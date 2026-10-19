// `tknxray watch`: frame snapshots (synthetic fixtures, fixed width and `now`), the polling loop,
// the CLI paths and the privacy / no-keep-alive guarantees (CLAUDE.md rules 4 and 5).
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { session, toolUse, writeTree, type SessionBuilder } from '../scripts/make-fixture.js';
import { resolveTarget, screen, Watcher, watchCommand } from '../src/commands/watch.js';
import { main } from '../src/main.js';
import type { Session } from '../src/model/index.js';
import { stripAnsi, visibleWidth } from '../src/reporters/format.js';
import { assumedWindow, bucketMax, renderWatchFrame } from '../src/reporters/watch.js';
import { fixture } from './helpers/analyzer-fixtures.js';

const TMP = mkdtempSync(join(tmpdir(), 'ccxray-watch-'));
afterAll(() => rmSync(TMP, { recursive: true, force: true }));
const SNAP = '__snapshots__/watch';
const HOME = '/home/dev';
let n = 0;

function tree(builders: readonly SessionBuilder[]): string {
  const root = join(TMP, `r${n++}`);
  mkdirSync(root, { recursive: true });
  writeTree(root, builders);
  return root;
}

const SECRETS = ['SECRET-PROMPT-TEXT', 'SECRET-RESULT-TEXT', 'SECRET-REPLY-TEXT', 'secret-cmd'];

/**
 * 150 turns with a context growing past 200k, tool calls with results, a compaction, a 1h-TTL rebuild after
 * a 70 min break and a pending tool call on the last turn. Prompts, replies, tool inputs and
 * tool outputs carry SECRETS, which must never reach a frame.
 */
const TURNS = 150;

function busy(): SessionBuilder {
  const s = session('watch/busy', { start: '2026-10-01T09:00:00.000Z' });
  let ctx = 20_000;
  s.prompt('SECRET-PROMPT-TEXT one').assistant({
    usage: { input: 3, cacheWrite: ctx, cacheWrite1h: ctx, output: 50 },
    blocks: [{ type: 'text', text: 'SECRET-REPLY-TEXT' }],
  });
  for (let i = 2; i <= TURNS; i++) {
    s.gap(i === 41 ? '70m' : '20s');
    if (i === 30) {
      s.record('system', { subtype: 'compact_boundary', content: 'SECRET-PROMPT-TEXT summary' });
      ctx = 30_000;
      s.prompt('SECRET-PROMPT-TEXT after compaction').assistant({
        usage: { input: 2, cacheWrite: ctx, cacheWrite1h: ctx, output: 40 },
      });
      continue;
    }
    if (i === 41) {
      // 1h TTL session, 70 min gap: rebuild with cause ttl-expiry.
      s.prompt('SECRET-PROMPT-TEXT back').assistant({
        usage: { input: 2, cacheWrite: ctx + 500, cacheWrite1h: ctx + 500, output: 40 },
      });
      ctx += 500;
      continue;
    }
    const grow = 2_000;
    const last = i === TURNS;
    s.assistant({
      usage: { input: 1, cacheRead: ctx, cacheWrite: grow, cacheWrite1h: grow, output: 30 },
      blocks: [
        toolUse('Bash', { command: 'secret-cmd --flag' }),
        ...(last ? [toolUse('Read', { file_path: '/home/dev/app/x.ts' })] : []),
      ],
    });
    if (!last) s.toolResult({ content: `SECRET-RESULT-TEXT ${'o'.repeat(7_980)}` });
    else s.toolResult({ content: 'SECRET-RESULT-TEXT' });
    ctx += grow;
  }
  return s;
}

async function loadBusy(): Promise<Session> {
  const [root] = [tree([busy()])];
  const res = await resolveTarget([root!], 'latest');
  if ('error' in res) throw new Error(res.error);
  return res.state.session!;
}

const NOW = Date.parse('2026-10-01T09:10:00.000Z');

function frame(
  s: Session,
  width: number,
  extra: Partial<Parameters<typeof renderWatchFrame>[1]> = {},
) {
  return renderWatchFrame(s, { width, now: NOW, homeDir: HOME, mode: 'live', ...extra });
}

