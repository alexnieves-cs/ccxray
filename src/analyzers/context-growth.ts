// A8 context-growth (SPEC §5): per-session curve of context size (input + cache read + cache
// write per turn) [M]; flags sessions that got large or were compacted repeatedly.

import type { Analyzer, Finding, Session } from '../model/index.js';
import { chain, contextTokens, fmt, short } from './rules.js';

/** Non-synthetic turns of the chain A8 follows (subagent transcripts included). */
const realTurns = (s: Session) => chain(s).filter((t) => !t.isSynthetic);

export const CURVE_POINTS = 50;

/** Down-sample to at most `n` points, keeping each bucket's maximum (peaks survive). */
export function downsample(xs: readonly number[], n = CURVE_POINTS): number[] {
  if (xs.length <= n) return [...xs];
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const from = Math.floor((i * xs.length) / n);
    const to = Math.floor(((i + 1) * xs.length) / n);
    out.push(Math.max(...xs.slice(from, to)));
  }
  return out;
}

/**
 * Compactions in a session. One compaction can leave several markers (e.g. a compact_boundary
 * record followed by an isCompactSummary line), so markers with no assistant turn between them
 * count once.
 * UNVERIFIED (FORMAT.md Q5): which markers one compaction writes; no real compaction seen yet.
 */
export function countCompactions(s: Session): number {
  const turnTimes = realTurns(s).map((t) => t.ts);
  const marks = s.events
    .filter((e) => e.kind === 'compaction')
    .map((e) => e.ts)
    .sort((a, b) => a - b);
  let n = 0;
  let last: number | undefined;
  for (const m of marks) {
    if (last === undefined || turnTimes.some((t) => t > last! && t < m)) n++;
    last = m;
  }
  return n;
}

export const contextGrowth: Analyzer = {
  id: 'context-growth',
  spec: 'A8',
  description: 'Context size per turn; sessions that grew large or compacted repeatedly',
  run(sessions, ctx) {
    const { contextLargeTokens, compactionsPerSession } = ctx.thresholds;
    const findings: Finding[] = [];
    for (const s of sessions) {
      const turns = realTurns(s);
      if (turns.length === 0) continue;
      const sizes = turns.map((t) => contextTokens(t.usage));
      const max = Math.max(...sizes);
      const peak = turns[sizes.indexOf(max)]!;
      const compactions = countCompactions(s);
      const large = max >= contextLargeTokens;
      const compacted = compactions >= compactionsPerSession;
      if (!large && !compacted) continue;
      const why = [
        large ? `peaked at ${fmt(max)} tokens` : '',
        compacted ? `compacted ${compactions}×` : '',
      ].filter(Boolean);
      findings.push({
        analyzer: 'context-growth',
        severity: 'warn',
        title: `${s.isSubagent ? 'Subagent' : 'Session'} ${short(s.id)} ${why.join(' and ')} over ${turns.length} turns`,
        tokens: { value: max, kind: 'measured' },
        data: { max, turns: turns.length, compactions, curve: downsample(sizes) },
        evidence: [
          {
            sessionId: s.id,
            turnUuid: peak.uuid,
            detail: `peak context ${fmt(max)} tokens at turn ${peak.index + 1}`,
            source: peak.source,
          },
        ],
        fix: { summary: 'Start a new session or /clear between unrelated tasks' },
      });
    }
    return findings;
  },
};
