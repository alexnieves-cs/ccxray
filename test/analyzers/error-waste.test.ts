// A10 error-waste. Expected numbers by hand from the records written below.
import { afterAll, describe, expect, it } from 'vitest';
import { session, text, toolUse, type SessionBuilder } from '../../scripts/make-fixture.js';
import { errorWaste } from '../../src/analyzers/error-waste.js';
import { loadSessions } from '../../src/parser/index.js';
import { cleanup, ctx, run, tree } from '../helpers/analyze.js';

afterAll(cleanup);

const synthetic = (s: SessionBuilder, error = 'overloaded_error') =>
  s.assistant({
    model: '<synthetic>',
    requestId: null,
    blocks: [text('API Error')],
    envelope: { isApiErrorMessage: true, error },
  });
const bash = (command: string) => ({ blocks: [toolUse('Bash', { command })] });
const apiFindings = (fs: Awaited<ReturnType<typeof run>>) =>
  fs.filter((f) => f.data?.errors !== undefined);
const recallFindings = (fs: Awaited<ReturnType<typeof run>>) =>
  fs.filter((f) => f.data?.recalls !== undefined);

describe('A10 error-waste', () => {
  it('positive: a synthetic error turn retried 31 s later on the same model', async () => {
    const s = session('a10/p1')
      .prompt('go')
      .assistant({ usage: { cacheWrite: 10_000 } })
      .prompt('next');
    synthetic(s)
      .gap('30s')
      .assistant({ usage: { cacheWrite: 500, cacheRead: 10_000 } });
    const [f, ...rest] = await run(errorWaste, [s]);
    expect(rest).toEqual([]);
    expect(f!.tokens).toEqual({ value: 0, kind: 'measured' });
    expect(f!.data).toEqual({ errors: 1, syntheticTurns: 1, apiErrorEvents: 0, retries: 1 });
    expect(f!.evidence[0]!.detail).toBe('API error: overloaded_error');
  });

  it('positive: a system api_error record, not retried within 60 s', async () => {
    const s = session('a10/p2')
      .prompt('go')
      .assistant({ usage: { cacheWrite: 10_000 } })
      .record('system', { subtype: 'api_error' })
      .gap('2m')
      .assistant({ usage: { cacheWrite: 10_000 } });
    const [f] = await run(errorWaste, [s]);
    expect(f!.data).toEqual({ errors: 1, syntheticTurns: 0, apiErrorEvents: 1, retries: 0 });
  });

  it('positive: a failed Bash call re-issued with the same input', async () => {
    const s = session('a10/p3')
      .prompt('test it')
      .assistant(bash('pnpm tset'))
      .toolResult({ chars: 400, isError: true })
      .assistant(bash('pnpm tset'))
      .toolResult(100)
      .assistant();
    const [f, ...rest] = recallFindings(await run(errorWaste, [s]));
    expect(rest).toEqual([]);
    // failed result 400 chars → 100 [E]; re-call input {"command":"pnpm tset"} 23 chars → 6 [E].
    expect(f!.tokens).toEqual({ value: 106, kind: 'estimated' });
    expect(f!.data).toEqual({ tool: 'Bash', recalls: 1, sessions: 1, match: 'identical' });
    expect(f!.title).toContain('(same input)');
    expect(f!.evidence[0]!.detail).not.toContain('tset');
  });

  it('negative: a failed call followed by a different command, and a model switch', async () => {
    const s = session('a10/n1')
      .prompt('test it')
      .assistant(bash('pnpm tset'))
      .toolResult({ chars: 400, isError: true })
      .assistant(bash('pnpm test'))
      .toolResult(100);
    synthetic(s).gap('10s').model('claude-opus-4-1').assistant();
    const fs = await run(errorWaste, [s]);
    expect(recallFindings(fs)).toEqual([]);
    expect(apiFindings(fs)[0]!.data?.retries).toBe(0);
  });

  it('negative: a failed MCP call retried with a different argument of the same length', async () => {
    // Real-log FP (2026-10-22 review): the slim input of an MCP tool is `{}`, so the old
    // size-only match counted a corrected retry as a waste.
    const mcp = (id: string) => ({ blocks: [toolUse('mcp__x__start', { message_id: id })] });
    const s = session('a10/n3')
      .prompt('go')
      .assistant(mcp('msg_aaaa'))
      .toolResult({ chars: 300, isError: true })
      .assistant(mcp('msg_bbbb'))
      .toolResult(100);
    expect(recallFindings(await run(errorWaste, [s]))).toEqual([]);
  });

  it('negative: the same call re-issued after a new prompt (e.g. a permission granted)', async () => {
    const s = session('a10/n4')
      .prompt('merge it')
      .assistant(bash('git merge main'))
      .toolResult({ chars: 300, isError: true })
      .prompt('approved, go ahead')
      .assistant(bash('git merge main'))
      .toolResult(100);
    expect(recallFindings(await run(errorWaste, [s]))).toEqual([]);
  });

  it('negative: an identical call 4 turns later is outside the lookahead; no errors', async () => {
    const s = session('a10/n2')
      .prompt('test it')
      .assistant(bash('pnpm tset'))
      .toolResult({ chars: 400, isError: true });
    for (const c of ['ls', 'pwd', 'date']) s.assistant(bash(c)).toolResult(10);
    s.assistant(bash('pnpm tset')).toolResult(10);
    expect(await run(errorWaste, [s])).toEqual([]);
  });

  it('review: --include-content matches the same calls', async () => {
    const s = session('a10/r1')
      .prompt('test it')
      .assistant(bash('pnpm tset'))
      .toolResult({ chars: 400, isError: true })
      .assistant(bash('pnpm tset'))
      .toolResult(100);
    const { sessions } = await loadSessions({ roots: [tree([s])], includeContent: true });
    const [f] = errorWaste.run(sessions, { ...ctx(), includeContent: true });
    expect(f!.data?.match).toBe('identical');
    expect(f!.title).toContain('(same input)');
  });

  it('review: a system api_error and its synthetic turn are one error', async () => {
    const s = session('a10/r2')
      .prompt('go')
      .assistant({ usage: { cacheWrite: 10_000 } })
      .prompt('next')
      .record('system', { subtype: 'api_error' });
    synthetic(s)
      .gap('5m')
      .assistant({ usage: { cacheWrite: 10_000 } });
    const [f] = await run(errorWaste, [s]);
    expect(f!.data).toEqual({ errors: 1, syntheticTurns: 1, apiErrorEvents: 0, retries: 0 });
  });

  it('review: synthetic inline sidechain turns are outside the main chain', async () => {
    const s = session('a10/r3')
      .prompt('go')
      .assistant({ usage: { cacheWrite: 10_000 } })
      .assistant({
        model: '<synthetic>',
        requestId: null,
        sidechain: true,
        envelope: { agentId: 'x', isApiErrorMessage: true },
      });
    expect(await run(errorWaste, [s])).toEqual([]);
  });

  it('names a subagent by its agent id, not by the parent session id', async () => {
    const p = session('a10/sub', { id: 'face0000-1111-2222-3333-444444444444' })
      .prompt('go')
      .assistant({ usage: { cacheWrite: 1_000 } });
    const a = p.agent('a7777777abcdef').prompt('explore');
    a.assistant({ usage: { cacheWrite: 1_000 } });
    synthetic(a);
    const [f, ...rest] = apiFindings(await run(errorWaste, [p, a]));
    expect(rest).toEqual([]);
    expect(f!.title).toMatch(/^1 API error in subagent a7777777,/);
  });
});
