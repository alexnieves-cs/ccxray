// HTML reporter (`--html FILE`): one self-contained file. Inline CSS and JS only; nothing is
// loaded from the network (a CSP meta tag enforces it). Every dynamic string is escaped, and
// the replay's data is embedded as escaped JSON (scriptJson) that the page parses.
import type { Finding, Report, TokenKind, TokenTotals } from '../model/index.js';
import { reportClient } from './client.js';
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
  displayProject,
  displayRoot,
  formatCompact,
  formatDateRange,
  formatInt,
  formatPct,
  formatRatio,
  formatTokens,
  formatUtc,
  formatVersionRange,
  kindTag,
  relSource,
  resolveHome,
  shortId,
} from './format.js';
import { scriptJson, type Timeline } from './timeline.js';

export interface HtmlOptions {
  /** Home directory, shown as `~` in roots and project names. Defaults to os.homedir(). */
  homeDir?: string;
  /** Per-turn data for the session replay (buildTimeline). Without it the replay is omitted. */
  timeline?: Timeline;
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
    ? '<i class="b m" title="measured: taken directly from usage fields in the logs">M</i>'
    : '<i class="b e" title="estimated: chars/4 heuristic or attribution guess">E</i>';
}

// Colors: categorical slots 1-3 (blue, orange, aqua) for the stacked context layers, slot 7
// (violet) for output, status red for rebuilds. Light and dark steps are separate, validated
// sets; dark applies to the OS setting unless the viewer picked light, and to data-theme=dark.
const LIGHT = `--bg:#f9f9f7;--surface:#fcfcfb;--card:#ffffff;--fg:#0b0b0b;--fg2:#52514e;--mut:#6f6d68;
--grid:#e1e0d9;--axis:#c3c2b7;--ring:rgba(11,11,11,.10);--read:#2a78d6;--write:#eb6834;--input:#1baf7a;
--output:#6250d6;--crit:#d03b3b;--warn:#a86a00;--good:#006300;--info:#256abf;--accent:#2a78d6;
--wash:rgba(42,120,214,.08);color-scheme:light`;
const DARK = `--bg:#0d0d0d;--surface:#1a1a19;--card:#151514;--fg:#f0efec;--fg2:#c3c2b7;--mut:#9a988f;
--grid:#2c2c2a;--axis:#383835;--ring:rgba(255,255,255,.10);--read:#3987e5;--write:#d95926;--input:#199e70;
--output:#9085e9;--crit:#e66767;--warn:#fab219;--good:#0ca30c;--info:#86b6ef;--accent:#3987e5;
--wash:rgba(57,135,229,.12);color-scheme:dark`;

