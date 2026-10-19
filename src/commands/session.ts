// `tknxray session <id|latest>`: per-turn drill-down for one session (SPEC §3).

import { parseArgs } from 'node:util';
import { repeatedReadToolUseIds } from '../analyzers/repeated-read.js';
import { cacheTtlMs, rebuildTurns } from '../analyzers/rules.js';
import { defaultRoots } from '../discover.js';
import {
  applyThresholdOverrides,
  DEFAULT_THRESHOLDS,
  type Session,
  type Thresholds,
  type Turn,
} from '../model/index.js';
import { loadSessions } from '../parser/index.js';
import {
  renderSessionView,
  type SessionRow,
  type SessionView,
  type SubagentSummary,
  type TurnFlag,
  type UsageSum,
} from '../reporters/session.js';
import { splitThresholds } from './analyze.js';

const MIN_PREFIX = 4;

/** Pick the session for `query`: `latest`, a full id, or a unique prefix of ≥ 4 chars. */
export function resolveSession(
  sessions: readonly Session[],
  query: string,
): { session: Session } | { error: string } {
  const main = sessions.filter((s) => !s.isSubagent);
  if (query === 'latest') {
    const s = [...main]
      .filter((x) => x.turns.length > 0)
      .sort((a, b) => b.lastTs.getTime() - a.lastTs.getTime() || (a.id < b.id ? -1 : 1))[0];
    return s ? { session: s } : { error: 'no sessions with assistant turns found' };
  }
  const exact = sessions.find((s) => s.id === query);
  if (exact) return { session: exact };
  if (query.length < MIN_PREFIX)
    return { error: `session id prefix must be at least ${MIN_PREFIX} characters` };
  const hits = main.filter((s) => s.id.startsWith(query));
  if (hits.length === 1) return { session: hits[0]! };
  if (hits.length === 0) return { error: `no session matches "${query}"` };
  return {
    error:
      `"${query}" matches ${hits.length} sessions: ` +
      hits
        .slice(0, 5)
        .map((s) => s.id)
        .join(', ') +
      (hits.length > 5 ? ', …' : ''),
  };
}

const sumUsage = (turns: readonly Turn[]): UsageSum => {
  const t: UsageSum = { input: 0, cacheWrite: 0, cacheRead: 0, output: 0, turns: 0 };
  for (const x of turns) {
    if (x.isSynthetic) continue;
    t.input += x.usage.input;
    t.cacheWrite += x.usage.cacheWrite;
    t.cacheRead += x.usage.cacheRead;
    t.output += x.usage.output;
    t.turns++;
  }
  return t;
};

function rows(
  s: Session,
  turns: readonly Turn[],
  chain: string,
  th: Thresholds,
  dupReads: ReadonlySet<string>,
): SessionRow[] {
  const rebuilds = rebuildTurns(s, th);
  const ttl = cacheTtlMs(s, th);
  return turns.map((t, i) => {
    const tools: Record<string, number> = {};
    for (const u of t.toolUses) tools[u.name] = (tools[u.name] ?? 0) + 1;
    const flags: TurnFlag[] = [];
    if (rebuilds.has(t.uuid)) flags.push('rebuild');
    if (t.toolUses.some((u) => dupReads.has(u.id))) flags.push('dup-read');
    if (t.toolResults.some((r) => r.estTokens >= th.bigToolOutputTokens)) flags.push('big-output');
    return {
      chain,
      n: i + 1,
      uuid: t.uuid,
      ts: t.ts.toISOString(),
      gapMs: t.gapMs,
      gapOverTtl: t.gapMs !== null && t.gapMs > ttl,
      model: t.model,
      ccVersion: t.ccVersion ?? null,
      synthetic: t.isSynthetic,
      input: t.usage.input,
      cacheWrite: t.usage.cacheWrite,
      cacheRead: t.usage.cacheRead,
      output: t.usage.output,
      tools,
      flags,
    };
  });
}

