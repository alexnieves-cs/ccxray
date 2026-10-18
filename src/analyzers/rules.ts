// Small shared predicates for analyzers and the `session` view. Pure, no I/O.
// The A2 rebuild rule lives here so the session view (M4) and the cache-rebuild analyzer (M2)
// flag exactly the same turns.

import type { Session, Thresholds, Turn, Usage } from '../model/index.js';

/** Context size of one turn: input + cache read + cache write (SPEC §5 A4, A8). Measured. */
export function contextTokens(u: Usage): number {
  return u.input + u.cacheRead + u.cacheWrite;
}

/** Every token the turn processed: context + output. Measured. */
export function turnTokens(u: Usage): number {
  return contextTokens(u) + u.output;
}

/** Main-chain, non-synthetic turns of a session, in timestamp order. */
export function mainTurns(s: Session): Turn[] {
  return s.turns.filter((t) => !t.isSidechain && !t.isSynthetic);
}

/**
 * SPEC §5 A2: turn n (not the first, non-sidechain) rebuilt the cache when
 * `cache_creation ≥ max(rebuildMinCacheWrite, rebuildPrevContextFraction × prev context)` and
 * `cache_read ≤ (1 − rebuildReadDropFraction) × prev cache_read`. `prev` is the previous
 * non-synthetic turn of the same chain. With prev cache_read = 0 the drop condition holds
 * (0 ≤ 0): the previous turn wrote the cache and this one did not read it.
 */
export function isRebuild(prev: Turn | undefined, cur: Turn, th: Thresholds): boolean {
  if (prev === undefined || cur.isSidechain || cur.isSynthetic) return false;
  const minWrite = Math.max(
    th.rebuildMinCacheWrite,
    th.rebuildPrevContextFraction * contextTokens(prev.usage),
  );
  return (
    cur.usage.cacheWrite >= minWrite &&
    cur.usage.cacheRead <= (1 - th.rebuildReadDropFraction) * prev.usage.cacheRead
  );
}

/** uuids of the main-chain turns of `s` that match the A2 rebuild rule. */
export function rebuildTurns(s: Session, th: Thresholds): Set<string> {
  const out = new Set<string>();
  let prev: Turn | undefined;
  for (const t of mainTurns(s)) {
    if (isRebuild(prev, t, th)) out.add(t.uuid);
    prev = t;
  }
  return out;
}

/**
 * SPEC §5 A3 (a): the cache TTL that applies to a session: 1 h when it wrote any
 * `ephemeral_1h` tokens, else 5 min.
 */
export function cacheTtlMs(s: Session, th: Thresholds): number {
  return s.turns.some((t) => (t.usage.cacheWrite1h ?? 0) > 0) ? th.ttl1hMs : th.ttl5mMs;
}

const MUTATING = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

function field(input: unknown, key: string): unknown {
  return typeof input === 'object' && input !== null
    ? (input as Record<string, unknown>)[key]
    : undefined;
}

/**
 * SPEC §5 A6: tool_use ids of `Read` calls that repeat an earlier Read of the same file_path
 * (same offset/limit) in the session's main chain, with no Edit/Write/MultiEdit/NotebookEdit of
 * that path and no Bash command mentioning it in between. A subagent session is one chain.
 */
export function repeatedReadIds(s: Session): Set<string> {
  const seen = new Map<string, string>(); // read key → path
  const out = new Set<string>();
  for (const t of s.turns) {
    if ((t.isSidechain && !s.isSubagent) || t.isSynthetic) continue;
    for (const u of t.toolUses) {
      const path = field(u.input, 'file_path') ?? field(u.input, 'notebook_path');
      if (u.name === 'Read' && typeof path === 'string') {
        const key = JSON.stringify([path, field(u.input, 'offset'), field(u.input, 'limit')]);
        if (seen.has(key)) out.add(u.id);
        else seen.set(key, path);
      } else if (MUTATING.has(u.name) && typeof path === 'string') {
        for (const [k, p] of seen) if (p === path) seen.delete(k);
      } else if (u.name === 'Bash') {
        const cmd = field(u.input, 'command');
        if (typeof cmd === 'string') for (const [k, p] of seen) if (cmd.includes(p)) seen.delete(k);
      }
    }
  }
  return out;
}

/**
 * `mcp__github__create_issue` → `github`; undefined for built-in tools.
 * UNVERIFIED: the server name ends at the first `__` after `mcp__` (a server name that itself
 * contains `__` would be split wrongly).
 */
export function mcpServer(toolName: string): string | undefined {
  if (!toolName.startsWith('mcp__')) return undefined;
  const rest = toolName.slice('mcp__'.length);
  const i = rest.indexOf('__');
  return i > 0 ? rest.slice(0, i) : undefined;
}

/** Numeric-aware version compare, e.g. 2.1.99 < 2.1.100. */
export function compareVersions(a: string, b: string): number {
  return a.localeCompare(b, 'en', { numeric: true });
}

export function median(xs: readonly number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : Math.round((s[m - 1]! + s[m]!) / 2);
}

/** First 8 characters of a session id, for titles. */
export const short = (id: string): string => (id.length > 8 ? id.slice(0, 8) : id);

/** `20614` → `20,614`, independent of the host locale. */
export function fmt(n: number): string {
  return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}
