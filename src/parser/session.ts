// Build Session objects from parsed files (SPEC §4, §4.1). Content is kept only with
// includeContent (CLAUDE.md hard rule 4); instructions files are kept as length + sha256 only.

import { createHash } from 'node:crypto';
import { fileStem, type DiscoveredFile } from '../discover.js';
import type {
  ParseStats,
  Session,
  SessionEvent,
  SourcePointer,
  ToolResult,
  Turn,
  UserPrompt,
} from '../model/index.js';
import { estimateTokensFromChars } from '../tokens/estimate.js';
import { addAssistantLine, jsonLength, type PendingResponse } from './dedupe.js';
import {
  contentChars,
  contentText,
  inc,
  isAssistantRecord,
  isAttachmentRecord,
  isKnownType,
  isRec,
  isSummaryRecord,
  isSystemRecord,
  isToolResultBlock,
  isUserRecord,
  parseTs,
  str,
  type AttachmentRecord,
  type Rec,
  type UserRecord,
} from './records.js';

const EPOCH = new Date(0);

export interface FileData {
  file: DiscoveredFile;
  sessionId?: string;
  agentId?: string;
  cwd?: string;
  versions: string[];
  firstTs?: Date;
  lastTs?: Date;
  responses: PendingResponse[];
  toolResults: ToolResult[];
  prompts: UserPrompt[];
  events: SessionEvent[];
  /** `toolUseId` from the sibling `agent-<id>.meta.json`, when read. */
  metaToolUseId?: string;
  /** Parent side of subagent links: `toolUseResult.agentId` → the tool_result's tool_use_id. */
  agentLinks: Map<string, string>;
}

const PERSISTED = '<persisted-output>';
const UNITS: Record<string, number> = { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3 };

/**
 * [M] CC 2.1.302 (FORMAT.md Q1): an externalized output is a string starting `<persisted-output>`
 * with a line `Output too large (36.4KB). Full output saved to: <path>`.
 * UNVERIFIED: KB = 1024 (one sample: 36.4KB reported for a 37,277-byte file fits 1024, not 1000).
 */
export function persistedInfo(content: unknown): ToolResult['persisted'] {
  const first = Array.isArray(content)
    ? content.find((b): b is Rec => isRec(b) && typeof b.text === 'string')?.text
    : content;
  if (typeof first !== 'string' || !first.trimStart().startsWith(PERSISTED)) return undefined;
  const m = /Output too large \((\d+(?:\.\d+)?)\s*(B|KB|MB|GB)\)/.exec(first.slice(0, 500));
  return { reportedBytes: m ? Math.round(Number(m[1]) * UNITS[m[2]!]!) : null };
}

/** Consumes the records of one file, in line order. */
export class FileParser {
  readonly data: FileData;
  private readonly responses = new Map<string, PendingResponse>();
  private lastTs: Date | undefined;
  private rawLength = 0;

  constructor(
    file: DiscoveredFile,
    private readonly stats: ParseStats,
    private readonly includeContent: boolean,
  ) {
    this.data = {
      file,
      versions: [],
      responses: [],
      toolResults: [],
      prompts: [],
      events: [],
      agentLinks: new Map(),
    };
  }

  private warn = (key: string): void => inc(this.stats.warnings, key);

