// Every evidence entry the analyzers can locate carries a source pointer (file:line), so reports
// never fall back to a session id where a line is known. Synthetic sessions only.
import { afterAll, describe, expect, it } from 'vitest';
import { session, text, toolUse } from '../../scripts/make-fixture.js';
import { ANALYZERS } from '../../src/analyzers/index.js';
import { cleanup, ctx, load, toolDef } from '../helpers/analyze.js';

afterAll(cleanup);

describe('evidence sources', () => {
  it('A4 baselines, A7 summaries and A10 API errors point at a line', async () => {
    const s = session('ev/src')
      .prompt('go')
      .attachment({
        type: 'prompt_snapshot',
        tools: [toolDef('Bash', 100), toolDef('Grep', 100), toolDef('mcp__gh__get', 300)],
      })
      .assistant({ usage: { cacheWrite: 20_000 }, blocks: [toolUse('Bash', { command: 'ls' })] })
      .toolResult(10)
      .assistant({
        model: '<synthetic>',
        requestId: null,
        blocks: [text('API Error')],
        envelope: { isApiErrorMessage: true, error: 'overloaded_error' },
      });
    const sessions = await load([s]);
    const findings = ANALYZERS.flatMap((a) => a.run(sessions, ctx()));
    const ids = new Set(findings.map((f) => f.analyzer));
    for (const id of ['fixed-overhead', 'tool-usage', 'error-waste']) expect(ids).toContain(id);
    for (const f of findings)
      for (const e of f.evidence) {
        expect([f.analyzer, e.source?.file]).toEqual([f.analyzer, expect.any(String)]);
        expect(e.source!.line).toBeGreaterThan(0);
      }
  });
});
