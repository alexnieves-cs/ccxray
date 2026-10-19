// Terminal reporter (SPEC §3 example output). Every line fits in `width` columns (≤ 100).
import type { Finding, Report, Severity } from '../model/index.js';
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
  displayRoot,
  formatCompact,
  formatDateRange,
  formatInt,
  formatPct,
  formatRatio,
  formatTokens,
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
  const legend = [`[M] ${LEGEND_MEASURED}`, `[E] / ~ ${LEGEND_ESTIMATED}`];
  return [
    '',
    ...wrapParts(legend, ' · ', width).map(p.dim),
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
