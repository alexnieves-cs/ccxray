import { describe, expect, it } from 'vitest';
import { compareReport, oursBySession, parseCcusage, pctDiff } from '../scripts/validate-real.js';
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
});
