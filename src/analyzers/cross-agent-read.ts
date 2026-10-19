// A11 cross-agent-read (SPEC §5): the same file read by several agents of one session tree.
//
// A session tree is a main session plus its subagent transcripts (and inline sidechain agents).
// Each agent has its own context, so when the main conversation and N subagents each Read the
// same file, the file is written to the cache and carried in N+1 contexts. A file counts when
// at least `crossAgentReadMinAgents` agents of one tree read it (canonical path, as A6: `/`
// separators, resolved against the reading session's cwd, `.`/`..` collapsed; any offset/limit).
// Only each agent's first non-error Read of the file is a copy here: an agent's later re-reads
// are A6's (repeated-read), and A5 (big-tool-output) skips every copy counted here, so no tool
// result is counted by two analyzers.
//
// Impact (SPEC §5.2): carry cost of each copy (src/cost/carry.ts); savings = (copies − 1) ×
// the median copy's carry (one agent still reads the file; the others get the facts they need
// in their prompt). Estimated: tokens are chars/4 and a summary in the prompt is not free.
import { carryIndex, type CarryIndex } from '../cost/carry.js';
import { impact } from '../cost/impact.js';
import type { Analyzer, Finding, Session, Thresholds, Turn } from '../model/index.js';
import { formatCompact, formatUsd } from '../reporters/format.js';
import { median } from './rules.js';
import {
  displayPath,
  evidenceFor,
  MAX_EVIDENCE,
  normPath,
  plural,
  realTurns,
  shortAgent,
  type Evidence,
} from './util.js';

interface Copy {
  session: Session;
  turn: Turn;
  toolUseId: string;
  /** Agent key: the session id, plus the agentId for an inline sidechain agent. */
  agent: string;
  isSubagent: boolean;
  label: string;
  estTokens: number;
}

const rootOf = (s: Session): string =>
  s.isSubagent ? (s.parentSessionId ?? s.id.split(':')[0] ?? s.id) : s.id;

/** Agents per tree: one per session, plus each inline sidechain agentId of a main session. */
function agentsByTree(sessions: readonly Session[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const s of sessions) {
    let n = 1;
    if (!s.isSubagent) {
      const inline = new Set<string>();
      for (const t of s.turns) if (t.isSidechain) inline.add(t.agentId ?? '');
      n += inline.size;
    }
    out.set(rootOf(s), (out.get(rootOf(s)) ?? 0) + n);
  }
  return out;
}

/** First non-error Read of each (agent, canonical path), grouped by tree and path. Trees with
 * fewer agents than the threshold cannot be flagged and are skipped. */
function copiesByTree(
  sessions: readonly Session[],
  minAgents: number,
): Map<string, Map<string, Copy[]>> {
  const agents = agentsByTree(sessions);
  const trees = new Map<string, Map<string, Copy[]>>();
  for (const s of sessions) {
    const root = rootOf(s);
    if ((agents.get(root) ?? 0) < minAgents) continue;
    let paths = trees.get(root);
    if (paths === undefined) trees.set(root, (paths = new Map()));
    const seen = new Set<string>();
    for (const turn of realTurns(s))
      for (const u of turn.toolUses) {
        if (u.name !== 'Read') continue;
        const raw =
          typeof u.input === 'object' && u.input !== null
            ? (u.input as Record<string, unknown>).file_path
            : undefined;
        if (typeof raw !== 'string' || raw === '') continue;
        const result = turn.toolResults.find((r) => r.toolUseId === u.id);
        if (result === undefined || result.isError) continue;
        const inline = !s.isSubagent && turn.isSidechain;
        const agent = inline ? `${s.id}:side:${turn.agentId ?? ''}` : s.id;
        const path = normPath(raw, s.cwd);
        const key = `${agent}\u0000${path}`;
        if (seen.has(key)) continue;
        seen.add(key);
        let list = paths.get(path);
        if (list === undefined) paths.set(path, (list = []));
        list.push({
          session: s,
          turn,
          toolUseId: u.id,
          agent,
          isSubagent: s.isSubagent || inline,
          label: s.isSubagent
            ? `subagent ${shortAgent(s)}`
            : inline
              ? `inline agent ${(turn.agentId ?? '?').slice(0, 8)}`
              : `main session ${s.id.slice(0, 8)}`,
          estTokens: result.estTokens,
        });
      }
  }
  return trees;
}

