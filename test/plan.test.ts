// Action plan (SPEC §5.3): buildActionPlan is pure, Report in, ≤5 ranked actions out.
// Every number is synthetic and worked out by hand.
import { describe, expect, it } from 'vitest';
import {
  buildActionPlan,
  changesPhrase,
  combine,
  MAX_ACTIONS,
  trimLine,
  type Action,
} from '../src/cost/plan.js';
import type { Finding, Impact, Report } from '../src/model/index.js';
import { costedSampleReport, emptyReport } from './helpers/sample-report.js';

const imp = (savingsUsd: number, sub = 0, costUsd = savingsUsd * 2): Impact => ({
  costUsd,
  savingsUsd,
  basis: 'b',
  confidence: 'estimated',
  savingsMainUsd: savingsUsd - sub,
  savingsSubagentUsd: sub,
});

const finding = (analyzer: string, data: Record<string, unknown>, impact?: Impact): Finding => ({
  analyzer,
  severity: 'warn',
  title: `${analyzer} ${JSON.stringify(data).length}`,
  tokens: { value: 1, kind: 'estimated' },
  data,
  evidence: [],
  fix: { summary: '' },
  ...(impact ? { impact } : {}),
});

function report(findings: Finding[], main = 60, subagent = 40): Report {
  const r = emptyReport();
  const cost = (total: number) => ({
    input: 0,
    write5m: 0,
    write1h: 0,
    read: total,
    output: 0,
    total,
    unpricedTurns: 0,
  });
  r.totals.all = { ...r.totals.all, cost: cost(main + subagent) };
  r.totals.byRole = {
    main: { ...r.totals.all, cost: cost(main) },
    subagent: { ...r.totals.all, cost: cost(subagent) },
  };
  r.findings = findings;
  return r;
}

const act = (o: Partial<Action>): Action => ({
  id: 'x',
  title: 't',
  savingsUsd: 0,
  sharePct: 0,
  confidence: 'estimated',
  why: '',
  change: '',
  findings: [1],
  category: 'context',
  savingsMainUsd: 0,
  savingsSubagentUsd: 0,
  ...o,
});

describe('buildActionPlan', () => {
  it('is empty with no cost or no priced findings', () => {
    const p = buildActionPlan(emptyReport());
    expect(p).toMatchObject({ windowCostUsd: 0, actions: [], combinedSavingsUsd: 0 });
    expect(buildActionPlan(report([finding('big-tool-output', { tool: 'Bash' })])).actions).toEqual(
      [],
    );
  });

  it('builds one action per lever, ranked by savings, share of the window cost', () => {
    const p = buildActionPlan(
      report([
        finding('big-tool-output', { tool: 'Bash', command: 'pnpm test', count: 3 }, imp(4)),
        finding('big-tool-output', { tool: 'Grep', count: 1 }, imp(1)),
        finding('repeated-read', { path: 'src/a.ts', rereads: 2 }, imp(2)),
        finding(
          'cache-rebuild',
          {
            causes: [
              { cause: 'ttl-expiry', count: 3, tokens: 1e6, costUsd: 9, savingsUsd: 8, fix: '' },
              { cause: 'mystery', count: 1, tokens: 1, costUsd: 1, savingsUsd: 1 },
            ],
          },
          { ...imp(9), confidence: 'measured-tokens' },
        ),
      ]),
    );
    expect(p.actions.map((a) => [a.id, a.savingsUsd, a.sharePct])).toEqual([
      ['cache-breaks', 8, 8],
      ['trim-output', 5, 5],
      ['repeated-reads', 2, 2],
    ]);
    const trim = p.actions[1]!;
    // Numbered as listed: rebuild ($9) #1, pnpm ($4) #2, re-read ($2) #3, Grep ($1) #4.
    expect(trim.findings).toEqual([2, 4]);
    expect(trim.change).toBe(
      'Add to CLAUDE.md:\n' +
        '- Run `pnpm test` as `pnpm test … 2>&1 | tail -n 100`.\n' +
        '- Narrow Grep with a glob or path, or set head_limit.',
    );
    expect(p.actions[0]!.confidence).toBe('measured-tokens');
    // Unknown causes are skipped, never guessed into an action.
    expect(p.actions.some((a) => a.title.includes('mystery'))).toBe(false);
  });

  it('keeps at most 5 actions and drops savings under half a cent', () => {
    const causes = ['ttl-expiry', 'model-switch', 'cc-upgrade', 'config-edit', 'tool-set-change'];
    const p = buildActionPlan(
      report([
        finding(
          'cache-rebuild',
          {
            causes: causes.map((cause, i) => ({
              cause,
              count: 1,
              tokens: 1,
              costUsd: 9,
              savingsUsd: i + 1,
            })),
          },
          imp(15),
        ),
        finding('big-tool-output', { tool: 'Read' }, imp(0.5)),
        finding('repeated-read', { path: 'p' }, imp(0.004)),
      ]),
    );
    expect(p.actions).toHaveLength(MAX_ACTIONS);
    expect(p.actions.map((a) => a.savingsUsd)).toEqual([5, 4, 3, 2, 1]);
  });

  it('turns A9 rows into per-type settings changes, skipping the all-parents summary', () => {
    const rows = [
      {
        type: 'general-purpose',
        agents: 4,
        costUsd: 30,
        savingsUsd: 15,
        cheaperModel: 'claude-sonnet-5-5',
      },
      { type: 'Explore', agents: 2, costUsd: 8, savingsUsd: 4, cheaperModel: 'claude-sonnet-5-5' },
      { type: 'reviewer', agents: 1, costUsd: 2, savingsUsd: 1, cheaperModel: 'claude-haiku-5-5' },
    ];
    const p = buildActionPlan(
      report([
        finding('subagent-cost', { parentSessionId: 'p1', subagentTypes: rows }, imp(20, 20, 40)),
        finding('subagent-cost', { subagentTypes: rows }, imp(20, 20, 40)), // summary
      ]),
    );
    expect(p.actions).toHaveLength(1);
    const a = p.actions[0]!;
    expect(a).toMatchObject({
      id: 'subagent-model',
      category: 'model',
      savingsUsd: 20,
      savingsSubagentUsd: 20,
    });
    expect(a.findings).toHaveLength(1);
    expect(a.title).toBe(
      'Run general-purpose, Explore, reviewer subagents on claude-sonnet-5-5 / claude-haiku-5-5',
    );
    expect(a.change.split('\n')).toEqual([
      'general-purpose: add to settings.json',
      '  "env": { "CLAUDE_CODE_SUBAGENT_MODEL": "claude-sonnet-5-5" }',
      'Explore: create .claude/agents/Explore.md with frontmatter `model: claude-sonnet-5-5` (overrides the built-in)',
      'reviewer: add `model: claude-haiku-5-5` to the frontmatter of .claude/agents/reviewer.md',
    ]);
    expect(a.why).toContain('may do worse');
  });

  it('builds a permissions.deny snippet for unused MCP tools', () => {
    const p = buildActionPlan(
      report([
        finding(
          'tool-usage',
          { server: 'gh', unusedTools: ['mcp__gh__a', 'mcp__gh__b'], usedTools: [] },
          imp(1),
        ),
        finding(
          'tool-usage',
          { server: 'db', unusedTools: ['mcp__db__drop'], usedTools: ['mcp__db__q'] },
          imp(0.5),
        ),
      ]),
    );
    expect(p.actions[0]!.change).toBe(
      'Preview with `tknxray fix mcp`, or add to .claude/settings.json:\n' +
        '"permissions": { "deny": [\n    "mcp__gh",\n    "mcp__db__drop"\n] }',
    );
  });

  it('numbers findings as the reporters list them (largest savings first)', () => {
    const p = buildActionPlan(
      report([
        finding('repeated-read', { path: 'a' }, imp(1)),
        finding('big-tool-output', { tool: 'Read' }, imp(3)),
      ]),
    );
    expect(p.actions.map((a) => [a.id, a.findings])).toEqual([
      ['trim-output', [1]],
      ['repeated-reads', [2]],
    ]);
  });

  it('the combined line is a conservative union: ≤ the sum and ≤ the window cost', () => {
    const r = costedSampleReport();
    const p = r.actionPlan!;
    const plain = p.actions.reduce((s, a) => s + a.savingsUsd, 0);
    expect(p.actions.length).toBeGreaterThan(0);
    expect(p.combinedSavingsUsd).toBeLessThanOrEqual(plain + 1e-9);
    expect(p.combinedSavingsUsd).toBeLessThanOrEqual(p.windowCostUsd);
    expect(p.combinedSavingsUsd).toBeGreaterThan(0);
    expect(p.combinedSharePct).toBeCloseTo((p.combinedSavingsUsd / p.windowCostUsd) * 100, 0);
  });
});

