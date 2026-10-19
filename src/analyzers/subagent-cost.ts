// A9 subagent-cost (SPEC §5): usage of subagent transcripts (and inline sidechain turns) vs
// their parent session [M].
// "Tokens" here = input + cache write + cache read + output of non-synthetic turns: everything
// the requests processed, not a price.

//
// Impact (SPEC §5.2): each subagent's list-price cost, and the lever "the same subagent work on a
// cheaper model": savings = cost − the same tokens re-priced one tier down (Opus / Fable / Mythos
// → claude-sonnet-5-5, Sonnet → claude-haiku-5-5; Haiku has no lever). Estimated: a cheaper model
// may need more or fewer tokens and may do worse. Costs are also grouped by subagent type
// (`subagent_type` of the parent Agent/Task tool_use; `(unknown)` when it cannot be linked).
// UNVERIFIED: that `subagent_type` names the agent definition, and that an explicit `model` in
// the same input overrides settings (Claude Code docs, not checked against a running version).
import { turnCost } from '../cost/cost.js';
import { impact } from '../cost/impact.js';
import { cheaperModel } from '../cost/prices.js';
import type { Analyzer, Finding, Session, ToolUse } from '../model/index.js';
import { formatUsd } from '../reporters/format.js';
import { fmt, short, turnTokens } from './rules.js';

const ROUTING_FIX =
  'Route exploratory subagents to a smaller model via the subagent `model:` field';

type Turn = Session['turns'][number];

/** A subagent: its own transcript, or inline sidechain turns of a main transcript. */
interface Agent {
  id: string;
  agentId?: string;
  parentToolUseId?: string;
  turns: Turn[];
  inline: boolean;
}

function tokensOf(turns: readonly Turn[]): number {
  return turns.filter((t) => !t.isSynthetic).reduce((a, t) => a + turnTokens(t.usage), 0);
}

/** Models of non-synthetic turns, most used first. */
function models(turns: readonly Turn[]): string[] {
  const n = new Map<string, number>();
  for (const t of turns) if (!t.isSynthetic) n.set(t.model, (n.get(t.model) ?? 0) + 1);
  return [...n.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([m]) => m);
}

/**
 * Subagents by parent session id. Transcript subagents come first; inline `isSidechain` turns of
 * a main transcript are grouped by agentId into pseudo-subagents. An inline turn whose message id
 * already appears in a subagent transcript of the same parent is dropped (no double count), and
 * inline turns of an agentId that has a transcript are added to that transcript's agent.
 */
export function subagentsByParent(sessions: readonly Session[]): Map<string, Agent[]> {
  const byParent = new Map<string, Agent[]>();
  const add = (k: string, a: Agent) => byParent.set(k, [...(byParent.get(k) ?? []), a]);
  for (const s of sessions)
    if (s.isSubagent)
      add(s.parentSessionId ?? '(unknown parent)', {
        id: s.id,
        ...(s.agentId !== undefined ? { agentId: s.agentId } : {}),
        ...(s.parentToolUseId !== undefined ? { parentToolUseId: s.parentToolUseId } : {}),
        turns: s.turns,
        inline: false,
      });
  for (const s of sessions) {
    if (s.isSubagent) continue;
    const inline = s.turns.filter((t) => t.isSidechain);
    if (inline.length === 0) continue;
    const agents = byParent.get(s.id) ?? [];
    const seen = new Set(agents.flatMap((a) => a.turns.map((t) => t.messageId)));
    const groups = new Map<string, Turn[]>();
    for (const t of inline) {
      if (seen.has(t.messageId)) continue;
      const k = t.agentId ?? '(inline)';
      groups.set(k, [...(groups.get(k) ?? []), t]);
    }
    for (const [k, turns] of groups) {
      const existing = agents.find((a) => a.agentId === k);
      if (existing) existing.turns = [...existing.turns, ...turns];
      else
        add(s.id, {
          id: `${s.id}:inline-${k}`,
          ...(k !== '(inline)' ? { agentId: k } : {}),
          turns,
          inline: true,
        });
    }
  }
  return byParent;
}