/** Groups of copies that reach the threshold, by tree root. */
function flagged(sessions: readonly Session[], th: Thresholds): [string, string, Copy[]][] {
  const out: [string, string, Copy[]][] = [];
  for (const [root, paths] of copiesByTree(sessions, th.crossAgentReadMinAgents))
    for (const [path, copies] of paths)
      if (copies.length >= th.crossAgentReadMinAgents) out.push([root, path, copies]);
  return out;
}

/** tool_use ids of every copy A11 reports (A5 skips them). */
export function crossAgentReadToolUseIds(
  sessions: readonly Session[],
  th: Thresholds,
): Set<string> {
  const ids = new Set<string>();
  for (const [, , copies] of flagged(sessions, th)) for (const c of copies) ids.add(c.toolUseId);
  return ids;
}

const FIX = (rel: string) =>
  `put the facts agents need from ${rel} in the subagent prompt or a CLAUDE.md summary ` +
  'instead of having every agent read the file';

function finding(
  root: string,
  path: string,
  copies: Copy[],
  sessions: readonly Session[],
  carry: CarryIndex,
): Finding {
  const rootSession = sessions.find((s) => s.id === root && !s.isSubagent);
  const cwd = rootSession?.cwd ?? copies[0]!.session.cwd;
  const rel = displayPath(path, cwd !== undefined ? normPath(cwd) : undefined);
  const withCarry = copies.map((c) => ({ c, carry: carry.carry(c.turn, c.estTokens) }));
  const costUsd = withCarry.reduce((a, x) => a + x.carry.usd, 0);
  const savingsUsd = (copies.length - 1) * median(withCarry.map((x) => x.carry.usd));
  const subs = copies.filter((c) => c.isSubagent).length;
  const total = copies.reduce((a, c) => a + c.estTokens, 0);
  const largest = copies.reduce((m, c) => Math.max(m, c.estTokens), 0);
  const evidence: Evidence[] = withCarry
    .slice(0, MAX_EVIDENCE)
    .map(({ c, carry: k }) =>
      evidenceFor(
        c.turn,
        `read by ${c.label} (~${formatCompact(c.estTokens)} tokens [E])` +
          (k.turnsCarried > 0
            ? `; stayed in context for ${plural(k.turnsCarried, 'turn')}, ~${formatUsd(k.usd)} [E]`
            : ''),
      ),
    );
  return {
    analyzer: 'cross-agent-read',
    severity: total - largest >= 20_000 ? 'warn' : 'info',
    title:
      `${rel} read by ${copies.length} agents of session ${root.slice(0, 8)} ` +
      `(${subs === copies.length ? `${subs} subagents` : `main + ${plural(subs, 'subagent')}`})`,
    // The copies beyond the largest one [E].
    tokens: { value: total - largest, kind: 'estimated' },
    data: { tool: 'Read', path: rel, agents: copies.length, subagents: subs },
    evidence,
    fix: { summary: FIX(rel) },
    ...(costUsd > 0
      ? {
          impact: impact({
            costUsd,
            savingsUsd,
            savingsSubagentUsd: savingsUsd,
            basis:
              `${copies.length} agents each carried their own copy until a compaction or the ` +
              `end of their session (${formatUsd(costUsd)} in all); one copy instead of ` +
              `${copies.length} saves ${copies.length - 1} × the median copy's carry`,
            confidence: 'estimated',
          }),
        }
      : {}),
  };
}

export const crossAgentRead: Analyzer = {
  id: 'cross-agent-read',
  spec: 'A11',
  description: 'The same file read by several agents (main session and subagents) of one session.',
  run(sessions, ctx) {
    const carry = carryIndex(sessions, ctx.thresholds);
    return flagged(sessions, ctx.thresholds).map(([root, path, copies]) =>
      finding(root, path, copies, sessions, carry),
    );
  },
};
