// A6 repeated-read (SPEC §5): the same file read again, unchanged, in the same context.
//
// Per session (subagent sessions are separate contexts) and per chain, tool calls are walked
// in timestamp order. A Read of (path, offset, limit) is a repeat when the same triple was read
// earlier in the chain with no change in between. Paths are compared in canonical form
// (normPath: `/` separators, resolved against the session cwd, drive letter lowercased);
// offset/limit are coerced with Number(), and an offset of 0 or 1 or a limit of 0 means
// "omitted" (a limit of 1 stays: a one-line read is not a full read).
//
// A change to a path, from any chain of the session or from a subagent session whose
// parentSessionId is this session (merged by timestamp: the filesystem is shared), is an
// Edit / Write / MultiEdit / NotebookEdit of it, or a Bash command with a word naming the file
// [E: a Bash command could change a file without naming it, which this misses].
// An Agent/Task tool_use forgets every read (the subagent may edit anything, also when its
// transcript is missing), and so does a compaction (the earlier read left the context).
// Reads whose result is_error do not count. Tokens are estimated: the sum of estTokens of the
// repeated reads. A5 (big-tool-output) skips these repeats so the two never count one result
// twice (see repeatedReadToolUseIds).
//
// One finding per (session, path), so each title names a file; repeats of different ranges of
// one file are added together.
import type { Analyzer, Finding, Session, ToolUse, Turn } from '../model/index.js';
import {
  baseName,
  displayPath,
  evidenceFor,
  MAX_EVIDENCE,
  normPath,
  realTurns,
  shortSession,
} from './util.js';
import type { Evidence } from './util.js';

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const AGENT_TOOLS = new Set(['Agent', 'Task']);

function field(u: ToolUse, key: string): unknown {
  return typeof u.input === 'object' && u.input !== null
    ? (u.input as Record<string, unknown>)[key]
    : undefined;
}
const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);

/** Number(v) when it is a finite number other than the `omitted` values, else null. */
function range(v: unknown, omitted: readonly number[]): number | null {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && !omitted.includes(n) ? n : null;
}

interface Repeat {
  turn: Turn;
  toolUseId: string;
  /** Canonical path. */
  path: string;
  readNo: number;
  estTokens: number;
}

/**
 * Reads seen so far in one chain, indexed by path and by file name, so forgetting a path or the
 * paths a Bash command names never scans every read.
 */
