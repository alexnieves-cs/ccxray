// Finding.impact (SPEC §5.2): carry cost and each analyzer's lever. Synthetic sessions on Opus 5.5
// ($/MTok: write 5m 5, write 1h 8, read 0.20, output 20); every expected $ is worked out by hand.
import { afterAll, describe, expect, it } from 'vitest';
import { session, text, toolUse, type UsageSpec } from '../scripts/make-fixture.js';
import { bigToolOutput } from '../src/analyzers/big-tool-output.js';
import { cacheRebuild } from '../src/analyzers/cache-rebuild.js';
import { contextGrowth } from '../src/analyzers/context-growth.js';
import { subagentCost } from '../src/analyzers/subagent-cost.js';
import { toolUsage } from '../src/analyzers/tool-usage.js';
import { CarryIndex } from '../src/cost/carry.js';
import { DEFAULT_THRESHOLDS } from '../src/model/index.js';
import { sortFindings } from '../src/reporters/derive.js';
import { cleanup, load, run, toolDef } from './helpers/analyze.js';

afterAll(cleanup);

const OPUS = { model: 'claude-opus-5-5' };
const say = (u: UsageSpec) => ({ usage: u, blocks: [text('ok')] });

/**
 * t0 runs a Bash command whose result is 40,000 chars (10,000 est. tokens); t1 writes it; t2
 * reads it; t3 is a rebuild (pays the write price again); t4 reads it; a compaction drops it
 * before t5.
 */
function carried(model = OPUS.model) {
  const s = session('impact/carry', { model })
    .prompt('run it')
    .assistant({
      usage: { cacheWrite: 20_000 },
      blocks: [toolUse('Bash', { command: 'pnpm test' })],
    })
    .toolResult(40_000)
    .assistant(say({ cacheRead: 20_000, cacheWrite: 10_500 }))
    .prompt('next')
    .assistant(say({ cacheRead: 30_500, cacheWrite: 100 }))
    .prompt('later')
    .assistant(say({ cacheRead: 0, cacheWrite: 31_000 }))
    .prompt('more')
    .assistant(say({ cacheRead: 31_000, cacheWrite: 100 }))
    .record('system', { subtype: 'compact_boundary' })
    .prompt('after')
    .assistant(say({ cacheRead: 5_000, cacheWrite: 2_000 }));
  return s;
}

describe('carry cost', () => {
  it('writes once, reads every later turn, re-writes on a rebuild, stops at a compaction', async () => {
    const sessions = await load([carried()]);
    const idx = new CarryIndex(sessions, DEFAULT_THRESHOLDS);
    const t0 = sessions[0]!.turns[0]!;
    const c = idx.carry(t0, 10_000);
    // 10,000 × (5 write + 0.20 read + 5 rebuild write + 0.20 read) $/MTok = $0.104
    expect(c.turnsCarried).toBe(4);
    expect(c.usd).toBeCloseTo(0.104, 9);
    expect(c.unpriced).toBe(false);
    // Content added by the last turn before the compaction is never sent again.
    expect(idx.carry(sessions[0]!.turns[4]!, 1_000)).toMatchObject({ usd: 0, turnsCarried: 0 });
  });

  it('A5: cost is the carry, savings assume the output is cut to ~1k tokens', async () => {
    const [f] = await run(bigToolOutput, [carried()]);
    expect(f!.impact).toMatchObject({
      costUsd: 0.104,
      savingsUsd: 0.0936, // 9,000 of the 10,000 tokens not carried
      savingsMainUsd: 0.0936,
      savingsSubagentUsd: 0,
      confidence: 'estimated',
    });
    expect(f!.impact!.basis).toContain('stayed in context for 4 turns');
    expect(f!.data?.turnsCarriedMax).toBe(4);
  });

  it('unpriced models count 0 $ and are flagged, never guessed', async () => {
    const sessions = await load([carried('claude-unknown-9')]);
    const c = new CarryIndex(sessions, DEFAULT_THRESHOLDS).carry(sessions[0]!.turns[0]!, 10_000);
    expect(c).toEqual({ usd: 0, turnsCarried: 4, unpriced: true });
    expect((await run(bigToolOutput, [carried('claude-unknown-9')]))[0]!.impact).toBeUndefined();
  });
});