export const CHEAPER_CAVEAT =
  'a cheaper model may need more or fewer tokens and may do worse on the same task';

/** $ of turns at list prices, and the same tokens one tier down (unchanged when no tier). */
function agentUsd(turns: readonly Turn[]): { cost: number; cheaper: number; target?: string } {
  let cost = 0;
  let cheaper = 0;
  let target: string | undefined;
  for (const t of turns) {
    if (t.isSynthetic) continue;
    const c = turnCost(t);
    if (c === null) continue;
    cost += c.total;
    const down = cheaperModel(t.model);
    const r = down === undefined ? null : turnCost(t, down);
    cheaper += r?.total ?? c.total;
    if (down !== undefined && r !== null) target ??= down;
  }
  return { cost, cheaper, ...(target !== undefined ? { target } : {}) };
}

/** Parent Agent/Task tool_uses by id: `subagent_type` and an explicit `model`, when given. */
function agentInvocations(
  sessions: readonly Session[],
): Map<string, { type?: string; model?: string }> {
  const out = new Map<string, { type?: string; model?: string }>();
  const str = (u: ToolUse, k: string): string | undefined => {
    const v =
      typeof u.input === 'object' && u.input !== null
        ? (u.input as Record<string, unknown>)[k]
        : undefined;
    return typeof v === 'string' && v !== '' ? v.slice(0, 60) : undefined;
  };
  for (const s of sessions)
    for (const t of s.turns)
      for (const u of t.toolUses)
        if (u.name === 'Agent' || u.name === 'Task') {
          const type = str(u, 'subagent_type');
          const model = str(u, 'model');
          out.set(u.id, { ...(type ? { type } : {}), ...(model ? { model } : {}) });
        }
  return out;
}

export interface TypeRow {
  type: string;
  agents: number;
  model: string;
  cheaperModel: string;
  costUsd: number;
  savingsUsd: number;
  /** Agents whose invocation passed an explicit `model` (it overrides settings). */
  explicitModel: number;
}

const round6 = (x: number): number => Math.round(x * 1e6) / 1e6;

const pct = (part: number, whole: number): number =>
  whole > 0 ? Math.round((part / whole) * 100) : 0;

function typeRows(m: Map<string, TypeRow>): TypeRow[] {
  return [...m.values()]
    .map((r) => ({ ...r, costUsd: round6(r.costUsd), savingsUsd: round6(r.savingsUsd) }))
    .sort((a, b) => b.costUsd - a.costUsd || (a.type < b.type ? -1 : 1));
}

function cheaperImpact(
  cost: number,
  cheaper: number,
  agents: number,
  targets: readonly string[],
): { impact?: Finding['impact'] } {
  if (!(cost > 0)) return {};
  return {
    impact: impact({
      costUsd: cost,
      savingsUsd: cost - cheaper,
      savingsSubagentUsd: cost - cheaper,
      basis:
        `${agents === 1 ? '1 subagent' : `${agents} subagents`} cost ${formatUsd(cost)}; ` +
        (targets.length > 0
          ? `the same tokens on ${targets.join(' / ')} would cost ${formatUsd(cheaper)}, ` +
            `but ${CHEAPER_CAVEAT}`
          : 'they already run on the cheapest tier, so there is no cheaper model to move to'),
      confidence: 'estimated',
    }),
  };
}

