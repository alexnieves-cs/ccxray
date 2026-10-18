// JSON reporter (`--json`). Shape: schema/report.v1.json. Keys are emitted in a stable order:
// the top-level Report keys in declaration order, every nested object's keys sorted.
import type { Report } from '../model/index.js';
import { displayRoot, relFile } from './format.js';

export interface JsonOptions {
  /** Home directory, replaced by `~` in `stats.roots`. */
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

/**
 * The report as it is shared: evidence `source.file` becomes `<project>/<file>.jsonl` relative
 * to the projects root, and log roots show `~` for the home directory (CLAUDE.md hard rule 4).
 */
export function shareableReport(report: Report, opts: JsonOptions = {}): Report {
  const roots = report.stats.roots;
  return {
    ...report,
    stats: { ...report.stats, roots: roots.map((r) => displayRoot(r, opts.homeDir)) },
    findings: report.findings.map((f) => ({
      ...f,
      evidence: f.evidence.map((e) =>
        e.source ? { ...e, source: { ...e.source, file: relFile(e.source.file, roots) } } : e,
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