  onRecord = (r: Rec, line: number, rawLength = 0): void => {
    const { stats, data: d } = this;
    this.rawLength = rawLength;
    const type = typeof r.type === 'string' ? r.type : '(missing)';
    inc(stats.recordTypes, type);
    if (!isKnownType(type)) inc(stats.unknownRecordTypes, type);
    const version = str(r.version);
    if (version !== undefined) {
      inc(stats.ccVersions, version);
      if (!d.versions.includes(version)) d.versions.push(version);
    }
    d.sessionId ??= str(r.sessionId);
    d.agentId ??= str(r.agentId);
    d.cwd ??= str(r.cwd);
    const own = parseTs(r.timestamp);
    if (own !== undefined) {
      this.lastTs = own;
      if (d.firstTs === undefined || own < d.firstTs) d.firstTs = own;
      if (d.lastTs === undefined || own > d.lastTs) d.lastTs = own;
    }
    const ts = own ?? this.lastTs ?? EPOCH;
    const source: SourcePointer = { file: d.file.path, line };
    const uuid = str(r.uuid);

    if (isAssistantRecord(r)) {
      if (own === undefined) this.warn('assistant without timestamp');
      addAssistantLine(
        this.responses,
        { r, ownTs: own, ts, source, rawLength },
        { stats, warn: this.warn, includeContent: this.includeContent },
      );
    } else if (isUserRecord(r)) this.user(r, ts, source);
    else if (isAttachmentRecord(r)) this.attachment(r, ts, source);
    else if (isSystemRecord(r)) {
      // UNVERIFIED (FORMAT.md Q5): compaction marker from community reports; 0 seen in C1.
      if (r.subtype === 'compact_boundary')
        d.events.push({ kind: 'compaction', ts, uuid, marker: 'system:compact_boundary', source });
      // UNVERIFIED: `system` records with subtype `api_error`; not seen in C1.
      else if (r.subtype === 'api_error')
        d.events.push({ kind: 'api-error', ts, uuid, detail: 'system:api_error', source });
    } else if (isSummaryRecord(r)) {
      // UNVERIFIED (FORMAT.md Q5): `summary` records as compaction markers.
      d.events.push({ kind: 'compaction', ts, uuid, marker: 'summary', source });
    } else if (type === 'assistant' || type === 'user') this.warn(`${type} without message`);
    else if (type === 'attachment') this.warn('attachment without attachment.type');
  };

  private user(r: UserRecord, ts: Date, source: SourcePointer): void {
    const uuid = str(r.uuid);
    if (r.isCompactSummary === true) {
      // UNVERIFIED (FORMAT.md Q5): `isCompactSummary: true` marks the post-compaction summary.
      this.data.events.push({ kind: 'compaction', ts, uuid, marker: 'isCompactSummary', source });
      return;
    }
    const c = r.message.content;
    if (Array.isArray(c)) {
      let results = 0;
      // [M] 2.1.302 (FORMAT.md Q4): the parent's Agent tool_result line carries
      // `toolUseResult.agentId`, matching the subagent's `agent-<id>.jsonl`.
      const tur = isRec(r.toolUseResult) ? str(r.toolUseResult.agentId) : undefined;
      for (const b of c) {
        if (!isToolResultBlock(b)) continue;
        if (results === 0 && tur !== undefined) this.data.agentLinks.set(tur, b.tool_use_id);
        results++;
        const chars = contentChars(b.content);
        const tr: ToolResult = {
          toolUseId: b.tool_use_id,
          chars,
          estTokens: estimateTokensFromChars(chars),
          recordUuid: uuid,
          ts,
        };
        if (typeof b.is_error === 'boolean') tr.isError = b.is_error;
        const persisted = persistedInfo(b.content);
        if (persisted !== undefined) tr.persisted = persisted;
        if (this.includeContent) tr.text = contentText(b.content);
        this.data.toolResults.push(tr);
      }
      if (results > 0) return;
    } else if (typeof c !== 'string') {
      this.warn('user without message.content');
      return;
    }
    // UNVERIFIED: `isMeta: true` user lines are injected by the client, not typed by the user.
    if (r.isMeta === true) return;
    const p: UserPrompt = {
      uuid: uuid ?? `${source.file}:${source.line}`,
      ts,
      chars: contentChars(c),
      source,
    };
    if (this.includeContent) p.text = contentText(c);
    this.data.prompts.push(p);
  }

