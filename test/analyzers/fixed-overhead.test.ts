// A4 fixed-overhead. Expected numbers are computed by hand from the usage written below.
import { afterAll, describe, expect, it } from 'vitest';
import { session, type UsageSpec } from '../../scripts/make-fixture.js';
import { fixedOverhead } from '../../src/analyzers/fixed-overhead.js';
import { compareVersions } from '../../src/analyzers/rules.js';
import { loadSessions } from '../../src/parser/index.js';
import { cleanup, ctx, run, text, toolDef, tree } from '../helpers/analyze.js';

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
      cold('p1c', '2.1.98', { cacheWrite: 19_000 }), // 19,000
      cold('p1d', '2.1.100', { input: 2, cacheWrite: 41_000 }), // 41,002
      cold('p1e', '2.1.100', { cacheWrite: 40_000 }),
      cold('p1f', '2.1.100', { cacheWrite: 42_000 }),
    ]);
    const info = fs.find((f) => f.severity === 'info')!;
    // median of 6 = (21,005 + 40,000) / 2 = 30,502.5 → 30,503
    expect(info.tokens).toEqual({ value: 30_503, kind: 'measured' });
    expect(info.title).toContain('fixed overhead inferred [E], includes first prompt/attachments');
    expect(info.data?.inferred).toBe(true);
    expect(info.data?.versions).toEqual([
      { version: '2.1.98', median: 20_003, sessions: 3 },
      { version: '2.1.100', median: 41_002, sessions: 3 },
    ]);
    const [jump, ...rest] = jumps(fs);
    expect(rest).toEqual([]);
    expect(jump!.tokens).toEqual({ value: 20_999, kind: 'measured' });
    expect(jump!.data).toMatchObject({ fromVersion: '2.1.98', toVersion: '2.1.100' });
    expect(jump!.data?.knownIssue).toBe(true);
    expect(jump!.fix.summary).toContain('Your baseline grew 21k at 2.1.100');
    expect(jump!.fix.docsUrl).toBe('https://github.com/anthropics/claude-code/issues/46917');
    expect(jump!.evidence).toHaveLength(5);
  });

  it('positive: flags a jump between consecutive versions only, without the issue link', async () => {
    const fs = await run(
      fixedOverhead,
      [
        cold('p2a', '2.1.300', { cacheWrite: 20_000 }),
        cold('p2b', '2.1.301', { cacheWrite: 21_000 }), // +1,000: below 2,000
        cold('p2c', '2.1.302', { cacheWrite: 23_500 }), // +2,500
      ],
      { baselineMinSessions: 1 },
    );
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
    const fs = await run(
      fixedOverhead,
      [
        cold('n2a', '2.1.300', { cacheWrite: 30_000 }),
        cold('n2b', '2.1.301', { cacheWrite: 31_500 }), // +1,500
        cold('n2c', '2.1.302', { cacheWrite: 25_000 }), // −6,500
      ],
      { baselineMinSessions: 1 },
    );
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
    const th = { baselineJumpTokens: 1_000, baselineMinSessions: 1 };
    expect(jumps(await run(fixedOverhead, b, th))).toHaveLength(1);
  });

  it('review: needs baselineMinSessions per version before reporting a jump', async () => {
    const b = [
      cold('r1a', '2.1.300', { cacheWrite: 20_000 }),
      cold('r1b', '2.1.300', { cacheWrite: 20_000 }),
      cold('r1c', '2.1.302', { cacheWrite: 60_000 }),
      cold('r1d', '2.1.302', { cacheWrite: 60_000 }),
    ];
    expect(jumps(await run(fixedOverhead, b))).toEqual([]); // 2 sessions each < 3
    expect(jumps(await run(fixedOverhead, b, { baselineMinSessions: 2 }))).toHaveLength(1);
  });

  it('review: skips resumed/continued sessions and sessions cut by --since', async () => {
    const resumed = session('a4/r2a', { version: '2.1.302' })
      .prompt('continue', { parentUuid: 'aaaaaaaa-0000-4000-8000-000000000999' })
      .assistant({ usage: { cacheRead: 90_000, cacheWrite: 5_000 } });
    const cut = session('a4/r2b', { version: '2.1.302' })
      .prompt('hi')
      .assistant({ usage: { cacheWrite: 20_000 } })
      .gap('1h')
      .prompt('later')
      .assistant({ usage: { cacheRead: 20_000, cacheWrite: 70_000 } });
    const fresh = cold('r2c', '2.1.302', { cacheWrite: 21_000 });
    const root = tree([resumed, cut, fresh]);
    const all = (await loadSessions({ roots: [root] })).sessions;
    expect(all.find((s) => s.continued === true)).toBeDefined();
    const [f] = fixedOverhead.run(all, ctx());
    expect(f!.data).toMatchObject({ sessions: 2, medianBaseline: 20_500 }); // resumed skipped
    const since = new Date('2026-10-01T09:30:00.000Z');
    const windowed = (await loadSessions({ roots: [root], since })).sessions;
    // Only `cut` has a turn after 09:30, and its first kept turn is its second (index 1).
    expect(windowed.map((s) => s.turns[0]!.index)).toEqual([1]);
    expect(fixedOverhead.run(windowed, ctx())).toEqual([]);
  });

  it('review: tool definitions come from main sessions, not subagent snapshots', async () => {
    const p = session('a4/r3')
      .attachment({ type: 'prompt_snapshot', tools: [toolDef('Bash', 100)] })
      .prompt('go')
      .assistant({ usage: { cacheWrite: 10_000 } });
    const a = p
      .agent('s1')
      .gap('1m')
      .attachment({ type: 'prompt_snapshot', tools: [toolDef('Grep', 400)] })
      .prompt('x')
      .assistant({ usage: { cacheWrite: 1_000 } });
    const defs = (await run(fixedOverhead, [p, a])).find((f) => f.tokens.kind === 'estimated')!;
    expect(defs.data).toMatchObject({ tools: 1, defChars: 100 });
    expect(defs.evidence[0]!.sessionId).toBe(p.id);
  });
});

describe('compareVersions', () => {
  it('compares the numeric core, then sorts a prerelease before its release', () => {
    expect(compareVersions('2.1.99', '2.1.100')).toBe(-1);
    expect(compareVersions('2.1.100-beta.1', '2.1.100')).toBe(-1);
    expect(compareVersions('2.1.100', '2.1.100-rc.1')).toBe(1);
    expect(compareVersions('2.1.100-beta.2', '2.1.100-beta.10')).toBe(-1);
    expect(compareVersions('2.1.100-rc.1', '2.1.99')).toBe(1);
    expect(compareVersions('2.1', '2.1.0')).toBe(0);
    expect(['unknown', '2.1.9', '2.1.10-x', '2.1.10'].sort(compareVersions)).toEqual([
      '2.1.9',
      '2.1.10-x',
      '2.1.10',
      'unknown',
    ]);
  });
});
