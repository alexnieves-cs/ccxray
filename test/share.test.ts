// `tknxray share` (SPEC §3.2): the shareable file holds no free text from the logs.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Ajv2020 } from 'ajv/dist/2020.js';
import * as formatsModule from 'ajv-formats';
import fc from 'fast-check';
import { afterAll, describe, expect, it } from 'vitest';
import { shareCommand } from '../src/commands/share.js';
import { main } from '../src/main.js';
import {
  addTotals,
  localSessionLabel,
  makeHasher,
  OTHER,
  renderShare,
  shareData,
  shareModel,
  shareReport,
  shareTool,
  type ShareReport,
} from '../src/reporters/share.js';
import { FX } from './helpers/analyzer-fixtures.js';
import { costedSampleReport, sampleReport } from './helpers/sample-report.js';

const TMP = mkdtempSync(join(tmpdir(), 'ccxray-share-'));
afterAll(() => rmSync(TMP, { recursive: true, force: true }));

function validator() {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  const mod = formatsModule as unknown as { default: unknown };
  const add = (
    typeof mod.default === 'function' ? mod.default : (mod.default as { default: unknown }).default
  ) as (a: Ajv2020) => void;
  add(ajv);
  const path = join(import.meta.dirname, '..', 'schema', 'share.v1.json');
  return ajv.compile(JSON.parse(readFileSync(path, 'utf8')) as object);
}
const validate = validator();

const SALT = Buffer.from('00112233445566778899aabbccddeeff', 'hex');
const NOW = new Date('2026-11-25T12:00:00Z');

/** The sample report with private-looking strings in every place a log string can reach. */
function leakyReport() {
  const r = costedSampleReport();
  r.window = { since: '2026-10-11T00:00:00.000Z', until: null, project: 'acme-secret' };
  r.stats.roots = ['/home/dev/.claude/projects'];
  r.stats.recordTypes['/home/dev/odd type'] = 2;
  r.stats.ccVersions['2.1.290-acme-internal'] = 5;
  r.stats.warnings['bad line in /home/dev/x.jsonl'] = 1;
  r.totals.byModel['acme-finetune-v2'] = r.totals.all;
  r.totals.byModel['claude-opus-4-5-acme/ft'] = r.totals.all;
  const f = r.findings[0]!;
  f.data = {
    ...f.data,
    tool: 'mcp__acme-internal__deploy',
    command: 'ACME_TOKEN=sk-123 ./deploy-acme.sh',
    note: 'secret plan',
    model: 'acme-finetune-v2',
    type: 'acme-reviewer',
    ttl: 'C:\\Users\\dev',
    causes: [{ cause: 'see /home/dev/notes.md', fix: 'edit /home/dev/CLAUDE.md', count: 2 }],
  };
  return r;
}

const LEAKS = [
  '/home/dev',
  '-home-dev',
  'acme',
  'client.ts',
  'pnpm test',
  'CI=1',
  'sk-123',
  'secret',
  'github',
  'Users',
  'CLAUDE.md',
  'read #2',
  'rebuilds cost',
];

