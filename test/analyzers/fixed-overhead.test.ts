// A4 fixed-overhead. Expected numbers are computed by hand from the usage written below.
import { afterAll, describe, expect, it } from 'vitest';
import { session, type UsageSpec } from '../../scripts/make-fixture.js';
import { fixedOverhead } from '../../src/analyzers/fixed-overhead.js';
import { cleanup, run, text, toolDef } from '../helpers/analyze.js';

afterAll(cleanup);

/** A session whose first turn has `first` usage, plus a warm second turn that must be ignored. */
const cold = (name: string, version: string, first: UsageSpec) =>
  session(`a4/${name}`, { version })
    .prompt('hi')
    .assistant({ usage: first, blocks: [text('hello')] })
    .prompt('more')
    .assistant({ usage: { input: 1, cacheWrite: 900, cacheRead: 90_000, output: 5 } });

const jumps = (fs: Awaited<ReturnType<typeof run>>) => fs.filter((f) => f.severity === 'warn');

describe('A4 fixed-overhead', () => {
  it('positive: flags a jump across 2.1.100 and links #46917 (numeric version order)', async () => {
    const fs = await run(fixedOverhead, [
      cold('p1a', '2.1.98', { input: 3, cacheWrite: 20_000 }), // 20,003
      cold('p1b', '2.1.98', { input: 5, cacheWrite: 21_000 }), // 21,005
      cold('p1c', '2.1.100', { input: 2, cacheWrite: 41_000 }), // 41,002
    ]);
    const info = fs.find((f) => f.severity === 'info')!;
    expect(info.tokens).toEqual({ value: 21_005, kind: 'measured' }); // median of 3
    expect(info.data?.versions).toEqual([
      { version: '2.1.98', median: 20_504, sessions: 2 }, // (20,003 + 21,005) / 2
      { version: '2.1.100', median: 41_002, sessions: 1 },
    ]);
    const [jump, ...rest] = jumps(fs);
    expect(rest).toEqual([]);
    expect(jump!.tokens).toEqual({ value: 20_498, kind: 'measured' });
    expect(jump!.data).toMatchObject({ fromVersion: '2.1.98', toVersion: '2.1.100' });
    expect(jump!.data?.knownIssue).toBe(true);
    expect(jump!.fix.summary).toContain('Your baseline grew 20k at 2.1.100');
    expect(jump!.fix.docsUrl).toBe('https://github.com/anthropics/claude-code/issues/46917');
    expect(jump!.evidence).toHaveLength(3);
  });

  it('positive: flags a jump between consecutive versions only, without the issue link', async () => {
    const fs = await run(fixedOverhead, [
      cold('p2a', '2.1.300', { cacheWrite: 20_000 }),
      cold('p2b', '2.1.301', { cacheWrite: 21_000 }), // +1,000: below 2,000
      cold('p2c', '2.1.302', { cacheWrite: 23_500 }), // +2,500
    ]);
    const [jump, ...rest] = jumps(fs);
    expect(rest).toEqual([]);
    expect(jump!.tokens.value).toBe(2_500);
    expect(jump!.data).toMatchObject({ fromVersion: '2.1.301', toVersion: '2.1.302' });
    expect(jump!.data?.knownIssue).toBe(false);
    expect(jump!.fix.docsUrl).toBeUndefined();
  });

  it('positive: skips a synthetic first turn and sizes tool definitions from prompt_snapshot', async () => {
    const s = session('a4/p3', { version: '2.1.302' })
      .attachment({
        type: 'prompt_snapshot',
        systemPrompt: ['x'.repeat(50)],
        tools: [
          toolDef('Bash', 200),
          toolDef('Read', 100),
          toolDef('mcp__github__create_issue', 700),
          toolDef('mcp__github__list_prs', 400),
        ],
      })
      .prompt('hi')
      .assistant({ model: '<synthetic>', envelope: { isApiErrorMessage: true } })
      .prompt('hi again')
      .assistant({ usage: { input: 4, cacheWrite: 15_000 } });
    const fs = await run(fixedOverhead, [s]);
    expect(fs).toHaveLength(2);
    expect(fs[0]!.tokens).toEqual({ value: 15_004, kind: 'measured' });
    const defs = fs[1]!;
    expect(defs.tokens).toEqual({ value: 350, kind: 'estimated' }); // 1,400 chars / 4
    expect(defs.data).toMatchObject({
      tools: 4,
      defChars: 1_400,
      mcpTools: 2,
      mcpChars: 1_100,
      builtinTools: 2,
      builtinChars: 300,
      systemPromptChars: 50,
    });
    expect(defs.data?.topTools).toEqual([
      { name: 'mcp__github__create_issue', chars: 700 },
      { name: 'mcp__github__list_prs', chars: 400 },
      { name: 'Bash', chars: 200 },
      { name: 'Read', chars: 100 },
    ]);
    expect(defs.title).toContain('MCP 2 tools, 79% of chars');
  });

  it('negative: different baselines on one version are not a jump', async () => {
    const fs = await run(fixedOverhead, [
      cold('n1a', '2.1.302', { cacheWrite: 20_000 }),
      cold('n1b', '2.1.302', { cacheWrite: 30_000 }),
    ]);
    expect(jumps(fs)).toEqual([]);
    expect(fs[0]!.tokens.value).toBe(25_000);
  });

  it('negative: small increases and decreases are not flagged', async () => {
    const fs = await run(fixedOverhead, [
      cold('n2a', '2.1.300', { cacheWrite: 30_000 }),
      cold('n2b', '2.1.301', { cacheWrite: 31_500 }), // +1,500
      cold('n2c', '2.1.302', { cacheWrite: 25_000 }), // −6,500
    ]);
    expect(jumps(fs)).toEqual([]);
  });

  it('negative: subagent transcripts are not baselines', async () => {
    const p = cold('n3', '2.1.300', { cacheWrite: 20_000 });
    const a = p.agent('x').version('2.1.302').prompt('go');
    a.assistant({ usage: { cacheWrite: 90_000 } });
    const fs = await run(fixedOverhead, [p, a]);
    expect(jumps(fs)).toEqual([]);
    expect(fs[0]!.data).toMatchObject({ sessions: 1, medianBaseline: 20_000 });
  });

  it('respects --threshold.baselineJumpTokens', async () => {
    const b = [
      cold('t1a', '2.1.300', { cacheWrite: 30_000 }),
      cold('t1b', '2.1.301', { cacheWrite: 31_500 }),
    ];
    expect(jumps(await run(fixedOverhead, b, { baselineJumpTokens: 1_000 }))).toHaveLength(1);
  });
});
