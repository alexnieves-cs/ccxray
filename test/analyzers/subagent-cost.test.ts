// A9 subagent-cost. Tokens = input + cache write + cache read + output; expected by hand.
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { session, toolUse } from '../../scripts/make-fixture.js';
import { subagentCost } from '../../src/analyzers/subagent-cost.js';
import { loadSessions } from '../../src/parser/index.js';
import { cleanup, ctx, run } from '../helpers/analyze.js';

afterAll(cleanup);
const FX = join(import.meta.dirname, '..', 'fixtures', 'projects');

describe('A9 subagent-cost', () => {
  it('positive: nested-subagents-dir fixture, 2 subagents vs their parent', async () => {
    const { sessions } = await loadSessions({ roots: [join(FX, 'nested-subagents-dir')] });
    const fs = subagentCost.run(sessions, ctx());
    expect(fs).toHaveLength(1);
    const f = fs[0]!;
    // parent 9,075 + 9,234 = 18,309; n1 4,023 + 4,317 = 8,340; n2 4,115.
    expect(f.tokens).toEqual({ value: 12_455, kind: 'measured' });
    expect(f.data).toMatchObject({
      subagents: 2,
      subagentTokens: 12_455,
      parentTokens: 18_309,
      sharePct: 40, // 12,455 / 30,764
      subagentModels: 'claude-sonnet-4-5',
    });
    expect(f.data?.agents).toEqual([
      {
        agentId: 'n1',
        model: 'claude-sonnet-4-5',
        turns: 2,
        tokens: 8_340,
        parentToolUseId: 'toolu_agent_n1',
      },
      {
        agentId: 'n2',
        model: 'claude-sonnet-4-5',
        turns: 1,
        tokens: 4_115,
        parentToolUseId: 'toolu_agent_n2',
      },
    ]);
    expect(f.fix.summary).toContain('subagent `model:` field');
  });

  it('positive: reports the subagent model next to the parent model', async () => {
    const p = session('a9/p2', { model: 'claude-opus-4-1' })
      .prompt('go')
      .assistant({
        usage: { input: 10, cacheWrite: 20_000, output: 100 },
        blocks: [toolUse('Agent', { prompt: 'explore' }, 'toolu_h1')],
      });
    const a = p
      .agent('h1', { meta: { toolUseId: 'toolu_h1' } })
      .model('claude-haiku-4-5')
      .prompt('explore')
      .assistant({ usage: { input: 5, cacheWrite: 3_000, output: 50 } })
      .assistant({ usage: { input: 1, cacheWrite: 100, cacheRead: 3_000, output: 20 } });
    const [f, ...rest] = await run(subagentCost, [p, a]);
    expect(rest).toEqual([]);
    expect(f!.data).toMatchObject({
      subagentTokens: 6_176,
      parentTokens: 20_110,
      sharePct: 23, // 6,176 / 26,286
      parentModel: 'claude-opus-4-1',
      subagentModels: 'claude-haiku-4-5',
    });
    expect(f!.title).toContain('on claude-haiku-4-5');
  });

  it('positive: one finding per parent plus an overall one', async () => {
    const A = session('a9/p3a')
      .prompt('go')
      .assistant({ usage: { cacheWrite: 10_000 } });
    const a1 = A.agent('a1')
      .prompt('x')
      .assistant({ usage: { cacheWrite: 2_000 } });
    const B = session('a9/p3b')
      .prompt('go')
      .assistant({ usage: { cacheWrite: 30_000 } });
    const b1 = B.agent('b1')
      .prompt('x')
      .assistant({ usage: { cacheWrite: 6_000 } });
    const b2 = B.agent('b2')
      .prompt('y')
      .assistant({ usage: { cacheWrite: 2_000 } });
    const fs = await run(subagentCost, [A, a1, B, b1, b2]);
    expect(fs.map((f) => [f.tokens.value, f.data?.sharePct])).toEqual(
      expect.arrayContaining([
        [2_000, 17], // 2,000 / 12,000
        [8_000, 21], // 8,000 / 38,000
        [10_000, 20], // 10,000 / 50,000
      ]),
    );
    expect(fs).toHaveLength(3);
    expect(fs[2]!.data).toMatchObject({ parents: 2, subagents: 3, parentTokens: 40_000 });
  });

  it('negative: no subagent transcripts', async () => {
    const s = session('a9/n1')
      .prompt('go')
      .assistant({ usage: { cacheWrite: 10_000 } });
    expect(await run(subagentCost, [s])).toEqual([]);
  });

  it('negative: an Agent tool_use without a transcript is not a subagent', async () => {
    const s = session('a9/n2')
      .prompt('go')
      .assistant({ usage: { cacheWrite: 10_000 }, blocks: [toolUse('Agent', { prompt: 'p' })] })
      .toolResult(20);
    expect(await run(subagentCost, [s])).toEqual([]);
  });

  it('review: inline sidechain turns become pseudo-subagents, without double counting', async () => {
    const p = session('a9/r1')
      .prompt('go')
      .assistant({ usage: { cacheWrite: 10_000 } })
      .assistant({ sidechain: true, envelope: { agentId: 'inl' }, usage: { cacheWrite: 3_000 } })
      .assistant({ sidechain: true, envelope: { agentId: 'inl' }, usage: { cacheWrite: 1_000 } })
      // Same message as the transcript's turn below (another requestId): counted once.
      .assistant({
        sidechain: true,
        envelope: { agentId: 'file' },
        msgId: 'msg_dup0001',
        usage: { cacheWrite: 500 },
      });
    const a = p
      .agent('file')
      .prompt('x')
      .assistant({ msgId: 'msg_dup0001', usage: { cacheWrite: 500 } });
    const [f, ...rest] = await run(subagentCost, [p, a]);
    expect(rest).toEqual([]);
    // parent main chain 10,000; transcript `file` 500; inline `inl` 3,000 + 1,000.
    expect(f!.data).toMatchObject({ subagents: 2, subagentTokens: 4_500, parentTokens: 10_000 });
    expect(f!.data?.agents).toEqual([
      expect.objectContaining({ agentId: 'inl', tokens: 4_000, turns: 2, inline: true }),
      expect.objectContaining({ agentId: 'file', tokens: 500, turns: 1 }),
    ]);
  });
});