  private attachment(r: AttachmentRecord, ts: Date, source: SourcePointer): void {
    const a = r.attachment;
    inc(this.stats.attachmentTypes, a.type);
    if (a.type === 'instructions' && Array.isArray(a.files)) {
      const files: { path: string; chars: number; hash: string }[] = [];
      for (const f of a.files) {
        const path = isRec(f) ? str(f.path) : undefined;
        const content = isRec(f) ? str(f.content) : undefined;
        if (path === undefined || content === undefined) {
          this.warn('instructions file without path or content');
          continue;
        }
        const hash = createHash('sha256').update(content).digest('hex');
        files.push({ path, chars: content.length, hash });
      }
      this.data.events.push({ kind: 'instructions', ts, files, source });
    } else if (a.type === 'prompt_snapshot' && Array.isArray(a.tools)) {
      const fallback = this.rawLength;
      const tools = a.tools.map((t: unknown) => ({
        // UNVERIFIED: tool entries other than `{name, description, schema}` (FORMAT.md Q3).
        name:
          (isRec(t)
            ? (str(t.name) ?? (isRec(t.schema) ? str(t.schema.name) : undefined))
            : undefined) ?? '(unnamed)',
        chars: jsonLength(t, fallback),
      }));
      const ev: SessionEvent = { kind: 'tools-snapshot', ts, tools, source };
      // UNVERIFIED: `systemPrompt[]` parts are strings or `{text}` objects.
      if (Array.isArray(a.systemPrompt))
        ev.systemPromptChars = a.systemPrompt.reduce<number>(
          (n, p) => n + (typeof p === 'string' ? p.length : isRec(p) ? contentChars([p]) : 0),
          0,
        );
      this.data.events.push(ev);
    }
  }

  finish(): FileData {
    this.data.responses = [...this.responses.values()];
    return this.data;
  }
}

/**
 * Session identity of a file. Main transcripts use the first envelope `sessionId` (else the file
 * stem); UNVERIFIED: every record in a file belongs to that one session.
 * [M] CC 2.1.302 (FORMAT.md Q4): subagents live in `{sessionId}/subagents/agent-<id>.jsonl`, with
 * the parent's sessionId and envelope `agentId` = `<id>`.
 * UNVERIFIED: other files below `{sessionId}/`, and flat `agent-<id>.jsonl` files next to the
 * parent (older layouts, parent = envelope sessionId), are treated as subagents too.
 * Session.id is `<parentSessionId>:agent-<agentId>` (or `<parentSessionId>:<file stem>`), a ccxray
 * choice: `:` never occurs in a sessionId UUID, so it cannot collide with the parent.
 */
export function sessionIdentity(
  f: FileData,
): Pick<Session, 'id' | 'isSubagent' | 'agentId' | 'parentSessionId'> {
  const stem = fileStem(f.file);
  const agentFile = stem.startsWith('agent-');
  if (!f.file.nested && !agentFile) return { id: f.sessionId ?? stem, isSubagent: false };
  const parentSessionId = f.file.nested ? f.file.dirs[0] : f.sessionId;
  const agentId = agentFile ? stem.slice('agent-'.length) : f.agentId;
  const suffix = agentId !== undefined ? `agent-${agentId}` : stem;
  return {
    id: `${parentSessionId ?? 'unknown'}:${suffix}`,
    isSubagent: true,
    agentId,
    parentSessionId,
  };
}

const byTs = <T extends { ts: Date }>(a: T, b: T): number => a.ts.getTime() - b.ts.getTime();