describe('shareReport', () => {
  it('holds none of the private strings and matches the closed schema', () => {
    const r = leakyReport();
    const out = renderShare(shareReport(r, { hash: makeHasher(SALT), now: NOW }));
    for (const s of LEAKS) expect(out, s).not.toContain(s);
    for (const f of r.findings) expect(out).not.toContain(f.title);
    for (const s of r.sessions) expect(out).not.toContain(s.id.slice(0, 8));
    const share = JSON.parse(out) as ShareReport;
    expect(validate(share), JSON.stringify(validate.errors)).toBe(true);
    expect(share.window).toEqual({ since: '2026-10-11', until: null, projectFilter: true });
    expect(share.stats.roots).toBe(1);
    expect(share.stats.recordTypes[OTHER]).toBe(2);
    expect(share.stats.ccVersions[OTHER]).toBe(5);
    expect(share.stats.warnings[OTHER]).toBe(1);
    expect(share.findings[0]!.data).toMatchObject({
      tool: 'mcp',
      model: OTHER,
      type: '(custom)',
      ttl: OTHER,
      causes: [{ cause: OTHER, count: 2 }],
    });
  });

  it('keeps the numbers, ids and vocabularies a reviewer needs', () => {
    const r = costedSampleReport();
    const share = shareReport(r, { hash: makeHasher(SALT), now: NOW });
    expect(validate(share), JSON.stringify(validate.errors)).toBe(true);
    expect(share.generatedOn).toBe('2026-11-25');
    expect(share.totals.all).toEqual(r.totals.all);
    expect(share.totals.activeDays).toBe(Object.keys(r.totals.byDay).length);
    expect(share.sessions).toEqual({ count: 4, main: 2, subagents: 2 });
    expect(share.findings.map((f) => f.analyzer)).toEqual(r.findings.map((f) => f.analyzer));
    expect(share.findings.map((f) => f.n)).toEqual(r.findings.map((_, i) => i + 1));
    expect(share.findings.map((f) => f.tokens)).toEqual(r.findings.map((f) => f.tokens));
    const rebuild = share.findings.find((f) => f.analyzer === 'cache-rebuild')!;
    // The `fix` text of each cause is dropped; its numbers stay.
    const causes = rebuild.data.causes as Record<string, unknown>[];
    expect(causes.map((c) => [c.cause, c.count, c.tokens])).toEqual([
      ['cc-upgrade', 3, 201_000],
      ['ttl-expiry', 29, 2_204_000],
      ['config-edit', 6, 413_900],
    ]);
    for (const c of causes)
      expect(Object.keys(c).sort()).toEqual(['cause', 'costUsd', 'count', 'savingsUsd', 'tokens']);
    const big = share.findings.find((f) => f.analyzer === 'big-tool-output')!;
    expect(big.data).toEqual({ tool: 'Bash', count: 11, maxChars: 48_100, turnsCarriedMax: 140 });
    for (const f of share.findings) expect(f.review).toEqual({ verdict: null, note: '' });
    expect(share.actionPlan?.actions.map((a) => a.findings)).toEqual(
      r.actionPlan?.actions.map((a) => a.findings),
    );
    expect(share.notes).toBe('');
  });

  it('merges model ids outside the list into "(other)" and keeps the sums right', () => {
    const r = sampleReport();
    const t = r.totals.all;
    r.totals.byModel = { 'acme-a': t, 'acme-b': t, 'claude-opus-4-5': t };
    const share = shareReport(r, { hash: makeHasher(SALT) });
    expect(Object.keys(share.totals.byModel).sort()).toEqual([OTHER, 'claude-opus-4-5']);
    expect(share.totals.byModel[OTHER]).toEqual(addTotals(t, t));
    expect(share.totals.byModel[OTHER]!.turns).toBe(2 * t.turns);
    expect(share.totals.byModel[OTHER]!.cacheHitRatio).toBeCloseTo(t.cacheHitRatio!, 12);
  });

  it('hashes sessions with a per-file salt: stable within a file, unlinkable across files', () => {
    const r = sampleReport();
    const a = shareReport(r, { hash: makeHasher(SALT) });
    const b = shareReport(r, { hash: makeHasher(SALT) });
    const c = shareReport(r, { hash: makeHasher() });
    expect(a.findings.map((f) => f.evidence)).toEqual(b.findings.map((f) => f.evidence));
    expect(a.findings[0]!.evidence.sessions).not.toEqual(c.findings[0]!.evidence.sessions);
    expect(renderShare(a)).not.toContain(SALT.toString('hex'));
    const h = makeHasher(SALT);
    const parent = '3fa2c1d0-1111-4aaa-8bbb-000000000001';
    expect(h(parent)).toMatch(/^[0-9a-f]{12}$/);
    expect(h(`${parent}:agent-7f3e`)).toMatch(new RegExp(`^${h(parent)}:[0-9a-f]{8}$`));
    expect(localSessionLabel(`${parent}:agent-7f3e9a01b2`)).toBe('3fa2c1d0 subagent 7f3e9a01');
    expect(localSessionLabel(parent)).toBe('3fa2c1d0');
  });

  it('never lets a string under an unknown key through, whatever it holds', () => {
    const known = new Set(['tool', 'model', 'parentModel', 'cheaperModel', 'subagentModels']);
    fc.assert(
      fc.property(
        fc.string({ minLength: 1 }).filter((k) => !known.has(k)),
        fc.string({ minLength: 1 }),
        (k, v) => {
          const out = shareData({ [k]: v }, makeHasher(SALT));
          const s = Object.hasOwn(out, k) ? out[k] : undefined;
          // Dropped, or a short id with no path or command characters; the raw value only
          // passes through when it is itself such an id (an analyzer enum like `ttl-expiry`).
          if (s === undefined) return true;
          if (typeof s !== 'string') return false;
          return /^[A-Za-z0-9()_:-]{1,40}$/.test(s) && (s !== v || /^[A-Za-z0-9_-]{1,40}$/.test(v));
        },
      ),
    );
    fc.assert(
      fc.property(fc.string(), (v) => {
        const t = shareTool(v);
        const m = shareModel(v);
        return (
          (t === OTHER || t === 'mcp' || /^[A-Z][A-Za-z0-9]+$/.test(t)) &&
          (m === OTHER || m === '<synthetic>' || /^claude-[a-z0-9.-]+$/.test(m))
        );
      }),
    );
  });
});

