// `tknxray compare` (SPEC §3.1): two windows side by side, so a change can be checked against the
// logs ("I set CLAUDE_CODE_SUBAGENT_MODEL on the 12th; did it help?"). Pure: Reports and
// sessions in, a Comparison out.
//
// Workloads differ between windows, so every rate is normalized (per assistant turn, per main
// session) and the verdict says what moved, not why: a comparison is evidence, not proof.
import type { Finding, Report, Session } from './model/index.js';

export type Better = 'lower' | 'higher' | 'neutral';

export interface Metric {
  id: string;
  label: string;
  /** How values print: `usd`, `pct` (0..100), `ratio` (0..1), `tokens` or `count`. */
  unit: 'usd' | 'pct' | 'ratio' | 'tokens' | 'count';
  before: number | null;
  after: number | null;
  better: Better;
  kind: 'measured' | 'estimated';
}

/** Savings share of one kind of waste (SPEC §5.2 impact, grouped by analyzer). */
export interface WasteRow {
  analyzer: string;
  label: string;
  beforePct: number;
  afterPct: number;
  upperBound: boolean;
}

export interface Comparison {
  before: Report['window'];
  after: Report['window'];
  metrics: Metric[];
  waste: WasteRow[];
  /** Metrics with a direction that moved at least MIN_MOVE the good or bad way. */
  improved: string[];
  worsened: string[];
  /** Set when one window has too little data for the rates to mean much. */
  thin?: string;
  note: string;
}

/** A move smaller than this (relative) is reported as unchanged. */
export const MIN_MOVE = 0.05;
/** Fewer main sessions or assistant turns than these make a window "thin". */
const MIN_SESSIONS = 3;
const MIN_TURNS = 100;

export const COMPARE_NOTE =
  'Workloads differ between windows: rates are per turn or per session to make them comparable, ' +
  'but a change in a rate is evidence, not proof, that a setting caused it.';

const WASTE_LABELS: Record<string, string> = {
  'subagent-cost': 'Subagents on a larger model than needed',
  'context-growth': 'Large context re-read every turn',
  'cache-rebuild': 'Cache rebuilt after breaks or changes',
  'cache-ttl': 'Prompt cache TTL (5m vs 1h) not the cheaper one',
  'big-tool-output': 'Big tool outputs carried in context',
  'repeated-read': 'Same file read again',
  'cross-agent-read': 'Same file read by several agents',
  'tool-usage': 'Unused tool definitions',
  'fixed-overhead': 'Fixed per-request overhead',
  'error-waste': 'Failed tool calls and API errors',
};

const median = (xs: number[]): number | null => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 === 1 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

const plural = (n: number, w: string): string => `${n} ${w}${n === 1 ? '' : 's'}`;

const div = (a: number, b: number): number | null => (b > 0 ? a / b : null);

/** Largest context (input + cache read + cache write) of a main session's turns. Measured. */
function peakContext(s: Session): number {
  let peak = 0;
  for (const t of s.turns) {
    if (t.isSynthetic || t.isSidechain) continue;
    const u = t.usage;
    peak = Math.max(peak, u.input + u.cacheRead + u.cacheWrite);
  }
  return peak;
}

/** What compare() needs from one window; the sessions can be released once this is built. */
export interface Side {
  report: Report;
  /** One entry per main session with at least one real turn. Measured. */
  main: { peak: number; compactions: number }[];
}

export function side(report: Report, sessions: readonly Session[]): Side {
  return {
    report,
    main: sessions
      .filter((s) => !s.isSubagent && s.turns.some((t) => !t.isSynthetic))
      .map((s) => ({
        peak: peakContext(s),
        compactions: s.events.filter((e) => e.kind === 'compaction').length,
      })),
  };
}

function measure(s: Side): Map<string, number | null> {
  const { report, main } = s;
  const all = report.totals.all;
  const cost = all.cost?.total ?? 0;
  // Turns on a model without a list price are left out of cost.total, so $ rates divide by
  // priced turns only, and per-session $ is shown only when every turn is priced.
  const priced = all.cost === undefined ? 0 : all.turns - all.cost.unpricedTurns;
  const rebuilds = report.findings
    .filter((f) => f.analyzer === 'cache-rebuild')
    .reduce((a, f) => a + (typeof f.data?.rebuilds === 'number' ? f.data.rebuilds : 0), 0);
  const compactions = main.reduce((a, m) => a + m.compactions, 0);
  const sub = report.totals.byRole?.subagent.cost?.total ?? 0;
  return new Map<string, number | null>([
    ['sessions', main.length],
    ['turns', all.turns],
    ['unpriced', all.turns - priced],
    ['costPerTurn', div(cost, priced)],
    ['costPerSession', priced === all.turns ? div(cost, main.length) : null],
    ['hitRatio', all.cacheHitRatio],
    ['writePerTurn', div(all.cacheWrite, all.turns)],
    ['outputPerTurn', div(all.output, all.turns)],
    ['peakContext', median(main.map((m) => m.peak))],
    ['compactionsPerSession', div(compactions, main.length)],
    ['rebuildsPer100', all.turns > 0 ? (rebuilds / all.turns) * 100 : null],
    ['subagentShare', priced > 0 && cost > 0 ? (sub / cost) * 100 : null],
    ['addressable', priced > 0 && cost > 0 ? (report.actionPlan?.combinedSharePct ?? 0) : null],
  ]);
}

