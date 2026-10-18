// Dedupe of assistant responses (SPEC §4.3, docs/FORMAT.md "Dedupe").
//  1. Same response: Claude Code writes one line per content block, so lines with the same
//     (message.id, requestId) in one file are merged into one Turn.
//  2. Sidechain replay: a sidechain response whose message.id also appears in a non-sidechain
//     response (any file) is dropped.
//  3. Cross-session copy: the same (message.id, requestId) in several files is kept once, in the
//     first file by sorted path.

import type { ParseStats, SourcePointer, ToolUse, Usage } from '../model/index.js';
import {
  counter,
  inc,
  isRec,
  isToolUseBlock,
  readUsage,
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
  isSynthetic: boolean;
  /** Short error label for api-error events (envelope `error` or `isApiErrorMessage`). */
  apiError?: string;
  usage: Usage;
  stopReason?: string;
  toolUses: ToolUse[];
  blockCounts: Record<string, number>;
  source: SourcePointer;
}

const ZERO_USAGE: Usage = { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 };

/** Merge one assistant line into the file's responses. Returns warning keys, if any. */
export function addAssistantLine(
  responses: Map<string, PendingResponse>,
  r: AssistantRecord,
  ts: Date,
  source: SourcePointer,
  stats: ParseStats,
  warn: (key: string) => void,
): void {
  const m = r.message;
  const messageId = str(m.id);
  const requestId = str(r.requestId);
  if (messageId === undefined) warn('assistant without message.id');
  // UNVERIFIED: without requestId, message.id alone is assumed unique only within one file.
  const hasGlobalKey = messageId !== undefined && requestId !== undefined;
  const key =
    messageId === undefined
      ? `line:${source.file}:${source.line}`
      : requestId === undefined
        ? `msg:${messageId}`
        : `${messageId}\u0000${requestId}`;
  const usage = readUsage(m.usage);
  if (usage === undefined) warn('assistant without message.usage');

  let resp = responses.get(key);
  if (resp === undefined) {
    const model = str(m.model) ?? 'unknown';
    const errLabel =
      typeof r.error === 'string'
        ? r.error.slice(0, 80)
        : r.error !== undefined && r.error !== null && r.error !== false
          ? 'error'
          : r.isApiErrorMessage === true
            ? 'isApiErrorMessage'
            : undefined;
    resp = {
      key,
      hasGlobalKey,
      messageId: messageId ?? key,
      requestId,
      uuid: str(r.uuid) ?? `${source.file}:${source.line}`,
      ts,
      model,
      ccVersion: str(r.version),
      isSidechain: r.isSidechain === true,
      agentId: str(r.agentId),
      isSynthetic: model === '<synthetic>' || errLabel !== undefined,
      apiError: errLabel,
      usage: usage ?? { ...ZERO_USAGE },
      toolUses: [],
      blockCounts: counter(),
      source,
    };
    responses.set(key, resp);
  } else {
    stats.dedupe.sameResponseLines++;
    // FORMAT.md: usage is identical on every line in 2.1.302. Older versions may have written
    // partial output_tokens on earlier lines (UNVERIFIED), so keep the largest.
    if (usage !== undefined && usage.output > resp.usage.output) resp.usage = usage;
  }
  const stop = str(m.stop_reason);
  if (stop !== undefined) resp.stopReason = stop;

  // UNVERIFIED: string assistant content (not seen in 2.1.302) is treated as one text block.
  const blocks = typeof m.content === 'string' ? [{ type: 'text' }] : m.content;
  if (!Array.isArray(blocks)) return;
  for (const b of blocks) {
    const type = isRec(b) && typeof b.type === 'string' ? b.type : '(unknown)';
    inc(resp.blockCounts, type);
    if (!isToolUseBlock(b)) continue;
    if (resp.toolUses.some((t) => t.id === b.id)) continue;
    resp.toolUses.push({
      id: b.id,
      name: b.name,
      input: b.input,
      inputChars: JSON.stringify(b.input ?? null).length,
    });
  }
}

/**
 * Apply rules 2 and 3 across files. `files` must be sorted by path. Returns the kept responses
 * per file (same order as `files`).
 */
export function dedupeAcrossFiles(
  files: readonly (readonly PendingResponse[])[],
  stats: ParseStats,
): PendingResponse[][] {
  const mainIds = new Set<string>();
  for (const f of files) for (const r of f) if (!r.isSidechain) mainIds.add(r.messageId);
  const seen = new Set<string>();
  return files.map((f) =>
    f.filter((r) => {
      if (r.isSidechain && mainIds.has(r.messageId)) {
        stats.dedupe.sidechainReplays++;
        return false;
      }
      if (!r.hasGlobalKey) return true;
      if (seen.has(r.key)) {
        stats.dedupe.crossSessionCopies++;
        return false;
      }
      seen.add(r.key);
      return true;
    }),
  );
}
