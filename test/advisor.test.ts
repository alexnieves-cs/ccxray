// Advisor-tool calls (FORMAT.md): `usage.iterations[]` entries of `type: "advisor_message"` are
// separate requests on the advisor's model, left out of the top-level usage. All content is
// synthetic; numbers worked out by hand below.
import { afterAll, describe, expect, it } from 'vitest';
import { session } from '../scripts/make-fixture.js';
import { computeTotals, sessionTotals } from '../src/analyzers/totals.js';
import { readUsage } from '../src/parser/records.js';
import { pricingInfo } from '../src/pipeline.js';
import { cleanup, load } from './helpers/analyze.js';

afterAll(cleanup);

describe('advisor calls', () => {
  it('reads advisor_message iterations and skips the executor ones', () => {
    const u = readUsage({
      input_tokens: 10,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 400,
      output_tokens: 50,
      iterations: [
        { type: 'message', input_tokens: 10, cache_read_input_tokens: 400, output_tokens: 50 },
        {
          type: 'advisor_message',
          model: 'claude-fable-5-2',
          input_tokens: 900,
          output_tokens: 70,
        },
        { type: 'advisor_message', input_tokens: 5, output_tokens: 1 },
        'junk',
      ],
    })!;
    expect(u.input).toBe(10); // top-level stays the executor's
    expect(u.advisor).toEqual([
      { model: 'claude-fable-5-2', usage: { input: 900, cacheWrite: 0, cacheRead: 0, output: 70 } },
      { model: 'unknown', usage: { input: 5, cacheWrite: 0, cacheRead: 0, output: 1 } },
    ]);
    expect(readUsage({ input_tokens: 1, iterations: [{ type: 'message' }] })!.advisor).toBe(
      undefined,
    );
  });

  it('adds advisor tokens and cost to the totals, under the advisor model, with no extra turns', async () => {
    const s = session('advisor/one', { model: 'claude-sonnet-5-5' }).prompt('x');
    s.assistant({
      usage: {
        input: 100,
        cacheRead: 1_000,
        output: 200,
        advisor: [{ model: 'claude-fable-5-2', input: 10_000, output: 500 }],
      },
    });
    s.assistant({ usage: { input: 0, cacheRead: 1_200, output: 100 } });
    const sessions = await load([s]);
    const t = computeTotals(sessions);
    // Executor: input 100, read 2,200, output 300; advisor: input 10,000, output 500.
    expect(t.all).toMatchObject({ input: 10_100, cacheRead: 2_200, output: 800, turns: 2 });
    expect(t.byModel['claude-sonnet-5-5']).toMatchObject({ input: 100, output: 300, turns: 2 });
    expect(t.byModel['claude-fable-5-2']).toMatchObject({ input: 10_000, output: 500, turns: 0 });
    // Fable 5.2: 10,000 × $8 + 500 × $40 per MTok = $0.10; Sonnet 5.5: 100 × 2 + 2,200 × 0.10
    // + 300 × 10 = 3,420 µ$.
    expect(t.byModel['claude-fable-5-2']!.cost!.total).toBeCloseTo(0.1, 6);
    expect(t.all.cost!.total).toBeCloseTo(0.10342, 6);
    expect(sessionTotals(sessions[0]!)).toEqual(t.bySession[sessions[0]!.id]);
    expect(t.byRole?.main.input).toBe(10_100);
  });

  it('an advisor on an unpriced model is reported as unpriced, not priced as the executor', async () => {
    const s = session('advisor/unpriced', { model: 'claude-sonnet-5-5' }).prompt('x');
    s.assistant({
      usage: { input: 1, output: 1, advisor: [{ model: 'claude-mystery-9', input: 5 }] },
    });
    const sessions = await load([s]);
    expect(pricingInfo(sessions).unpricedModels).toEqual({ 'claude-mystery-9': 1 });
    expect(computeTotals(sessions).all.cost!.unpricedTurns).toBe(1);
  });
});
