// `tknxray compare` (SPEC §3.1): load two windows, build a Report for each, print the comparison.
// Exit codes: 0 success, 1 a window has no sessions (still printed), 2 bad args.
import { parseArgs } from 'node:util';
import { compare, side as sideOf, type Comparison } from '../compare.js';
import { defaultRoots } from '../discover.js';
import { applyThresholdOverrides, DEFAULT_THRESHOLDS, type Thresholds } from '../model/index.js';
import { loadSessions } from '../parser/index.js';
import { buildReport } from '../pipeline.js';
import { renderCompareTerminal } from '../reporters/compare.js';
import { shouldUseColor } from '../reporters/index.js';
import { parseDate, splitThresholds, UsageError, type AnalyzeEnv } from './analyze.js';

const DAY_MS = 86_400_000;

export const COMPARE_HELP = `Usage:
  tknxray compare --at DATE [--days N] [options]
  tknxray compare --before FROM..TO --after FROM..TO [options]

Compares two windows of your logs: rates per turn and per session, cache health, and how much
waste each kind of finding priced. Use it to check a change, e.g. the day you set
CLAUDE_CODE_SUBAGENT_MODEL or started using /clear.

  --at DATE        the day the change took effect: before = the N days up to it, after = it and
                   the N-1 days after (YYYY-MM-DD UTC)
  --days N         days on each side of --at (default 7)
  --before A..B    explicit before window (YYYY-MM-DD..YYYY-MM-DD, inclusive)
  --after A..B     explicit after window
  --project NAME   only projects whose dir or cwd contains NAME
  --json           print the comparison as JSON
  --no-color       no ANSI colors
  --root DIR       projects dir to read (repeatable)
  --threshold.KEY=VALUE  analyzer threshold override, applied to both windows
`;

interface Window {
  since: Date;
  until: Date;
}

function range(s: string, flag: string): Window {
  const m = /^(.+)\.\.(.+)$/.exec(s);
  if (m === null) throw new UsageError(`${flag} expects FROM..TO, got ${s}`);
  const since = parseDate(m[1]!, flag);
  const until = parseDate(m[2]!, flag, true);
  if (until < since) throw new UsageError(`${flag}: ${m[2]} is before ${m[1]}`);
  return { since, until };
}

interface Options {
  before: Window;
  after: Window;
  roots: string[];
  project?: string;
  json: boolean;
  noColor: boolean;
  thresholds: Thresholds;
}

function parse(argv: readonly string[]): Options {
  const { rest, overrides } = splitThresholds(argv);
  let values;
  try {
    ({ values } = parseArgs({
      args: rest,
      options: {
        at: { type: 'string' },
        days: { type: 'string' },
        before: { type: 'string' },
        after: { type: 'string' },
        project: { type: 'string' },
        json: { type: 'boolean' },
        'no-color': { type: 'boolean' },
        root: { type: 'string', multiple: true },
      },
      allowPositionals: false,
      strict: true,
    }));
  } catch (e) {
    throw new UsageError(e instanceof Error ? e.message : String(e));
  }
  let thresholds: Thresholds;
  try {
    thresholds = applyThresholdOverrides(DEFAULT_THRESHOLDS, overrides);
  } catch (e) {
    throw new UsageError(e instanceof Error ? e.message : String(e));
  }
  let before: Window;
  let after: Window;
  if (values.at !== undefined) {
    if (values.before !== undefined || values.after !== undefined)
      throw new UsageError('use --at or --before/--after, not both');
    const days = values.days === undefined ? 7 : Number(values.days);
    if (!Number.isInteger(days) || days < 1 || days > 366)
      throw new UsageError(`--days expects a whole number from 1 to 366, got ${values.days}`);
    const at = parseDate(values.at, '--at');
    if (at.getUTCHours() + at.getUTCMinutes() + at.getUTCSeconds() !== 0)
      throw new UsageError('--at expects a day, YYYY-MM-DD');
    before = { since: new Date(at.getTime() - days * DAY_MS), until: new Date(at.getTime() - 1) };
    after = { since: at, until: new Date(at.getTime() + days * DAY_MS - 1) };
  } else if (values.before !== undefined && values.after !== undefined) {
    if (values.days !== undefined) throw new UsageError('--days goes with --at');
    before = range(values.before, '--before');
    after = range(values.after, '--after');
    if (before.until >= after.since)
      throw new UsageError('the --before window must end before the --after window starts');
  } else {
    throw new UsageError('compare needs --at DATE, or both --before and --after');
  }
  return {
    before,
    after,
    roots: values.root ?? defaultRoots(),
    project: values.project,
    json: values.json === true,
    noColor: values['no-color'] === true,
    thresholds,
  };
}

export async function compareCommand(
  argv: readonly string[],
  out: (s: string) => void,
  e: AnalyzeEnv = {},
): Promise<number> {
  const err = e.err ?? ((s: string) => void process.stderr.write(s));
  if (argv.includes('--help') || argv.includes('-h')) {
    out(COMPARE_HELP);
    return 0;
  }
  let o: Options;
  try {
    o = parse(argv);
  } catch (x) {
    if (!(x instanceof UsageError)) throw x;
    err(`tknxray compare: ${x.message}\nRun \`tknxray compare --help\` for usage.\n`);
    return 2;
  }
  const now = e.now ?? new Date();
  const side = async (w: Window) => {
    const { sessions, stats } = await loadSessions({
      roots: o.roots,
      since: w.since,
      until: w.until,
      project: o.project,
      includeContent: false,
    });
    const report = buildReport({
      sessions,
      stats,
      ctx: { thresholds: o.thresholds, now, includeContent: false },
      window: {
        since: w.since.toISOString(),
        until: w.until.toISOString(),
        project: o.project ?? null,
      },
      includeContent: false,
    });
    return { side: sideOf(report, sessions), found: sessions.length > 0 };
  };
  // One window at a time: the first is released before the second loads (peak RSS, SPEC §8).
  const b = await side(o.before);
  const a = await side(o.after);
  const c: Comparison = compare(b.side, a.side);
  if (o.json) out(JSON.stringify(c, null, 2) + '\n');
  else {
    const color =
      !o.noColor && shouldUseColor(e.env ?? process.env, e.isTTY ?? process.stdout.isTTY);
    out(renderCompareTerminal(c, color));
  }
  return b.found && a.found ? 0 : 1;
}
