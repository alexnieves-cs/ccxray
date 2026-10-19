// Evidence without a `source` (it is optional in the model) renders without a location: no
// "undefined", no dangling separator.
import { describe, expect, it } from 'vitest';
import { renderHtml } from '../../src/reporters/html.js';
import { renderJson } from '../../src/reporters/json.js';
import { stripAnsi } from '../../src/reporters/format.js';
import { renderTerminal } from '../../src/reporters/terminal.js';
import { sampleReport, SAMPLE_HOME } from '../helpers/sample-report.js';

function withoutSources() {
  const r = sampleReport();
  for (const f of r.findings) for (const e of f.evidence) delete e.source;
  return r;
}

describe('evidence without a source', () => {
  it('terminal falls back to the session id', () => {
    const out = stripAnsi(renderTerminal(withoutSources(), { color: false, homeDir: SAMPLE_HOME }));
    expect(out).not.toMatch(/undefined|null/);
    expect(out).toMatch(/e\.g\. session [0-9a-f]{8}/);
  });

  it('HTML leaves the source cell empty and JSON omits the key', () => {
    const html = renderHtml(withoutSources(), { homeDir: SAMPLE_HOME });
    expect(html).not.toContain('undefined');
    const json = JSON.parse(renderJson(withoutSources(), { homeDir: SAMPLE_HOME })) as {
      findings: { evidence: Record<string, unknown>[] }[];
    };
    for (const f of json.findings)
      for (const e of f.evidence) expect(e).not.toHaveProperty('source');
  });
});
