// Shared formatting helpers for all reporters. Pure and deterministic: no locale, no timezone
// (everything is UTC), no terminal-width probing. See CLAUDE.md hard rules 2 and 4.
import type { SourcePointer, TokenKind } from '../model/index.js';

/** `1318` → `1,318`. Fixed format, independent of the host locale. */
export function formatInt(n: number): string {
  const sign = n < 0 ? '-' : '';
  const digits = String(Math.round(Math.abs(n)));
  return sign + digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** Compact token count: `950`, `6.3k`, `31k`, `1.2M`, `28.4M`, `1.1B`. */
export function formatCompact(n: number): string {
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  if (abs < 1_000) return sign + String(Math.round(abs));
  if (abs < 10_000) return sign + trimZero((abs / 1_000).toFixed(1)) + 'k';
  if (Math.round(abs / 1_000) < 1_000) return sign + String(Math.round(abs / 1_000)) + 'k';
  if (Number((abs / 1_000_000).toFixed(1)) < 1_000) {
    return sign + trimZero((abs / 1_000_000).toFixed(1)) + 'M';
  }
  return sign + trimZero((abs / 1_000_000_000).toFixed(1)) + 'B';
}

function trimZero(s: string): string {
  return s.endsWith('.0') ? s.slice(0, -2) : s;
}

/** Integer percentage of `part / whole`: `24%`, `<1%` for tiny non-zero parts, `-` when whole is 0. */
export function formatPct(part: number, whole: number): string {
  if (whole <= 0) return '-';
  return formatRatio(part / whole);
}

/** A 0..1 ratio as a percentage, or `n/a` for null. */
export function formatRatio(ratio: number | null): string {
  if (ratio === null || !Number.isFinite(ratio)) return 'n/a';
  if (ratio > 0 && ratio < 0.005) return '<1%';
  return `${Math.round(ratio * 100)}%`;
}

/** Measured numbers are exact counts; estimates get a `~` prefix. */
export function formatTokens(value: number, kind: TokenKind): string {
  return kind === 'estimated' ? `~${formatCompact(value)}` : formatCompact(value);
}

/** Short label shown next to a number: `[M]` measured, `[E]` estimated. */
export function kindTag(kind: TokenKind): string {
  return kind === 'measured' ? '[M]' : '[E]';
}

export const LEGEND_MEASURED = 'measured: taken directly from usage fields in the logs';
export const LEGEND_ESTIMATED = 'estimated: chars/4 heuristic or attribution guess, never exact';
export const LEGEND = `[M] ${LEGEND_MEASURED} · [E] / ~ ${LEGEND_ESTIMATED}`;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** UTC date range: `Oct 11–18 2026`, `Sep 28–Oct 4 2026`, `Dec 30 2025–Jan 2 2026`. */
export function formatDateRange(fromIso: string, toIso: string): string {
  const a = new Date(fromIso);
  const b = new Date(toIso);
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return 'unknown dates';
  const [ay, am, ad] = [a.getUTCFullYear(), a.getUTCMonth(), a.getUTCDate()];
  const [by, bm, bd] = [b.getUTCFullYear(), b.getUTCMonth(), b.getUTCDate()];
  if (ay === by && am === bm && ad === bd) return `${MONTHS[am]} ${ad} ${ay}`;
  if (ay === by && am === bm) return `${MONTHS[am]} ${ad}–${bd} ${ay}`;
  if (ay === by) return `${MONTHS[am]} ${ad}–${MONTHS[bm]} ${bd} ${ay}`;
  return `${MONTHS[am]} ${ad} ${ay}–${MONTHS[bm]} ${bd} ${by}`;
}

/** `2026-10-18T09:05:00.000Z` → `2026-10-18 09:05 UTC`. */
export function formatUtc(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
}

/** Numeric-aware version compare, e.g. 2.1.99 < 2.1.100. */
export function compareVersions(a: string, b: string): number {
  return a.localeCompare(b, 'en', { numeric: true });
}

/** `2.1.290–2.1.296`, or a single version, or `unknown version`. */
export function formatVersionRange(versions: readonly string[]): string {
  const sorted = [...new Set(versions)].sort(compareVersions);
  if (sorted.length === 0) return 'unknown version';
  if (sorted.length === 1) return sorted[0] as string;
  return `${sorted[0]}–${sorted[sorted.length - 1]}`;
}

function normalizeSlashes(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '');
}

