// `tknxray share` (SPEC §3.2): the report as a volunteer can share it without sending
// transcripts. Shape: schema/share.v1.json.
//
// Unlike `--json`, which keeps titles, evidence details, project names and short commands for the
// user's own use, this keeps only numbers, a few fixed vocabularies (analyzer ids, severities,
// built-in tool names, claude-* model ids, Claude Code versions, enum values the analyzers set)
// and salted hashes of session ids. Every other string is dropped or replaced by "(other)".
// The salt is random per file and never written, so two files cannot be joined on a session.
import { createHmac, randomBytes } from 'node:crypto';
import type {
  CostTotals,
  Finding,
  Report,
  Severity,
  TokenKind,
  TokenTotals,
} from '../model/index.js';

export const SHARE_SCHEMA_VERSION = 1;

export const SHARE_PRIVACY_NOTE =
  'No prompts, outputs, file contents, file paths, commands, project names, finding titles or ' +
  'session ids. Session ids are salted hashes; the salt was not saved. Strings outside fixed ' +
  'lists (built-in tool names, claude-* model ids, Claude Code versions) read "(other)".';

export type Verdict = 'real' | 'false-positive' | 'unsure';

export interface ShareFinding {
  /** 1-based position, the number `tknxray` and `tknxray share` print for it. */
  n: number;
  analyzer: string;
  severity: Severity;
  tokens: { value: number; kind: TokenKind };
  impact?: {
    costUsd: number;
    savingsUsd: number;
    savingsMainUsd: number;
    savingsSubagentUsd: number;
    confidence: 'measured-tokens' | 'estimated';
    upperBound?: true;
  };
  data: Record<string, unknown>;
  /** How many evidence turns the finding listed, and the salted hashes of their sessions. */
  evidence: { turns: number; sessions: string[] };
  /** Filled in by the volunteer: is this finding a real problem in their sessions? */
  review: { verdict: Verdict | null; note: string };
}

export interface ShareReport {
  schemaVersion: 1;
  kind: 'tknxray-share';
  tool: { name: 'tknxray'; version: string };
  /** UTC day the file was made. */
  generatedOn: string;
  window: { since: string | null; until: string | null; projectFilter: boolean };
  privacy: string;
  stats: {
    roots: number;
    files: number;
    bytes: number;
    lines: number;
    blankLines: number;
    malformedLines: number;
    recordTypes: Record<string, number>;
    unknownRecordTypes: Record<string, number>;
    attachmentTypes: Record<string, number>;
    dedupe: { sameResponseLines: number; sidechainReplays: number; crossSessionCopies: number };
    syntheticTurns: number;
    ccVersions: Record<string, number>;
    warnings: Record<string, number>;
  };
  totals: {
    all: TokenTotals;
    byModel: Record<string, TokenTotals>;
    byRole?: { main: TokenTotals; subagent: TokenTotals };
    activeDays: number;
  };
  sessions: { count: number; main: number; subagents: number };
  findings: ShareFinding[];
  calibration?: { samples: number; medianRatio: number | null };
  pricing?: { asOf: string; unpricedModels: Record<string, number> };
  actionPlan?: {
    windowCostUsd: number;
    combinedSavingsUsd: number;
    combinedSharePct: number;
    combinedUpperBound?: true;
    actions: {
      id: string;
      category: string;
      savingsUsd: number;
      sharePct: number;
      savingsMainUsd: number;
      savingsSubagentUsd: number;
      confidence: 'measured-tokens' | 'estimated';
      findings: number[];
      upperBound?: true;
    }[];
  };
  /** Free text for the volunteer. */
  notes: string;
}

export const OTHER = '(other)';

/** An id the analyzers or Claude Code set: lower-case words joined by `-` or `_`. */
const ID = /^[a-z][a-z0-9_-]{0,39}$/;
/** An enum value an analyzer sets (`ttl-expiry`, `1h`). */
const ENUM = /^[a-z0-9][a-z0-9_-]{0,39}$/;
/** A record or attachment type as Claude Code writes them (`assistant`, `hook_success`). */
const RECORD_TYPE = /^[A-Za-z][A-Za-z0-9_-]{0,39}$/;
const MODEL = /^claude-[a-z0-9][a-z0-9.-]{0,62}$/;
const CC_VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,6}$/;
/** Built-in tools are one PascalCase word; anything else a user can name goes through MCP. */
const BUILTIN_TOOL = /^[A-Z][A-Za-z0-9]{1,39}$/;
/** tknxray's own parse warnings: fixed English phrases (src/parser). */
const WARNING = /^[a-z][a-z0-9 ._()-]{0,79}$/i;
const DAY = /^\d{4}-\d{2}-\d{2}/;
/** Finding.data keys are camelCase words the analyzers choose. */
const DATA_KEY = /^[A-Za-z][A-Za-z0-9]{0,39}$/;

