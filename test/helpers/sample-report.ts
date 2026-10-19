// Synthetic sample Report for reporter tests. ALL NUMBERS, IDS AND PATHS ARE MADE UP: nothing
// here was taken from a real transcript (CLAUDE.md hard rule 4). It exercises several analyzers,
// measured and estimated tokens, subagent sessions and parse warnings.
import { COST_NOTE, costOf } from '../../src/cost/cost.js';
import { buildActionPlan } from '../../src/cost/plan.js';
import { priceFor, PRICES_AS_OF, PRICES_SOURCE } from '../../src/cost/prices.js';
import { sortFindings } from '../../src/reporters/derive.js';
import type { CostTotals, Finding, Impact, Report, TokenTotals } from '../../src/model/index.js';

export const SAMPLE_HOME = '/home/dev';
const ROOT = '/home/dev/.claude/projects';
const PROJ = '-home-dev-src-acme-api';

function totals(
  input: number,
  cacheWrite: number,
  cacheRead: number,
  output: number,
  turns: number,
): TokenTotals {
  const denom = input + cacheWrite + cacheRead;
  return {
    input,
    cacheWrite,
    cacheWrite5m: cacheWrite,
    cacheWrite1h: 0,
    cacheRead,
    output,
    cacheHitRatio: denom === 0 ? null : cacheRead / denom,
    turns,
  };
}

const S1 = '3fa2c1d0-1111-4aaa-8bbb-000000000001';
const S2 = '9b07e5aa-2222-4aaa-8bbb-000000000002';
const S3 = '3fa2c1d0-1111-4aaa-8bbb-000000000001'; // subagent reusing the parent sessionId
const S4 = 'c41d0f9e-4444-4aaa-8bbb-000000000004';

const t1 = totals(41_200, 1_870_000, 9_420_000, 88_300, 212);
const t2 = totals(12_900, 640_500, 3_015_000, 31_250, 97);
const t3 = totals(3_100, 210_000, 402_000, 9_800, 41);
const t4 = totals(1_050, 98_400, 640_100, 4_120, 18);

function sum(...ts: TokenTotals[]): TokenTotals {
  const s = ts.reduce((a, b) => ({
    ...a,
    input: a.input + b.input,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    cacheWrite5m: a.cacheWrite5m + b.cacheWrite5m,
    cacheWrite1h: a.cacheWrite1h + b.cacheWrite1h,
    cacheRead: a.cacheRead + b.cacheRead,
    output: a.output + b.output,
    turns: a.turns + b.turns,
  }));
  return { ...s, cacheHitRatio: s.cacheRead / (s.input + s.cacheWrite + s.cacheRead) };
}

