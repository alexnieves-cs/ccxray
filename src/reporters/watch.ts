// `tknxray watch` frame renderer (SPEC §3). Pure: the same session, options and `now` always give
// the same string, so frames can be snapshot-tested. The I/O loop is src/commands/watch.ts.
//
// Token numbers are measured [M] (usage fields); tool-result sizes, the rebuild cause, the cache
// TTL and the context window are estimates or assumptions and are labeled so. No prompt, tool
// input or tool output text is ever shown: tool names and sizes only (CLAUDE.md rule 4).
//
// ToS (CLAUDE.md rule 5): the idle line says how long ago the last turn was and which cache TTL
// applies; past the TTL it says the cache has likely expired. It never suggests sending anything
// to keep the cache alive and shows no countdown.
import { countCompactions } from '../analyzers/context-growth.js';
import { findRebuilds, type Rebuild } from '../analyzers/cache-rebuild.js';
import { cacheTtlMs, chain, contextTokens, sessionTtl, turnTokens } from '../analyzers/rules.js';
import { DEFAULT_THRESHOLDS, type Session, type Thresholds, type Turn } from '../model/index.js';
import {
  displayProject,
  formatCompact,
  formatInt,
  formatRatio,
  formatUtc,
  padStart,
  palette,
  resolveHome,
  sanitizeText,
  shortId,
  truncate,
  visibleWidth,
  wrapParts,
  type Palette,
} from './format.js';
import { formatGap } from './session.js';

export const WATCH_MIN_WIDTH = 60;
export const WATCH_MAX_WIDTH = 120;

/** Context windows the gauge assumes (see `assumedWindow`). */
export const WINDOW_DEFAULT = 200_000;
export const WINDOW_LARGE = 1_000_000;

export interface WatchFrameOptions {
  /** Terminal columns; clamped to 60..120. */
  width: number;
  /** Epoch ms used for "ago" times. */
  now: number;
  /** Epoch ms of the last poll of the files (defaults to `now`). */
  polledAt?: number;
  /** Subagent sessions of `session` (parentSessionId = session.id). */
  subagents?: readonly Session[];
  thresholds?: Thresholds;
  color?: boolean;
  homeDir?: string;
  /** `live`: polling, keys work. `once`: a single frame (--once or stdout not a TTY). */
  mode?: 'live' | 'once';
  /** A status line shown under the header, e.g. a read error on the last poll. */
  note?: string;
}

const BLOCKS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];
const CHART_ROWS = 4;
const GLYPH = { read: '█', write: '▓', input: '▒', empty: '░' } as const;
const REBUILD_MARK = '↻';
const COMPACTION_MARK = '◆';

const shortModel = (m: string): string => sanitizeText(m.replace(/^claude-/, ''));
const clockUtc = (ms: number): string => new Date(ms).toISOString().slice(11, 19) + ' UTC';

/**
 * The context window the gauge compares against: 1,000,000 when any turn's context exceeded
 * 200,000 (only a 1M-context model can have done that), else 200,000.
 * UNVERIFIED: the window is not logged; a session that never went over 200k may still run with a
 * 1M window. Shown as "(assumed)".
 */
export function assumedWindow(contexts: readonly number[]): number {
  return contexts.some((c) => c > WINDOW_DEFAULT) ? WINDOW_LARGE : WINDOW_DEFAULT;
}

/** Bucket `xs` into `n` columns keeping each bucket's max; returns [from, to) turn ranges too. */
export function bucketMax(
  xs: readonly number[],
  n: number,
): { value: number; from: number; to: number }[] {
  if (xs.length <= n) return xs.map((value, i) => ({ value, from: i, to: i + 1 }));
  const out: { value: number; from: number; to: number }[] = [];
  for (let i = 0; i < n; i++) {
    const from = Math.floor((i * xs.length) / n);
    const to = Math.floor(((i + 1) * xs.length) / n);
    let value = 0;
    for (let j = from; j < to; j++) value = Math.max(value, xs[j]!);
    out.push({ value, from, to });
  }
  return out;
}

/** One cell of an area chart row: `level` in eighths of a row, `row` 0 = bottom. */
function cell(level: number, row: number): string {
  const base = row * 8;
  if (level >= base + 8) return BLOCKS[7]!;
  if (level > base) return BLOCKS[level - base - 1]!;
  return ' ';
}

interface Facts {
  s: Session;
  turns: Turn[];
  contexts: number[];
  rebuilds: Map<string, Rebuild>;
  /** Turn indexes that follow a compaction marker. */
  compactedAt: Set<number>;
  compactions: number;
  th: Thresholds;
}

