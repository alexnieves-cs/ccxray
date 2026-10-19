// Session replay data (src/reporters/timeline.ts) and its embedding in the HTML report.
// Fixtures are synthetic (test/fixtures/projects, scripts/make-fixture.ts).
import { afterAll, describe, expect, it } from 'vitest';
import { DEFAULT_THRESHOLDS, type Finding } from '../../src/model/index.js';
import { buildReport } from '../../src/pipeline.js';
import { reportClient } from '../../src/reporters/client.js';
import { renderHtml } from '../../src/reporters/html.js';
import { buildTimeline, scriptJson } from '../../src/reporters/timeline.js';
import { emptyStats } from '../../src/parser/index.js';
import { cleanupTmp, ctx, fixture } from '../helpers/analyzer-fixtures.js';
import { remoteLoads } from '../helpers/remote-loads.js';

afterAll(cleanupTmp);

const marksOf = (tl: ReturnType<typeof buildTimeline>): string[] =>
  tl.sessions.flatMap((s) => s.marks.map((m) => `${m.k}@${m.at}`));

describe('buildTimeline', () => {
  it('carries measured usage per turn and marks the rebuild and the idle gap', async () => {
    const tl = buildTimeline(await fixture('ttl-gap-rebuild'), DEFAULT_THRESHOLDS);
    expect(tl.sessions).toHaveLength(1);
    const s = tl.sessions[0]!;
    expect(s.turns).toHaveLength(3);
    expect(marksOf(tl)).toEqual(['rebuild@2', 'idle@2']);
    const rebuild = s.marks.find((m) => m.k === 'rebuild')!;
    expect(rebuild.tokens).toBe(s.turns[2]!.w);
    expect(rebuild.cause).toBe('ttl-expiry');
    expect(s.peak).toBe(Math.max(...s.turns.map((t) => t.r + t.w + t.i)));
    expect(s.window).toBe(200_000);
  });

  it('marks model switches and Claude Code upgrades', async () => {
    expect(marksOf(buildTimeline(await fixture('model-switch'), DEFAULT_THRESHOLDS))).toEqual([
      'rebuild@2',
      'model@2',
    ]);
    expect(
      marksOf(buildTimeline(await fixture('version-change-rebuild'), DEFAULT_THRESHOLDS)),
    ).toEqual(['rebuild@2', 'version@2']);
  });

  it('links subagents to the parent turn that started them', async () => {
    const tl = buildTimeline(await fixture('nested-subagents-dir'), DEFAULT_THRESHOLDS);
    const [main, a, b] = tl.sessions;
    expect(main!.sub).toBe(false);
    expect([a!.sub, a!.parent, a!.spawnTurn, b!.parent, b!.spawnTurn]).toEqual([true, 0, 0, 0, 0]);
    // The Agent calls point at the subagents they started.
    expect(main!.turns[0]!.x!.map((x) => x.a)).toEqual([1, 2]);
    expect(tl.tools).toContain('Agent');
  });

  it('keeps tool result sizes and the error / persisted flags, never content', async () => {
    const big = buildTimeline(await fixture('big-bash-output'), DEFAULT_THRESHOLDS);
    expect(big.sessions[0]!.turns.flatMap((t) => t.x ?? [])).toEqual([
      { n: 0, c: 48_000 },
      { n: 0, c: 32_000, e: 1 },
    ]);
    const persisted = buildTimeline(await fixture('persisted-tool-output'), DEFAULT_THRESHOLDS);
    expect(persisted.sessions[0]!.turns.flatMap((t) => t.x ?? [])[0]).toMatchObject({ p: 1 });
    // Only names, numbers and labels: no tool input or output text survives.
    const json = JSON.stringify(persisted);
    expect(json).not.toContain('persisted-output');
    expect(json).not.toMatch(/"command"|"text"|"input"/);
  });

  it('maps evidence turns for "show in replay" links', async () => {
    const sessions = await fixture('ttl-gap-rebuild');
    const turn = sessions[0]!.turns[2]!;
    const f: Finding = {
      analyzer: 'cache-rebuild',
      severity: 'high',
      title: 't',
      tokens: { value: 1, kind: 'measured' },
      evidence: [{ sessionId: turn.sessionId, turnUuid: turn.uuid, detail: 'd' }],
      fix: { summary: 's' },
    };
    expect(buildTimeline(sessions, DEFAULT_THRESHOLDS, [f]).turnRefs).toEqual({
      [turn.uuid]: [0, 2],
    });
  });

  it('leaves out the smallest sessions past the budget and says how many', async () => {
    const sessions = [
      ...(await fixture('ttl-gap-rebuild')),
      ...(await fixture('model-switch')),
      ...(await fixture('big-bash-output')),
    ];
    const tl = buildTimeline(sessions, DEFAULT_THRESHOLDS, [], { maxMainSessions: 2 });
    expect(tl.sessions).toHaveLength(2);
    expect(tl.omitted).toEqual({ sessions: 1, turns: 3 });
  });
});

describe('replay in the HTML report', () => {
  it('embeds escaped data that cannot close the script element', () => {
    const evil = '</script><script>alert(1)</script> ';
    const json = scriptJson({ tools: [evil] });
    expect(json).not.toContain('</script');
    expect(json).not.toContain('<');
    expect(json).not.toContain(' ');
    expect(JSON.parse(json)).toEqual({ tools: [evil] });
  });

  it('renders a replay section with no remote loads and one executable script', async () => {
    const sessions = [
      ...(await fixture('ttl-gap-rebuild')),
      ...(await fixture('nested-subagents-dir')),
    ];
    const report = buildReport({
      sessions,
      stats: emptyStats(),
      ctx: ctx(),
      window: { since: null, until: null, project: null },
      includeContent: false,
    });
    const tl = buildTimeline(sessions, DEFAULT_THRESHOLDS, report.findings);
    tl.tools.push('</script><img src=x onerror=alert(1)>');
    const html = renderHtml(report, { timeline: tl });
    expect(html).toContain('id="replay"');
    expect(html).toContain('<script type="application/json" id="tl-data">');
    expect(html).not.toContain('<img src=x');
    expect(html.match(/<script>/g)).toHaveLength(1);
    expect(remoteLoads(html)).toEqual([]);
    // the evidence of the rebuild finding links into the replay
    expect(html).toContain('data-turn="');
  });

  it('omits the replay without timeline data', async () => {
    const report = buildReport({
      sessions: await fixture('ttl-gap-rebuild'),
      stats: emptyStats(),
      ctx: ctx(),
      window: { since: null, until: null, project: null },
      includeContent: false,
    });
    expect(renderHtml(report)).not.toContain('id="replay"');
  });

  it('ships client code that is self-contained and parses as a function body', () => {
    const src = reportClient.toString();
    expect(() => new Function(`(${src})`)).not.toThrow();
    // No network APIs in the page script (CLAUDE.md hard rule 1; the CSP blocks them too).
    expect(src).not.toMatch(/\bfetch\(|XMLHttpRequest|WebSocket|sendBeacon|EventSource/);
  });
});
