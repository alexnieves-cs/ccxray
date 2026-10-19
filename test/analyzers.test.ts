// Analyzer tests (SPEC §6 M2): each analyzer has ≥ 3 positive and ≥ 2 negative fixtures. Every
// expected number is worked out by hand from the fixture definitions (scripts/make-fixture.ts
// for the committed ones, the builders below for the rest), not read back from analyzer code.
import { afterAll, describe, expect, it } from 'vitest';
import {
  session,
  text,
  toolUse,
  type SessionBuilder,
  type UsageSpec,
} from '../scripts/make-fixture.js';
import { bigToolOutput, normalizeCommand } from '../src/analyzers/big-tool-output.js';
import { cacheRebuild } from '../src/analyzers/cache-rebuild.js';
import { ANALYZERS } from '../src/analyzers/index.js';
import { repeatedRead } from '../src/analyzers/repeated-read.js';
import { computeTotals } from '../src/analyzers/totals.js';
import { displayPath, shortSession } from '../src/analyzers/util.js';
import type { Finding, Session } from '../src/model/index.js';
import { emptyStats } from '../src/parser/index.js';
import { buildReport } from '../src/pipeline.js';
import { calibrate, calibrationSamples } from '../src/tokens/calibrate.js';
import { built, cleanupTmp, ctx, fixture } from './helpers/analyzer-fixtures.js';
import { observedCompaction } from './helpers/analyze.js';

afterAll(cleanupTmp);

const tt = (
  input: number,
  cacheWrite: number,
  cacheRead: number,
  output: number,
  turns: number,
) => ({
  input,
  cacheWrite,
  cacheWrite5m: 0,
  cacheWrite1h: 0,
  cacheRead,
  output,
  turns,
  cacheHitRatio:
    input + cacheWrite + cacheRead === 0 ? null : cacheRead / (input + cacheWrite + cacheRead),
});

const s = (name: string, o: Parameters<typeof session>[1] = {}): SessionBuilder =>
  session(`m2/${name}`, o);
/** prompt + one assistant turn with `u`, after an optional gap. */
const turn = (b: SessionBuilder, u: UsageSpec, gap?: string): SessionBuilder =>
  (gap ? b.gap(gap) : b).prompt('next').assistant({ usage: u, blocks: [text('ok')] });
const warm: UsageSpec[] = [
  { input: 3, cacheWrite: 20000, output: 10 },
  { input: 2, cacheWrite: 500, cacheRead: 20000, output: 10 },
];
const rebuild: UsageSpec = { input: 3, cacheWrite: 21000, cacheRead: 0, output: 10 };

const run = (a: typeof cacheRebuild, sessions: Session[], over = {}): Finding[] =>
  a.run(sessions, ctx(over));

