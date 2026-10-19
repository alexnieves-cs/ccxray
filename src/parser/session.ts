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
import { jsonLength, ResponseMerger } from './dedupe.js';
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
  /** Assistant responses of this file, merged per (message.id, requestId) (dedupe rule 1). */
  turns: Turn[];
  /** Dedupe bookkeeping from ResponseMerger (see dedupe.ts). */
  foreign: ReadonlySet<Turn>;
  localOnly: ReadonlySet<Turn>;
  apiErrors: ReadonlyMap<Turn, string>;
  toolResults: ToolResult[];
  prompts: UserPrompt[];
  events: SessionEvent[];
  /** `parentUuid` of the first record that has the key (null when it is null). */
  firstParentUuid?: string | null;
  /** `toolUseId` from the sibling `agent-<id>.meta.json`, when read. */
  metaToolUseId?: string;
  /** Parent side of subagent links: `toolUseResult.agentId` → the tool_result's tool_use_id. */
  agentLinks: Map<string, string>;
  /** Every user/assistant record has `isSidechain: true` and a string `agentId` (undefined:
   * no such record). */
  allSidechain?: boolean;
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
  private readonly merger: ResponseMerger;
  private lastTs: Date | undefined;
  private rawLength = 0;

  constructor(
    file: DiscoveredFile,
    private readonly stats: ParseStats,
    private readonly includeContent: boolean,
  ) {
    this.merger = new ResponseMerger({ stats, warn: this.warn, includeContent });
    this.data = {
      file,
      versions: [],
      turns: this.merger.turns,
      foreign: this.merger.foreign,
      localOnly: this.merger.localOnly,
      apiErrors: this.merger.apiErrors,
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
    if (type === 'user' || type === 'assistant')
      d.allSidechain =
        d.allSidechain !== false && r.isSidechain === true && typeof r.agentId === 'string';
    d.cwd ??= str(r.cwd);
    if (d.firstParentUuid === undefined && 'parentUuid' in r)
      d.firstParentUuid = str(r.parentUuid) ?? null;
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
      this.merger.add({ r, ownTs: own, ts, source, rawLength, fileSessionId: d.sessionId });
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
        // Common fields in the literal (in-object slots, one shape); rare ones added only when set.
        const tr: ToolResult = {
          toolUseId: b.tool_use_id,
          toolName: undefined,
          chars,
          estTokens: estimateTokensFromChars(chars),
          isError: typeof b.is_error === 'boolean' ? b.is_error : undefined,
          recordUuid: uuid,
          ts,
        };
        if (this.includeContent) tr.text = contentText(b.content);
        const persisted = persistedInfo(b.content);
        if (persisted !== undefined) tr.persisted = persisted;
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
    } else if (a.type === 'deferred_tools_record') {
      // UNVERIFIED (FORMAT.md): only the attachment type is known; names are read from any of
      // these arrays, as strings or `{name}` objects. Nothing else is kept.
      const tools: string[] = [];
      for (const key of ['tools', 'toolNames', 'names', 'deferredTools'])
        if (Array.isArray(a[key]))
          for (const t of a[key] as unknown[]) {
            const name = typeof t === 'string' ? t : isRec(t) ? str(t.name) : undefined;
            if (name !== undefined && !tools.includes(name)) tools.push(name);
          }
      if (tools.length > 0) this.data.events.push({ kind: 'deferred-tools', ts, tools, source });
    }
  }

  finish(): FileData {
    return this.data;
  }
}

/**
 * Session identity of a file. Main transcripts use the first envelope `sessionId` (else the file
 * stem); UNVERIFIED: every record in a file belongs to that one session.
 * A file is a subagent transcript when its path is a subagent layout (`DiscoveredFile.subagentOf`:
 * [M] CC 2.1.302 `{sessionId}/subagents/agent-<id>.jsonl`, with the parent's sessionId and
 * envelope `agentId` = `<id>`), or, UNVERIFIED, when every user/assistant record has
 * `isSidechain: true` and an `agentId` (e.g. a flat `agent-<id>.jsonl` next to the parent; parent
 * = envelope sessionId). Being deeper below the root does not make a file a subagent.
 * Session.id is `<parentSessionId>:agent-<agentId>` (or `<parentSessionId>:<file stem>`), a tknxray
 * choice: `:` never occurs in a sessionId UUID, so it cannot collide with the parent.
 */
