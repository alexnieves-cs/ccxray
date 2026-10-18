// A3 rebuild-cause (SPEC §5): why a cache rebuild (A2) happened. The first matching cause wins,
// in SPEC order. Pure: reads only the session, the two turns and the thresholds.
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
}

type Ev<K extends SessionEvent['kind']> = Extract<SessionEvent, { kind: K }>;

const between = (e: SessionEvent, a: Turn, b: Turn): boolean => e.ts > a.ts && e.ts <= b.ts;

/**
 * `prior` is the chain's real turns before `turn`, oldest first; its last entry is turn n-1.
 * The TTL is 1 h when any of them wrote `ephemeral_1h` tokens, else 5 min (the API default).
 */
export function rebuildCause(
  s: Session,
  prior: readonly Turn[],
  turn: Turn,
  th: Thresholds,
): CauseResult {
  const prev = prior[prior.length - 1]!;
  const gapMs = turn.ts.getTime() - prev.ts.getTime();
  const r = (cause: RebuildCause, detail: string): CauseResult => ({ cause, detail, gapMs });

  // (a) TTL expiry.
  // UNVERIFIED: that one ephemeral_1h write anywhere earlier in the chain means the cached prefix
  // lives for 1 h (a session could mix 1h and 5m entries; the split is measured, its meaning not).
  const oneHour = prior.some((t) => (t.usage.cacheWrite1h ?? 0) > 0);
  if (gapMs > (oneHour ? th.ttl1hMs : th.ttl5mMs))
    return r('ttl-expiry', `idle ${formatDuration(gapMs)} > ${oneHour ? '1h' : '5m'} cache TTL`);

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

  // (d) Compaction marker between the two turns (markers are UNVERIFIED, FORMAT.md Q5).
  const compaction = inGap.find((e): e is Ev<'compaction'> => e.kind === 'compaction');
  if (compaction) return r('compaction', `compaction (${compaction.marker}) before this turn`);

  // (e) Config edit.
  // UNVERIFIED (FORMAT.md Q2): that a mid-session CLAUDE.md edit produces a new `instructions`
  // attachment. Detected as a file whose sha256 differs from the latest earlier attachment of
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
  // UNVERIFIED (FORMAT.md Q3): that a new `prompt_snapshot` is logged when the tool set changes.
  const delta = toolSetDelta(s.events, inGap);
  if (delta !== undefined)
    return r('tool-set-change', `tool definitions changed (+${delta.added} / -${delta.removed})`);
  const fresh = newToolNames(s, prior, turn);
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

/** Tool names used at `turn` that no earlier turn used and no earlier tools snapshot listed. */
function newToolNames(s: Session, prior: readonly Turn[], turn: Turn): string[] {
  const known = new Set<string>();
  for (const t of prior) for (const u of t.toolUses) known.add(u.name);
  for (const e of s.events)
    if (e.kind === 'tools-snapshot' && e.ts <= turn.ts) for (const t of e.tools) known.add(t.name);
  return [...new Set(turn.toolUses.map((u) => u.name))].filter((n) => !known.has(n));
}