function facts(s: Session, th: Thresholds): Facts {
  const turns = chain(s).filter((t) => !t.isSynthetic);
  const rebuilds = new Map(findRebuilds([s], th).map((r) => [r.turn.uuid, r]));
  const compactedAt = new Set<number>();
  for (const e of s.events) {
    if (e.kind !== 'compaction' || turns.length === 0) continue;
    const i = turns.findIndex((t) => t.ts >= e.ts);
    compactedAt.add(i === -1 ? turns.length - 1 : i);
  }
  return {
    s,
    turns,
    contexts: turns.map((t) => contextTokens(t.usage)),
    rebuilds,
    compactedAt,
    compactions: countCompactions(s),
    th,
  };
}

function header(f: Facts, o: WatchFrameOptions, p: Palette, w: number, home: string): string[] {
  const last = f.turns[f.turns.length - 1];
  const version = last?.ccVersion ?? f.s.ccVersions[f.s.ccVersions.length - 1];
  const polled = o.polledAt ?? o.now;
  const live =
    o.mode === 'once'
      ? p.dim(`○ snapshot ${clockUtc(polled)}`)
      : `${p.green('●')} live · polled ${clockUtc(polled)}`;
  return wrapParts(
    [
      p.bold('tknxray watch'),
      sanitizeText(displayProject(f.s.project, home)),
      shortId(sanitizeText(f.s.id)),
      ...(last ? [shortModel(last.model)] : []),
      `Claude Code ${version !== undefined ? sanitizeText(version) : 'unknown'}`,
      `${formatInt(f.turns.length)} turns`,
      `started ${formatUtc(new Date(f.s.firstTs).toISOString())}`,
      live,
    ],
    ' · ',
    w,
    '  ',
  );
}

function gauge(f: Facts, p: Palette, w: number): string[] {
  const i = f.turns.length - 1;
  const t = f.turns[i]!;
  const u = t.usage;
  const total = contextTokens(u);
  const win = assumedWindow(f.contexts);
  const peak = Math.max(...f.contexts);
  const peakAt = f.contexts.indexOf(peak) + 1;
  const barW = w - 4;
  const cols = (x: number): number => Math.min(barW, Math.round((x / win) * barW));
  const r = cols(u.cacheRead);
  const rw = Math.max(r, cols(u.cacheRead + u.cacheWrite));
  const all = Math.max(rw, cols(total));
  const bar =
    p.green(GLYPH.read.repeat(r)) +
    p.yellow(GLYPH.write.repeat(rw - r)) +
    p.magenta(GLYPH.input.repeat(all - rw)) +
    p.dim(GLYPH.empty.repeat(barW - all));
  return [
    `${p.bold('CONTEXT')}  latest turn #${i + 1} [M]`,
    `  ${bar}${total > win ? p.red('▶') : ''}`,
    ...wrapParts(
      [
        `  ${p.bold(formatInt(total))} of ${formatInt(win)} (assumed window)`,
        formatRatio(total / win),
        `session peak ${formatInt(peak)} at #${peakAt}`,
      ],
      ' · ',
      w,
      '  ',
    ),
    ...wrapParts(
      [
        `  ${p.green(GLYPH.read)} cache read ${formatInt(u.cacheRead)}`,
        `${p.yellow(GLYPH.write)} cache write ${formatInt(u.cacheWrite)}`,
        `${p.magenta(GLYPH.input)} uncached input ${formatInt(u.input)}`,
      ],
      '   ',
      w,
      '  ',
    ),
  ];
}