export function sessionIdentity(
  f: FileData,
): Pick<Session, 'id' | 'isSubagent' | 'agentId' | 'parentSessionId'> {
  const stem = fileStem(f.file);
  const byLayout = f.file.subagentOf;
  if (byLayout === undefined && f.allSidechain !== true)
    return { id: f.sessionId ?? stem, isSubagent: false };
  const parentSessionId = byLayout ?? f.sessionId;
  const agentId = stem.startsWith('agent-') ? stem.slice('agent-'.length) : f.agentId;
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
  kept: readonly (readonly Turn[])[],
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
      seen?: Set<string>;
    }
  >();
  const promptKey = (p: UserPrompt): string => `p|${p.uuid}`;
  const eventKey = (e: SessionEvent): string =>
    `e|${e.kind}|${'uuid' in e ? (e.uuid ?? '') : ''}|${e.ts.getTime()}|${e.source.line}`;
  const resultKey = (tr: ToolResult): string =>
    `r|${tr.toolUseId}|${tr.recordUuid ?? `${tr.ts?.getTime()}`}`;
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
      g = { s, results: [], links: new Map() };
      sessions.set(ident.id, g);
    }
    const s = g.s;
    s.files.push(f.file.path);
    s.cwd ??= f.cwd;
    if (!ident.isSubagent && typeof f.firstParentUuid === 'string') s.continued = true;
    for (const v of f.versions) if (!s.ccVersions.includes(v)) s.ccVersions.push(v);
    if (f.firstTs !== undefined && (s.firstTs === EPOCH || f.firstTs < s.firstTs))
      s.firstTs = f.firstTs;
    if (f.lastTs !== undefined && f.lastTs > s.lastTs) s.lastTs = f.lastTs;
    if (s.files.length === 1) {
      // Common case: the session's first file, nothing to dedupe against.
      for (const p of f.prompts) s.prompts.push(p);
      for (const e of f.events) s.events.push(e);
      for (const tr of f.toolResults) g.results.push(tr);
    } else {
      // A second file for the same session (or the same file via another root): build the key
      // set lazily from what is already merged.
      const seen = (g.seen ??= new Set([
        ...s.prompts.map(promptKey),
        ...s.events.map(eventKey),
        ...g.results.map(resultKey),
      ]));
      const fresh = (key: string): boolean => {
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      };
      for (const p of f.prompts) if (fresh(promptKey(p))) s.prompts.push(p);
      for (const e of f.events) if (fresh(eventKey(e))) s.events.push(e);
      for (const tr of f.toolResults) if (fresh(resultKey(tr))) g.results.push(tr);
    }
    for (const [a, id] of f.agentLinks) g.links.set(a, id);
    g.metaToolUseId ??= f.metaToolUseId;
    for (const t of kept[i] ?? []) {
      t.sessionId = s.id;
      s.turns.push(t);
      if (t.isSynthetic) stats.syntheticTurns++;
      const detail = f.apiErrors.get(t);
      if (detail !== undefined)
        s.events.push({ kind: 'api-error', ts: t.ts, uuid: t.uuid, detail, source: t.source });
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
    // Collect per turn first, then store one exact-size array (no per-result copies).
    const grouped = new Map<Turn, ToolResult[]>();
    for (const tr of results) {
      const t = byToolUse.get(tr.toolUseId);
      if (t === undefined) {
        inc(stats.warnings, 'tool_result without matching tool_use');
        continue;
      }
      const u = t.toolUses.find((x) => x.id === tr.toolUseId)!;
      tr.toolUseId = u.id; // share one string instead of a second copy from JSON.parse
      tr.toolName = u.name;
      const list = grouped.get(t);
      if (list === undefined) grouped.set(t, [tr]);
      else list.push(tr);
    }
    for (const [t, list] of grouped)
      t.toolResults =
        t.toolResults.length === 0
          ? list.length === 1
            ? list
            : list.slice()
          : t.toolResults.concat(list);
    finalize(s);
    out.push(s);
  }
  return out;
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
  // Exact-size copies of the per-session arrays (push leaves up to 50% spare capacity).
  s.turns = s.turns.slice();
  s.prompts = s.prompts.slice();
  s.events = s.events.slice();
  const prev = new Map<string, Turn>();
  for (const t of s.turns) {
    const c = chainOf(t);
    const p = prev.get(c);
    t.index = p === undefined ? 0 : p.index + 1;
    const gap = p === undefined ? null : t.ts.getTime() - p.ts.getTime();
    // `| 0` keeps small gaps as V8 small integers instead of boxed doubles (memory, SPEC §8).
    t.gapMs = gap !== null && Math.abs(gap) < 2 ** 30 ? gap | 0 : gap;
    prev.set(c, t);
  }
  const first = s.turns[0];
  const last = s.turns[s.turns.length - 1];
  if (first !== undefined && (s.firstTs === EPOCH || first.ts < s.firstTs)) s.firstTs = first.ts;
  if (last !== undefined && last.ts > s.lastTs) s.lastTs = last.ts;
}
