// A7 tool-usage. Definition sizes are set exactly with toolDef(); expected numbers by hand.
import { afterAll, describe, expect, it } from 'vitest';
import { session, toolUse } from '../../scripts/make-fixture.js';
import { toolUsage } from '../../src/analyzers/tool-usage.js';
import { cleanup, run, toolDef } from '../helpers/analyze.js';

afterAll(cleanup);

const snapshot = (...tools: ReturnType<typeof toolDef>[]) => ({ type: 'prompt_snapshot', tools });
const calls = (name: string, ...tools: string[]) => {
  const s = session(`a7/${name}`).prompt('go');
  for (const t of tools) s.assistant({ blocks: [toolUse(t)] }).toolResult(10);
  return s;
};
const servers = (fs: Awaited<ReturnType<typeof run>>) =>
  fs.filter((f) => typeof f.data?.server === 'string');

describe('A7 tool-usage', () => {
  it('positive: one finding per MCP server with unused tools, one for built-ins', async () => {
    const s = calls('p1', 'Bash', 'Read', 'Bash', 'mcp__github__list_prs').attachment(
      snapshot(
        toolDef('Bash', 100),
        toolDef('Read', 100),
        toolDef('Grep', 200),
        toolDef('mcp__github__create_issue', 300),
        toolDef('mcp__github__list_prs', 200),
        toolDef('mcp__github__get_file', 400),
        toolDef('mcp__linear__search', 100),
      ),
    );
    const fs = await run(toolUsage, [s]);
    expect(fs).toHaveLength(4);
    expect(fs[0]!.data).toMatchObject({ calls: 4, distinctTools: 3, definitionsKnown: true });
    expect(fs[0]!.data?.top).toEqual([
      { name: 'Bash', count: 2 },
      { name: 'Read', count: 1 },
      { name: 'mcp__github__list_prs', count: 1 },
    ]);
    const [gh, lin] = servers(fs);
    // The M5 `tknxray fix mcp` contract: exactly these keys.
    expect(gh!.data).toEqual({
      server: 'github',
      unusedTools: ['mcp__github__create_issue', 'mcp__github__get_file'],
      usedTools: ['mcp__github__list_prs'],
      defChars: 700,
    });
    expect(gh!.tokens).toEqual({ value: 175, kind: 'estimated' });
    expect(gh!.severity).toBe('warn');
    expect(lin!.data).toEqual({
      server: 'linear',
      unusedTools: ['mcp__linear__search'],
      usedTools: [],
      defChars: 100,
    });
    expect(lin!.tokens.value).toBe(25);
    expect(lin!.fix.summary).toContain('Disable the "linear" MCP server');
    expect(gh!.fix.summary).toBe(
      'Deny the unused "github" tools in permissions.deny (run `tknxray fix mcp` to preview the change)',
    );
    // No internal milestone labels (M4, M5…) in user-visible text.
    for (const f of fs) expect(`${f.title} ${f.fix.summary}`).not.toMatch(/\bM\d\b/);
    const builtin = fs[3]!;
    expect(builtin.severity).toBe('info');
    expect(builtin.data).toEqual({ unusedTools: ['Grep'], deferredTools: [], defChars: 200 });
    expect(builtin.tokens).toEqual({ value: 50, kind: 'estimated' });
  });

  it('positive: definitions and calls are unioned across sessions', async () => {
    const defs = snapshot(toolDef('mcp__fs__read', 100), toolDef('mcp__fs__write', 100));
    const a = calls('p2a').attachment(defs).assistant();
    const b = calls('p2b', 'mcp__fs__read').attachment(defs);
    const [gh, ...rest] = servers(await run(toolUsage, [a, b]));
    expect(rest).toEqual([]);
    expect(gh!.data).toEqual({
      server: 'fs',
      unusedTools: ['mcp__fs__write'],
      usedTools: ['mcp__fs__read'],
      defChars: 100,
    });
  });

  it('positive: server names with underscores; calls from subagents count', async () => {
    const p = calls('p3').attachment(snapshot(toolDef('mcp__my_server__do_thing', 100)));
    p.assistant();
    const a = p.agent('x').prompt('go');
    a.assistant({ blocks: [toolUse('mcp__my_server__other')] }).toolResult(5);
    const [f, ...rest] = servers(await run(toolUsage, [p, a]));
    expect(rest).toEqual([]);
    expect(f!.data).toEqual({
      server: 'my_server',
      unusedTools: ['mcp__my_server__do_thing'],
      usedTools: ['mcp__my_server__other'],
      defChars: 100,
    });
  });

  it('negative: without a prompt_snapshot only call counts are reported', async () => {
    const fs = await run(toolUsage, [calls('n1', 'Bash', 'mcp__github__list_prs')]);
    expect(fs).toHaveLength(1);
    expect(fs[0]!.data).toMatchObject({ calls: 2, distinctTools: 2, definitionsKnown: false });
    expect(fs[0]!.fix.summary).toContain('unknown without a prompt_snapshot');
  });

  it('negative: every defined tool was called', async () => {
    const s = calls('n2', 'Bash', 'mcp__gh__x').attachment(
      snapshot(toolDef('Bash', 100), toolDef('mcp__gh__x', 100)),
    );
    const fs = await run(toolUsage, [s]);
    expect(fs).toHaveLength(1);
    expect(servers(fs)).toEqual([]);
  });

  it('negative: no tool calls and no snapshot means no findings', async () => {
    expect(await run(toolUsage, [calls('n3').assistant()])).toEqual([]);
  });

  it('review: deferred tools are defined, cost 0 per cold turn and are listed separately', async () => {
    const s = calls('r1', 'mcp__github__list_prs')
      .attachment(
        snapshot(toolDef('mcp__github__list_prs', 200), toolDef('mcp__github__get_file', 400)),
      )
      .attachment({
        type: 'deferred_tools_record',
        tools: ['mcp__github__search_code', { name: 'WebFetch' }],
      });
    const fs = await run(toolUsage, [s]);
    const [gh] = servers(fs);
    expect(gh!.data).toEqual({
      server: 'github',
      unusedTools: ['mcp__github__get_file', 'mcp__github__search_code'],
      usedTools: ['mcp__github__list_prs'],
      defChars: 400, // search_code is deferred: 0
    });
    expect(gh!.tokens.value).toBe(100);
    expect(gh!.title).toContain('never called, 1 deferred');
    expect(gh!.evidence[1]!.detail).toBe('deferred, 0 tokens/cold turn: mcp__github__search_code');
    const builtin = fs.find((f) => f.data?.server === undefined && f.data?.unusedTools)!;
    expect(builtin.data).toEqual({
      unusedTools: ['WebFetch'],
      deferredTools: ['WebFetch'],
      defChars: 0,
    });
    expect(builtin.tokens.value).toBe(0);
  });

  it('review: snapshots in subagent transcripts are ignored', async () => {
    const p = calls('r2', 'Bash').attachment(snapshot(toolDef('Bash', 100)));
    const a = p
      .agent('s1')
      .attachment(snapshot(toolDef('mcp__x__y', 100)))
      .prompt('x');
    a.assistant();
    const fs = await run(toolUsage, [p, a]);
    expect(servers(fs)).toEqual([]);
  });
});
