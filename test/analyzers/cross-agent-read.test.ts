// A11 cross-agent-read. Expected numbers worked out by hand from scripts/make-fixture.ts
// ('shared-spec-reads') and the builders below; all content is synthetic.
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { session, toolUse } from '../../scripts/make-fixture.js';
import { bigToolOutput } from '../../src/analyzers/big-tool-output.js';
import { catTarget, crossAgentRead } from '../../src/analyzers/cross-agent-read.js';
import { repeatedRead } from '../../src/analyzers/repeated-read.js';
import { loadSessions } from '../../src/parser/index.js';
import { cleanup, ctx, run } from '../helpers/analyze.js';

afterAll(cleanup);

const FX = join(import.meta.dirname, '..', 'fixtures', 'projects', 'shared-spec-reads');
const fixture = async () => (await loadSessions({ roots: [FX] })).sessions;

describe('A11 cross-agent-read', () => {
  it('positive: one file read by the main session and two subagents, spelled three ways', async () => {
    const fs = crossAgentRead.run(await fixture(), ctx());
    expect(fs).toHaveLength(1); // README.md has only 2 readers; a3's SPEC.md read failed
    const f = fs[0]!;
    expect(f.title).toBe('docs/SPEC.md read by 3 agents of session cb51037c (main + 2 subagents)');
    // 3 copies of 20,000 chars (5,000 est. tokens); the copies beyond the largest: 10,000 [E].
    expect(f.tokens).toEqual({ value: 10_000, kind: 'estimated' });
    expect(f.data).toEqual({ tool: 'Read', path: 'docs/SPEC.md', agents: 3, subagents: 2 });
    // Sonnet 4.5, 5m writes: main and a1 copies are written (3.75) then read once (0.30):
    // 5,000 × 4.05 = 20,250 µ$ each; a2's copy is only written: 18,750 µ$. Savings = 2 × median.
    expect(f.impact).toMatchObject({
      costUsd: 0.05925,
      savingsUsd: 0.0405,
      savingsSubagentUsd: 0.0405,
      savingsMainUsd: 0,
      confidence: 'estimated',
    });
    expect(f.evidence.map((e) => e.detail)).toEqual([
      'read by main session cb51037c (~5k tokens [E]); stayed in context for 2 turns, ~$0.02 [E]',
      'read by subagent a1 (~5k tokens [E]); stayed in context for 2 turns, ~$0.02 [E]',
      'read by subagent a2 (~5k tokens [E]); stayed in context for 1 turn, ~$0.02 [E]',
    ]);
    expect(f.fix.summary).toContain('subagent prompt or a CLAUDE.md summary');
  });

  it('no double count: A5 skips the copies, A6 keeps the in-agent re-read', async () => {
    const sessions = await fixture();
    expect(bigToolOutput.run(sessions, ctx())).toEqual([]);
    const a6 = repeatedRead.run(sessions, ctx());
    expect(a6.map((f) => f.title)).toEqual(['docs/SPEC.md re-read 1× unchanged in subagent a1']);
  });

  it('threshold: crossAgentReadMinAgents', async () => {
    expect(crossAgentRead.run(await fixture(), ctx({ crossAgentReadMinAgents: 4 }))).toEqual([]);
    const two = crossAgentRead.run(await fixture(), ctx({ crossAgentReadMinAgents: 2 }));
    expect(two.map((f) => f.data?.path).sort()).toEqual(['README.md', 'docs/SPEC.md']);
  });

  it('inline sidechain agents count as agents; separate session trees do not add up', async () => {
    const read = { blocks: [toolUse('Read', { file_path: '/home/dev/app/a.md' })] };
    const p = session('a11/inline')
      .prompt('x')
      .assistant({ usage: { cacheWrite: 1000 }, ...read });
    p.toolResult(400);
    for (const id of ['i1', 'i2'])
      p.assistant({
        sidechain: true,
        envelope: { agentId: id },
        usage: { cacheWrite: 1000 },
        ...read,
      }).toolResult(400);
    const other = session('a11/other')
      .prompt('y')
      .assistant({ usage: { cacheWrite: 1000 }, ...read });
    other.toolResult(400);
    const fs = await run(crossAgentRead, [p, other]);
    expect(fs.map((f) => [f.title, f.data?.agents])).toEqual([
      [`a.md read by 3 agents of session ${p.id.slice(0, 8)} (main + 2 subagents)`, 3],
    ]);
  });

  it('negatives: two readers, errored reads, other tools', async () => {
    const s = session('a11/neg').prompt('x');
    s.assistant({ blocks: [toolUse('Read', { file_path: 'b.md' })] }).toolResult(100);
    const a1 = s.agent('n1').prompt('a');
    a1.assistant({ blocks: [toolUse('Read', { file_path: 'b.md' })] }).toolResult(100);
    const a2 = s.agent('n2').prompt('b');
    a2.assistant({ blocks: [toolUse('Read', { file_path: 'b.md' })] }).toolResult({
      chars: 10,
      isError: true,
    });
    const a3 = s.agent('n3').prompt('c');
    a3.assistant({ blocks: [toolUse('Bash', { command: 'cat b.md | head' })] }).toolResult(100);
    expect(await run(crossAgentRead, [s, a1, a2, a3])).toEqual([]);
  });

  it('plain `cat` counts, and the same relative path from several worktrees is one file', async () => {
    const s = session('a11/cat').prompt('x');
    s.assistant({ blocks: [toolUse('Read', { file_path: '/home/dev/app/docs/SPEC.md' })] });
    s.toolResult(8000);
    const cmds = [
      'cd /home/dev/wt-a && cat docs/SPEC.md',
      'cd /home/dev/wt-b && cat -n docs/SPEC.md',
    ];
    const agents = cmds.map((command, i) => {
      const a = s.agent(`c${i}`).prompt('read the spec');
      a.assistant({ blocks: [toolUse('Bash', { command })] }).toolResult(8000);
      return a;
    });
    const [f, ...rest] = await run(crossAgentRead, [s, ...agents]);
    expect(rest).toEqual([]);
    expect(f!.title).toBe(
      `docs/SPEC.md read by 3 agents of session ${s.id.slice(0, 8)} (main + 2 subagents, from 3 directories)`,
    );
    expect(f!.data).toMatchObject({ tool: 'Read+Bash', directories: 3, agents: 3 });
    expect(f!.evidence[1]!.detail).toMatch(/^read by subagent c0 with cat /);
  });
});

describe('catTarget', () => {
  it('accepts one plain file, optionally after cd', () => {
    expect(catTarget('cat a.md')).toEqual({ file: 'a.md' });
    expect(catTarget('cat -n /x/a.md')).toEqual({ file: '/x/a.md' });
    expect(catTarget('cd /w && cat docs/a.md')).toEqual({ dir: '/w', file: 'docs/a.md' });
    expect(catTarget('cd /w; cat docs/a.md')).toEqual({ dir: '/w', file: 'docs/a.md' });
  });

  it('rejects pipes, globs, several files and other commands', () => {
    for (const c of [
      'cat a.md | head',
      'cat a.md b.md',
      'cat *.md',
      'cat a.md && cat b.md',
      'cat a.md > b.md',
      'cd /w && ls && cat a.md',
      'cat "a b.md"',
      'cat',
      'cat -A a.md',
      'git show HEAD:a.md',
    ])
      expect(catTarget(c), c).toBeUndefined();
  });
});
