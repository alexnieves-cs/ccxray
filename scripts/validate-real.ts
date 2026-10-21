// Real-log validation (SPEC §6 M2, §7). LOCAL ONLY: never run in CI, never on a shared machine.
//
//   pnpm validate:real                          # default roots (CLAUDE_CONFIG_DIR, ~/.claude …)
//   pnpm validate:real --root DIR [--root DIR]  # other projects dirs
//   pnpm validate:real --ccusage ccusage.json   # also cross-check A1 totals against ccusage
//
// For the cross-check, run ccusage yourself first (this script never runs npx and makes no
// network call): `npx ccusage@latest claude session --json > ccusage.json`. Both sides then cover all
// time (this script applies no --since unless you pass one, and neither should ccusage).
//
// Output is counts only: no prompt or file content, no paths, and session ids are hashed.
// A1 passes when every total is within ±0.5% of ccusage (SPEC §6 M2). The $ cross-check (M7,
// SPEC §5.1) passes when the window's list-price cost is within ±$0.01 of ccusage's totalCost
// (both price 1h cache writes at 2× input); per-session costs are printed, never gated.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { defaultRoots } from '../src/discover.js';
import { DEFAULT_THRESHOLDS, type Session, type TokenTotals } from '../src/model/index.js';
import { loadSessions } from '../src/parser/index.js';
import { buildReport } from '../src/pipeline.js';

export const TOLERANCE_PCT = 0.5;
const METRICS = ['input', 'output', 'cacheCreate', 'cacheRead'] as const;
type Metric = (typeof METRICS)[number];
export type Counts = Record<Metric, number>;

export const hashId = (id: string): string =>
  createHash('sha256').update(id).digest('hex').slice(0, 10);

const num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined;

/**
 * ccusage's rows that belong to Claude Code. Newer ccusage `session` (no agent subcommand) also
 * reports other coding CLIs (Codex, Gemini, ...) and tags each row with `agent`; tknxray only
 * reads Claude Code, so other agents' rows are dropped. Rows without `agent` are kept (older
 * output, or `ccusage claude session`). When a row is dropped, ccusage's own totals cover the
 * other agents too, so callers sum the kept rows instead.
 */
function claudeRows(root: Record<string, unknown>): { rows: unknown[]; dropped: number } {
  const all = [
    ...(Array.isArray(root.session) ? (root.session as unknown[]) : []),
    ...(Array.isArray(root.sessions) ? (root.sessions as unknown[]) : []),
  ];
  const rows = all.filter((s) => {
    const a = (s as Record<string, unknown> | null)?.agent;
    return typeof a !== 'string' || a === 'claude';
  });
  return { rows, dropped: all.length - rows.length };
}

/**
 * The shape of `ccusage session --json`. Two shapes are accepted; anything else is ignored.
 * - Confirmed against real ccusage output on 2026-10-19 (ccusage latest): `{ session: [{ period:
 *   <sessionId>, inputTokens, outputTokens, cacheCreationTokens, cacheReadTokens, totalTokens,
 *   totalCost, modelsUsed, modelBreakdowns, metadata: { lastActivity } }], totals: { … } }`,
 *   with subagent transcripts folded into their parent session.
 * - UNVERIFIED (older, as remembered from ccusage's docs): `{ sessions: [{ sessionId, … }],
 *   totals }`. Alternative token key spellings are accepted for both.
 */
export function parseCcusage(json: unknown): {
  sessions: Map<string, Counts>;
  totals?: Counts;
  droppedOtherAgents: number;
} {
  const counts = (o: unknown): Counts | undefined => {
    if (typeof o !== 'object' || o === null) return undefined;
    const r = o as Record<string, unknown>;
    const input = num(r.inputTokens) ?? num(r.input_tokens);
    const output = num(r.outputTokens) ?? num(r.output_tokens);
    const cacheCreate = num(r.cacheCreationTokens) ?? num(r.cacheCreationInputTokens);
    const cacheRead = num(r.cacheReadTokens) ?? num(r.cacheReadInputTokens);
    if ([input, output, cacheCreate, cacheRead].some((x) => x === undefined)) return undefined;
    return { input: input!, output: output!, cacheCreate: cacheCreate!, cacheRead: cacheRead! };
  };
  const root = (typeof json === 'object' && json !== null ? json : {}) as Record<string, unknown>;
  const sessions = new Map<string, Counts>();
  const { rows, dropped } = claudeRows(root);
  for (const s of rows) {
    const r = s as Record<string, unknown> | null;
    const id = r?.sessionId ?? r?.period;
    const c = counts(s);
    if (typeof id === 'string' && c !== undefined) sessions.set(id, c);
  }
  const totals = dropped > 0 ? undefined : counts(root.totals);
  return { sessions, ...(totals !== undefined ? { totals } : {}), droppedOtherAgents: dropped };
}