describe('A1 totals', () => {
  it('cross-session-copy: a copied response counts once', async () => {
    const t = computeTotals(await fixture('cross-session-copy'));
    expect(t.all).toEqual(tt(16, 5400, 10300, 180, 3));
    expect(t.bySession).toEqual({
      'aaaaaaaa-0000-4000-8000-000000000001': tt(14, 5300, 5000, 150, 2),
      'bbbbbbbb-0000-4000-8000-000000000002': tt(2, 100, 5300, 30, 1),
    });
    expect(t.byProject).toEqual({ '-home-dev-cross-session-copy': tt(16, 5400, 10300, 180, 3) });
    expect(t.byDay).toEqual({ '2026-10-01': tt(16, 5400, 10300, 180, 3) });
  });

  it('nested-subagents-dir: subagent sessions are included in all', async () => {
    const t = computeTotals(await fixture('nested-subagents-dir'));
    // parent (5,9000,0,70)+(4,200,9000,30); n1 (3,4000,0,20)+(2,300,4000,15); n2 (3,4100,0,12)
    expect(t.all).toEqual(tt(17, 17600, 13000, 147, 5));
    expect(Object.keys(t.bySession).sort()).toEqual([
      '0d25164f-0000-4000-8000-000000000000',
      '0d25164f-0000-4000-8000-000000000000:agent-n1',
      '0d25164f-0000-4000-8000-000000000000:agent-n2',
    ]);
  });

  it('model-switch: byModel splits the turns', async () => {
    const t = computeTotals(await fixture('model-switch'));
    expect(t.byModel).toEqual({
      'claude-sonnet-4-5': tt(5, 18300, 18000, 55, 2),
      'claude-opus-4-1': tt(3, 18400, 0, 60, 1),
    });
  });

  it('minimal-single-turn: the 5m/1h split is summed', async () => {
    const t = computeTotals(await fixture('minimal-single-turn'));
    expect(t.all).toEqual({ ...tt(3, 20000, 0, 12, 1), cacheWrite5m: 20000 });
  });

  it('byDay uses UTC days, and odd model names stay plain keys', async () => {
    const b = s('midnight', { start: '2026-10-01T23:59:58.000Z' });
    b.prompt('a').assistant({ usage: { input: 1, output: 1 }, model: '__proto__' });
    b.prompt('b').assistant({ usage: { input: 2, output: 2 } });
    const t = computeTotals(await built('midnight', [b]));
    expect(t.byDay).toEqual({ '2026-10-01': tt(1, 0, 0, 1, 1), '2026-10-02': tt(2, 0, 0, 2, 1) });
    expect(Object.keys(t.byModel)).toEqual(['__proto__', 'claude-sonnet-4-5']);
  });

  it('synthetic-error-turn: synthetic turns are excluded', async () => {
    const t = computeTotals(await fixture('synthetic-error-turn'));
    expect(t.all).toEqual(tt(3, 19000, 0, 9, 1));
    expect(t.byModel['<synthetic>']).toBeUndefined();
  });

  it('no sessions: zeros and a null hit ratio', () => {
    expect(computeTotals([])).toEqual({
      all: tt(0, 0, 0, 0, 0),
      bySession: {},
      byProject: {},
      byModel: {},
      byDay: {},
    });
  });
});

