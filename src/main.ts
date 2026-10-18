import { parseArgs } from 'node:util';
import { analyze } from './commands/analyze.js';
import { doctor } from './commands/doctor.js';
import { VERSION } from './version.js';

const HELP = `ccxray ${VERSION}: explain where your Claude Code tokens go (local only, no network)

Usage:
  ccxray [--since DATE] [--until DATE] [--project NAME] [--json] [--html FILE]
         [--include-content] [--threshold.KEY=VALUE]... [--no-color] [--root DIR]...
  ccxray session <id|latest>
  ccxray doctor [--root DIR]... [--json]

Options:
  --since DATE    first day to analyze, YYYY-MM-DD UTC (default: 7 days ago)
  --until DATE    last day to analyze, inclusive
  --project NAME  only projects whose dir or cwd contains NAME
  --json          print the JSON report (schema/report.v1.json) to stdout
  --html FILE     write a self-contained HTML report to FILE
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
  const { values, positionals } = parseArgs({
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
  if (positionals[0] === 'doctor' && !values.help) {
    const roots = (values.root as unknown[] | undefined)?.filter(
      (r): r is string => typeof r === 'string',
    );
    return doctor({ roots, json: values.json === true }, out);
  }
  if (!values.help) return analyze(argv, out);
  out(HELP);
  return 0;
}
