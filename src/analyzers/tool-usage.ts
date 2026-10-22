// A7 tool-usage (SPEC §5): tool_use counts by name, and tools defined but never called.
// Definitions are known only from `prompt_snapshot` attachments ([M] CC 2.1.302, FORMAT.md Q3);
// without one, the analyzer reports call counts only. Definition sizes are chars [M] and
// tokens [E chars/4], paid on every cold turn.
//
// Finding.data for MCP servers is consumed by `tknxray fix mcp` (M5). Keep exactly:
//   { server: string, unusedTools: string[], usedTools: string[], defChars?: number }
// with full tool names (`mcp__<server>__<tool>`). defChars = definition chars of the unused tools.
//
// UNVERIFIED (FORMAT.md Q3): that a prompt_snapshot's `tools[]` lists every tool sent on a cold
// turn, and that tools named in a `deferred_tools_record` are not sent up front. Deferred tools
// count as defined, cost 0 tokens per cold turn and are excluded from defChars and the estimate;
// they stay in unusedTools (they can still be denied) and are listed separately in the evidence.
// Only main (non-subagent) sessions' snapshots are read.

//
// Impact (SPEC §5.2): an unused definition is part of every request of the main sessions whose
// prompt_snapshot lists it: read from the cache on most turns, written on cold/rebuild turns.
// cost = definition tokens [E] × Σ over those turns of the read (or write) price; removing the
// definitions saves all of it. Built-in tools cannot be removed: cost only, savings 0.
// UNVERIFIED: that definitions sit in the cached prefix of every main-chain request; subagent
// requests are left out (whether they carry the same definitions is not logged).
import { carryIndex, everyTurnUnit, type CarryIndex } from '../cost/carry.js';
import { impact } from '../cost/impact.js';
import type { Analyzer, Finding, Impact, Session, SourcePointer } from '../model/index.js';
import { formatUsd } from '../reporters/format.js';
import { estimateTokensFromChars } from '../tokens/estimate.js';
import { fmt, mainTurns, mcpServer } from './rules.js';

const TOP_CALLED = 8;

/**
 * Per-token $ of content sent with every main-chain request of `sessions` (Σ of read prices,
 * write prices on cold/rebuild turns), with the turn count.
 */
export function everyRequestUnit(
  idx: CarryIndex,
  sessions: Iterable<Session>,
): { perToken: number; turns: number; cold: number } {
  let perToken = 0;
  let turns = 0;
  let cold = 0;
  for (const s of sessions) {
    const c = idx.mainChain(s);
    if (c === undefined || s.isSubagent) continue;
    perToken += everyTurnUnit(c);
    turns += c.turns.length;
    for (const x of c.cold) cold += x;
  }
  return { perToken, turns, cold };
}

/** Impact of `tokens` of definitions sent with every main-chain request of `sessions`. */
export function definitionsImpact(
  idx: CarryIndex,
  sessions: Iterable<Session>,
  tokens: number,
  removable: boolean,
  note = '; built-in definitions cannot be removed, so nothing to save',
): Impact | undefined {
  const u = everyRequestUnit(idx, sessions);
  const costUsd = tokens * u.perToken;
  if (!(costUsd > 0)) return undefined;
  return impact({
    costUsd,
    savingsUsd: removable ? costUsd : 0,
    basis:
      `~${fmt(tokens)} tokens of definitions [E] were part of ${fmt(u.turns)} main-session ` +
      `requests (written on ${fmt(u.cold)} cold or rebuild turns, read on the rest): ` +
      `${formatUsd(costUsd)}` +
      (removable ? '' : note),
    confidence: 'estimated',
  });
}

const byName = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const withImpact = (i: Impact | undefined): { impact?: Impact } =>
  i === undefined ? {} : { impact: i };

