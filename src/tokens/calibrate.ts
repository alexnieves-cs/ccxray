// Estimator calibration (SPEC §4.5): how far chars/4 is from the measured token count.
//
// For two consecutive real turns p → t of one chain, request t is request p plus p's output plus
// whatever the client added between them. When exactly one tool_result was added (p made one
// tool call and got one result) and nothing else was logged in between (no prompt, no event):
//
//   context(x) = input + cacheWrite + cacheRead of turn x            (measured)
//   measured   = context(t) − context(p) − output(p)                 (tokens the result added)
//   ratio      = estTokens(result) / measured                        (estimate ÷ measured)
//
// A ratio above 1 means chars/4 overestimates. `measured` also includes the tool_result block
// framing and any text the client injects that the log does not show (e.g. system reminders),
// so ratios run slightly low; results under MIN_EST_TOKENS are skipped to keep that overhead
// small. Turns with a model change are skipped (different tokenizers).
// UNVERIFIED: that request t carries all of p's output tokens (thinking included) and nothing
// unlogged besides the tool_result; a client that drops or adds content biases the ratio.
import type { Report, Session, Turn } from '../model/index.js';

export const MIN_EST_TOKENS = 250;

const context = (t: Turn): number => t.usage.input + t.usage.cacheWrite + t.usage.cacheRead;
const chainOf = (t: Turn): string => (t.isSidechain ? `side:${t.agentId ?? ''}` : 'main');

/** Ratios of every usable sample, in session/turn order. */
export function calibrationSamples(sessions: readonly Session[]): number[] {
  const out: number[] = [];
  for (const s of sessions) {
    const last = new Map<string, Turn>();
    for (const t of s.turns) {
      const c = chainOf(t);
      const p = last.get(c);
      last.set(c, t);
      if (p === undefined || t.index !== p.index + 1 || p.isSynthetic || t.isSynthetic) continue;
      if (p.model !== t.model || p.toolUses.length !== 1 || p.toolResults.length !== 1) continue;
      const result = p.toolResults[0]!;
      if (result.estTokens < MIN_EST_TOKENS) continue;
      const inGap = (d: Date): boolean => d > p.ts && d <= t.ts;
      if (s.prompts.some((x) => inGap(x.ts)) || s.events.some((x) => inGap(x.ts))) continue;
      const measured = context(t) - context(p) - p.usage.output;
      if (measured <= 0) continue;
      out.push(result.estTokens / measured);
    }
  }
  return out;
}

export function calibrate(sessions: readonly Session[]): NonNullable<Report['calibration']> {
  const xs = calibrationSamples(sessions).sort((a, b) => a - b);
  const mid = Math.floor(xs.length / 2);
  const medianRatio =
    xs.length === 0 ? null : xs.length % 2 === 1 ? xs[mid]! : (xs[mid - 1]! + xs[mid]!) / 2;
  return {
    samples: xs.length,
    medianRatio: medianRatio === null ? null : Math.round(medianRatio * 1000) / 1000,
    note:
      'estimated: chars/4 estimate ÷ measured growth of input + cache_write + cache_read ' +
      '(minus the previous output) on turns that added exactly one tool_result; >1 means the ' +
      'estimate is high',
  };
}
