// Dedupe of assistant responses (SPEC §4.3, docs/FORMAT.md "Dedupe").
//  1. Same response: Claude Code writes one line per content block, so lines with the same
//     (message.id, requestId) in one file are merged into one Turn.
//  2. Sidechain replay: a sidechain response whose message.id also appears in a non-sidechain
//     response (any file) is dropped.
//  3. Cross-session copy: the same (message.id, requestId) in several files is kept once
//     (see dedupeAcrossFiles for which copy wins).

import type { ParseStats, SourcePointer, ToolUse, Usage } from '../model/index.js';
import {
  counter,
  inc,
  isRec,
  isToolUseBlock,
  readUsage,
  slimToolInput,
  str,
  type AssistantRecord,
} from './records.js';

export interface PendingResponse {
  /** Dedupe key; `hasGlobalKey` is false when it is only unique within the file. */
  key: string;
  hasGlobalKey: boolean;
  messageId: string;
  requestId?: string;
  uuid: string;
  ts: Date;
  model: string;
  ccVersion?: string;
  isSidechain: boolean;
  agentId?: string;
  /** Envelope `sessionId` of the first line, for choosing among cross-session copies. */
  envSessionId?: string;
  isSynthetic: boolean;
  /** Short error label for api-error events (envelope `error` or `isApiErrorMessage`). */
  apiError?: string;
  usage: Usage;
  stopReason?: string;
  toolUses: ToolUse[];
  blockCounts: Record<string, number>;
  source: SourcePointer;
  /** Which fields came from a line that had them (vs. placeholders). */
  has: { usage: boolean; ts: boolean; uuid: boolean };
}

/** `JSON.stringify(v).length`, or `fallback` when stringify throws (e.g. ~20k-deep input). */
export function jsonLength(v: unknown, fallback: number): number {
  try {
    return JSON.stringify(v ?? null).length;
  } catch {
    return fallback;
  }
}

/** One assistant line, as handed over by the file parser. */
export interface AssistantLine {
  r: AssistantRecord;
  /** The line's own timestamp, if valid. */
  ownTs?: Date;
  /** Fallback timestamp (previous record in the file, or epoch). */
  ts: Date;
  source: SourcePointer;
  rawLength: number;
}