export const COST_TOLERANCE_USD = 0.01;

/** `totalCost` of the ccusage report and of each session (same shapes as parseCcusage). */
export function parseCcusageCost(json: unknown): { sessions: Map<string, number>; total?: number } {
  const root = (typeof json === 'object' && json !== null ? json : {}) as Record<string, unknown>;
  const sessions = new Map<string, number>();
  const { rows, dropped } = claudeRows(root);
  for (const s of rows) {
    const r = s as Record<string, unknown> | null;
    const id = r?.sessionId ?? r?.period;
    const c = num(r?.totalCost);
    if (typeof id === 'string' && c !== undefined) sessions.set(id, c);
  }
  const totals = root.totals as Record<string, unknown> | undefined;
  const total = dropped > 0 ? undefined : num(totals?.totalCost);
  return { sessions, ...(total !== undefined ? { total } : {}) };
}

/** Compare our list-price cost with ccusage's: total gated at ±COST_TOLERANCE_USD. */
export function compareCost(
  ours: { total: number; bySession: Map<string, number> },
  theirs: ReturnType<typeof parseCcusageCost>,
): { lines: string[]; pass: boolean } {
  const total = theirs.total ?? [...theirs.sessions.values()].reduce((a, b) => a + b, 0);
  const diff = ours.total - total;
  const pass = Math.abs(diff) <= COST_TOLERANCE_USD;
  const usd = (x: number) => `$${x.toFixed(4)}`;
  const lines = [
    '',
    `cost cross-check [E] (list prices, ±$${COST_TOLERANCE_USD} on the total)`,
    `  tknxray ${usd(ours.total)} · ccusage ${usd(total)} · diff ${diff >= 0 ? '+' : ''}${diff.toFixed(4)}`,
    `  TOTAL: ${pass ? 'PASS' : 'FAIL'}`,
  ];
  for (const [id, c] of [...theirs.sessions].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const o = ours.bySession.get(id);
    lines.push(
      `  ${hashId(id)}  tknxray ${o === undefined ? 'missing' : usd(o)} · ccusage ${usd(c)}`,
    );
  }
  return { lines, pass };
}

/** Our cost per ccusage session key (subagents rolled into their parent, like oursBySession). */
export function oursCostBySession(
  sessions: readonly Session[],
  bySession: Record<string, TokenTotals>,
): Map<string, number> {
  const out = new Map<string, number>();
  for (const s of sessions) {
    const key = s.isSubagent ? (s.parentSessionId ?? s.id) : s.id;
    out.set(key, (out.get(key) ?? 0) + (bySession[s.id]?.cost?.total ?? 0));
  }
  return out;
}

const fromTotals = (t: TokenTotals): Counts => ({
  input: t.input,
  output: t.output,
  cacheCreate: t.cacheWrite,
  cacheRead: t.cacheRead,
});

/** % difference of ours vs theirs; 0 when both are 0, Infinity when only theirs is 0. */
export function pctDiff(ours: number, theirs: number): number {
  if (theirs === 0) return ours === 0 ? 0 : Infinity;
  return ((ours - theirs) / theirs) * 100;
}

export function within(ours: Counts, theirs: Counts): boolean {
  return METRICS.every((m) => Math.abs(pctDiff(ours[m], theirs[m])) <= TOLERANCE_PCT);
}

/**
 * tknxray sessions keyed for matching ccusage: subagent sessions are rolled into their parent
 * session id, as ccusage does (confirmed against real `ccusage session --json` on 2026-10-19).
 */