describe('renderWatchFrame snapshots', () => {
  it.each([80, 120])(
    'ttl-gap-rebuild, nested-subagents-dir, big-bash-output at %i columns',
    async (w) => {
      const parts: string[] = [];
      for (const name of ['ttl-gap-rebuild', 'nested-subagents-dir', 'big-bash-output']) {
        const sessions = await fixture(name);
        const main = sessions.find((s) => !s.isSubagent)!;
        const subagents = sessions.filter((s) => s.isSubagent && s.parentSessionId === main.id);
        parts.push(`=== ${name} ===\n${frame(main, w, { subagents })}`);
      }
      const out = parts.join('\n');
      for (const line of out.split('\n')) expect(visibleWidth(line)).toBeLessThanOrEqual(w);
      await expect(out).toMatchFileSnapshot(`${SNAP}/fixtures-${w}.txt`);
    },
  );

  it.each([80, 120])(
    'a busy session (downsampled chart, compaction, 1h TTL) at %i columns',
    async (w) => {
      const s = await loadBusy();
      const out = frame(s, w, { now: Date.parse('2026-10-01T11:30:00.000Z') });
      for (const line of out.split('\n')) expect(visibleWidth(line)).toBeLessThanOrEqual(w);
      await expect(out).toMatchFileSnapshot(`${SNAP}/busy-${w}.txt`);
    },
  );

  it('labels what it shows: rebuild cause, compaction, TTL, window, tool sizes', async () => {
    const out = frame(await loadBusy(), 120, { now: Date.parse('2026-10-01T11:30:00.000Z') });
    expect(out).toContain('(assumed window)');
    expect(out).toContain('cache TTL 1h (from the cache-write split) [E]');
    expect(out).toContain('1 rebuild');
    expect(out).toContain('1 compaction');
    expect(out).toMatch(/↻[^\n]*\n[^\n]*◆/);
    expect(out).toContain('tools (result ~tokens [E]): Bash ~5 · Read (no result yet)');
    expect(out).toContain('max of up to 2 turns per column');
  });

  it('stays within 60..120 columns and colors only when asked', async () => {
    const s = await loadBusy();
    for (const w of [20, 60, 79, 100, 200]) {
      const out = frame(s, w, { color: true });
      const max = Math.max(60, Math.min(w, 120));
      for (const line of out.split('\n')) expect(visibleWidth(line)).toBeLessThanOrEqual(max);
      expect(out).toContain('\x1b[');
    }
    expect(frame(s, 80)).not.toContain('\x1b');
  });

  it('marks a rebuild on the latest turn with its cause', async () => {
    const [main] = (await fixture('ttl-gap-rebuild')).filter((s) => !s.isSubagent);
    const out = frame(main!, 100);
    expect(out).toContain('↻ rebuild: rewrote 20,600 [M]');
    expect(out).toContain('likely cause ttl-expiry [E]');
  });

  it('shows a waiting state for a session without assistant turns', async () => {
    const s = session('watch/empty').prompt('SECRET-PROMPT-TEXT');
    const root = tree([s]);
    // `latest` skips sessions without turns, so name it.
    const res = await resolveTarget([root], s.id);
    expect('error' in res).toBe(false);
    if ('error' in res) return;
    const out = frame(res.state.session!, 80);
    expect(out).toContain('waiting for the first assistant turn');
  });
});

describe('privacy and ToS', () => {
  it('never shows prompt, reply, tool input or tool output text', async () => {
    const s = await loadBusy();
    const frames = [80, 120].map((w) => frame(s, w));
    for (const name of ['ttl-gap-rebuild', 'nested-subagents-dir', 'big-bash-output']) {
      const all = await fixture(name);
      const main = all.find((x) => !x.isSubagent)!;
      frames.push(frame(main, 100, { subagents: all.filter((x) => x.isSubagent) }));
    }
    for (const f of frames) {
      for (const secret of [...SECRETS, 'prompt 1', 'reply 1', 'say hi', 'x.ts'])
        expect(f).not.toContain(secret);
    }
  });

  it('idle past the TTL says the cache likely expired, and never suggests keeping it warm', async () => {
    const s = await loadBusy();
    const lastTs = s.turns[s.turns.length - 1]!.ts;
    for (const ago of [0, 30_000, 4 * 60_000, 59 * 60_000, 3_600_000, 3_600_001, 5 * 3_600_000]) {
      const out = stripAnsi(frame(s, 100, { now: lastTs + ago }));
      const expired = ago > 3_600_000;
      expect(out.includes('cache has likely expired; the next turn will rebuild it [E]')).toBe(
        expired,
      );
      expect(out).not.toMatch(/keep[^\n]*warm/i);
      expect(out).not.toMatch(/warm[^\n]*cache|cache[^\n]*warm/i);
      expect(out).not.toMatch(/send (a|another|one) (prompt|message)/i);
      expect(out).not.toMatch(/keep-?alive|expires in|left before|time left|remaining|ping/i);
    }
  });
});

