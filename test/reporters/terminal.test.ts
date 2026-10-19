import { describe, expect, it } from 'vitest';
import type { Report } from '../../src/model/index.js';
import { stripAnsi, visibleWidth } from '../../src/reporters/format.js';
import { renderTerminal } from '../../src/reporters/terminal.js';
import {
  costedSampleReport,
  emptyReport,
  sampleReport,
  SAMPLE_HOME,
} from '../helpers/sample-report.js';

const SNAP = '../__snapshots__/reporters';

function maxWidth(out: string): number {
  return Math.max(...out.split('\n').map(visibleWidth));
}

describe('terminal reporter', () => {
  it('matches the snapshot', async () => {
    const out = renderTerminal(sampleReport(), { color: false, homeDir: SAMPLE_HOME });
    await expect(out).toMatchFileSnapshot(`${SNAP}/terminal.txt`);
  });

  it('matches the snapshot with cost and the action plan (M7)', async () => {
    const out = renderTerminal(costedSampleReport(), { color: false, homeDir: SAMPLE_HOME });
    await expect(out).toMatchFileSnapshot(`${SNAP}/terminal-cost.txt`);
  });

  it('shows COST under TOKENS and WHAT TO CHANGE FIRST, with the $ legend', () => {
    const out = renderTerminal(costedSampleReport(), { color: false, width: 100 });
    const at = (s: string) => out.indexOf(s);
    expect(at('COST')).toBeGreaterThan(at('TOKENS (measured'));
    expect(at('WHAT TO CHANGE FIRST')).toBeGreaterThan(at('COST'));
    expect(at('WHAT TO CHANGE FIRST')).toBeLessThan(at('TOP FINDINGS'));
    expect(out).toMatch(
      /These \d changes would have cut about \d+(\.\d)?% of this window's cost \[E\]/,
    );
    expect(out).toContain('what these tokens would cost at API list prices');
    // Multi-line changes survive sanitizing: each CLAUDE.md line is on its own line.
    expect(out).toContain('\n        Add to CLAUDE.md:\n        - Run `pnpm test` as');
    // Commands are cut like everywhere else: no env assignments, two words.
    expect(out).not.toContain('CI=1');
    for (const l of out.split('\n')) expect(visibleWidth(l)).toBeLessThanOrEqual(100);
    // An old report without cost renders without these sections.
    const old = renderTerminal(sampleReport(), { color: false });
    expect(old).not.toContain('WHAT TO CHANGE FIRST');
  });

  it('colored output differs only by ANSI codes', () => {
    const plain = renderTerminal(sampleReport(), { color: false });
    const colored = renderTerminal(sampleReport(), { color: true });
    expect(colored).toContain('\x1b[');
    expect(plain).not.toContain('\x1b[');
    expect(stripAnsi(colored)).toBe(plain);
  });

  it('labels measured and estimated numbers and orders findings by severity then tokens', () => {
    const out = renderTerminal(sampleReport(), { color: false });
    expect(out).toContain('TOKENS (measured from usage fields)');
    expect(out).toContain('WHERE IT WENT (estimated attribution)');
    expect(out).toMatch(/2\.8M \[M\]/);
    expect(out).toMatch(/~182k \[E\]/);
    const order = [
      'CACHE REBUILD',
      'REPEATED READ [warn]',
      'BIG TOOL OUTPUT [warn]',
      'BIG TOOL OUTPUT [info]',
    ];
    const idx = order.map((s) => out.indexOf(s));
    expect(idx.every((i) => i >= 0)).toBe(true);
    expect([...idx].sort((a, b) => a - b)).toEqual(idx);
  });

  it('never prints absolute paths, env assignments or more than two command tokens', () => {
    const out = renderTerminal(sampleReport(), { color: false, homeDir: SAMPLE_HOME });
    expect(out).not.toContain('/home/dev');
    expect(out).not.toContain('CI=1');
    expect(out).not.toContain('--reporter verbose');
    expect(out).toContain('cmd `pnpm test`');
    expect(out).not.toContain('-home-dev');
    expect(out).toContain('~-src-acme-api/3fa2c1d0-1111-4aaa-8bbb-000000000001.jsonl:120');
  });

  it('keeps every line within the width, even with very long names', () => {
    const r: Report = sampleReport();
    const long = 'mcp__an_extremely_long_server_name_for_testing__and_an_even_longer_tool_name_x';
    r.findings.push({
      analyzer: 'tool-usage-with-a-surprisingly-long-analyzer-identifier',
      severity: 'high',
      title: `${long} ${long} was never called`,
      tokens: { value: 123_456_789, kind: 'estimated' },
      data: {
        tool: long,
        command: `${long} ${long}`,
        causes: [{ cause: long, count: 123_456, tokens: 9_999_999, fix: long }],
      },
      evidence: [
        {
          sessionId: long,
          turnUuid: long,
          detail: long,
          source: { file: `/home/dev/.claude/projects/${long}/${long}.jsonl`, line: 1_000_000 },
        },
      ],
      fix: { summary: `${long} ${long}` },
    });
    r.window.project = long;
    const cjk = '日本語のツール名がとても長い場合の表示テスト'.repeat(3);
    r.findings.push({
      analyzer: 'repeated-read',
      severity: 'warn',
      title: `\x1b]0;pwned\x07${cjk}\x1b[2J😀😀😀\nsecond line\u009b`,
      tokens: { value: NaN, kind: 'estimated' },
      data: { tool: cjk, causes: [{ cause: `\x1b]8;;x\x07${cjk}`, count: 2, fix: cjk }] },
      evidence: [{ sessionId: cjk, turnUuid: 't', detail: cjk }],
      fix: { summary: `${cjk}\r\x1b[1Aoverwrite` },
    });
    for (const width of [100, 80, 60, 200, 10]) {
      for (const color of [false, true]) {
        const out = renderTerminal(r, { color, width });
        expect(maxWidth(out)).toBeLessThanOrEqual(Math.max(60, Math.min(width, 100)));
        // Only our own SGR sequences may remain: no OSC, no cursor moves, no raw controls.
        // eslint-disable-next-line no-control-regex
        expect(stripAnsi(out)).not.toMatch(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/);
        expect(out).not.toContain('second line\n');
      }
    }
  });

  it('explains where it looked when no sessions were found', async () => {
    const out = renderTerminal(emptyReport(), { color: false, homeDir: SAMPLE_HOME });
    expect(out).toContain('no sessions found');
    expect(out).toContain('~/.claude/projects');
    await expect(out).toMatchFileSnapshot(`${SNAP}/terminal-empty.txt`);
  });

  it('omits WHERE IT WENT and parse warnings when there is nothing to show', () => {
    const r = sampleReport();
    r.findings = r.findings.filter((f) => f.tokens.kind === 'measured');
    r.stats = { ...r.stats, malformedLines: 0, unknownRecordTypes: {}, warnings: {} };
    const out = renderTerminal(r, { color: false });
    expect(out).not.toContain('WHERE IT WENT');
    expect(out).not.toContain('PARSE WARNINGS');
  });
});
