// Small pure helpers shared by analyzers. No I/O, no clock, no environment.
import { posix } from 'node:path';
import type { Finding, Session, Turn } from '../model/index.js';

/** Evidence entries kept per finding. Counts in titles and data stay exact. */
export const MAX_EVIDENCE = 50;

/** First 8 characters of a session id (subagent ids keep their `:agent-…` suffix short too). */
export function shortSession(id: string): string {
  const [head, ...rest] = id.split(':');
  const h = (head ?? '').slice(0, 8);
  return rest.length > 0 ? `${h}:${rest.join(':').slice(0, 14)}` : h;
}

/** Short agent id of a subagent session: first 8 characters of `agentId` (else of its id suffix). */
export function shortAgent(s: Pick<Session, 'id' | 'agentId'>): string {
  const raw = s.agentId ?? s.id.slice(s.id.indexOf(':') + 1).replace(/^agent-/, '');
  return raw.slice(0, 8);
}

/**
 * How titles name a session: `session <8 chars>` for a main session, `subagent <agent id, 8 chars>`
 * for a subagent transcript (whose Session.id starts with the parent's id, so `short(s.id)` would
 * name the parent).
 */
export function sessionLabel(s: Pick<Session, 'id' | 'agentId' | 'isSubagent'>): string {
  return s.isSubagent ? `subagent ${shortAgent(s)}` : `session ${s.id.slice(0, 8)}`;
}

// A home directory at the start of a path: /home/<u>, /Users/<u>, C:\Users\<u>, /root.
const HOME_PREFIX =
  /^(?:\/home\/[^/\\]+|\/Users\/[^/\\]+|[A-Za-z]:[\\/]Users[\\/][^/\\]+|\/root)(?=[/\\]|$)/;

/**
 * `path` relative to the session cwd when it is inside it (SPEC §9: paths relative to the
 * project). Outside the cwd, a leading home directory is shown as `~` so a report does not carry
 * the user name. String-based, so POSIX paths behave the same on Windows and vice versa.
 */
export function displayPath(path: string, cwd: string | undefined): string {
  if (cwd !== undefined && cwd !== '') {
    const base = cwd.replace(/[/\\]+$/, '');
    if (path === base) return '.';
    for (const sep of ['/', '\\'])
      if (path.startsWith(base + sep)) return path.slice(base.length + 1);
  }
  return path.replace(HOME_PREFIX, '~');
}

// The same home prefixes anywhere in a string (e.g. inside a shell word).
const HOME_ANYWHERE =
  /(?<![\w.~-])(?:\/home\/[^/\\\s'"]+|\/Users\/[^/\\\s'"]+|[A-Za-z]:[\\/]Users[\\/][^/\\\s'"]+)(?=[/\\\s'"]|$)/g;

/** Every home directory inside `s` shown as `~` (for command words, not only path starts). */
export const maskHome = (s: string): string => s.replace(HOME_ANYWHERE, '~');

/**
 * Canonical form of a file path for comparisons: `\` → `/`, relative paths resolved against
 * `cwd`, `.`/`..` collapsed, and a Windows drive letter lowercased. Pure string work
 * (posix.normalize), identical on every OS.
 */
export function normPath(p: string, cwd?: string): string {
  let x = p.replace(/\\/g, '/');
  const isAbs = (q: string): boolean => q.startsWith('/') || /^[A-Za-z]:\//.test(q);
  if (!isAbs(x) && cwd !== undefined && cwd !== '')
    x = `${cwd.replace(/\\/g, '/').replace(/\/+$/, '')}/${x}`;
  x = x.replace(/^([A-Za-z]):/, (_, d: string) => `${d.toLowerCase()}:`);
  return posix.normalize(x);
}

/** Last path segment, for either separator. */
export function baseName(path: string): string {
  const parts = path.split(/[/\\]/);
  return parts[parts.length - 1] ?? path;
}

/** `6m`, `14m 30s`, `2h 5m`, `45s`. */
export function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 === 0 ? `${m}m` : `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return m % 60 === 0 ? `${h}h` : `${h}h ${m % 60}m`;
}

/** Turns that count for token stats (SPEC §4.2: synthetic/error turns are excluded). */
export const realTurns = (s: Session): Turn[] => s.turns.filter((t) => !t.isSynthetic);

export type Evidence = Finding['evidence'][number];

export function evidenceFor(t: Turn, detail: string): Evidence {
  return { sessionId: t.sessionId, turnUuid: t.uuid, detail, source: t.source };
}

export const plural = (n: number, word: string, many = `${word}s`): string =>
  `${n} ${n === 1 ? word : many}`;
