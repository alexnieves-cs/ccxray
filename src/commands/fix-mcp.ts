// `ccxray fix mcp`: print (and with --apply, write) a permissions.deny diff for MCP tools that
// were never called. Dry run by default; --apply writes a timestamped backup first.
import {
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import type { Finding } from '../model/index.js';
import { planMcpDeny } from '../fix/mcp.js';
import { estimateTokensFromChars } from '../tokens/estimate.js';

export interface FindingsQuery {
  roots?: string[];
  since?: string;
  project?: string;
}

export interface FixMcpDeps {
  /** Source of `tool-usage` findings. Injected by tests; the default runs the analyzer pipeline. */
  loadFindings?: (q: FindingsQuery) => Promise<readonly Finding[]>;
  cwd?: string;
  now?: Date;
}

export const FIX_MCP_HELP = `Usage: ccxray fix mcp [--settings FILE] [--apply] [--per-tool] [--root DIR]... [--since DATE] [--project NAME]

Adds permissions.deny rules for MCP tools that were never called in the analyzed sessions.
Prints a diff and writes nothing unless --apply is given (a timestamped backup is written first).

  --settings FILE  settings file to change (default: .claude/settings.local.json in the current dir;
                   alternatives: .claude/settings.json, ~/.claude/settings.json)
  --apply          write the change
  --per-tool       never use a server-wide rule (mcp__<server>), list each tool instead
`;

// TODO(M2/M4 integration): the analyzers and src/pipeline.ts land in other branches. Once
// merged, replace this with a static `import { buildReport } from '../pipeline.js'` (a dynamic
// import of a variable path resolves relative to dist/cli.js at runtime and would miss the
// bundled module). Assumed call shape: buildReport(query) → Promise<{ findings: Finding[] }>.
async function defaultLoadFindings(q: FindingsQuery): Promise<readonly Finding[]> {
  const spec = '../pipeline.js';
  let mod: { buildReport?: (q: FindingsQuery) => Promise<{ findings: Finding[] }> };
  try {
    mod = (await import(spec)) as typeof mod;
  } catch {
    throw new Error('fix mcp needs the analyzer pipeline, which is not in this build yet');
  }
  if (typeof mod.buildReport !== 'function') throw new Error('pipeline has no buildReport');
  return (await mod.buildReport(q)).findings;
}

function stamp(now: Date): string {
  return now.toISOString().replace(/[:.]/g, '-');
}

export async function fixCommand(
  argv: string[],
  out: (s: string) => void,
  deps: FixMcpDeps = {},
): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      settings: { type: 'string' },
      apply: { type: 'boolean' },
      'per-tool': { type: 'boolean' },
      root: { type: 'string', multiple: true },
      since: { type: 'string' },
      project: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
    allowPositionals: true,
    strict: false,
  });
  const sub = positionals[positionals.indexOf('fix') + 1];
  if (sub !== 'mcp' || values.help) {
    out(FIX_MCP_HELP);
    return sub === 'mcp' ? 0 : 2;
  }
  const cwd = deps.cwd ?? process.cwd();
  const target =
    typeof values.settings === 'string'
      ? resolve(cwd, values.settings)
      : join(cwd, '.claude', 'settings.local.json');
  const rel = relative(cwd, target);
  const shown = rel === '' || rel.startsWith('..') || isAbsolute(rel) ? target : rel;

  const roots = (values.root as unknown[] | undefined)?.filter(
    (r): r is string => typeof r === 'string',
  );
  const findings = await (deps.loadFindings ?? defaultLoadFindings)({
    ...(roots ? { roots } : {}),
    ...(typeof values.since === 'string' ? { since: values.since } : {}),
    ...(typeof values.project === 'string' ? { project: values.project } : {}),
  });

  const before = existsSync(target) ? readFileSync(target, 'utf8') : null;
  let plan;
  try {
    plan = planMcpDeny(findings, before, {
      serverRules: values['per-tool'] !== true,
      label: shown.replace(/\\/g, '/'),
    });
  } catch (err) {
    out(`ccxray fix mcp: ${shown}: ${(err as Error).message}\n`);
    return 2;
  }

  const lines = [`ccxray fix mcp · target ${shown}${before === null ? ' (new file)' : ''}`];
  for (const s of plan.servers) {
    const size =
      s.defChars !== undefined
        ? ` · definitions ${s.defChars.toLocaleString('en-US')} chars ~${estimateTokensFromChars(s.defChars).toLocaleString('en-US')} tokens [E]`
        : ' · definition size unknown';
    const rules = s.rules.length ? `${s.rules.length} rule(s)` : 'already denied';
    lines.push(`  ${s.server}: ${s.unusedTools} never-called tool(s) → ${rules}${size}`);
  }
  for (const s of plan.skipped) lines.push(`  skipped: ${s}`);
  if (plan.added.length === 0) {
    lines.push('Nothing to add: no never-called MCP tools without a deny rule.');
    out(`${lines.join('\n')}\n`);
    return 0;
  }
  lines.push('', plan.diff.trimEnd(), '');
  lines.push(
    'Note: whether a deny rule also removes the tool definition from the context is UNVERIFIED;',
    'measure with `ccxray` before and after. Remove a rule to re-enable a tool.',
  );
  if (values.apply !== true) {
    lines.push(
      'Dry run: nothing was written. Re-run with --apply to write (a backup is made first).',
    );
    out(`${lines.join('\n')}\n`);
    return 0;
  }
  mkdirSync(dirname(target), { recursive: true });
  if (before !== null) {
    const backup = `${target}.ccxray-backup-${stamp(deps.now ?? new Date())}`;
    copyFileSync(target, backup, constants.COPYFILE_EXCL);
    lines.push(`Backup: ${relative(cwd, backup) || backup}`);
  }
  const tmp = `${target}.ccxray-tmp-${process.pid}`;
  writeFileSync(tmp, plan.text);
  renameSync(tmp, target);
  lines.push(`Wrote ${plan.added.length} deny rule(s) to ${shown}.`);
  out(`${lines.join('\n')}\n`);
  return 0;
}