describe('levers', () => {
  it('A2: write price − read price by the turn TTL split', async () => {
    const s = session('impact/a2', OPUS)
      .prompt('a')
      .assistant(say({ cacheWrite: 20_000, cacheWrite1h: 20_000 }))
      .prompt('b')
      .assistant(say({ cacheRead: 20_000, cacheWrite: 100, cacheWrite1h: 100 }))
      .gap('2h')
      .prompt('c')
      .assistant(say({ cacheWrite: 20_000, cacheWrite1h: 20_000 }));
    const [f] = await run(cacheRebuild, [s]);
    // 20,000 × 8 = $0.16 written; as reads 20,000 × 0.20 = $0.004.
    expect(f!.impact).toMatchObject({
      costUsd: 0.16,
      savingsUsd: 0.156,
      confidence: 'measured-tokens',
    });
    expect(f!.data?.causes).toEqual([
      expect.objectContaining({ cause: 'ttl-expiry', savingsUsd: 0.156 }),
    ]);
  });

  it('A7: unused definitions × every main-chain request; built-ins save nothing', async () => {
    const s = session('impact/a7', OPUS)
      .attachment({
        type: 'prompt_snapshot',
        tools: [toolDef('Bash', 400), toolDef('mcp__gh__issue', 4_000)],
      })
      .prompt('go')
      .assistant({ usage: { cacheWrite: 20_000 }, blocks: [toolUse('Bash', { command: 'ls' })] })
      .toolResult(10)
      .assistant(say({ cacheRead: 20_000, cacheWrite: 100 }))
      .prompt('more')
      .assistant(say({ cacheRead: 20_100, cacheWrite: 100 }));
    const fs = await run(toolUsage, [s]);
    const gh = fs.find((f) => f.data?.server === 'gh')!;
    // 1,000 tokens × (5 cold write + 0.20 + 0.20) $/MTok = $0.0054
    expect(gh.impact).toMatchObject({ costUsd: 0.0054, savingsUsd: 0.0054 });
    expect(gh.impact!.basis).toContain('3 main-session requests (written on 1 cold');
  });

  it('A8: context above the threshold × the read price', async () => {
    const s = session('impact/a8', OPUS)
      .prompt('a')
      .assistant(say({ cacheWrite: 25_000 }))
      .prompt('b')
      .assistant(say({ cacheRead: 25_000, cacheWrite: 5_000 }));
    const [f] = await run(contextGrowth, [s], { contextLargeTokens: 20_000 });
    // (5,000 + 10,000) × 0.20 $/MTok = $0.003
    expect(f!.impact).toMatchObject({ costUsd: 0.003, savingsUsd: 0.003, savingsMainUsd: 0.003 });
    expect(f!.impact!.basis).toContain('/clear');
  });

  it('A9: same tokens one tier down, by subagent type, with the caveat', async () => {
    const p = session('impact/a9', OPUS)
      .prompt('go')
      .assistant({
        usage: { cacheWrite: 10_000 },
        blocks: [
          toolUse('Agent', { subagent_type: 'Explore', model: 'opus', prompt: 'p' }, 'toolu_x1'),
        ],
      });
    const a = p
      .agent('x1', { meta: { toolUseId: 'toolu_x1' } })
      .prompt('p')
      .assistant(say({ output: 1_000_000 }));
    const [f] = await run(subagentCost, [p, a]);
    // $20 of output on Opus 5.5 → $10 on Sonnet 5.5.
    expect(f!.impact).toMatchObject({ costUsd: 20, savingsUsd: 10, savingsSubagentUsd: 10 });
    expect(f!.impact!.basis).toContain('may do worse');
    expect(f!.data?.subagentTypes).toEqual([
      {
        type: 'Explore',
        agents: 1,
        model: 'claude-opus-5-5',
        cheaperModel: 'claude-sonnet-5-5',
        costUsd: 20,
        savingsUsd: 10,
        explicitModel: 1,
      },
    ]);
  });

  it('TOP FINDINGS rank by savings, then unpriced findings by severity and tokens', async () => {
    const fs = sortFindings([
      ...(await run(bigToolOutput, [carried()])),
      ...(await run(contextGrowth, [carried()], { contextLargeTokens: 20_000 })),
      {
        analyzer: 'x',
        severity: 'high',
        title: 'unpriced',
        tokens: { value: 9e9, kind: 'measured' },
        evidence: [],
        fix: { summary: '' },
      },
    ]);
    expect(fs.map((f) => f.analyzer)).toEqual(['big-tool-output', 'context-growth', 'x']);
    expect(fs[0]!.impact!.savingsUsd).toBeGreaterThan(fs[1]!.impact!.savingsUsd);
  });
});