/** Subagent types Claude Code ships; any other type name is a user's or plugin's own agent. */
const BUILTIN_AGENT_TYPES = new Set([
  'general-purpose',
  'Explore',
  'Plan',
  'statusline-setup',
  'output-style-setup',
  'claude-code-guide',
  '(unknown)',
]);

export const shareModel = (m: string): string => (MODEL.test(m) || m === '<synthetic>' ? m : OTHER);

export function shareTool(t: string): string {
  if (t.startsWith('mcp__')) return 'mcp';
  return BUILTIN_TOOL.test(t) ? t : OTHER;
}

const shareAgentType = (t: string): string => (BUILTIN_AGENT_TYPES.has(t) ? t : '(custom)');

/** Keys whose string values are analyzer enums (`cause: 'ttl-expiry'`, `ttl: '1h'`). */
const ENUM_KEYS = new Set(['cause', 'match', 'tokensKind', 'ttl']);
const MODEL_KEYS = new Set(['model', 'parentModel', 'cheaperModel']);
const NESTED_KEYS = new Set(['causes', 'subagentTypes']);

/** A per-file keyed hash: equal within one file, unlinkable across files. */
export type Hasher = (sessionId: string) => string;

/**
 * A subagent's key is `<sessionId>:agent-<agentId>`; its two parts are hashed apart, so a
 * subagent's hash starts with its parent session's (`3f1c…:9a0b…`).
 */
export function makeHasher(salt: Buffer = randomBytes(16)): Hasher {
  const h = (s: string, n: number) =>
    createHmac('sha256', salt).update(s).digest('hex').slice(0, n);
  return (id) => {
    const i = id.indexOf(':agent-');
    return i < 0 ? h(id, 12) : `${h(id.slice(0, i), 12)}:${h(id.slice(i + 1), 8)}`;
  };
}

/** How the local list names a session: the id's first 8 characters, as `tknxray` shows it. */
export function localSessionLabel(id: string): string {
  const i = id.indexOf(':agent-');
  return i < 0 ? id.slice(0, 8) : `${id.slice(0, 8)} subagent ${id.slice(i + 7, i + 15)}`;
}

/** Finding.data as shared: numbers, booleans and the known vocabularies; no free text. */
export function shareData(data: Record<string, unknown>, hash: Hasher): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) {
    if (!DATA_KEY.test(k)) continue;
    if (typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v))) out[k] = v;
    else if (NESTED_KEYS.has(k) && Array.isArray(v)) {
      out[k] = v
        .filter((c): c is Record<string, unknown> => typeof c === 'object' && c !== null)
        .map((c) => shareData(c, hash));
    } else if (typeof v !== 'string') continue;
    else if (k === 'tool') out.tool = shareTool(v);
    else if (MODEL_KEYS.has(k)) out[k] = v === '' ? '' : shareModel(v);
    else if (k === 'subagentModels') {
      out.subagentModels = v === '' ? '' : v.split(', ').map(shareModel).join(', ');
    } else if (k === 'type') out.type = shareAgentType(v);
    else if (k === 'parentSessionId') out.parentSessionId = hash(v);
    else if (ENUM_KEYS.has(k) && ENUM.test(v)) out[k] = v;
    else if (ENUM_KEYS.has(k)) out[k] = OTHER;
    // Anything else (titles, paths, commands, fix text) is dropped.
  }
  return out;
}

/** Counts keyed by strings from the logs: keys outside `ok` are summed under "(other)". */
function shareCounts(
  counts: Record<string, number>,
  ok: (k: string) => boolean,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, n] of Object.entries(counts)) {
    const key = ok(k) ? k : OTHER;
    out[key] = (out[key] ?? 0) + n;
  }
  return out;
}

function addCost(a: CostTotals | undefined, b: CostTotals | undefined): CostTotals | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return {
    input: a.input + b.input,
    write5m: a.write5m + b.write5m,
    write1h: a.write1h + b.write1h,
    read: a.read + b.read,
    output: a.output + b.output,
    total: a.total + b.total,
    unpricedTurns: a.unpricedTurns + b.unpricedTurns,
  };
}

/** The sum of two token totals, with the hit ratio recomputed from the sums. */
export function addTotals(a: TokenTotals, b: TokenTotals): TokenTotals {
  const input = a.input + b.input;
  const cacheWrite = a.cacheWrite + b.cacheWrite;
  const cacheRead = a.cacheRead + b.cacheRead;
  const denom = input + cacheWrite + cacheRead;
  const cost = addCost(a.cost, b.cost);
  return {
    input,
    cacheWrite,
    cacheWrite5m: a.cacheWrite5m + b.cacheWrite5m,
    cacheWrite1h: a.cacheWrite1h + b.cacheWrite1h,
    cacheRead,
    output: a.output + b.output,
    cacheHitRatio: denom === 0 ? null : cacheRead / denom,
    turns: a.turns + b.turns,
    ...(cost !== undefined ? { cost } : {}),
  };
}

