// Automated false-positive spot check (real-log validation, SPEC §7). LOCAL ONLY: never in CI.
//
//   pnpm fp-check                               # last 30 days, default roots
//   pnpm fp-check --root DIR [--root DIR]       # other projects dirs
//   pnpm fp-check --since 2026-10-01 --max 20
//
// Loads sessions with the project's own parser and runs the analyzers (like validate-real.ts),
// samples up to --max findings spread across analyzers (round-robin in registry order, highest
// $ impact then tokens first), and re-checks each finding's evidence pointers against the RAW
// JSONL lines, read again here without the parser:
//   evidence   the record with the evidence turn's uuid exists, and the file:line pointer holds
//              a record (it may be a supporting record, e.g. a prompt_snapshot, not the turn)
//   usage      measured findings only: the parser's usage for that turn, which the finding's
//              numbers come from, equals the raw `message.usage` fields; numbers the evidence
//              detail quotes exactly (`cache_write N`, `rewrote N tokens`) match too
//   invariant  a cheap analyzer-specific property recomputed from raw lines (see INVARIANTS)
// Each check is pass, fail or n.a. Output is counts only: analyzer ids, hashed session ids
// (sha256, 10 hex chars), check results and usage field names. No paths, prompts, file names,
// commands or contents are printed. This checks evidence mechanically; it does not judge
// whether the advice is right.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { ANALYZERS } from '../src/analyzers/index.js';
import { displayPath, normPath } from '../src/analyzers/util.js';
import { defaultRoots } from '../src/discover.js';
import {
  DEFAULT_THRESHOLDS,
  type Finding,
  type Session,
  type Thresholds,
  type Turn,
} from '../src/model/index.js';
import { loadSessions } from '../src/parser/index.js';
import { buildReport } from '../src/pipeline.js';
import { hashId } from './validate-real.js';

export const DEFAULT_MAX = 20;
/** Evidence entries re-checked per finding (a finding can carry up to 50). */
export const EVIDENCE_PER_FINDING = 5;

export type Verdict = 'pass' | 'fail' | 'n.a.';
export interface FindingCheck {
  analyzer: string;
  session: string;
  evidence: Verdict;
  usage: Verdict;
  invariant: Verdict;
  /** Short machine reasons for fails (field names, never values from the logs' text). */
  notes: string[];
}

// ---- Raw JSONL, read without the parser -------------------------------------------------------

interface RawUsage {
  input: number;
  cacheWrite: number;
  cacheRead: number;
  output: number;
}

export interface RawRec {
  line: number;
  uuid?: string;
  type?: string;
  sessionId?: string;
  isSidechain: boolean;
  ts: number;
  msgId?: string;
  requestId?: string;
  model?: string;
  usage?: RawUsage;
  /** tool_use blocks on this line: name and (Read-like tools) file_path. Kept in memory only. */
  tools: { name: string; filePath?: string }[];
  error: boolean;
  cwd?: string;
}

export interface RawFile {
  recs: RawRec[];
  byUuid: Map<string, RawRec>;
  byLine: Map<number, RawRec>;
}

const obj = (v: unknown): Record<string, unknown> | undefined =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
const s = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const cnt = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);

/** Index the lines of one transcript. Malformed lines are skipped. */
export function indexRaw(text: string): RawFile {
  const recs: RawRec[] = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!.trim();
    if (l === '') continue;
    let r: Record<string, unknown> | undefined;
    try {
      r = obj(JSON.parse(l));
    } catch {
      continue;
    }
    if (r === undefined) continue;
    const m = obj(r.message);
    const u = obj(m?.usage);
    const content = Array.isArray(m?.content) ? (m.content as unknown[]) : [];
    const tools: RawRec['tools'] = [];
    for (const b of content) {
      const bo = obj(b);
      if (bo?.type !== 'tool_use' || typeof bo.name !== 'string') continue;
      const fp = s(obj(bo.input)?.file_path);
      tools.push({ name: bo.name, ...(fp !== undefined ? { filePath: fp } : {}) });
    }
    const ts = Date.parse(s(r.timestamp) ?? '');
    const model = s(m?.model);
    recs.push({
      line: i + 1,
      uuid: s(r.uuid),
      type: s(r.type),
      sessionId: s(r.sessionId),
      isSidechain: r.isSidechain === true,
      ts: Number.isFinite(ts) ? ts : NaN,
      msgId: s(m?.id),
      requestId: s(r.requestId),
      model,
      usage:
        u === undefined
          ? undefined
          : {
              input: cnt(u.input_tokens),
              cacheWrite: cnt(u.cache_creation_input_tokens),
              cacheRead: cnt(u.cache_read_input_tokens),
              output: cnt(u.output_tokens),
            },
      tools,
      // UNVERIFIED: a `system` record whose subtype contains "error" (not seen in a real log).
      error:
        r.isApiErrorMessage === true ||
        r.error !== undefined ||
        model === '<synthetic>' ||
        (r.type === 'system' && /error/i.test(s(r.subtype) ?? '')),
      cwd: s(r.cwd),
    });
  }
  const byUuid = new Map<string, RawRec>();
  const byLine = new Map<number, RawRec>();
  for (const r of recs) {
    if (r.uuid !== undefined && !byUuid.has(r.uuid)) byUuid.set(r.uuid, r);
    byLine.set(r.line, r);
  }
  return { recs, byUuid, byLine };
}

