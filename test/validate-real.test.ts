import { describe, expect, it } from 'vitest';
import { compareReport, parseCcusage, pctDiff } from '../scripts/validate-real.js';

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
});
