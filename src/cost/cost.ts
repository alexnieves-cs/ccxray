// Cost model (SPEC §5.1). Pure. Token counts are measured [M]; every $ figure is an estimate [E]:
// what the tokens would cost at API list prices (prices.ts). Max/Pro subscribers do not pay per
// token, so $ is a common unit to compare token kinds, not a bill.
import type { CostTotals, Turn, Usage } from '../model/index.js';
import { priceFor, type Price } from './prices.js';

export type { CostTotals };

/** USD per token kind, and their sum. */
export interface Cost {
  input: number;
  write5m: number;
  write1h: number;
  read: number;
  output: number;
  total: number;
}

export const COST_NOTE =
  '$ = what these tokens would cost at API list prices; subscription limits are not ' +
  'published, use it to compare, not as a bill';

/** Prompt length for long-prompt tiers: every input token, cache reads and writes included. */
export const promptTokens = (u: Usage): number => u.input + u.cacheRead + u.cacheWrite;

/**
 * The 5m / 1h split of a turn's cache write. The 1h part is `cacheWrite1h`; the rest is 5m.
 * UNVERIFIED: when the `cache_creation` split is missing, the whole write is priced at the 5m
 * rate (SPEC §4.4).
 */
export function writeSplit(u: Usage): { w5m: number; w1h: number } {
  const w1h = Math.min(u.cacheWrite, Math.max(0, u.cacheWrite1h ?? 0));
  return { w5m: u.cacheWrite - w1h, w1h };
}

export function costOf(u: Usage, price: Price): Cost {
  const { w5m, w1h } = writeSplit(u);
  const c = {
    input: (u.input * price.input) / 1e6,
    write5m: (w5m * price.write5m) / 1e6,
    write1h: (w1h * price.write1h) / 1e6,
    read: (u.cacheRead * price.read) / 1e6,
    output: (u.output * price.output) / 1e6,
  };
  return { ...c, total: c.input + c.write5m + c.write1h + c.read + c.output };
}

/**
 * List-price cost of one turn, or null when its model is unpriced. `model` re-prices the same
 * tokens on another model (A9's "cheaper model" lever).
 */
export function turnCost(turn: Pick<Turn, 'model' | 'usage'>, model = turn.model): Cost | null {
  const price = priceFor(model, promptTokens(turn.usage));
  return price === undefined ? null : costOf(turn.usage, price);
}

/** Per-token prices of one turn's prompt content: cache write (weighted by the turn's TTL
 * split) and cache read. null when unpriced. `ttl` picks the write rate when the turn wrote
 * nothing. */
export function unitPrices(
  turn: Pick<Turn, 'model' | 'usage'>,
  ttl: '5m' | '1h' = '5m',
): { write: number; read: number } | null {
  const price = priceFor(turn.model, promptTokens(turn.usage));
  if (price === undefined) return null;
  const { w5m, w1h } = writeSplit(turn.usage);
  const write =
    w5m + w1h > 0
      ? (w5m * price.write5m + w1h * price.write1h) / (w5m + w1h)
      : ttl === '1h'
        ? price.write1h
        : price.write5m;
  return { write: write / 1e6, read: price.read / 1e6 };
}

export function emptyCost(): CostTotals {
  return { input: 0, write5m: 0, write1h: 0, read: 0, output: 0, total: 0, unpricedTurns: 0 };
}

/** Add one turn's cost into `t` (or count it as unpriced). Mutates and returns `t`. */
export function addTurnCost(t: CostTotals, turn: Pick<Turn, 'model' | 'usage'>): CostTotals {
  return addCost(t, turnCost(turn));
}

/** Add one turn's already computed cost into `t` (null = unpriced). Mutates and returns `t`. */
export function addCost(t: CostTotals, c: Cost | null): CostTotals {
  if (c === null) {
    t.unpricedTurns++;
    return t;
  }
  t.input += c.input;
  t.write5m += c.write5m;
  t.write1h += c.write1h;
  t.read += c.read;
  t.output += c.output;
  t.total += c.total;
  return t;
}

/** Sum of costs. */
export function sumCosts(cs: readonly CostTotals[]): CostTotals {
  const t = emptyCost();
  for (const c of cs) {
    t.input += c.input;
    t.write5m += c.write5m;
    t.write1h += c.write1h;
    t.read += c.read;
    t.output += c.output;
    t.total += c.total;
    t.unpricedTurns += c.unpricedTurns;
  }
  return t;
}

/** Round every $ field to 1e-6 (micro-dollars), so JSON output is stable. */
export const usd = (x: number): number => Math.round(x * 1e6) / 1e6;

export function roundCost<T extends Cost>(c: T): T {
  return {
    ...c,
    input: usd(c.input),
    write5m: usd(c.write5m),
    write1h: usd(c.write1h),
    read: usd(c.read),
    output: usd(c.output),
    total: usd(c.total),
  };
}
