// `tknxray session`: resolution, flags, JSON rows and a snapshot of the rendered view.
// The fixture is DSL-built and synthetic; expected flags are worked out by hand below.
import { afterAll, describe, expect, it } from 'vitest';
import { session, text, toolUse } from '../scripts/make-fixture.js';
import { buildSessionView, resolveSession, wantsAscii } from '../src/commands/session.js';
import { main } from '../src/main.js';
import { DEFAULT_THRESHOLDS } from '../src/model/index.js';
import {
  formatSpan,
  renderSessionView,
  TOOLS_W,
  type SessionRow,
} from '../src/reporters/session.js';
import { visibleWidth } from '../src/reporters/format.js';
import { cleanup, load, tree } from './helpers/analyze.js';

afterAll(cleanup);
const SNAP = '__snapshots__/session';
const file_path = '/home/dev/app/src/a.ts';

/** Starts 2 min before midnight UTC so the rows cross a day boundary. */
function viewFixture() {
  const s = session('view/main', { start: '2026-10-01T23:58:00.000Z' })
    .prompt('look at a.ts')
    .assistant({
      usage: { input: 3, cacheWrite: 20_000, output: 100 },
      blocks: [toolUse('Read', { file_path })],
    })
    .toolResult(4_000)
    // Read of the same file again (📄) and a 24,000-char Bash output = 6,000 tokens [E] (📦).
    .assistant({
      usage: { input: 2, cacheWrite: 1_100, cacheRead: 20_000, output: 50 },
      blocks: [toolUse('Read', { file_path }), toolUse('Bash', { command: 'pnpm test' })],
    })
    .toolResult(4_000)
    .toolResult(24_000)
    .gap('6m')
    .prompt('explore')
    // 27,000 ≥ max(10,000, 0.5 × 21,102) and cache read 0 ≤ 0.5 × 20,000: rebuild (🔁), gap > 5m.
    .assistant({
      usage: { input: 3, cacheWrite: 27_000, output: 80 },
      blocks: [toolUse('Agent', { prompt: 'explore' }, 'toolu_view_agent')],
    });
  const a = s
    .agent('x1', { meta: { toolUseId: 'toolu_view_agent' } })
    .model('claude-haiku-4-5')
    .prompt('explore')
    .assistant({ usage: { input: 2, cacheWrite: 3_000, output: 10 }, blocks: [text('done')] });
  s.sync(a).toolResult(30);
  s.assistant({ model: '<synthetic>', requestId: null, envelope: { isApiErrorMessage: true } });
  s.assistant({
    usage: { input: 1, cacheWrite: 200, cacheRead: 27_000, output: 20 },
    blocks: [
      toolUse('mcp__github__list_pull_requests_for_repository'),
      toolUse('Grep', { pattern: 'x' }),
      toolUse('Bash', { command: 'ls' }),
      toolUse('Bash', { command: 'pwd' }),
    ],
  });
  const other = session('view/other', { start: '2026-09-30T10:00:00.000Z' })
    .prompt('hi')
    .assistant({ usage: { input: 1, cacheWrite: 100 } });
  return [s, a, other];
}

const flagsOf = (rows: SessionRow[]) => rows.map((r) => r.flags);

