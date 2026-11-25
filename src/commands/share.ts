// `tknxray share` (SPEC §3.2): write a report a volunteer can share without sending transcripts
// (schema/share.v1.json), and print, on this machine only, the finding titles behind each number
// so the volunteer can mark each finding real or a false positive before sharing.
// Exit codes: 0 written, 1 no sessions (nothing written), 2 bad args or the file cannot be written.
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { defaultRoots } from '../discover.js';
import { applyThresholdOverrides, DEFAULT_THRESHOLDS, type Thresholds } from '../model/index.js';
import { loadSessions } from '../parser/index.js';
import { buildReport } from '../pipeline.js';
import { localSessionLabel, makeHasher, renderShare, shareReport } from '../reporters/share.js';
import {
  defaultSince,
  parseDate,
  splitThresholds,
  UsageError,
  type AnalyzeEnv,
} from './analyze.js';

export const DEFAULT_SHARE_FILE = 'tknxray-share.json';

export const SHARE_HELP = `Usage:
  tknxray share [--since DATE] [--until DATE] [--project NAME] [--out FILE] [--force]
                [--root DIR]... [--threshold.KEY=VALUE]...

Writes a report you can share to help check tknxray's findings, without sending transcripts:
numbers, analyzer ids, built-in tool names, claude-* model ids and Claude Code versions only.
No prompts, outputs, file paths, commands, project names, finding titles or session ids (those
are salted hashes, and the salt is not saved). Nothing is sent anywhere; you choose whether to
share the file.

The finding titles are printed here, on your machine, so you can check each one. Then set each
finding's "review.verdict" in the file to "real", "false-positive" or "unsure" (a "note" helps).

  --since DATE    first day to analyze, YYYY-MM-DD UTC (default: 7 days ago)
  --until DATE    last day to analyze, inclusive
  --project NAME  only projects whose dir or cwd contains NAME (the name is not written)
  --out FILE      where to write it (default: ${DEFAULT_SHARE_FILE})
  --force         overwrite FILE if it exists (by default an existing file, maybe one you
                  already reviewed, is left alone)
  --root DIR      projects dir to read (repeatable)
  --threshold.KEY=VALUE  analyzer threshold override
`;

interface Options {
  roots: string[];
  since: Date;
  until?: Date;
  window: { since: string; until: string | null; project: string | null };
  project?: string;
  out: string;
  force: boolean;
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
        out: { type: 'string' },
        force: { type: 'boolean' },
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
  const since = values.since !== undefined ? parseDate(values.since, '--since') : defaultSince(now);
  const until = values.until !== undefined ? parseDate(values.until, '--until', true) : undefined;
  if (until !== undefined && until < since) throw new UsageError('--until is before --since');
  if (values.out === '') throw new UsageError('--out needs a file path');
  return {
    roots: values.root ?? defaultRoots(),
    since,
    until,
    window: {
      since: since.toISOString(),
      until: until?.toISOString() ?? null,
      project: values.project ?? null,
    },
    project: values.project,
    out: values.out ?? DEFAULT_SHARE_FILE,
    force: values.force === true,
    thresholds,
  };
}

export async function shareCommand(
  argv: readonly string[],
  out: (s: string) => void,
  e: AnalyzeEnv = {},
): Promise<number> {
  const err = e.err ?? ((s: string) => void process.stderr.write(s));
  const now = e.now ?? new Date();
  if (argv.includes('--help') || argv.includes('-h')) {
    out(SHARE_HELP);
    return 0;
  }
  let o: Options;
  try {
    o = parse(argv, now);
  } catch (x) {
    if (!(x instanceof UsageError)) throw x;
    err(`tknxray share: ${x.message}\nRun \`tknxray share --help\` for usage.\n`);
    return 2;
  }
  const { sessions, stats } = await loadSessions({
    roots: o.roots,
    since: o.since,
    until: o.until,
    project: o.project,
    includeContent: false,
  });
  if (sessions.length === 0) {
    out('No Claude Code sessions in that window, so no file was written.\n');
    return 1;
  }
  const report = buildReport({
    sessions,
    stats,
    ctx: { thresholds: o.thresholds, now, includeContent: false },
    window: o.window,
    includeContent: false,
  });
  const hash = makeHasher();
  const share = shareReport(report, { hash, now });
  const path = resolve(o.out);
  try {
    writeFileSync(path, renderShare(share), { flag: o.force ? 'w' : 'wx' });
  } catch (x) {
    const code = (x as NodeJS.ErrnoException).code;
    err(
      code === 'EEXIST'
        ? `tknxray share: ${path} already exists; pass --force to overwrite it.\n`
        : `tknxray share: could not write ${path}: ${x instanceof Error ? x.message : String(x)}\n`,
    );
    return 2;
  }
  const lines = [
    `wrote ${path}`,
    `${share.findings.length} findings from ${share.sessions.count} sessions; ` +
      `no prompts, outputs, paths, commands, project names, titles or session ids.`,
    '',
  ];
  if (report.findings.length > 0) {
    lines.push(
      'Before you share it, check each finding below. In the file, set its "review.verdict" to',
      '"real", "false-positive" or "unsure" (a "note" helps). This list stays on your machine;',
      'run `tknxray session <id>` to see one session turn by turn.',
      '',
    );
    report.findings.forEach((f, i) => {
      const ids = [...new Set(f.evidence.map((x) => x.sessionId))];
      const shown = ids
        .slice(0, 3)
        .map((id) => `${localSessionLabel(id)} (${hash(id)} in the file)`)
        .join(', ');
      const more = ids.length > 3 ? `, +${ids.length - 3} more` : '';
      lines.push(`${i + 1}. [${f.severity}] ${f.analyzer}: ${f.title}`);
      if (ids.length > 0) lines.push(`   sessions: ${shown}${more}`);
    });
    lines.push('');
  }
  out(lines.join('\n'));
  return 0;
}
