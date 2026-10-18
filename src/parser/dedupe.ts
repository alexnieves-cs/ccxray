// Dedupe of assistant responses (SPEC §4.3, docs/FORMAT.md "Dedupe").
//  1. Same response: Claude Code writes one line per content block, so lines with the same
//     (message.id, requestId) in one file are merged into one Turn.
//  2. Sidechain replay: a sidechain response whose message.id also appears in a non-sidechain
//     response (any file) is dropped.
//  3. Cross-session copy: the same (message.id, requestId) in several files is kept once
//     (see dedupeAcrossFiles for which copy wins).
//
// Memory (SPEC §8, < 300 MB RSS for 1 GB): responses are plain Turn objects from the start, never
// copied. Maps are keyed by the message.id string the Turn already holds (requestId compared on
// lookup), so no composite key strings are built. Bookkeeping needed only while one file is read
// lives in that file's ResponseMerger and is dropped with it.

import type { ParseStats, SourcePointer, ToolUse, Turn } from '../model/index.js';
import {
  counter,
  inc,
  intern,
  isRec,
  isToolUseBlock,
  readUsage,
  slimToolInput,
  str,
  type AssistantRecord,
} from './records.js';

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
  /** The file's session id (first envelope sessionId seen so far). */
  fileSessionId?: string;
}

const HAS_USAGE = 1;
const HAS_TS = 2;
const HAS_UUID = 4;
const HAS_SID = 8;

/** Map from (message.id, requestId) to a Turn without building composite key strings. */
class PairMap {
  private readonly m = new Map<string, Turn | Turn[]>();
  get(messageId: string, requestId: string | undefined): Turn | undefined {
    const v = this.m.get(messageId);
    if (v === undefined) return undefined;
    if (!Array.isArray(v)) return v.requestId === requestId ? v : undefined;
    return v.find((t) => t.requestId === requestId);
  }
  /** Insert, or replace the entry with the same requestId. */
  set(t: Turn): void {
    const v = this.m.get(t.messageId);
    if (v === undefined || (!Array.isArray(v) && v.requestId === t.requestId))
      this.m.set(t.messageId, t);
    else if (!Array.isArray(v)) this.m.set(t.messageId, [v, t]);
    else {
      const i = v.findIndex((x) => x.requestId === t.requestId);
      if (i >= 0) v[i] = t;
      else v.push(t);
    }
  }
}

/**
 * blockCounts are shared, frozen objects: one per distinct combination, reached through a
 * transition table (like hidden classes), so 150k turns hold a handful of count objects.
 * Bounded: past the cap, a turn gets its own unshared copy.
 */
const EMPTY_COUNTS: Record<string, number> = Object.freeze(counter());
const transitions = new Map<Record<string, number>, Map<string, Record<string, number>>>();
let sharedCounts = 0;
function bumpCount(c: Record<string, number>, type: string): Record<string, number> {
  if (!Object.isFrozen(c)) {
    inc(c, type);
    return c;
  }
  let next = transitions.get(c)?.get(type);
  if (next !== undefined) return next;
  const fresh = Object.assign(counter(), c);
  inc(fresh, type);
  if (sharedCounts >= 10_000) return fresh;
  next = Object.freeze(fresh);
  let tr = transitions.get(c);
  if (tr === undefined) transitions.set(c, (tr = new Map()));
  tr.set(type, next);
  sharedCounts++;
  return next;
}

const apiErrorLabel = (r: AssistantRecord): string | undefined =>
  typeof r.error === 'string'
    ? r.error.slice(0, 80)
    : r.error !== undefined && r.error !== null && r.error !== false
      ? 'error'
      : r.isApiErrorMessage === true
        ? 'isApiErrorMessage'
        : undefined;

/** Merges the assistant lines of one file (rule 1). */
export class ResponseMerger {
  /** Turns in first-line order. */
  readonly turns: Turn[] = [];
  /** Turns whose envelope sessionId differs from (or lacks) the file's sessionId. */
  readonly foreign = new Set<Turn>();
  /** Turns without message.id or requestId: unique within this file only. */
  readonly localOnly = new Set<Turn>();
  /** api-error labels (envelope `error` / `isApiErrorMessage`); rare. */
  readonly apiErrors = new Map<Turn, string>();
  private readonly byKey = new PairMap();
  private readonly flags = new Map<Turn, number>();