export function sampleReport(): Report {
  const all = sum(t1, t2, t3, t4);
  return {
    schemaVersion: 1,
    tool: { name: 'tknxray', version: '0.0.0-test' },
    generatedAt: '2026-10-18T09:30:00.000Z',
    window: { since: '2026-10-11', until: null, project: null },
    includeContent: false,
    stats: {
      roots: [ROOT],
      files: 6,
      bytes: 48_211_904,
      lines: 21_877,
      blankLines: 3,
      malformedLines: 4,
      recordTypes: {
        assistant: 9_812,
        user: 8_640,
        attachment: 1_203,
        'queue-operation': 88,
        'x-future': 7,
      },
      unknownRecordTypes: { 'x-future': 7 },
      attachmentTypes: { instructions: 31 },
      dedupe: { sameResponseLines: 1_950, sidechainReplays: 12, crossSessionCopies: 2 },
      syntheticTurns: 3,
      ccVersions: { '2.1.290': 6_100, '2.1.296': 13_600 },
      warnings: { 'assistant without message.usage': 2 },
    },
    totals: {
      all,
      bySession: { [S1]: sum(t1, t3), [S2]: t2, [S4]: t4 },
      byProject: { [PROJ]: all },
      byModel: { 'claude-opus-4-5': sum(t1, t2), 'claude-haiku-4-5': sum(t3, t4) },
      byDay: { '2026-10-11': sum(t1, t3), '2026-10-14': t2, '2026-10-18': t4 },
    },
    sessions: [
      {
        id: S1,
        project: PROJ,
        isSubagent: false,
        firstTs: '2026-10-11T14:02:11.000Z',
        lastTs: '2026-10-11T18:40:09.000Z',
        turns: 212,
        ccVersions: ['2.1.290'],
        models: ['claude-opus-4-5'],
        totals: t1,
      },
      {
        id: S2,
        project: PROJ,
        isSubagent: false,
        firstTs: '2026-10-14T08:15:00.000Z',
        lastTs: '2026-10-14T10:01:30.000Z',
        turns: 97,
        ccVersions: ['2.1.290', '2.1.296'],
        models: ['claude-opus-4-5'],
        totals: t2,
      },
      {
        id: S3,
        project: PROJ,
        isSubagent: true,
        firstTs: '2026-10-11T15:00:00.000Z',
        lastTs: '2026-10-11T15:12:44.000Z',
        turns: 41,
        ccVersions: ['2.1.290'],
        models: ['claude-haiku-4-5'],
        totals: t3,
      },
      {
        id: S4,
        project: PROJ,
        isSubagent: true,
        firstTs: '2026-10-18T07:59:00.000Z',
        lastTs: '2026-10-18T08:05:10.000Z',
        turns: 18,
        ccVersions: ['2.1.296'],
        models: ['claude-haiku-4-5'],
        totals: t4,
      },
    ],
    findings: [
      {
        analyzer: 'repeated-read',
        severity: 'warn',
        title: 'src/api/client.ts read 7× unchanged in session 3fa2c1d0',
        tokens: { value: 182_400, kind: 'estimated' },
        data: { tool: 'Read', path: 'src/api/client.ts', reads: 7 },
        evidence: [
          {
            sessionId: S1,
            turnUuid: 'a1000000-0000-4000-8000-000000000031',
            detail: 'read #2 of src/api/client.ts, no edit since read #1',
            source: { file: `${ROOT}/${PROJ}/${S1}.jsonl`, line: 412 },
          },
        ],
        fix: {
          summary: 'reference the earlier read instead of re-reading (cc-slim dedupe, planned)',
        },
      },
      {
        analyzer: 'tool-usage',
        severity: 'info',
        title: '9 MCP tools from "github" server never called in 4 sessions',
        tokens: { value: 0, kind: 'measured' },
        data: { server: 'github', unused: 9 },
        evidence: [
          {
            sessionId: S2,
            turnUuid: 'b2000000-0000-4000-8000-000000000001',
            detail: 'tool list at first turn',
          },
        ],
        fix: { summary: 'run `tknxray fix mcp` to preview a permissions.deny diff' },
      },
      {
        analyzer: 'big-tool-output',
        severity: 'warn',
        title: '`pnpm test` returned 48k chars (×11)',
        tokens: { value: 132_000, kind: 'estimated' },
        data: {
          tool: 'Bash',
          command: 'CI=1 pnpm test --reporter verbose --run',
          count: 11,
          maxChars: 48_100,
        },
        evidence: [
          {
            sessionId: S2,
            turnUuid: 'b2000000-0000-4000-8000-000000000044',
            detail: 'Bash result 48,100 chars',
            source: { file: `${ROOT}/${PROJ}/${S2}.jsonl`, line: 1_207 },
          },
          {
            sessionId: S3,
            turnUuid: 'c3000000-0000-4000-8000-000000000007',
            detail: 'Bash result 31,020 chars',
            source: { file: `${ROOT}/${PROJ}/${S1}/subagents/agent-7f3e.jsonl`, line: 88 },
          },
        ],
        fix: { summary: 'pipe through `| tail -50`, or use --reporter=dot' },
      },
      {
        analyzer: 'big-tool-output',
        severity: 'info',
        title: 'Grep returned 22k chars (×3)',
        tokens: { value: 16_500, kind: 'estimated' },
        data: { tool: 'Grep', count: 3 },
        evidence: [
          {
            sessionId: S1,
            turnUuid: 'a1000000-0000-4000-8000-000000000090',
            detail: 'Grep result 22,000 chars',
            source: { file: `${ROOT}/${PROJ}/${S1}.jsonl`, line: 2_001 },
          },
        ],
        fix: { summary: 'narrow the glob or set head_limit' },
      },
      {
        analyzer: 'cache-rebuild',
        severity: 'high',
        title: '38 rebuilds cost 2.8M cache-write tokens',
        tokens: { value: 2_818_900, kind: 'measured' },
        data: {
          causes: [
            { cause: 'cc-upgrade', count: 3, tokens: 201_000, fix: 'known: #46917 (2.1.100+)' },
            {
              cause: 'ttl-expiry',
              count: 29,
              tokens: 2_204_000,
              fix: 'batch work; you had 29 gaps > 5 min',
            },
            {
              cause: 'config-edit',
              count: 6,
              tokens: 413_900,
              fix: 'edit CLAUDE.md between sessions',
            },
          ],
        },
        evidence: [
          {
            sessionId: S1,
            turnUuid: 'a1000000-0000-4000-8000-000000000012',
            detail: 'gap 12m, cache_read 81k → 0',
            source: { file: `${ROOT}/${PROJ}/${S1}.jsonl`, line: 120 },
          },
          {
            sessionId: S2,
            turnUuid: 'b2000000-0000-4000-8000-000000000020',
            detail: 'version 2.1.290 → 2.1.296',
            source: { file: `${ROOT}/${PROJ}/${S2}.jsonl`, line: 655 },
          },
        ],
        fix: {
          summary: 'see causes above',
          docsUrl: 'https://github.com/anthropics/claude-code/issues/46917',
        },
      },
    ],
    calibration: { samples: 14, medianRatio: 1.08, note: 'synthetic' },
  };
}