const CSS = `
:root{${LIGHT}}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){${DARK}}}
:root[data-theme="dark"]{${DARK}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:1180px;margin:0 auto;padding:20px 16px 48px}
a{color:var(--accent)}
h1{font-size:22px;margin:0;letter-spacing:-.01em}h1 span{color:var(--mut);font-weight:500}
h2{font-size:17px;margin:40px 0 4px;letter-spacing:-.01em}h2+.sub{margin:0 0 14px;color:var(--fg2)}
.mut{color:var(--mut)}.num{font-variant-numeric:tabular-nums}
code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px}
button,select{font:inherit;color:var(--fg);background:var(--card);border:1px solid var(--ring);border-radius:8px;padding:5px 10px;cursor:pointer}
button:hover,select:hover{border-color:var(--axis)}
button:focus-visible,select:focus-visible,input:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.b{display:inline-block;font:700 9px/14px system-ui,sans-serif;font-style:normal;border-radius:4px;padding:0 4px;margin-left:4px;vertical-align:1px;border:1px solid currentColor}
.b.m{color:var(--good)}.b.e{color:var(--warn)}
header.top{display:flex;flex-wrap:wrap;gap:12px;align-items:flex-end;justify-content:space-between;padding-bottom:16px;border-bottom:1px solid var(--grid)}
header.top p{margin:4px 0 0;color:var(--fg2)}
.pills{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.pill{font-size:12px;color:var(--fg2);border:1px solid var(--ring);border-radius:999px;padding:3px 10px;background:var(--card)}
.hero{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,160px),1fr));gap:12px;margin-top:20px}
.tile{background:var(--card);border:1px solid var(--ring);border-radius:12px;padding:14px 16px}
.tile .v{font-size:28px;font-weight:650;letter-spacing:-.02em;line-height:1.15}
.tile .l{color:var(--fg2);font-size:13px;margin-top:2px}.tile .d{color:var(--mut);font-size:12px;margin-top:6px}
.tile.alert .v{color:var(--crit)}
.comp{margin-top:14px}.comp .sbar{height:14px}
.keys{display:flex;flex-wrap:wrap;gap:4px 18px;margin-top:8px;color:var(--fg2);font-size:13px}
.sw{display:inline-block;width:10px;height:10px;border-radius:3px;margin-right:6px;vertical-align:0}
.s-read{background:var(--read)}.s-write{background:var(--write)}.s-input{background:var(--input)}.s-output{background:var(--output)}
.sbar{display:flex;gap:2px;width:100%;height:10px;border-radius:5px;overflow:hidden;background:var(--grid)}
.sbar>span{display:block;height:100%;min-width:2px}
.panelbox{background:var(--card);border:1px solid var(--ring);border-radius:14px;padding:16px}
#replay{scroll-margin-top:12px}
.rp-ctl{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:12px}
.rp-ctl select#rp-session{max-width:100%;flex:1 1 320px}
#rp-play{min-width:92px;background:var(--accent);color:#fff;border-color:transparent;font-weight:600}
.rp-ctl input[type=range]{flex:1 1 200px;accent-color:var(--accent)}
.rp-grid{display:grid;grid-template-columns:minmax(0,1fr) 330px;gap:16px}
@media (max-width:900px){.rp-grid{grid-template-columns:1fr}}
.rp-chartwrap{position:relative;min-width:0}
#rp-chart{position:relative;user-select:none;cursor:crosshair}
#rp-chart svg{display:block}
#rp-chart .grid{stroke:var(--grid);stroke-width:1}#rp-chart .base{stroke:var(--axis);stroke-width:1}
#rp-chart .win{stroke:var(--mut);stroke-width:1;stroke-dasharray:2 3}
#rp-chart .tick,#rp-chart .lanelab{fill:var(--mut);font-size:11px;font-variant-numeric:tabular-nums}
#rp-chart .a-read{fill:var(--read)}#rp-chart .a-write{fill:var(--write)}#rp-chart .a-input{fill:var(--input)}
#rp-chart .ghost{opacity:.13}
#rp-chart .out rect{fill:var(--output)}
#rp-chart .cursor{stroke:var(--fg);stroke-width:1.5}
#rp-chart .mk{cursor:pointer;color:var(--mut)}
#rp-chart .mk>circle{fill:var(--surface);stroke:currentColor;stroke-width:1.5;stroke-opacity:.45}
#rp-chart .mk path,.ic path{fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}
#rp-chart .mk.past>circle{stroke-opacity:1}#rp-chart .mk.now>circle{fill:currentColor}#rp-chart .mk.now path{stroke:var(--surface)}
#rp-chart .mk .cnt{fill:currentColor;stroke:var(--surface);stroke-width:1.5}#rp-chart .mk .cntt{fill:var(--surface);font-size:8px;font-weight:700}
.mk-rebuild,.ic-rebuild{color:var(--crit)}.mk-compaction,.ic-compaction{color:var(--fg2)}.mk-idle,.ic-idle{color:var(--warn)}
.mk-model,.mk-version,.ic-model,.ic-version{color:var(--info)}
.ic{vertical-align:-2px}
#rp-chart .mk-line{stroke-width:1}#rp-chart .mk-line.mk-rebuild{stroke:var(--crit);stroke-opacity:.5}
#rp-chart .mk-line.mk-compaction{stroke:var(--fg2);stroke-opacity:.45;stroke-dasharray:3 3}
#rp-tip{display:none;position:absolute;z-index:5;pointer-events:none;background:var(--card);color:var(--fg);border:1px solid var(--ring);
box-shadow:0 6px 24px rgba(0,0,0,.14);border-radius:8px;padding:8px 10px;font-size:12px;line-height:1.55;max-width:240px;font-variant-numeric:tabular-nums}
.legend{display:flex;flex-wrap:wrap;gap:4px 16px;font-size:12px;color:var(--fg2);margin:6px 0 0 48px}
.legend .g{font-weight:700}
#rp-panel{font-size:13px}
#rp-panel .ph{display:flex;flex-direction:column;gap:1px;margin-bottom:10px}
#rp-panel .turnno{font-size:15px}#rp-panel .turnno b{font-size:22px;font-variant-numeric:tabular-nums}
.gauge{margin:10px 0 12px}.gl{display:flex;justify-content:space-between;gap:8px;font-size:12px;margin:3px 0}
.gtrack .sbar{height:16px;border-radius:6px}
.kv{display:grid;grid-template-columns:1fr 1fr;gap:6px 12px;margin:0 0 12px}.kv div{display:flex;justify-content:space-between;gap:6px}
.kv dt{color:var(--fg2)}.kv dd{margin:0;font-weight:600}
.tools ul{list-style:none;margin:4px 0 0;padding:0;max-height:156px;overflow:auto}
.tools li{display:grid;grid-template-columns:minmax(0,1.2fr) 1fr auto;gap:8px;align-items:center;padding:2px 0}
.tools .tn{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px}
.tbar{height:6px;background:var(--grid);border-radius:3px;overflow:hidden}.tbar span{display:block;height:100%;background:var(--fg2);opacity:.55}
.flag{grid-column:1/-1;justify-self:start;font-size:11px;color:var(--fg2);border:1px solid var(--ring);border-radius:999px;padding:0 7px}
.flag.err{color:var(--crit)}.flag.link{color:var(--accent);background:transparent;cursor:pointer}
.run{border-top:1px solid var(--grid);padding-top:8px;margin-top:10px}
.runrow{display:grid;grid-template-columns:1fr 1fr;gap:4px 12px;color:var(--fg2)}.runrow b{color:var(--fg)}.runrow .hl b{color:var(--crit)}
.callout{display:flex;flex-direction:column;gap:2px;border-left:3px solid var(--fg2);background:var(--wash);border-radius:6px;padding:8px 10px;margin:4px 0 6px;animation:pop .35s ease-out}
.callout.c-rebuild{border-color:var(--crit)}.callout.c-idle{border-color:var(--warn)}.callout.c-model,.callout.c-version{border-color:var(--info)}
.callout .big{font-size:15px;font-weight:650;color:var(--crit)}
@keyframes pop{from{transform:translateY(-4px);opacity:0}to{transform:none;opacity:1}}
@media (prefers-reduced-motion:reduce){.callout{animation:none}}
#rp-lanes{margin-top:8px;font-size:12px}
.lanes-h{display:flex;flex-wrap:wrap;justify-content:space-between;gap:2px 12px;color:var(--fg2);margin:0 0 4px}
.lanebox{max-height:188px;overflow-y:auto;overflow-x:hidden;border-top:1px solid var(--grid);border-bottom:1px solid var(--grid)}
.lane{position:relative;display:block;width:100%;height:22px;padding:0;border:0;border-radius:0;background:transparent;font-size:11px}
.lane:hover{background:var(--wash)}
.lane .lb{position:absolute;top:7px;height:8px;background:var(--output);border-radius:4px;min-width:6px}
.lane.live .lb{box-shadow:0 0 0 2px var(--card),0 0 0 3.5px var(--output)}
.lane .ll{position:absolute;top:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--fg2)}
.lane.live .ll{color:var(--fg);font-weight:600}
.back{font-size:12px;padding:3px 10px;color:var(--accent)}
#rp-log ol{list-style:none;margin:0;padding:0;max-height:260px;overflow:auto;border-top:1px solid var(--grid)}
#rp-log li{border-bottom:1px solid var(--grid)}
#rp-log .ev{display:block;width:100%;text-align:left;background:transparent;border:0;border-radius:0;padding:7px 4px;font-size:13px;color:var(--fg2)}
#rp-log .ev:hover{background:var(--wash)}#rp-log .ev.past{color:var(--fg)}#rp-log .ev.now{background:var(--wash)}
#rp-log .ev{display:grid;grid-template-columns:22px 210px minmax(0,1fr);gap:4px;align-items:baseline}
#rp-log .w{color:var(--mut);font-variant-numeric:tabular-nums}#rp-log .also{display:block;color:var(--mut);font-size:12px}
.callout.minor{background:transparent;padding:2px 10px}
@media (max-width:640px){#rp-log .ev{grid-template-columns:22px minmax(0,1fr)}#rp-log .d{grid-column:2}}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}
#days svg{display:block;width:100%;height:auto}#days .grid{stroke:var(--grid)}#days .tick{fill:var(--mut);font-size:11px}
#days .c-read{fill:var(--read)}#days .c-write{fill:var(--write)}#days .c-input{fill:var(--input)}#days .c-output{fill:var(--output)}
.cards{display:grid;gap:12px}
.card{background:var(--card);border:1px solid var(--ring);border-radius:12px;padding:14px 16px}
.card .hd{display:flex;gap:10px;align-items:baseline;justify-content:space-between;flex-wrap:wrap}
.card .tt{font-weight:600;font-size:15px;margin-top:4px}.card .an{font-size:11px;letter-spacing:.06em;color:var(--mut);font-weight:600}
.card .tk{font-size:18px;font-weight:650;white-space:nowrap;font-variant-numeric:tabular-nums}
.sev{display:inline-flex;gap:4px;align-items:center;font-size:12px;font-weight:600;border-radius:999px;padding:1px 9px;border:1px solid currentColor}
.sev-high{color:var(--crit)}.sev-warn{color:var(--warn)}.sev-info{color:var(--info)}
.card ul.causes{margin:8px 0 0;padding-left:18px}.card .fix{margin:8px 0 0;color:var(--fg2)}
.card pre{white-space:pre-wrap;background:var(--surface);border:1px solid var(--grid);padding:8px;border-radius:8px;overflow:auto}
details summary{cursor:pointer;color:var(--accent);margin-top:8px}
.wrap{overflow-x:auto}
table{border-collapse:collapse;width:100%;font-size:13px}th,td{border-bottom:1px solid var(--grid);padding:6px;text-align:left;vertical-align:top}
th{color:var(--fg2);font-weight:600}td.n,th.n{text-align:right;font-variant-numeric:tabular-nums}
.go{font-size:11px;padding:1px 8px;white-space:nowrap;color:var(--accent)}
footer{margin-top:40px;color:var(--mut);font-size:12px;border-top:1px solid var(--grid);padding-top:10px}
@media (max-width:640px){.hero{grid-template-columns:1fr 1fr}.tile{padding:12px}.tile .v{font-size:22px}#rp-log .w{min-width:0;display:block}}
`;

