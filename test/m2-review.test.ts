// Regression tests for the PR #7 review findings (numbered as in the review). All synthetic.
import { afterAll, describe, expect, it } from 'vitest';
import { session, text, toolUse, type SessionBuilder } from '../scripts/make-fixture.js';
import { bigToolOutput, normalizeCommand } from '../src/analyzers/big-tool-output.js';
import { cacheRebuild } from '../src/analyzers/cache-rebuild.js';
import { repeatedRead } from '../src/analyzers/repeated-read.js';
import { parseDate } from '../src/commands/analyze.js';
import { analyze } from '../src/commands/analyze.js';
import { main } from '../src/main.js';
import {
  applyThresholdOverrides,
  DEFAULT_THRESHOLDS,
  type Session,
  type Turn,
} from '../src/model/index.js';
import { emptyStats } from '../src/parser/index.js';
import { buildReport } from '../src/pipeline.js';
import { render } from '../src/reporters/index.js';
import { built, cleanupTmp, ctx, fixture, FX, writeBuilt } from './helpers/analyzer-fixtures.js';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

afterAll(cleanupTmp);

async function cli(argv: string[]) {
  let out = '';
  let err = '';
  const code = await analyze(argv, (s) => (out += s), { err: (s) => (err += s), isTTY: false });
  return { code, out, err };
}
const call = (b: SessionBuilder, block: ReturnType<typeof toolUse>, chars = 4000) =>
  b.assistant({ usage: { input: 1 }, blocks: [block] }).toolResult(chars);
const read = (file_path: string, extra: Record<string, unknown> = {}) =>
  toolUse('Read', { file_path, ...extra });

const s = (name: string, o: Parameters<typeof session>[1] = {}): SessionBuilder =>
  session(`m2r/${name}`, o).prompt('x');

describe('1. A5 never leaks command arguments or home paths', () => {
  it('normalizeCommand masks = values, home dirs and cd prefixes', () => {
    expect(normalizeCommand('curl --password=hunter2 https://x')).toBe('curl …');
    expect(normalizeCommand('cat /home/alice/.secrets/token')).toBe('cat ~/.secrets/token');
    expect(normalizeCommand('cat /work/proj/src/a.ts', '/work/proj')).toBe('cat src/a.ts');
    expect(normalizeCommand('cd /work/proj; pnpm test')).toBe('pnpm test');
    expect(normalizeCommand('cd "/home/alice/my proj" && cd sub && pnpm test --run')).toBe(
      'pnpm test',
    );
    expect(normalizeCommand("cd '/x y';ls -la")).toBe('ls -la');
    expect(normalizeCommand('TOKEN=hunter2 ./deploy.sh')).toBe('./deploy.sh');
  });

  it('JSON, terminal and HTML hold neither the secret nor the user name', async () => {
    const b = session('m2/priv', { project: '-work-proj', cwd: '/work/proj' }).prompt('x');
    call(
      b,
      toolUse('Bash', { command: 'cd "/home/alice/my proj" && curl --password=hunter2 u' }),
      24000,
    );
    call(b, toolUse('Bash', { command: 'cd /work/proj; cat /home/alice/.secrets/key' }), 24000);
    const root = writeBuilt('priv', [b]);
    const html = join(tmpdir(), `ccxray-priv-${process.pid}.html`);
    const json = await cli(['--root', root, '--since', '2026-01-01', '--json', '--html', html]);
    const term = await cli(['--root', root, '--since', '2026-01-01', '--no-color']);
    const { readFileSync, rmSync } = await import('node:fs');
    const page = readFileSync(html, 'utf8');
    rmSync(html);
    expect(json.out).toContain('"command": "curl …"');
    expect(json.out).toContain('"command": "cat ~/.secrets/key"');
    for (const outText of [json.out, term.out, page]) {
      expect(outText).not.toContain('hunter2');
      expect(outText).not.toContain('alice');
    }
  });
});

