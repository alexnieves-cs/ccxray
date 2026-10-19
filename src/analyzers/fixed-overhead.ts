// A4 fixed-overhead (SPEC §5): the context of the first assistant turn of each main session is
// its baseline (system prompt + tool definitions + CLAUDE.md + first prompt). Measured; what it
// consists of is inferred [E]. Tool definition sizes come from `prompt_snapshot` attachments
// when Claude Code logs them ([M] CC 2.1.302, FORMAT.md Q3).

import type { Analyzer, Finding, Session, SessionEvent, SourcePointer } from '../model/index.js';
import { estimateTokensFromChars } from '../tokens/estimate.js';
import {
  chain,
  compareVersions,
  contextTokens,
  fmt,
  mainTurns,
  mcpServer,
  median,
  short,
} from './rules.js';

const ISSUE_46917 = 'https://github.com/anthropics/claude-code/issues/46917';
const TOP_TOOLS = 5;
const UNKNOWN = 'unknown';

type Snapshot = Extract<SessionEvent, { kind: 'tools-snapshot' }>;

interface Baseline {
  session: Session;
  turnUuid: string;
  source: SourcePointer;
  version: string;
  tokens: number;
}

/** True when 2.1.100 lies in (a, b]: the known baseline inflation (#46917). */
function crosses2_1_100(a: string, b: string): boolean {
  return compareVersions(a, '2.1.100') < 0 && compareVersions(b, '2.1.100') >= 0;
}

/** Latest tools-snapshot across main (non-subagent) sessions, with the session it came from. */
export function latestSnapshot(
  sessions: readonly Session[],
): { s: Session; ev: Snapshot } | undefined {
  let best: { s: Session; ev: Snapshot } | undefined;
  for (const s of sessions) {
    if (s.isSubagent) continue;
    for (const ev of s.events)
      if (ev.kind === 'tools-snapshot' && (best === undefined || ev.ts >= best.ev.ts))
        best = { s, ev };
  }
  return best;
}