const DEFS: Omit<Metric, 'before' | 'after'>[] = [
  { id: 'sessions', label: 'main sessions', unit: 'count', better: 'neutral', kind: 'measured' },
  { id: 'turns', label: 'assistant turns', unit: 'count', better: 'neutral', kind: 'measured' },
  { id: 'costPerTurn', label: '$ per turn', unit: 'usd', better: 'lower', kind: 'estimated' },
  {
    id: 'costPerSession',
    label: '$ per main session',
    unit: 'usd',
    better: 'lower',
    kind: 'estimated',
  },
  { id: 'hitRatio', label: 'cache hit ratio', unit: 'ratio', better: 'higher', kind: 'measured' },
  {
    id: 'writePerTurn',
    label: 'cache writes per turn',
    unit: 'tokens',
    better: 'lower',
    kind: 'measured',
  },
  {
    id: 'outputPerTurn',
    label: 'output per turn',
    unit: 'tokens',
    better: 'neutral',
    kind: 'measured',
  },
  {
    id: 'peakContext',
    label: 'median peak context',
    unit: 'tokens',
    better: 'lower',
    kind: 'measured',
  },
  {
    id: 'compactionsPerSession',
    label: 'compactions per session',
    unit: 'count',
    better: 'lower',
    kind: 'measured',
  },
  {
    id: 'rebuildsPer100',
    label: 'cache rebuilds per 100 turns',
    unit: 'count',
    better: 'lower',
    kind: 'measured',
  },
  {
    id: 'subagentShare',
    label: 'subagent share of $',
    unit: 'pct',
    better: 'neutral',
    kind: 'estimated',
  },
  {
    id: 'addressable',
    label: 'fixable waste (action plan)',
    unit: 'pct',
    better: 'lower',
    kind: 'estimated',
  },
];

/** Relative move of `after` against `before`; null when either is missing or before is 0. */
export function relMove(m: Pick<Metric, 'before' | 'after'>): number | null {
  if (m.before === null || m.after === null) return null;
  if (m.before === 0) return m.after === 0 ? 0 : null;
  return (m.after - m.before) / Math.abs(m.before);
}

/** 'better' | 'worse' | 'same' | null (no direction or no data). */
export function direction(m: Metric): 'better' | 'worse' | 'same' | null {
  if (m.better === 'neutral') return null;
  if (m.before === null || m.after === null) return null;
  // A zero baseline has no relative move: any rise from 0 is a move.
  const r = relMove(m);
  const moved = r === null ? m.after !== m.before : Math.abs(r) >= MIN_MOVE;
  if (!moved) return 'same';
  const up = m.after > m.before;
  return up === (m.better === 'higher') ? 'better' : 'worse';
}

function wasteShares(report: Report): Map<string, { pct: number; upper: boolean }> {
  const cost = report.totals.all.cost?.total ?? 0;
  const out = new Map<string, { pct: number; upper: boolean }>();
  if (!(cost > 0)) return out;
  const add = (f: Finding): void => {
    const s = f.impact?.savingsUsd ?? 0;
    if (!(s > 0)) return;
    const cur = out.get(f.analyzer) ?? { pct: 0, upper: false };
    out.set(f.analyzer, {
      pct: cur.pct + (s / cost) * 100,
      upper: cur.upper || f.impact?.upperBound === true,
    });
  };
  report.findings.forEach(add);
  return out;
}

export function compare(before: Side, after: Side): Comparison {
  const b = measure(before);
  const a = measure(after);
  const metrics: Metric[] = DEFS.map((d) => ({
    ...d,
    before: b.get(d.id) ?? null,
    after: a.get(d.id) ?? null,
  }));
  const wb = wasteShares(before.report);
  const wa = wasteShares(after.report);
  const round = (x: number): number => Math.round(x * 10) / 10;
  const waste: WasteRow[] = [...new Set([...wb.keys(), ...wa.keys()])]
    .map((k) => ({
      analyzer: k,
      label: WASTE_LABELS[k] ?? k,
      beforePct: round(wb.get(k)?.pct ?? 0),
      afterPct: round(wa.get(k)?.pct ?? 0),
      upperBound: (wb.get(k)?.upper ?? false) || (wa.get(k)?.upper ?? false),
    }))
    .filter((w) => w.beforePct > 0 || w.afterPct > 0)
    .sort((x, y) => Math.max(y.beforePct, y.afterPct) - Math.max(x.beforePct, x.afterPct));
  const thinSide = (name: string, m: Map<string, number | null>): string | undefined =>
    (m.get('sessions') ?? 0) < MIN_SESSIONS || (m.get('turns') ?? 0) < MIN_TURNS
      ? `the ${name} window has ${plural(m.get('sessions') ?? 0, 'main session')} and ` +
        `${plural(m.get('turns') ?? 0, 'turn')}`
      : undefined;
  const unpricedSide = (name: string, m: Map<string, number | null>): string | undefined =>
    (m.get('unpriced') ?? 0) > 0
      ? `the ${name} window has ${plural(m.get('unpriced') ?? 0, 'turn')} on a model with no ` +
        `list price, left out of the $ rates`
      : undefined;
  const thin = [
    thinSide('before', b),
    thinSide('after', a),
    unpricedSide('before', b),
    unpricedSide('after', a),
  ]
    .filter(Boolean)
    .join('; ');
  return {
    before: before.report.window,
    after: after.report.window,
    metrics,
    waste,
    improved: metrics.filter((m) => direction(m) === 'better').map((m) => m.id),
    worsened: metrics.filter((m) => direction(m) === 'worse').map((m) => m.id),
    ...(thin ? { thin: `Thin data: ${thin}; treat the rates with care.` } : {}),
    note: COMPARE_NOTE,
  };
}