describe('2. A6 sees subagent edits', () => {
  const F = '/home/dev/app/src/a.ts';
  it('an Agent/Task launch forgets earlier reads', async () => {
    const b = s('agent-launch');
    call(b, read(F));
    call(b, toolUse('Agent', { description: 'd', prompt: 'p' }), 10);
    call(b, read(F));
    call(b, toolUse('Task', { description: 'd', prompt: 'p' }), 10);
    call(b, read(F));
    expect(repeatedRead.run(await built('agent-launch', [b]), ctx())).toEqual([]);
  });

  it("a linked subagent's Edit between two parent reads is a change", async () => {
    const make = (edit: boolean) => {
      const p = s(`bg-${edit}`);
      call(p, toolUse('Agent', { description: 'bg', prompt: 'p' }), 10);
      call(p, read(F));
      const sub = p.agent('e1').prompt('p');
      if (edit) call(sub, toolUse('Edit', { file_path: F, old_string: 'a', new_string: 'b' }), 10);
      else call(sub, toolUse('Grep', { pattern: 'x' }), 10);
      p.sync(sub);
      call(p, read(F));
      return [p, sub];
    };
    expect(repeatedRead.run(await built('bg-edit', make(true)), ctx())).toEqual([]);
    expect(repeatedRead.run(await built('bg-none', make(false)), ctx())).toHaveLength(1);
  });
});

describe('3. A6 path and range normalization', () => {
  it('relative, ./ and absolute spellings are one path', async () => {
    const b = s('spell');
    call(b, read('src/a.ts'));
    call(b, read('/home/dev/app/src/./a.ts'));
    const f = repeatedRead.run(await built('spell', [b]), ctx());
    expect(f.map((x) => x.title)).toEqual([expect.stringMatching(/^src\/a\.ts re-read 1×/)]);
  });

  it('Windows separators and drive letters, in reads and in edits', async () => {
    const w = { cwd: 'C:\\work\\app', project: 'C--work-app' };
    const same = s('win', w);
    call(same, read('C:\\work\\app\\src\\a.ts'));
    call(same, read('c:/work/app/src/a.ts'));
    const edited = s('win-edit', w);
    call(edited, read('C:\\work\\app\\src\\a.ts'));
    call(edited, toolUse('Edit', { file_path: 'c:/work/app/src/a.ts' }), 10);
    call(edited, read('C:\\work\\app\\src\\a.ts'));
    const f = repeatedRead.run(await built('win', [same, edited]), ctx());
    expect(f.map((x) => x.data!.path)).toEqual(['src/a.ts']);
  });

  it('offset/limit are coerced; offset 0/1 and limit 0 mean omitted', async () => {
    const b = s('ranges');
    call(b, read('/home/dev/app/a', { offset: '10', limit: 50 }));
    call(b, read('/home/dev/app/a', { offset: 10, limit: '50' }));
    call(b, read('/home/dev/app/b'));
    call(b, read('/home/dev/app/b', { offset: 1 }));
    call(b, read('/home/dev/app/b', { offset: 0, limit: 0 }));
    call(b, read('/home/dev/app/b', { limit: 1 }));
    const f = repeatedRead.run(await built('ranges2', [b]), ctx());
    expect(f.map((x) => [x.data!.path, x.data!.rereads])).toEqual([
      ['a', 1],
      ['b', 2],
    ]);
  });
});

describe('4. threshold overrides', () => {
  it.each([
    ['ttl5mMs', ''],
    ['ttl5mMs', '   '],
    ['toString', '1'],
    ['__proto__', '1'],
    ['rebuildReadDropFraction', '1.5'],
    ['rebuildPrevContextFraction', '-0.1'],
    ['bigToolOutputTokens', '-1'],
  ])('rejects %s=%j', (key, value) => {
    expect(() => applyThresholdOverrides(DEFAULT_THRESHOLDS, { [key]: value })).toThrow();
  });

  it('accepts in-range values', () => {
    expect(
      applyThresholdOverrides(DEFAULT_THRESHOLDS, { rebuildReadDropFraction: '1', ttl5mMs: '0' }),
    ).toMatchObject({ rebuildReadDropFraction: 1, ttl5mMs: 0 });
  });

  it.each([
    '--threshold.rebuildReadDropFraction=2',
    '--threshold.toString=1',
    '--threshold.__proto__=1',
    '--threshold.ttl5mMs=',
  ])('%s exits 2', async (flag) => {
    const r = await cli([flag, '--root', join(FX, 'does-not-exist')]);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/^tknxray: /);
  });
});