/** A report where discovery found log roots but no sessions. */
export function emptyReport(): Report {
  const r = sampleReport();
  const zero = totals(0, 0, 0, 0, 0);
  return {
    ...r,
    window: { since: '2026-10-11', until: null, project: 'acme' },
    stats: {
      ...r.stats,
      files: 0,
      bytes: 0,
      lines: 0,
      malformedLines: 0,
      unknownRecordTypes: {},
      warnings: {},
    },
    totals: { all: zero, bySession: {}, byProject: {}, byModel: {}, byDay: {} },
    sessions: [],
    findings: [],
  };
}

// ---- M7: the same sample with $ (cost, impact, action plan) -------------------------------

function priced(t: TokenTotals, model: string): CostTotals {
  const u = { ...t, cacheWrite1h: 0 };
  return { ...costOf(u, priceFor(model)!), unpricedTurns: 0 };
}

function addCost(a: CostTotals, b: CostTotals): CostTotals {
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

const imp = (
  costUsd: number,
  savingsUsd: number,
  savingsSubagentUsd: number,
  confidence: Impact['confidence'],
  basis: string,
): Impact => ({
  costUsd,
  savingsUsd,
  basis,
  confidence,
  savingsMainUsd: savingsUsd - savingsSubagentUsd,
  savingsSubagentUsd,
});

/** sampleReport() as the M7 pipeline returns it: totals.cost, byRole, impacts and the plan. */
export function costedSampleReport(): Report {
  const r = sampleReport();
  const c1 = priced(t1, 'claude-opus-4-5');
  const c2 = priced(t2, 'claude-opus-4-5');
  const c3 = priced(t3, 'claude-haiku-4-5');
  const c4 = priced(t4, 'claude-haiku-4-5');
  const all = { ...r.totals.all, cost: [c2, c3, c4].reduce(addCost, c1) };
  r.totals = {
    ...r.totals,
    all,
    byModel: {
      'claude-opus-4-5': { ...r.totals.byModel['claude-opus-4-5']!, cost: addCost(c1, c2) },
      'claude-haiku-4-5': { ...r.totals.byModel['claude-haiku-4-5']!, cost: addCost(c3, c4) },
    },
    byDay: {
      '2026-10-11': { ...r.totals.byDay['2026-10-11']!, cost: addCost(c1, c3) },
      '2026-10-14': { ...r.totals.byDay['2026-10-14']!, cost: c2 },
      '2026-10-18': { ...r.totals.byDay['2026-10-18']!, cost: c4 },
    },
    byRole: {
      main: { ...sum(t1, t2), cost: addCost(c1, c2) },
      subagent: { ...sum(t3, t4), cost: addCost(c3, c4) },
    },
  };
  const by = (a: string, title: string): Finding =>
    r.findings.find((f) => f.analyzer === a && f.title.startsWith(title))!;
  const rebuild = by('cache-rebuild', '38');
  // write 6.25, read 0.50 $/MTok (Opus 4.5): cost = tokens × 6.25, savings = tokens × 5.75.
  const causes = (rebuild.data!.causes as Record<string, unknown>[]).map((c) => ({
    ...c,
    costUsd: ((c.tokens as number) * 6.25) / 1e6,
    savingsUsd: ((c.tokens as number) * 5.75) / 1e6,
  }));
  rebuild.data = { causes };
  rebuild.impact = imp(
    (2_818_900 * 6.25) / 1e6,
    (2_818_900 * 5.75) / 1e6,
    0,
    'measured-tokens',
    '38 rebuilds wrote 2.8M tokens at the cache-write price; as cache reads they would have cost 8% of that',
  );
  const pnpm = by('big-tool-output', '`pnpm');
  pnpm.data = { ...pnpm.data, turnsCarriedMax: 140 };
  pnpm.impact = imp(
    2.1,
    1.62,
    0.42,
    'estimated',
    '11 outputs stayed in context for up to 140 turns',
  );
  const grep = by('big-tool-output', 'Grep');
  grep.data = { ...grep.data, turnsCarriedMax: 30 };
  grep.impact = imp(0.31, 0.12, 0, 'estimated', '3 outputs stayed in context for up to 30 turns');
  const reread = by('repeated-read', 'src/api');
  reread.data = { ...reread.data, rereads: 6 };
  reread.impact = imp(0.95, 0.81, 0, 'estimated', '6 extra copies carried until the session ended');
  const mcp = by('tool-usage', '9 MCP');
  mcp.data = {
    ...mcp.data,
    unusedTools: Array.from({ length: 9 }, (_, i) => `mcp__github__tool_${i + 1}`),
    usedTools: [],
  };
  mcp.impact = imp(0.4, 0.4, 0, 'estimated', '9 definitions sent with 309 main-session requests');
  r.findings = sortFindings(r.findings);
  r.pricing = {
    asOf: PRICES_AS_OF,
    source: PRICES_SOURCE,
    unpricedModels: {},
    note: COST_NOTE,
  };
  r.actionPlan = buildActionPlan(r);
  return r;
}