describe('A2/A3 cache-rebuild', () => {
  const causes = (f: Finding[]) => (f[0]?.data?.causes ?? []) as { cause: string; count: number }[];

  it('ttl-gap-rebuild: ttl-expiry, with the 5–15 min gap count', async () => {
    const f = run(cacheRebuild, await fixture('ttl-gap-rebuild'));
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({
      analyzer: 'cache-rebuild',
      severity: 'warn',
      title: '1 rebuild cost 21k cache-write tokens',
      tokens: { value: 20600, kind: 'measured' },
      data: {
        causes: [
          {
            cause: 'ttl-expiry',
            count: 1,
            tokens: 20600,
            tokensKind: 'estimated',
            fix: 'batch prompts; you had 1 gap of 5–15 min (5m TTL)',
          },
        ],
        rebuilds: 1,
        sessions: 1,
      },
    });
    expect(f[0]!.evidence).toHaveLength(1);
    expect(f[0]!.evidence[0]!.detail).toBe(
      'ttl-expiry: idle 6m 2s > 5m cache TTL; cache_read 20k → 0, cache_write 20,600',
    );
    expect(f[0]!.fix.docsUrl).toBeUndefined();
  });

  it('version-change-rebuild: cc-upgrade links the known issue', async () => {
    const f = run(cacheRebuild, await fixture('version-change-rebuild'));
    expect(causes(f)).toEqual([
      {
        cause: 'cc-upgrade',
        count: 1,
        tokens: 21000,
        tokensKind: 'estimated',
        fix: 'restart after upgrading; known issue: anthropics/claude-code#46917',
      },
    ]);
    expect(f[0]!.evidence[0]!.detail).toContain('Claude Code 2.1.300 → 2.1.302');
    expect(f[0]!.fix.docsUrl).toBe('https://github.com/anthropics/claude-code/issues/46917');
  });

  it('model-switch: model-switch', async () => {
    const f = run(cacheRebuild, await fixture('model-switch'));
    expect(causes(f)).toEqual([
      {
        cause: 'model-switch',
        count: 1,
        tokens: 18400,
        tokensKind: 'estimated',
        fix: '/model mid-session invalidates the cache',
      },
    ]);
    expect(f[0]!.evidence[0]!.detail).toContain('model claude-sonnet-4-5 → claude-opus-4-1');
  });

  it('compaction, config-edit, tool-set-change and unknown', async () => {
    const md = (content: string) => ({
      type: 'instructions',
      files: [{ path: '/home/dev/app/CLAUDE.md', type: 'Project', content }],
    });
    const snap = (...names: string[]) => ({
      type: 'prompt_snapshot',
      tools: names.map((name) => ({ name })),
    });
    const compaction = turn(turn(s('compaction'), warm[0]!), warm[1]!).record('system', {
      subtype: 'compact_boundary',
    });
    const config = turn(turn(s('config').attachment(md('v1')), warm[0]!), warm[1]!).attachment(
      md('v2'),
    );
    const nested = turn(turn(s('nested').attachment(md('v1')), warm[0]!), warm[1]!).attachment({
      type: 'instructions',
      files: [{ path: '/home/dev/app/src/CLAUDE.md', type: 'Project', content: 'new' }],
    });
    const tools = turn(
      turn(s('tools').attachment(snap('Bash', 'Read')), warm[0]!),
      warm[1]!,
    ).attachment(snap('Bash', 'Read', 'mcp__gh__issue'));
    const firstUse = turn(turn(s('first-use'), warm[0]!), warm[1]!)
      .prompt('file it')
      .assistant({ usage: rebuild, blocks: [toolUse('mcp__gh__issue', {})] });
    for (const b of [compaction, config, nested, tools]) turn(b, rebuild);
    const sessions = await built('causes', [compaction, config, nested, tools, firstUse]);
    const f = run(cacheRebuild, sessions);
    expect(f[0]!.title).toBe('5 rebuilds cost 105k cache-write tokens');
    expect(causes(f).map((c) => [c.cause, c.count])).toEqual([
      ['compaction', 1],
      ['config-edit', 1],
      ['tool-set-change', 2],
      ['unknown', 1],
    ]);
    const details = f[0]!.evidence.map((e) => e.detail.split(';')[0]).sort();
    expect(details).toEqual([
      'compaction: compaction (system:compact_boundary) before this turn',
      'config-edit: instructions file changed: CLAUDE.md',
      'tool-set-change: first use of tool mcp__gh__issue [E]',
      'tool-set-change: tool definitions changed (+1 / -0)',
      'unknown: gap 3s, no known cause',
    ]);
  });

  it('cause order: ttl-expiry wins over a version change; 1h TTL raises the bar', async () => {
    const both = turn(turn(s('both'), warm[0]!), warm[1]!).version('2.1.303');
    turn(both, rebuild, '10m');
    const hour = (gap: string) =>
      turn(
        turn(s(`hour-${gap}`), {
          input: 3,
          cacheWrite: 20000,
          cacheWrite5m: 0,
          cacheWrite1h: 20000,
        }),
        warm[1]!,
      );
    const f = run(
      cacheRebuild,
      await built('order', [
        both,
        turn(hour('10m'), rebuild, '10m'),
        turn(hour('61m'), rebuild, '61m'),
      ]),
    );
    expect(f[0]!.data!.causes).toEqual([
      {
        cause: 'ttl-expiry',
        count: 2,
        tokens: 42000,
        tokensKind: 'estimated',
        fix: 'batch prompts; you had 1 gap of 5–15 min (5m TTL), 1 break over 1h (1h TTL)',
      },
      {
        cause: 'unknown',
        count: 1,
        tokens: 21000,
        tokensKind: 'estimated',
        fix: 'no known cause; check the evidence turns by hand',
      },
    ]);
    expect(f[0]!.evidence.map((e) => e.detail.split(';')[0]).sort()).toEqual([
      'ttl-expiry: idle 10m 2s > 5m cache TTL',
      'ttl-expiry: idle 1h 1m > 1h cache TTL',
      'unknown: gap 10m 2s, no known cause',
    ]);
  });

  it('caps evidence at 50 and keeps the counts exact', async () => {
    const b = turn(turn(s('many'), warm[0]!), warm[1]!);
    for (let i = 0; i < 55; i++)
      turn(turn(b, rebuild, '6m'), { input: 1, cacheWrite: 10, cacheRead: 21000 });
    const f = run(cacheRebuild, await built('many', [b]));
    expect(f[0]).toMatchObject({
      severity: 'high',
      title: '55 rebuilds cost 1.2M cache-write tokens',
      tokens: { value: 55 * 21000 },
      data: { rebuilds: 55, evidenceShown: 50 },
    });
    expect(f[0]!.evidence).toHaveLength(50);
  });

  it('negatives: no rebuild in small or single-turn sessions', async () => {
    expect(
      run(cacheRebuild, await fixture('multi-block-same-msgid', 'minimal-single-turn')),
    ).toEqual([]);
  });

  it('negatives: growth without a read drop, a small write, sidechains, cold turn 1', async () => {
    const growth = turn(turn(turn(s('growth'), warm[0]!), warm[1]!), {
      input: 2,
      cacheWrite: 15000,
      cacheRead: 20000,
    });
    const small = turn(
      turn(turn(s('small'), warm[0]!), warm[1]!),
      { input: 2, cacheWrite: 9999 },
      '6m',
    );
    // Rule needs cacheRead(n-1) > 0: turn 2 after a cold turn 1 is not checked.
    const cold = turn(turn(s('cold'), warm[0]!), rebuild, '6m');
    const parent = s('parent').prompt('go').assistant({ usage: warm[0]! });
    const sub = parent.agent('x1');
    turn(turn(turn(sub, warm[0]!), warm[1]!), rebuild, '6m');
    expect(run(cacheRebuild, await built('neg', [growth, small, cold, parent, sub]))).toEqual([]);
  });

  it('regression: the first turn after a compaction is not a rebuild', async () => {
    // Shape seen in CC 2.1.302 (FORMAT.md Q5, synthetic numbers of the same size): cache_read
    // drops from ~374k to ~80k and ~54k is written for the new summary prefix. The write is far
    // under 0.5 × the previous context, so A2 does not count it.
    const b = turn(turn(s('post-compaction'), warm[0]!), {
      input: 2,
      cacheWrite: 617,
      cacheRead: 374_036,
      output: 10,
    });
    observedCompaction(b).assistant({
      usage: { input: 2, cacheWrite: 54_227, cacheRead: 79_590, output: 10 },
      blocks: [text('ok')],
    });
    const sessions = await built('post-compaction', [b]);
    expect(sessions[0]!.events.filter((e) => e.kind === 'compaction')).toHaveLength(2);
    expect(run(cacheRebuild, sessions)).toEqual([]);
  });

  it('negative: thresholds are honored', async () => {
    expect(
      run(cacheRebuild, await fixture('ttl-gap-rebuild'), { rebuildMinCacheWrite: 30000 }),
    ).toEqual([]);
    expect(
      run(cacheRebuild, await fixture('ttl-gap-rebuild'), { ttl5mMs: 10 * 60_000 })[0]!.data!
        .causes,
    ).toMatchObject([{ cause: 'unknown' }]);
  });
});

