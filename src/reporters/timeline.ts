// Per-turn timeline data for the HTML report's session replay. Pure: no I/O.
//
// Everything here is measured (usage fields, timestamps, tool names, result sizes as logged)
// except where a field says otherwise. No prompt, tool input or tool output text is copied:
// a turn carries token counts, its model, and for each tool call only the tool name and the
// size of its result (CLAUDE.md hard rule 4).
import { findRebuilds } from '../analyzers/cache-rebuild.js';
import { cacheTtlMs, contextTokens, sessionTtl } from '../analyzers/rules.js';
import { formatDuration } from '../analyzers/util.js';
import type { Finding, Session, Thresholds, Turn } from '../model/index.js';

/** One tool call of a turn. Indices point into Timeline.tools. */
export interface TimelineTool {
  /** Tool name index into Timeline.tools. */
  n: number;
  /** Characters of the tool result as logged (inline size; 0 when no result was found). */
  c: number;
  /** 1 when the result was an error. */
  e?: 1;
  /** 1 when Claude Code externalized the output (`<persisted-output>`). */
  p?: 1;
  /** Index into Timeline.sessions of the subagent this call started, when known. */
  a?: number;
}

/** One deduped assistant turn. r/w/i/o are measured usage fields. */
export interface TimelineTurn {
  /** Timestamp, epoch ms. */
  t: number;
  /** cache read. */
  r: number;
  /** cache write (creation). */
  w: number;
  /** uncached input. */
  i: number;
  /** output. */
  o: number;
  /** Model index into Timeline.models. */
  m: number;
  /** ms since the previous turn of the same chain, or null. */
  g: number | null;
  /** Tool calls, when any. */
  x?: TimelineTool[];
}

export type MarkKind = 'rebuild' | 'compaction' | 'model' | 'version' | 'idle';

/** Something worth stopping the replay for, at turn index `at` of its session. */
export interface TimelineMark {
  k: MarkKind;
  at: number;
  /** One-line description, no content. */
  label: string;
  /** Measured tokens tied to the mark (a rebuild's cache write), when any. */
  tokens?: number;
  /** Rebuild cause (an attribution guess, estimated). */
  cause?: string;
}

export interface TimelineSession {
  id: string;
  /** Short display label. */
  label: string;
  sub: boolean;
  /** Parent index into Timeline.sessions (subagents whose parent is included). */
  parent?: number;
  agentId?: string;
  /** Subagent type from the parent's Agent/Task call (`subagent_type`), when logged. */
  agentType?: string;
  /** Parent turn index that started this subagent / that received its result. */
  spawnTurn?: number;
  returnTurn?: number;
  project: string;
  ccVersions: string[];
  /** Cache TTL the session used ('5m' | '1h'), from the cache-write split. */
  ttl: '5m' | '1h';
  turns: TimelineTurn[];
  marks: TimelineMark[];
  /** Largest context (input + cache read + cache write) of a turn. Measured. */
  peak: number;
  /** Sum of every token of every turn. Measured. */
  total: number;
  /**
   * Context window assumed for the fill gauge: 1,000,000 when any turn's context exceeded
   * 200,000, else 200,000. Estimated: the logs do not record the window size.
   */
  window: number;
}

export interface Timeline {
  tools: string[];
  models: string[];
  sessions: TimelineSession[];
  /** Evidence turn uuid → [session index, turn index], for "show in replay" links. */
  turnRefs: Record<string, [number, number]>;
  /** Sessions left out to keep the report small. */
  omitted: { sessions: number; turns: number };
}

export interface TimelineOptions {
  /** Most main sessions to include (largest by tokens first). */
  maxMainSessions?: number;
  /** Most turns in total across included sessions. */
  maxTurns?: number;
  /** Labels sessions by project; display only. */
  projectLabel?: (project: string) => string;
}

const SMALL_WINDOW = 200_000;
const LARGE_WINDOW = 1_000_000;

/** Turns the timeline follows: the main chain of a main session, every turn of a subagent. */
function chainOf(s: Session): Turn[] {
  return s.turns.filter((t) => !t.isSynthetic && (s.isSubagent || !t.isSidechain));
}

const totalOf = (turns: readonly Turn[]): number =>
  turns.reduce((a, t) => a + contextTokens(t.usage) + t.usage.output, 0);