// UNVERIFIED: older Claude Code versions may have written partial output_tokens on earlier
// block lines, so output is the max over the lines (2.1.302 writes identical usage on each).
/** One API response as raw lines: every assistant line with the same message.id (+ requestId). */
interface RawResponse {
  first: RawRec;
  ts: number;
  /** Usage of the first line; output_tokens is the max over the lines (older CCs wrote partials). */
  usage?: RawUsage;
  tools: RawRec['tools'];
  synthetic: boolean;
}

function responses(recs: readonly RawRec[]): RawResponse[] {
  const by = new Map<string, RawResponse>();
  const out: RawResponse[] = [];
  for (const r of recs) {
    if (r.type !== 'assistant') continue;
    const key = r.msgId !== undefined ? `${r.msgId}\u0000${r.requestId ?? ''}` : `line:${r.line}`;
    const g = by.get(key);
    if (g === undefined) {
      const n: RawResponse = {
        first: r,
        ts: r.ts,
        ...(r.usage !== undefined ? { usage: { ...r.usage } } : {}),
        tools: [...r.tools],
        synthetic: r.error,
      };
      by.set(key, n);
      out.push(n);
      continue;
    }
    g.tools.push(...r.tools);
    if (g.usage === undefined && r.usage !== undefined) g.usage = { ...r.usage };
    else if (g.usage !== undefined && r.usage !== undefined)
      g.usage.output = Math.max(g.usage.output, r.usage.output);
  }
  return out;
}

const responseOf = (all: readonly RawResponse[], uuid: string): RawResponse | undefined =>
  all.find((g) => g.first.uuid === uuid);

/** Previous response of the same chain (main: non-sidechain) before `cur`, by timestamp. */
function prevInChain(all: readonly RawResponse[], cur: RawResponse): RawResponse | undefined {
  let best: RawResponse | undefined;
  for (const g of all) {
    if (g === cur || g.first.isSidechain !== cur.first.isSidechain) continue;
    if (g.first.sessionId !== cur.first.sessionId) continue;
    if (!(g.ts < cur.ts)) continue;
    if (best === undefined || g.ts > best.ts) best = g;
  }
  return best;
}

// ---- Sampling ---------------------------------------------------------------------------------

const weight = (f: Finding): [number, number] => [f.impact?.savingsUsd ?? 0, f.tokens.value];

/**
 * Up to `max` findings, round-robin across analyzers (registry order, unknown ids after it, by
 * name), each analyzer's findings by $ impact then tokens, highest first. Deterministic.
 */
export function sampleFindings(findings: readonly Finding[], max = DEFAULT_MAX): Finding[] {
  const order = ANALYZERS.map((a) => a.id);
  const groups = new Map<string, Finding[]>();
  for (const f of findings) groups.set(f.analyzer, [...(groups.get(f.analyzer) ?? []), f]);
  const ids = [...groups.keys()].sort((a, b) => {
    const ia = order.indexOf(a);
    const ib = order.indexOf(b);
    if (ia !== ib) return (ia < 0 ? Infinity : ia) - (ib < 0 ? Infinity : ib);
    return a < b ? -1 : a > b ? 1 : 0;
  });
  const queues = ids.map((id) =>
    [...groups.get(id)!].sort((a, b) => {
      const [ua, ta] = weight(a);
      const [ub, tb] = weight(b);
      return ub - ua || tb - ta || (a.title < b.title ? -1 : a.title > b.title ? 1 : 0);
    }),
  );
  const out: Finding[] = [];
  while (out.length < max && queues.some((q) => q.length > 0))
    for (const q of queues) {
      const f = q.shift();
      if (f !== undefined && out.length < max) out.push(f);
    }
  return out;
}