describe('combine', () => {
  it('sums context levers but counts context vs context-reset only once (max)', () => {
    const a = [
      act({ category: 'context', savingsMainUsd: 10 }),
      act({ category: 'context', savingsMainUsd: 5 }),
      act({ category: 'context-reset', savingsMainUsd: 20 }),
    ];
    expect(combine(a, 100, 0)).toBeCloseTo(20);
    expect(combine(a.slice(0, 2), 100, 0)).toBeCloseTo(15);
  });

  it('combines other levers as independent fractions, per scope', () => {
    // main: 1 − (1 − .5)(1 − .5) = .75 of 100; subagents: .5 of 40.
    const a = [
      act({ category: 'rebuild', savingsMainUsd: 50 }),
      act({ category: 'model', savingsMainUsd: 50, savingsSubagentUsd: 20 }),
    ];
    expect(combine(a, 100, 40)).toBeCloseTo(95);
    expect(combine(a, 100, 40)).toBeLessThan(120);
  });

  it('never exceeds the scope cost and ignores a scope with no cost', () => {
    const a = [act({ category: 'model', savingsMainUsd: 500, savingsSubagentUsd: 9 })];
    expect(combine(a, 100, 0)).toBeCloseTo(100);
  });

  it('phrases one change in the singular', () => {
    expect(changesPhrase(1)).toBe('This change');
    expect(changesPhrase(3)).toBe('These 3 changes');
  });
});

describe('trimLine', () => {
  it('suggests a concrete CLAUDE.md line per command shape', () => {
    expect(trimLine('Bash', 'cat docs/SPEC.md')).toContain("Don't `cat` whole files");
    expect(trimLine('Bash', 'rg foo')).toContain('`-l`');
    expect(trimLine('Bash', 'git diff')).toContain('--stat');
    expect(trimLine('Bash', 'git log')).toContain('-n 20');
    expect(trimLine('Bash', 'pnpm test (in a loop)')).toContain('head -n 100');
    expect(trimLine('Read', undefined)).toContain('offset/limit');
    expect(trimLine('mcp__x__y', undefined)).toBe('- Ask `mcp__x__y` for a narrower result.');
  });
});
