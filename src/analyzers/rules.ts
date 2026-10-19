// Small shared predicates for analyzers and the `session` view. Pure, no I/O.
// The A2 rebuild rule and the A3 TTL live here so the session view (M4) and the cache-rebuild
// analyzer (M2) flag exactly the same turns. The A6 repeat rule is in repeated-read.ts.

import type { Session, Thresholds, Turn, Usage } from '../model/index.js';

/** Context size of one turn: input + cache read + cache write (SPEC §5 A4, A8). Measured. */
export function contextTokens(u: Usage): number {
  return u.input + u.cacheRead + u.cacheWrite;
}

/** Every token the turn processed: context + output. Measured. */
export function turnTokens(u: Usage): number {
  return contextTokens(u) + u.output;
}

/**
 * The chain analyzers follow in a session: every turn of a subagent transcript, else the main
 * chain (inline sidechain turns excluded). Includes synthetic turns.
 */
export function chain(s: Session): Turn[] {
  return s.turns.filter((t) => s.isSubagent || !t.isSidechain);
}

/** Main-chain, non-synthetic turns of a session, in timestamp order. */
export function mainTurns(s: Session): Turn[] {
  return s.turns.filter((t) => !t.isSidechain && !t.isSynthetic);
}

/**
 * SPEC §5 A2: turn n (not the first, non-sidechain) rebuilt the cache when
 * `cache_creation ≥ max(rebuildMinCacheWrite, rebuildPrevContextFraction × prev context)` and
 * `cache_read ≤ (1 − rebuildReadDropFraction) × prev cache_read`, with `prev cache_read > 0`
 * (the literal rule: cache_read cannot drop from 0, SPEC §5 A2 notes). `prev` is the previous
 * non-synthetic turn of the same main chain. The one A2 predicate: the cache-rebuild analyzer
 * and the `session` 🔁 flag both use it.
 */
export function isRebuild(prev: Turn | undefined, cur: Turn, th: Thresholds): boolean {
  if (prev === undefined || cur.isSidechain || cur.isSynthetic) return false;
  return meetsRebuildRule(prev, cur, th);
}

/**
 * The A2 usage rule alone, for any chain (sidechains included): the cost model (src/cost/carry.ts)
 * uses it to tell which turns rewrote their prefix. isRebuild adds the main-chain restriction.
 */
export function meetsRebuildRule(prev: Turn, cur: Turn, th: Thresholds): boolean {
  const minWrite = Math.max(
    th.rebuildMinCacheWrite,
    th.rebuildPrevContextFraction * contextTokens(prev.usage),
  );
  return (
    cur.usage.cacheWrite >= minWrite &&
    prev.usage.cacheRead > 0 &&
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
 * SPEC §5 A3 (a): the cache TTL that applies to a session: 1 h when it wrote any `ephemeral_1h`
 * tokens (decided over the whole session, before since/until filtering: `Session.wrote1hCache`),
 * else 5 min.
 * UNVERIFIED: that a session which wrote ephemeral_1h tokens at all keeps its cached prefix for
 * 1 h (a session could mix 1h and 5m entries; the split is measured, its meaning not).
 */
export function sessionTtl(s: Session): '5m' | '1h' {
  const oneHour = s.wrote1hCache ?? s.turns.some((t) => (t.usage.cacheWrite1h ?? 0) > 0);
  return oneHour ? '1h' : '5m';
}

/** sessionTtl in ms. */
export function cacheTtlMs(s: Session, th: Thresholds): number {
  return sessionTtl(s) === '1h' ? th.ttl1hMs : th.ttl5mMs;
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

const SEMVER = /^v?(\d+(?:\.\d+)*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

/**
 * Version compare: the numeric core first (2.1.99 < 2.1.100, missing parts count as 0), then a
 * prerelease sorts before its release (2.1.100-beta.1 < 2.1.100), prereleases compared
 * numeric-aware. Strings that are not versions fall back to a numeric-aware string compare,
 * after every version.
 */
export function compareVersions(a: string, b: string): number {
  const ma = SEMVER.exec(a);
  const mb = SEMVER.exec(b);
  if (!ma || !mb) {
    if (ma || mb) return ma ? -1 : 1;
    return a.localeCompare(b, 'en', { numeric: true });
  }
  const na = ma[1]!.split('.').map(Number);
  const nb = mb[1]!.split('.').map(Number);
  for (let i = 0; i < Math.max(na.length, nb.length); i++) {
    const d = (na[i] ?? 0) - (nb[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  const pa = ma[2];
  const pb = mb[2];
  if (pa === undefined || pb === undefined) return pa === pb ? 0 : pa === undefined ? 1 : -1;
  return pa.localeCompare(pb, 'en', { numeric: true });
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