const sumTotals = (t: TokenTotals): number => t.input + t.cacheWrite + t.cacheRead + t.output;

function tile(label: string, value: string, kind: TokenKind, detail = '', cls = ''): string {
  return (
    `<div class="tile${cls ? ' ' + cls : ''}"><div class="v num">${e(value)}${badge(kind)}</div>` +
    `<div class="l">${e(label)}</div>${detail ? `<div class="d">${detail}</div>` : ''}</div>`
  );
}

function composition(t: TokenTotals): string {
  const parts: [string, string, number][] = [
    ['read', 'cache read', t.cacheRead],
    ['write', 'cache write', t.cacheWrite],
    ['input', 'uncached input', t.input],
    ['output', 'output', t.output],
  ];
  const sum = parts.reduce((a, [, , n]) => a + n, 0);
  const bar = parts
    .filter(([, , n]) => n > 0 && sum > 0)
    .map(
      ([k, label, n]) =>
        `<span class="s-${k}" style="width:${((n / sum) * 100).toFixed(3)}%" title="${e(label)}: ${formatInt(n)}"></span>`,
    )
    .join('');
  const keys = parts
    .map(
      ([k, label, n]) =>
        `<span><span class="sw s-${k}"></span>${e(label)} <b class="num">${e(formatCompact(n))}</b> <span class="mut">${e(formatPct(n, sum))}</span></span>`,
    )
    .join('');
  return `<div class="comp"><div class="sbar" role="img" aria-label="token breakdown">${bar}</div><div class="keys">${keys}</div></div>`;
}