/** Group files into sessions, attach kept responses as turns and join tool results. */
export function buildSessions(
  files: readonly FileData[],
  kept: readonly (readonly PendingResponse[])[],
  stats: ParseStats,
): Session[] {
  const sessions = new Map<
    string,
    {
      s: Session;
      results: ToolResult[];
      links: Map<string, string>;
      metaToolUseId?: string;
      /** Keys already merged: the same file can be reached from two roots (e.g. ~/.claude and
       * ~/.config/claude), so prompts, events and tool_results are deduped on merge. */
      seen: Set<string>;
    }
  >();
  files.forEach((f, i) => {
    const ident = sessionIdentity(f);
    let g = sessions.get(ident.id);
    if (g === undefined) {
      const s: Session = {
        ...ident,
        project: f.file.project,
        files: [],
        turns: [],
        prompts: [],
        events: [],
        firstTs: f.firstTs ?? EPOCH,
        lastTs: f.lastTs ?? EPOCH,
        ccVersions: [],
      };
      g = { s, results: [], links: new Map(), seen: new Set() };
      sessions.set(ident.id, g);
    }
    const s = g.s;
    s.files.push(f.file.path);
    s.cwd ??= f.cwd;
    for (const v of f.versions) if (!s.ccVersions.includes(v)) s.ccVersions.push(v);
    if (f.firstTs !== undefined && (s.firstTs === EPOCH || f.firstTs < s.firstTs))
      s.firstTs = f.firstTs;
    if (f.lastTs !== undefined && f.lastTs > s.lastTs) s.lastTs = f.lastTs;
    const seen = g.seen;
    const fresh = (key: string): boolean => {
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    };
    for (const p of f.prompts) if (fresh(`p|${p.uuid}`)) s.prompts.push(p);
    for (const e of f.events)
      if (
        fresh(`e|${e.kind}|${'uuid' in e ? (e.uuid ?? '') : ''}|${e.ts.getTime()}|${e.source.line}`)
      )
        s.events.push(e);
    for (const tr of f.toolResults)
      if (fresh(`r|${tr.toolUseId}|${tr.recordUuid ?? `${tr.ts?.getTime()}`}`)) g.results.push(tr);
    for (const [a, id] of f.agentLinks) g.links.set(a, id);
    g.metaToolUseId ??= f.metaToolUseId;
    for (const r of kept[i] ?? []) {
      s.turns.push(toTurn(r, s.id));
      if (r.isSynthetic) stats.syntheticTurns++;
      if (r.apiError !== undefined)
        s.events.push({
          kind: 'api-error',
          ts: r.ts,
          uuid: r.uuid,
          detail: r.apiError,
          source: r.source,
        });
    }
  });

  const out: Session[] = [];
  for (const { s, results, metaToolUseId } of sessions.values()) {
    if (s.isSubagent && s.agentId !== undefined) {
      const viaParent =
        s.parentSessionId !== undefined
          ? sessions.get(s.parentSessionId)?.links.get(s.agentId)
          : undefined;
      const id = metaToolUseId ?? viaParent;
      if (id !== undefined) s.parentToolUseId = id;
    }
    const byToolUse = new Map<string, Turn>();
    for (const t of s.turns) for (const u of t.toolUses) byToolUse.set(u.id, t);
    for (const tr of results) {
      const t = byToolUse.get(tr.toolUseId);
      if (t === undefined) {
        inc(stats.warnings, 'tool_result without matching tool_use');
        continue;
      }
      tr.toolName = t.toolUses.find((u) => u.id === tr.toolUseId)?.name;
      t.toolResults.push(tr);
    }
    finalize(s);
    out.push(s);
  }
  return out;
}

function toTurn(r: PendingResponse, sessionId: string): Turn {
  return {
    sessionId,
    uuid: r.uuid,
    messageId: r.messageId,
    requestId: r.requestId,
    ts: r.ts,
    gapMs: null,
    index: 0,
    model: r.model,
    ccVersion: r.ccVersion,
    isSidechain: r.isSidechain,
    agentId: r.agentId,
    isSynthetic: r.isSynthetic,
    usage: r.usage,
    stopReason: r.stopReason,
    toolUses: r.toolUses,
    toolResults: [],
    blockCounts: r.blockCounts,
    source: r.source,
  };
}

/** Chain of a turn: the main conversation, or one sidechain (per agentId). */
const chainOf = (t: Turn): string => (t.isSidechain ? `side:${t.agentId ?? ''}` : 'main');

/**
 * Sort by ts (stable); set index and gapMs per chain (main vs each sidechain agent, so sidechain
 * turns inside a main file do not split main-chain gaps); widen firstTs/lastTs to the turns.
 */
export function finalize(s: Session): void {
  s.turns.sort(byTs);
  s.prompts.sort(byTs);
  s.events.sort(byTs);
  const prev = new Map<string, Turn>();
  for (const t of s.turns) {
    const c = chainOf(t);
    const p = prev.get(c);
    t.index = p === undefined ? 0 : p.index + 1;
    t.gapMs = p === undefined ? null : t.ts.getTime() - p.ts.getTime();
    prev.set(c, t);
  }
  const first = s.turns[0];
  const last = s.turns[s.turns.length - 1];
  if (first !== undefined && (s.firstTs === EPOCH || first.ts < s.firstTs)) s.firstTs = first.ts;
  if (last !== undefined && last.ts > s.lastTs) s.lastTs = last.ts;
}
