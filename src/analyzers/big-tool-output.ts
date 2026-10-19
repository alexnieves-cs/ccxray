// A5 big-tool-output (SPEC §5): tool results that put many tokens into the context.
//
// A result qualifies when its inline estimate is ≥ bigToolOutputTokens. An output Claude Code
// externalized (`<persisted-output>`, FORMAT.md Q1) whose inline preview is under that is not a
// big output (Claude Code already handled it): it only adds to data.persistedByClaudeCode of a
// group that has big outputs, and never makes a finding on its own. Tokens are always the
// *inline* estimate (chars / 4), the part that entered the context; the full size of persisted
// big outputs goes to data.persistedBytes. Fix advice depends on the command family (bashAdvice).
// Grouped by tool name, and for Bash by the normalized command (normalizeCommand). All sessions
// count, subagents included: their context is billed too. Reads that A6 reports as repeats are
// left to A6, and reads A11 reports as cross-agent copies to A11, so WHERE IT WENT never counts
// one result twice. Estimated.
//
// Impact (SPEC §5.2): the CARRY cost of each output (src/cost/carry.ts): written to the cache
// once, then re-read on every later turn of its chain until a compaction or the chain's end.
// Savings assume the fix cuts each output to TRIMMED_OUTPUT_TOKENS (about 100 lines) [E].
import { carryIndex } from '../cost/carry.js';
import { impact } from '../cost/impact.js';
import type { Analyzer, Finding, Session, ToolResult, Turn } from '../model/index.js';
import { CHARS_PER_TOKEN } from '../tokens/estimate.js';
import { formatCompact, formatInt, formatUsd, shortCommand } from '../reporters/format.js';
import { crossAgentReadToolUseIds } from './cross-agent-read.js';
import { repeatedReadToolUseIds } from './repeated-read.js';
import { displayPath, evidenceFor, maskHome, MAX_EVIDENCE, plural, type Evidence } from './util.js';

// Leading `cd <dir> &&` or `cd <dir>;` (Claude Code often prefixes one); dir may be quoted.
const CD_PREFIX = /^\s*cd\s+(?:"[^"]*"|'[^']*'|[^\s;&|]+)\s*(?:&&|;)\s*/;

// Shell loop keywords whose two-word label (`for f`, `while read`) says nothing about the output.
const LOOP_START = /^\s*(?:for|while|until)\b/;
// Commands inside a loop body that only frame the output, skipped when naming the loop.
const LOOP_NOISE = new Set([
  'do',
  'done',
  'echo',
  'printf',
  'true',
  ':',
  '[',
  '[[',
  'test',
  'sleep',
]);

/**
 * The first meaningful command inside a `for`/`while`/`until … do …; done` loop, as two words
 * without `$` words (loop variables), e.g. `for f in *.ts; do echo "$f"; cat "$f"; done` → `cat`.
 * Undefined when the body cannot be found. Splits on `;`, `&&`, `||`, `|` and newlines without
 * honoring quotes [E]: good enough for a label.
 */
function loopBody(command: string): string | undefined {
  const m = /(?:^|[\s;])do\s+([\s\S]*)$/.exec(command);
  if (!m) return undefined;
  for (const seg of m[1]!.split(/;|&&|\|\||\||\n/)) {
    const words = shortCommand(seg.trim())
      .split(' ')
      .filter((w) => w !== '' && !w.includes('$'));
    if (words.length === 0 || LOOP_NOISE.has(words[0]!)) continue;
    return words.join(' ');
  }
  return undefined;
}

/**
 * Grouping key and display form of a Bash command (CLAUDE.md rule 4, SPEC §9): leading
 * `cd <dir> &&` / `cd <dir>;` prefixes are dropped, then shortCommand() keeps the first two words
 * after env assignments and prefixes and shows any word containing `=` as `…`; path words are
 * shown relative to `cwd`, and any home directory as `~`. A `for`/`while`/`until` loop is named
 * by the first meaningful command of its body, e.g. `cat (in a loop)`, else by its first two
 * words. Never holds more than that.
 */
export function normalizeCommand(command: string, cwd?: string): string {
  let c = command;
  while (CD_PREFIX.test(c)) c = c.replace(CD_PREFIX, '');
  const inner = LOOP_START.test(c) ? loopBody(c) : undefined;
  const label = (inner ?? shortCommand(c))
    .split(' ')
    .map((w) => maskHome(/[/\\]/.test(w) ? displayPath(w, cwd) : w))
    .join(' ');
  return inner !== undefined ? `${label} (in a loop)` : label;
}

/** What a trimmed output keeps (~100 lines × ~40 chars / 4), for A5 savings. Estimated. */
export const TRIMMED_OUTPUT_TOKENS = 1_000;