describe('tknxray share', () => {
  const root = ['--root', join(FX, 'ttl-gap-rebuild'), '--root', join(FX, 'big-bash-output')];

  async function run(argv: string[]) {
    let out = '';
    let err = '';
    const code = await shareCommand(argv, (s) => (out += s), { now: NOW, err: (s) => (err += s) });
    return { code, out, err };
  }

  it('writes a valid file and lists the titles only on the terminal', async () => {
    const file = join(TMP, 'a.json');
    const { code, out } = await run([...root, '--since', '2026-01-01', '--out', file]);
    expect(code).toBe(0);
    const text = readFileSync(file, 'utf8');
    const share = JSON.parse(text) as ShareReport;
    expect(validate(share), JSON.stringify(validate.errors)).toBe(true);
    expect(share.findings.length).toBeGreaterThan(0);
    expect(out).toContain(`wrote ${file}`);
    expect(out).toContain('1. [');
    expect(out).toContain('in the file)');
    // The local list names each finding; the file does not.
    const titleLine = out.split('\n').find((l) => l.startsWith('1. ['))!;
    const title = titleLine.slice(titleLine.indexOf(': ') + 2);
    expect(title.length).toBeGreaterThan(0);
    expect(text).not.toContain(title);
    expect(text).not.toContain(FX);
  });

  it('leaves an existing file alone unless --force', async () => {
    const file = join(TMP, 'reviewed.json');
    writeFileSync(file, 'my reviews');
    const r1 = await run([...root, '--since', '2026-01-01', '--out', file]);
    expect(r1.code).toBe(2);
    expect(r1.err).toContain('already exists; pass --force');
    expect(readFileSync(file, 'utf8')).toBe('my reviews');
    const r2 = await run([...root, '--since', '2026-01-01', '--out', file, '--force']);
    expect(r2.code).toBe(0);
    expect(readFileSync(file, 'utf8')).toContain('"tknxray-share"');
  });

  it('writes nothing when there are no sessions, and rejects bad flags', async () => {
    const file = join(TMP, 'none.json');
    const r = await run(['--root', join(TMP, 'missing'), '--out', file]);
    expect(r.code).toBe(1);
    expect(existsSync(file)).toBe(false);
    expect((await run(['--include-content'])).code).toBe(2);
    expect((await run(['--out', ''])).code).toBe(2);
  });

  it('is reachable from main and has its own help', async () => {
    let out = '';
    expect(await main(['share', '--help'], (s) => (out += s))).toBe(0);
    expect(out).toContain('tknxray share [--since DATE]');
    out = '';
    expect(await main(['--help'], (s) => (out += s))).toBe(0);
    expect(out).toContain('tknxray share');
  });
});
