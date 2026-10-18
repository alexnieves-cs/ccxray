// HTML reporter (`--html FILE`): one self-contained file. Inline CSS and JS only; nothing is
// loaded from the network (a CSP meta tag enforces it). Every dynamic string is escaped.
import type { Finding, Report, TokenKind } from '../model/index.js';
import {
  allVersions,
  analyzerHeading,
  attribution,
  causeRows,
  dateSpan,
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
  formatUtc,
  formatVersionRange,
  relSource,
  shortId,
} from './format.js';

export interface HtmlOptions {
  /** Home directory, replaced by `~` when showing log roots. */
  homeDir?: string;
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const e = escapeHtml;

function badge(kind: TokenKind): string {
  return kind === 'measured'
    ? '<span class="b m" title="measured from usage fields">M</span>'
    : '<span class="b e" title="estimated">E</span>';
}

const CSS = `
:root{--bg:#fff;--fg:#1d1f23;--mut:#5f6670;--line:#d9dde3;--card:#f5f7fa;--hi:#c62828;--warn:#b26a00;--info:#1565c0;
--c1:#7e57c2;--c2:#ef6c00;--c3:#2e7d32;--c4:#1565c0}
@media (prefers-color-scheme:dark){:root{--bg:#15171a;--fg:#e6e8eb;--mut:#9aa3ad;--line:#2c3036;--card:#1e2125;
--hi:#ef5350;--warn:#ffb74d;--info:#64b5f6;--c1:#b39ddb;--c2:#ffb74d;--c3:#81c784;--c4:#64b5f6}}
*{box-sizing:border-box}body{margin:0 auto;max-width:1100px;padding:24px 16px;background:var(--bg);color:var(--fg);
font:14px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif}
h1{font-size:20px;margin:0 0 4px}h2{font-size:16px;margin:28px 0 8px}.mut{color:var(--mut)}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px}
.tile{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:10px}
.tile .v{font-size:20px;font-weight:600}.tile .l{color:var(--mut);font-size:12px}
table{border-collapse:collapse;width:100%;font-size:13px}th,td{border-bottom:1px solid var(--line);padding:6px;
text-align:left;vertical-align:top}td.n,th.n{text-align:right;font-variant-numeric:tabular-nums}
.wrap{overflow-x:auto}.b{display:inline-block;font-size:10px;font-weight:700;border-radius:3px;padding:0 4px;
margin-left:4px;border:1px solid currentColor}.b.m{color:var(--c3)}.b.e{color:var(--c2)}
.sev-high{color:var(--hi);font-weight:600}.sev-warn{color:var(--warn);font-weight:600}.sev-info{color:var(--info)}
details summary{cursor:pointer;color:var(--info)}pre{white-space:pre-wrap;background:var(--card);padding:8px;
border-radius:6px}code{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px}
.key{display:inline-block;width:10px;height:10px;border-radius:2px;margin:0 4px 0 12px}
button{font:inherit;background:var(--card);color:var(--fg);border:1px solid var(--line);border-radius:6px;padding:2px 8px}
footer{margin-top:32px;color:var(--mut);font-size:12px;border-top:1px solid var(--line);padding-top:8px}
`;

const JS = `
document.getElementById('toggle').addEventListener('click',function(){
var d=document.querySelectorAll('details.ev');var open=!Array.prototype.every.call(d,function(x){return x.open;});
Array.prototype.forEach.call(d,function(x){x.open=open;});});
`;

function tile(label: string, value: string, kind: TokenKind = 'measured'): string {
  return `<div class="tile"><div class="v">${e(value)}${badge(kind)}</div><div class="l">${e(label)}</div></div>`;
}

function tokenBar(report: Report): string {
  const t = report.totals.all;
  const parts: [string, number, string][] = [
    ['input (uncached)', t.input, 'var(--c1)'],
    ['cache write', t.cacheWrite, 'var(--c2)'],
    ['cache read', t.cacheRead, 'var(--c3)'],
    ['output', t.output, 'var(--c4)'],
  ];
  const sum = parts.reduce((a, [, n]) => a + n, 0);
  let x = 0;
  const rects = parts
    .map(([label, n, color]) => {
      const w = sum > 0 ? (n / sum) * 1000 : 0;
      const r = `<rect x="${x.toFixed(1)}" y="0" width="${w.toFixed(1)}" height="24" style="fill:${color}"><title>${e(label)}: ${formatInt(n)}</title></rect>`;
      x += w;
      return r;
    })
    .join('');
  const keys = parts
    .map(
      ([label, n, color]) =>
        `<span class="key" style="background:${color}"></span>${e(label)} ${e(formatCompact(n))} (${e(formatPct(n, sum))})`,
    )
    .join('');
  return `<svg viewBox="0 0 1000 24" preserveAspectRatio="none" width="100%" height="24" role="img" aria-label="token breakdown">${rects}</svg><p class="mut">${keys}</p>`;
}

function docsLink(url: string): string {
  // Plain navigation links only, never loaded automatically; rel=noreferrer leaks nothing.
  if (/^https:\/\/[^\s"'<>]+$/.test(url)) {
    return ` · <a href="${e(url)}" rel="noreferrer">docs</a>`;
  }
  return ` · docs: ${e(url)}`;
}

function findingRow(f: Finding, n: number, roots: string[]): string {
  const cmd = findingCommand(f);
  const causes = causeRows(f)
    .map(
      (c) =>
        `<li>${formatInt(c.count)} × ${e(c.cause)}${c.tokens !== undefined ? ` (${e(formatTokens(c.tokens, f.tokens.kind))})` : ''}${c.fix ? ` → ${e(c.fix)}` : ''}</li>`,
    )
    .join('');
  const evidence = f.evidence
    .map(
      (ev) =>
        `<tr><td><code>${e(shortId(ev.sessionId))}</code></td><td><code>${e(ev.turnUuid)}</code></td>` +
        `<td>${ev.source ? `<code>${e(relSource(ev.source, roots))}</code>` : ''}</td><td>${e(ev.detail)}</td></tr>`,
    )
    .join('');
  const tokens =
    f.tokens.value > 0
      ? `${e(formatTokens(f.tokens.value, f.tokens.kind))}${badge(f.tokens.kind)}`
      : '';
  const fix =
    `<p>→ ${e(f.fix.summary)}${f.fix.docsUrl ? docsLink(f.fix.docsUrl) : ''}</p>` +
    (f.fix.diff ? `<pre><code>${e(f.fix.diff)}</code></pre>` : '');
  return (
    `<tr><td class="n">${n}</td><td class="sev-${e(f.severity)}">${e(f.severity)}</td>` +
    `<td>${e(analyzerHeading(f.analyzer))}</td><td>${e(f.title)}${cmd ? ` <code>${e(cmd)}</code>` : ''}` +
    (causes ? `<ul>${causes}</ul>` : '') +
    fix +
    `<details class="ev"><summary>${f.evidence.length} evidence</summary><div class="wrap"><table>` +
    `<tr><th>session</th><th>turn</th><th>source</th><th>detail</th></tr>${evidence}</table></div></details></td>` +
    `<td class="n">${tokens}</td></tr>`
  );
}

function sessionsTable(report: Report): string {
  const rows = report.sessions
    .map((s) => {
      const t = s.totals;
      return (
        `<tr><td><code>${e(shortId(s.id))}</code></td><td>${e(s.project)}</td><td>${s.isSubagent ? 'subagent' : 'main'}</td>` +
        `<td>${e(formatUtc(s.firstTs))}</td><td class="n">${formatInt(s.turns)}</td>` +
        `<td>${e(s.models.join(', '))}</td><td>${e(s.ccVersions.join(', '))}</td>` +
        [t.input, t.cacheWrite, t.cacheRead, t.output]
          .map((n) => `<td class="n">${e(formatCompact(n))}</td>`)
          .join('') +
        `<td class="n">${e(formatRatio(t.cacheHitRatio))}</td></tr>`
      );
    })
    .join('');
  return (
    `<div class="wrap"><table><tr><th>session</th><th>project</th><th>kind</th><th>first turn</th><th class="n">turns</th>` +
    `<th>models</th><th>CC versions</th><th class="n">input</th><th class="n">cache write</th><th class="n">cache read</th>` +
    `<th class="n">output</th><th class="n">hit ratio</th></tr>${rows}</table></div>`
  );
}

function parseStatsSection(report: Report, homeDir?: string): string {
  const s = report.stats;
  const map = (m: Record<string, number>) =>
    Object.entries(m)
      .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
      .map(([k, v]) => `${e(k)} ×${formatInt(v)}`)
      .join(', ') || 'none';
  const rows: [string, string][] = [
    ['log roots', s.roots.map((r) => e(displayRoot(r, homeDir))).join('<br>') || 'none'],
    [
      'files / lines',
      `${formatInt(s.files)} / ${formatInt(s.lines)} (${formatInt(s.blankLines)} blank)`,
    ],
    ['malformed lines (skipped)', formatInt(s.malformedLines)],
    ['record types', map(s.recordTypes)],
    ['unknown record types', map(s.unknownRecordTypes)],
    [
      'dedupe (lines dropped)',
      `same response ${formatInt(s.dedupe.sameResponseLines)} · sidechain replays ${formatInt(s.dedupe.sidechainReplays)} · cross-session copies ${formatInt(s.dedupe.crossSessionCopies)}`,
    ],
    ['synthetic turns (excluded)', formatInt(s.syntheticTurns)],
    ['field warnings', map(s.warnings)],
  ];
  const warn = parseWarnings(report);
  return (
    (warn.length
      ? `<p class="sev-warn">${e(warn.join(' · '))}. Run <code>ccxray doctor</code> for details.</p>`
      : '') +
    `<table>${rows.map(([k, v]) => `<tr><th>${e(k)}</th><td>${v}</td></tr>`).join('')}</table>`
  );
}

export function renderHtml(report: Report, opts: HtmlOptions = {}): string {
  const t = report.totals.all;
  const span = dateSpan(report);
  const subtitle = [
    `${formatInt(report.sessions.length)} sessions`,
    span ? formatDateRange(span.from, span.to) : 'no sessions found',
    `Claude Code ${formatVersionRange(allVersions(report))}`,
    `generated ${formatUtc(report.generatedAt)}`,
  ].join(' · ');
  const attr = attribution(report.findings);
  const findings = sortFindings(report.findings);
  const subagents = report.sessions.filter((s) => s.isSubagent).length;
  const body = [
    `<h1>ccxray report</h1><p class="mut">${e(subtitle)}</p>`,
    `<p class="mut">Prompt and file contents: ${report.includeContent ? 'included (--include-content)' : 'not included'}.</p>`,
    `<h2>Summary (measured)</h2><div class="tiles">`,
    tile(
      'sessions' + (subagents ? ` (${subagents} subagent)` : ''),
      formatInt(report.sessions.length),
    ),
    tile('assistant turns', formatInt(t.turns)),
    tile('cache hit ratio', formatRatio(t.cacheHitRatio)),
    tile('input (uncached)', formatCompact(t.input)),
    tile('cache write', formatCompact(t.cacheWrite)),
    tile('cache read', formatCompact(t.cacheRead)),
    tile('output', formatCompact(t.output)),
    `</div>`,
    `<h2>Token breakdown (measured)</h2>`,
    tokenBar(report),
    attr.length
      ? `<h2>Where it went (estimated)</h2><table><tr><th>analyzer</th><th class="n">tokens</th><th class="n">findings</th><th>by tool</th></tr>` +
        attr
          .map(
            (r) =>
              `<tr><td>${e(r.analyzer)}</td><td class="n">${e(formatTokens(r.tokens, 'estimated'))}${badge('estimated')}</td>` +
              `<td class="n">${r.findings}</td><td>${e(r.byTool.map((x) => `${x.tool} ${formatRatio(x.share)}`).join(', '))}</td></tr>`,
          )
          .join('') +
        `</table>`
      : '',
    `<h2>Findings</h2>`,
    findings.length
      ? `<p><button id="toggle" type="button">expand / collapse all evidence</button></p><div class="wrap"><table>` +
        `<tr><th class="n">#</th><th>severity</th><th>analyzer</th><th>finding</th><th class="n">tokens</th></tr>` +
        findings.map((f, i) => findingRow(f, i + 1, report.stats.roots)).join('') +
        `</table></div>`
      : '<p class="mut">No findings in this window.</p>',
    `<h2>Sessions</h2>`,
    report.sessions.length ? sessionsTable(report) : '<p class="mut">No sessions found.</p>',
    `<h2>Parse stats</h2>`,
    parseStatsSection(report, opts.homeDir),
    `<h2>Legend</h2><p>${badge('measured')} ${e(LEGEND_MEASURED)}<br>${badge('estimated')} ${e(LEGEND_ESTIMATED)}</p>`,
    `<footer>Local-only report generated by ccxray ${e(report.tool.version)}. ` +
      `It was built from files on this machine and loads nothing from the network.</footer>`,
  ].join('\n');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:">
<meta name="referrer" content="no-referrer">
<title>ccxray report</title>
<style>${CSS}</style>
</head>
<body>
${body}
<script>${findings.length ? JS : ''}</script>
</body>
</html>
`;
}
