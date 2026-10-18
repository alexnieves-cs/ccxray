// JSON reporter (`--json`). Shape: schema/report.v1.json. Keys are emitted in a stable order:
// the top-level Report keys in declaration order, every nested object's keys sorted.
import type { Report } from '../model/index.js';
import { displayProject, displayRoot, relFile, resolveHome, shortCommand } from './format.js';

export interface JsonOptions {
  /** Home directory, shown as `~` in roots and project names. Defaults to os.homedir(). */
  homeDir?: string;
}

const TOP_LEVEL_ORDER: (keyof Report)[] = [
  'schemaVersion',
  'tool',
  'generatedAt',
  'window',
  'includeContent',
  'stats',
  'totals',
  'sessions',
  'findings',
  'calibration',
];

/** Longest free-form string kept from Finding.data when content is not included. */
export const MAX_DATA_STRING = 80;

/**
 * Finding.data as shared without --include-content: the keys reporters know (`causes`, `tool`,
 * `command`, see derive.ts) in their known shapes, `command` cut to two words, plus number and
 * boolean scalars and strings up to MAX_DATA_STRING chars. Everything else is dropped.
 */
export function shareableData(data: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) {
    if (k === 'causes' && Array.isArray(v)) {
      out.causes = v
        .filter((c): c is Record<string, unknown> => typeof c === 'object' && c !== null)
        .map((c) => shareableData(c));
    } else if (k === 'command' && typeof v === 'string') out.command = shortCommand(v);
    else if (typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v))) out[k] = v;
    else if (typeof v === 'string' && v.length <= MAX_DATA_STRING) out[k] = v;
  }
  return out;
}

/**
 * The report as it is shared (CLAUDE.md hard rule 4): evidence `source.file` becomes
 * `<project>/<file>.jsonl` relative to the projects root, the home directory is shown as `~` in
 * log roots and project names, and finding data is filtered unless includeContent is true.
 */
export function shareableReport(report: Report, opts: JsonOptions = {}): Report {
  const home = resolveHome(opts.homeDir);
  const roots = report.stats.roots;
  const proj = (p: string) => displayProject(p, home);
  return {
    ...report,
    stats: { ...report.stats, roots: roots.map((r) => displayRoot(r, home)) },
    totals: {
      ...report.totals,
      byProject: Object.fromEntries(
        Object.entries(report.totals.byProject).map(([k, v]) => [proj(k), v]),
      ),
    },
    sessions: report.sessions.map((s) => ({ ...s, project: proj(s.project) })),
    findings: report.findings.map((f) => ({
      ...f,
      ...(f.data && !report.includeContent ? { data: shareableData(f.data) } : {}),
      evidence: f.evidence.map((e) =>
        e.source ? { ...e, source: { ...e.source, file: relFile(e.source.file, roots, home) } } : e,
      ),
    })),
  };
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === 'object' && !(value instanceof Date)) {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(obj).sort()) out[k] = sortKeys(obj[k]);
    return out;
  }
  return value;
}

export function renderJson(report: Report, opts: JsonOptions = {}): string {
  const shared = shareableReport(report, opts) as unknown as Record<string, unknown>;
  const ordered: Record<string, unknown> = {};
  for (const k of TOP_LEVEL_ORDER) if (k in shared) ordered[k] = sortKeys(shared[k]);
  for (const k of Object.keys(shared).sort()) if (!(k in ordered)) ordered[k] = sortKeys(shared[k]);
  return JSON.stringify(ordered, null, 2) + '\n';
}