describe('5. subcommand routing', () => {
  it('`--project doctor` analyzes with a project filter, it does not run doctor', async () => {
    let out = '';
    const code = await main(
      ['--project', 'doctor', '--root', join(FX, 'does-not-exist')],
      (x) => (out += x),
    );
    expect(code).toBe(1);
    expect(out).toContain('no sessions found');
    expect(out).toContain('project ~ "doctor"');
    expect(out).not.toContain('tknxray doctor (counts only');
  });
});

describe('6. dates', () => {
  it.each(['2026-02-30', '2026-13-01', 'yesterday', '2026/10/01', '2026-10-01 10:00', '1e12'])(
    'rejects %j',
    (v) => expect(() => parseDate(v, '--since')).toThrow(/expects YYYY-MM-DD/),
  );
  it('takes a date-time without an offset as UTC', () => {
    expect(parseDate('2026-10-01T10:00', '--since').toISOString()).toBe('2026-10-01T10:00:00.000Z');
    expect(parseDate('2026-10-01T10:00:00+02:00', '--since').toISOString()).toBe(
      '2026-10-01T08:00:00.000Z',
    );
    expect(parseDate('2024-02-29', '--until', true).toISOString()).toBe('2024-02-29T23:59:59.999Z');
  });
});

describe('7. A3 TTL is decided per session, before the window filter', () => {
  it('a 1h write before --since still makes a 10 min gap no TTL expiry', async () => {
    const b = session('m2r/ttl1h', { start: '2026-10-01T09:00:00.000Z' })
      .prompt('a')
      .assistant({ usage: { input: 3, cacheWrite: 20000, cacheWrite5m: 0, cacheWrite1h: 20000 } })
      .gap('24h')
      .prompt('b')
      .assistant({ usage: { input: 2, cacheWrite: 500, cacheRead: 20000 } })
      .gap('10m')
      .prompt('c')
      .assistant({ usage: { input: 3, cacheWrite: 21000 } });
    const sessions = await built('ttl1h', [b], { since: new Date('2026-10-02T00:00:00.000Z') });
    expect(sessions[0]!.turns).toHaveLength(2);
    expect(sessions[0]!.wrote1hCache).toBe(true);
    const f = cacheRebuild.run(sessions, ctx());
    expect(f[0]!.data!.causes).toMatchObject([{ cause: 'unknown', count: 1 }]);
  });
});

describe('8. --html', () => {
  it('a failed write has its own message; --json is printed first', async () => {
    const r = await cli([
      '--root',
      join(FX, 'ttl-gap-rebuild'),
      '--since',
      '2026-01-01',
      '--json',
      '--html',
      tmpdir(), // a directory: the write fails
    ]);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/^tknxray: could not write the HTML report to /);
    expect(JSON.parse(r.out).schemaVersion).toBe(1);
  });
});