interface Hit {
  session: Session;
  turn: Turn;
  result: ToolResult;
  carryUsd: number;
  savingsUsd: number;
  turnsCarried: number;
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

const FILE_DUMP = new Set(['cat', 'sed', 'head', 'tail', 'less', 'more', 'nl', 'bat']);
const SEARCH = new Set(['grep', 'rg', 'egrep', 'fgrep', 'ag', 'ack']);
const PKG = new Set(['pnpm', 'npm', 'yarn', 'bun']);
const PKG_TASKS = new Set(['test', 'build', 'run', 'lint', 'typecheck', 'exec', 'vitest', 'jest']);
const RUNNERS = new Set(['vitest', 'jest', 'pytest', 'cargo', 'make', 'tsc', 'mocha', 'gradle']);
const NPX = new Set(['npx', 'pnpx', 'bunx']);

/** Advice for a Bash group, by command family (its normalized label). */
export function bashAdvice(command: string): string {
  if (command.endsWith(' (in a loop)'))
    return 'limit the output (| head, | tail, or a narrower command)';
  const [w0 = '', w1 = ''] = command.split(' ');
  if (FILE_DUMP.has(w0)) return 'use Read with offset/limit, or grep -n for the part you need';
  if (SEARCH.has(w0) || (w0 === 'git' && w1 === 'grep'))
    return 'add -l, -m N or a narrower path/glob';
  if (w0 === 'git' && (w1 === 'show' || w1 === 'diff'))
    return 'run with --stat first, then show a single path';
  if (w0 === 'git' && w1 === 'log') return 'limit it with -n N --oneline';
  if (
    RUNNERS.has(w0) ||
    (PKG.has(w0) && PKG_TASKS.has(w1)) ||
    (NPX.has(w0) && RUNNERS.has(w1)) ||
    (w0 === 'go' && (w1 === 'test' || w1 === 'build' || w1 === 'vet'))
  )
    return 'pipe through `| tail -n 100`, or use --silent / --reporter=dot';
  return 'limit the output (| head, | tail, or a narrower command)';
}

function fixFor(g: Group): string {
  const persisted = g.hits.filter((h) => h.result.persisted).length;
  const base =
    g.tool === 'Bash'
      ? bashAdvice(g.command ?? '')
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
    // So is a Read that A11 reports as one agent's copy of a file several agents read.
    for (const id of crossAgentReadToolUseIds(sessions, ctx.thresholds)) repeats.add(id);
    const carry = carryIndex(sessions, ctx.thresholds);
    // Outputs Claude Code externalized whose inline preview is under the threshold: already
    // handled, so not big outputs; counted per group as data.persistedByClaudeCode only.
    const handled = new Map<string, number>();
    for (const session of sessions)
      for (const turn of session.turns)
        for (const result of turn.toolResults) {
          const full = result.persisted?.reportedBytes ?? 0;
          const small = result.estTokens < min;
          if (small && !(result.persisted && full >= min * CHARS_PER_TOKEN)) continue;
          if (repeats.has(result.toolUseId)) continue;
          const { tool, command } = toolOf(turn, result, session.cwd);
          const key = `${tool}\u0000${command ?? ''}`;
          if (small) {
            handled.set(key, (handled.get(key) ?? 0) + 1);
            continue;
          }
          const g = groups.get(key) ?? { tool, command, hits: [] };
          const c = carry.carry(turn, result.estTokens);
          const kept = Math.min(result.estTokens, TRIMMED_OUTPUT_TOKENS);
          g.hits.push({
            session,
            turn,
            result,
            carryUsd: c.usd,
            savingsUsd:
              result.estTokens > 0 ? (c.usd * (result.estTokens - kept)) / result.estTokens : 0,
            turnsCarried: c.turnsCarried,
          });
          groups.set(key, g);
        }
    const findings: Finding[] = [];
    for (const [key, g] of groups) {
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
              (h.result.isError ? ', is_error' : '') +
              (h.turnsCarried > 0
                ? `; stayed in context for ${plural(h.turnsCarried, 'turn')}, ~${formatUsd(h.carryUsd)} [E]`
                : ''),
          ),
        );
      const costUsd = g.hits.reduce((a, h) => a + h.carryUsd, 0);
      const savingsUsd = g.hits.reduce((a, h) => a + h.savingsUsd, 0);
      const subUsd = g.hits
        .filter((h) => h.session.isSubagent || h.turn.isSidechain)
        .reduce((a, h) => a + h.savingsUsd, 0);
      const longest = g.hits.reduce((m, h) => Math.max(m, h.turnsCarried), 0);
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
          persistedByClaudeCode: handled.get(key) ?? 0,
          turnsCarriedMax: longest,
        },
        evidence,
        fix: { summary: fixFor(g) },
        ...(costUsd > 0
          ? {
              impact: impact({
                costUsd,
                savingsUsd,
                savingsSubagentUsd: subUsd,
                basis:
                  `each output was written to the cache once and re-read on every later turn ` +
                  `until a compaction or the end of its session (the longest stayed in context ` +
                  `for ${plural(longest, 'turn')}); savings assume each is cut to ~` +
                  `${formatCompact(TRIMMED_OUTPUT_TOKENS)} tokens (about 100 lines)`,
                confidence: 'estimated',
              }),
            }
          : {}),
      });
    }
    return findings;
  },
};
