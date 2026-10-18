// A3 rebuild-cause (SPEC §5): why a cache rebuild (A2) happened. The first matching cause wins,
// in SPEC order. Pure: reads only the session, the two turns, the thresholds and ChainState.
import type { Session, SessionEvent, Thresholds, Turn } from '../model/index.js';
import { displayPath, formatDuration } from './util.js';

export const REBUILD_CAUSES = [
  'ttl-expiry',
  'cc-upgrade',
  'model-switch',
  'compaction',
  'config-edit',
  'tool-set-change',
  'unknown',
] as const;
export type RebuildCause = (typeof REBUILD_CAUSES)[number];

export interface CauseResult {
  cause: RebuildCause;
  /** Short evidence text: numbers, versions, model and tool names, file names. Never content. */
  detail: string;
  /** ms between the previous turn and this one. */
  gapMs: number;
  /** The cache TTL assumed for this session. */
  ttl: '5m' | '1h';
}

/**
 * Running state of one session's main chain, advanced turn by turn so that classifying a
 * rebuild never rescans earlier turns.
 */
export class ChainState {
  /** Tool names used by earlier turns or listed by earlier tools snapshots. */
  readonly knownTools = new Set<string>();
  readonly ttl: '5m' | '1h';
  private next = 0;
  constructor(private readonly s: Session) {
    // UNVERIFIED: that a session which wrote ephemeral_1h tokens at all keeps its cached prefix
    // for 1 h (a session could mix 1h and 5m entries; the split is measured, its meaning not).
    // Decided per session over all its turns, before since/until filtering (Session.wrote1hCache).
    const oneHour = s.wrote1hCache ?? s.turns.some((t) => (t.usage.cacheWrite1h ?? 0) > 0);
    this.ttl = oneHour ? '1h' : '5m';
  }
  /** Add tools snapshots up to `ts` (events are sorted by ts). */
  private snapshotsUntil(ts: Date): void {
    const ev = this.s.events;
    while (this.next < ev.length && ev[this.next]!.ts <= ts) {
      const e = ev[this.next++]!;
      if (e.kind === 'tools-snapshot') for (const t of e.tools) this.knownTools.add(t.name);
    }
  }
  /** Tool names `turn` uses that are not known yet. Call before `advance(turn)`. */
  newToolNames(turn: Turn): string[] {
    this.snapshotsUntil(turn.ts);
    return [...new Set(turn.toolUses.map((u) => u.name))].filter((n) => !this.knownTools.has(n));
  }
  advance(turn: Turn): void {
    this.snapshotsUntil(turn.ts);
    for (const u of turn.toolUses) this.knownTools.add(u.name);
  }
}

type Ev<K extends SessionEvent['kind']> = Extract<SessionEvent, { kind: K }>;

const between = (e: SessionEvent, a: Turn, b: Turn): boolean => e.ts > a.ts && e.ts <= b.ts;

/** Classify the rebuild at `turn` (n) against `prev` (n-1); `state` has seen turns up to n-1. */
export function rebuildCause(
  s: Session,
  prev: Turn,
  turn: Turn,
  th: Thresholds,
  state: ChainState,
): CauseResult {
  const gapMs = turn.ts.getTime() - prev.ts.getTime();
  const ttl = state.ttl;
  const r = (cause: RebuildCause, detail: string): CauseResult => ({ cause, detail, gapMs, ttl });

  // (a) TTL expiry: strictly longer than the TTL.
  if (gapMs > (ttl === '1h' ? th.ttl1hMs : th.ttl5mMs))
    return r('ttl-expiry', `idle ${formatDuration(gapMs)} > ${ttl} cache TTL`);

  // (b) Claude Code version changed.
  if (
    prev.ccVersion !== undefined &&
    turn.ccVersion !== undefined &&
    prev.ccVersion !== turn.ccVersion
  )
    return r('cc-upgrade', `Claude Code ${prev.ccVersion} → ${turn.ccVersion}`);

  // (c) Model switch.
  if (prev.model !== turn.model) return r('model-switch', `model ${prev.model} → ${turn.model}`);

  const inGap = s.events.filter((e) => between(e, prev, turn));

  // (d) Compaction marker between the two turns.
  // UNVERIFIED: the compaction markers themselves (FORMAT.md Q5; none seen in a real log yet).
  const compaction = inGap.find((e): e is Ev<'compaction'> => e.kind === 'compaction');
  if (compaction) return r('compaction', `compaction (${compaction.marker}) before this turn`);

  // (e) Config edit.
  // UNVERIFIED: that a mid-session CLAUDE.md edit produces a new `instructions` attachment
  // (FORMAT.md Q2). Detected as a file whose sha256 differs from the latest earlier attachment of
  // the same path; files that only appear (e.g. a nested CLAUDE.md) do not count.
  const changed = changedInstructionFiles(s.events, inGap);
  if (changed.length > 0)
    return r(
      'config-edit',
      `${changed.length === 1 ? 'instructions file' : `${changed.length} instructions files`} ` +
        `changed: ${changed
          .map((p) => displayPath(p, s.cwd))
          .slice(0, 3)
          .join(', ')}`,
    );

  // (f) Tool set change [E]: a prompt_snapshot whose tool names differ from the previous one,
  // else tool names first used at this turn (a weak signal: SPEC §5 marks it estimated).
  // UNVERIFIED: that a new `prompt_snapshot` is logged when the tool set changes (FORMAT.md Q3).
  const delta = toolSetDelta(s.events, inGap);
  if (delta !== undefined)
    return r('tool-set-change', `tool definitions changed (+${delta.added} / -${delta.removed})`);
  const fresh = state.newToolNames(turn);
  if (fresh.length > 0)
    return r(
      'tool-set-change',
      `first use of ${fresh.length === 1 ? 'tool' : 'tools'} ${fresh.slice(0, 3).join(', ')} [E]`,
    );

  return r('unknown', `gap ${formatDuration(gapMs)}, no known cause`);
}

function changedInstructionFiles(all: readonly SessionEvent[], inGap: SessionEvent[]): string[] {
  const out = new Set<string>();
  for (const e of inGap) {
    if (e.kind !== 'instructions') continue;
    const before = new Map<string, string>();
    for (const x of all) {
      if (x === e) break;
      if (x.kind === 'instructions') for (const f of x.files) before.set(f.path, f.hash);
    }
    for (const f of e.files) {
      const h = before.get(f.path);
      if (h !== undefined && h !== f.hash) out.add(f.path);
    }
  }
  return [...out];
}

function toolSetDelta(
  all: readonly SessionEvent[],
  inGap: SessionEvent[],
): { added: number; removed: number } | undefined {
  for (const e of inGap) {
    if (e.kind !== 'tools-snapshot') continue;
    let prev: Ev<'tools-snapshot'> | undefined;
    for (const x of all) {
      if (x === e) break;
      if (x.kind === 'tools-snapshot') prev = x;
    }
    if (prev === undefined) continue;
    const a = new Set(prev.tools.map((t) => t.name));
    const b = new Set(e.tools.map((t) => t.name));
    const added = [...b].filter((n) => !a.has(n)).length;
    const removed = [...a].filter((n) => !b.has(n)).length;
    if (added + removed > 0) return { added, removed };
  }
  return undefined;
}