function chart(f: Facts, p: Palette, w: number): string[] {
  const peak = Math.max(...f.contexts);
  const top = formatCompact(peak);
  const lw = Math.max(top.length, 1);
  const width = w - 2 - lw - 2;
  const buckets = bucketMax(f.contexts, width);
  const perCol = Math.ceil(f.contexts.length / buckets.length);
  const rebuildIdx = new Set(
    f.turns.map((t, i) => (f.rebuilds.has(t.uuid) ? i : -1)).filter((i) => i >= 0),
  );
  const any = (b: { from: number; to: number }, set: ReadonlySet<number>): boolean => {
    for (let j = b.from; j < b.to; j++) if (set.has(j)) return true;
    return false;
  };
  const levels = buckets.map((b) =>
    peak > 0 && b.value > 0 ? Math.max(1, Math.round((b.value / peak) * CHART_ROWS * 8)) : 0,
  );
  const prefix = (label: string, axis: string): string => `  ${padStart(label, lw)} ${axis}`;
  const lines = [
    `${p.bold('CONTEXT PER TURN')} [M]  ` +
      (perCol > 1 ? `max of up to ${perCol} turns per column` : 'one column per turn'),
  ];
  for (let row = CHART_ROWS - 1; row >= 0; row--) {
    const label = row === CHART_ROWS - 1 ? top : row === 0 ? '0' : '';
    const cells = buckets
      .map((b, c) => {
        const ch = cell(levels[c]!, row);
        return any(b, rebuildIdx) ? p.red(ch) : p.cyan(ch);
      })
      .join('');
    lines.push(prefix(label, '│') + cells);
  }
  if (rebuildIdx.size > 0)
    lines.push(
      prefix('', ' ') +
        buckets.map((b) => (any(b, rebuildIdx) ? p.red(REBUILD_MARK) : ' ')).join(''),
    );
  if (f.compactedAt.size > 0)
    lines.push(
      prefix('', ' ') +
        buckets.map((b) => (any(b, f.compactedAt) ? p.yellow(COMPACTION_MARK) : ' ')).join(''),
    );
  const first = '#1';
  const lastLabel = `#${f.turns.length}`;
  const axis =
    buckets.length > first.length + lastLabel.length
      ? first + ' '.repeat(buckets.length - first.length - lastLabel.length) + lastLabel
      : lastLabel;
  lines.push(prefix('', ' ') + p.dim(axis));
  const legend = [
    ...(rebuildIdx.size > 0 ? [`${p.red(REBUILD_MARK)} cache rebuild (A2)`] : []),
    ...(f.compactedAt.size > 0 ? [`${p.yellow(COMPACTION_MARK)} after a compaction`] : []),
  ];
  if (legend.length > 0) lines.push(...wrapParts(legend, '   ', w, '  ').map((l) => `  ${l}`));
  return lines;
}

function latest(f: Facts, p: Palette, w: number): string[] {
  const i = f.turns.length - 1;
  const t = f.turns[i]!;
  const u = t.usage;
  const ctx = contextTokens(u);
  const lines = wrapParts(
    [
      `${p.bold('LATEST TURN')} #${i + 1}`,
      clockUtc(t.ts),
      shortModel(t.model),
      `gap ${formatGap(t.gapMs)}`,
    ],
    ' · ',
    w,
    '  ',
  );
  lines.push(
    ...wrapParts(
      [
        `  cache read ${formatInt(u.cacheRead)}`,
        `cache write ${formatInt(u.cacheWrite)}`,
        `input ${formatInt(u.input)}`,
        `output ${formatInt(u.output)} [M]`,
        `hit ratio ${formatRatio(ctx > 0 ? u.cacheRead / ctx : null)} [M]`,
      ],
      ' · ',
      w,
      '  ',
    ),
  );
  const max = 8;
  const tools = t.toolUses.slice(0, max).map((tu) => {
    const results = t.toolResults.filter((r) => r.toolUseId === tu.id);
    const name = sanitizeText(tu.name);
    if (results.length === 0) return `${name} (no result yet)`;
    const est = results.reduce((a, r) => a + r.estTokens, 0);
    const persisted = results.some((r) => r.persisted !== undefined) ? ' persisted' : '';
    return `${name} ~${formatCompact(est)}${persisted}`;
  });
  if (t.toolUses.length > max) tools.push(`+${t.toolUses.length - max} more`);
  lines.push(
    ...(tools.length > 0
      ? wrapParts(
          [`  tools (result ~tokens [E]): ${tools[0]}`, ...tools.slice(1)],
          ' · ',
          w,
          '    ',
        )
      : ['  tools: none']),
  );
  const rb = f.rebuilds.get(t.uuid);
  if (rb !== undefined)
    lines.push(
      ...wrapParts(
        [
          `  ${p.red(`${REBUILD_MARK} rebuild`)}: rewrote ${formatInt(u.cacheWrite)} [M]`,
          `likely cause ${rb.cause} [E]: ${sanitizeText(rb.detail)}`,
        ],
        ' · ',
        w,
        '    ',
      ),
    );
  else lines.push(`  not a rebuild (A2)`);
  const lastAny = f.s.turns.filter((x) => f.s.isSubagent || !x.isSidechain).at(-1);
  if (lastAny?.isSynthetic) lines.push(p.yellow('  newest response is an API error (no usage)'));
  return lines;
}