describe('A5 big-tool-output', () => {
  it('normalizes Bash commands to two words', () => {
    expect(normalizeCommand('pnpm test --reporter verbose')).toBe('pnpm test');
    expect(normalizeCommand('CI=1 FOO=bar pnpm test')).toBe('pnpm test');
    expect(normalizeCommand('env CI=1 pnpm  test')).toBe('pnpm test');
    expect(normalizeCommand('cd /home/dev/app && pnpm test')).toBe('pnpm test');
    expect(normalizeCommand('ls')).toBe('ls');
  });

  it('big-bash-output: one finding per command', async () => {
    const f = run(bigToolOutput, await fixture('big-bash-output'));
    expect(f.map((x) => [x.title, x.tokens, x.data])).toEqual([
      [
        '`pnpm test` returned up to 48k chars inline (1 big output)',
        { value: 12000, kind: 'estimated' },
        {
          tool: 'Bash',
          command: 'pnpm test',
          count: 1,
          maxChars: 48000,
          totalChars: 48000,
          sessions: 1,
          persisted: 0,
          persistedBytes: 0,
          errors: 0,
          persistedByClaudeCode: 0,
        },
      ],
      [
        '`pnpm build` returned up to 32k chars inline (1 big output)',
        { value: 8000, kind: 'estimated' },
        {
          tool: 'Bash',
          command: 'pnpm build',
          count: 1,
          maxChars: 32000,
          totalChars: 32000,
          sessions: 1,
          persisted: 0,
          persistedBytes: 0,
          errors: 1,
          persistedByClaudeCode: 0,
        },
      ],
    ]);
    expect(f[0]!.fix.summary).toBe(
      'pipe through `| tail -n 100`, or use --silent / --reporter=dot',
    );
    expect(f[1]!.evidence[0]!.detail).toBe(
      'Bash result 32,000 chars inline (~8k tokens [E]), is_error',
    );
  });

  it('persisted-tool-output: a persisted output under the inline threshold is no finding', async () => {
    // Inline preview = 19 (tag + \n) + 49 ("Output too large (36.4KB). Full output saved to: ")
    // + 132 (saved path) + 23 ("\n\nPreview (first 2KB):\n") + 2,048 + 20 ("\n</persisted-output>")
    // = 2,291 chars → ceil(2,291 / 4) = 573 tokens [E]: Claude Code already handled it.
    expect(run(bigToolOutput, await fixture('persisted-tool-output'))).toEqual([]);
  });

  it('persisted outputs under the threshold only add to persistedByClaudeCode of a big group', async () => {
    const preview = (kb: string) => ({
      content: `<persisted-output>\nOutput too large (${kb}KB). Full output saved to: /x\n</persisted-output>`,
    });
    const a = s('persisted-mix')
      .prompt('x')
      .assistant({
        usage: { input: 1 },
        blocks: [toolUse('Bash', { command: 'sed -n 1,900p a.ts' })],
      })
      .toolResult(preview('40.0'))
      .assistant({
        usage: { input: 1 },
        blocks: [toolUse('Bash', { command: 'sed -n 1,400p b.ts' })],
      })
      .toolResult(24_000);
    const [f, ...rest] = run(bigToolOutput, await built('persisted-mix', [a]));
    expect(rest).toEqual([]);
    expect(f!.title).toBe('`sed -n` returned up to 24k chars inline (1 big output)');
    expect(f!.tokens.value).toBe(6_000);
    expect(f!.data).toMatchObject({ count: 1, persisted: 0, persistedByClaudeCode: 1 });
    expect(f!.evidence).toHaveLength(1);
  });

  it('fix advice depends on the command family', async () => {
    const cmds: [string, string][] = [
      ['cat src/a.ts', 'use Read with offset/limit, or grep -n for the part you need'],
      ['cat -n src/a.ts', 'use Read with offset/limit, or grep -n for the part you need'],
      ['head -n 5000 log.txt', 'use Read with offset/limit, or grep -n for the part you need'],
      ['grep -rn foo .', 'add -l, -m N or a narrower path/glob'],
      ['rg foo', 'add -l, -m N or a narrower path/glob'],
      ['git show HEAD', 'run with --stat first, then show a single path'],
      ['git diff main', 'run with --stat first, then show a single path'],
      ['git log -p', 'limit it with -n N --oneline'],
      ['pnpm test', 'pipe through `| tail -n 100`, or use --silent / --reporter=dot'],
      ['npm run build', 'pipe through `| tail -n 100`, or use --silent / --reporter=dot'],
      ['npx vitest run', 'pipe through `| tail -n 100`, or use --silent / --reporter=dot'],
      ['cargo test', 'pipe through `| tail -n 100`, or use --silent / --reporter=dot'],
      ['go test ./...', 'pipe through `| tail -n 100`, or use --silent / --reporter=dot'],
      ['make all', 'pipe through `| tail -n 100`, or use --silent / --reporter=dot'],
      ['tsc --noEmit', 'pipe through `| tail -n 100`, or use --silent / --reporter=dot'],
      [
        'for f in *.ts; do cat "$f"; done',
        'limit the output (| head, | tail, or a narrower command)',
      ],
      ['find . -type f', 'limit the output (| head, | tail, or a narrower command)'],
    ];
    const b = s('advice').prompt('x');
    for (const [command] of cmds)
      b.assistant({ usage: { input: 1 }, blocks: [toolUse('Bash', { command })] }).toolResult(
        20_000,
      );
    const f = run(bigToolOutput, await built('advice', [b]));
    const byCommand = new Map(f.map((x) => [x.data!.command, x.fix.summary]));
    for (const [command, advice] of cmds)
      expect([command, byCommand.get(normalizeCommand(command))]).toEqual([command, advice]);
  });

  it('names shell loops by the first meaningful command of the body', () => {
    expect(normalizeCommand('for f in src/*.ts; do cat "$f"; done')).toBe('cat (in a loop)');
    expect(normalizeCommand('for f in a b; do echo "== $f"; sed -n 1,50p "$f"; done')).toBe(
      'sed -n (in a loop)',
    );
    expect(normalizeCommand('cd /home/dev/app && while read f; do head -5 "$f"; done < l')).toBe(
      'head -5 (in a loop)',
    );
    expect(normalizeCommand('for f in a b c')).toBe('for f');
    expect(normalizeCommand('for f in a; do echo "$f"; done')).toBe('for f');
  });

  it('groups env-prefixed and cd-prefixed commands, and other tools across sessions', async () => {
    const a = s('bash')
      .prompt('x')
      .assistant({
        usage: { input: 1 },
        blocks: [toolUse('Bash', { command: 'CI=1 pnpm test --run' })],
      })
      .toolResult(20000)
      .assistant({
        usage: { input: 1 },
        blocks: [toolUse('Bash', { command: 'cd /home/dev/app && pnpm test' })],
      })
      .toolResult(24000)
      .assistant({ usage: { input: 1 }, blocks: [toolUse('Grep', { pattern: 'x' })] })
      .toolResult(30000);
    const sub = a
      .agent('g1')
      .prompt('y')
      .assistant({ usage: { input: 1 }, blocks: [toolUse('Grep', { pattern: 'y' })] });
    sub.toolResult(22000);
    const f = run(bigToolOutput, await built('groups', [a, sub])).sort((x, y) =>
      x.title < y.title ? -1 : 1,
    );
    expect(f.map((x) => [x.title, x.tokens.value, x.data!.sessions, x.fix.summary])).toEqual([
      [
        'Grep returned up to 30k chars inline (2 big outputs)',
        13000,
        2,
        'narrow the glob or path, or set head_limit',
      ],
      [
        '`pnpm test` returned up to 24k chars inline (2 big outputs)',
        11000,
        1,
        'pipe through `| tail -n 100`, or use --silent / --reporter=dot',
      ],
    ]);
    expect(f[0]!.data!.command).toBeUndefined();
  });

  it('threshold boundary: 5,000 estimated tokens qualifies, 4,999 does not', async () => {
    const b = (chars: number) =>
      s(`edge${chars}`)
        .prompt('x')
        .assistant({
          usage: { input: 1 },
          blocks: [toolUse('Read', { file_path: '/home/dev/app/a' })],
        })
        .toolResult(chars);
    expect(run(bigToolOutput, await built('edge-no', [b(19996)]))).toEqual([]);
    expect(run(bigToolOutput, await built('edge-yes', [b(20000)]))[0]!.tokens.value).toBe(5000);
  });

  it('negatives: small results, and a small persisted output', async () => {
    expect(
      run(bigToolOutput, await fixture('multi-block-same-msgid', 'repeated-read-unchanged')),
    ).toEqual([]);
    const small = s('small-persisted')
      .prompt('x')
      .assistant({ usage: { input: 1 }, blocks: [toolUse('Bash', { command: 'ls -R' })] })
      .toolResult({
        content:
          '<persisted-output>\nOutput too large (10.0KB). Full output saved to: /x\n</persisted-output>',
      });
    expect(run(bigToolOutput, await built('small-persisted', [small]))).toEqual([]);
  });
});