export const subagentCost: Analyzer = {
  id: 'subagent-cost',
  spec: 'A9',
  description: 'Tokens used by subagent transcripts vs their parent session',
  run(sessions) {
    const byParent = subagentsByParent(sessions);
    if (byParent.size === 0) return [];
    const invocations = agentInvocations(sessions);
    let allCost = 0;
    let allCheaper = 0;
    const allTypes = new Map<string, TypeRow>();
    const parents = new Map(sessions.filter((s) => !s.isSubagent).map((s) => [s.id, s]));
    const findings: Finding[] = [];
    let allSub = 0;
    let allParent = 0;
    const modelTokens = new Map<string, number>();
    for (const [parentId, subs] of [...byParent.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      const parent = parents.get(parentId);
      const parentTokens = parent ? tokensOf(parent.turns.filter((t) => !t.isSidechain)) : 0;
      const agents = subs
        .map((s) => ({
          s,
          tokens: tokensOf(s.turns),
          models: models(s.turns),
          usd: agentUsd(s.turns),
          inv: s.parentToolUseId !== undefined ? invocations.get(s.parentToolUseId) : undefined,
        }))
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
      const cost = agents.reduce((a, x) => a + x.usd.cost, 0);
      const cheaper = agents.reduce((a, x) => a + x.usd.cheaper, 0);
      allCost += cost;
      allCheaper += cheaper;
      const types = new Map<string, TypeRow>();
      for (const a of agents)
        for (const m of [types, allTypes]) {
          const type = a.inv?.type ?? '(unknown)';
          const row = m.get(type) ?? {
            type,
            agents: 0,
            model: a.models[0] ?? '',
            cheaperModel: '',
            costUsd: 0,
            savingsUsd: 0,
            explicitModel: 0,
          };
          row.agents++;
          row.costUsd += a.usd.cost;
          row.savingsUsd += a.usd.cost - a.usd.cheaper;
          if (a.usd.target !== undefined && row.cheaperModel === '')
            row.cheaperModel = a.usd.target;
          if (a.inv?.model !== undefined) row.explicitModel++;
          m.set(type, row);
        }
      const targets = [...new Set(agents.map((a) => a.usd.target).filter(Boolean))];
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
          parentModel: parent ? (models(parent.turns.filter((t) => !t.isSidechain))[0] ?? '') : '',
          subagentModels: subModels.join(', ').slice(0, 80),
          subagentTypes: typeRows(types),
          agents: agents.map((a) => ({
            agentId: a.s.agentId ?? a.s.id,
            model: a.models[0] ?? '',
            turns: a.s.turns.filter((t) => !t.isSynthetic).length,
            tokens: a.tokens,
            costUsd: round6(a.usd.cost),
            ...(a.inv?.type !== undefined ? { type: a.inv.type } : {}),
            ...(a.s.parentToolUseId !== undefined ? { parentToolUseId: a.s.parentToolUseId } : {}),
            ...(a.s.inline ? { inline: true } : {}),
          })),
        },
        evidence: agents.slice(0, 5).map((a) => ({
          sessionId: a.s.inline ? parentId : a.s.id,
          turnUuid: a.s.turns[0]?.uuid ?? '',
          detail:
            `${a.s.inline ? 'inline sidechain' : 'agent'} ${a.s.agentId ?? short(a.s.id)} · ` +
            `${a.models[0] ?? 'no model'} · ` +
            `${a.s.turns.length} turns · ${fmt(a.tokens)} tokens` +
            (a.inv?.type !== undefined ? ` · type ${a.inv.type}` : '') +
            (a.usd.cost > 0 ? ` · ${formatUsd(a.usd.cost)} [E]` : ''),
          ...(a.s.turns[0] ? { source: a.s.turns[0].source } : {}),
        })),
        fix: { summary: ROUTING_FIX },
        ...cheaperImpact(cost, cheaper, agents.length, targets as string[]),
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
        subagentTypes: typeRows(allTypes),
      },
      evidence: findings.map((f) => f.evidence[0]!).filter(Boolean),
      fix: { summary: ROUTING_FIX },
      ...cheaperImpact(
        allCost,
        allCheaper,
        [...byParent.values()].reduce((a, x) => a + x.length, 0),
        [...new Set([...allTypes.values()].map((r) => r.cheaperModel).filter(Boolean))],
      ),
    });
    return findings;
  },
};