/** Merge one assistant line into the file's responses. */
export function addAssistantLine(
  responses: Map<string, PendingResponse>,
  line: AssistantLine,
  opts: { stats: ParseStats; warn: (key: string) => void; includeContent: boolean },
): void {
  const { r, ownTs, source } = line;
  const m = r.message;
  const messageId = str(m.id);
  const requestId = str(r.requestId);
  if (messageId === undefined) opts.warn('assistant without message.id');
  // UNVERIFIED: without requestId, message.id alone is assumed unique only within one file.
  const hasGlobalKey = messageId !== undefined && requestId !== undefined;
  const key =
    messageId === undefined
      ? `line:${source.file}:${source.line}`
      : requestId === undefined
        ? `msg:${messageId}`
        : `${messageId}\u0000${requestId}`;
  const usage = readUsage(m.usage);
  if (usage === undefined) opts.warn('assistant without message.usage');
  const uuid = str(r.uuid);

  const existing = responses.get(key);
  const resp: PendingResponse = existing ?? {
    key,
    hasGlobalKey,
    messageId: messageId ?? key,
    requestId,
    uuid: uuid ?? `${source.file}:${source.line}`,
    ts: ownTs ?? line.ts,
    model: 'unknown',
    isSidechain: r.isSidechain === true,
    isSynthetic: false,
    usage: { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 },
    toolUses: [],
    blockCounts: counter(),
    source,
    has: { usage: false, ts: ownTs !== undefined, uuid: uuid !== undefined },
  };
  if (existing !== undefined) opts.stats.dedupe.sameResponseLines++;

  // Fill fields from the first line that has them (a first line may lack usage or timestamp).
  if (!resp.has.ts && ownTs !== undefined) {
    resp.ts = ownTs;
    resp.has.ts = true;
  }
  if (!resp.has.uuid && uuid !== undefined) {
    resp.uuid = uuid;
    resp.source = source;
    resp.has.uuid = true;
  }
  // FORMAT.md: usage is identical on every line in 2.1.302. Older versions may have written
  // partial output_tokens on earlier lines (UNVERIFIED), so after the first real usage, prefer
  // the line with the largest output_tokens.
  if (usage !== undefined && (!resp.has.usage || usage.output > resp.usage.output)) {
    resp.usage = usage;
    resp.has.usage = true;
  }
  const model = str(m.model);
  if (resp.model === 'unknown' && model !== undefined) resp.model = model;
  resp.ccVersion ??= str(r.version);
  resp.agentId ??= str(r.agentId);
  resp.envSessionId ??= str(r.sessionId);
  const errLabel =
    typeof r.error === 'string'
      ? r.error.slice(0, 80)
      : r.error !== undefined && r.error !== null && r.error !== false
        ? 'error'
        : r.isApiErrorMessage === true
          ? 'isApiErrorMessage'
          : undefined;
  resp.apiError ??= errLabel;
  resp.isSynthetic = resp.model === '<synthetic>' || resp.apiError !== undefined;
  const stop = str(m.stop_reason);
  if (stop !== undefined) resp.stopReason = stop;

  // UNVERIFIED: string assistant content (not seen in 2.1.302) is treated as one text block.
  const blocks = typeof m.content === 'string' ? [{ type: 'text' }] : m.content;
  if (Array.isArray(blocks))
    for (const b of blocks) {
      const type = isRec(b) && typeof b.type === 'string' ? b.type : '(unknown)';
      inc(resp.blockCounts, type);
      if (!isToolUseBlock(b)) continue;
      if (resp.toolUses.some((t) => t.id === b.id)) continue;
      resp.toolUses.push({
        id: b.id,
        name: b.name,
        input: opts.includeContent ? b.input : slimToolInput(b.name, b.input),
        inputChars: jsonLength(b.input, line.rawLength),
      });
    }
  // Insert last, so nothing above can leave a half-built response in the map.
  if (existing === undefined) responses.set(key, resp);
}

export interface FileResponses {
  responses: readonly PendingResponse[];
  /** The file's session id (first envelope sessionId). */
  sessionId?: string;
  firstTs?: Date;
}

/**
 * Apply rules 2 and 3 across files. `files` must be sorted by path. Returns the kept responses
 * per file (same order as `files`).
 */
export function dedupeAcrossFiles(
  files: readonly FileResponses[],
  stats: ParseStats,
): PendingResponse[][] {
  // UNVERIFIED (FORMAT.md "Dedupe"): sidechain replay rule from ccusage docs; no replay seen yet.
  const mainIds = new Set<string>();
  for (const f of files) for (const r of f.responses) if (!r.isSidechain) mainIds.add(r.messageId);
  // UNVERIFIED (FORMAT.md "Dedupe"): cross-session copies from ccusage docs; none seen yet. Keep
  // the copy whose file's sessionId equals the record's own envelope sessionId, else the copy in
  // the file with the earliest first timestamp, else the first file by path.
  const best = new Map<string, { r: PendingResponse; own: boolean; first: number }>();
  for (const f of files) {
    const first = f.firstTs?.getTime() ?? Number.POSITIVE_INFINITY;
    for (const r of f.responses) {
      if (!r.hasGlobalKey) continue;
      const own = r.envSessionId !== undefined && r.envSessionId === f.sessionId;
      const cur = best.get(r.key);
      if (cur === undefined || (own && !cur.own) || (own === cur.own && first < cur.first))
        best.set(r.key, { r, own, first });
    }
  }
  return files.map((f) =>
    f.responses.filter((r) => {
      if (r.isSidechain && mainIds.has(r.messageId)) {
        stats.dedupe.sidechainReplays++;
        return false;
      }
      if (!r.hasGlobalKey || best.get(r.key)?.r === r) return true;
      stats.dedupe.crossSessionCopies++;
      return false;
    }),
  );
}