function startsWithPath(file: string, root: string): boolean {
  // Windows paths compare case-insensitively; POSIX ones exactly.
  const ci = /^[a-z]:\//i.test(root);
  const f = ci ? file.toLowerCase() : file;
  const r = ci ? root.toLowerCase() : root;
  return f.startsWith(r + '/');
}

/**
 * Render an evidence pointer as `<project>/<file>.jsonl:<line>`, relative to the projects root
 * it lives under. Never returns an absolute path: when no root matches, falls back to the last
 * two path segments (project dir + file name). CLAUDE.md hard rule 4.
 */
export function relSource(source: SourcePointer, roots: readonly string[]): string {
  return `${relFile(source.file, roots)}:${source.line}`;
}

export function relFile(file: string, roots: readonly string[]): string {
  const f = normalizeSlashes(file);
  const matches = roots.map(normalizeSlashes).filter((r) => r && startsWithPath(f, r));
  const root = matches.sort((x, y) => y.length - x.length)[0];
  if (root !== undefined) return f.slice(root.length + 1);
  const parts = f.split('/').filter(Boolean);
  return parts.slice(-2).join('/');
}

/** Replace the home directory prefix with `~` so shared reports don't reveal a username. */
export function displayRoot(root: string, homeDir: string | undefined): string {
  const r = normalizeSlashes(root);
  const h = homeDir ? normalizeSlashes(homeDir) : '';
  if (h && (r === h || startsWithPath(r, h))) return '~' + r.slice(h.length);
  return r;
}

/**
 * First two tokens of a shell command (SPEC §5 A5), e.g. `pnpm test --reporter verbose` →
 * `pnpm test`. Leading `VAR=value` assignments are dropped so secrets never reach a report.
 */
export function shortCommand(cmd: string): string {
  const tokens = cmd.trim().split(/\s+/).filter(Boolean);
  while (tokens.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0] as string)) tokens.shift();
  return tokens.slice(0, 2).join(' ');
}

/** First 8 characters of a session id, e.g. `3fa2c1d0`. */
export function shortId(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id;
}

// ANSI escape sequences (SGR only; that is all the terminal reporter emits).
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;]*m/g;

export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '');
}

/** Visible width in columns. Assumes no wide (CJK/emoji) characters, which reporters avoid. */
export function visibleWidth(s: string): number {
  return [...stripAnsi(s)].length;
}

/** Cut `s` to at most `width` visible columns, ending in `…` when cut. ANSI-aware. */
export function truncate(s: string, width: number): string {
  if (visibleWidth(s) <= width) return s;
  if (width <= 0) return '';
  let out = '';
  let cols = 0;
  let sawAnsi = false;
  for (let i = 0; i < s.length;) {
    if (s[i] === '\x1b') {
      // eslint-disable-next-line no-control-regex
      const m = /^\x1b\[[0-9;]*m/.exec(s.slice(i));
      if (m) {
        out += m[0];
        sawAnsi = true;
        i += m[0].length;
        continue;
      }
    }
    const ch = String.fromCodePoint(s.codePointAt(i) as number);
    if (cols === width - 1) break;
    out += ch;
    cols += 1;
    i += ch.length;
  }
  return out + '…' + (sawAnsi ? '\x1b[0m' : '');
}

/** Pad with spaces to `width` visible columns (never truncates). */
export function padEnd(s: string, width: number): string {
  return s + ' '.repeat(Math.max(0, width - visibleWidth(s)));
}

export function padStart(s: string, width: number): string {
  return ' '.repeat(Math.max(0, width - visibleWidth(s))) + s;
}

/** Join parts with `sep`, wrapping onto new lines (prefixed by `indent`) to stay within `width`. */
export function wrapParts(
  parts: readonly string[],
  sep: string,
  width: number,
  indent = '',
): string[] {
  const lines: string[] = [];
  let cur = '';
  for (const part of parts) {
    if (cur === '') cur = part;
    else if (visibleWidth(cur + sep + part) <= width) cur += sep + part;
    else {
      lines.push(cur);
      cur = indent + part;
    }
  }
  if (cur !== '') lines.push(cur);
  return lines.map((l) => truncate(l, width));
}

/**
 * Whether to emit ANSI colors: NO_COLOR (any non-empty value) wins, then FORCE_COLOR
 * (`0`/`false` disables, anything else enables), then whether the stream is a TTY.
 */
export function shouldUseColor(
  env: Record<string, string | undefined>,
  isTTY: boolean | undefined,
): boolean {
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') return false;
  const force = env.FORCE_COLOR;
  if (force !== undefined) return !(force === '0' || force.toLowerCase() === 'false');
  return isTTY === true;
}
