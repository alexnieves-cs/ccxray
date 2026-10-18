// A2 cache-rebuild + A3 rebuild-cause (SPEC §5). One aggregated finding over all sessions.
//
// Rule (SPEC §5 A2): turn n of a session's main (non-sidechain) chain, n > 1, is a rebuild when
//   cacheWrite(n) ≥ max(rebuildMinCacheWrite, rebuildPrevContextFraction × context(n-1))
//   and cacheRead(n) ≤ (1 − rebuildReadDropFraction) × cacheRead(n-1), with cacheRead(n-1) > 0
// (isRebuild in rules.ts, the one predicate also used by the `session` view's rebuild flag)
// where context(n-1) = input + cacheRead + cacheWrite of turn n-1. Synthetic turns are skipped
// (they made no API call), so n-1 is the previous real turn. Subagent sessions are entirely
// sidechain and are not checked (SPEC: non-sidechain). Consequences of the literal rule:
//   - a turn whose previous turn read nothing from cache (e.g. turn 2 after a cold turn 1) never
//     counts, because cache_read cannot drop from 0;
//   - with --since/--until, the first in-window turn has no in-window turn n-1 and is not checked.
// Tokens are measured: the sum of cacheWrite of the rebuild turns. The per-cause split in
// data.causes is estimated (tokensKind: 'estimated'): the cause is an attribution guess.
import type { Analyzer, Finding, Session, Thresholds, Turn } from '../model/index.js';
import { formatCompact, formatInt } from '../reporters/format.js';
import { ChainState, rebuildCause, REBUILD_CAUSES, type RebuildCause } from './rebuild-cause.js';
import { isRebuild } from './rules.js';
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
  ttl: '5m' | '1h';
}

export function findRebuilds(sessions: readonly Session[], th: Thresholds): Rebuild[] {
  const out: Rebuild[] = [];
  for (const s of sessions) {
    const chain = realTurns(s).filter((t) => !t.isSidechain);
    const state = new ChainState(s);
    for (let i = 0; i < chain.length; i++) {
      const turn = chain[i]!;
      const prev = chain[i - 1];
      if (prev !== undefined && isRebuild(prev, turn, th))
        out.push({ session: s, turn, prev, ...rebuildCause(s, prev, turn, th, state) });
      state.advance(turn);
    }
  }
  return out;
}

function fixFor(cause: RebuildCause, rebuilds: readonly Rebuild[], th: Thresholds): string {
  switch (cause) {
    case 'ttl-expiry': {
      // Worded per TTL: a 5m session is told about short breaks, a 1h session about long ones.
      const five = rebuilds.filter((r) => r.ttl === '5m');
      const hour = rebuilds.length - five.length;
      const short = five.filter((r) => r.gapMs > th.ttl5mMs && r.gapMs <= FIFTEEN_MIN).length;
      const parts = [
        ...(five.length > 0 ? [`you had ${plural(short, 'gap')} of 5–15 min (5m TTL)`] : []),
        ...(hour > 0 ? [`${plural(hour, 'break')} over 1h (1h TTL)`] : []),
      ];
      return `batch prompts; ${parts.join(', ')}`;
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
        // The total is measured; splitting it by cause is an attribution guess (CLAUDE.md rule 2).
        tokensKind: 'estimated' as const,
        fix: fixFor(cause, rs, th),
      };
    }).filter((c) => c.count > 0);
    const top = [...causes].sort((a, b) => b.tokens - a.tokens)[0]!;
    const evidence: Evidence[] = [...rebuilds]
      .sort((a, b) => b.turn.usage.cacheWrite - a.turn.usage.cacheWrite || a.turn.ts - b.turn.ts)
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