describe('A6 repeated-read', () => {
  const read = (file_path: string, extra: Record<string, unknown> = {}) =>
    toolUse('Read', { file_path, ...extra });
  const call = (
    b: SessionBuilder,
    block: ReturnType<typeof toolUse>,
    chars = 4000,
  ): SessionBuilder => b.assistant({ usage: { input: 1 }, blocks: [block] }).toolResult(chars);
  const F = '/home/dev/app/src/a.ts';

  it('repeated-read-unchanged: two repeats of three reads', async () => {
    const f = run(repeatedRead, await fixture('repeated-read-unchanged'));
    expect(f).toEqual([
      {
        analyzer: 'repeated-read',
        severity: 'info',
        title: 'src/api/client.ts re-read 2× unchanged in session bba11d92',
        tokens: { value: 2000, kind: 'estimated' },
        data: { tool: 'Read', path: 'src/api/client.ts', rereads: 2 },
        evidence: [
          expect.objectContaining({
            detail: 'read #2 of src/api/client.ts, unchanged since read #1',
          }),
          expect.objectContaining({
            detail: 'read #3 of src/api/client.ts, unchanged since read #1',
          }),
        ],
        fix: { summary: 'reference the earlier read (cc-slim read-dedupe hook planned)' },
      },
    ]);
  });

  it('same range counts, a different range does not; unrelated Bash does not reset', async () => {
    const b = s('ranges').prompt('x');
    call(b, read(F, { offset: 10, limit: 50 }), 800);
    call(b, read(F, { offset: 60, limit: 50 }), 800);
    call(b, toolUse('Bash', { command: 'grep -n foo src/b.ts' }), 100);
    call(b, read(F, { offset: 10, limit: 50 }), 800);
    const f = run(repeatedRead, await built('ranges', [b]));
    expect(f.map((x) => [x.title, x.tokens.value])).toEqual([
      ['src/a.ts re-read 1× unchanged in session ' + shortSession(b.id), 200],
    ]);
  });

  it('subagent sessions count separately; paths outside the cwd use ~', async () => {
    const p = s('outside').prompt('x');
    call(p, read('/home/dev/notes/todo.md'), 400);
    const sub = p.agent('r2').prompt('y');
    call(sub, read('/home/dev/notes/todo.md'), 400);
    call(sub, read('/home/dev/notes/todo.md'), 400);
    const f = run(repeatedRead, await built('outside', [p, sub]));
    expect(f).toHaveLength(1);
    expect(f[0]!.title).toBe('~/notes/todo.md re-read 1× unchanged in subagent r2');
    expect(f[0]!.evidence[0]!.sessionId).toBe(`${p.id}:agent-r2`);
  });

  it('repeated-read-after-edit: an Edit in between is a change', async () => {
    expect(run(repeatedRead, await fixture('repeated-read-after-edit'))).toEqual([]);
  });

  it('negatives: Write, a Bash naming the file, a compaction, an errored read', async () => {
    const write = s('write').prompt('x');
    call(write, read(F));
    call(write, toolUse('Write', { file_path: F, content: 'x' }), 10);
    call(write, read(F));
    const bash = s('bash-basename').prompt('x');
    call(bash, read(F));
    call(bash, toolUse('Bash', { command: "sed -i 's/a/b/' a.ts" }), 0);
    call(bash, read(F));
    const comp = s('compacted').prompt('x');
    call(comp, read(F));
    comp.record('system', { subtype: 'compact_boundary' });
    call(comp, read(F));
    const err = s('errored').prompt('x');
    err
      .assistant({ usage: { input: 1 }, blocks: [read(F)] })
      .toolResult({ chars: 30, isError: true });
    call(err, read(F));
    expect(run(repeatedRead, await built('neg-reads', [write, bash, comp, err]))).toEqual([]);
  });
});

