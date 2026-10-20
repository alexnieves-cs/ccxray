import { describe, expect, it } from 'vitest';
import { renderHtml } from '../../src/reporters/html.js';
import { render } from '../../src/reporters/index.js';
import { remoteLoads } from '../helpers/remote-loads.js';
import {
  costedSampleReport,
  emptyReport,
  sampleReport,
  SAMPLE_HOME,
} from '../helpers/sample-report.js';

describe('html reporter', () => {
  it('matches the snapshot', async () => {
    await expect(renderHtml(sampleReport(), { homeDir: SAMPLE_HOME })).toMatchFileSnapshot(
      '../__snapshots__/reporters/report.html',
    );
  });

  it('matches the snapshot with cost and the action plan (M7)', async () => {
    await expect(renderHtml(costedSampleReport(), { homeDir: SAMPLE_HOME })).toMatchFileSnapshot(
      '../__snapshots__/reporters/report-cost.html',
    );
  });

  it('shows action-plan cards on one scale and a cost bar next to the token bar', () => {
    const html = renderHtml(costedSampleReport());
    const plan = costedSampleReport().actionPlan!;
    expect(html).toContain('What to change first');
    expect(html.match(/<article class="card plan"/g)?.length).toBe(plan.actions.length);
    expect(html).toContain('Cost at API list prices');
    expect(html).toContain('what these tokens would cost at API list prices');
    expect(remoteLoads(html)).toEqual([]);
    expect(html).toContain("default-src 'none'");
    expect(html.match(/<script/g)?.length).toBe(
      renderHtml(sampleReport()).match(/<script/g)?.length,
    );
    // Shared scale: bar widths are each action's share of the window cost.
    for (const a of plan.actions)
      expect(html).toContain(`width:${((a.savingsUsd / plan.windowCostUsd) * 100).toFixed(3)}%`);
  });

  it('lists cost by project, largest first, only for two or more projects', () => {
    const r = costedSampleReport();
    expect(renderHtml(r)).not.toContain('id="projects"');
    const all = r.totals.all;
    r.totals.byProject = {
      '-home-dev-small': { ...all, turns: 3, cost: { ...all.cost!, total: 1 } },
      '-home-dev-big': { ...all, turns: 9, cost: { ...all.cost!, total: 4 } },
    };
    const html = renderHtml(r, { homeDir: '/home/dev' });
    expect(html).toContain('<h2>Cost by project</h2>');
    expect(html.indexOf('~-big')).toBeLessThan(html.indexOf('~-small'));
  });

  it('overview: one focusable day per UTC day, gaps included, $ [E] when priced and tokens [M] otherwise', () => {
    const costed = renderHtml(costedSampleReport());
    // The sample is active on 10-11, 10-14 and 10-18: eight calendar days, five of them empty.
    expect(costed.match(/<rect class="hit"[^>]*tabindex="0"/g)?.length).toBe(8);
    expect(costed).toContain('data-d="2026-10-12"');
    expect(costed).toMatch(/Cost per day<i class="b e"/);
    expect(costed).toMatch(
      /aria-label="2026-10-11: \$[\d.,]+ at list prices, \d+ turns, cache hit/,
    );
    expect(costed).toContain('<summary>table view</summary>');
    expect(costed).toContain('avoidable with the plan below');
    const plain = renderHtml(sampleReport());
    expect(plain).toMatch(/Tokens per day<i class="b m"/);
    expect(plain).not.toContain('avoidable with the plan');
    expect(plain).not.toContain('href="#plan"');
  });

  it('overview: no chart for a single day, and the nav links only to sections that exist', () => {
    const html = renderHtml(emptyReport());
    expect(html).not.toContain('id="ov-plot"');
    const nav = /<nav class="toc"[^]*?<\/nav>/.exec(html)![0];
    for (const id of [...nav.matchAll(/href="#([a-z]+)"/g)].map((m) => m[1]))
      expect(html).toMatch(new RegExp(`id="${id}"`));
  });

  it('the remote-load detector catches what it should (self-test)', () => {
    expect(remoteLoads('<script src="https://cdn.example/x.js"></script>')).toHaveLength(1);
    expect(remoteLoads('<link rel="stylesheet" href="//cdn.example/x.css">')).toHaveLength(1);
    expect(remoteLoads('<img src="http://e.test/p.png">')).toHaveLength(1);
    expect(remoteLoads('<style>a{background:url(https://e.test/a.png)}</style>')).toHaveLength(1);
    expect(remoteLoads('<style>@import "x.css";</style>')).toHaveLength(1);
    expect(remoteLoads('<a href="https://github.com/x">x</a>')).toHaveLength(1);
    expect(remoteLoads('<a href="https://github.com/x" rel="noreferrer">x</a>')).toEqual([]);
  });

  it('loads nothing remote', () => {
    for (const r of [sampleReport(), emptyReport()]) {
      const html = renderHtml(r);
      expect(remoteLoads(html)).toEqual([]);
      expect(html).toContain("default-src 'none'");
    }
    expect(renderHtml(sampleReport())).toContain('rel="noreferrer"');
  });

  it('escapes every dynamic string', () => {
    const r = sampleReport();
    const evil = '<script>alert("x")</script>';
    const f = r.findings[0];
    if (!f) throw new Error('sample has findings');
    f.title = evil;
    f.fix = { summary: evil, diff: evil, docsUrl: 'javascript:alert(1)' };
    f.evidence[0] = { sessionId: evil, turnUuid: evil, detail: evil };
    r.sessions[0] = { ...r.sessions[0]!, project: evil, models: [evil] };
    const html = renderHtml(r);
    expect(html).not.toContain(evil);
    expect(html).toContain('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;');
    expect(html).not.toContain('href="javascript:');
    expect(html.match(/<script>/g)).toHaveLength(1);
  });

  it('labels measured and estimated values and has the required sections', () => {
    const html = renderHtml(sampleReport(), { homeDir: SAMPLE_HOME });
    for (const s of [
      'Summary (measured)',
      'Token breakdown',
      'Where it went (estimated)',
      'Findings',
      'Sessions',
      'Parse stats',
      'Legend',
      'Local-only report generated by tknxray',
    ]) {
      expect(html).toContain(s);
    }
    expect(html).toContain('prefers-color-scheme:dark');
    expect(html).not.toContain('/home/dev');
    expect(html).toContain('not included');
  });

  it('render() dispatches to every format', () => {
    const r = sampleReport();
    expect(render(r, 'terminal')).toContain('TOP FINDINGS');
    expect(render(r, 'json')).toContain('"schemaVersion": 1');
    expect(render(r, 'html')).toContain('<!doctype html>');
  });
});