// ---- Checks -----------------------------------------------------------------------------------

export interface CheckInput {
  sessions: readonly Session[];
  /** Raw text of a transcript file. Injected by tests; default readFileSync. */
  readText?: (file: string) => string;
  thresholds?: Thresholds;
}

const combine = (vs: readonly Verdict[]): Verdict =>
  vs.includes('fail') ? 'fail' : vs.includes('pass') ? 'pass' : 'n.a.';

const USAGE_FIELDS = [
  ['input', 'input_tokens'],
  ['cacheWrite', 'cache_creation_input_tokens'],
  ['cacheRead', 'cache_read_input_tokens'],
  ['output', 'output_tokens'],
] as const;

/** Exact numbers an evidence detail quotes (formatInt, `,` separators). */
function quoted(detail: string): Partial<RawUsage> {
  const n = (re: RegExp): number | undefined => {
    const m = re.exec(detail);
    return m ? Number(m[1]!.replace(/,/g, '')) : undefined;
  };
  const w = n(/cache_write ([\d,]+)/) ?? n(/rewrote ([\d,]+) tokens/);
  return w !== undefined ? { cacheWrite: w } : {};
}

/** Finds a check can recompute from raw lines alone. Others are n.a. */
type Invariant = (a: {
  f: Finding;
  ev: Finding['evidence'][number];
  cur: RawResponse | undefined;
  all: readonly RawResponse[];
  recs: readonly RawRec[];
  th: Thresholds;
  index: number;
}) => { v: Verdict; note?: string };

const ctx = (u: RawUsage): number => u.input + u.cacheRead + u.cacheWrite;

export const INVARIANTS: Record<string, Invariant> = {
  // cache_read dropped and cache_creation was large, vs the previous response of the chain.
  'cache-rebuild': ({ cur, all, th }) => {
    if (cur?.usage === undefined) return { v: 'n.a.' };
    const prev = prevInChain(all, cur);
    if (prev?.usage === undefined) return { v: 'n.a.' };
    const p = prev.usage;
    const u = cur.usage;
    const ok =
      p.cacheRead > 0 &&
      u.cacheRead <= (1 - th.rebuildReadDropFraction) * p.cacheRead &&
      u.cacheWrite >= Math.max(th.rebuildMinCacheWrite, th.rebuildPrevContextFraction * ctx(p));
    return ok ? { v: 'pass' } : { v: 'fail', note: 'rebuild rule not met on raw usage' };
  },
  // The gap to the previous response is 5–60 min; 1h advice: it wrote; 5m advice: it read.
  'cache-ttl': ({ f, cur, all, th }) => {
    if (cur?.usage === undefined) return { v: 'n.a.' };
    const prev = prevInChain(all, cur);
    if (prev === undefined) return { v: 'n.a.' };
    const gap = cur.ts - prev.ts;
    const inGap = gap > th.ttl5mMs && gap <= th.ttl1hMs;
    const ttl = f.data?.ttl;
    const ok =
      inGap &&
      (ttl === '1h' ? cur.usage.cacheWrite > 0 : ttl === '5m' ? cur.usage.cacheRead > 0 : true);
    return ok ? { v: 'pass' } : { v: 'fail', note: 'gap or cache use off on raw lines' };
  },
  // The first evidence turn is the peak: its raw context equals the finding's token value.
  'context-growth': ({ f, cur, index }) => {
    if (index !== 0 || cur?.usage === undefined) return { v: 'n.a.' };
    return ctx(cur.usage) === f.tokens.value
      ? { v: 'pass' }
      : { v: 'fail', note: 'peak context differs from raw usage' };
  },
  // The same path appears in ≥ 2 raw Read tool_use inputs of the session.
  'repeated-read': ({ f, recs }) => {
    const want = f.data?.path;
    if (typeof want !== 'string') return { v: 'n.a.' };
    const cwd0 = recs.find((r) => r.cwd !== undefined)?.cwd;
    const base = cwd0 !== undefined ? normPath(cwd0) : undefined;
    let n = 0;
    for (const r of recs)
      if (r.type === 'assistant')
        for (const t of r.tools)
          if (t.name === 'Read' && t.filePath !== undefined) {
            const p = normPath(t.filePath, r.cwd ?? cwd0);
            if (displayPath(p, base) === want || p.endsWith(`/${want}`)) n++;
          }
    return n >= 2 ? { v: 'pass' } : { v: 'fail', note: 'fewer than 2 raw Reads of the path' };
  },
  // The evidence response called the tool the finding names.
  'big-tool-output': ({ f, cur }) => toolCalled(f, cur),
  'error-waste': ({ f, ev, cur, recs }) => {
    if (typeof f.data?.tool === 'string') return toolCalled(f, cur);
    // API errors: the evidence record is an error / synthetic record.
    const r = recs.find((x) => x.uuid === ev.turnUuid);
    if (r === undefined) return { v: 'n.a.' };
    return r.error ? { v: 'pass' } : { v: 'fail', note: 'evidence record is not an error' };
  },
  // The evidence turn is a subagent / sidechain response.
  'subagent-cost': ({ cur }) => {
    if (cur === undefined) return { v: 'n.a.' };
    return cur.first.isSidechain
      ? { v: 'pass' }
      : { v: 'fail', note: 'evidence turn is not a sidechain' };
  },
};