describe('estimator calibration', () => {
  // Turn p makes one Bash call whose 4,000-char result is ~1,000 tokens [E]. Turn t's context
  // grows by p's output (50) plus `added`, so the ratio is 1000 / added.
  const pair = (b: SessionBuilder, added: number): SessionBuilder => {
    b.prompt('x').assistant({
      usage: { input: 2, cacheWrite: 1000, cacheRead: 9000, output: 50 },
      blocks: [toolUse('Bash', { command: 'pnpm test' })],
    });
    b.toolResult(4000);
    return b.assistant({
      usage: { input: 2, cacheWrite: 50 + added, cacheRead: 10000, output: 5 },
    });
  };

  it('median of estimate ÷ measured over single-tool_result turns', async () => {
    const sessions = await built('calib', [
      pair(s('c1'), 1000),
      pair(s('c2'), 800),
      pair(s('c3'), 1250),
    ]);
    expect(calibrationSamples(sessions).sort()).toEqual([0.8, 1, 1.25]);
    expect(calibrate(sessions)).toMatchObject({ samples: 3, medianRatio: 1 });
  });

  it('skips turns with a prompt in between, two tool calls, or a tiny result', async () => {
    const prompted = s('prompted');
    prompted.prompt('x').assistant({
      usage: { input: 2, cacheRead: 9000 },
      blocks: [toolUse('Bash', { command: 'ls' })],
    });
    prompted
      .toolResult(4000)
      .prompt('also')
      .assistant({ usage: { input: 2, cacheWrite: 1000, cacheRead: 9000 } });
    const two = s('two');
    two.prompt('x').assistant({
      usage: { input: 2, cacheRead: 9000 },
      blocks: [toolUse('Bash', { command: 'ls' }), toolUse('Bash', { command: 'pwd' })],
    });
    two
      .toolResult(4000)
      .toolResult(4000)
      .assistant({ usage: { input: 2, cacheWrite: 2000, cacheRead: 9000 } });
    const tiny = s('tiny');
    tiny.prompt('x').assistant({
      usage: { input: 2, cacheRead: 9000 },
      blocks: [toolUse('Bash', { command: 'ls' })],
    });
    tiny.toolResult(996).assistant({ usage: { input: 2, cacheWrite: 300, cacheRead: 9000 } });
    const sessions = await built('calib-neg', [prompted, two, tiny]);
    expect(calibrate(sessions)).toMatchObject({ samples: 0, medianRatio: null });
    expect(calibrate([]).note).toMatch(/^estimated:/);
  });
});