function hero(report: Report): string {
  const t = report.totals.all;
  const rebuild = report.findings.find((f) => f.analyzer === 'cache-rebuild');
  const rebuilds = typeof rebuild?.data?.rebuilds === 'number' ? rebuild.data.rebuilds : 0;
  const subagents = report.sessions.filter((s) => s.isSubagent).length;
  const tiles = [
    tile(
      'tokens processed',
      formatCompact(sumTotals(t)),
      'measured',
      `${e(formatInt(t.turns))} assistant turns in ${e(formatInt(report.sessions.length))} sessions${subagents ? ` (${subagents} subagent)` : ''}`,
    ),
    tile(
      'cache hit ratio',
      formatRatio(t.cacheHitRatio),
      'measured',
      'cache read ÷ everything sent as input',
    ),
    tile(
      'written to cache again by rebuilds',
      formatCompact(rebuild?.tokens.value ?? 0),
      'measured',
      rebuild
        ? `${e(formatInt(rebuilds))} rebuilds · ${e(formatPct(rebuild.tokens.value, t.cacheWrite))} of all cache writes`
        : 'no cache rebuilds found',
      rebuild ? 'alert' : '',
    ),
    tile(
      'output',
      formatCompact(t.output),
      'measured',
      `${e(formatPct(t.output, sumTotals(t)))} of all tokens`,
    ),
  ];
  return `<h2 class="sr">Summary (measured)</h2><div class="hero">${tiles.join('')}</div>`;
}

