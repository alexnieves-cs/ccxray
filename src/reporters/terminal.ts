// Terminal reporter (SPEC §3 example output). Every line fits in `width` columns (≤ 100).
import { changesPhrase } from '../cost/plan.js';
import { COST_NOTE } from '../cost/cost.js';
import type { CostTotals, Finding, Report, Severity, TokenTotals } from '../model/index.js';
import {
  analyzerHeading,
  attribution,
  causeRows,
  dateSpan,
  allVersions,
  findingCommand,
  parseWarnings,
  sortFindings,
} from './derive.js';
import {
  LEGEND_ESTIMATED,
  LEGEND_MEASURED,
  displayProject,
  displayRoot,
  formatCompact,
  formatDateRange,
  formatInt,
  formatPct,
  formatRatio,
  formatTokens,
  formatUsd,
  formatVersionRange,
  kindTag,
  palette,
  type Palette,
  padEnd,
  padStart,
  relSource,
  resolveHome,
  sanitizeText,
  shortId,
  truncate,
  visibleWidth,
  wrapParts,
} from './format.js';

export interface TerminalOptions {
  color: boolean;
  /** Target width in columns; clamped to 60..100. Defaults to 100. */
  width?: number;
  /** Home directory, shown as `~` in roots and project names. Defaults to os.homedir(). */
  homeDir?: string;
  /** How many findings to list before "+N more". Defaults to 8. */
  maxFindings?: number;
}

const MAX_WIDTH = 100;
const MIN_WIDTH = 60;

/** Deep copy with every string passed through sanitizeText (no escapes or controls from data). */
function sanitizeDeep<T>(v: T): T {
  if (typeof v === 'string') return sanitizeText(v) as T;
  if (Array.isArray(v)) return v.map(sanitizeDeep) as T;
  if (v !== null && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) out[sanitizeText(k)] = sanitizeDeep(x);
    return out as T;
  }
  return v;
}

export function renderTerminal(input: Report, opts: TerminalOptions): string {
  const width = Math.max(MIN_WIDTH, Math.min(finiteOr(opts.width, MAX_WIDTH), MAX_WIDTH));
  const p = palette(opts.color);
  const home = resolveHome(opts.homeDir);
  const report = sanitizeDeep(input);
  const lines =
    report.sessions.length === 0
      ? emptyState(report, p, width, home)
      : [
          ...header(report, p, width),
          '',
          ...tokens(report, p),
          ...cost(report, p, width),
          ...breakdown(report, p, width, home),
          ...actionPlan(report, input, p, width),
          ...whereItWent(report, p, width),
          ...topFindings(report, p, width, opts.maxFindings ?? 8, home),
          ...warnings(report, p, width),
          ...footer(report, p, width),
        ];
  return lines.map((l) => truncate(l, width)).join('\n') + '\n';
}

function header(report: Report, p: Palette, width: number): string[] {
  const subagents = report.sessions.filter((s) => s.isSubagent).length;
  const span = dateSpan(report);
  const parts = [
    p.bold('tknxray'),
    `${formatInt(report.sessions.length)} sessions` + (subagents ? ` (${subagents} subagent)` : ''),
    `${formatInt(report.totals.all.turns)} assistant turns`,
    span ? formatDateRange(span.from, span.to) : 'unknown dates',
    `Claude Code ${formatVersionRange(allVersions(report))}`,
  ];
  if (report.window.project) parts.push(`project ~ "${report.window.project}"`);
  return wrapParts(parts, ' · ', width, '  ');
}

