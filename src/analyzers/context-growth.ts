// A8 context-growth (SPEC §5): per-session curve of context size (input + cache read + cache
// write per turn) [M]; flags sessions that got large or were compacted repeatedly.

import type { Analyzer, Finding, Session, Turn } from '../model/index.js';
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

interface Grown {
  s: Session;
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
      const g: Grown = {
        s,
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
            : `${subs.length} subagents of session ${short(root)} grew large` +
              `${compactions > 0 ? ` or compacted` : ''}; largest peaked at ${fmt(top.max)} tokens ` +
              `(subagent ${shortAgent(top.s)}, ${top.turns} turns)`,
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
      });
    }
    return findings;
  },
};
