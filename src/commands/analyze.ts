// Default command (SPEC §3): load sessions, run the pipeline, render terminal / JSON / HTML.
// Exit codes: 0 success, 1 no sessions found (the empty state is still printed), 2 bad args or
// an --html file that cannot be written (with its own message).
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { defaultRoots } from '../discover.js';
import { applyThresholdOverrides, DEFAULT_THRESHOLDS, type Thresholds } from '../model/index.js';
import { loadSessions } from '../parser/index.js';
import { buildReport } from '../pipeline.js';
import { render, shouldUseColor } from '../reporters/index.js';

export interface AnalyzeEnv {
  now?: Date;
  err?: (s: string) => void;
  env?: Record<string, string | undefined>;
  isTTY?: boolean;
}

const DAY_MS = 86_400_000;
const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
// ISO 8601 date-time: YYYY-MM-DDTHH:MM[:SS[.sss]] with an optional Z or ±HH:MM offset.
const DATE_TIME =
  /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d)(?:\.\d{1,3})?)?(Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)?$/;

class UsageError extends Error {}

/** true when y-m-d is a real calendar day (2026-02-30 is not). */
function realDay(y: string, m: string, d: string): boolean {
  const t = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
  return (
    t.getUTCFullYear() === Number(y) &&
    t.getUTCMonth() === Number(m) - 1 &&
    t.getUTCDate() === Number(d)
  );
}

/**
 * `YYYY-MM-DD` (a UTC day; `until` is inclusive, so it means the end of that day) or an ISO
 * date-time. A date-time without an offset is taken as UTC (`Z` is appended), never local time,
 * so results do not depend on the machine's time zone. Anything else is a usage error.
 */
export function parseDate(s: string, flag: string, endOfDay = false): Date {
  const bad = (): never => {
    throw new UsageError(`${flag} expects YYYY-MM-DD or an ISO date-time, got ${s}`);
  };
  const day = DATE_ONLY.exec(s);
  if (day !== null) {
    if (!realDay(day[1]!, day[2]!, day[3]!)) bad();
    const d = new Date(`${s}T00:00:00.000Z`);
    return endOfDay ? new Date(d.getTime() + DAY_MS - 1) : d;
  }
  const dt = DATE_TIME.exec(s);
  if (dt === null || !realDay(dt[1]!, dt[2]!, dt[3]!)) return bad();
  const d = new Date(dt[7] === undefined ? `${s}Z` : s);
  return Number.isNaN(d.getTime()) ? bad() : d;
}

/** Pull `--threshold.<key>=<value>` / `--threshold.<key> <value>` out of argv. */
export function splitThresholds(argv: readonly string[]): {
  rest: string[];
  overrides: Record<string, string>;
} {
  const rest: string[] = [];
  // No prototype: a `__proto__` key must arrive as an ordinary (and then unknown) key.
  const overrides = Object.create(null) as Record<string, string>;
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]!;
    const m = /^--threshold\.([^=]*)(?:=(.*))?$/s.exec(flag);
    if (m === null) {
      rest.push(flag);
      continue;
    }
    const value = m[2] ?? argv[++i];
    if (!m[1] || value === undefined) throw new UsageError(`${flag} needs a key and a value`);
    overrides[m[1]] = value;
  }
  return { rest, overrides };
}

interface Options {
  roots: string[];
  since: Date;
  until?: Date;
  window: { since: string; until: string | null; project: string | null };
  project?: string;
  json: boolean;
  html?: string;
  includeContent: boolean;
  noColor: boolean;
  thresholds: Thresholds;
}

function parse(argv: readonly string[], now: Date): Options {
  const { rest, overrides } = splitThresholds(argv);
  let values;
  try {
    ({ values } = parseArgs({
      args: rest,
      options: {
        since: { type: 'string' },
        until: { type: 'string' },
        project: { type: 'string' },
        json: { type: 'boolean' },
        html: { type: 'string' },
        'include-content': { type: 'boolean' },
        root: { type: 'string', multiple: true },
        'no-color': { type: 'boolean' },
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
  const since =
    values.since !== undefined
      ? parseDate(values.since, '--since')
      : new Date(now.getTime() - 7 * DAY_MS);
  const until = values.until !== undefined ? parseDate(values.until, '--until', true) : undefined;
  if (until !== undefined && until < since) throw new UsageError('--until is before --since');
  if (values.html === '') throw new UsageError('--html needs a file path');
  return {
    roots: values.root ?? defaultRoots(),
    since,
    until,
    window: {
      since: values.since ?? since.toISOString(),
      until: values.until ?? null,
      project: values.project ?? null,
    },
    project: values.project,
    json: values.json === true,
    html: values.html,
    includeContent: values['include-content'] === true,
    noColor: values['no-color'] === true,
    thresholds,
  };
}

export async function analyze(
  argv: readonly string[],
  out: (s: string) => void,
  e: AnalyzeEnv = {},
): Promise<number> {
  const err = e.err ?? ((s: string) => void process.stderr.write(s));
  const now = e.now ?? new Date();
  let o: Options;
  try {
    o = parse(argv, now);
  } catch (x) {
    if (!(x instanceof UsageError)) throw x;
    err(`ccxray: ${x.message}\nRun \`ccxray --help\` for usage.\n`);
    return 2;
  }
  const { sessions, stats } = await loadSessions({
    roots: o.roots,
    since: o.since,
    until: o.until,
    project: o.project,
    includeContent: o.includeContent,
  });
  const report = buildReport({
    sessions,
    stats,
    ctx: { thresholds: o.thresholds, now, includeContent: o.includeContent },
    window: o.window,
    includeContent: o.includeContent,
  });
  const code = sessions.length > 0 ? 0 : 1;
  // JSON first, so a failed HTML write still leaves the JSON on stdout.
  if (o.json) out(render(report, 'json'));
  if (o.html !== undefined) {
    // Overwrites an existing file at that path (documented in --help).
    const path = resolve(o.html);
    try {
      writeFileSync(path, render(report, 'html'));
    } catch (x) {
      err(
        `ccxray: could not write the HTML report to ${path}: ` +
          `${x instanceof Error ? x.message : String(x)}\n`,
      );
      return 2;
    }
    // stdout stays pure JSON when --json is also given.
    (o.json ? err : out)(`wrote ${path}\n`);
  } else if (!o.json) {
    const color =
      !o.noColor && shouldUseColor(e.env ?? process.env, e.isTTY ?? process.stdout.isTTY);
    out(render(report, 'terminal', { color }));
  }
  return code;
}
