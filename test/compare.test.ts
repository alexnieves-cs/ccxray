// `tknxray compare` (SPEC §3.1) on synthetic sessions: a before week and an after week.
import { afterAll, describe, expect, it } from 'vitest';
import { session } from '../scripts/make-fixture.js';
import { compareCommand } from '../src/commands/compare.js';
import { compare, direction, relMove, side, type Metric } from '../src/compare.js';
import { stripAnsi } from '../src/reporters/format.js';
import { cleanupTmp, writeBuilt } from './helpers/analyzer-fixtures.js';

afterAll(cleanupTmp);

/** n turns per session; a context of `ctx` tokens read from the cache each turn. */
function week(prefix: string, start: string, sessions: number, ctx: number) {
  return Array.from({ length: sessions }, (_, i) => {
    const day = new Date(Date.parse(start) + i * 86_400_000).toISOString();
    const b = session(`${prefix}-${i}`, { start: day, model: 'claude-opus-4-5' });
    b.prompt('task').assistant({ usage: { input: 3, cacheWrite: ctx, output: 200 } });
    for (let t = 0; t < 40; t++)
      b.prompt('more').assistant({
        usage: { input: 3, cacheRead: ctx, cacheWrite: 500, output: 200 },
      });
    return b;
  });
}

const ROOT = writeBuilt('compare', [
  ...week('before', '2026-10-01T09:00:00.000Z', 4, 120_000),
  ...week('after', '2026-10-08T09:00:00.000Z', 4, 40_000),
]);

async function run(argv: string[]) {
  let out = '';
  let err = '';
  const code = await compareCommand([...argv, '--root', ROOT], (s) => (out += s), {
    err: (s) => (err += s),
    isTTY: false,
    now: new Date('2026-10-19T00:00:00.000Z'),
  });
  return { code, out, err };
}

const metric = (over: Partial<Metric>): Metric => ({
  id: 'x',
  label: 'x',
  unit: 'usd',
  before: 1,
  after: 1,
  better: 'lower',
  kind: 'estimated',
  ...over,
});

describe('compare: direction', () => {
  it('moves under 5% are the same; the sign follows `better`', () => {
    expect(direction(metric({ before: 100, after: 96 }))).toBe('same');
    expect(direction(metric({ before: 100, after: 90 }))).toBe('better');
    expect(direction(metric({ before: 100, after: 110 }))).toBe('worse');
    expect(direction(metric({ before: 0.9, after: 0.99, better: 'higher' }))).toBe('better');
    expect(direction(metric({ better: 'neutral', before: 1, after: 9 }))).toBeNull();
    expect(direction(metric({ before: null }))).toBeNull();
  });

  it('a rise from 0 is a move, with no relative size', () => {
    expect(relMove({ before: 0, after: 3 })).toBeNull();
    expect(relMove({ before: 0, after: 0 })).toBe(0);
    expect(direction(metric({ before: 0, after: 3 }))).toBe('worse');
  });
});

describe('tknxray compare', () => {
  it('--at splits into two windows and shows smaller context as better', async () => {
    const r = await run(['--at', '2026-10-08', '--json']);
    expect(r.code).toBe(0);
    const c = JSON.parse(r.out) as ReturnType<typeof compare>;
    const m = Object.fromEntries(c.metrics.map((x) => [x.id, x]));
    expect(m.sessions!.before).toBe(4);
    expect(m.sessions!.after).toBe(4);
    expect(m.turns!.before).toBe(164);
    expect(m.peakContext!.before).toBe(120_503);
    expect(m.peakContext!.after).toBe(40_503);
    expect(c.improved).toEqual(expect.arrayContaining(['costPerTurn', 'peakContext']));
    expect(c.before.since).toBe('2026-10-01T00:00:00.000Z');
    expect(c.after.until).toBe('2026-10-14T23:59:59.999Z');
    expect(c.thin).toBeUndefined();
  });

  it('prints labeled rows, a verdict and the caveat', async () => {
    const r = await run([
      '--before',
      '2026-10-01..2026-10-07',
      '--after',
      '2026-10-08..2026-10-14',
    ]);
    const out = stripAnsi(r.out);
    expect(out).toMatch(/\$ per turn \[E\]/);
    expect(out).toMatch(/median peak context \[M\]\s+121k\s+41k\s+-66%\s+better/);
    expect(out).toMatch(/VERDICT {2}\d+ better, \d+ worse/);
    expect(out).toContain('evidence, not proof');
    for (const line of out.split('\n')) expect(line.length).toBeLessThanOrEqual(100);
  });

  it('flags thin windows and exits 1 when one side is empty', async () => {
    const r = await run(['--at', '2026-10-15', '--days', '7', '--json']);
    expect(r.code).toBe(1);
    expect((JSON.parse(r.out) as { thin: string }).thin).toMatch(
      /after window has 0 main sessions/,
    );
  });

  it('rejects bad arguments with exit 2', async () => {
    for (const argv of [
      [],
      ['--at', '2026-10-08', '--before', '2026-10-01..2026-10-02'],
      ['--at', '2026-10-08', '--days', '0'],
      ['--at', '2026-10-08T05:00'],
      ['--before', '2026-10-05', '--after', '2026-10-08..2026-10-09'],
      ['--before', '2026-10-05..2026-10-09', '--after', '2026-10-08..2026-10-09'],
    ]) {
      const r = await run(argv);
      expect(r.code, argv.join(' ')).toBe(2);
      expect(r.err).toMatch(/tknxray compare: /);
    }
  });

  it('--help prints usage', async () => {
    const r = await run(['--help']);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/tknxray compare --at DATE/);
  });

  it('side() keeps only main sessions with real turns', () => {
    expect(side({} as never, []).main).toEqual([]);
  });
});
