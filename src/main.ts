import { parseArgs } from 'node:util';
import { analyze } from './commands/analyze.js';
import { compareCommand } from './commands/compare.js';
import { captureCommand } from './commands/capture.js';
import { doctor } from './commands/doctor.js';
import { fixCommand } from './commands/fix-mcp.js';
import { sessionCommand } from './commands/session.js';
import { watchCommand } from './commands/watch.js';
import { VERSION } from './version.js';

const HELP = `tknxray ${VERSION}: explain where your Claude Code tokens go (local only, no network)

Usage:
  tknxray [--since DATE] [--until DATE] [--project NAME] [--json] [--html FILE]
          [--include-content] [--threshold.KEY=VALUE]... [--no-color] [--root DIR]...
  tknxray session <id|prefix|latest> [--root DIR]... [--json] [--threshold.KEY=VALUE]...
  tknxray watch [latest|<id|prefix>] [--project NAME] [--root DIR]... [--interval SECONDS]
          [--once] [--no-color]   (live view of one session; q or Ctrl-C quits)
  tknxray compare --at DATE [--days N] | --before A..B --after C..D   (did a change help?)
  tknxray doctor [--root DIR]... [--json]
  tknxray fix mcp [--settings FILE] [--apply]   (preview; see tknxray fix mcp --help)
  tknxray capture --i-understand-this-is-api-key-only   (opt-in; see docs/capture.md)

Options:
  --since DATE    first day to analyze, YYYY-MM-DD UTC (default: 7 days ago)
  --until DATE    last day to analyze, inclusive
  --project NAME  only projects whose dir or cwd contains NAME
  --json          print the JSON report (schema/report.v1.json) to stdout
  --html FILE     write a self-contained HTML report to FILE (overwrites it)
  --include-content  allow prompt/output snippets in reports (off by default)
  --threshold.KEY=VALUE  override an analyzer threshold (see src/model/thresholds.ts)
  --no-color      no ANSI colors
  --root DIR      projects dir to read (repeatable; default: CLAUDE_CONFIG_DIR, ~/.claude)
  -v, --version   print the version
  -h, --help      show this help
`;

export async function main(
  argv: string[],
  out: (s: string) => void = (s) => process.stdout.write(s),
): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      version: { type: 'boolean', short: 'v' },
      help: { type: 'boolean', short: 'h' },
      json: { type: 'boolean' },
      root: { type: 'string', multiple: true },
    },
    allowPositionals: true,
    strict: false,
  });
  if (values.version) {
    out(`${VERSION}\n`);
    return 0;
  }
  // Only argv[0] names a subcommand: in `--project doctor`, `doctor` is a flag value.
  if (argv[0] === 'session' && !values.help) return sessionCommand(argv, out);
  if (argv[0] === 'watch' && !values.help) return watchCommand(argv, out);
  if (argv[0] === 'doctor' && !values.help) {
    const roots = (values.root as unknown[] | undefined)?.filter(
      (r): r is string => typeof r === 'string',
    );
    return doctor({ roots, json: values.json === true }, out);
  }
  if (argv[0] === 'compare') return compareCommand(argv.slice(1), out);
  if (argv[0] === 'fix') return fixCommand(argv, out);
  if (argv[0] === 'capture') return captureCommand(argv, out);
  if (!values.help) return analyze(argv, out);
  out(HELP);
  return 0;
}
