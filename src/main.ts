import { parseArgs } from 'node:util';
import { doctor } from './commands/doctor.js';
import { VERSION } from './version.js';

const HELP = `ccxray ${VERSION}: explain where your Claude Code tokens go (local only, no network)

Usage:
  ccxray [--since DATE] [--project NAME] [--json] [--html FILE]
  ccxray session <id|latest>
  ccxray doctor [--root DIR]... [--json]

Options:
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
  out(HELP);
  return 0;
}
