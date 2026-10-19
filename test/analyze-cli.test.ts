// Default command (SPEC §3) on the committed fixtures. Never reads ~/.claude: every run passes
// --root (or a root that does not exist).
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Ajv2020 } from 'ajv/dist/2020.js';
import * as formatsModule from 'ajv-formats';
import { afterAll, describe, expect, it } from 'vitest';
import { analyze, parseDate, splitThresholds } from '../src/commands/analyze.js';
import { main } from '../src/main.js';
import { FX } from './helpers/analyzer-fixtures.js';

const TMP = mkdtempSync(join(tmpdir(), 'ccxray-cli-'));
afterAll(() => rmSync(TMP, { recursive: true, force: true }));

const NAMES = [
  'ttl-gap-rebuild',
  'version-change-rebuild',
  'big-bash-output',
  'repeated-read-unchanged',
  'nested-subagents-dir',
];
const ROOTS = NAMES.flatMap((n) => ['--root', join(FX, n)]);
const SINCE = ['--since', '2026-09-01'];

async function run(argv: string[], now?: Date) {
  let out = '';
  let err = '';
  const code =
    now === undefined
      ? await main(argv, (s) => (out += s))
      : await analyze(argv, (s) => (out += s), { now, err: (s) => (err += s), isTTY: false });
  return { code, out, err };
}
async function runArgs(argv: string[]) {
  let out = '';
  let err = '';
  const code = await analyze(argv, (s) => (out += s), { err: (s) => (err += s), isTTY: false });
  return { code, out, err };
}

function validator() {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  const mod = formatsModule as unknown as { default: unknown };
  const add = (
    typeof mod.default === 'function' ? mod.default : (mod.default as { default: unknown }).default
  ) as (a: Ajv2020) => void;
  add(ajv);
  const schema = join(import.meta.dirname, '..', 'schema', 'report.v1.json');
  return ajv.compile(JSON.parse(readFileSync(schema, 'utf8')) as object);
}

describe('tknxray (default command)', () => {
  it('prints the terminal report within 100 columns', async () => {
    const { code, out } = await run([...ROOTS, ...SINCE, '--no-color']);
    expect(code).toBe(0);
    expect(out).toContain('tknxray · 7 sessions (2 subagent)');
    expect(out).toContain('2 rebuilds cost 42k cache-write tokens');
    expect(out).toContain('`pnpm test` returned up to 48k chars inline');
    expect(out).toContain('src/api/client.ts re-read 2× unchanged');
    expect(out).not.toContain(String.fromCharCode(27));
    for (const line of out.split('\n')) expect(line.length).toBeLessThanOrEqual(100);
    for (const secret of ['prompt 1', 'reply 2', 'look at client.ts'])
      expect(out).not.toContain(secret);
  });

  it('defaults --since to 7 days before now', async () => {
    const inside = await run([...ROOTS], new Date('2026-10-05T00:00:00.000Z'));
    expect(inside.code).toBe(0);
    const outside = await run([...ROOTS], new Date('2026-10-18T00:00:00.000Z'));
    expect(outside.code).toBe(1);
    expect(outside.out).toContain('no sessions found');
    expect(outside.out).toContain('since 2026-10-11T00:00:00.000Z');
  });

  it('--json validates against schema/report.v1.json', async () => {
    const { code, out } = await run([...ROOTS, ...SINCE, '--json']);
    expect(code).toBe(0);
    const report = JSON.parse(out);
    const validate = validator();
    expect(validate(report), JSON.stringify(validate.errors)).toBe(true);
    expect(report.window).toEqual({ since: '2026-09-01', until: null, project: null });
    // ttl (3+2+3) + version (3+2+3) + bash (3+2+2) + reads (2+2+2+1) + nested (5+4+3+2+3)
    expect(report.totals.all.input).toBe(47);
    expect(report.totals.all.turns).toBe(3 + 3 + 3 + 4 + 5);
    expect(report.findings.map((f: { analyzer: string }) => f.analyzer)).toEqual([
      'cache-rebuild',
      'fixed-overhead',
      'subagent-cost',
      'big-tool-output',
      'big-tool-output',
      'repeated-read',
      'tool-usage',
    ]);
    expect(report.calibration).toMatchObject({ samples: expect.any(Number) });
  });

  it('--until, --project and --threshold.* filter and tune', async () => {
    const proj = await run([...ROOTS, ...SINCE, '--project', 'ttl-gap', '--json']);
    expect(JSON.parse(proj.out).sessions).toHaveLength(1);
    const early = await run([...ROOTS, '--since', '2026-09-01', '--until', '2026-09-30', '--json']);
    expect(early.code).toBe(1);
    expect(JSON.parse(early.out).sessions).toEqual([]);
    const th = await run([...ROOTS, ...SINCE, '--json', '--threshold.rebuildMinCacheWrite=30000']);
    expect(JSON.parse(th.out).findings.map((f: { analyzer: string }) => f.analyzer)).not.toContain(
      'cache-rebuild',
    );
  });

  it('--html writes a self-contained file and prints its path', async () => {
    const file = join(TMP, 'report.html');
    const { code, out } = await run([...ROOTS, ...SINCE, '--html', file]);
    expect(code).toBe(0);
    expect(out).toBe(`wrote ${file}\n`);
    const html = readFileSync(file, 'utf8');
    expect(html).toContain('<html');
    const remote = /\b(?:src|href|data|action|srcset|poster)\s*=\s*["']?\s*(?:https?:)?\/\//i;
    const tags = [...html.matchAll(/<(\w+)\b[^>]*>/g)].filter(
      (m) => remote.test(m[0]) && !(m[1] === 'a' && /rel="[^"]*noreferrer/.test(m[0])),
    );
    expect(tags.map((m) => m[0])).toEqual([]);
    expect(html).not.toMatch(/url\(\s*["']?\s*(?:https?:)?\/\/|@import/i);
  });

  it('--html with --json keeps stdout pure JSON', async () => {
    const file = join(TMP, 'both.html');
    const { code, out, err } = await run(
      [...ROOTS, ...SINCE, '--json', '--html', file],
      new Date(),
    );
    expect(code).toBe(0);
    expect(() => JSON.parse(out)).not.toThrow();
    expect(err).toBe(`wrote ${file}\n`);
  });

  it('exits 1 with the empty state when no logs are found', async () => {
    const { code, out } = await run(['--root', join(FX, 'does-not-exist')]);
    expect(code).toBe(1);
    expect(out).toContain('no sessions found');
  });

  it.each([
    [['--bogus']],
    [['--since', 'yesterday']],
    [['--threshold.nope=1']],
    [['--threshold.ttl5mMs=abc']],
    [['--threshold.ttl5mMs']],
    [['stray-positional']],
    [['--since', '2026-10-02', '--until', '2026-10-01']],
  ])('exits 2 on bad args: %j', async (argv) => {
    const { code, out, err } = await runArgs([...argv, '--root', join(FX, 'does-not-exist')]);
    expect(code).toBe(2);
    expect(out).toBe('');
    expect(err).toMatch(/^tknxray: /);
  });

  it('parses dates and threshold flags', () => {
    expect(parseDate('2026-10-01', '--since').toISOString()).toBe('2026-10-01T00:00:00.000Z');
    expect(parseDate('2026-10-01', '--until', true).toISOString()).toBe('2026-10-01T23:59:59.999Z');
    expect(splitThresholds(['--json', '--threshold.a=1', '--threshold.b', '2'])).toEqual({
      rest: ['--json'],
      overrides: { a: '1', b: '2' },
    });
  });
});