describe('helpers', () => {
  it('bucketMax keeps one column per turn, or the max per bucket', () => {
    expect(bucketMax([1, 2, 3], 5).map((b) => b.value)).toEqual([1, 2, 3]);
    expect(bucketMax([1, 9, 2, 3, 8, 1], 3).map((b) => b.value)).toEqual([9, 3, 8]);
    expect(bucketMax([1, 9, 2, 3, 8, 1], 3).map((b) => [b.from, b.to])).toEqual([
      [0, 2],
      [2, 4],
      [4, 6],
    ]);
  });

  it('assumes a 1M window only after a turn went over 200k', () => {
    expect(assumedWindow([10, 200_000])).toBe(200_000);
    expect(assumedWindow([10, 200_001])).toBe(1_000_000);
  });

  it('screen() redraws in place and keeps the footer when the terminal is short', () => {
    const out = screen('a\nb\nc\nd\n', 3);
    expect(out.startsWith('\x1b[H')).toBe(true);
    expect(out).toBe('\x1b[Ha\x1b[K\r\nb\x1b[K\r\nd\x1b[K\x1b[J');
  });
});

/** Write the first `k` lines of `s` to its transcript path under `root`; returns the rest. */
function writePartial(
  root: string,
  s: SessionBuilder,
  k: number,
): { path: string; rest: string[] } {
  const lines = s.toJsonl().trimEnd().split('\n');
  const path = join(root, s.relPath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, lines.slice(0, k).join('\n') + '\n');
  return { path, rest: lines.slice(k) };
}

function liveSession(): SessionBuilder {
  const s = session('watch/live', { start: '2026-10-01T09:00:00.000Z' });
  s.prompt('SECRET-PROMPT-TEXT').assistant({ usage: { input: 3, cacheWrite: 20_000, output: 10 } });
  s.gap('10s')
    .prompt('two')
    .assistant({
      usage: { input: 2, cacheWrite: 1_000, cacheRead: 20_000, output: 10 },
    });
  s.gap('10s')
    .prompt('three')
    .assistant({
      usage: { input: 2, cacheWrite: 3_000, cacheRead: 21_000, output: 10 },
    });
  return s;
}

describe('polling', () => {
  it('re-parses when the transcript grows and only then', async () => {
    const root = join(TMP, `live${n++}`);
    const s = liveSession();
    const { path, rest } = writePartial(root, s, 4); // two turns
    const res = await resolveTarget([root], 'latest');
    if ('error' in res) throw new Error(res.error);
    let t = NOW;
    const w = new Watcher(res.target, res.state, () => t);
    const before = renderWatchFrame(w.state.session!, { width: 80, now: t, homeDir: HOME });
    expect(before).toContain('2 turns');
    expect(await w.poll()).toBe(false);
    appendFileSync(path, rest.join('\n') + '\n');
    t += 2_000;
    expect(await w.poll()).toBe(true);
    const after = renderWatchFrame(w.state.session!, {
      width: 80,
      now: t,
      polledAt: w.polledAt,
      homeDir: HOME,
    });
    expect(after).toContain('3 turns');
    expect(after).toContain('latest turn #3');
    expect(after).not.toBe(before);
    expect(await w.poll()).toBe(false);
  });

  it('picks up a new subagent file under {sessionId}/subagents/', async () => {
    const root = join(TMP, `live${n++}`);
    const s = liveSession();
    writePartial(root, s, 1_000);
    const res = await resolveTarget([root], s.id.slice(0, 8));
    if ('error' in res) throw new Error(res.error);
    const w = new Watcher(res.target, res.state);
    expect(w.state.subagents).toHaveLength(0);
    const a = s
      .agent('z9')
      .prompt('SECRET-PROMPT-TEXT')
      .assistant({
        usage: { input: 1, cacheWrite: 4_000, output: 5 },
      });
    const sub = join(root, a.relPath);
    mkdirSync(dirname(sub), { recursive: true });
    writeFileSync(sub, a.toJsonl());
    expect(await w.poll()).toBe(true);
    expect(w.state.subagents.map((x) => x.agentId)).toEqual(['z9']);
  });

  it('start() polls on a timer and reports changes', async () => {
    const root = join(TMP, `live${n++}`);
    const { path, rest } = writePartial(root, liveSession(), 2);
    const res = await resolveTarget([root], 'latest');
    if ('error' in res) throw new Error(res.error);
    const w = new Watcher(res.target, res.state);
    const ticks: boolean[] = [];
    w.start(20, (changed) => ticks.push(changed));
    try {
      await vi.waitFor(() => expect(ticks.length).toBeGreaterThan(0), { timeout: 2_000 });
      appendFileSync(path, rest.join('\n') + '\n');
      await vi.waitFor(() => expect(w.state.session!.turns).toHaveLength(3), { timeout: 2_000 });
      expect(ticks).toContain(true);
    } finally {
      w.stop();
    }
  });

  it('keeps the last frame with a note when the transcript disappears', async () => {
    const root = join(TMP, `live${n++}`);
    const { path } = writePartial(root, liveSession(), 1_000);
    const res = await resolveTarget([root], 'latest');
    if ('error' in res) throw new Error(res.error);
    const w = new Watcher(res.target, res.state);
    rmSync(path);
    expect(await w.poll()).toBe(false);
    expect(w.note).toContain('gone or unreadable');
    expect(w.state.session!.turns).toHaveLength(3);
  });
});

