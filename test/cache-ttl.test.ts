// A12 cache-ttl (SPEC §5) on synthetic sessions, priced at claude-opus-4-5 list prices
// ($5 input, $6.25 5m write, $10 1h write, $0.50 read per MTok).
import { afterAll, describe, expect, it } from 'vitest';
import { session } from '../scripts/make-fixture.js';
import { cacheTtl } from '../src/analyzers/cache-ttl.js';
import { buildActionPlan } from '../src/cost/plan.js';
import { buildReport } from '../src/pipeline.js';
import { emptyStats } from '../src/parser/index.js';
import { built, cleanupTmp, ctx } from './helpers/analyzer-fixtures.js';

afterAll(cleanupTmp);

const CTX = 50_000;

/** `breaks` gaps of `gap`, each followed by the turn after it; `ttl` decides the write field. */
function chain(name: string, ttl: '5m' | '1h', breaks: number, gap: string, rebuilt: boolean) {
  const w = (n: number) => (ttl === '1h' ? { cacheWrite: n, cacheWrite1h: n } : { cacheWrite: n });
  const b = session(name, { model: 'claude-opus-4-5' });
  b.prompt('start').assistant({ usage: { input: 3, ...w(CTX), output: 100 } });
  b.prompt('go').assistant({ usage: { input: 3, cacheRead: CTX, ...w(500), output: 100 } });
  for (let i = 0; i < breaks; i++) {
    b.gap(gap);
    b.prompt('back').assistant({
      usage: rebuilt
        ? { input: 3, ...w(CTX + 500), output: 100 }
        : { input: 3, cacheRead: CTX + 500, ...w(500), output: 100 },
    });
    b.prompt('go').assistant({ usage: { input: 3, cacheRead: CTX + 500, ...w(500), output: 100 } });
  }
  return b;
}

describe('A12 cache-ttl', () => {
  it('5m TTL with 10-minute breaks: 1h would have saved the rebuilds net of its premium', async () => {
    const [f, ...rest] = cacheTtl.run(
      await built('ttl-5m', [chain('a', '5m', 3, '10m', true)]),
      ctx(),
    );
    expect(rest).toEqual([]);
    expect(f!.data).toMatchObject({ ttl: '1h', rebuilds: 3 });
    // 3 rebuilds × 50,500 × ($6.25 − $0.50) = $0.871125 avoided; the other 5m writes
    // (50,000 + 500 + 3 × 500 = 52,000) × ($10 − $6.25) = $0.195 extra.
    expect(f!.data!.avoidedUsd).toBeCloseTo(0.871125, 6);
    expect(f!.data!.extraUsd).toBeCloseTo(0.195, 6);
    expect(f!.impact!.savingsUsd).toBeCloseTo(0.676125, 5);
    expect(f!.fix.summary).toContain('"promptCacheTtl": "1h"');
  });

  it('new content in a rebuild is still written under 1h, at the 1h price', async () => {
    const b = session('grow', { model: 'claude-opus-4-5' });
    b.prompt('start').assistant({ usage: { input: 3, cacheWrite: CTX, output: 100 } });
    b.prompt('go').assistant({ usage: { input: 3, cacheRead: CTX, output: 100 } });
    let cached = CTX;
    for (let i = 0; i < 3; i++) {
      b.gap('10m');
      // Rewrites the cached prefix plus 20,000 new tokens.
      b.prompt('back').assistant({ usage: { input: 3, cacheWrite: cached + 20_000, output: 100 } });
      cached += 20_000;
      b.prompt('go').assistant({ usage: { input: 3, cacheRead: cached, output: 100 } });
    }
    const [f] = cacheTtl.run(await built('ttl-grow', [b]), ctx());
    // Each rebuild under 1h: the prefix (50k, 70k, 90k) read at $0.50 and 20,000 new tokens
    // written at $10, instead of all of it written at $6.25.
    const avoided = [50_000, 70_000, 90_000].reduce(
      (a, k) => a + ((k + 20_000) * 6.25 - (k * 0.5 + 20_000 * 10)) / 1e6,
      0,
    );
    expect(f!.data!.rebuilds).toBe(3);
    expect(f!.data!.avoidedUsd).toBeCloseTo(avoided, 6);
  });

  it('a window with both TTLs gets one direction: the larger net', async () => {
    const s = await built('ttl-both', [
      chain('m5', '5m', 3, '10m', true),
      chain('m1', '1h', 3, '1m', false),
    ]);
    const found = cacheTtl.run(s, ctx());
    expect(found).toHaveLength(1);
    expect(found[0]!.data).toMatchObject({ ttl: '1h' });
  });

  it('5m TTL with breaks over an hour: no finding (1h would expire too)', async () => {
    const s = await built('ttl-5m-long', [chain('b', '5m', 3, '90m', true)]);
    expect(cacheTtl.run(s, ctx())).toEqual([]);
  });

  it('1h TTL never needed: 5m would have saved the write premium', async () => {
    const [f] = cacheTtl.run(await built('ttl-1h-idle', [chain('c', '1h', 3, '1m', false)]), ctx());
    expect(f!.data).toMatchObject({ ttl: '5m', warmBreaks: 0, lostUsd: 0 });
    // (50,000 + 500 + 6 × 500 = 53,500) × ($10 − $6.25) = $0.200625
    expect(f!.impact!.savingsUsd).toBeCloseTo(0.200625, 6);
  });

  it('1h TTL that kept 20-minute breaks warm: no finding', async () => {
    const s = await built('ttl-1h-busy', [chain('d', '1h', 3, '20m', false)]);
    expect(cacheTtl.run(s, ctx())).toEqual([]);
  });

  it('becomes a "Set the prompt cache TTL" action with the settings change', async () => {
    const sessions = await built('ttl-plan', [chain('e', '5m', 4, '10m', true)]);
    const report = buildReport({
      sessions,
      stats: emptyStats(),
      ctx: ctx(),
      window: { since: null, until: null, project: null },
      includeContent: false,
    });
    const a = buildActionPlan(report).actions.find((x) => x.id === 'cache-ttl-1h');
    expect(a?.title).toBe('Set the prompt cache TTL to 1h');
    expect(a?.category).toBe('cache-ttl');
    expect(a?.change).toContain('CLAUDE_CODE_PROMPT_CACHE_TTL=1h');
  });
});