// Same paths as ICON in client.ts (16×16 box, stroked).
const LEGEND_ICONS: Record<string, string> = {
  rebuild: 'M12.5 5.5A5 5 0 1 0 13 9M12.5 1.8v3.9H8.6',
  compaction: 'M3 3h10M3 13h10M8 5v6M5.5 8.5 8 11l2.5-2.5',
  idle: 'M5.5 3.5v9M10.5 3.5v9',
  model: 'M8 2.5 13.5 8 8 13.5 2.5 8Z',
};
const legendIcon = (k: string): string =>
  `<svg class="ic ic-${k}" width="13" height="13" viewBox="0 0 16 16" aria-hidden="true"><path d="${LEGEND_ICONS[k] ?? ''}"/></svg>`;

function replaySection(tl: Timeline): string {
  if (tl.sessions.length === 0) return '';
  const omitted =
    tl.omitted.sessions > 0
      ? ` ${formatInt(tl.omitted.sessions)} smaller sessions (${formatInt(tl.omitted.turns)} turns) are left out to keep this file small.`
      : '';
  return (
    `<section id="replay"><h2>Session replay</h2>` +
    `<p class="sub">Every assistant turn, in order: how much context it sent and how much of that came from the cache. ` +
    `Press play to watch the context fill up; the replay stops at cache rebuilds, compactions and long idle gaps. ` +
    `Token counts are measured; tool result sizes are estimated (~chars/4).${e(omitted)}</p>` +
    `<div class="panelbox">` +
    `<div class="rp-ctl"><label class="sr" for="rp-session">session</label><select id="rp-session"></select>` +
    `<button type="button" id="rp-play" aria-pressed="false">▶ Play</button>` +
    `<button type="button" id="rp-prev" title="previous turn (←)">◀</button><button type="button" id="rp-next" title="next turn (→)">▶</button>` +
    `<button type="button" id="rp-jump" title="next event (n)">next event ⇥</button>` +
    `<label class="sr" for="rp-speed">speed</label><select id="rp-speed"><option value="0.5">0.5×</option><option value="1" selected>1×</option><option value="2">2×</option><option value="4">4×</option></select>` +
    `<label class="sr" for="rp-scrub">turn</label><input id="rp-scrub" type="range" min="0" max="0" value="0"></div>` +
    `<div class="rp-grid"><div class="rp-chartwrap"><div id="rp-chart"></div><div id="rp-tip" role="tooltip"></div>` +
    `<div class="legend"><span><span class="sw s-read"></span>cache read</span><span><span class="sw s-write"></span>cache write</span>` +
    `<span><span class="sw s-input"></span>uncached input</span><span><span class="sw s-output"></span>output</span>` +
    `<span>${legendIcon('rebuild')} cache rebuild</span><span>${legendIcon('compaction')} compaction</span>` +
    `<span>${legendIcon('idle')} idle past the cache TTL</span><span>${legendIcon('model')} model switch</span></div>` +
    `<div id="rp-lanes"></div></div>` +
    `<aside id="rp-panel" aria-live="off"></aside></div>` +
    `<h3 class="sr">Events</h3><div id="rp-log" style="margin-top:14px"></div>` +
    `<p id="rp-status" class="sr" aria-live="polite"></p>` +
    `</div></section>` +
    `<script type="application/json" id="tl-data">${scriptJson(tl)}</script>`
  );
}