describe('tknxray watch CLI', () => {
  async function run(argv: string[]): Promise<{ code: number; out: string }> {
    let out = '';
    const code = await watchCommand(argv, (s) => (out += s), {
      isTTY: false,
      env: {},
      columns: () => 100,
      now: () => NOW,
    });
    return { code, out };
  }

  it('--once prints one frame of the latest session and exits 0', async () => {
    const root = tree([liveSession()]);
    const { code, out } = await run(['watch', '--root', root, '--once']);
    expect(code).toBe(0);
    expect(out).toContain('tknxray watch');
    expect(out).toContain('3 turns');
    expect(out).toContain('local only, reads files, sends nothing');
    expect(out).not.toContain('\x1b');
    expect(out).not.toContain('SECRET');
  });

  it('dispatches from main and prints help', async () => {
    let out = '';
    expect(await main(['--help'], (s) => (out += s))).toBe(0);
    expect(out).toContain('tknxray watch [latest|<id|prefix>]');
    const root = tree([liveSession()]);
    out = '';
    // stdout is not a TTY under vitest, so this prints one frame even without --once.
    expect(await main(['watch', '--root', root], (s) => (out += s))).toBe(0);
    expect(out).toContain('3 turns');
  });

  it('--project filters, ids and prefixes resolve, unknown sessions exit 1', async () => {
    const a = liveSession();
    const b = session('other/proj', {
      start: '2026-09-02T09:00:00.000Z',
      project: '-home-dev-proj',
      cwd: '/home/dev/proj',
    })
      .prompt('x')
      .assistant({ usage: { input: 1, cacheWrite: 10_000, output: 1 } });
    const root = tree([a, b]);
    expect((await run(['--root', root, '--project', 'proj'])).out).toContain(b.id.slice(0, 8));
    expect((await run(['--root', root, a.id.slice(0, 6)])).out).toContain(a.id.slice(0, 8));
    const miss = await run(['--root', root, 'ffffffff']);
    expect(miss.code).toBe(1);
    expect(miss.out).toContain('no session matches');
    const none = await run(['--root', join(TMP, 'nothing-here')]);
    expect(none.code).toBe(1);
    expect(none.out).toContain('no sessions with assistant turns found');
  });

  it.each([[['--interval', '0']], [['--interval', 'abc']], [['--bogus']], [['a', 'b']]])(
    'exits 2 on bad args: %j',
    async (argv) => {
      expect((await run(argv)).code).toBe(2);
    },
  );

  it('the built bin prints one frame when stdout is a pipe', () => {
    const root = tree([liveSession()]);
    const bin = join(import.meta.dirname, '..', 'bin', 'tknxray.js');
    const out = execFileSync(process.execPath, [bin, 'watch', '--root', root], {
      encoding: 'utf8',
      env: { ...process.env, COLUMNS: '90', NO_COLOR: '1' },
    });
    expect(out).toContain('one frame (--once or output is not a terminal)');
    for (const line of out.split('\n')) expect(visibleWidth(line)).toBeLessThanOrEqual(90);
  });

  it('in a terminal: alternate screen, raw keys, q quits and restores the screen', async () => {
    const root = tree([liveSession()]);
    const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode: vi.fn() });
    let out = '';
    const resize: (() => void)[] = [];
    const done = watchCommand(['--root', root, '--interval', '0.1'], (s) => (out += s), {
      isTTY: true,
      env: {},
      columns: () => 80,
      rows: () => 50,
      now: () => NOW,
      stdin: stdin as unknown as NodeJS.ReadStream,
      onResize: (cb) => {
        resize.push(cb);
        return () => resize.splice(resize.indexOf(cb), 1);
      },
    });
    await vi.waitFor(() => expect(out).toContain('q or Ctrl-C to quit'));
    expect(out.startsWith('\x1b[?1049h\x1b[?25l')).toBe(true);
    expect(stdin.setRawMode).toHaveBeenCalledWith(true);
    const before = out.length;
    resize[0]!();
    expect(out.length).toBeGreaterThan(before);
    stdin.write('q');
    expect(await done).toBe(0);
    expect(out.endsWith('\x1b[?25h\x1b[?1049l')).toBe(true);
    expect(stdin.setRawMode).toHaveBeenLastCalledWith(false);
    expect(resize).toHaveLength(0);
  });
});
