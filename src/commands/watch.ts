// `tknxray watch [latest|<id|prefix>]`: a live, full-screen view of one session (SPEC §3).
// The frame is rendered by src/reporters/watch.ts (pure); this file is the I/O loop: pick the
// session, poll its files with fs.stat (size + mtime, not fs.watch, for portability), re-parse on
// change and redraw. Reads files only and sends nothing anywhere (CLAUDE.md rules 1 and 5).

import { basename } from 'node:path';
import { parseArgs } from 'node:util';
import { defaultRoots, discover, discoverSession, fileStem, type Discovery } from '../discover.js';
import { DEFAULT_THRESHOLDS, type Session } from '../model/index.js';
import { loadSessionFiles } from '../parser/index.js';
import { shouldUseColor } from '../reporters/format.js';
import { renderWatchFrame } from '../reporters/watch.js';
import { resolveSession } from './session.js';

const USAGE =
  'Usage: tknxray watch [latest|<id|prefix>] [--project NAME] [--root DIR]... ' +
  '[--interval SECONDS] [--once] [--no-color]\n';
const MIN_INTERVAL_S = 0.1;

/** What `watch` follows: one main transcript and its `{sessionId}/` dir (subagents). */
export interface WatchTarget {
  root: string;
  mainPath: string;
  dirNames: string[];
}

export interface WatchState {
  session?: Session;
  subagents: Session[];
  /** size + mtime of every file, to skip re-parsing when nothing changed. */
  fingerprint: string;
}

const fingerprint = (d: Discovery): string =>
  d.files.map((f) => `${f.path}\0${f.size}\0${f.mtimeMs}`).join('\n');

const matchesProject = (s: Session, needle: string | undefined): boolean =>
  needle === undefined ||
  s.project.toLowerCase().includes(needle) ||
  (s.cwd ?? '').toLowerCase().includes(needle);

/** Parse the target's files; the main session is the one read from `mainPath`. */
export async function loadTarget(t: WatchTarget, found?: Discovery): Promise<WatchState> {
  const d = found ?? (await discoverSession(t.root, t.mainPath, t.dirNames));
  const { sessions } = await loadSessionFiles(d);
  const session =
    sessions.find((s) => !s.isSubagent && s.files.includes(t.mainPath)) ??
    sessions.find((s) => s.files.includes(t.mainPath));
  const subagents =
    session === undefined || session.isSubagent
      ? []
      : sessions
          .filter((s) => s.isSubagent && s.parentSessionId === session.id)
          .sort((a, b) => a.firstTs - b.firstTs || (a.id < b.id ? -1 : 1));
  return { session, subagents, fingerprint: fingerprint(d) };
}

const targetOf = (s: Session, f: { root: string; path: string }): WatchTarget => ({
  root: f.root,
  mainPath: f.path,
  dirNames: [...new Set([s.id, basename(f.path, '.jsonl')])],
});

/**
 * `latest`: the most recently modified main transcript (by layout) whose session has at least
 * one assistant turn and matches `project`. Otherwise the `session` command's rules: a full id
 * or a unique prefix of ≥ 4 characters.
 */
export async function resolveTarget(
  roots: readonly string[],
  query: string,
  project?: string,
): Promise<{ target: WatchTarget; state: WatchState } | { error: string }> {
  const found = await discover([...roots]);
  const needle = project?.toLowerCase();
  if (query === 'latest') {
    const mains = found.files
      .filter((f) => f.subagentOf === undefined)
      .sort((a, b) => b.mtimeMs - a.mtimeMs || (a.path < b.path ? -1 : 1));
    for (const f of mains) {
      const guess: WatchTarget = { root: f.root, mainPath: f.path, dirNames: [fileStem(f)] };
      const state = await loadTarget(guess);
      const s = state.session;
      if (s === undefined || s.isSubagent || s.turns.length === 0 || !matchesProject(s, needle))
        continue;
      const target = targetOf(s, f);
      const same = target.dirNames.join('\0') === guess.dirNames.join('\0');
      return { target, state: same ? state : await loadTarget(target) };
    }
    return {
      error:
        'no sessions with assistant turns found' +
        (project !== undefined ? ` for project "${project}"` : ''),
    };
  }
  const { sessions } = await loadSessionFiles(found);
  const found1 = resolveSession(
    sessions.filter((s) => matchesProject(s, needle)),
    query,
  );
  if ('error' in found1) return found1;
  const s = found1.session;
  const file = found.files.find((f) => s.files.includes(f.path) && f.subagentOf === undefined);
  if (file === undefined) return { error: `session ${s.id} has no main transcript to watch` };
  const target = targetOf(s, file);
  return { target, state: await loadTarget(target) };
}