function dailyChart(report: Report): string {
  const days = Object.entries(report.totals.byDay).sort((a, b) => (a[0] < b[0] ? -1 : 1));
  if (days.length < 2) return '';
  const W = 1000;
  const H = 220;
  const padL = 52;
  const padB = 22;
  const plotH = H - padB - 8;
  const max = Math.max(...days.map(([, t]) => sumTotals(t)));
  const nice = (v: number): number => {
    const p = Math.pow(10, Math.floor(Math.log10(v)));
    return ([1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].find((m) => m * p >= v) ?? 10) * p;
  };
  const yMax = max > 0 ? nice(max) : 1;
  const slot = (W - padL) / days.length;
  const bw = Math.min(24, Math.max(2, slot - 4));
  let g = '';
  for (let k = 0; k <= 4; k++) {
    const y = 8 + plotH - (plotH * k) / 4;
    g += `<line class="grid" x1="${padL}" x2="${W}" y1="${y}" y2="${y}"/><text class="tick" x="${padL - 6}" y="${y + 4}" text-anchor="end">${e(formatCompact((yMax * k) / 4))}</text>`;
  }
  const every = Math.ceil(days.length / 10);
  days.forEach(([day, t], i) => {
    const x = padL + slot * i + (slot - bw) / 2;
    let y = 8 + plotH;
    const segs: [string, number][] = [
      ['read', t.cacheRead],
      ['write', t.cacheWrite],
      ['input', t.input],
      ['output', t.output],
    ];
    for (const [k, v] of segs) {
      const h = (v / yMax) * plotH;
      if (h < 0.5) continue;
      y -= h;
      g += `<rect class="c-${k}" x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(0.5, h - 1).toFixed(1)}"><title>${e(day)} · ${e(k)} ${formatInt(v)}</title></rect>`;
    }
    if (i % every === 0)
      g += `<text class="tick" x="${(x + bw / 2).toFixed(1)}" y="${H - 6}" text-anchor="middle">${e(day.slice(5))}</text>`;
  });
  return (
    `<section id="days"><h2>Tokens per day (measured)</h2><p class="sub">UTC days, stacked by kind. Hover a column for exact numbers; the sessions table below has them too.</p>` +
    `<div class="panelbox"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="tokens per day">${g}</svg></div></section>`
  );
}

