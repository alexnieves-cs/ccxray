/// <reference lib="dom" />
// Browser code of the HTML report: the session replay and the small page behaviors. It is
// embedded into the page with Function.prototype.toString, so it must stay self-contained: no
// imports, no references to module scope, plain ES2020. It reads the timeline from the
// `<script type="application/json" id="tl-data">` element and never touches the network.
//
// Every string that comes from the logs (tool and model names, labels) goes through esc()
// before it reaches innerHTML.

export function reportClient(): void {
  const doc = document;
  const $ = (sel: string): HTMLElement | null => doc.querySelector(sel);

  // ---- theme toggle (auto / light / dark); the choice is a per-viewer convenience ----
  const root = doc.documentElement;
  const themeBtn = $('#theme');
  const THEMES = ['auto', 'light', 'dark'];
  const applyTheme = (t: string): void => {
    if (t === 'auto') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', t);
    if (themeBtn) themeBtn.textContent = 'theme: ' + t;
  };
  let theme = 'auto';
  try {
    theme = localStorage.getItem('tknxray-theme') || 'auto';
  } catch {
    /* storage can be blocked for file:// pages */
  }
  applyTheme(theme);
  themeBtn?.addEventListener('click', () => {
    theme = THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length]!;
    applyTheme(theme);
    try {
      localStorage.setItem('tknxray-theme', theme);
    } catch {
      /* ignore */
    }
  });

  // ---- expand / collapse all evidence ----
  $('#toggle')?.addEventListener('click', () => {
    const d = doc.querySelectorAll<HTMLDetailsElement>('details.ev');
    const open = !Array.prototype.every.call(d, (x: HTMLDetailsElement) => x.open);
    d.forEach((x) => (x.open = open));
  });

  const dataEl = $('#tl-data');
  if (!dataEl) return;

  interface Tool {
    n: number;
    c: number;
    e?: 1;
    p?: 1;
    a?: number;
  }
  interface TTurn {
    t: number;
    r: number;
    w: number;
    i: number;
    o: number;
    m: number;
    g: number | null;
    x?: Tool[];
  }
  interface Mark {
    k: string;
    at: number;
    label: string;
    tokens?: number;
    cause?: string;
  }
  interface TSession {
    id: string;
    label: string;
    sub: boolean;
    parent?: number;
    agentId?: string;
    agentType?: string;
    spawnTurn?: number;
    returnTurn?: number;
    project: string;
    ttl: string;
    turns: TTurn[];
    marks: Mark[];
    peak: number;
    total: number;
    window: number;
  }
  interface TL {
    tools: string[];
    models: string[];
    sessions: TSession[];
    turnRefs: Record<string, [number, number]>;
    omitted: { sessions: number; turns: number };
  }
  /** All marks that fall on one turn; `k` is the most important kind among them. */
  interface Group {
    at: number;
    k: string;
    marks: Mark[];
  }

  const tl = JSON.parse(dataEl.textContent || '{}') as TL;
  if (!tl.sessions || tl.sessions.length === 0) return;

  const esc = (s: unknown): string =>
    String(s).replace(/[&<>"']/g, (c) => '&#' + c.charCodeAt(0) + ';');
  const int = (n: number): string => Math.round(n).toLocaleString('en-US');
  const compact = (n: number): string => {
    const a = Math.abs(n);
    if (a >= 1e9) return (n / 1e9).toFixed(a >= 1e10 ? 0 : 1) + 'B';
    if (a >= 1e6) return (n / 1e6).toFixed(a >= 1e7 ? 0 : 1) + 'M';
    if (a >= 1e3) return (n / 1e3).toFixed(a >= 1e4 ? 0 : 1) + 'k';
    return String(Math.round(n));
  };
  // Same wording as formatDuration in src/analyzers/util.ts, so labels and the panel agree.
  const dur = (ms: number): string => {
    const sec = Math.round(ms / 1000);
    if (sec < 60) return sec + 's';
    const m = Math.floor(sec / 60);
    if (m < 60) return sec % 60 === 0 ? m + 'm' : m + 'm ' + (sec % 60) + 's';
    return m % 60 === 0 ? Math.floor(m / 60) + 'h' : Math.floor(m / 60) + 'h ' + (m % 60) + 'm';
  };
  const clock = (ms: number): string => {
    const d = new Date(ms);
    const p = (x: number): string => String(x).padStart(2, '0');
    const mon = d.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' });
    return `${mon} ${d.getUTCDate()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} UTC`;
  };
  const ctxOf = (t: TTurn): number => t.r + t.w + t.i;
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

  const PRIORITY = ['rebuild', 'compaction', 'idle', 'version', 'model'];
  const MARK_TEXT: Record<string, string> = {
    rebuild: 'Cache rebuild',
    compaction: 'Compaction',
    model: 'Model switch',
    version: 'Claude Code upgrade',
    idle: 'Idle past the cache TTL',
  };
  // Icons are SVG paths in a 16×16 box, so they render the same with any font.
  const ICON: Record<string, string> = {
    rebuild: 'M12.5 5.5A5 5 0 1 0 13 9M12.5 1.8v3.9H8.6',
    compaction: 'M3 3h10M3 13h10M8 5v6M5.5 8.5 8 11l2.5-2.5',
    idle: 'M5.5 3.5v9M10.5 3.5v9',
    model: 'M8 2.5 13.5 8 8 13.5 2.5 8Z',
    version: 'M8 13V3M4 7l4-4 4 4',
  };
  const icon = (k: string, size = 14): string =>
    `<svg class="ic ic-${k}" width="${size}" height="${size}" viewBox="0 0 16 16" aria-hidden="true"><path d="${ICON[k] || ICON.model}"/></svg>`;

  // ---- elements ----
  const sel = $('#rp-session') as HTMLSelectElement;
  const chart = $('#rp-chart')!;
  const lanes = $('#rp-lanes')!;
  const panel = $('#rp-panel')!;
  const log = $('#rp-log')!;
  const tip = $('#rp-tip')!;
  const playBtn = $('#rp-play') as HTMLButtonElement;
  const speedSel = $('#rp-speed') as HTMLSelectElement;
  const scrub = $('#rp-scrub') as HTMLInputElement;
  const status = $('#rp-status')!;

  // Session picker: main sessions, each followed by its subagents.
  const order: number[] = [];
  tl.sessions.forEach((s, i) => {
    if (s.sub && s.parent !== undefined) return;
    order.push(i);
    tl.sessions.forEach((c, j) => {
      if (c.sub && c.parent === i) order.push(j);
    });
  });
  sel.innerHTML = order
    .map((i) => {
      const s = tl.sessions[i]!;
      const pre = s.sub && s.parent !== undefined ? '   └ ' : '';
      return `<option value="${i}">${esc(pre + s.label + ' · ' + s.turns.length + ' turns · ' + compact(s.total) + ' tokens')}</option>`;
    })
    .join('');

  let cur = 0; // session index
  let pos = 0; // fractional turn cursor
  let playing = false;
  let hold = 0; // ms left to pause on a mark
  let lastStop = -1; // turn of the last group the replay paused on
  let last = 0;
  let groups: Group[] = [];
  let geom = { x0: 0, w: 0 };

  const S = (): TSession => tl.sessions[cur]!;

  function groupMarks(s: TSession): Group[] {
    const by = new Map<number, Mark[]>();
    for (const m of s.marks) {
      const list = by.get(m.at) || [];
      list.push(m);
      by.set(m.at, list);
    }
    return [...by.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([at, marks]) => {
        marks.sort((a, b) => PRIORITY.indexOf(a.k) - PRIORITY.indexOf(b.k));
        return { at, k: marks[0]!.k, marks };
      });
  }

  function niceMax(v: number): number {
    if (v <= 0) return 1;
    const p = Math.pow(10, Math.floor(Math.log10(v)));
    for (const m of [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (m * p >= v) return m * p;
    return 10 * p;
  }

  // Static layers are drawn once per session and size; the cursor and the reveal per frame.
  function draw(): void {
    const s = S();
    const W = Math.max(300, chart.clientWidth);
    const narrow = W < 560;
    const H = narrow ? 250 : 320;
    const padL = 44;
    const padR = 10;
    const marksH = 28;
    const outH = 42;
    const gap = 22;
    const plotTop = marksH + 4;
    const plotH = H - plotTop - outH - gap - 20;
    const n = s.turns.length;
    const w = W - padL - padR;
    const xAt = (i: number): number => padL + (n <= 1 ? w / 2 : (i / (n - 1)) * w);
    const yMax = niceMax(Math.max(...s.turns.map(ctxOf)));
    const yAt = (v: number): number => plotTop + plotH - (v / yMax) * plotH;
    const oMax = niceMax(Math.max(1, ...s.turns.map((t) => t.o)));
    const outTop = plotTop + plotH + gap;
    geom = { x0: padL, w };

    // Stacked areas, bottom to top: cache read, cache write, uncached input.
    const layers: [string, (t: TTurn) => number][] = [
      ['read', (t) => t.r],
      ['write', (t) => t.r + t.w],
      ['input', (t) => t.r + t.w + t.i],
    ];
    const area = (hi: (t: TTurn) => number, lo: (t: TTurn) => number): string => {
      if (n === 0) return '';
      let d = '';
      s.turns.forEach(
        (t, i) => (d += (i ? 'L' : 'M') + xAt(i).toFixed(1) + ',' + yAt(hi(t)).toFixed(1)),
      );
      for (let i = n - 1; i >= 0; i--)
        d += 'L' + xAt(i).toFixed(1) + ',' + yAt(lo(s.turns[i]!)).toFixed(1);
      return d + 'Z';
    };
    const zero = (): number => 0;
    const paths = layers
      .map(([k, hi], li) => {
        const lo = li === 0 ? zero : layers[li - 1]![1];
        return `<path class="a-${k}" d="${area(hi, lo)}"/>`;
      })
      .join('');
    let grid = '';
    for (let k = 0; k <= 4; k++) {
      const v = (yMax / 4) * k;
      const y = yAt(v);
      grid += `<line class="${k ? 'grid' : 'base'}" x1="${padL}" x2="${W - padR}" y1="${y}" y2="${y}"/>`;
      grid += `<text class="tick" x="${padL - 6}" y="${y + 4}" text-anchor="end">${compact(v)}</text>`;
    }
    if (s.window <= yMax * 1.001) {
      const y = yAt(s.window);
      grid += `<line class="win" x1="${padL}" x2="${W - padR}" y1="${y}" y2="${y}"/><text class="tick" x="${W - padR}" y="${y - 4}" text-anchor="end">context window ${compact(s.window)} (assumed)</text>`;
    }
    const step = niceMax(Math.max(1, n / (narrow ? 4 : 7)));
    for (let i = 0; i < n; i += step)
      if (xAt(i) < W - padR - 44)
        grid += `<text class="tick" x="${xAt(i)}" y="${H - 3}" text-anchor="middle">${i + 1}</text>`;
    grid += `<text class="tick" x="${W - padR}" y="${H - 3}" text-anchor="end">turn →</text>`;
    // Output gets its own small chart and scale (one axis per chart).
    const bw = Math.max(1, Math.min(5, w / Math.max(1, n) - 1));
    let outBars = '';
    s.turns.forEach((t, i) => {
      const h = (t.o / oMax) * outH;
      if (h > 0.3)
        outBars += `<rect x="${(xAt(i) - bw / 2).toFixed(1)}" y="${(outTop + outH - h).toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}" rx="${Math.min(1.5, bw / 2)}"/>`;
    });
    let marks = '';
    groups.forEach((g, gi) => {
      const x = xAt(g.at);
      if (g.k === 'rebuild' || g.k === 'compaction')
        marks += `<line class="mk-line mk-${g.k}" x1="${x}" x2="${x}" y1="${plotTop}" y2="${plotTop + plotH}"/>`;
      marks +=
        `<g class="mk mk-${g.k}" data-group="${gi}" transform="translate(${x.toFixed(1)},${marksH / 2})">` +
        `<circle r="10"/><g transform="translate(-7,-7) scale(.875)"><path d="${ICON[g.k] || ICON.model}"/></g>` +
        (g.marks.length > 1
          ? `<circle class="cnt" cx="8" cy="-7" r="5.5"/><text class="cntt" x="8" y="-4.5" text-anchor="middle">${g.marks.length}</text>`
          : '') +
        `</g>`;
    });

    chart.innerHTML =
      `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="context size per turn for ${esc(s.label)}">` +
      `<defs><clipPath id="rp-clip"><rect id="rp-cliprect" x="0" y="0" width="${padL}" height="${H}"/></clipPath></defs>` +
      grid +
      `<g class="ghost">${paths}<g class="out">${outBars}</g></g>` +
      `<g clip-path="url(#rp-clip)">${paths}<g class="out">${outBars}</g></g>` +
      `<line class="base" x1="${padL}" x2="${W - padR}" y1="${outTop + outH}" y2="${outTop + outH}"/>` +
      `<text class="lanelab" x="${padL}" y="${outTop - 6}">output per turn</text>` +
      `<text class="tick" x="${padL - 6}" y="${outTop + 8}" text-anchor="end">${compact(oMax)}</text>` +
      marks +
      `<line id="rp-cursor" class="cursor" x1="0" x2="0" y1="${plotTop - 2}" y2="${outTop + outH}"/>` +
      `</svg>`;

    drawLanes(padL, padR);
    drawLog();
    scrub.max = String(Math.max(0, n - 1));
    frame(true);
  }

  // Subagent lanes, on the parent's turn axis: from the turn that started each one to the turn
  // that got its result. The track lines up with the chart's x axis.
  function drawLanes(padL: number, padR: number): void {
    const s = S();
    const parentIdx = s.sub ? s.parent : cur;
    if (parentIdx === undefined) {
      lanes.innerHTML = s.sub
        ? '<p class="mut">The session that started this subagent is not in the report.</p>'
        : '';
      return;
    }
    const parent = tl.sessions[parentIdx]!;
    const kids = tl.sessions
      .map((c, j) => ({ c, j }))
      .filter(({ c }) => c.sub && c.parent === parentIdx && c.spawnTurn !== undefined);
    if (kids.length === 0) {
      lanes.innerHTML = '';
      return;
    }
    if (s.sub) {
      const pn = parent.turns.length;
      lanes.innerHTML =
        `<button type="button" class="back" data-s="${parentIdx}" data-at="${s.spawnTurn ?? 0}">↖ back to ${esc(parent.label)}</button>` +
        `<span class="mut"> · started at turn ${(s.spawnTurn ?? 0) + 1} of ${pn}${s.returnTurn !== undefined ? `, result at turn ${s.returnTurn + 1}` : ''}</span>`;
      return;
    }
    const n = parent.turns.length;
    const maxTotal = Math.max(...kids.map(({ c }) => c.total));
    const pct = (i: number): number => (n <= 1 ? 0 : (i / (n - 1)) * 100);
    const rows = kids
      .map(({ c, j }) => {
        const a = c.spawnTurn!;
        const b = Math.max(a, c.returnTurn ?? a);
        const weight = 0.3 + 0.7 * Math.sqrt(c.total / maxTotal);
        const left = pct(a);
        const label = `${c.label} · ${compact(c.total)} tokens · ${c.turns.length} turns`;
        return (
          `<button type="button" class="lane" data-s="${j}" data-a="${a}" data-b="${b}" title="${esc(label)} (open in replay)">` +
          `<span class="lb" style="left:${left.toFixed(2)}%;width:calc(${(pct(b) - left).toFixed(2)}% + 6px);opacity:${weight.toFixed(2)}"></span>` +
          `<span class="ll" style="${left > 55 ? `left:4px;right:calc(${(100 - left).toFixed(2)}% + 10px);text-align:right` : `left:calc(${left.toFixed(2)}% + 14px);right:4px`}">${esc(label)}</span></button>`
        );
      })
      .join('');
    lanes.innerHTML =
      `<div class="lanes-h" style="margin-left:${padL}px;margin-right:${padR}px"><span>${kids.length} subagent${kids.length > 1 ? 's' : ''}, placed at the turn that started them</span><span class="mut">click one to replay it</span></div>` +
      `<div class="lanebox" style="margin-left:${padL}px;margin-right:${padR}px">${rows}</div>`;
  }

  function drawLog(): void {
    if (groups.length === 0) {
      log.innerHTML =
        '<p class="mut">No cache rebuilds, compactions, idle gaps past the cache TTL or model switches in this session.</p>';
      return;
    }
    const s = S();
    log.innerHTML =
      '<ol>' +
      groups
        .map((g, gi) => {
          const t = s.turns[g.at]!;
          const main = g.marks[0]!;
          const also = g.marks.slice(1);
          return (
            `<li><button type="button" class="ev ev-${g.k}" data-group="${gi}">` +
            `<span class="g">${icon(g.k)}</span>` +
            `<span class="w">turn ${g.at + 1} · ${esc(clock(t.t))}</span>` +
            `<span class="d"><b>${esc(MARK_TEXT[main.k] || main.k)}</b>: ${esc(main.label)}` +
            (main.tokens
              ? ` · <span class="num">${int(main.tokens)}</span> tokens written again <i class="b m">M</i>`
              : '') +
            (main.cause ? ` · likely cause ${esc(main.cause)} <i class="b e">E</i>` : '') +
            (also.length
              ? `<span class="also">same turn: ${also.map((m) => esc(m.label)).join('; ')}</span>`
              : '') +
            `</span></button></li>`
          );
        })
        .join('') +
      '</ol>';
  }

  // Per-frame: cursor, reveal clip, panel. `force` redraws the panel even if the turn is the same.
  let shownTurn = -1;
  function frame(force = false): void {
    const s = S();
    const n = s.turns.length;
    const i = Math.min(n - 1, Math.max(0, Math.floor(pos)));
    const x = geom.x0 + (n <= 1 ? geom.w / 2 : (Math.min(pos, n - 1) / (n - 1)) * geom.w);
    const cursor = doc.getElementById('rp-cursor');
    cursor?.setAttribute('x1', String(x));
    cursor?.setAttribute('x2', String(x));
    doc.getElementById('rp-cliprect')?.setAttribute('width', String(x + 1));
    scrub.value = String(i);
    if (i === shownTurn && !force) return;
    shownTurn = i;
    renderPanel(i);
    lanes.querySelectorAll<HTMLElement>('.lane[data-a]').forEach((el) => {
      const a = Number(el.dataset.a);
      const b = Number(el.dataset.b);
      el.classList.toggle('live', i >= a && i <= b);
      el.classList.toggle('done', i > b);
    });
    log.querySelectorAll<HTMLElement>('.ev').forEach((el) => {
      const g = groups[Number(el.dataset.group)]!;
      el.classList.toggle('past', g.at <= i);
      el.classList.toggle('now', g.at === i);
    });
    chart.querySelectorAll<SVGGElement>('.mk').forEach((el) => {
      const g = groups[Number(el.getAttribute('data-group'))]!;
      el.classList.toggle('past', g.at <= i);
      el.classList.toggle('now', g.at === i);
    });
  }

  function bar(parts: [string, number][], total: number): string {
    return (
      '<span class="sbar">' +
      parts
        .filter(([, v]) => v > 0)
        .map(
          ([k, v]) =>
            `<span class="s-${k}" style="width:${Math.min(100, (v / total) * 100).toFixed(2)}%"></span>`,
        )
        .join('') +
      '</span>'
    );
  }

  function renderPanel(i: number): void {
    const s = S();
    const t = s.turns[i]!;
    const ctx = ctxOf(t);
    let readSum = 0;
    let writeSum = 0;
    let outSum = 0;
    let rebuildSum = 0;
    for (let k = 0; k <= i; k++) {
      const u = s.turns[k]!;
      readSum += u.r;
      writeSum += u.w + u.i;
      outSum += u.o;
    }
    for (const m of s.marks) if (m.k === 'rebuild' && m.at <= i) rebuildSum += m.tokens || 0;
    const g = groups.find((x) => x.at === i);
    const tools = t.x || [];
    const maxC = Math.max(1, ...tools.map((x) => x.c));
    const toolRows = tools
      .map((x) => {
        const name = tl.tools[x.n] || '?';
        const flags =
          (x.e ? ' <span class="flag err">error</span>' : '') +
          (x.p ? ' <span class="flag">output saved to a file by Claude Code</span>' : '') +
          (x.a !== undefined
            ? ` <button type="button" class="flag link" data-s="${x.a}">replay ${esc(tl.sessions[x.a]?.label || 'subagent')} →</button>`
            : '');
        return (
          `<li><span class="tn" title="${esc(name)}">${esc(name)}</span>` +
          `<span class="tbar"><span style="width:${((x.c / maxC) * 100).toFixed(1)}%"></span></span>` +
          `<span class="num">${x.c ? '~' + compact(x.c / 4) + ' <i class="b e">E</i>' : '–'}</span>${flags}</li>`
        );
      })
      .join('');
    const fill = Math.min(1, ctx / s.window);
    const callout = g
      ? g.marks
          .map(
            (m, mi) =>
              `<div class="callout c-${m.k}${mi ? ' minor' : ''}"><b>${icon(m.k)} ${esc(MARK_TEXT[m.k] || m.k)}</b><span>${esc(m.label)}</span>` +
              (m.tokens
                ? `<span class="big"><span class="num">${int(m.tokens)}</span> tokens written to the cache again <i class="b m">M</i></span>`
                : '') +
              (m.cause
                ? `<span class="mut">likely cause: ${esc(m.cause)} <i class="b e">E</i></span>`
                : '') +
              `</div>`,
          )
          .join('')
      : '';
    panel.innerHTML =
      `<div class="ph"><span class="turnno">Turn <b>${i + 1}</b> <span class="mut">of ${s.turns.length}</span></span>` +
      `<span class="mut">${esc(clock(t.t))}${t.g !== null && t.g > 60000 ? ' · ' + dur(t.g) + ' after the previous turn' : ''}</span>` +
      `<span class="mut">${esc(tl.models[t.m] || '?')}</span></div>` +
      callout +
      `<div class="gauge"><div class="gl"><span>Context sent</span><span><b class="num">${int(ctx)}</b> tokens <i class="b m">M</i></span></div>` +
      `<div class="gtrack">${bar(
        [
          ['read', t.r],
          ['write', t.w],
          ['input', t.i],
        ],
        s.window,
      )}</div>` +
      `<div class="gl mut"><span>${(fill * 100).toFixed(fill < 0.1 ? 1 : 0)}% of a ${compact(s.window)} window (assumed)</span><span>peak ${compact(s.peak)}</span></div></div>` +
      `<dl class="kv">` +
      `<div><dt><span class="sw s-read"></span>cache read</dt><dd class="num">${int(t.r)}</dd></div>` +
      `<div><dt><span class="sw s-write"></span>cache write</dt><dd class="num">${int(t.w)}</dd></div>` +
      `<div><dt><span class="sw s-input"></span>uncached input</dt><dd class="num">${int(t.i)}</dd></div>` +
      `<div><dt><span class="sw s-output"></span>output</dt><dd class="num">${int(t.o)}</dd></div>` +
      `</dl>` +
      (tools.length
        ? `<div class="tools"><div class="gl"><span>Tool calls</span><span class="mut">result size, tokens</span></div><ul>${toolRows}</ul></div>`
        : `<div class="tools mut">No tool calls this turn.</div>`) +
      `<div class="run"><div class="gl"><span>Session so far</span><span class="mut">measured</span></div>` +
      `<div class="runrow"><span><b class="num">${compact(readSum)}</b> read from cache</span>` +
      `<span><b class="num">${compact(writeSum)}</b> written or uncached</span>` +
      `<span><b class="num">${compact(outSum)}</b> output</span>` +
      `<span class="${rebuildSum ? 'hl' : ''}"><b class="num">${compact(rebuildSum)}</b> rewritten by rebuilds</span></div></div>`;
    status.textContent = `Turn ${i + 1} of ${s.turns.length}${g ? ': ' + g.marks.map((m) => MARK_TEXT[m.k]).join(', ') : ''}`;
  }

  function setSession(i: number, at = 0): void {
    cur = i;
    sel.value = String(i);
    groups = groupMarks(S());
    pos = Math.min(at, S().turns.length - 1);
    lastStop = pos;
    shownTurn = -1;
    draw();
  }

  function setPlaying(p: boolean): void {
    playing = p;
    playBtn.innerHTML = p ? '❚❚&nbsp;Pause' : '▶&nbsp;Play';
    playBtn.setAttribute('aria-pressed', String(p));
    if (p) {
      if (pos >= S().turns.length - 1) {
        pos = 0;
        lastStop = -1;
      }
      last = performance.now();
      requestAnimationFrame(tick);
    }
  }

  function tick(now: number): void {
    if (!playing) return;
    const dt = Math.min(100, now - last);
    last = now;
    const s = S();
    if (hold > 0) {
      hold -= dt;
    } else {
      // Turns per second, so that any session plays in roughly 15-40 s at 1x.
      const base = Math.max(6, s.turns.length / 25);
      const next = pos + (dt / 1000) * base * Number(speedSel.value);
      const crossed = groups.find((g) => g.at > lastStop && g.at <= Math.floor(next));
      if (crossed && !reduced) {
        pos = crossed.at;
        lastStop = crossed.at;
        hold = crossed.k === 'rebuild' || crossed.k === 'compaction' ? 2200 : 1100;
      } else pos = next;
    }
    if (pos >= s.turns.length - 1) {
      pos = s.turns.length - 1;
      frame();
      setPlaying(false);
      return;
    }
    frame();
    requestAnimationFrame(tick);
  }

  const goTo = (i: number): void => {
    setPlaying(false);
    pos = Math.max(0, Math.min(S().turns.length - 1, i));
    lastStop = pos;
    frame();
  };

  // ---- interaction ----
  playBtn.addEventListener('click', () => setPlaying(!playing));
  sel.addEventListener('change', () => {
    setPlaying(false);
    setSession(Number(sel.value));
  });
  scrub.addEventListener('input', () => goTo(Number(scrub.value)));
  $('#rp-prev')?.addEventListener('click', () => goTo(Math.floor(pos) - 1));
  $('#rp-next')?.addEventListener('click', () => goTo(Math.floor(pos) + 1));
  $('#rp-jump')?.addEventListener('click', () => {
    const g = groups.find((x) => x.at > Math.floor(pos)) || groups[0];
    if (g) goTo(g.at);
  });

  const jumpTo = (si: number, ti: number): void => {
    setPlaying(false);
    if (si !== cur) setSession(si, ti);
    else goTo(ti);
    const box = $('#replay')!.getBoundingClientRect();
    if (box.top < 0 || box.top > innerHeight * 0.5)
      $('#replay')!.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'start' });
  };

  doc.addEventListener('click', (ev) => {
    const el = (ev.target as Element).closest('[data-s],[data-group],[data-turn]');
    if (!el) return;
    const d = (k: string): string | null => el.getAttribute(k);
    if (d('data-turn') !== null) {
      const ref = tl.turnRefs[d('data-turn')!];
      if (ref) jumpTo(ref[0], ref[1]);
    } else if (d('data-s') !== null) {
      jumpTo(Number(d('data-s')), Number(d('data-at') || 0));
    } else if (d('data-group') !== null) {
      const g = groups[Number(d('data-group'))];
      if (g) jumpTo(cur, g.at);
    }
  });

  // Hover tooltip, and click or drag on the chart to scrub.
  const turnFromEvent = (ev: MouseEvent): number => {
    const svg = chart.querySelector('svg');
    if (!svg) return 0;
    const r = svg.getBoundingClientRect();
    const n = S().turns.length;
    const x = ev.clientX - r.left - geom.x0;
    return Math.min(n - 1, Math.max(0, Math.round((x / geom.w) * (n - 1))));
  };
  let dragging = false;
  chart.addEventListener('mousedown', (ev) => {
    if ((ev.target as Element).closest('.mk')) return;
    dragging = true;
    goTo(turnFromEvent(ev));
  });
  window.addEventListener('mouseup', () => (dragging = false));
  chart.addEventListener('mousemove', (ev) => {
    const i = turnFromEvent(ev);
    if (dragging) goTo(i);
    const s = S();
    const t = s.turns[i]!;
    const mk = (ev.target as Element).closest('.mk');
    const g = mk ? groups[Number(mk.getAttribute('data-group'))] : undefined;
    tip.innerHTML = g
      ? `<b>Turn ${g.at + 1}</b>` +
        g.marks
          .map((m) => `<br>${icon(m.k, 12)} ${esc(MARK_TEXT[m.k] || m.k)}: ${esc(m.label)}`)
          .join('')
      : `<b>Turn ${i + 1}</b> · ${esc(clock(t.t))}<br>` +
        `<span class="sw s-read"></span>read ${int(t.r)}<br><span class="sw s-write"></span>write ${int(t.w)}<br>` +
        `<span class="sw s-input"></span>input ${int(t.i)}<br><span class="sw s-output"></span>output ${int(t.o)}` +
        (t.x && t.x.length
          ? `<br>${t.x.length} tool call${t.x.length > 1 ? 's' : ''}: ${esc(
              t.x
                .map((x) => tl.tools[x.n])
                .slice(0, 3)
                .join(', '),
            )}${t.x.length > 3 ? '…' : ''}`
          : '');
    const box = chart.getBoundingClientRect();
    const tx = ev.clientX - box.left;
    tip.style.display = 'block';
    const tw = tip.offsetWidth;
    tip.style.left = (tx + 16 + tw > box.width ? tx - 16 - tw : tx + 16) + 'px';
    tip.style.top = Math.max(0, ev.clientY - box.top - 20) + 'px';
  });
  chart.addEventListener('mouseleave', () => (tip.style.display = 'none'));

  // Keyboard, while the replay is on screen and focus is not in a form control:
  // space play/pause, ← → step, n next event.
  doc.addEventListener('keydown', (ev) => {
    const tag = (ev.target as HTMLElement).tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || ev.metaKey || ev.ctrlKey)
      return;
    const box = $('#replay')!.getBoundingClientRect();
    if (box.bottom < 0 || box.top > innerHeight) return;
    if (ev.key === ' ' && tag !== 'BUTTON') {
      ev.preventDefault();
      setPlaying(!playing);
    } else if (ev.key === 'ArrowRight') goTo(Math.floor(pos) + 1);
    else if (ev.key === 'ArrowLeft') goTo(Math.floor(pos) - 1);
    else if (ev.key === 'n') $('#rp-jump')?.click();
  });

  let resizeT = 0;
  window.addEventListener('resize', () => {
    clearTimeout(resizeT);
    resizeT = window.setTimeout(draw, 120);
  });

  // Start on the biggest session; play once when the replay first scrolls into view.
  setSession(order[0] ?? 0);
  if (!reduced && 'IntersectionObserver' in window) {
    let started = false;
    const io = new IntersectionObserver(
      (entries) => {
        if (!started && entries.some((x) => x.isIntersecting)) {
          started = true;
          io.disconnect();
          setPlaying(true);
        }
      },
      { threshold: 0.4 },
    );
    io.observe($('#replay')!);
  }
}