/** Polls a target; `poll()` re-parses only when a file's size or mtime changed. */
export class Watcher {
  state: WatchState;
  polledAt = 0;
  note: string | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;

  constructor(
    readonly target: WatchTarget,
    initial: WatchState,
    private readonly now: () => number = Date.now,
  ) {
    this.state = initial;
    this.polledAt = now();
  }

  /** One poll. Returns true when the files changed and were re-parsed. Never throws. */
  async poll(): Promise<boolean> {
    try {
      const d = await discoverSession(this.target.root, this.target.mainPath, this.target.dirNames);
      this.polledAt = this.now();
      if (!d.files.some((f) => f.path === this.target.mainPath)) {
        this.note = 'the transcript file is gone or unreadable; showing the last read';
        return false;
      }
      this.note = undefined;
      const fp = fingerprint(d);
      if (fp === this.state.fingerprint) return false;
      const next = await loadTarget(this.target, d);
      if (next.session === undefined) {
        this.note = 'could not read the session from its transcript; showing the last read';
        return false;
      }
      this.state = next;
      return true;
    } catch (e) {
      this.note = `poll failed: ${e instanceof Error ? e.message : String(e)}`;
      return false;
    }
  }

  /** Poll every `intervalMs` (no overlapping polls) and call `onTick` after each one. */
  start(intervalMs: number, onTick: (changed: boolean) => void): void {
    const tick = async (): Promise<void> => {
      if (this.stopped) return;
      const changed = await this.poll();
      if (this.stopped) return;
      onTick(changed);
      this.timer = setTimeout(() => void tick(), intervalMs);
    };
    this.timer = setTimeout(() => void tick(), intervalMs);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== undefined) clearTimeout(this.timer);
  }
}

export interface WatchIO {
  env: Record<string, string | undefined>;
  /** stdout is a terminal: draw full-screen and poll; otherwise print one frame. */
  isTTY: boolean;
  columns: () => number | undefined;
  rows: () => number | undefined;
  now: () => number;
  stdin?: NodeJS.ReadStream;
  /** Subscribe to terminal resizes; returns an unsubscribe function. */
  onResize: (cb: () => void) => () => void;
}

const envColumns = (v: string | undefined): number | undefined => {
  const n = Number(v);
  return v !== undefined && Number.isInteger(n) && n > 0 ? n : undefined;
};

const defaultIO = (): WatchIO => ({
  env: process.env,
  isTTY: process.stdout.isTTY === true,
  // Not a terminal (piped --once): honor COLUMNS, else the renderer's default of 100.
  columns: () => process.stdout.columns ?? envColumns(process.env.COLUMNS),
  rows: () => process.stdout.rows,
  now: Date.now,
  stdin: process.stdin,
  onResize: (cb) => {
    process.stdout.on('resize', cb);
    process.on('SIGWINCH', cb);
    return () => {
      process.stdout.off('resize', cb);
      process.off('SIGWINCH', cb);
    };
  },
});

// Alternate screen buffer + hidden cursor, and their inverses.
const ENTER = '\x1b[?1049h\x1b[?25l';
const LEAVE = '\x1b[?25h\x1b[?1049l';