function totals(f: Facts, subs: readonly Session[], p: Palette, w: number): string[] {
  const sum = { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 };
  for (const t of f.turns) {
    sum.input += t.usage.input;
    sum.cacheWrite += t.usage.cacheWrite;
    sum.cacheRead += t.usage.cacheRead;
    sum.output += t.usage.output;
  }
  const ctx = sum.input + sum.cacheWrite + sum.cacheRead;
  const rewritten = [...f.rebuilds.values()].reduce((a, r) => a + r.turn.usage.cacheWrite, 0);
  const lines = [
    `${p.bold('SESSION SO FAR')} [M]`,
    ...wrapParts(
      [
        `  input ${formatInt(sum.input)}`,
        `cache write ${formatInt(sum.cacheWrite)}`,
        `cache read ${formatInt(sum.cacheRead)}`,
        `output ${formatInt(sum.output)}`,
        `hit ratio ${formatRatio(ctx > 0 ? sum.cacheRead / ctx : null)}`,
      ],
      ' · ',
      w,
      '  ',
    ),
    ...wrapParts(
      [
        `  rewritten by rebuilds ${formatInt(rewritten)} [M]`,
        `${f.rebuilds.size} ${f.rebuilds.size === 1 ? 'rebuild' : 'rebuilds'}`,
        `${f.compactions} ${f.compactions === 1 ? 'compaction' : 'compactions'}`,
      ],
      ' · ',
      w,
      '  ',
    ),
  ];
  if (subs.length === 0) {
    lines.push('  subagents: none so far');
    return lines;
  }
  const per = subs.map((x) => {
    const real = x.turns.filter((t) => !t.isSynthetic);
    return {
      name: sanitizeText(x.agentId ?? shortId(x.id)),
      models: [...new Set(real.map((t) => shortModel(t.model)))].join(','),
      turns: real.length,
      tokens: real.reduce((a, t) => a + turnTokens(t.usage), 0),
    };
  });
  // Largest first, so the "+N more" tail is the small ones.
  per.sort((a, b) => b.tokens - a.tokens);
  const all = per.reduce((a, x) => a + x.tokens, 0);
  const shown = 6;
  lines.push(
    ...wrapParts(
      [
        `  subagents ${subs.length} · ${formatInt(all)} tokens [M]`,
        ...per
          .slice(0, shown)
          .map(
            (x) =>
              `${x.name} (${x.models || '?'}, ${x.turns} ${x.turns === 1 ? 'turn' : 'turns'}) ${formatCompact(x.tokens)}`,
          ),
        ...(per.length > shown ? [`+${per.length - shown} more`] : []),
      ],
      ' · ',
      w,
      '    ',
    ),
  );
  return lines;
}

function idle(f: Facts, o: WatchFrameOptions, p: Palette, w: number): string[] {
  const last = f.turns[f.turns.length - 1]!;
  const ago = Math.max(0, o.now - last.ts);
  const ttl = sessionTtl(f.s);
  const ttlMs = cacheTtlMs(f.s, f.th);
  const split = f.s.turns.some(
    (t) => t.usage.cacheWrite5m !== undefined || t.usage.cacheWrite1h !== undefined,
  );
  const lines = wrapParts(
    [
      `${p.bold('IDLE')}  last turn ${formatGap(ago)} ago`,
      `cache TTL ${ttl} ` +
        (split ? '(from the cache-write split) [E]' : '(no cache-write split logged) [E]'),
    ],
    ' · ',
    w,
    '      ',
  );
  // "A gap exactly equal to the TTL is not an expiry" (SPEC §5 M2 notes), same as A3.
  if (ago > ttlMs)
    lines.push(p.yellow('      cache has likely expired; the next turn will rebuild it [E]'));
  return lines;
}

/** Render one full frame (no trailing newline handling beyond `\n` per line). Pure. */
export function renderWatchFrame(session: Session, opts: WatchFrameOptions): string {
  const w = Math.max(
    WATCH_MIN_WIDTH,
    Math.min(Number.isFinite(opts.width) ? Math.floor(opts.width) : 100, WATCH_MAX_WIDTH),
  );
  const p = palette(opts.color === true);
  const home = resolveHome(opts.homeDir);
  const f = facts(session, opts.thresholds ?? DEFAULT_THRESHOLDS);
  const rule = p.dim('─'.repeat(w));
  const lines = [...header(f, opts, p, w, home)];
  if (opts.note !== undefined) lines.push(p.yellow(sanitizeText(opts.note)));
  lines.push(rule);
  if (f.turns.length === 0) {
    lines.push('  waiting for the first assistant turn', rule);
  } else {
    lines.push(
      ...gauge(f, p, w),
      '',
      ...chart(f, p, w),
      rule,
      ...latest(f, p, w),
      '',
      ...totals(f, opts.subagents ?? [], p, w),
      '',
      ...idle(f, opts, p, w),
      rule,
    );
  }
  lines.push(
    p.dim('[M] measured from usage fields · [E] estimate or assumption, never exact'),
    (opts.mode === 'once'
      ? 'one frame (--once or output is not a terminal)'
      : 'q or Ctrl-C to quit') + ' · local only, reads files, sends nothing',
  );
  return lines.map((l) => (visibleWidth(l) > w ? truncate(l, w) : l).trimEnd()).join('\n') + '\n';
}