export const toolUsage: Analyzer = {
  id: 'tool-usage',
  spec: 'A7',
  description: 'Tool calls by name; tools and MCP servers defined but never called',
  run(sessions, ctx) {
    const calls = new Map<string, number>();
    const firstCall = new Map<string, { s: Session; uuid: string; source: SourcePointer }>();
    for (const s of sessions)
      for (const t of s.turns)
        for (const u of t.toolUses) {
          calls.set(u.name, (calls.get(u.name) ?? 0) + 1);
          if (!firstCall.has(u.name)) firstCall.set(u.name, { s, uuid: t.uuid, source: t.source });
        }
    // Definitions: union over every snapshot; the latest snapshot wins for a tool's size.
    const defs = new Map<string, number>();
    let snapSession: Session | undefined;
    /** Where the definitions were read: the latest snapshot, else a deferred_tools_record. */
    let snapSource: SourcePointer | undefined;
    const snaps = sessions
      .filter((s) => !s.isSubagent)
      .flatMap((s) => s.events.flatMap((e) => (e.kind === 'tools-snapshot' ? [{ s, e }] : [])))
      .sort((a, b) => a.e.ts - b.e.ts);
    /** Tool names each main session's snapshots list (for the impact's affected sessions). */
    const listedBy = new Map<Session, Set<string>>();
    for (const { s, e } of snaps) {
      snapSession = s;
      snapSource = e.source;
      for (const t of e.tools) defs.set(t.name, t.chars);
      let names = listedBy.get(s);
      if (names === undefined) listedBy.set(s, (names = new Set()));
      for (const t of e.tools) names.add(t.name);
    }
    const idx = carryIndex(sessions, ctx.thresholds);
    /** Main sessions whose snapshots list any of `names`. */
    const affected = (names: readonly string[]): Session[] =>
      [...listedBy].filter(([, set]) => names.some((n) => set.has(n))).map(([s]) => s);
    const deferred = new Set<string>();
    for (const s of sessions)
      if (!s.isSubagent)
        for (const e of s.events)
          if (e.kind === 'deferred-tools') {
            if (snapSession === undefined) {
              snapSession = s;
              snapSource = e.source;
            }
            for (const t of e.tools) deferred.add(t);
          }
    const defined = new Set([...defs.keys(), ...deferred]);
    /** Cold-turn definition chars: 0 for deferred tools. */
    const coldChars = (n: string): number => (deferred.has(n) ? 0 : (defs.get(n) ?? 0));
    const findings: Finding[] = [];
    const total = [...calls.values()].reduce((a, b) => a + b, 0);
    if (total > 0) {
      const top = [...calls.entries()].sort((a, b) => b[1] - a[1] || byName(a[0], b[0]));
      findings.push({
        analyzer: 'tool-usage',
        severity: 'info',
        title:
          `${fmt(total)} tool calls, ${top.length} distinct tools: ` +
          top
            .slice(0, 4)
            .map(([n, c]) => `${n} ${c}`)
            .join(', '),
        tokens: { value: 0, kind: 'measured' },
        data: {
          calls: total,
          distinctTools: top.length,
          definitionsKnown: defined.size > 0,
          deferredTools: deferred.size,
          top: top.slice(0, TOP_CALLED).map(([name, count]) => ({ name, count })),
        },
        evidence: top.slice(0, 3).map(([name, count]) => ({
          sessionId: firstCall.get(name)!.s.id,
          turnUuid: firstCall.get(name)!.uuid,
          detail: `first of ${count} ${name} calls`,
          source: firstCall.get(name)!.source,
        })),
        fix: {
          summary:
            defined.size > 0
              ? 'See the unused-tool findings for what you could deny'
              : 'Tool definition sizes are unknown without a prompt_snapshot; counts only',
        },
      });
    }
    if (defined.size === 0 || snapSession === undefined) return findings;

    const servers = new Map<string, { defined: string[]; used: Set<string> }>();
    const builtinUnused: string[] = [];
    for (const name of [...defined].sort(byName)) {
      const server = mcpServer(name);
      if (server === undefined) {
        if (!calls.has(name)) builtinUnused.push(name);
        continue;
      }
      const g = servers.get(server) ?? { defined: [], used: new Set() };
      g.defined.push(name);
      servers.set(server, g);
    }
    for (const name of calls.keys()) {
      const server = mcpServer(name);
      if (server !== undefined) servers.get(server)?.used.add(name);
    }
    const turnUuid = mainTurns(snapSession)[0]?.uuid ?? '';
    const source = snapSource ?? mainTurns(snapSession)[0]?.source;
    const at = source !== undefined ? { source } : {};
    const ev = (detail: string, unused: string[]) => {
      const lazy = unused.filter((n) => deferred.has(n));
      return [
        { sessionId: snapSession!.id, turnUuid, detail, ...at },
        ...(lazy.length > 0
          ? [
              {
                sessionId: snapSession!.id,
                turnUuid,
                detail: `deferred, 0 tokens/cold turn: ${lazy.join(', ')}`.slice(0, 200),
                ...at,
              },
            ]
          : []),
      ];
    };
    const lazyNote = (unused: string[]) => {
      const n = unused.filter((x) => deferred.has(x)).length;
      return n > 0 ? `, ${n} deferred` : '';
    };
    for (const [server, g] of [...servers.entries()].sort((a, b) => byName(a[0], b[0]))) {
      const unusedTools = g.defined.filter((n) => !calls.has(n));
      if (unusedTools.length === 0) continue;
      const defChars = unusedTools.reduce((a, n) => a + coldChars(n), 0);
      const est = estimateTokensFromChars(defChars);
      const none = g.used.size === 0;
      findings.push({
        analyzer: 'tool-usage',
        severity: est > 0 ? 'warn' : 'info',
        title:
          `${unusedTools.length} of ${new Set([...g.defined, ...g.used]).size} tools from MCP server "${server}" ` +
          `never called${lazyNote(unusedTools)} (~${fmt(est)} tokens/cold turn [E])`,
        tokens: { value: est, kind: 'estimated' },
        data: { server, unusedTools, usedTools: [...g.used].sort(byName), defChars },
        ...withImpact(definitionsImpact(idx, affected(unusedTools), est, true)),
        evidence: ev(
          `${unusedTools.length} unused ${server} tools defined, ${fmt(defChars)} chars; ` +
            `${g.used.size} used`,
          unusedTools,
        ),
        fix: {
          summary: none
            ? `Turn the "${server}" MCP server off (/mcp, or disabledMcpjsonServers), or move it into the one subagent that needs it`
            : `Set "alwaysLoad": false on the "${server}" server so its tools load on demand, or deny the unused ones (\`tknxray fix mcp\`)`,
          docsUrl: 'https://code.claude.com/docs/en/mcp',
        },
      });
    }
    if (builtinUnused.length > 0) {
      const defChars = builtinUnused.reduce((a, n) => a + coldChars(n), 0);
      const est = estimateTokensFromChars(defChars);
      const lazy = builtinUnused.filter((n) => deferred.has(n));
      findings.push({
        analyzer: 'tool-usage',
        severity: 'info',
        title:
          `${builtinUnused.length} built-in tools defined but never called` +
          `${lazyNote(builtinUnused)} (~${fmt(est)} tokens/cold turn [E])`,
        tokens: { value: est, kind: 'estimated' },
        data: { unusedTools: builtinUnused, deferredTools: lazy, defChars },
        ...withImpact(definitionsImpact(idx, affected(builtinUnused), est, false)),
        evidence: ev(
          `${builtinUnused.length} unused built-in tools, ${fmt(defChars)} chars`,
          builtinUnused,
        ),
        fix: { summary: 'Built-in tools usually cannot be removed; listed for completeness' },
      });
    }
    return findings;
  },
};
