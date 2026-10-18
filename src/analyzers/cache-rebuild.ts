// A2 cache-rebuild + A3 rebuild-cause (SPEC §5). One aggregated finding over all sessions.
//
// Rule (SPEC §5 A2): turn n of a session's main (non-sidechain) chain, n > 1, is a rebuild when
//   cacheWrite(n) ≥ max(rebuildMinCacheWrite, rebuildPrevContextFraction × context(n-1))
//   and cacheRead(n) ≤ (1 − rebuildReadDropFraction) × cacheRead(n-1), with cacheRead(n-1) > 0
// where context(n-1) = input + cacheRead + cacheWrite of turn n-1. Synthetic turns are skipped
// (they made no API call), so n-1 is the previous real turn. Subagent sessions are entirely
// sidechain and are not checked (SPEC: non-sidechain). Consequences of the literal rule:
//   - a turn whose previous turn read nothing from cache (e.g. turn 2 after a cold turn 1) never
//     counts, because cache_read cannot drop from 0;
//   - with --since/--until, the first in-window turn has no in-window turn n-1 and is not checked.
// Tokens are measured: the sum of cacheWrite of the rebuild turns.
import type { Analyzer, Finding, Session, Thresholds, Turn } from '../model/index.js';
import { formatCompact, formatInt } from '../reporters/format.js';
import { rebuildCause, REBUILD_CAUSES, type RebuildCause } from './rebuild-cause.js';
import { evidenceFor, MAX_EVIDENCE, plural, realTurns, type Evidence } from './util.js';

const KNOWN_ISSUE = 'https://github.com/anthropics/claude-code/issues/46917';
const FIFTEEN_MIN = 15 * 60_000;

export interface Rebuild {
  session: Session;
  turn: Turn;
  prev: Turn;
  cause: RebuildCause;
  detail: string;
  gapMs: number;
}

export function isRebuild(prev: Turn, turn: Turn, th: Thresholds): boolean {
  const prevContext = prev.usage.input + prev.usage.cacheRead + prev.usage.cacheWrite;
  const minWrite = Math.max(th.rebuildMinCacheWrite, th.rebuildPrevContextFraction * prevContext);
  return (
    turn.usage.cacheWrite >= minWrite &&
    prev.usage.cacheRead > 0 &&
    turn.usage.cacheRead <= (1 - th.rebuildReadDropFraction) * prev.usage.cacheRead
  );
}

export function findRebuilds(sessions: readonly Session[], th: Thresholds): Rebuild[] {
  const out: Rebuild[] = [];
  for (const s of sessions) {
    const chain = realTurns(s).filter((t) => !t.isSidechain);
    for (let i = 1; i < chain.length; i++) {
      const prev = chain[i - 1]!;
      const turn = chain[i]!;
      if (!isRebuild(prev, turn, th)) continue;
      const c = rebuildCause(s, chain.slice(0, i), turn, th);
      out.push({ session: s, turn, prev, ...c });
    }
  }
  return out;
}

function fixFor(cause: RebuildCause, rebuilds: readonly Rebuild[], th: Thresholds): string {
  switch (cause) {
    case 'ttl-expiry': {
      const short = rebuilds.filter((r) => r.gapMs > th.ttl5mMs && r.gapMs <= FIFTEEN_MIN).length;
      return `batch prompts; you had ${plural(short, 'gap')} of 5–15 min`;
    }
    case 'cc-upgrade':
      return 'restart after upgrading; known issue: anthropics/claude-code#46917';
    case 'model-switch':
      return '/model mid-session invalidates the cache';
    case 'compaction':
      return 'use /clear or a new session for unrelated tasks';
    case 'config-edit':
      return 'edit CLAUDE.md between sessions (method unverified)';
    case 'tool-set-change':
      return 'set up tools / MCP servers before the session [E]';
    case 'unknown':
      return 'no known cause; check the evidence turns by hand';
  }
}

function detailOf(r: Rebuild): string {
  const u = r.turn.usage;
  return (
    `${r.cause}: ${r.detail}; cache_read ${formatCompact(r.prev.usage.cacheRead)} → ` +
    `${formatCompact(u.cacheRead)}, cache_write ${formatInt(u.cacheWrite)}`
  );
}

export const cacheRebuild: Analyzer = {
  id: 'cache-rebuild',
  spec: 'A2',
  description: 'Turns that rewrote the prompt cache, with their likely cause (A2 + A3).',
  run(sessions, ctx) {
    const th = ctx.thresholds;
    const rebuilds = findRebuilds(sessions, th);
    if (rebuilds.length === 0) return [];
    const tokens = rebuilds.reduce((a, r) => a + r.turn.usage.cacheWrite, 0);
    const causes = REBUILD_CAUSES.map((cause) => {
      const rs = rebuilds.filter((r) => r.cause === cause);
      return {
        cause,
        count: rs.length,
        tokens: rs.reduce((a, r) => a + r.turn.usage.cacheWrite, 0),
        fix: fixFor(cause, rs, th),
      };
    }).filter((c) => c.count > 0);
    const top = [...causes].sort((a, b) => b.tokens - a.tokens)[0]!;
    const evidence: Evidence[] = [...rebuilds]
      .sort(
        (a, b) =>
          b.turn.usage.cacheWrite - a.turn.usage.cacheWrite ||
          a.turn.ts.getTime() - b.turn.ts.getTime(),
      )
      .slice(0, MAX_EVIDENCE)
      .map((r) => evidenceFor(r.turn, detailOf(r)));
    const finding: Finding = {
      analyzer: 'cache-rebuild',
      // Arbitrary but fixed: 10+ rebuilds or 500k+ rewritten tokens is worth leading with.
      severity: rebuilds.length >= 10 || tokens >= 500_000 ? 'high' : 'warn',
      title:
        `${plural(rebuilds.length, 'rebuild')} cost ${formatCompact(tokens)} ` +
        `cache-write tokens`,
      tokens: { value: tokens, kind: 'measured' },
      data: {
        causes,
        rebuilds: rebuilds.length,
        sessions: new Set(rebuilds.map((r) => r.session.id)).size,
        evidenceShown: evidence.length,
      },
      evidence,
      fix: {
        summary: `largest cause ${top.cause}: ${top.fix}`,
        ...(causes.some((c) => c.cause === 'cc-upgrade') ? { docsUrl: KNOWN_ISSUE } : {}),
      },
    };
    return [finding];
  },
};