function tokens(report: Report, p: Palette): string[] {
  const t = report.totals.all;
  const sum = t.input + t.cacheWrite + t.cacheRead + t.output;
  const row = (label: string, n: number, extra = '') =>
    `  ${padEnd(label, 22)} ${padStart(formatCompact(n), 7)} ${padStart(formatPct(n, sum), 5)}` +
    (extra ? `   ${p.dim(extra)}` : '');
  const split =
    t.cacheWrite5m || t.cacheWrite1h
      ? `5m ${formatCompact(t.cacheWrite5m)} · 1h ${formatCompact(t.cacheWrite1h)}`
      : '';
  return [
    p.bold('TOKENS') + ' (measured from usage fields)',
    row('input (uncached)', t.input),
    row('cache write (creation)', t.cacheWrite, split),
    row('cache read', t.cacheRead),
    row('output', t.output),
    `  cache hit ratio  ${p.green(formatRatio(t.cacheHitRatio))}  ` +
      p.dim('(read / (read + write + input))'),
  ];
}

/** Words of `text` wrapped to `width`, every line starting with `indent`. */
function wrapText(text: string, width: number, indent: string): string[] {
  const words = text.split(' ').filter((w) => w !== '');
  if (words.length === 0) return [];
  return wrapParts([indent + words[0], ...words.slice(1)], ' ', width, indent);
}

const writes = (c: CostTotals): number => c.write5m + c.write1h;

/** COST [E]: the window at API list prices, by kind and main vs subagents. */
function cost(report: Report, p: Palette, width: number): string[] {
  const all = report.totals.all.cost;
  if (all === undefined) return [];
  const main = report.totals.byRole?.main.cost;
  const sub = report.totals.byRole?.subagent.cost;
  const out = [
    '',
    p.bold('COST') +
      ' [E] what these tokens would cost at API list prices' +
      (report.pricing ? p.dim(` (prices of ${report.pricing.asOf})`) : ''),
  ];
  if (all.total > 0) {
    const split = main !== undefined && sub !== undefined && sub.total > 0;
    const row = (label: string, k: (c: CostTotals) => number) =>
      `  ${padEnd(label, 22)} ${padStart(formatUsd(k(all)), 7)} ${padStart(formatPct(k(all), all.total), 5)}` +
      (split ? p.dim(`   main ${formatUsd(k(main))} · subagents ${formatUsd(k(sub))}`) : '');
    out.push(
      row('total', (c) => c.total),
      row('output', (c) => c.output),
      row('cache read', (c) => c.read),
      row('cache write', writes),
      row('input (uncached)', (c) => c.input),
    );
  } else out.push('  no priced turns in this window');
  if (all.unpricedTurns > 0) {
    const models = Object.keys(report.pricing?.unpricedModels ?? {}).join(', ');
    out.push(
      ...wrapText(
        `${formatInt(all.unpricedTurns)} turns on unpriced models left out` +
          (models ? ` (${models})` : ''),
        width,
        '  ',
      ).map(p.dim),
    );
  }
  return out;
}

const EIGHTHS = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉'];

/** A horizontal bar of `cells` columns for value / max, in eighths of a cell. */
export function hbar(value: number, max: number, cells: number): string {
  if (!(max > 0) || !(value > 0) || !(cells > 0)) return '';
  const e = Math.max(1, Math.round((value / max) * cells * 8));
  return '█'.repeat(Math.floor(e / 8)) + EIGHTHS[e % 8]!;
}

const MAX_PROJECTS = 5;
const MAX_DAYS = 14;