class ReadLog {
  private readonly counts = new Map<string, number>();
  private readonly byPath = new Map<string, Set<string>>();
  private readonly byBase = new Map<string, Set<string>>();
  record(path: string, key: string): number {
    const n = (this.counts.get(key) ?? 0) + 1;
    this.counts.set(key, n);
    let keys = this.byPath.get(path);
    if (keys === undefined) this.byPath.set(path, (keys = new Set()));
    keys.add(key);
    const base = baseName(path);
    let paths = this.byBase.get(base);
    if (paths === undefined) this.byBase.set(base, (paths = new Set()));
    paths.add(path);
    return n;
  }
  forget(path: string): void {
    for (const k of this.byPath.get(path) ?? []) this.counts.delete(k);
    this.byPath.delete(path);
    this.byBase.get(baseName(path))?.delete(path);
  }
  /**
   * Forget every read file whose name appears as a word of the Bash command [E]: words are split
   * on whitespace, quotes and shell punctuation, so `cat src/a.ts`, `sed -i … "a.ts"` and
   * `a.ts:10` all name a.ts; a glob such as `src/*.ts` names nothing.
   */
  forgetNamedBy(cmd: string): void {
    for (const word of cmd.split(/[\s'"`;|&<>(),:=]+/)) {
      if (word === '') continue;
      for (const path of [...(this.byBase.get(baseName(word.replace(/\\/g, '/'))) ?? [])])
        this.forget(path);
    }
  }
}

type Op =
  | { ts: number; seq: number; turn: Turn; use: ToolUse; own: boolean; cwd?: string }
  | { ts: number; seq: number; compaction: true };

/**
 * `subagents` are the sessions whose parentSessionId is `s`: their tool calls can change files
 * (own = false), but their reads are their own context and are not counted here.
 */
function sessionRepeats(s: Session, subagents: readonly Session[]): Repeat[] {
  const ops: Op[] = [];
  let seq = 0;
  const add = (src: Session, own: boolean): void => {
    for (const turn of realTurns(src))
      for (const use of turn.toolUses)
        ops.push({ ts: turn.ts.getTime(), seq: seq++, turn, use, own, cwd: src.cwd });
  };
  add(s, true);
  for (const sub of subagents) add(sub, false);
  for (const e of s.events)
    if (e.kind === 'compaction') ops.push({ ts: e.ts.getTime(), seq: seq++, compaction: true });
  // Stable: same-ts ops keep insertion order.
  ops.sort((a, b) => a.ts - b.ts || a.seq - b.seq);

  const out: Repeat[] = [];
  const chains = new Map<string, ReadLog>();
  for (const op of ops) {
    if ('compaction' in op) {
      chains.clear();
      continue;
    }
    const { turn, use: u } = op;
    if (u.name === 'Read') {
      if (!op.own) continue;
      const rawPath = str(field(u, 'file_path'));
      if (rawPath === undefined) continue;
      const result = turn.toolResults.find((r) => r.toolUseId === u.id);
      if (result?.isError) continue;
      const path = normPath(rawPath, op.cwd);
      const chainKey = turn.isSidechain ? `side:${turn.agentId ?? ''}` : 'main';
      let log = chains.get(chainKey);
      if (log === undefined) chains.set(chainKey, (log = new ReadLog()));
      const key = JSON.stringify([
        path,
        range(field(u, 'offset'), [0, 1]),
        range(field(u, 'limit'), [0]),
      ]);
      const n = log.record(path, key);
      if (n > 1)
        out.push({ turn, toolUseId: u.id, path, readNo: n, estTokens: result?.estTokens ?? 0 });
    } else if (EDIT_TOOLS.has(u.name)) {
      const p = str(field(u, 'file_path')) ?? str(field(u, 'notebook_path'));
      if (p !== undefined) for (const log of chains.values()) log.forget(normPath(p, op.cwd));
    } else if (u.name === 'Bash') {
      const cmd = str(field(u, 'command'));
      if (cmd !== undefined) for (const log of chains.values()) log.forgetNamedBy(cmd);
    } else if (AGENT_TOOLS.has(u.name)) chains.clear();
  }
  return out;
}

function repeatsBySession(sessions: readonly Session[]): Map<Session, Repeat[]> {
  const subs = new Map<string, Session[]>();
  for (const s of sessions)
    if (s.isSubagent && s.parentSessionId !== undefined) {
      let list = subs.get(s.parentSessionId);
      if (list === undefined) subs.set(s.parentSessionId, (list = []));
      list.push(s);
    }
  const out = new Map<Session, Repeat[]>();
  for (const s of sessions)
    out.set(s, sessionRepeats(s, s.isSubagent ? [] : (subs.get(s.id) ?? [])));
  return out;
}

/** tool_use ids of the Reads A6 reports as repeats (A5 skips them). */
export function repeatedReadToolUseIds(sessions: readonly Session[]): Set<string> {
  const ids = new Set<string>();
  for (const reps of repeatsBySession(sessions).values())
    for (const r of reps) ids.add(r.toolUseId);
  return ids;
}

export const repeatedRead: Analyzer = {
  id: 'repeated-read',
  spec: 'A6',
  description: 'Files read again, unchanged, in the same session.',
  run(sessions) {
    const findings: Finding[] = [];
    for (const [s, repeats] of repeatsBySession(sessions)) {
      const byPath = new Map<string, Repeat[]>();
      for (const r of repeats) {
        let list = byPath.get(r.path);
        if (list === undefined) byPath.set(r.path, (list = []));
        list.push(r);
      }
      const cwd = s.cwd !== undefined ? normPath(s.cwd) : undefined;
      for (const [path, reps] of byPath) {
        const rel = displayPath(path, cwd);
        const tokens = reps.reduce((a, r) => a + r.estTokens, 0);
        const evidence: Evidence[] = reps
          .slice(0, MAX_EVIDENCE)
          .map((r) => evidenceFor(r.turn, `read #${r.readNo} of ${rel}, unchanged since read #1`));
        findings.push({
          analyzer: 'repeated-read',
          severity: tokens >= 20_000 ? 'warn' : 'info',
          title: `${rel} re-read ${reps.length}× unchanged in session ${shortSession(s.id)}`,
          tokens: { value: tokens, kind: 'estimated' },
          data: { tool: 'Read', path: rel, rereads: reps.length },
          evidence,
          fix: {
            summary: 'reference the earlier read (cc-slim read-dedupe hook planned)',
          },
        });
      }
    }
    return findings;
  },
};
