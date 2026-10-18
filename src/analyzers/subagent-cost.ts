// A9 subagent-cost (SPEC §5): usage of subagent transcripts vs their parent session [M].
// "Tokens" here = input + cache write + cache read + output of non-synthetic turns: everything
// the requests processed, not a price.

import type { Analyzer, Finding, Session } from '../model/index.js';
import { fmt, short, turnTokens } from './rules.js';

const ROUTING_FIX =
  'Route exploratory subagents to a smaller model via the subagent `model:` field';

function tokensOf(s: Session, mainOnly: boolean): number {
  return s.turns
    .filter((t) => !t.isSynthetic && !(mainOnly && t.isSidechain))
    .reduce((a, t) => a + turnTokens(t.usage), 0);
}

/** Models of a session's non-synthetic turns, most used first. */
function models(s: Session): string[] {
  const n = new Map<string, number>();
  for (const t of s.turns) if (!t.isSynthetic) n.set(t.model, (n.get(t.model) ?? 0) + 1);
  return [...n.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([m]) => m);
}

const pct = (part: number, whole: number): number =>
  whole > 0 ? Math.round((part / whole) * 100) : 0;

export const subagentCost: Analyzer = {
  id: 'subagent-cost',
  spec: 'A9',
  description: 'Tokens used by subagent transcripts vs their parent session',
  run(sessions) {
    const byParent = new Map<string, Session[]>();
    for (const s of sessions)
      if (s.isSubagent) {
        const k = s.parentSessionId ?? '(unknown parent)';
        byParent.set(k, [...(byParent.get(k) ?? []), s]);
      }
    if (byParent.size === 0) return [];
    const parents = new Map(sessions.filter((s) => !s.isSubagent).map((s) => [s.id, s]));
    const findings: Finding[] = [];
    let allSub = 0;
    let allParent = 0;
    const modelTokens = new Map<string, number>();
    for (const [parentId, subs] of [...byParent.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      const parent = parents.get(parentId);
      const parentTokens = parent ? tokensOf(parent, true) : 0;
      const agents = subs
        .map((s) => ({ s, tokens: tokensOf(s, false), models: models(s) }))
        .sort((a, b) => b.tokens - a.tokens || (a.s.id < b.s.id ? -1 : 1));
      const subTokens = agents.reduce((a, x) => a + x.tokens, 0);
      allSub += subTokens;
      allParent += parentTokens;
      for (const a of agents) {
        const m = a.models[0] ?? '(none)';
        modelTokens.set(m, (modelTokens.get(m) ?? 0) + a.tokens);
      }
      const subModels = [...new Set(agents.flatMap((a) => a.models))];
      const share = pct(subTokens, subTokens + parentTokens);
      findings.push({
        analyzer: 'subagent-cost',
        severity: 'info',
        title:
          `${agents.length} subagent${agents.length === 1 ? '' : 's'} used ${fmt(subTokens)} tokens ` +
          `(${share}% of session ${short(parentId)}) on ${subModels.join(', ') || 'no model'}`,
        tokens: { value: subTokens, kind: 'measured' },
        data: {
          parentSessionId: parentId,
          subagents: agents.length,
          subagentTokens: subTokens,
          parentTokens,
          sharePct: share,
          parentModel: parent ? (models(parent)[0] ?? '') : '',
          subagentModels: subModels.join(', ').slice(0, 80),
          agents: agents.map((a) => ({
            agentId: a.s.agentId ?? a.s.id,
            model: a.models[0] ?? '',
            turns: a.s.turns.filter((t) => !t.isSynthetic).length,
            tokens: a.tokens,
            ...(a.s.parentToolUseId !== undefined ? { parentToolUseId: a.s.parentToolUseId } : {}),
          })),
        },
        evidence: agents.slice(0, 5).map((a) => ({
          sessionId: a.s.id,
          turnUuid: a.s.turns[0]?.uuid ?? '',
          detail:
            `agent ${a.s.agentId ?? short(a.s.id)} · ${a.models[0] ?? 'no model'} · ` +
            `${a.s.turns.length} turns · ${fmt(a.tokens)} tokens`,
          ...(a.s.turns[0] ? { source: a.s.turns[0].source } : {}),
        })),
        fix: { summary: ROUTING_FIX },
      });
    }
    if (byParent.size < 2) return findings;
    const total = allSub + allParent;
    findings.push({
      analyzer: 'subagent-cost',
      severity: 'info',
      title:
        `Subagents: ${fmt(allSub)} tokens across ${byParent.size} parent session` +
        `${byParent.size === 1 ? '' : 's'} (${pct(allSub, total)}% of their tokens)`,
      tokens: { value: allSub, kind: 'measured' },
      data: {
        parents: byParent.size,
        subagents: [...byParent.values()].reduce((a, x) => a + x.length, 0),
        subagentTokens: allSub,
        parentTokens: allParent,
        sharePct: pct(allSub, total),
        byModel: [...modelTokens.entries()]
          .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
          .map(([model, tokens]) => ({ model, tokens })),
      },
      evidence: findings.map((f) => f.evidence[0]!).filter(Boolean),
      fix: { summary: ROUTING_FIX },
    });
    return findings;
  },
};
