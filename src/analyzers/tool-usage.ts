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

import type { Analyzer, Finding, Session } from '../model/index.js';
import { estimateTokensFromChars } from '../tokens/estimate.js';
import { fmt, mainTurns, mcpServer } from './rules.js';

const TOP_CALLED = 8;

const byName = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export const toolUsage: Analyzer = {
  id: 'tool-usage',
  spec: 'A7',
  description: 'Tool calls by name; tools and MCP servers defined but never called',
  run(sessions) {
    const calls = new Map<string, number>();
    const firstCall = new Map<string, { s: Session; uuid: string }>();
    for (const s of sessions)
      for (const t of s.turns)
        for (const u of t.toolUses) {
          calls.set(u.name, (calls.get(u.name) ?? 0) + 1);
          if (!firstCall.has(u.name)) firstCall.set(u.name, { s, uuid: t.uuid });
        }
    // Definitions: union over every snapshot; the latest snapshot wins for a tool's size.
    const defs = new Map<string, number>();
    let snapSession: Session | undefined;
    const snaps = sessions
      .filter((s) => !s.isSubagent)
      .flatMap((s) => s.events.flatMap((e) => (e.kind === 'tools-snapshot' ? [{ s, e }] : [])))
      .sort((a, b) => a.e.ts - b.e.ts);
    for (const { s, e } of snaps) {
      snapSession = s;
      for (const t of e.tools) defs.set(t.name, t.chars);
    }
    const deferred = new Set<string>();
    for (const s of sessions)
      if (!s.isSubagent)
        for (const e of s.events)
          if (e.kind === 'deferred-tools') {
            snapSession ??= s;
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
    const ev = (detail: string, unused: string[]) => {
      const lazy = unused.filter((n) => deferred.has(n));
      return [
        { sessionId: snapSession!.id, turnUuid, detail },
        ...(lazy.length > 0
          ? [
              {
                sessionId: snapSession!.id,
                turnUuid,
                detail: `deferred, 0 tokens/cold turn: ${lazy.join(', ')}`.slice(0, 200),
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
          `${unusedTools.length} of ${g.defined.length} tools from MCP server "${server}" ` +
          `never called${lazyNote(unusedTools)} (~${fmt(est)} tokens/cold turn [E])`,
        tokens: { value: est, kind: 'estimated' },
        data: { server, unusedTools, usedTools: [...g.used].sort(byName), defChars },
        evidence: ev(
          `${unusedTools.length} unused ${server} tools defined, ${fmt(defChars)} chars; ` +
            `${g.used.size} used`,
          unusedTools,
        ),
        fix: {
          summary: none
            ? `Disable the "${server}" MCP server, or scope it to a subagent (tknxray fix mcp, M5)`
            : `Deny the unused "${server}" tools in permissions.deny (tknxray fix mcp, M5)`,
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
