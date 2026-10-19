// Reporter-side views derived from a Report. Shared by terminal and HTML so both show the same
// numbers. Finding.data is analyzer-specific and untyped, so it is read defensively: a field
// that is missing or has the wrong shape is ignored, never guessed (CLAUDE.md hard rule 3).
//
// Finding.data conventions (PROVISIONAL inter-stream contract between analyzers and reporters,
// also in docs/SPEC.md §4.1; may change until M4):
//   causes?:  { cause: string; count: number; tokens?: number; tokensKind?: TokenKind;
//               fix?: string }[]
//             per-cause breakdown, e.g. for cache-rebuild (A2/A3). `tokens` has `tokensKind`
//             when given (A3 marks its split 'estimated': the cause is a guess), else the
//             finding's kind.
//   tool?:    string   tool name, e.g. `Bash`; groups WHERE IT WENT by tool.
//   command?: string   raw Bash command; reporters only ever show shortCommand() of it.
// Any other key: numbers and booleans are kept; strings are kept in JSON only when short
// (see json.ts); nothing else is rendered.
import type { Finding, Report, Severity, TokenKind } from '../model/index.js';
import { shortCommand } from './format.js';

function finiteOr(n: number, fallback: number): number {
  return Number.isFinite(n) ? n : fallback;
}

const SEVERITY_RANK: Record<Severity, number> = { high: 0, warn: 1, info: 2 };

/** savingsUsd of a finding, when it has a positive, finite one. */
export function savingsOf(f: Finding): number | undefined {
  const v = f.impact?.savingsUsd;
  return isFiniteNumber(v) && v > 0 ? v : undefined;
}

/**
 * Cost impact first (SPEC §5.2): findings with $ savings, largest first. Then the rest (unpriced
 * models, or nothing to save): severity (high → info), then tokens descending. Analyzer and title
 * break ties for stability.
 */
export function sortFindings(findings: readonly Finding[]): Finding[] {
  return [...findings].sort(
    (a, b) =>
      (savingsOf(a) === undefined ? 1 : 0) - (savingsOf(b) === undefined ? 1 : 0) ||
      (savingsOf(b) ?? 0) - (savingsOf(a) ?? 0) ||
      (SEVERITY_RANK[a.severity] ?? 3) - (SEVERITY_RANK[b.severity] ?? 3) ||
      finiteOr(b.tokens.value, -1) - finiteOr(a.tokens.value, -1) ||
      a.analyzer.localeCompare(b.analyzer, 'en') ||
      a.title.localeCompare(b.title, 'en'),
  );
}

export function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

export interface CauseRow {
  cause: string;
  count: number;
  tokens?: number;
  /** Kind of `tokens`; undefined means the finding's kind. */
  tokensKind?: TokenKind;
  fix?: string;
}

/** Cause breakdown of a finding, from `data.causes` (provisional contract, see the top). */
export function causeRows(f: Finding): CauseRow[] {
  const raw = f.data?.causes;
  if (!Array.isArray(raw)) return [];
  const rows: CauseRow[] = [];
  for (const c of raw as unknown[]) {
    if (typeof c !== 'object' || c === null) continue;
    const o = c as Record<string, unknown>;
    if (typeof o.cause !== 'string' || !isFiniteNumber(o.count)) continue;
    rows.push({
      cause: o.cause,
      count: o.count,
      ...(isFiniteNumber(o.tokens) ? { tokens: o.tokens } : {}),
      ...(o.tokensKind === 'measured' || o.tokensKind === 'estimated'
        ? { tokensKind: o.tokensKind }
        : {}),
      ...(typeof o.fix === 'string' ? { fix: o.fix } : {}),
    });
  }
  return rows.sort((a, b) => b.count - a.count);
}

/** `data.command`, shortened to its first two tokens (SPEC §9), when the finding has one. */
export function findingCommand(f: Finding): string | undefined {
  const cmd = f.data?.command;
  return typeof cmd === 'string' && cmd.trim() ? shortCommand(cmd) : undefined;
}

export interface AttributionRow {
  analyzer: string;
  tokens: number;
  findings: number;
  /** Share of `tokens` per `data.tool`, largest first. */
  byTool: { tool: string; share: number }[];
}

/**
 * WHERE IT WENT: estimated tokens summed per analyzer, from findings whose tokens are
 * estimated. Empty when no finding provides an estimate.
 */
export function attribution(findings: readonly Finding[]): AttributionRow[] {
  const groups = new Map<
    string,
    { tokens: number; findings: number; tools: Map<string, number> }
  >();
  for (const f of findings) {
    if (f.tokens.kind !== 'estimated' || !(Number.isFinite(f.tokens.value) && f.tokens.value > 0)) {
      continue;
    }
    const g = groups.get(f.analyzer) ?? { tokens: 0, findings: 0, tools: new Map() };
    g.tokens += f.tokens.value;
    g.findings += 1;
    const tool = f.data?.tool;
    if (typeof tool === 'string') g.tools.set(tool, (g.tools.get(tool) ?? 0) + f.tokens.value);
    groups.set(f.analyzer, g);
  }
  return [...groups.entries()]
    .map(([analyzer, g]) => ({
      analyzer,
      tokens: g.tokens,
      findings: g.findings,
      byTool: [...g.tools.entries()]
        .map(([tool, t]) => ({ tool, share: t / g.tokens }))
        .sort((a, b) => b.share - a.share || a.tool.localeCompare(b.tool, 'en')),
    }))
    .sort((a, b) => b.tokens - a.tokens || a.analyzer.localeCompare(b.analyzer, 'en'));
}

/** `cache-rebuild` → `CACHE REBUILD`. */
export function analyzerHeading(id: string): string {
  return id.replace(/[-_]+/g, ' ').toUpperCase();
}

/** Earliest firstTs and latest lastTs across sessions, or null when there are none. */
export function dateSpan(report: Report): { from: string; to: string } | null {
  if (report.sessions.length === 0) return null;
  const firsts = report.sessions.map((s) => s.firstTs).sort();
  const lasts = report.sessions.map((s) => s.lastTs).sort();
  return { from: firsts[0] as string, to: lasts[lasts.length - 1] as string };
}

/** Every Claude Code version seen, from parse stats plus session summaries. */
export function allVersions(report: Report): string[] {
  return [
    ...new Set([
      ...Object.keys(report.stats.ccVersions),
      ...report.sessions.flatMap((s) => s.ccVersions),
    ]),
  ];
}

/** Short parse-warning phrases (malformed lines, unknown record types, field oddities). */
export function parseWarnings(report: Report): string[] {
  const s = report.stats;
  const out: string[] = [];
  if (s.malformedLines > 0) out.push(`${s.malformedLines} malformed lines skipped`);
  const unknown = Object.entries(s.unknownRecordTypes).sort((a, b) => b[1] - a[1]);
  if (unknown.length > 0) {
    const list = unknown.map(([t, n]) => `${t} ×${n}`).join(', ');
    out.push(`${unknown.length} unknown record type${unknown.length === 1 ? '' : 's'} (${list})`);
  }
  const warned = Object.values(s.warnings).reduce((a, b) => a + b, 0);
  if (warned > 0) out.push(`${warned} field warnings`);
  return out;
}