function toolCalled(f: Finding, cur: RawResponse | undefined): { v: Verdict; note?: string } {
  const tool = f.data?.tool;
  if (typeof tool !== 'string' || cur === undefined) return { v: 'n.a.' };
  return cur.tools.some((t) => t.name === tool)
    ? { v: 'pass' }
    : { v: 'fail', note: 'evidence response has no such tool_use' };
}

/** Re-check one finding's evidence against raw lines. */
export function checkFinding(f: Finding, input: CheckInput): FindingCheck {
  const readText = input.readText ?? ((p: string) => readFileSync(p, 'utf8'));
  const th = input.thresholds ?? DEFAULT_THRESHOLDS;
  const cache = new Map<string, RawFile | null>();
  const raw = (file: string): RawFile | null => {
    if (!cache.has(file)) {
      let r: RawFile | null = null;
      try {
        r = indexRaw(readText(file));
      } catch {
        r = null;
      }
      cache.set(file, r);
    }
    return cache.get(file)!;
  };
  const byId = new Map(input.sessions.map((x) => [x.id, x]));
  const turnByUuid = new Map<string, Turn>();
  const notes = new Set<string>();
  const evs: Verdict[] = [];
  const uses: Verdict[] = [];
  const invs: Verdict[] = [];
  const evidence = f.evidence.slice(0, EVIDENCE_PER_FINDING);
  evidence.forEach((ev, index) => {
    const session = byId.get(ev.sessionId);
    const files = [...new Set([...(ev.source ? [ev.source.file] : []), ...(session?.files ?? [])])];
    const recs = files.flatMap((p) => raw(p)?.recs ?? []);
    const all = responses(recs);
    // (a) the record exists, and the pointer's line holds it
    if (ev.turnUuid !== '') {
      let found: RawRec | undefined;
      for (const p of files) {
        found = raw(p)?.byUuid.get(ev.turnUuid);
        if (found !== undefined) break;
      }
      // Standalone events without a uuid are keyed `${file}:${line}` by the analyzers.
      if (found === undefined && ev.source && ev.turnUuid === `${ev.source.file}:${ev.source.line}`)
        found = raw(ev.source.file)?.byLine.get(ev.source.line);
      // The pointer may name a supporting record (e.g. a prompt_snapshot) other than the turn:
      // it must hold a valid record, not necessarily the one with turnUuid.
      const pointerOk = ev.source === undefined || raw(ev.source.file)?.byLine.has(ev.source.line);
      if (found === undefined) notes.add('evidence record not found');
      if (pointerOk !== true) notes.add('evidence line pointer has no record');
      evs.push(found !== undefined && pointerOk === true ? 'pass' : 'fail');
    } else evs.push('n.a.');
    const cur = ev.turnUuid !== '' ? responseOf(all, ev.turnUuid) : undefined;

    // (b) measured usage of that turn vs raw message.usage
    if (f.tokens.kind === 'measured' && cur?.usage !== undefined) {
      if (turnByUuid.size === 0)
        for (const x of input.sessions) for (const t of x.turns) turnByUuid.set(t.uuid, t);
      const t = turnByUuid.get(ev.turnUuid);
      let bad = false;
      if (t !== undefined)
        for (const [k, rawKey] of USAGE_FIELDS)
          if (t.usage[k] !== cur.usage[k]) {
            bad = true;
            notes.add(`${rawKey} differs`);
          }
      const q = quoted(ev.detail);
      if (q.cacheWrite !== undefined && q.cacheWrite !== cur.usage.cacheWrite) {
        bad = true;
        notes.add('quoted cache_creation_input_tokens differs');
      }
      uses.push(t === undefined && q.cacheWrite === undefined ? 'n.a.' : bad ? 'fail' : 'pass');
    } else uses.push('n.a.');

    // (c) analyzer-specific invariant
    const inv = INVARIANTS[f.analyzer];
    if (inv === undefined) invs.push('n.a.');
    else {
      const r = inv({ f, ev, cur, all, recs, th, index });
      invs.push(r.v);
      if (r.note !== undefined && r.v === 'fail') notes.add(r.note);
    }
  });
  return {
    analyzer: f.analyzer,
    session: f.evidence[0] !== undefined ? hashId(f.evidence[0].sessionId) : '-'.repeat(10),
    evidence: combine(evs),
    usage: combine(uses),
    invariant: combine(invs),
    notes: [...notes].sort(),
  };
}

