// A6 repeated-read (SPEC §5): the same file read again, unchanged, in the same context.
//
// Per session (subagent sessions are separate contexts) and per chain, tool calls are walked
// in order. A Read of (file_path, offset, limit) is a repeat when the same triple was read
// earlier with no change in between. A change is, for that path: an Edit / Write / MultiEdit /
// NotebookEdit, or a Bash command containing the path or its file name [E: a Bash command could
// change a file without naming it, which this misses]. A compaction event also resets
// everything: after compaction the earlier read is no longer in context. Reads whose result
// is_error do not count. Tokens are estimated: the sum of estTokens of the repeated reads.
//
// One finding per (session, path), so each title names a file; repeats of different ranges of
// one file are added together.
import type { Analyzer, Finding, Session, ToolUse, Turn } from '../model/index.js';
import {
  baseName,
  displayPath,
  evidenceFor,
  MAX_EVIDENCE,
  realTurns,
  shortSession,
} from './util.js';
import type { Evidence } from './util.js';

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

function field(u: ToolUse, key: string): unknown {
  return typeof u.input === 'object' && u.input !== null
    ? (u.input as Record<string, unknown>)[key]
    : undefined;
}
const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);

interface Repeat {
  turn: Turn;
  path: string;
  readNo: number;
  estTokens: number;
}

function sessionRepeats(s: Session): Repeat[] {
  const out: Repeat[] = [];
  // Per chain: chain key → (read key → reads so far).
  const chains = new Map<string, Map<string, number>>();
  const turns = realTurns(s);
  const compactions = s.events.filter((e) => e.kind === 'compaction').map((e) => e.ts.getTime());
  let lastTs = -Infinity;
  for (const turn of turns) {
    if (compactions.some((c) => c > lastTs && c <= turn.ts.getTime())) chains.clear();
    lastTs = turn.ts.getTime();
    const chainKey = turn.isSidechain ? `side:${turn.agentId ?? ''}` : 'main';
    let reads = chains.get(chainKey);
    if (reads === undefined) chains.set(chainKey, (reads = new Map()));
    for (const u of turn.toolUses) {
      if (u.name === 'Read') {
        const path = str(field(u, 'file_path'));
        if (path === undefined) continue;
        const result = turn.toolResults.find((r) => r.toolUseId === u.id);
        if (result?.isError) continue;
        const key = JSON.stringify([path, field(u, 'offset') ?? null, field(u, 'limit') ?? null]);
        const n = (reads.get(key) ?? 0) + 1;
        reads.set(key, n);
        if (n > 1) out.push({ turn, path, readNo: n, estTokens: result?.estTokens ?? 0 });
      } else if (EDIT_TOOLS.has(u.name)) {
        const path = str(field(u, 'file_path')) ?? str(field(u, 'notebook_path'));
        if (path !== undefined) forget(reads, (p) => p === path);
      } else if (u.name === 'Bash') {
        const cmd = str(field(u, 'command'));
        if (cmd !== undefined) forget(reads, (p) => cmd.includes(p) || cmd.includes(baseName(p)));
      }
    }
  }
  return out;
}

function forget(reads: Map<string, number>, match: (path: string) => boolean): void {
  for (const key of [...reads.keys()]) {
    const [path] = JSON.parse(key) as [string];
    if (match(path)) reads.delete(key);
  }
}

export const repeatedRead: Analyzer = {
  id: 'repeated-read',
  spec: 'A6',
  description: 'Files read again, unchanged, in the same session.',
  run(sessions) {
    const findings: Finding[] = [];
    for (const s of sessions) {
      const byPath = new Map<string, Repeat[]>();
      for (const r of sessionRepeats(s)) byPath.set(r.path, [...(byPath.get(r.path) ?? []), r]);
      for (const [path, reps] of byPath) {
        const rel = displayPath(path, s.cwd);
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
