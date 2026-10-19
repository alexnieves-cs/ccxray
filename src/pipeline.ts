// sessions → Report (SPEC §4 data flow): analyzers, A1 totals, session summaries, calibration.
// Pure: no I/O. The CLI loads sessions and renders the report.
import { ANALYZERS } from './analyzers/index.js';
import { computeTotals } from './analyzers/totals.js';
import type {
  Analyzer,
  AnalyzerContext,
  Finding,
  ParseStats,
  Report,
  Session,
  SessionSummary,
} from './model/index.js';
import { sortFindings } from './reporters/derive.js';
import { calibrate } from './tokens/calibrate.js';
import { VERSION } from './version.js';

export interface BuildReportInput {
  sessions: readonly Session[];
  stats: ParseStats;
  ctx: AnalyzerContext;
  window: Report['window'];
  includeContent: boolean;
  /** Defaults to the registry in src/analyzers/index.ts. */
  analyzers?: readonly Analyzer[];
}

function summary(s: Session, totals: Report['totals']): SessionSummary {
  return {
    id: s.id,
    project: s.project,
    isSubagent: s.isSubagent,
    firstTs: new Date(s.firstTs).toISOString(),
    lastTs: new Date(s.lastTs).toISOString(),
    turns: s.turns.length,
    ccVersions: [...s.ccVersions],
    models: [...new Set(s.turns.filter((t) => !t.isSynthetic).map((t) => t.model))],
    totals: totals.bySession[s.id]!,
  };
}

export function buildReport(input: BuildReportInput): Report {
  const { sessions, stats, ctx } = input;
  const findings: Finding[] = [];
  for (const a of input.analyzers ?? ANALYZERS) findings.push(...a.run(sessions, ctx));
  const totals = computeTotals(sessions);
  return {
    schemaVersion: 1,
    tool: { name: 'ccxray', version: VERSION },
    generatedAt: ctx.now.toISOString(),
    window: input.window,
    includeContent: input.includeContent,
    stats,
    totals,
    sessions: [...sessions]
      .sort((a, b) => a.firstTs - b.firstTs || (a.id < b.id ? -1 : 1))
      .map((s) => summary(s, totals)),
    findings: sortFindings(findings),
    calibration: calibrate(sessions),
  };
}