function shareFinding(f: Finding, n: number, hash: Hasher): ShareFinding {
  const sessions = [...new Set(f.evidence.map((e) => hash(e.sessionId)))].sort();
  const i = f.impact;
  return {
    n,
    analyzer: ID.test(f.analyzer) ? f.analyzer : OTHER,
    severity: f.severity,
    tokens: { value: f.tokens.value, kind: f.tokens.kind },
    ...(i
      ? {
          impact: {
            costUsd: i.costUsd,
            savingsUsd: i.savingsUsd,
            savingsMainUsd: i.savingsMainUsd,
            savingsSubagentUsd: i.savingsSubagentUsd,
            confidence: i.confidence,
            ...(i.upperBound ? { upperBound: true as const } : {}),
          },
        }
      : {}),
    data: shareData(f.data ?? {}, hash),
    evidence: { turns: f.evidence.length, sessions },
    review: { verdict: null, note: '' },
  };
}

const day = (s: string | null): string | null =>
  s !== null && DAY.test(s) ? s.slice(0, 10) : null;

export interface ShareOptions {
  hash?: Hasher;
  now?: Date;
}

export function shareReport(report: Report, opts: ShareOptions = {}): ShareReport {
  const hash = opts.hash ?? makeHasher();
  const s = report.stats;
  const byModel: Record<string, TokenTotals> = {};
  for (const [m, t] of Object.entries(report.totals.byModel)) {
    const key = shareModel(m);
    byModel[key] = byModel[key] ? addTotals(byModel[key], t) : t;
  }
  const subagents = report.sessions.filter((x) => x.isSubagent).length;
  const plan = report.actionPlan;
  return {
    schemaVersion: SHARE_SCHEMA_VERSION,
    kind: 'tknxray-share',
    tool: { name: 'tknxray', version: report.tool.version },
    generatedOn: (opts.now ?? new Date()).toISOString().slice(0, 10),
    window: {
      since: day(report.window.since),
      until: day(report.window.until),
      projectFilter: report.window.project !== null,
    },
    privacy: SHARE_PRIVACY_NOTE,
    stats: {
      roots: s.roots.length,
      files: s.files,
      bytes: s.bytes,
      lines: s.lines,
      blankLines: s.blankLines,
      malformedLines: s.malformedLines,
      recordTypes: shareCounts(s.recordTypes, (k) => RECORD_TYPE.test(k)),
      unknownRecordTypes: shareCounts(s.unknownRecordTypes, (k) => RECORD_TYPE.test(k)),
      attachmentTypes: shareCounts(s.attachmentTypes, (k) => RECORD_TYPE.test(k)),
      dedupe: { ...s.dedupe },
      syntheticTurns: s.syntheticTurns,
      ccVersions: shareCounts(s.ccVersions, (k) => CC_VERSION.test(k)),
      warnings: shareCounts(s.warnings, (k) => WARNING.test(k)),
    },
    totals: {
      all: report.totals.all,
      byModel,
      ...(report.totals.byRole ? { byRole: report.totals.byRole } : {}),
      activeDays: Object.keys(report.totals.byDay).length,
    },
    sessions: {
      count: report.sessions.length,
      main: report.sessions.length - subagents,
      subagents,
    },
    findings: report.findings.map((f, i) => shareFinding(f, i + 1, hash)),
    ...(report.calibration
      ? {
          calibration: {
            samples: report.calibration.samples,
            medianRatio: report.calibration.medianRatio,
          },
        }
      : {}),
    ...(report.pricing
      ? {
          pricing: {
            asOf: report.pricing.asOf,
            unpricedModels: shareCounts(report.pricing.unpricedModels, (m) => MODEL.test(m)),
          },
        }
      : {}),
    ...(plan
      ? {
          actionPlan: {
            windowCostUsd: plan.windowCostUsd,
            combinedSavingsUsd: plan.combinedSavingsUsd,
            combinedSharePct: plan.combinedSharePct,
            ...(plan.combinedUpperBound ? { combinedUpperBound: true as const } : {}),
            actions: plan.actions.map((a) => ({
              id: ID.test(a.id) ? a.id : OTHER,
              category: a.category,
              savingsUsd: a.savingsUsd,
              sharePct: a.sharePct,
              savingsMainUsd: a.savingsMainUsd,
              savingsSubagentUsd: a.savingsSubagentUsd,
              confidence: a.confidence,
              findings: a.findings,
              ...(a.upperBound ? { upperBound: true as const } : {}),
            })),
          },
        }
      : {}),
    notes: '',
  };
}

/** Stable output: top-level keys in declaration order, nested object keys sorted. */
export function renderShare(share: ShareReport): string {
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort);
    if (v !== null && typeof v === 'object') {
      const o = v as Record<string, unknown>;
      return Object.fromEntries(
        Object.keys(o)
          .sort()
          .map((k) => [k, sort(o[k])]),
      );
    }
    return v;
  };
  const top = share as unknown as Record<string, unknown>;
  const ordered = Object.fromEntries(Object.keys(top).map((k) => [k, sort(top[k])]));
  return JSON.stringify(ordered, null, 2) + '\n';
}