function docsLink(url: string): string {
  // Plain navigation links only, never loaded automatically; rel=noreferrer leaks nothing.
  if (/^https:\/\/[^\s"'<>]+$/.test(url)) {
    return ` · <a href="${e(url)}" rel="noreferrer">docs</a>`;
  }
  return ` · docs: ${e(url)}`;
}

const SEV_ICON: Record<string, string> = { high: '▲', warn: '●', info: '○' };

function findingCard(
  f: Finding,
  n: number,
  roots: string[],
  home: string,
  tl: Timeline | undefined,
): string {
  const cmd = findingCommand(f);
  const causes = causeRows(f)
    .map(
      (c) =>
        `<li>${formatInt(c.count)} × ${e(c.cause)}${c.tokens !== undefined ? ` (${e(formatTokens(c.tokens, c.tokensKind ?? f.tokens.kind))}${c.tokensKind ? ` ${kindTag(c.tokensKind)}` : ''})` : ''}${c.fix ? ` → ${e(c.fix)}` : ''}</li>`,
    )
    .join('');
  const evidence = f.evidence
    .map(
      (ev) =>
        `<tr><td>${tl?.turnRefs[ev.turnUuid] ? `<button type="button" class="go" data-turn="${e(ev.turnUuid)}">▶ replay</button>` : ''}</td>` +
        `<td><code>${e(shortId(ev.sessionId))}</code></td>` +
        `<td>${ev.source ? `<code>${e(relSource(ev.source, roots, home))}</code>` : ''}</td><td>${e(ev.detail)}</td></tr>`,
    )
    .join('');
  const tokens = !(f.tokens.value <= 0)
    ? `${e(formatTokens(f.tokens.value, f.tokens.kind))}${badge(f.tokens.kind)}`
    : '';
  const fix =
    `<p class="fix">→ ${e(f.fix.summary)}${f.fix.docsUrl ? docsLink(f.fix.docsUrl) : ''}</p>` +
    (f.fix.diff ? `<pre><code>${e(f.fix.diff)}</code></pre>` : '');
  return (
    `<article class="card" id="f${n}"><div class="hd"><div><span class="sev sev-${e(f.severity)}">${SEV_ICON[f.severity] ?? ''} ${e(f.severity)}</span> ` +
    `<span class="an">${n}. ${e(analyzerHeading(f.analyzer))}</span></div><div class="tk">${tokens}</div></div>` +
    `<div class="tt">${e(f.title)}${cmd ? ` <code>${e(cmd)}</code>` : ''}</div>` +
    (causes ? `<ul class="causes">${causes}</ul>` : '') +
    fix +
    (f.evidence.length
      ? `<details class="ev"><summary>${f.evidence.length} evidence</summary><div class="wrap"><table>` +
        `<tr><th></th><th>session</th><th>source</th><th>detail</th></tr>${evidence}</table></div></details>`
      : '') +
    `</article>`
  );
}

function sessionsTable(report: Report, home: string): string {
  const rows = report.sessions
    .map((s) => {
      const t = s.totals;
      return (
        `<tr><td><code>${e(shortId(s.id))}</code></td><td>${e(displayProject(s.project, home))}</td><td>${s.isSubagent ? 'subagent' : 'main'}</td>` +
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
    `<div class="wrap panelbox"><table><tr><th>session</th><th>project</th><th>kind</th><th>first turn</th><th class="n">turns</th>` +
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
      ? `<p class="sev-warn">${e(warn.join(' · '))}. Run <code>tknxray doctor</code> for details.</p>`
      : '') +
    `<div class="panelbox"><table>${rows.map(([k, v]) => `<tr><th>${e(k)}</th><td>${v}</td></tr>`).join('')}</table></div>`
  );
}

export function renderHtml(report: Report, opts: HtmlOptions = {}): string {
  const home = resolveHome(opts.homeDir);
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
  const tl = opts.timeline;
  const body = [
    `<header class="top"><div><h1>tknxray <span>report</span></h1><p>${e(subtitle)}</p></div>` +
      `<div class="pills"><span class="pill">local only · nothing loaded from the network</span>` +
      `<span class="pill">prompt and file contents: ${report.includeContent ? 'included (--include-content)' : 'not included'}</span>` +
      `<button type="button" id="theme" class="pill">theme: auto</button></div></header>`,
    hero(report),
    `<h2 class="sr">Token breakdown (measured)</h2>`,
    composition(t),
    tl ? replaySection(tl) : '',
    attr.length
      ? `<h2>Where it went (estimated)</h2><p class="sub">Tokens the analyzers attribute to a cause. Estimates overlap and are not savings.</p>` +
        `<div class="panelbox wrap"><table><tr><th>analyzer</th><th class="n">tokens</th><th class="n">findings</th><th>by tool</th></tr>` +
        attr
          .map(
            (r) =>
              `<tr><td>${e(r.analyzer)}</td><td class="n">${e(formatTokens(r.tokens, 'estimated'))}${badge('estimated')}</td>` +
              `<td class="n">${r.findings}</td><td>${e(r.byTool.map((x) => `${x.tool} ${formatRatio(x.share)}`).join(', '))}</td></tr>`,
          )
          .join('') +
        `</table></div>`
      : '',
    `<h2>Findings</h2>`,
    findings.length
      ? `<p class="sub">Most severe first. Each one points at the session and log line it came from` +
        `${tl ? '; ▶ replay jumps to that turn' : ''}. <button id="toggle" type="button">expand / collapse all evidence</button></p>` +
        `<div class="cards">${findings.map((f, i) => findingCard(f, i + 1, report.stats.roots, home, tl)).join('')}</div>`
      : '<p class="mut">No findings in this window.</p>',
    dailyChart(report),
    `<h2>Sessions (measured)</h2>`,
    report.sessions.length ? sessionsTable(report, home) : '<p class="mut">No sessions found.</p>',
    `<h2>Parse stats</h2>`,
    parseStatsSection(report, home),
    `<h2>Legend</h2><p>${badge('measured')} ${e(LEGEND_MEASURED)}<br>${badge('estimated')} ${e(LEGEND_ESTIMATED)}</p>`,
    `<footer>Local-only report generated by tknxray ${e(report.tool.version)}. ` +
      `It was built from files on this machine and loads nothing from the network.</footer>`,
  ].join('\n');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:">
<meta name="referrer" content="no-referrer">
<title>tknxray report</title>
<style>${CSS}</style>
</head>
<body>
<main>
${body}
</main>
<script>(${reportClient.toString()})();</script>
</body>
</html>
`;
}
