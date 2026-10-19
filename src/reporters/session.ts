// `tknxray session` renderer (SPEC §3): one row per assistant turn. Pure; ≤ 100 columns.
// Every token number here is measured (usage fields); the big-output flag compares an
// estimate [E]. No prompt, file or command content is shown: tool names only.
import {
  displayProject,
  formatCompact,
  formatInt,
  formatRatio,
  formatUtc,
  formatVersionRange,
  padEnd,
  padStart,
  resolveHome,
  sanitizeText,
  shortId,
  truncate,
  visibleWidth,
  wrapParts,
} from './format.js';

export type TurnFlag = 'rebuild' | 'dup-read' | 'big-output';

export interface SessionRow {
  /** `main`, or `agent-<id>` for a subagent's turns. */
  chain: string;
  /** 1-based position in its chain. */
  n: number;
  uuid: string;
  ts: string;
  gapMs: number | null;
  /** The gap is longer than the cache TTL that applies to this session (SPEC §5 A3 a). */
  gapOverTtl: boolean;
  model: string;
  ccVersion: string | null;
  synthetic: boolean;
  input: number;
  cacheWrite: number;
  cacheRead: number;
  output: number;
  /** Tool calls in this turn by name, in first-call order. */
  tools: Record<string, number>;
  flags: TurnFlag[];
}

export interface UsageSum {
  input: number;
  cacheWrite: number;
  cacheRead: number;
  output: number;
  turns: number;
}

export interface SubagentSummary extends UsageSum {
  id: string;
  agentId: string | null;
  models: string[];
  /** `n` of the main-chain row whose tool_use spawned it, when linked. */
  spawnedAt: number | null;
}

export interface SessionView {
  id: string;
  project: string;
  ccVersions: string[];
  firstTs: string;
  lastTs: string;
  ttlMs: number;
  bigOutputTokens: number;
  totals: UsageSum;
  rows: SessionRow[];
  subagents: SubagentSummary[];
  /** Sidechain turns found inside the main transcript (not shown as rows). */
  inlineSidechainTurns: number;
}

export interface SessionRenderOptions {
  /** Plain ASCII flags and punctuation (NO_COLOR or a non-UTF-8 locale). */
  ascii: boolean;
  homeDir?: string;
}

const WIDTH = 100;
const FLAG: Record<TurnFlag, [string, string]> = {
  rebuild: ['🔁', 'R'],
  'dup-read': ['📄', 'D'],
  'big-output': ['📦', 'B'],
};
const ASCII_MAP: Record<string, string> = {
  '…': '~',
  '×': 'x',
  '·': '|',
  '–': '-',
  '─': '-',
  '≥': '>=',
};