export const fixedOverhead: Analyzer = {
  id: 'fixed-overhead',
  spec: 'A4',
  description: 'Baseline context of the first turn per session, by Claude Code version',
  run(sessions, ctx) {
    const baselines: Baseline[] = [];
    for (const s of sessions) {
      // A resumed/continued session, or one cut by --since, does not start from a cold context.
      if (s.isSubagent || s.continued === true || chain(s)[0]?.index !== 0) continue;
      const first = mainTurns(s)[0];
      if (first === undefined) continue;
      baselines.push({
        session: s,
        turnUuid: first.uuid,
        source: first.source,
        version: first.ccVersion ?? UNKNOWN,
        tokens: contextTokens(first.usage),
      });
    }
    const findings: Finding[] = [];
    if (baselines.length > 0) {
      const byVersion = new Map<string, Baseline[]>();
      for (const b of baselines) byVersion.set(b.version, [...(byVersion.get(b.version) ?? []), b]);
      const versions = [...byVersion.keys()]
        .filter((v) => v !== UNKNOWN)
        .sort(compareVersions)
        .map((v) => {
          const bs = byVersion.get(v)!;
          return { version: v, median: median(bs.map((b) => b.tokens)), sessions: bs.length, bs };
        });
      const all = median(baselines.map((b) => b.tokens));
      const latest = versions[versions.length - 1];
      findings.push({
        analyzer: 'fixed-overhead',
        severity: 'info',
        title:
          `Baseline context ${fmt(all)} tokens per fresh session ` +
          `(median of ${baselines.length}; fixed overhead inferred [E], includes first ` +
          `prompt/attachments)` +
          (latest ? `; ${fmt(latest.median)} on ${latest.version}` : ''),
        tokens: { value: all, kind: 'measured' },
        data: {
          medianBaseline: all,
          sessions: baselines.length,
          inferred: true,
          versions: versions.map(({ version, median: m, sessions: n }) => ({
            version,
            median: m,
            sessions: n,
          })),
        },
        evidence: baselines.slice(0, 10).map((b) => ({
          sessionId: b.session.id,
          turnUuid: b.turnUuid,
          detail: `first turn context ${b.tokens} tokens on ${b.version}`,
          source: b.source,
        })),
        fix: {
          summary:
            'Fixed overhead is paid on every cold turn: trim MCP servers and CLAUDE.md you do not need',
        },
      });
      // Jumps only between consecutive versions with enough fresh sessions to trust the median.
      const solid = versions.filter((v) => v.sessions >= ctx.thresholds.baselineMinSessions);
      for (let i = 1; i < solid.length; i++) {
        const a = solid[i - 1]!;
        const b = solid[i]!;
        const delta = b.median - a.median;
        if (delta < ctx.thresholds.baselineJumpTokens) continue;
        const known = crosses2_1_100(a.version, b.version);
        const k = Math.round(delta / 1000);
        findings.push({
          analyzer: 'fixed-overhead',
          severity: 'warn',
          title: `Baseline grew ${fmt(delta)} tokens at ${b.version} (from ${a.version})`,
          tokens: { value: delta, kind: 'measured' },
          data: {
            fromVersion: a.version,
            toVersion: b.version,
            fromMedian: a.median,
            toMedian: b.median,
            delta,
            knownIssue: known,
          },
          evidence: [...a.bs.slice(0, 2), ...b.bs.slice(0, 3)].map((x) => ({
            sessionId: x.session.id,
            turnUuid: x.turnUuid,
            detail: `session ${short(x.session.id)} first turn ${x.tokens} tokens on ${x.version}`,
            source: x.source,
          })),
          fix: {
            summary:
              `Your baseline grew ${k}k at ${b.version}` +
              (known ? ' (known: anthropics/claude-code#46917, 2.1.100+)' : '') +
              '; trim MCP servers you do not use to win some of it back',
            ...(known ? { docsUrl: ISSUE_46917 } : {}),
          },
        });
      }
    }
    const snap = latestSnapshot(sessions);
    if (snap !== undefined && snap.ev.tools.length > 0) findings.push(toolDefinitions(snap));
    return findings;
  },
};

function toolDefinitions({ s, ev }: { s: Session; ev: Snapshot }): Finding {
  const chars = ev.tools.reduce((a, t) => a + t.chars, 0);
  const mcp = ev.tools.filter((t) => mcpServer(t.name) !== undefined);
  const mcpChars = mcp.reduce((a, t) => a + t.chars, 0);
  const top = [...ev.tools].sort((a, b) => b.chars - a.chars || (a.name < b.name ? -1 : 1));
  const est = estimateTokensFromChars(chars);
  return {
    analyzer: 'fixed-overhead',
    severity: 'info',
    title:
      `${ev.tools.length} tool definitions = ${fmt(chars)} chars ` +
      `(~${fmt(est)} tokens [E]) per cold turn; ` +
      `MCP ${mcp.length} tools, ${chars ? Math.round((mcpChars / chars) * 100) : 0}% of chars`,
    tokens: { value: est, kind: 'estimated' },
    data: {
      tools: ev.tools.length,
      defChars: chars,
      mcpTools: mcp.length,
      mcpChars,
      builtinTools: ev.tools.length - mcp.length,
      builtinChars: chars - mcpChars,
      ...(ev.systemPromptChars !== undefined ? { systemPromptChars: ev.systemPromptChars } : {}),
      topTools: top.slice(0, TOP_TOOLS).map((t) => ({ name: t.name, chars: t.chars })),
    },
    evidence: [
      {
        sessionId: s.id,
        turnUuid: mainTurns(s)[0]?.uuid ?? '',
        detail:
          'prompt_snapshot; largest: ' +
          top
            .slice(0, 3)
            .map((t) => `${t.name} ${t.chars}`)
            .join(', '),
        source: ev.source,
      },
    ],
    fix: {
      summary:
        mcp.length > 0
          ? 'Disable MCP servers you rarely use, or deny their unused tools (see tool-usage)'
          : 'Built-in tool definitions are fixed overhead; nothing to trim here',
    },
  };
}