/** Rows and summaries for one session and its subagents. Pure. */
export function buildSessionView(
  s: Session,
  all: readonly Session[],
  th: Thresholds,
): { view: SessionView; subagentRows: SessionRow[] } {
  const mainChain = s.turns.filter((t) => s.isSubagent || !t.isSidechain);
  const subs = s.isSubagent
    ? []
    : all
        .filter((x) => x.isSubagent && x.parentSessionId === s.id)
        .sort((a, b) => a.firstTs.getTime() - b.firstTs.getTime() || (a.id < b.id ? -1 : 1));
  // The A6 rule itself, so 📄 marks exactly the reads A6 reports (subagent edits count).
  const dupReads = repeatedReadToolUseIds([s, ...subs]);
  const mainRows = rows(
    s,
    mainChain,
    s.isSubagent ? `agent-${s.agentId ?? s.id}` : 'main',
    th,
    dupReads,
  );
  const spawnRow = new Map<string, number>();
  mainChain.forEach((t, i) => t.toolUses.forEach((u) => spawnRow.set(u.id, i + 1)));
  const subagentRows: SessionRow[] = [];
  const subagents: SubagentSummary[] = subs.map((x) => {
    subagentRows.push(...rows(x, x.turns, `agent-${x.agentId ?? x.id}`, th, dupReads));
    const models = [...new Set(x.turns.filter((t) => !t.isSynthetic).map((t) => t.model))];
    return {
      id: x.id,
      agentId: x.agentId ?? null,
      models,
      spawnedAt: x.parentToolUseId !== undefined ? (spawnRow.get(x.parentToolUseId) ?? null) : null,
      ...sumUsage(x.turns),
    };
  });
  return {
    view: {
      id: s.id,
      project: s.project,
      ccVersions: s.ccVersions,
      firstTs: s.firstTs.toISOString(),
      lastTs: s.lastTs.toISOString(),
      ttlMs: cacheTtlMs(s, th),
      bigOutputTokens: th.bigToolOutputTokens,
      totals: sumUsage(mainChain),
      rows: mainRows,
      subagents,
      inlineSidechainTurns: s.turns.length - mainChain.length,
    },
    subagentRows,
  };
}

/** ASCII flags when NO_COLOR is set, TERM is dumb, or the locale is not UTF-8. */
export function wantsAscii(env: Record<string, string | undefined>): boolean {
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') return true;
  if (env.TERM === 'dumb') return true;
  const loc = env.LC_ALL || env.LC_CTYPE || env.LANG;
  return loc !== undefined && loc !== '' && !/utf-?8/i.test(loc);
}

export async function sessionCommand(
  argv: readonly string[],
  out: (s: string) => void,
  env: Record<string, string | undefined> = process.env,
): Promise<number> {
  let th: Thresholds;
  let values: { root?: string[]; json?: boolean; ascii?: boolean };
  let positionals: string[];
  try {
    const split = splitThresholds(argv);
    th = applyThresholdOverrides(DEFAULT_THRESHOLDS, split.overrides);
    ({ values, positionals } = parseArgs({
      args: split.rest,
      options: {
        root: { type: 'string', multiple: true },
        json: { type: 'boolean' },
        ascii: { type: 'boolean' },
      },
      allowPositionals: true,
    }));
  } catch (e) {
    out(`tknxray session: ${e instanceof Error ? e.message : String(e)}\n`);
    return 2;
  }
  const args = positionals[0] === 'session' ? positionals.slice(1) : positionals;
  if (args.length !== 1) {
    out('Usage: tknxray session <id|prefix|latest> [--root DIR]... [--json] [--threshold.KEY=N]\n');
    return 2;
  }
  const roots = values.root ?? defaultRoots();
  const { sessions } = await loadSessions({ roots });
  const found = resolveSession(sessions, args[0]!);
  if ('error' in found) {
    out(`tknxray session: ${found.error}\n`);
    return 1;
  }
  const { view, subagentRows } = buildSessionView(found.session, sessions, th);
  if (values.json) {
    out(`${JSON.stringify([...view.rows, ...subagentRows], null, 2)}\n`);
    return 0;
  }
  out(renderSessionView(view, { ascii: values.ascii === true || wantsAscii(env) }));
  return 0;
}
