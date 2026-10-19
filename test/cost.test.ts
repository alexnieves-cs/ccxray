import { describe, expect, it } from 'vitest';
import {
  addTurnCost,
  emptyCost,
  roundCost,
  turnCost,
  unitPrices,
  writeSplit,
} from '../src/cost/cost.js';
import { cheaperModel, priceFor, pricedId, PRICES_AS_OF } from '../src/cost/prices.js';
import { computeTotals } from '../src/analyzers/totals.js';
import type { Session, Turn, Usage } from '../src/model/index.js';

const u = (x: Partial<Usage>): Usage => ({
  input: 0,
  cacheWrite: 0,
  cacheRead: 0,
  output: 0,
  ...x,
});
const turn = (model: string, usage: Partial<Usage>) => ({ model, usage: u(usage) });

describe('price table', () => {
  it('is dated', () => expect(PRICES_AS_OF).toBe('2026-10-19'));

  it('matches exact ids, date and variant suffixes, most specific first', () => {
    expect(pricedId('claude-opus-5-5')).toBe('claude-opus-5-5');
    expect(pricedId('claude-opus-5')).toBe('claude-opus-5');
    expect(pricedId('claude-opus-5-5[1m]')).toBe('claude-opus-5-5');
    expect(pricedId('claude-opus-4-5-20251101')).toBe('claude-opus-4-5');
    expect(pricedId('claude-opus-4-20250514')).toBe('claude-opus-4');
    expect(pricedId('claude-opus-4-1-20250805')).toBe('claude-opus-4-1');
    expect(pricedId('claude-sonnet-4-5@20250929')).toBe('claude-sonnet-4-5');
    expect(pricedId('claude-fable-5-1')).toBe('claude-fable-5-1');
    expect(pricedId('claude-mythos-5')).toBe('claude-mythos-5');
    expect(pricedId('claude-3-5-haiku-20241022')).toBe('claude-3-5-haiku');
    expect(priceFor('claude-opus-5-5')?.read).toBe(0.2);
    expect(priceFor('claude-opus-5')?.read).toBe(0.5);
    expect(priceFor('claude-sonnet-5-5')?.read).toBe(0.1);
    expect(priceFor('claude-sonnet-5')?.read).toBe(0.2);
  });

  it('never guesses a price for unknown models', () => {
    for (const m of ['<synthetic>', 'claude-opus-4-9', 'claude-opus-5-5x', 'gpt-5', '', 'opus'])
      expect(priceFor(m)).toBeUndefined();
    expect(turnCost(turn('<synthetic>', { output: 10 }))).toBeNull();
  });

  it('tiers Haiku 5.5 by prompt length (input + cache read + cache write)', () => {
    expect(priceFor('claude-haiku-5-5', 100_000)?.input).toBe(0.1);
    expect(priceFor('claude-haiku-5-5', 100_001)?.input).toBe(0.5);
    // 60k read + 40k write + 1 input = 100,001 → long tier for every kind, output included.
    const c = turnCost(
      turn('claude-haiku-5-5', {
        input: 1,
        cacheRead: 60_000,
        cacheWrite: 40_000,
        output: 1_000_000,
      }),
    )!;
    expect(c.output).toBeCloseTo(2.5);
    expect(c.read).toBeCloseTo((60_000 * 0.05) / 1e6);
    const small = turnCost(turn('claude-haiku-5-5', { cacheRead: 100_000, output: 1_000_000 }))!;
    expect(small.output).toBeCloseTo(0.5);
  });

  it('names the next tier down for the subagent lever', () => {
    expect(cheaperModel('claude-opus-5-5')).toBe('claude-sonnet-5-5');
    expect(cheaperModel('claude-fable-5-1')).toBe('claude-sonnet-5-5');
    expect(cheaperModel('claude-sonnet-4-5-20250929')).toBe('claude-haiku-5-5');
    expect(cheaperModel('claude-haiku-4-5')).toBeUndefined();
    expect(cheaperModel('mystery')).toBeUndefined();
  });
});

