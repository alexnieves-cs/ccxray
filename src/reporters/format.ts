// Shared formatting helpers for all reporters. Pure and deterministic: no locale, no timezone
// (everything is UTC), no terminal-width probing. See CLAUDE.md hard rules 2 and 4.
import { homedir } from 'node:os';
import type { SourcePointer, TokenKind } from '../model/index.js';

/** The home directory to hide from reports: the caller's choice, else os.homedir(). */
export function resolveHome(homeDir?: string): string {
  if (homeDir !== undefined) return homeDir;
  try {
    return homedir();
  } catch {
    return '';
  }
}

/** `1318` → `1,318`. Fixed format, independent of the host locale. */
export function formatInt(n: number): string {
  if (!Number.isFinite(n)) return 'n/a';
  const sign = n < 0 ? '-' : '';
  const digits = String(Math.round(Math.abs(n)));
  return sign + digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** Compact token count: `950`, `6.3k`, `31k`, `1.2M`, `28.4M`, `1.1B`. */
export function formatCompact(n: number): string {
  if (!Number.isFinite(n)) return 'n/a';
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
  if (!Number.isFinite(part) || !Number.isFinite(whole)) return 'n/a';
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

/**
 * US dollars at list prices: `$1,234`, `$93.12`, `$0.42`, `<$0.01`, `$0`. Always an estimate;
 * callers add the [E] label.
 */
export function formatUsd(n: number): string {
  if (!Number.isFinite(n)) return 'n/a';
  if (n < 0) return `-${formatUsd(-n)}`;
  if (n === 0) return '$0';
  if (n < 0.005) return '<$0.01';
  if (n >= 1_000) return `$${formatInt(n)}`;
  return `$${n.toFixed(2)}`;
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

/** Windows paths (drive letter, or running on win32) compare case-insensitively. */
function caseInsensitive(p: string): boolean {
  return /^[a-z]:\//i.test(p) || process.platform === 'win32';
}

function startsWithPath(file: string, root: string): boolean {
  const ci = caseInsensitive(root);
  const f = ci ? file.toLowerCase() : file;
  const r = ci ? root.toLowerCase() : root;
  return f.startsWith(r + '/');
}

function samePath(a: string, b: string): boolean {
  return caseInsensitive(b) ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/**
 * Project dir names encode the cwd (`/home/dev/src/api` → `-home-dev-src-api`). Collapse the
 * encoded home prefix to `~` (`~-src-api`) so a shared report doesn't reveal the username.
 * UNVERIFIED: which characters Claude Code replaces with `-`; both `/ \ :` only and every
 * non-alphanumeric character are tried.
 */
export function displayProject(project: string, homeDir?: string): string {
  const home = normalizeSlashes(resolveHome(homeDir));
  if (!home) return project;
  const encoded = [
    ...new Set([home.replace(/[/\\:]/g, '-'), home.replace(/[^A-Za-z0-9]/g, '-')]),
  ].sort((a, b) => b.length - a.length);
  const ci = caseInsensitive(home);
  const p = ci ? project.toLowerCase() : project;
  for (const enc of encoded) {
    const e = ci ? enc.toLowerCase() : enc;
    if (p === e) return '~';
    if (p.startsWith(e + '-')) return '~' + project.slice(enc.length);
  }
  return project;
}

/**
 * Render an evidence pointer as `<project>/<file>.jsonl:<line>`, relative to the projects root
 * it lives under. Never returns an absolute path: when no root matches, falls back to the last
 * two path segments (project dir + file name). CLAUDE.md hard rule 4.
 */
export function relSource(
  source: SourcePointer,
  roots: readonly string[],
  homeDir?: string,
): string {
  return `${relFile(source.file, roots, homeDir)}:${source.line}`;
}

export function relFile(file: string, roots: readonly string[], homeDir?: string): string {
  const f = normalizeSlashes(file);
  const matches = roots.map(normalizeSlashes).filter((r) => r && startsWithPath(f, r));
  const root = matches.sort((x, y) => y.length - x.length)[0];
  const parts =
    root !== undefined
      ? f.slice(root.length + 1).split('/')
      : f.split('/').filter(Boolean).slice(-2);
  if (parts.length > 1) parts[0] = displayProject(parts[0] as string, homeDir);
  return parts.join('/');
}

/** Replace the home directory prefix with `~` so shared reports don't reveal a username. */
export function displayRoot(root: string, homeDir?: string): string {
  const r = normalizeSlashes(root);
  const h = normalizeSlashes(resolveHome(homeDir));
  if (h && (samePath(r, h) || startsWithPath(r, h))) return '~' + r.slice(h.length);
  return r;
}

/** Split a shell command into words, honoring quotes, and stop at the first `;`, `&`, `|`. */
function shellWords(cmd: string): string[] {
  const words: string[] = [];
  let cur = '';
  let inWord = false;
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i] as string;
    if (quote) {
      if (ch === quote) quote = null;
      else if (ch === '\\' && quote === '"' && i + 1 < cmd.length) cur += cmd[++i];
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      inWord = true;
    } else if (ch === '\\' && i + 1 < cmd.length) {
      cur += cmd[++i];
      inWord = true;
    } else if (/\s/.test(ch) || ch === ';' || ch === '&' || ch === '|') {
      if (inWord) words.push(cur);
      cur = '';
      inWord = false;
      if (!/\s/.test(ch)) return words;
    } else {
      cur += ch;
      inWord = true;
    }
  }
  if (inWord) words.push(cur);
  return words;
}

const PREFIX_WORDS = new Set(['env', 'export', 'sudo', 'command', 'exec', 'nohup', 'time']);

/**
 * First two words of a shell command (SPEC §5 A5, §9), e.g. `pnpm test --reporter verbose` →
 * `pnpm test`. Leading `env` / `export` / `sudo` (and their flags) and `VAR=value` assignments
 * are skipped, parsing stops at `;`, `&&`, `|`, and a word that still contains `=` is shown as
 * `…`, so secrets passed inline never reach a report.
 */
export function shortCommand(cmd: string): string {
  const words = shellWords(cmd.trim());
  let i = 0;
  let afterPrefix = false;
  while (i < words.length) {
    const w = words[i] as string;
    if (PREFIX_WORDS.has(w)) afterPrefix = true;
    else if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) afterPrefix = true;
    else if (!(afterPrefix && w.startsWith('-'))) break;
    i++;
  }
  return words
    .slice(i, i + 2)
    .map((w) => (w.includes('=') ? '…' : w))
    .join(' ');
}

/** First 8 characters of a session id, e.g. `3fa2c1d0`. */
export function shortId(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id;
}

// SGR sequences: the only escapes the terminal reporter emits itself.
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;]*m/g;
// eslint-disable-next-line no-control-regex
const ANSI_PREFIX_RE = /^\x1b\[[0-9;]*m/;
// Any escape sequence (CSI, OSC, other ESC-x) plus C0/C1 control characters and DEL.
const UNSAFE_RE =
  // eslint-disable-next-line no-control-regex
  /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b[@-_]?|[\x00-\x1f\x7f-\x9f]/g;

export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '');
}