export function oursBySession(
  sessions: readonly Session[],
  bySession: Record<string, TokenTotals>,
) {
  const out = new Map<string, Counts>();
  for (const s of sessions) {
    const key = s.isSubagent ? (s.parentSessionId ?? s.id) : s.id;
    const c = fromTotals(bySession[s.id]!);
    const prev = out.get(key);
    out.set(
      key,
      prev === undefined
        ? c
        : {
            input: prev.input + c.input,
            output: prev.output + c.output,
            cacheCreate: prev.cacheCreate + c.cacheCreate,
            cacheRead: prev.cacheRead + c.cacheRead,
          },
    );
  }
  return out;
}

/**
 * Files whose name (a session UUID) differs from the tknxray session they were grouped under,
 * keyed by file stem -> our grouping key. tknxray keys a main file by its first envelope
 * `sessionId`; ccusage appears to key by the file name. UNVERIFIED: a resumed or continued
 * transcript starts with records carrying the earlier session's id, so the two tools can put the
 * same turns under different sessions while totals still match.
 */
export function regroupedFiles(sessions: readonly Session[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const s of sessions) {
    const key = s.isSubagent ? (s.parentSessionId ?? s.id) : s.id;
    for (const f of s.files) {
      const stem = (f.split(/[\\/]/).pop() ?? f).replace(/\.jsonl$/, '');
      if (!s.isSubagent && stem !== key) out.set(stem, key);
    }
  }
  return out;
}

const fmt = (x: number): string =>
  Number.isFinite(x) ? `${x >= 0 ? '+' : ''}${x.toFixed(2)}%` : 'n/a';
const n = (x: number): string => x.toLocaleString('en-US');

export function compareReport(
  ours: { all: Counts; bySession: Map<string, Counts> },
  theirs: ReturnType<typeof parseCcusage>,
  regrouped: ReadonlyMap<string, string> = new Map(),
): { lines: string[]; pass: boolean } {
  const lines: string[] = ['', `ccusage cross-check (±${TOLERANCE_PCT}% per metric)`];
  const total = theirs.totals ?? sumCounts([...theirs.sessions.values()]);
  lines.push('  metric         tknxray       ccusage       diff');
  for (const m of METRICS)
    lines.push(
      `  ${m.padEnd(12)} ${n(ours.all[m]).padStart(14)} ${n(total[m]).padStart(14)} ` +
        `${fmt(pctDiff(ours.all[m], total[m])).padStart(9)}`,
    );
  const pass = within(ours.all, total);
  lines.push(
    `  TOTAL: ${pass ? 'PASS' : 'FAIL'}`,
    '',
    '  per session (hashed id; diff for input / output / cacheCreate / cacheRead):',
  );
  let ok = 0;
  let missing = 0;
  for (const [id, t] of [...theirs.sessions].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const o = ours.bySession.get(id);
    if (o === undefined) {
      missing++;
      const owner = regrouped.get(id);
      lines.push(
        `  ${hashId(id)}  not found in tknxray` +
          (owner !== undefined
            ? ` (its file is grouped under ${hashId(owner)}: first record carries that session id)`
            : ''),
      );
      continue;
    }
    const good = within(o, t);
    if (good) ok++;
    lines.push(
      `  ${hashId(id)}  ${METRICS.map((m) => fmt(pctDiff(o[m], t[m])).padStart(9)).join(' ')}  ` +
        (good ? 'PASS' : 'FAIL'),
    );
  }
  const extra = [...ours.bySession.keys()].filter((k) => !theirs.sessions.has(k)).length;
  lines.push(
    `  sessions: ${theirs.sessions.size} in ccusage · ${ok} pass · ` +
      `${theirs.sessions.size - ok - missing} fail · ${missing} missing in tknxray · ` +
      `${extra} only in tknxray`,
  );
  return { lines, pass };
}

function sumCounts(cs: Counts[]): Counts {
  return cs.reduce(
    (a, c) => ({
      input: a.input + c.input,
      output: a.output + c.output,
      cacheCreate: a.cacheCreate + c.cacheCreate,
      cacheRead: a.cacheRead + c.cacheRead,
    }),
    { input: 0, output: 0, cacheCreate: 0, cacheRead: 0 },
  );
}