describe('turnCost', () => {
  it('prices every kind, the 1h write at its own rate', () => {
    const c = turnCost(
      turn('claude-opus-5-5', {
        input: 1_000_000,
        cacheWrite: 3_000_000,
        cacheWrite5m: 1_000_000,
        cacheWrite1h: 2_000_000,
        cacheRead: 1_000_000,
        output: 1_000_000,
      }),
    )!;
    expect(roundCost(c)).toEqual({
      input: 4,
      write5m: 5,
      write1h: 16,
      read: 0.2,
      output: 20,
      total: 45.2,
    });
  });

  it('prices a write without a TTL split at the 5m rate (UNVERIFIED rule)', () => {
    expect(writeSplit(u({ cacheWrite: 10 }))).toEqual({ w5m: 10, w1h: 0 });
    const c = turnCost(turn('claude-sonnet-4-5', { cacheWrite: 1_000_000 }))!;
    expect(c.write5m).toBeCloseTo(3.75);
    expect(c.write1h).toBe(0);
  });

  it('re-prices the same tokens on another model', () => {
    const t = turn('claude-opus-5-5', { cacheRead: 1_000_000, output: 1_000_000 });
    expect(turnCost(t)!.total).toBeCloseTo(20.2);
    expect(turnCost(t, 'claude-sonnet-5-5')!.total).toBeCloseTo(10.1);
  });

  it('gives per-token write (TTL-weighted) and read prices', () => {
    const p = unitPrices(
      turn('claude-opus-5-5', { cacheWrite: 4, cacheWrite5m: 2, cacheWrite1h: 2 }),
    )!;
    expect(p.write * 1e6).toBeCloseTo(6.5);
    expect(p.read * 1e6).toBeCloseTo(0.2);
    expect(unitPrices(turn('claude-opus-5-5', {}), '1h')!.write * 1e6).toBeCloseTo(8);
    expect(unitPrices(turn('x', {}))).toBeNull();
  });

  it('counts unpriced turns instead of pricing them', () => {
    const t = emptyCost();
    addTurnCost(t, turn('mystery-model', { output: 5 }));
    addTurnCost(t, turn('claude-opus-5-5', { output: 1_000_000 }));
    expect(t.unpricedTurns).toBe(1);
    expect(t.total).toBeCloseTo(20);
  });
});

describe('totals.cost', () => {
  const mk = (over: Partial<Turn>): Turn =>
    ({
      sessionId: 's',
      uuid: 'u',
      messageId: 'm',
      ts: Date.UTC(2026, 9, 18),
      gapMs: null,
      index: 0,
      model: 'claude-opus-5-5',
      isSidechain: false,
      isSynthetic: false,
      usage: u({ output: 1_000_000 }),
      toolUses: [],
      toolResults: [],
      blockCounts: {},
      source: { file: 'f', line: 1 },
      ...over,
    }) as Turn;
  const session = (id: string, isSubagent: boolean, turns: Turn[]): Session => ({
    id,
    project: 'p',
    files: [],
    isSubagent,
    turns,
    prompts: [],
    events: [],
    firstTs: 0,
    lastTs: 0,
    ccVersions: [],
  });

  it('sums per model, per session and main vs subagent; Σ per model = total', () => {
    const totals = computeTotals([
      session('a', false, [
        mk({}),
        mk({ isSidechain: true, model: 'claude-sonnet-5-5' }),
        mk({ model: '<synthetic>', isSynthetic: true }),
        mk({ model: 'unknown-x' }),
      ]),
      session('a:agent-1', true, [mk({ isSidechain: true })]),
    ]);
    expect(totals.all.cost!.total).toBeCloseTo(50);
    expect(totals.all.cost!.unpricedTurns).toBe(1);
    expect(totals.byRole!.main.cost!.total).toBeCloseTo(20);
    expect(totals.byRole!.subagent.cost!.total).toBeCloseTo(30);
    const perModel = Object.values(totals.byModel).reduce((a, t) => a + t.cost!.total, 0);
    expect(perModel).toBeCloseTo(totals.all.cost!.total);
    expect(totals.bySession['a:agent-1']!.cost!.total).toBeCloseTo(20);
  });
});