  constructor(
    private readonly opts: {
      stats: ParseStats;
      warn: (key: string) => void;
      includeContent: boolean;
    },
  ) {}

  add(line: AssistantLine): void {
    const { r, ownTs, source } = line;
    const { stats, warn } = this.opts;
    const m = r.message;
    const messageId = str(m.id);
    const requestId = str(r.requestId);
    if (messageId === undefined) warn('assistant without message.id');
    const usage = readUsage(m.usage);
    if (usage === undefined) warn('assistant without message.usage');
    const uuid = str(r.uuid);

    const found = messageId === undefined ? undefined : this.byKey.get(messageId, requestId);
    const t: Turn = found ?? {
      sessionId: '',
      uuid: uuid ?? `${source.file}:${source.line}`,
      messageId: messageId ?? `line:${source.file}:${source.line}`,
      requestId,
      ts: ownTs ?? line.ts,
      gapMs: null,
      index: 0,
      model: 'unknown',
      ccVersion: undefined,
      isSidechain: r.isSidechain === true,
      agentId: undefined,
      isSynthetic: false,
      usage: { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 },
      stopReason: undefined,
      toolUses: [],
      toolResults: [],
      blockCounts: EMPTY_COUNTS,
      source,
    };
    let f: number;
    if (found === undefined)
      f = (ownTs !== undefined ? HAS_TS : 0) | (uuid !== undefined ? HAS_UUID : 0);
    else {
      stats.dedupe.sameResponseLines++;
      f = this.flags.get(t) ?? 0;
    }

    // Fill fields from the first line that has them (a first line may lack usage or timestamp).
    if (!(f & HAS_TS) && ownTs !== undefined) {
      t.ts = ownTs;
      f |= HAS_TS;
    }
    if (!(f & HAS_UUID) && uuid !== undefined) {
      t.uuid = uuid;
      t.source = source;
      f |= HAS_UUID;
    }
    // FORMAT.md: usage is identical on every line in 2.1.302. Older versions may have written
    // partial output_tokens on earlier lines (UNVERIFIED), so after the first real usage, prefer
    // the line with the largest output_tokens.
    if (usage !== undefined && (!(f & HAS_USAGE) || usage.output > t.usage.output)) {
      t.usage = usage;
      f |= HAS_USAGE;
    }
    const sid = str(r.sessionId);
    if (!(f & HAS_SID)) {
      if (sid === undefined) this.foreign.add(t);
      else {
        f |= HAS_SID;
        if (sid === line.fileSessionId) this.foreign.delete(t);
        else this.foreign.add(t);
      }
    }
    const model = str(m.model);
    if (t.model === 'unknown' && model !== undefined) t.model = intern(model);
    t.ccVersion ??= intern(str(r.version));
    t.agentId ??= intern(str(r.agentId));
    if (!this.apiErrors.has(t)) {
      const label = apiErrorLabel(r);
      if (label !== undefined) this.apiErrors.set(t, label);
    }
    t.isSynthetic = t.model === '<synthetic>' || this.apiErrors.has(t);
    const stop = str(m.stop_reason);
    if (stop !== undefined) t.stopReason = intern(stop);

    // UNVERIFIED: string assistant content (not seen in 2.1.302) is treated as one text block.
    const blocks = typeof m.content === 'string' ? [{ type: 'text' }] : m.content;
    if (Array.isArray(blocks))
      for (const b of blocks) {
        const type = isRec(b) && typeof b.type === 'string' ? b.type : '(unknown)';
        t.blockCounts = bumpCount(t.blockCounts, type);
        if (!isToolUseBlock(b)) continue;
        if (t.toolUses.some((u) => u.id === b.id)) continue;
        const name = intern(b.name);
        const use: ToolUse = {
          id: b.id,
          name,
          input: this.opts.includeContent ? b.input : slimToolInput(name, b.input),
          inputChars: jsonLength(b.input, line.rawLength),
        };
        // Exact-size arrays: push() and spread grow a 17-slot backing store per turn (~150 B); concat is exact.
        t.toolUses = t.toolUses.length === 0 ? [use] : t.toolUses.concat(use);
      }
    this.flags.set(t, f);
    // Insert last, so nothing above can leave a half-built response in the merger.
    if (found === undefined) {
      this.turns.push(t);
      // UNVERIFIED: without requestId, message.id alone is assumed unique only within one file.
      if (messageId === undefined || requestId === undefined) this.localOnly.add(t);
      if (messageId !== undefined) this.byKey.set(t);
    }
  }
}

