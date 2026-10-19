// A8 context-growth (SPEC §5): per-session curve of context size (input + cache read + cache
// write per turn) [M]; flags sessions that got large or were compacted repeatedly.

//
// Impact (SPEC §5.2): the cost of carrying context above contextLargeTokens, Σ over the chain's
// turns of max(0, context − contextLargeTokens) × that turn's cache-read price. Savings = that
// cost, framed as "starting fresh / /clear between tasks avoids most of this" [E]: an upper
// bound, since some of that context was needed.
import { unitPrices } from '../cost/cost.js';
import { impact } from '../cost/impact.js';
import type { Analyzer, Finding, Impact, Session, Turn } from '../model/index.js';
import { formatUsd } from '../reporters/format.js';
import { chain, contextTokens, fmt, short } from './rules.js';
import { MAX_EVIDENCE, plural, shortAgent } from './util.js';

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
 * [M] CC 2.1.302–2.1.303 (FORMAT.md Q5): one compaction writes a `system`/`compact_boundary` record
 * and, 4–5 lines later, an `isCompactSummary` user line stamped up to ~0.3 s *before* the
 * boundary, with no assistant turn between them, so the pair counts once (markers are sorted by
 * timestamp). Other markers (`summary` records) are still accepted.
 * UNVERIFIED: the marker set of other Claude Code versions, and `summary` records as markers.
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

interface Grown {
  s: Session;
  /** $ of re-reading the context above the threshold, and the turns over it. */
  overUsd: number;
  overTurns: number;
  turns: number;
  max: number;
  peak: Turn;
  compactions: number;
  large: boolean;
  compacted: boolean;
  sizes: number[];
}

const MAIN_FIX = 'Start a new session or /clear between unrelated tasks';
const SUBAGENT_FIX =
  'A subagent cannot be /clear-ed: give it a narrower task, and have it return a short ' +
  'summary (paths, line numbers) instead of whole files or outputs';

/** Compacted / peaked wording shared by titles and evidence. */
const why = (g: Grown): string[] =>
  [
    g.large ? `peaked at ${fmt(g.max)} tokens` : '',
    g.compacted ? `compacted ${g.compactions}×` : '',
  ].filter(Boolean);

function overImpact(gs: readonly Grown[], limit: number, sub: boolean): { impact?: Impact } {
  const usd = gs.reduce((a, g) => a + g.overUsd, 0);
  const turns = gs.reduce((a, g) => a + g.overTurns, 0);
  if (!(usd > 0)) return {};
  return {
    impact: impact({
      costUsd: usd,
      savingsUsd: usd,
      savingsSubagentUsd: sub ? usd : 0,
      basis:
        `context above ${fmt(limit)} tokens was re-read on ${plural(turns, 'turn')}: ` +
        `${formatUsd(usd)} at cache-read prices; ` +
        (sub
          ? 'narrower subagent tasks would avoid most of it'
          : 'starting fresh or /clear between tasks would avoid most of it'),
      confidence: 'estimated',
      upperBound: true,
    }),
  };
}

export const contextGrowth: Analyzer = {
  id: 'context-growth',
  spec: 'A8',
  description: 'Context size per turn; sessions that grew large or compacted repeatedly',
  run(sessions, ctx) {
    const { contextLargeTokens, compactionsPerSession } = ctx.thresholds;
    // Flagged sessions, grouped by session tree: a main session and its subagents.
    const trees = new Map<string, { main?: Grown; subs: Grown[] }>();
    for (const s of sessions) {
      const turns = realTurns(s);
      if (turns.length === 0) continue;
      const sizes = turns.map((t) => contextTokens(t.usage));
      const max = Math.max(...sizes);
      const compactions = countCompactions(s);
      const large = max >= contextLargeTokens;
      const compacted = compactions >= compactionsPerSession;
      if (!large && !compacted) continue;
      let overUsd = 0;
      let overTurns = 0;
      turns.forEach((t, i) => {
        const over = sizes[i]! - contextLargeTokens;
        if (over <= 0) return;
        overTurns++;
        overUsd += over * (unitPrices(t)?.read ?? 0);
      });
      const g: Grown = {
        s,
        overUsd,
        overTurns,
        turns: turns.length,
        max,
        peak: turns[sizes.indexOf(max)]!,
        compactions,
        large,
        compacted,
        sizes,
      };
      const root = s.isSubagent ? (s.parentSessionId ?? s.id.split(':')[0] ?? s.id) : s.id;
      const tree = trees.get(root) ?? { subs: [] };
      if (s.isSubagent) tree.subs.push(g);
      else tree.main = g;
      trees.set(root, tree);
    }
    const findings: Finding[] = [];
    for (const [root, { main, subs }] of trees) {
      if (main !== undefined)
        findings.push({
          analyzer: 'context-growth',
          severity: 'warn',
          title: `Session ${short(main.s.id)} ${why(main).join(' and ')} over ${plural(main.turns, 'turn')}`,
          tokens: { value: main.max, kind: 'measured' },
          data: {
            max: main.max,
            turns: main.turns,
            compactions: main.compactions,
            curve: downsample(main.sizes),
          },
          evidence: [
            {
              sessionId: main.s.id,
              turnUuid: main.peak.uuid,
              detail: `peak context ${fmt(main.max)} tokens at turn ${main.peak.index + 1}`,
              source: main.peak.source,
            },
          ],
          fix: { summary: MAIN_FIX },
          ...overImpact([main], contextLargeTokens, false),
        });
      if (subs.length === 0) continue;
      // One finding for every flagged subagent of the tree; evidence names each agent.
      subs.sort((a, b) => b.max - a.max || a.s.id.localeCompare(b.s.id, 'en'));
      const top = subs[0]!;
      const compactions = subs.reduce((a, g) => a + g.compactions, 0);
      findings.push({
        analyzer: 'context-growth',
        severity: 'warn',
        title:
          subs.length === 1
            ? `Subagent ${shortAgent(top.s)} of session ${short(root)} ${why(top).join(' and ')} over ${plural(top.turns, 'turn')}`
            : `${subs.length} subagents of session ${short(root)} ` +
              [
                subs.some((g) => g.large) ? 'grew large' : '',
                subs.some((g) => g.compacted) ? 'compacted repeatedly' : '',
              ]
                .filter(Boolean)
                .join(' or ') +
              `; largest peaked at ${fmt(top.max)} tokens ` +
              `(subagent ${shortAgent(top.s)}, ${plural(top.turns, 'turn')})`,
        tokens: { value: top.max, kind: 'measured' },
        data: {
          subagents: subs.length,
          max: top.max,
          turns: top.turns,
          totalTurns: subs.reduce((a, g) => a + g.turns, 0),
          compactions,
        },
        evidence: subs.slice(0, MAX_EVIDENCE).map((g) => ({
          sessionId: g.s.id,
          turnUuid: g.peak.uuid,
          detail:
            `subagent ${shortAgent(g.s)}: ${why(g).join(', ')} over ${plural(g.turns, 'turn')} ` +
            `(peak ${fmt(g.max)} at turn ${g.peak.index + 1})`,
          source: g.peak.source,
        })),
        fix: { summary: SUBAGENT_FIX },
        ...overImpact(subs, contextLargeTokens, true),
      });
    }
    return findings;
  },
};
