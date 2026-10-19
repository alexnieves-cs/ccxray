// Terminal rendering of `tknxray compare` (SPEC §3.1). Pure; every line fits in 100 columns.
import { direction, relMove, type Comparison, type Metric } from '../compare.js';
import {
  formatCompact,
  formatInt,
  formatRatio,
  formatUsd,
  padEnd,
  padStart,
  palette,
  truncate,
  wrapParts,
} from './format.js';

const WIDTH = 100;

function windowLabel(w: Comparison['before']): string {
  const since = w.since === null ? '…' : w.since.slice(0, 10);
  const until = w.until === null ? 'now' : w.until.slice(0, 10);
  return since === until ? since : `${since} → ${until}`;
}

export function formatMetricValue(m: Pick<Metric, 'unit'>, v: number | null): string {
  if (v === null) return '–';
  switch (m.unit) {
    case 'usd':
      return formatUsd(v);
    case 'ratio':
      return formatRatio(v);
    case 'pct':
      return `${v.toFixed(1)}%`;
    case 'tokens':
      return formatCompact(Math.round(v));
    case 'count':
      return Number.isInteger(v) ? formatInt(v) : v.toFixed(2);
  }
}

function change(m: Metric): string {
  if (m.before === null || m.after === null) return '';
  if (m.unit === 'pct' || m.unit === 'ratio') {
    const d = (m.after - m.before) * (m.unit === 'ratio' ? 100 : 1);
    return `${d >= 0 ? '+' : ''}${d.toFixed(1)} pts`;
  }
  const r = relMove(m);
  if (r === null) return m.after > m.before ? 'new' : '';
  return `${r >= 0 ? '+' : ''}${Math.round(r * 100)}%`;
}

export function renderCompareTerminal(c: Comparison, color: boolean): string {
  const p = palette(color);
  const lines: string[] = [];
  lines.push(
    `${p.bold('tknxray compare')} · before ${windowLabel(c.before)} · after ${windowLabel(c.after)}` +
      (c.after.project !== null ? ` · project ${c.after.project}` : ''),
  );
  lines.push('');
  lines.push(p.bold(`${padEnd('', 34)}${padStart('before', 12)}${padStart('after', 12)}  change`));
  for (const m of c.metrics) {
    const tag = m.kind === 'measured' ? '[M]' : '[E]';
    const dir = direction(m);
    const mark =
      dir === 'better'
        ? p.green('better')
        : dir === 'worse'
          ? p.red('worse')
          : dir === 'same'
            ? p.dim('same')
            : '';
    lines.push(
      `  ${padEnd(truncate(`${m.label} ${tag}`, 32), 32)}` +
        `${padStart(formatMetricValue(m, m.before), 12)}${padStart(formatMetricValue(m, m.after), 12)}` +
        `  ${padEnd(change(m), 10)} ${mark}`.trimEnd(),
    );
  }
  if (c.waste.length > 0) {
    lines.push('');
    lines.push(
      p.bold('WASTE BY KIND') + p.dim("  savings the findings price, as % of each window's $ [E]"),
    );
    for (const w of c.waste) {
      const d = w.afterPct - w.beforePct;
      const mark = Math.abs(d) < 0.5 ? p.dim('same') : d < 0 ? p.green('better') : p.red('worse');
      const pct = (x: number): string => `${w.upperBound ? '≤' : ''}${x.toFixed(1)}%`;
      lines.push(
        `  ${padEnd(truncate(w.label, 40), 40)}${padStart(pct(w.beforePct), 9)} → ` +
          `${padEnd(pct(w.afterPct), 9)} ${mark}`,
      );
    }
  }
  lines.push('');
  const better = c.improved.length;
  const worse = c.worsened.length;
  const directional = c.metrics.filter((m) => direction(m) !== null).length;
  lines.push(
    `${p.bold('VERDICT')}  ${better} better, ${worse} worse, ${directional - better - worse} ` +
      `about the same (moves under 5% count as the same).`,
  );
  for (const note of [c.thin, c.note]) {
    if (note === undefined) continue;
    for (const l of wrapParts(note.split(' '), ' ', WIDTH - 2)) lines.push(p.dim(`  ${l}`));
  }
  lines.push(
    p.dim('[M] measured from usage fields · [E] estimated · $ at API list prices, not a bill'),
  );
  return lines.join('\n') + '\n';
}