/** `45s`, `6m05s`, `2h03m`, `3d04h`; `-` for the first turn. */
export function formatGap(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return '-';
  const s = Math.max(0, Math.round(ms / 1000));
  const p2 = (n: number) => String(n).padStart(2, '0');
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m${p2(s % 60)}s`;
  if (s < 86400) return `${Math.floor(s / 3600)}h${p2(Math.floor((s % 3600) / 60))}m`;
  return `${Math.floor(s / 86400)}d${p2(Math.floor((s % 86400) / 3600))}h`;
}

/** Exact count when it fits the column, else compact (`12.3M`). */
const num = (n: number, w: number): string =>
  padStart(formatInt(n).length <= w ? formatInt(n) : formatCompact(n), w);

const shortModel = (m: string): string => m.replace(/^claude-/, '');

function toolsCell(tools: Record<string, number>, ascii: boolean): string {
  const entries = Object.entries(tools).map(([n, c], i) => ({ n: sanitizeText(n), c, i }));
  entries.sort((a, b) => b.c - a.c || a.i - b.i);
  return entries.map((e) => (e.c > 1 ? `${e.n}${ascii ? 'x' : '×'}${e.c}` : e.n)).join(', ');
}

// Column layout: widths and a 1-space gap; tools get what is left of WIDTH.
const COLS = { n: 4, time: 8, gap: 7, model: 12, input: 7, cw: 8, cr: 9, out: 7, flags: 6 };
// A row is: 2-space indent, the 8 columns before flags joined by 1 space (7 gaps), 2 spaces,
// flags, 2 spaces, tools.
export const TOOLS_W = WIDTH - 2 - Object.values(COLS).reduce((a, b) => a + b, 0) - 7 - 2 - 2;

function row(r: SessionRow, ascii: boolean): string {
  const flags = r.flags.map((f) => FLAG[f][ascii ? 1 : 0]).join('');
  const tools = r.synthetic ? 'API error' : toolsCell(r.tools, ascii);
  return (
    '  ' +
    [
      padStart(String(r.n), COLS.n),
      r.ts.slice(11, 19),
      padEnd(formatGap(r.gapMs) + (r.gapOverTtl ? '*' : ''), COLS.gap),
      padEnd(truncate(sanitizeText(shortModel(r.model)), COLS.model), COLS.model),
      num(r.input, COLS.input),
      num(r.cacheWrite, COLS.cw),
      num(r.cacheRead, COLS.cr),
      num(r.output, COLS.out),
    ].join(' ') +
    '  ' +
    padEnd(flags, COLS.flags) +
    '  ' +
    truncate(tools, TOOLS_W)
  ).trimEnd();
}

function header(): string {
  return (
    '  ' +
    [
      padStart('#', COLS.n),
      padEnd('time UTC', COLS.time),
      padEnd('gap', COLS.gap),
      padEnd('model', COLS.model),
      padStart('input', COLS.input),
      padStart('c.write', COLS.cw),
      padStart('c.read', COLS.cr),
      padStart('output', COLS.out),
    ].join(' ') +
    '  ' +
    padEnd('flags', COLS.flags) +
    '  tools'
  );
}

/** `2026-10-01 23:58–00:04 UTC`, or with the end date when the UTC day changes. */
export function formatSpan(fromIso: string, toIso: string): string {
  const a = formatUtc(fromIso).slice(0, 16);
  const b = formatUtc(toIso).slice(0, 16);
  return a.slice(0, 10) === b.slice(0, 10) ? `${a}–${b.slice(11)} UTC` : `${a} – ${b} UTC`;
}

const hitRatio = (t: UsageSum): number | null => {
  const d = t.input + t.cacheWrite + t.cacheRead;
  return d > 0 ? t.cacheRead / d : null;
};

export function renderSessionView(v: SessionView, opts: SessionRenderOptions): string {
  const home = resolveHome(opts.homeDir);
  const { ascii } = opts;
  const t = v.totals;
  const lines = [
    ...wrapParts(
      [
        `tknxray session ${shortId(v.id)}`,
        sanitizeText(displayProject(v.project, home)),
        `Claude Code ${sanitizeText(formatVersionRange(v.ccVersions))}`,
        formatSpan(v.firstTs, v.lastTs),
      ],
      ' · ',
      WIDTH,
      '  ',
    ),
    // Each measured number is its own part, so wrapping never cuts one.
    ...wrapParts(
      [
        `TOKENS [M]  input ${formatInt(t.input)}`,
        `cache write ${formatInt(t.cacheWrite)}`,
        `cache read ${formatInt(t.cacheRead)}`,
        `output ${formatInt(t.output)}`,
        `hit ratio ${formatRatio(hitRatio(t))}`,
        `${t.turns} turns`,
      ],
      ' · ',
      WIDTH,
      '  ',
    ),
    '',
    header(),
  ];
  let day = '';
  for (const r of v.rows) {
    if (r.ts.slice(0, 10) !== day) {
      day = r.ts.slice(0, 10);
      lines.push(`  ── ${day} ──`);
    }
    lines.push(row(r, ascii));
  }
  if (v.rows.length === 0) lines.push('  (no main-chain assistant turns)');
  if (v.inlineSidechainTurns > 0)
    lines.push(`  + ${v.inlineSidechainTurns} sidechain turns inside the main transcript`);

  if (v.subagents.length > 0) {
    lines.push('', `SUBAGENTS (${v.subagents.length}) [M]`);
    lines.push(
      '  ' +
        [
          padEnd('agent', 14),
          padEnd('model', 16),
          padStart('turns', 5),
          padStart('input', 7),
          padStart('c.write', 9),
          padStart('c.read', 10),
          padStart('output', 7),
          padStart('from #', 6),
        ].join(' '),
    );
    for (const a of v.subagents)
      lines.push(
        '  ' +
          [
            padEnd(truncate(sanitizeText(a.agentId ?? shortId(a.id)), 14), 14),
            padEnd(truncate(sanitizeText(a.models.map(shortModel).join(',')), 16), 16),
            padStart(String(a.turns), 5),
            num(a.input, 7),
            num(a.cacheWrite, 9),
            num(a.cacheRead, 10),
            num(a.output, 7),
            padStart(a.spawnedAt === null ? '-' : `#${a.spawnedAt}`, 6),
          ].join(' '),
      );
  }
  const ttl = formatGap(v.ttlMs).replace(/00s$/, '').replace(/00m$/, '');
  lines.push(
    '',
    `flags: ${FLAG.rebuild[ascii ? 1 : 0]} cache rebuild (A2) · ` +
      `${FLAG['dup-read'][ascii ? 1 : 0]} repeated read · ` +
      `${FLAG['big-output'][ascii ? 1 : 0]} output ≥ ~${formatCompact(v.bigOutputTokens)} tokens [E] · ` +
      `* gap > cache TTL ${ttl}`,
  );
  const text = lines.map((l) => (visibleWidth(l) > WIDTH ? truncate(l, WIDTH) : l)).join('\n');
  return `${ascii ? text.replace(/[…×·–─≥]/g, (c) => ASCII_MAP[c]!) : text}\n`;
}
