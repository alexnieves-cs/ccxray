// Small pure helpers shared by analyzers. No I/O, no clock, no environment.
import type { Finding, Session, Turn } from '../model/index.js';

/** Evidence entries kept per finding. Counts in titles and data stay exact. */
export const MAX_EVIDENCE = 50;

/** First 8 characters of a session id (subagent ids keep their `:agent-…` suffix short too). */
export function shortSession(id: string): string {
  const [head, ...rest] = id.split(':');
  const h = (head ?? '').slice(0, 8);
  return rest.length > 0 ? `${h}:${rest.join(':').slice(0, 14)}` : h;
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