export const allPassed = (c: FindingCheck): boolean =>
  c.evidence !== 'fail' &&
  c.usage !== 'fail' &&
  c.invariant !== 'fail' &&
  [c.evidence, c.usage, c.invariant].includes('pass');

export const DISCLAIMER =
  'note: this checks evidence pointers and measured numbers mechanically against the raw logs; ' +
  'it is NOT a substitute for judging whether the advice is right (that still needs a human).';

export function formatChecks(cs: readonly FindingCheck[], totalFindings: number): string[] {
  const lines = [
    `fp-check: ${cs.length} of ${totalFindings} findings sampled (round-robin by analyzer, highest impact first)`,
    '  #   analyzer           session      evidence  usage[M]  invariant',
  ];
  cs.forEach((c, i) =>
    lines.push(
      `  ${String(i + 1).padStart(2)}  ${c.analyzer.padEnd(18)} ${c.session}  ` +
        `${c.evidence.padEnd(8)}  ${c.usage.padEnd(8)}  ${c.invariant.padEnd(9)}` +
        (c.notes.length > 0 ? `  (${c.notes.join('; ')})` : ''),
    ),
  );
  const ok = cs.filter(allPassed).length;
  const failed = cs.filter((c) => [c.evidence, c.usage, c.invariant].includes('fail')).length;
  lines.push(
    '',
    `SUMMARY: ${cs.length} findings checked · ${ok} passed all mechanical checks · ` +
      `${failed} with a failed check · ${cs.length - ok - failed} with nothing checkable`,
    DISCLAIMER,
  );
  return lines;
}

async function mainScript(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      root: { type: 'string', multiple: true },
      since: { type: 'string' },
      max: { type: 'string' },
    },
  });
  const now = new Date();
  const since =
    values.since !== undefined
      ? new Date(values.since)
      : new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  if (Number.isNaN(since.getTime())) throw new Error('--since: not a date');
  const max = values.max !== undefined ? Number(values.max) : DEFAULT_MAX;
  if (!Number.isInteger(max) || max < 1) throw new Error('--max: a positive integer');
  const { sessions, stats } = await loadSessions({ roots: values.root ?? defaultRoots(), since });
  const report = buildReport({
    sessions,
    stats,
    ctx: { thresholds: DEFAULT_THRESHOLDS, now, includeContent: false },
    window: { since: since.toISOString(), until: null, project: null },
    includeContent: false,
  });
  const picked = sampleFindings(report.findings, max);
  const checks = picked.map((f) => checkFinding(f, { sessions }));
  process.stdout.write(`${formatChecks(checks, report.findings.length).join('\n')}\n`);
  return checks.some((c) => [c.evidence, c.usage, c.invariant].includes('fail')) ? 1 : 0;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  mainScript(process.argv.slice(2)).then(
    (code) => (process.exitCode = code),
    (e: unknown) => {
      process.stderr.write(`fp-check: ${e instanceof Error ? e.message : String(e)}\n`);
      process.exitCode = 2;
    },
  );
}