/**
 * Make a data-derived string safe to print: escape sequences (e.g. OSC title changes) are
 * removed and other control characters (newlines, tabs, C1) become spaces.
 */
export function sanitizeText(s: string): string {
  return s.replace(UNSAFE_RE, (m) => (m.length === 1 && m !== '\x1b' ? ' ' : ''));
}

/** Columns a code point takes: 0 for combining marks, 2 for East Asian wide and emoji. */
export function charWidth(cp: number): number {
  if (
    (cp >= 0x300 && cp <= 0x36f) ||
    cp === 0x200d ||
    (cp >= 0xfe00 && cp <= 0xfe0f) ||
    (cp >= 0x200b && cp <= 0x200f)
  ) {
    return 0;
  }
  if (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0x303e) ||
    (cp >= 0x3041 && cp <= 0x33ff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0xa000 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f000 && cp <= 0x1faff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  ) {
    return 2;
  }
  return 1;
}

/** Visible width in terminal columns (ANSI SGR ignored, wide characters count 2). */
export function visibleWidth(s: string): number {
  let w = 0;
  for (const ch of stripAnsi(s)) w += charWidth(ch.codePointAt(0) as number);
  return w;
}

/** Cut `s` to at most `width` visible columns, ending in `…` when cut. ANSI-aware. */
export function truncate(s: string, width: number): string {
  if (visibleWidth(s) <= width) return s;
  if (width <= 0) return '';
  let out = '';
  let cols = 0;
  let sawAnsi = false;
  for (let i = 0; i < s.length;) {
    const m = s[i] === '\x1b' ? ANSI_PREFIX_RE.exec(s.slice(i)) : null;
    if (m) {
      out += m[0];
      sawAnsi = true;
      i += m[0].length;
      continue;
    }
    const ch = String.fromCodePoint(s.codePointAt(i) as number);
    const w = charWidth(ch.codePointAt(0) as number);
    if (cols + w > width - 1) break;
    out += ch;
    cols += w;
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

export type Paint = (s: string) => string;
export interface Palette {
  bold: Paint;
  dim: Paint;
  red: Paint;
  yellow: Paint;
  cyan: Paint;
  green: Paint;
  magenta: Paint;
}

/** SGR color helpers; every one is the identity when `color` is false. */
export function palette(color: boolean): Palette {
  const sgr =
    (open: number, close: number): Paint =>
    (s) =>
      color && s ? `\x1b[${open}m${s}\x1b[${close}m` : s;
  return {
    bold: sgr(1, 22),
    dim: sgr(2, 22),
    red: sgr(31, 39),
    yellow: sgr(33, 39),
    cyan: sgr(36, 39),
    green: sgr(32, 39),
    magenta: sgr(35, 39),
  };
}