export interface FileResponses {
  turns: readonly Turn[];
  foreign: ReadonlySet<Turn>;
  localOnly: ReadonlySet<Turn>;
  firstTs?: Date;
}

/**
 * Apply rules 2 and 3 across files. `files` must be sorted by path. Returns the kept turns per
 * file (same order as `files`). Uses one sort over all turns instead of hash maps, so the extra
 * memory is a single pointer array (SPEC §8).
 */
export function dedupeAcrossFiles(
  files: readonly FileResponses[],
  stats: ParseStats,
): (readonly Turn[])[] {
  const fileOf = new Map<string, FileResponses>();
  const all: Turn[] = [];
  for (const f of files)
    for (const t of f.turns) {
      if (!fileOf.has(t.source.file)) fileOf.set(t.source.file, f);
      all.push(t);
    }
  const order = new Map<FileResponses, number>(files.map((f, i) => [f, i]));
  const fileIndex = (t: Turn): number => order.get(fileOf.get(t.source.file)!)!;
  const cmp = (a: string | undefined, b: string | undefined): number =>
    a === b ? 0 : a === undefined ? -1 : b === undefined ? 1 : a < b ? -1 : 1;
  // Stable sort; ties keep sorted-path order (all turns were pushed in file order).
  all.sort((a, b) => cmp(a.messageId, b.messageId) || cmp(a.requestId, b.requestId));

  const dropped = new Set<Turn>();
  const own = (t: Turn): boolean => !fileOf.get(t.source.file)!.foreign.has(t);
  const first = (t: Turn): number =>
    fileOf.get(t.source.file)!.firstTs?.getTime() ?? Number.POSITIVE_INFINITY;
  for (let i = 0; i < all.length;) {
    let j = i + 1;
    while (j < all.length && all[j]!.messageId === all[i]!.messageId) j++;
    if (j - i > 1) {
      // UNVERIFIED (FORMAT.md "Dedupe"): sidechain replay rule from ccusage docs; no replay seen
      // yet. A sidechain response is dropped when a non-sidechain one has the same message.id.
      const group = all.slice(i, j);
      if (group.some((t) => !t.isSidechain))
        for (const t of group)
          if (t.isSidechain) {
            dropped.add(t);
            stats.dedupe.sidechainReplays++;
          }
      // UNVERIFIED (FORMAT.md "Dedupe"): cross-session copies from ccusage docs; none seen yet.
      // Among the same (message.id, requestId) in several files, keep the copy whose file's
      // sessionId equals the record's own envelope sessionId, else the one in the file with the
      // earliest first timestamp, else the first file by path.
      const live = group.filter(
        (t) => !dropped.has(t) && !fileOf.get(t.source.file)!.localOnly.has(t),
      );
      for (let a = 0; a < live.length;) {
        let b = a + 1;
        while (b < live.length && live[b]!.requestId === live[a]!.requestId) b++;
        let best = live[a]!;
        for (let k = a + 1; k < b; k++) {
          const t = live[k]!;
          const o = own(t);
          const bo = own(best);
          if (
            (o && !bo) ||
            (o === bo &&
              (first(t) < first(best) ||
                (first(t) === first(best) && fileIndex(t) < fileIndex(best))))
          )
            best = t;
        }
        for (let k = a; k < b; k++)
          if (live[k] !== best) {
            dropped.add(live[k]!);
            stats.dedupe.crossSessionCopies++;
          }
        a = b;
      }
    }
    i = j;
  }
  // No copy when nothing is dropped: finalize() copies into exact-size session arrays.
  if (dropped.size === 0) return files.map((f) => f.turns);
  return files.map((f) =>
    f.turns.some((t) => dropped.has(t)) ? f.turns.filter((t) => !dropped.has(t)) : f.turns,
  );
}