describe('session view', () => {
  it('flags rebuilds, repeated reads and big outputs per turn', async () => {
    const sessions = await load(viewFixture());
    const found = resolveSession(sessions, 'latest');
    if (!('session' in found)) throw new Error(found.error);
    const { view, subagentRows } = buildSessionView(found.session, sessions, DEFAULT_THRESHOLDS);
    expect(flagsOf(view.rows)).toEqual([[], ['dup-read', 'big-output'], ['rebuild'], [], []]);
    expect(view.rows.map((r) => r.gapOverTtl)).toEqual([false, false, true, false, false]);
    expect(view.rows[3]!.synthetic).toBe(true);
    expect(view.rows[4]!.tools).toEqual({
      mcp__github__list_pull_requests_for_repository: 1,
      Grep: 1,
      Bash: 2,
    });
    expect(view.totals).toEqual({
      input: 9,
      cacheWrite: 48_300,
      cacheRead: 47_000,
      output: 250,
      turns: 4,
    });
    expect(view.subagents).toEqual([
      expect.objectContaining({ agentId: 'x1', models: ['claude-haiku-4-5'], spawnedAt: 3 }),
    ]);
    expect(subagentRows.map((r) => r.chain)).toEqual(['agent-x1']);
    // Bigger threshold: the 6,000-token output is no longer big.
    const th = { ...DEFAULT_THRESHOLDS, bigToolOutputTokens: 6_001 };
    expect(flagsOf(buildSessionView(found.session, sessions, th).view.rows)[1]).toEqual([
      'dup-read',
    ]);
  });

  it('renders within 100 columns, with an ASCII fallback (snapshot)', async () => {
    const sessions = await load(viewFixture());
    const s = sessions.find((x) => !x.isSubagent && x.turns.length > 1)!;
    const { view } = buildSessionView(s, sessions, DEFAULT_THRESHOLDS);
    const utf = renderSessionView(view, { ascii: false, homeDir: '/home/dev' });
    const ascii = renderSessionView(view, { ascii: true, homeDir: '/home/dev' });
    for (const line of [...utf.split('\n'), ...ascii.split('\n')])
      expect(visibleWidth(line)).toBeLessThanOrEqual(100);
    expect(ascii).toMatch(/^[\x20-\x7e\n]*$/);
    expect(utf).not.toContain('pnpm test');
    await expect(utf).toMatchFileSnapshot(`${SNAP}/session.txt`);
    await expect(ascii).toMatchFileSnapshot(`${SNAP}/session-ascii.txt`);
  });

  it('resolves latest, full ids, unique prefixes; rejects short or ambiguous ones', async () => {
    const sessions = await load(viewFixture());
    const ids = sessions.filter((s) => !s.isSubagent).map((s) => s.id);
    const pick = (q: string) => {
      const r = resolveSession(sessions, q);
      return 'session' in r ? r.session.id : r.error;
    };
    const latest = pick('latest');
    expect(ids).toContain(latest);
    expect(pick(latest.slice(0, 4))).toBe(latest);
    expect(pick(`${latest}:agent-x1`)).toBe(`${latest}:agent-x1`);
    expect(pick('abc')).toContain('at least 4 characters');
    expect(pick('ffff')).toContain('no session matches');
    const twins = await load([
      session('tw/a', { id: 'abcd0001' }),
      session('tw/b', { id: 'abcd0002' }),
    ]);
    expect(resolveSession(twins, 'abcd')).toEqual({
      error: '"abcd" matches 2 sessions: abcd0001, abcd0002',
    });
  });

  it('tknxray session: --json rows, --threshold overrides and errors', async () => {
    const root = tree(viewFixture());
    const run = async (...args: string[]) => {
      let out = '';
      const code = await main(['session', ...args, '--root', root], (s) => (out += s));
      return { code, out };
    };
    const j = await run('latest', '--json', '--threshold.rebuildMinCacheWrite=30000');
    expect(j.code).toBe(0);
    const rows = JSON.parse(j.out) as SessionRow[];
    expect(rows).toHaveLength(6);
    expect(rows.flatMap((r) => r.flags)).not.toContain('rebuild');
    expect(rows[5]).toMatchObject({ chain: 'agent-x1', n: 1, model: 'claude-haiku-4-5' });
    expect((await run('latest', '--threshold.nope=1')).code).toBe(2);
    expect((await run('latest', '--threshold.ttl5mMs')).code).toBe(2);
    expect((await run('zzzz')).code).toBe(1);
    expect((await run()).code).toBe(2);
    const t = await run('latest');
    expect(t.code).toBe(0);
    expect(t.out).toContain('SUBAGENTS (1)');
  });

  it('uses ASCII flags for NO_COLOR, TERM=dumb and non-UTF-8 locales', () => {
    expect(wantsAscii({})).toBe(false);
    expect(wantsAscii({ LANG: 'en_US.UTF-8' })).toBe(false);
    expect(wantsAscii({ NO_COLOR: '1', LANG: 'en_US.UTF-8' })).toBe(true);
    expect(wantsAscii({ LC_ALL: 'C' })).toBe(true);
    expect(wantsAscii({ TERM: 'dumb' })).toBe(true);
  });

  it('review: rows fill exactly 100 columns; header numbers are wrapped, never cut', async () => {
    const sessions = await load(viewFixture());
    const s = sessions.find((x) => !x.isSubagent && x.turns.length > 1)!;
    const { view } = buildSessionView(s, sessions, DEFAULT_THRESHOLDS);
    expect(TOOLS_W).toBe(19);
    const long = renderSessionView(view, { ascii: false, homeDir: '/home/dev' })
      .split('\n')
      .find((l) => l.includes('Bash×2'))!;
    expect(visibleWidth(long)).toBe(100);
    expect(long.endsWith('Bash×2, mcp__githu…')).toBe(true); // 19 columns
    const huge = {
      ...view,
      project: `-home-dev-${'p'.repeat(60)}`,
      totals: {
        input: 123_456_789,
        cacheWrite: 987_654_321,
        cacheRead: 1_234_567_890,
        output: 55_555_555,
        turns: 4,
      },
    };
    const out = renderSessionView(huge, { ascii: true, homeDir: '/home/dev' });
    for (const n of ['123,456,789', '987,654,321', '1,234,567,890', '55,555,555'])
      expect(out).toContain(n);
    for (const line of out.split('\n')) expect(visibleWidth(line)).toBeLessThanOrEqual(100);
  });

  it('review: the span shows the end date when the UTC day changes', () => {
    expect(formatSpan('2026-10-01T09:00:00Z', '2026-10-01T09:05:00Z')).toBe(
      '2026-10-01 09:00–09:05 UTC',
    );
    expect(formatSpan('2026-10-01T23:58:00Z', '2026-10-02T00:04:00Z')).toBe(
      '2026-10-01 23:58 – 2026-10-02 00:04 UTC',
    );
  });
});
