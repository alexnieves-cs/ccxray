import { parseArgs } from 'node:util';
import { VERSION } from './version.js';

const HELP = `ccxray ${VERSION}: explain where your Claude Code tokens go (local only, no network)

Usage:
  ccxray [--since DATE] [--project NAME] [--json] [--html FILE]
  ccxray session <id|latest>
  ccxray doctor

Options:
  -v, --version   print the version
  -h, --help      show this help
`;

export function main(
  argv: string[],
  out: (s: string) => void = (s) => process.stdout.write(s),
): number {
  const { values } = parseArgs({
    args: argv,
    options: {
      version: { type: 'boolean', short: 'v' },
      help: { type: 'boolean', short: 'h' },
    },
    allowPositionals: true,
    strict: false,
  });
  if (values.version) {
    out(`${VERSION}\n`);
    return 0;
  }
  out(HELP);
  return 0;
}