/** A frame drawn over the previous one: home, each line cleared to its end, rest cleared. */
export function screen(frame: string, rows: number | undefined): string {
  let lines = frame.replace(/\n$/, '').split('\n');
  if (rows !== undefined && rows > 1 && lines.length > rows)
    lines = [...lines.slice(0, rows - 1), lines[lines.length - 1]!];
  return `\x1b[H${lines.join('\x1b[K\r\n')}\x1b[K\x1b[J`;
}

export async function watchCommand(
  argv: readonly string[],
  out: (s: string) => void,
  io: Partial<WatchIO> = {},
): Promise<number> {
  const env: WatchIO = { ...defaultIO(), ...io };
  let values: {
    root?: string[];
    project?: string;
    interval?: string;
    once?: boolean;
    'no-color'?: boolean;
  };
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({
      args: [...argv],
      options: {
        root: { type: 'string', multiple: true },
        project: { type: 'string' },
        interval: { type: 'string' },
        once: { type: 'boolean' },
        'no-color': { type: 'boolean' },
      },
      allowPositionals: true,
    }));
  } catch (e) {
    out(`tknxray watch: ${e instanceof Error ? e.message : String(e)}\n${USAGE}`);
    return 2;
  }
  const args = positionals[0] === 'watch' ? positionals.slice(1) : positionals;
  if (args.length > 1) {
    out(USAGE);
    return 2;
  }
  const intervalS = values.interval === undefined ? 2 : Number(values.interval);
  if (!Number.isFinite(intervalS) || intervalS < MIN_INTERVAL_S) {
    out(`tknxray watch: --interval must be a number of seconds ≥ ${MIN_INTERVAL_S}\n${USAGE}`);
    return 2;
  }
  const roots = values.root ?? defaultRoots();
  const res = await resolveTarget(roots, args[0] ?? 'latest', values.project);
  if ('error' in res) {
    out(`tknxray watch: ${res.error}\n`);
    return 1;
  }
  if (res.state.session === undefined) {
    out('tknxray watch: could not read the session\n');
    return 1;
  }
  const color = values['no-color'] !== true && shouldUseColor(env.env, env.isTTY);
  const watcher = new Watcher(res.target, res.state, env.now);
  const frame = (mode: 'live' | 'once'): string =>
    renderWatchFrame(watcher.state.session!, {
      width: env.columns() ?? 100,
      now: env.now(),
      polledAt: watcher.polledAt,
      subagents: watcher.state.subagents,
      thresholds: DEFAULT_THRESHOLDS,
      color,
      mode,
      ...(watcher.note !== undefined ? { note: watcher.note } : {}),
    });

  if (values.once === true || !env.isTTY) {
    out(frame('once'));
    return 0;
  }
  return new Promise<number>((done) => {
    const stdin = env.stdin;
    const raw = stdin?.isTTY === true;
    const draw = (): void => out(screen(frame('live'), env.rows()));
    let finished = false;
    const quit = (): void => {
      if (finished) return;
      finished = true;
      watcher.stop();
      offResize();
      process.off('SIGINT', quit);
      process.off('SIGTERM', quit);
      process.off('exit', restore);
      if (stdin !== undefined && raw) {
        stdin.off('data', onKey);
        stdin.setRawMode(false);
        stdin.pause();
      }
      restore();
      done(0);
    };
    const restore = (): void => out(LEAVE);
    const onKey = (b: Buffer): void => {
      const k = b.toString('utf8');
      if (k === 'q' || k === 'Q' || k === '\x03') quit();
    };
    out(ENTER);
    process.on('exit', restore);
    process.on('SIGINT', quit);
    process.on('SIGTERM', quit);
    const offResize = env.onResize(draw);
    if (stdin !== undefined && raw) {
      stdin.setRawMode(true);
      stdin.resume();
      stdin.on('data', onKey);
    }
    draw();
    watcher.start(intervalS * 1000, draw);
  });
}
