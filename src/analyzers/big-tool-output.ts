// A5 big-tool-output (SPEC §5): tool results that put many tokens into the context.
//
// A result qualifies when its inline estimate is ≥ bigToolOutputTokens, or when Claude Code
// externalized it (`<persisted-output>`, FORMAT.md Q1) and the reported full size would have
// been ≥ bigToolOutputTokens × 4 bytes. Tokens are always the *inline* estimate (chars / 4), the
// part that entered the context; the full size of persisted outputs goes to data.persistedBytes.
// Grouped by tool name, and for Bash by the normalized command (normalizeCommand). All sessions
// count, subagents included: their context is billed too. Reads that A6 reports as repeats are
// left to A6, so WHERE IT WENT never counts one result twice. Estimated.
import type { Analyzer, Finding, Session, ToolResult, Turn } from '../model/index.js';
import { CHARS_PER_TOKEN } from '../tokens/estimate.js';
import { formatCompact, formatInt, shortCommand } from '../reporters/format.js';
import { repeatedReadToolUseIds } from './repeated-read.js';
import { displayPath, evidenceFor, maskHome, MAX_EVIDENCE, plural, type Evidence } from './util.js';

// Leading `cd <dir> &&` or `cd <dir>;` (Claude Code often prefixes one); dir may be quoted.
const CD_PREFIX = /^\s*cd\s+(?:"[^"]*"|'[^']*'|[^\s;&|]+)\s*(?:&&|;)\s*/;

/**
 * Grouping key and display form of a Bash command (CLAUDE.md rule 4, SPEC §9): leading
 * `cd <dir> &&` / `cd <dir>;` prefixes are dropped, then shortCommand() keeps the first two words
 * after env assignments and prefixes and shows any word containing `=` as `…`; path words are
 * shown relative to `cwd`, and any home directory as `~`. Never holds more than that.
 */
export function normalizeCommand(command: string, cwd?: string): string {
  let c = command;
  while (CD_PREFIX.test(c)) c = c.replace(CD_PREFIX, '');
  return shortCommand(c)
    .split(' ')
    .map((w) => maskHome(/[/\\]/.test(w) ? displayPath(w, cwd) : w))
    .join(' ');
}

interface Hit {
  session: Session;
  turn: Turn;
  result: ToolResult;
}

interface Group {
  tool: string;
  command?: string;
  hits: Hit[];
}

function toolOf(turn: Turn, r: ToolResult, cwd?: string): { tool: string; command?: string } {
  const use = turn.toolUses.find((u) => u.id === r.toolUseId);
  const tool = r.toolName ?? use?.name ?? '(unknown tool)';
  if (tool !== 'Bash') return { tool };
  const input = use?.input;
  const cmd =
    typeof input === 'object' && input !== null && 'command' in input
      ? (input as { command: unknown }).command
      : undefined;
  return {
    tool,
    command: typeof cmd === 'string' ? normalizeCommand(cmd, cwd) || '(empty)' : '(unknown)',
  };
}

function fixFor(g: Group): string {
  const persisted = g.hits.filter((h) => h.result.persisted).length;
  const base =
    g.tool === 'Bash'
      ? 'pipe through `| tail -n 100`, or use --silent / --reporter=dot'
      : g.tool === 'Grep'
        ? 'narrow the glob or path, or set head_limit'
        : g.tool === 'Read'
          ? 'read only the part you need with offset/limit'
          : 'ask for a narrower result';
  return persisted > 0 ? `${base}; Claude Code already truncated ${persisted} to a preview` : base;
}

export const bigToolOutput: Analyzer = {
  id: 'big-tool-output',
  spec: 'A5',
  description: 'Tool results with large outputs, grouped by tool and command.',
  run(sessions, ctx) {
    const min = ctx.thresholds.bigToolOutputTokens;
    const groups = new Map<string, Group>();
    // A Read that A6 reports as a repeat is counted there only, never in both.
    const repeats = repeatedReadToolUseIds(sessions);
    for (const session of sessions)
      for (const turn of session.turns)
        for (const result of turn.toolResults) {
          const full = result.persisted?.reportedBytes ?? 0;
          if (result.estTokens < min && full < min * CHARS_PER_TOKEN) continue;
          if (repeats.has(result.toolUseId)) continue;
          const { tool, command } = toolOf(turn, result, session.cwd);
          const key = `${tool}\u0000${command ?? ''}`;
          const g = groups.get(key) ?? { tool, command, hits: [] };
          g.hits.push({ session, turn, result });
          groups.set(key, g);
        }
    const findings: Finding[] = [];
    for (const g of groups.values()) {
      const tokens = g.hits.reduce((a, h) => a + h.result.estTokens, 0);
      const maxChars = g.hits.reduce((m, h) => Math.max(m, h.result.chars), 0);
      const persisted = g.hits.filter((h) => h.result.persisted);
      const label = g.command !== undefined ? `\`${g.command}\`` : g.tool;
      const evidence: Evidence[] = [...g.hits]
        .sort((a, b) => b.result.chars - a.result.chars || a.turn.ts - b.turn.ts)
        .slice(0, MAX_EVIDENCE)
        .map((h) =>
          evidenceFor(
            h.turn,
            `${g.tool} result ${formatInt(h.result.chars)} chars inline (~${formatCompact(h.result.estTokens)} tokens [E])` +
              (h.result.persisted
                ? `, persisted by Claude Code (full ${h.result.persisted.reportedBytes === null ? 'size unknown' : `${formatInt(h.result.persisted.reportedBytes)} bytes`})`
                : '') +
              (h.result.isError ? ', is_error' : ''),
          ),
        );
      findings.push({
        analyzer: 'big-tool-output',
        // Persisted-only groups cost little context: info. 50k+ estimated tokens: warn.
        severity: persisted.length === g.hits.length || tokens < 50_000 ? 'info' : 'warn',
        title:
          `${label} returned up to ${formatCompact(maxChars)} chars inline ` +
          `(${plural(g.hits.length, 'big output')})`,
        tokens: { value: tokens, kind: 'estimated' },
        data: {
          tool: g.tool,
          ...(g.command !== undefined ? { command: g.command } : {}),
          count: g.hits.length,
          maxChars,
          totalChars: g.hits.reduce((a, h) => a + h.result.chars, 0),
          sessions: new Set(g.hits.map((h) => h.session.id)).size,
          persisted: persisted.length,
          persistedBytes: persisted.reduce(
            (a, h) => a + (h.result.persisted?.reportedBytes ?? 0),
            0,
          ),
          errors: g.hits.filter((h) => h.result.isError).length,
        },
        evidence,
        fix: { summary: fixFor(g) },
      });
    }
    return findings;
  },
};