describe('9. performance', () => {
  /** In-memory turns, no files: 6,000 turns, 3,000 of them rebuilds, plus 3,000 reads and 3,000 Bash calls. */
  function bigSession(): Session {
    const turns: Turn[] = [];
    const t0 = Date.parse('2026-10-01T00:00:00.000Z');
    for (let i = 0; i < 6000; i++) {
      const rebuild = i % 2 === 1;
      const read = i % 2 === 0;
      turns.push({
        sessionId: 'perf',
        uuid: `u${i}`,
        messageId: `m${i}`,
        ts: t0 + i * 400_000,
        gapMs: i === 0 ? null : 400_000,
        index: i,
        model: 'm',
        isSidechain: false,
        isSynthetic: false,
        usage: rebuild
          ? { input: 1, cacheWrite: 21000, cacheRead: 0, output: 1 }
          : { input: 1, cacheWrite: 10, cacheRead: 21000, output: 1 },
        toolUses: read
          ? [{ id: `t${i}`, name: 'Read', input: { file_path: `/p/f${i}` }, inputChars: 1 }]
          : [{ id: `b${i}`, name: 'Bash', input: { command: 'ls' }, inputChars: 1 }],
        toolResults: [],
        blockCounts: {},
        source: { file: '/x.jsonl', line: i + 1 },
      });
    }
    const ts = turns.map((t) => t.ts);
    return {
      id: 'perf',
      project: 'p',
      cwd: '/p',
      files: [],
      isSubagent: false,
      turns,
      prompts: [],
      events: [],
      firstTs: ts[0]!,
      lastTs: ts[ts.length - 1]!,
      ccVersions: [],
    };
  }
  it('A3 and A6 stay near-linear on a long session', () => {
    const sessions = [bigSession()];
    const start = performance.now();
    const rebuilds = cacheRebuild.run(sessions, ctx());
    const reads = repeatedRead.run(sessions, ctx());
    const big = bigToolOutput.run(sessions, ctx());
    expect(rebuilds[0]!.data!.rebuilds).toBe(3000);
    expect(reads).toEqual([]);
    expect(big).toEqual([]);
    expect(performance.now() - start).toBeLessThan(2000);
  });
});

describe('10. A5 and A6 never count the same Read', () => {
  it('a big repeated Read goes to A6 only for the repeat', async () => {
    const b = s('overlap');
    call(b, read('/home/dev/app/big.json'), 24000);
    call(b, read('/home/dev/app/big.json'), 24000);
    const sessions = await built('overlap', [b]);
    const a5 = bigToolOutput.run(sessions, ctx());
    const a6 = repeatedRead.run(sessions, ctx());
    expect(a5.map((f) => [f.data!.count, f.tokens.value])).toEqual([[1, 6000]]);
    expect(a6.map((f) => f.tokens.value)).toEqual([6000]);
  });
});

describe('11. labels and the TTL boundary', () => {
  it('per-cause tokens are labeled [E] in terminal, HTML and JSON', async () => {
    const report = buildReport({
      sessions: await fixture('ttl-gap-rebuild'),
      stats: { ...emptyStats(), files: 1 },
      ctx: ctx(),
      window: { since: null, until: null, project: null },
      includeContent: false,
    });
    expect(render(report, 'terminal')).toContain('1 × ttl-expiry (~21k [E])');
    expect(render(report, 'html')).toContain('ttl-expiry (~21k [E])');
    expect(render(report, 'json')).toContain('"tokensKind": "estimated"');
    expect(render(report, 'terminal')).toContain('21k [M]');
  });

  it('a gap of exactly 300,000 ms is not a TTL expiry; 300,001 ms is', async () => {
    // turn() timing: the assistant line is written 2 s after the gap starts (prompt + reply).
    const mk = (name: string, gapMs: number) => {
      const b = session(`m2r/${name}`);
      b.prompt('a').assistant({ usage: { input: 3, cacheWrite: 20000 } });
      b.prompt('b').assistant({ usage: { input: 2, cacheWrite: 500, cacheRead: 20000 } });
      b.gap(gapMs - 2000).prompt('c');
      return b.assistant({ usage: { input: 3, cacheWrite: 21000 }, blocks: [text('ok')] });
    };
    const at = await built('ttl-edge', [mk('edge', 300_000)]);
    expect(at[0]!.turns[2]!.ts - at[0]!.turns[1]!.ts).toBe(300_000);
    expect(cacheRebuild.run(at, ctx())[0]!.data!.causes).toMatchObject([{ cause: 'unknown' }]);
    const past = await built('ttl-past', [mk('past', 300_001)]);
    expect(cacheRebuild.run(past, ctx())[0]!.data!.causes).toMatchObject([{ cause: 'ttl-expiry' }]);
  });
});
