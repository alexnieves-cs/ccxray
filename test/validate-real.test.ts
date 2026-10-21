import { describe, expect, it } from 'vitest';
import {
  compareCost,
  compareReport,
  oursBySession,
  parseCcusage,
  parseCcusageCost,
  pctDiff,
  regroupedFiles,
} from '../scripts/validate-real.js';
import type { Session } from '../src/model/index.js';

describe('validate:real helpers (no real logs)', () => {
  const ccusage = {
    sessions: [
      {
        sessionId: 's1',
        inputTokens: 1000,
        outputTokens: 200,
        cacheCreationTokens: 5000,
        cacheReadTokens: 9000,
      },
      {
        sessionId: 's2',
        inputTokens: 10,
        outputTokens: 0,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
      },
      { sessionId: 'bad', inputTokens: 'x' },
    ],
  };

  it('parses ccusage session --json defensively', () => {
    const p = parseCcusage(ccusage);
    expect([...p.sessions.keys()]).toEqual(['s1', 's2']);
    expect(p.totals).toBeUndefined();
    expect(parseCcusage(null).sessions.size).toBe(0);
  });

  it('passes within ±0.5% and fails beyond it, printing hashed ids only', () => {
    expect(pctDiff(1005, 1000)).toBeCloseTo(0.5);
    expect(pctDiff(1, 0)).toBe(Infinity);
    const ours = new Map([
      ['s1', { input: 1004, output: 200, cacheCreate: 5000, cacheRead: 9000 }],
      ['s2', { input: 11, output: 0, cacheCreate: 0, cacheRead: 0 }],
    ]);
    const all = { input: 1015, output: 200, cacheCreate: 5000, cacheRead: 9000 };
    const r = compareReport({ all, bySession: ours }, parseCcusage(ccusage));
    expect(r.pass).toBe(true); // 1015 vs 1010 = +0.495%
    const text = r.lines.join('\n');
    expect(text).toContain('1 pass · 1 fail');
    expect(text).not.toMatch(/\bs1\b|\bs2\b/);
  });

  it('drops other coding CLIs from multi-agent ccusage output and sums Claude rows only', () => {
    const row = (period: string, agent: string | undefined, n: number) => ({
      period,
      ...(agent !== undefined ? { agent } : {}),
      inputTokens: n,
      outputTokens: n,
      cacheCreationTokens: n,
      cacheReadTokens: n,
      totalCost: n,
    });
    const json = {
      session: [row('c1', 'claude', 10), row('x1', 'codex', 999), row('c2', undefined, 5)],
      totals: {
        inputTokens: 1014,
        outputTokens: 1014,
        cacheCreationTokens: 1014,
        cacheReadTokens: 1014,
        totalCost: 1014,
      },
    };
    const p = parseCcusage(json);
    expect([...p.sessions.keys()]).toEqual(['c1', 'c2']);
    expect(p.droppedOtherAgents).toBe(1);
    expect(p.totals).toBeUndefined(); // ccusage's totals include codex
    const c = parseCcusageCost(json);
    expect([...c.sessions.keys()]).toEqual(['c1', 'c2']);
    expect(c.total).toBeUndefined();
    const ours = new Map([
      ['c1', { input: 10, output: 10, cacheCreate: 10, cacheRead: 10 }],
      ['c2', { input: 5, output: 5, cacheCreate: 5, cacheRead: 5 }],
    ]);
    const all = { input: 15, output: 15, cacheCreate: 15, cacheRead: 15 };
    expect(compareReport({ all, bySession: ours }, p).pass).toBe(true);
    // Claude-only output (`ccusage claude session`) keeps ccusage's own totals.
    expect(
      parseCcusage({ sessions: [row('c1', undefined, 1)], totals: row('t', undefined, 1) }).totals,
    ).toBeDefined();
  });

  it('parses the confirmed ccusage shape (`session[]`, id under `period`)', () => {
    const json = {
      session: [
        {
          period: 'p1',
          inputTokens: 30,
          outputTokens: 400,
          cacheCreationTokens: 7000,
          cacheReadTokens: 90_000,
          totalTokens: 97_430,
          totalCost: 1.23,
          modelsUsed: ['claude-sonnet-4-5'],
          modelBreakdowns: [],
          metadata: { lastActivity: '2026-10-19T00:00:00.000Z' },
        },
        { period: 'p2', inputTokens: 'x' },
      ],
      totals: {
        inputTokens: 30,
        outputTokens: 400,
        cacheCreationTokens: 7000,
        cacheReadTokens: 90_000,
        totalTokens: 97_430,
        totalCost: 1.23,
      },
    };
    const p = parseCcusage(json);
    expect([...p.sessions.entries()]).toEqual([
      ['p1', { input: 30, output: 400, cacheCreate: 7000, cacheRead: 90_000 }],
    ]);
    expect(p.totals).toEqual({ input: 30, output: 400, cacheCreate: 7000, cacheRead: 90_000 });
  });

  it('rolls subagent sessions into their parent before comparing per session', () => {
    const t = (input: number, output: number) => ({
      input,
      output,
      cacheWrite: 0,
      cacheWrite5m: 0,
      cacheWrite1h: 0,
      cacheRead: 0,
      cacheHitRatio: null,
      turns: 1,
    });
    const s = (id: string, parent?: string) =>
      ({
        id,
        isSubagent: parent !== undefined,
        ...(parent !== undefined ? { parentSessionId: parent } : {}),
      }) as unknown as Session;
    const ours = oursBySession([s('p1'), s('p1:agent-a1', 'p1'), s('p1:agent-a2', 'p1')], {
      p1: t(10, 100),
      'p1:agent-a1': t(15, 200),
      'p1:agent-a2': t(5, 100),
    });
    expect([...ours.entries()]).toEqual([
      ['p1', { input: 30, output: 400, cacheCreate: 0, cacheRead: 0 }],
    ]);
    const theirs = parseCcusage({
      session: [
        {
          period: 'p1',
          inputTokens: 30,
          outputTokens: 400,
          cacheCreationTokens: 0,
          cacheReadTokens: 0,
        },
      ],
    });
    const r = compareReport(
      { all: { input: 30, output: 400, cacheCreate: 0, cacheRead: 0 }, bySession: ours },
      theirs,
    );
    expect(r.pass).toBe(true);
    expect(r.lines.join('\n')).toContain(
      '1 pass · 0 fail · 0 missing in tknxray · 0 only in tknxray',
    );
  });

  it('cross-checks list-price cost against ccusage totalCost within $0.01', () => {
    const json = {
      session: [
        { period: 'p1', totalCost: 93.1173902 },
        { period: 'p2', totalCost: 'x' },
      ],
      totals: { totalCost: 93.1173902 },
    };
    const theirs = parseCcusageCost(json);
    expect([...theirs.sessions.keys()]).toEqual(['p1']);
    expect(theirs.total).toBeCloseTo(93.1173902);
    const ok = compareCost({ total: 93.11739, bySession: new Map([['p1', 93.11739]]) }, theirs);
    expect(ok.pass).toBe(true);
    expect(ok.lines.join('\n')).not.toMatch(/\bp1\b/);
    expect(compareCost({ total: 93.2, bySession: new Map() }, theirs).pass).toBe(false);
  });

  it('explains a missing ccusage session whose file tknxray grouped under another session', () => {
    const sessions = [
      { id: 'old', isSubagent: false, files: ['/p/old.jsonl', '/p/new.jsonl'] },
      {
        id: 'old:agent-a',
        isSubagent: true,
        parentSessionId: 'old',
        files: ['/p/old/agent-a.jsonl'],
      },
    ] as unknown as Session[];
    const regrouped = regroupedFiles(sessions);
    expect([...regrouped]).toEqual([['new', 'old']]);
    const c = { input: 1, output: 1, cacheCreate: 0, cacheRead: 0 };
    const r = compareReport(
      { all: c, bySession: new Map([['old', c]]) },
      parseCcusage({
        sessions: [
          {
            sessionId: 'new',
            inputTokens: 1,
            outputTokens: 1,
            cacheCreationTokens: 0,
            cacheReadTokens: 0,
          },
        ],
      }),
      regrouped,
    );
    const text = r.lines.join('\n');
    expect(text).toContain('its file is grouped under');
    expect(text).not.toMatch(/\bnew\b|\bold\b/);
  });
});
