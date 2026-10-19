// A1 totals (SPEC §5): measured token sums. They go into Report.totals, not into findings.
//
// Counted: every deduped (src/parser/dedupe.ts), non-synthetic assistant turn of every session,
// INCLUDING subagent sessions and sidechain turns: subagent requests are real API spend, and
// ccusage counts them too. Synthetic turns (`<synthetic>` model, API errors) are excluded
// (SPEC §4.2). Dedupe across files already happened in the parser, so nothing is counted twice.
//
// Every bucket also carries `cost`: the same tokens at API list prices [E] (src/cost). Turns on
// unpriced models are counted in cost.unpricedTurns and left out of the $ sums.
import { addCost, emptyCost, roundCost, turnCost, type Cost } from '../cost/cost.js';
import type { Session, TokenTotals, Totals, Turn } from '../model/index.js';

export function emptyTokenTotals(): TokenTotals {
  return {
    input: 0,
    cacheWrite: 0,
    cacheWrite5m: 0,
    cacheWrite1h: 0,
    cacheRead: 0,
    output: 0,
    cacheHitRatio: null,
    turns: 0,
    cost: emptyCost(),
  };
}

// `c` is the turn's cost, computed once per turn and added to every bucket.
function add(t: TokenTotals, turn: Turn, c: Cost | null = turnCost(turn)): void {
  const u = turn.usage;
  t.input += u.input;
  t.cacheWrite += u.cacheWrite;
  t.cacheWrite5m += u.cacheWrite5m ?? 0;
  t.cacheWrite1h += u.cacheWrite1h ?? 0;
  t.cacheRead += u.cacheRead;
  t.output += u.output;
  t.turns++;
  if (t.cost !== undefined) addCost(t.cost, c);
}

/** read / (read + write + input); null when the denominator is 0. Measured. */
export function withHitRatio(t: TokenTotals): TokenTotals {
  const denom = t.cacheRead + t.cacheWrite + t.input;
  t.cacheHitRatio = denom > 0 ? t.cacheRead / denom : null;
  if (t.cost !== undefined) t.cost = roundCost(t.cost);
  return t;
}

/** UTC calendar day of a turn, `YYYY-MM-DD`. */
export const utcDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/** Totals of one session's non-synthetic turns. */
export function sessionTotals(s: Session): TokenTotals {
  const t = emptyTokenTotals();
  for (const turn of s.turns) if (!turn.isSynthetic) add(t, turn);
  return withHitRatio(t);
}

export function computeTotals(sessions: readonly Session[]): Totals {
  const all = emptyTokenTotals();
  const main = emptyTokenTotals();
  const subagent = emptyTokenTotals();
  // Maps, not objects: a model name such as `__proto__` must stay an ordinary key.
  const maps = {
    bySession: new Map<string, TokenTotals>(),
    byProject: new Map<string, TokenTotals>(),
    byModel: new Map<string, TokenTotals>(),
    byDay: new Map<string, TokenTotals>(),
  };
  const bucket = (m: Map<string, TokenTotals>, k: string): TokenTotals => {
    let t = m.get(k);
    if (t === undefined) m.set(k, (t = emptyTokenTotals()));
    return t;
  };
  for (const s of sessions) {
    // Every session gets an entry, even one whose turns are all synthetic (zeros).
    const ss = bucket(maps.bySession, s.id);
    for (const turn of s.turns) {
      if (turn.isSynthetic) continue;
      const c = turnCost(turn);
      add(all, turn, c);
      add(s.isSubagent || turn.isSidechain ? subagent : main, turn, c);
      add(ss, turn, c);
      add(bucket(maps.byProject, s.project), turn, c);
      add(bucket(maps.byModel, turn.model), turn, c);
      add(bucket(maps.byDay, utcDay(turn.ts)), turn, c);
    }
  }
  const obj = (m: Map<string, TokenTotals>): Record<string, TokenTotals> =>
    Object.fromEntries([...m].map(([k, t]) => [k, withHitRatio(t)]));
  return {
    all: withHitRatio(all),
    bySession: obj(maps.bySession),
    byProject: obj(maps.byProject),
    byModel: obj(maps.byModel),
    byDay: obj(maps.byDay),
    byRole: { main: withHitRatio(main), subagent: withHitRatio(subagent) },
  };
}