describe('pipeline', () => {
  it('buildReport runs every analyzer and sorts findings', async () => {
    const sessions = await fixture('ttl-gap-rebuild', 'big-bash-output', 'repeated-read-unchanged');
    const report = buildReport({
      sessions,
      stats: emptyStats(),
      ctx: ctx(),
      window: { since: '2026-09-01', until: null, project: null },
      includeContent: false,
    });
    expect(report.findings.map((f) => f.analyzer)).toEqual([
      'cache-rebuild',
      'fixed-overhead',
      'big-tool-output',
      'big-tool-output',
      'repeated-read',
      'tool-usage',
    ]);
    expect(report.sessions).toHaveLength(3);
    expect(report.sessions.every((x) => x.totals === report.totals.bySession[x.id])).toBe(true);
    expect(report.generatedAt).toBe('2026-10-18T00:00:00.000Z');
    expect(report.calibration).toMatchObject({ samples: expect.any(Number) });
    expect(ANALYZERS.map((a) => a.spec)).toEqual(['A2', 'A4', 'A5', 'A6', 'A7', 'A8', 'A9', 'A10']);
  });

  it('displayPath is relative to the cwd for both separators', () => {
    expect(displayPath('/home/dev/app/src/a.ts', '/home/dev/app')).toBe('src/a.ts');
    expect(displayPath('C:\\work\\app\\src\\a.ts', 'C:\\work\\app')).toBe('src\\a.ts');
    expect(displayPath('C:\\Users\\dev\\x.md', 'C:\\work\\app')).toBe('~\\x.md');
    expect(displayPath('/etc/hosts', '/home/dev/app')).toBe('/etc/hosts');
  });
});
