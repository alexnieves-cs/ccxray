// A8 context-growth. Context = input + cache read + cache write; expected numbers by hand.
import { afterAll, describe, expect, it } from 'vitest';
import { session, type SessionBuilder } from '../../scripts/make-fixture.js';
import { contextGrowth, downsample } from '../../src/analyzers/context-growth.js';
import { cleanup, run } from '../helpers/analyze.js';

afterAll(cleanup);

/** One compaction as Claude Code is reported to log it: a boundary plus a summary line. */
const compact = (s: SessionBuilder) =>
  s
    .record('system', { subtype: 'compact_boundary' })
    .prompt('summary of the earlier conversation', { isCompactSummary: true });

describe('A8 context-growth', () => {
  it('positive: flags a session whose context reached 150k', async () => {
    const s = session('a8/p1')
      .prompt('go')
      .assistant({ usage: { input: 2, cacheWrite: 50_000 } })
      .assistant({ usage: { input: 2, cacheWrite: 50_000, cacheRead: 50_000 } })
      .assistant({ usage: { input: 3, cacheWrite: 60_000, cacheRead: 100_000, output: 9 } });
    const [f, ...rest] = await run(contextGrowth, [s]);
    expect(rest).toEqual([]);
    expect(f!.tokens).toEqual({ value: 160_003, kind: 'measured' });
    expect(f!.data).toEqual({
      max: 160_003,
      turns: 3,
      compactions: 0,
      curve: [50_002, 100_002, 160_003],
    });
    expect(f!.evidence[0]!.detail).toBe('peak context 160,003 tokens at turn 3');
  });

  it('positive: flags 2 compactions even when the context stays small', async () => {
    const s = session('a8/p2')
      .prompt('go')
      .assistant({ usage: { cacheWrite: 1_000 } });
    compact(s).assistant({ usage: { cacheWrite: 1_100 } });
    compact(s).assistant({ usage: { cacheWrite: 1_200 } });
    const [f, ...rest] = await run(contextGrowth, [s]);
    expect(rest).toEqual([]);
    expect(f!.data).toMatchObject({ max: 1_200, turns: 3, compactions: 2 });
    expect(f!.title).toContain('compacted 2×');
  });

  it('positive: long sessions get a 50-point curve of bucket maxima', async () => {
    const s = session('a8/p3').prompt('go');
    for (let i = 1; i <= 120; i++) s.assistant({ usage: { cacheWrite: 1_000 * i } });
    const [f] = await run(contextGrowth, [s], { contextLargeTokens: 100_000 });
    const curve = f!.data?.curve as number[];
    expect(f!.data).toMatchObject({ max: 120_000, turns: 120 });
    expect(curve).toHaveLength(50);
    expect(curve[0]).toBe(2_000); // turns 1–2
    expect(curve[49]).toBe(120_000); // turns 118–120
    expect(downsample([1, 5, 2, 8, 3], 2)).toEqual([5, 8]);
  });

  it('negative: a small session without compactions', async () => {
    const s = session('a8/n1')
      .prompt('go')
      .assistant({ usage: { input: 3, cacheWrite: 20_000 } })
      .assistant({ usage: { input: 2, cacheWrite: 500, cacheRead: 20_000 } });
    expect(await run(contextGrowth, [s])).toEqual([]);
  });

  it('negative: markers of one compaction count once; 149,999 is under the threshold', async () => {
    const s = session('a8/n2')
      .prompt('go')
      .assistant({ usage: { input: 1, cacheWrite: 49_998, cacheRead: 100_000 } });
    compact(s).meta({ type: 'summary', summary: 'x', leafUuid: 'y' });
    s.assistant({ usage: { cacheWrite: 30_000 } });
    expect(await run(contextGrowth, [s])).toEqual([]);
    const [f] = await run(contextGrowth, [s], { compactionsPerSession: 1 });
    expect(f!.data?.compactions).toBe(1);
  });

  it('review: subagent transcripts are covered too', async () => {
    const p = session('a8/r1')
      .prompt('go')
      .assistant({ usage: { cacheWrite: 10_000 } });
    const a = p.agent('big').prompt('explore');
    a.assistant({ usage: { cacheWrite: 90_000 } }).assistant({
      usage: { cacheWrite: 70_000, cacheRead: 90_000 },
    });
    const [f, ...rest] = await run(contextGrowth, [p, a]);
    expect(rest).toEqual([]);
    expect(f!.data).toMatchObject({ max: 160_000, turns: 2 });
    expect(f!.title).toMatch(/^Subagent /);
  });
});