/** Index of the first turn at or after `ts` (turns sorted by ts); turns.length if none. */
function turnAtOrAfter(turns: readonly Turn[], ts: number): number {
  let lo = 0;
  let hi = turns.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (turns[mid]!.ts < ts) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function dateLabel(ms: number): string {
  const d = new Date(ms);
  const mon = d.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' });
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${mon} ${d.getUTCDate()} ${hh}:${mm} UTC`;
}

const shortId = (id: string): string => (id.length > 8 ? id.slice(0, 8) : id);

function agentTypeOf(parent: Turn | undefined, toolUseId: string | undefined): string | undefined {
  const use = parent?.toolUses.find((u) => u.id === toolUseId);
  const input = use?.input;
  if (typeof input !== 'object' || input === null) return undefined;
  const v = (input as Record<string, unknown>).subagent_type;
  return typeof v === 'string' && v.length > 0 && v.length <= 64 ? v : undefined;
}

export function buildTimeline(
  sessions: readonly Session[],
  th: Thresholds,
  findings: readonly Finding[] = [],
  opts: TimelineOptions = {},
): Timeline {
  const maxMain = opts.maxMainSessions ?? 25;
  const maxTurns = opts.maxTurns ?? 30_000;
  const project = opts.projectLabel ?? ((p: string) => p);

  const chains = new Map<Session, Turn[]>();
  for (const s of sessions) {
    const c = chainOf(s);
    if (c.length > 0) chains.set(s, c);
  }
  const mains = [...chains.keys()]
    .filter((s) => !s.isSubagent)
    .sort((a, b) => totalOf(chains.get(b)!) - totalOf(chains.get(a)!) || a.firstTs - b.firstTs);
  const subsByParent = new Map<string, Session[]>();
  const orphans: Session[] = [];
  const mainIds = new Set(mains.map((s) => s.id));
  for (const s of chains.keys()) {
    if (!s.isSubagent) continue;
    if (s.parentSessionId !== undefined && mainIds.has(s.parentSessionId)) {
      const list = subsByParent.get(s.parentSessionId) ?? [];
      list.push(s);
      subsByParent.set(s.parentSessionId, list);
    } else orphans.push(s);
  }

  // Pick sessions: largest main sessions with their subagents, then orphan subagents, within the
  // turn budget. Each main session is kept with all of its subagents or not at all.
  const picked: Session[] = [];
  let turnsUsed = 0;
  let omittedSessions = 0;
  let omittedTurns = 0;
  const fits = (n: number): boolean => turnsUsed + n <= maxTurns;
  let mainsPicked = 0;
  for (const m of mains) {
    const group = [m, ...(subsByParent.get(m.id) ?? []).sort((a, b) => a.firstTs - b.firstTs)];
    const n = group.reduce((a, s) => a + chains.get(s)!.length, 0);
    if (mainsPicked < maxMain && fits(n)) {
      picked.push(...group);
      turnsUsed += n;
      mainsPicked++;
    } else {
      omittedSessions += group.length;
      omittedTurns += n;
    }
  }
  for (const s of orphans.sort((a, b) => totalOf(chains.get(b)!) - totalOf(chains.get(a)!))) {
    const n = chains.get(s)!.length;
    if (fits(n) && picked.length < maxMain * 40) {
      picked.push(s);
      turnsUsed += n;
    } else {
      omittedSessions++;
      omittedTurns += n;
    }
  }

  const tools: string[] = [];
  const toolIdx = new Map<string, number>();
  const models: string[] = [];
  const modelIdx = new Map<string, number>();
  const intern = (list: string[], idx: Map<string, number>, v: string): number => {
    let i = idx.get(v);
    if (i === undefined) {
      i = list.length;
      list.push(v);
      idx.set(v, i);
    }
    return i;
  };

  const index = new Map<Session, number>();
  picked.forEach((s, i) => index.set(s, i));
  const byId = new Map<string, Session>();
  for (const s of picked) if (!s.isSubagent) byId.set(s.id, s);

  // Rebuilds come from the analyzer (same predicate as the cache-rebuild finding).
  const rebuilds = findRebuilds(picked, th);
  const rebuildsBySession = new Map<Session, typeof rebuilds>();
  for (const r of rebuilds) {
    const list = rebuildsBySession.get(r.session) ?? [];
    list.push(r);
    rebuildsBySession.set(r.session, list);
  }

  // Which subagent each parent tool_use started.
  const subByToolUse = new Map<string, Session>();
  for (const s of picked)
    if (s.isSubagent && s.parentToolUseId) subByToolUse.set(s.parentToolUseId, s);

  const turnRefs: Record<string, [number, number]> = {};
  const wanted = new Set(findings.flatMap((f) => f.evidence.map((e) => e.turnUuid)));

  const out: TimelineSession[] = picked.map((s) => {
    const turns = chains.get(s)!;
    const si = index.get(s)!;
    const rows: TimelineTurn[] = turns.map((t, ti) => {
      if (wanted.has(t.uuid)) turnRefs[t.uuid] = [si, ti];
      const x: TimelineTool[] = t.toolUses.map((u) => {
        const res = t.toolResults.find((r) => r.toolUseId === u.id);
        const tool: TimelineTool = { n: intern(tools, toolIdx, u.name), c: res?.chars ?? 0 };
        if (res?.isError) tool.e = 1;
        if (res?.persisted) tool.p = 1;
        const sub = subByToolUse.get(u.id);
        if (sub !== undefined) tool.a = index.get(sub)!;
        return tool;
      });
      const row: TimelineTurn = {
        t: t.ts,
        r: t.usage.cacheRead,
        w: t.usage.cacheWrite,
        i: t.usage.input,
        o: t.usage.output,
        m: intern(models, modelIdx, t.model),
        g: t.gapMs,
      };
      if (x.length > 0) row.x = x;
      return row;
    });

    const marks: TimelineMark[] = [];
    const posOf = new Map(turns.map((t, i) => [t.uuid, i]));
    for (const r of rebuildsBySession.get(s) ?? []) {
      const at = posOf.get(r.turn.uuid);
      if (at === undefined) continue;
      marks.push({
        k: 'rebuild',
        at,
        label: r.detail,
        tokens: r.turn.usage.cacheWrite,
        cause: r.cause,
      });
    }
    // Compactions: markers with no assistant turn between them count once (as A8 does).
    const compactAt = new Set<number>();
    for (const ev of s.events) {
      if (ev.kind !== 'compaction') continue;
      const at = turnAtOrAfter(turns, ev.ts);
      if (at < turns.length) compactAt.add(at);
    }
    for (const at of [...compactAt].sort((a, b) => a - b))
      marks.push({
        k: 'compaction',
        at,
        label: 'context compacted; the next turn starts a new cache prefix',
      });
    const ttlMs = cacheTtlMs(s, th);
    const ttl = sessionTtl(s);
    for (let i = 1; i < turns.length; i++) {
      const prev = turns[i - 1]!;
      const t = turns[i]!;
      if (t.model !== prev.model)
        marks.push({ k: 'model', at: i, label: `model ${prev.model} → ${t.model}` });
      if (t.ccVersion && prev.ccVersion && t.ccVersion !== prev.ccVersion)
        marks.push({
          k: 'version',
          at: i,
          label: `Claude Code ${prev.ccVersion} → ${t.ccVersion}`,
        });
      if (t.gapMs !== null && t.gapMs > ttlMs)
        marks.push({
          k: 'idle',
          at: i,
          label: `idle ${formatDuration(t.gapMs)}, longer than the ${ttl} cache TTL`,
        });
    }
    marks.sort((a, b) => a.at - b.at);

    const sizes = turns.map((t) => contextTokens(t.usage));
    const peak = Math.max(0, ...sizes);
    const row: TimelineSession = {
      id: s.id,
      label: '',
      sub: s.isSubagent,
      project: s.cwd
        ? (s.cwd
            .replace(/[\\/]+$/, '')
            .split(/[\\/]/)
            .pop() ?? project(s.project))
        : project(s.project),
      ccVersions: [...s.ccVersions],
      ttl,
      turns: rows,
      marks,
      peak,
      total: totalOf(turns),
      window: peak > SMALL_WINDOW ? LARGE_WINDOW : SMALL_WINDOW,
    };
    if (s.isSubagent) {
      if (s.agentId !== undefined) row.agentId = s.agentId;
      const parent = s.parentSessionId !== undefined ? byId.get(s.parentSessionId) : undefined;
      if (parent !== undefined) {
        row.parent = index.get(parent)!;
        const pturns = chains.get(parent)!;
        const spawn = pturns.findIndex((t) => t.toolUses.some((u) => u.id === s.parentToolUseId));
        if (spawn >= 0) {
          row.spawnTurn = spawn;
          const type = agentTypeOf(pturns[spawn], s.parentToolUseId);
          if (type !== undefined) row.agentType = type;
          const res = pturns[spawn]!.toolResults.find((r) => r.toolUseId === s.parentToolUseId);
          if (res?.ts !== undefined) {
            const back = turnAtOrAfter(pturns, res.ts);
            if (back < pturns.length) row.returnTurn = back;
          }
        }
      }
      row.label = `agent ${shortId(s.agentId ?? s.id)}${row.agentType ? ` (${row.agentType})` : ''}`;
    } else {
      row.label = `${row.project} · ${dateLabel(s.firstTs)}`;
    }
    return row;
  });

  return {
    tools,
    models,
    sessions: out,
    turnRefs,
    omitted: { sessions: omittedSessions, turns: omittedTurns },
  };
}

/**
 * JSON for embedding inside an inline <script> element: `<`, `>`, `&` and the JS line
 * separators are escaped so no logged string can close the element or break out of it.
 */
export function scriptJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}