async function mainScript(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      root: { type: 'string', multiple: true },
      since: { type: 'string' },
      ccusage: { type: 'string' },
    },
  });
  const since = values.since !== undefined ? new Date(values.since) : undefined;
  const { sessions, stats } = await loadSessions({ roots: values.root ?? defaultRoots(), since });
  const report = buildReport({
    sessions,
    stats,
    ctx: { thresholds: DEFAULT_THRESHOLDS, now: new Date(), includeContent: false },
    window: { since: values.since ?? null, until: null, project: null },
    includeContent: false,
  });
  const sum = (m: Record<string, number>): number => Object.values(m).reduce((a, b) => a + b, 0);
  const lines = [
    'tknxray validate:real (counts only)',
    `roots found: ${stats.roots.length} · files ${n(stats.files)} · ${(stats.bytes / 1e6).toFixed(1)} MB`,
    `lines ${n(stats.lines)} · blank ${n(stats.blankLines)} · malformed ${n(stats.malformedLines)}`,
    `unknown record types: ${Object.keys(stats.unknownRecordTypes).length} kinds, ` +
      `${n(sum(stats.unknownRecordTypes))} records · field warnings ${n(sum(stats.warnings))}`,
    `sessions ${n(sessions.length)} (${n(sessions.filter((s) => s.isSubagent).length)} subagent) · ` +
      `synthetic turns ${n(stats.syntheticTurns)} · dedupe drops ` +
      `${n(stats.dedupe.sameResponseLines)}/${n(stats.dedupe.sidechainReplays)}/` +
      `${n(stats.dedupe.crossSessionCopies)} (same-response/sidechain/cross-session)`,
    '',
    'findings per analyzer:',
  ];
  const per = new Map<string, { count: number; tokens: number; kind: string }>();
  for (const f of report.findings) {
    const p = per.get(f.analyzer) ?? { count: 0, tokens: 0, kind: f.tokens.kind };
    p.count++;
    p.tokens += f.tokens.value;
    per.set(f.analyzer, p);
  }
  if (per.size === 0) lines.push('  none');
  for (const [a, p] of per)
    lines.push(
      `  ${a.padEnd(18)} ${String(p.count).padStart(5)} findings · ${n(p.tokens)} tokens (${p.kind})`,
    );
  const t = report.totals.all;
  lines.push(
    '',
    'A1 totals (measured):',
    `  turns ${n(t.turns)} · input ${n(t.input)} · output ${n(t.output)} · cache create ` +
      `${n(t.cacheWrite)} (5m ${n(t.cacheWrite5m)} / 1h ${n(t.cacheWrite1h)}) · cache read ${n(t.cacheRead)}`,
    `  cache hit ratio ${t.cacheHitRatio === null ? 'n/a' : `${(t.cacheHitRatio * 100).toFixed(1)}%`}`,
    `calibration [E]: ${report.calibration?.samples ?? 0} samples · median ratio ` +
      `${report.calibration?.medianRatio ?? 'n/a'}`,
  );
  let code = 0;
  if (values.ccusage !== undefined) {
    const theirs = parseCcusage(JSON.parse(readFileSync(values.ccusage, 'utf8')));
    if (theirs.sessions.size === 0 && theirs.totals === undefined) {
      lines.push('', 'ccusage file: no sessions or totals recognized (format changed?)');
      code = 1;
    } else {
      if (theirs.droppedOtherAgents > 0)
        lines.push(
          '',
          `ccusage: ignored ${theirs.droppedOtherAgents} session(s) from other coding CLIs ` +
            '(not Claude Code); totals are summed over the Claude Code sessions only',
        );
      const cmp = compareReport(
        { all: fromTotals(t), bySession: oursBySession(sessions, report.totals.bySession) },
        theirs,
        regroupedFiles(sessions),
      );
      lines.push(...cmp.lines);
      if (!cmp.pass) code = 1;
      const cost = compareCost(
        {
          total: t.cost?.total ?? 0,
          bySession: oursCostBySession(sessions, report.totals.bySession),
        },
        parseCcusageCost(JSON.parse(readFileSync(values.ccusage, 'utf8'))),
      );
      lines.push(...cost.lines);
      if (t.cost !== undefined && t.cost.unpricedTurns > 0)
        lines.push(
          `  note: ${n(t.cost.unpricedTurns)} turns on unpriced models are not in tknxray's $`,
        );
      if (!cost.pass) code = 1;
    }
  }
  process.stdout.write(`${lines.join('\n')}\n`);
  return code;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  mainScript(process.argv.slice(2)).then(
    (code) => (process.exitCode = code),
    (e: unknown) => {
      process.stderr.write(`validate:real: ${e instanceof Error ? e.message : String(e)}\n`);
      process.exitCode = 2;
    },
  );
}