/** BY PROJECT / BY DAY [E]: where the $ went, when there is more than one of either. */
function breakdown(report: Report, p: Palette, width: number, home: string): string[] {
  const priced = (r: Record<string, TokenTotals>) =>
    Object.entries(r)
      .filter(([, t]) => t.turns > 0 && t.cost !== undefined)
      .map(([k, t]) => ({ k, t, usd: t.cost!.total }));
  const total = report.totals.all.cost?.total ?? 0;
  if (!(total > 0)) return [];
  const out: string[] = [];
  const MIN_BAR = 6;
  const projects = priced(report.totals.byProject).sort(
    (a, b) => b.usd - a.usd || (a.k < b.k ? -1 : 1),
  );
  if (projects.length > 1) {
    out.push('', p.bold('BY PROJECT') + ' [E] $ at list prices · turns and cache hit ratio [M]');
    const max = projects[0]!.usd;
    const shown = projects.slice(0, MAX_PROJECTS);
    const tail = (x: (typeof shown)[number]): string =>
      `  ${formatInt(x.t.turns)} turns · hit ${formatRatio(x.t.cacheHitRatio)}`;
    // The measured turns and hit ratio come last and must not be cut: the project name shrinks
    // first, then the bar is dropped.
    const tailW = Math.max(...shown.map((x) => tail(x).length));
    const fixed = 2 + 1 + 9 + 1 + 5 + 2 + tailW;
    const nameW = Math.max(8, Math.min(36, width - fixed - MIN_BAR));
    const room = width - fixed - nameW;
    const barCells = room >= MIN_BAR ? room : 0;
    for (const x of shown)
      out.push(
        `  ${padEnd(truncate(displayProject(x.k, home), nameW), nameW)} ${padStart(formatUsd(x.usd), 9)} ` +
          `${padStart(formatPct(x.usd, total), 5)}  ${padEnd(p.cyan(hbar(x.usd, max, barCells)), barCells)}` +
          p.dim(tail(x)),
      );
    if (projects.length > MAX_PROJECTS) {
      const rest = projects.slice(MAX_PROJECTS);
      out.push(
        p.dim(`  +${rest.length} more projects: ${formatUsd(rest.reduce((a, x) => a + x.usd, 0))}`),
      );
    }
  }
  const days = priced(report.totals.byDay).sort((a, b) => (a.k < b.k ? -1 : 1));
  if (days.length > 1) {
    const shown = days.slice(-MAX_DAYS);
    out.push(
      '',
      p.bold('BY DAY') +
        ' (UTC) [E] $ at list prices' +
        (days.length > shown.length ? p.dim(` · last ${shown.length} of ${days.length} days`) : ''),
    );
    const max = Math.max(...shown.map((x) => x.usd));
    const tailW = Math.max(...shown.map((x) => `  ${formatInt(x.t.turns)} turns`.length));
    const barCells = Math.max(MIN_BAR, Math.min(60, width - (2 + 12 + 1 + 9 + 2) - tailW));
    for (const x of shown)
      out.push(
        `  ${padEnd(formatDay(x.k), 12)} ${padStart(formatUsd(x.usd), 9)}  ` +
          `${padEnd(p.cyan(hbar(x.usd, max, barCells)), barCells)}` +
          p.dim(`  ${formatInt(x.t.turns)} turns`),
      );
  }
  return out;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** `2026-10-19` → `Mon Oct 19` (UTC). */
function formatDay(day: string): string {
  const d = new Date(`${day}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime())) return day;
  return `${WEEKDAYS[d.getUTCDay()]} ${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

/** WHAT TO CHANGE FIRST: the action plan, largest savings first. */
function actionPlan(report: Report, raw: Report, p: Palette, width: number): string[] {
  const plan = report.actionPlan;
  if (plan === undefined || plan.actions.length === 0) return [];
  const out = ['', p.bold('WHAT TO CHANGE FIRST') + ' (savings at API list prices [E])'];
  plan.actions.forEach((a, i) => {
    const right = `${a.upperBound === true ? 'up to ' : '~'}${formatUsd(a.savingsUsd)}  ${formatPct(a.savingsUsd, plan.windowCostUsd)} of cost`;
    const num = padStart(`${i + 1}.`, 3);
    const left = truncate(`${num} ${p.bold(a.title)}`, width - visibleWidthOf(right) - 2);
    out.push(`${padEnd(left, width - visibleWidthOf(right))}${p.green(right)}`);
    out.push(...wrapText(a.why, width, '      ').map(p.dim));
    // Change lines come from the unsanitized report so their line breaks survive; each line is
    // sanitized on its own and word-wrapped, never cut (it is meant to be copied).
    const lines = (raw.actionPlan?.actions[i]?.change ?? a.change).split('\n').map(sanitizeText);
    out.push(`      ${p.cyan('change:')}`);
    for (const l of lines) {
      // Continuation lines line up under the text of an indented or `- ` bullet line.
      const lead = /^\s*(?:- )?/.exec(l)![0];
      const [first = '', ...rest] = wrapText(l.slice(lead.length), width - 8 - lead.length, '');
      out.push(
        `        ${lead}${first}`,
        ...rest.map((r) => `        ${' '.repeat(lead.length)}${r}`),
      );
    }
    const refs =
      a.findings.slice(0, 5).join(', ') +
      (a.findings.length > 5 ? ` +${a.findings.length - 5} more` : '');
    out.push(
      p.dim(
        `      ${a.confidence === 'measured-tokens' ? 'tokens measured, $ estimated' : 'estimated'}` +
          ` · from finding${a.findings.length === 1 ? '' : 's'} ${refs}`,
      ),
    );
  });
  out.push(
    ...wrapText(
      `${changesPhrase(plan.actions.length)} would have cut ${plan.combinedUpperBound === true ? 'up to' : 'about'} ` +
        `${formatPct(plan.combinedSavingsUsd, plan.windowCostUsd)} of this window's cost [E] ` +
        `(${plan.combinedUpperBound === true ? 'up to ' : '~'}${formatUsd(plan.combinedSavingsUsd)} of ${formatUsd(plan.windowCostUsd)}; overlapping ` +
        'savings are not double-counted).',
      width,
      '  ',
    ).map(p.bold),
  );
  return out;
}

function whereItWent(report: Report, p: Palette, width: number): string[] {
  const rows = attribution(report.findings);
  if (rows.length === 0) return [];
  const out = ['', p.bold('WHERE IT WENT') + ' (estimated attribution)'];
  for (const r of rows) {
    const tools = r.byTool
      .slice(0, 3)
      .map((t) => `${t.tool} ${formatRatio(t.share)}`)
      .join(', ');
    const head = `  ${padEnd(truncate(r.analyzer, 20), 20)} ${padStart(formatTokens(r.tokens, 'estimated'), 7)} [E]`;
    const count = `${r.findings} finding${r.findings === 1 ? '' : 's'}`;
    out.push(truncate(`${head}  ${count}${tools ? ` · ${tools}` : ''}`, width));
  }
  return out;
}

function severityTag(s: Severity, p: Palette): string {
  if (s === 'high') return p.red('[high]');
  if (s === 'warn') return p.yellow('[warn]');
  return p.cyan('[info]');
}

const visibleWidthOf = (s: string): number => visibleWidth(s);

function finiteOr(n: number | undefined, fallback: number): number {
  return n !== undefined && Number.isFinite(n) ? n : fallback;
}

function findingLines(
  f: Finding,
  n: number,
  roots: string[],
  home: string,
  p: Palette,
  width: number,
): string[] {
  const num = padStart(`${n}.`, 3);
  const out = [
    `${num} ${p.bold(analyzerHeading(f.analyzer))} ${severityTag(f.severity, p)}  ${f.title}`,
  ];
  const facts: string[] = [];
  if (!(f.tokens.value <= 0))
    facts.push(`${formatTokens(f.tokens.value, f.tokens.kind)} ${kindTag(f.tokens.kind)}`);
  if (f.impact !== undefined && f.impact.costUsd > 0)
    facts.push(
      f.impact.savingsUsd > 0
        ? `saves ${f.impact.upperBound === true ? 'up to ' : '~'}${formatUsd(f.impact.savingsUsd)} of ${formatUsd(f.impact.costUsd)} [E]`
        : `costs ${formatUsd(f.impact.costUsd)} [E]`,
    );
  const cmd = findingCommand(f);
  if (cmd) facts.push(`cmd \`${cmd}\``);
  facts.push(`${f.evidence.length} evidence`);
  const first = f.evidence[0];
  if (first) {
    facts.push(
      `e.g. ${first.source ? relSource(first.source, roots, home) : `session ${shortId(first.sessionId)}`}`,
    );
  }
  out.push(...wrapParts(facts, ' · ', width - 6).map((l) => '      ' + p.dim(l)));
  for (const c of causeRows(f).slice(0, 5)) {
    const tok =
      c.tokens === undefined
        ? ''
        : c.tokensKind === undefined
          ? ` (${formatTokens(c.tokens, f.tokens.kind)})`
          : ` (${formatTokens(c.tokens, c.tokensKind)} ${kindTag(c.tokensKind)})`;
    const left = padEnd(`${formatInt(c.count)} × ${c.cause}${tok}`, 34);
    out.push(`      ${left}${c.fix ? ` → ${c.fix}` : ''}`);
  }
  if (f.fix.summary) out.push(`      → ${f.fix.summary}`);
  return out.map((l) => truncate(l, width));
}

function topFindings(
  report: Report,
  p: Palette,
  width: number,
  max: number,
  home: string,
): string[] {
  const sorted = sortFindings(report.findings);
  const out = ['', p.bold('TOP FINDINGS')];
  if (sorted.length === 0) return [...out, '  none: nothing crossed a threshold in this window'];
  sorted
    .slice(0, max)
    .forEach((f, i) => out.push(...findingLines(f, i + 1, report.stats.roots, home, p, width)));
  if (sorted.length > max) {
    out.push(p.dim(`  +${sorted.length - max} more findings in --json / --html`));
  }
  return out;
}

function warnings(report: Report, p: Palette, width: number): string[] {
  const w = parseWarnings(report);
  if (w.length === 0) return [];
  return [
    '',
    ...wrapParts(
      [`${p.yellow('PARSE WARNINGS')}  ${w[0]}`, ...w.slice(1), 'run `tknxray doctor` for details'],
      ' · ',
      width,
      '  ',
    ),
  ];
}

function footer(report: Report, p: Palette, width: number): string[] {
  const top = sortFindings(report.findings)[0]?.evidence[0]?.sessionId ?? report.sessions[0]?.id;
  const hint = [
    top ? `Run \`tknxray session ${shortId(top)}\` for per-turn detail` : '',
    '`--html` for a shareable report',
  ].filter(Boolean);
  const legend = [`[M] ${LEGEND_MEASURED}`, `[E] / ~ ${LEGEND_ESTIMATED}`, COST_NOTE];
  return [
    '',
    ...legend.flatMap((l) => wrapText(l, width, '')).map(p.dim),
    ...wrapParts(hint, ' · ', width, '  '),
  ];
}

function emptyState(report: Report, p: Palette, width: number, homeDir?: string): string[] {
  const roots = report.stats.roots;
  const out = [`${p.bold('tknxray')} · no sessions found`, ''];
  if (roots.length === 0) out.push('  No Claude Code log directories were found.');
  else {
    out.push('  Looked in:');
    for (const r of roots) out.push(`    ${displayRoot(r, homeDir)}`);
  }
  const w = report.window;
  const filters = [
    w.since ? `since ${w.since}` : '',
    w.until ? `until ${w.until}` : '',
    w.project ? `project ~ "${w.project}"` : '',
  ].filter(Boolean);
  if (filters.length > 0) out.push(`  Filters: ${filters.join(', ')}`);
  out.push(
    `  Files scanned: ${formatInt(report.stats.files)} · lines: ${formatInt(report.stats.lines)}`,
    '',
    '  Try a wider --since, set CLAUDE_CONFIG_DIR, or run `tknxray doctor`.',
  );
  return [...out, ...warnings(report, p, width)];
}
