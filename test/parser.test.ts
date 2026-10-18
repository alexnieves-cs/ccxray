// Fixture tests (SPEC §6 M1, §7). Every expected number below is computed by hand from the
// fixture definitions in scripts/make-fixture.ts, not derived from parser code.

import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Session, Usage } from '../src/model/index.js';
import { loadSessions, type LoadOptions } from '../src/parser/index.js';

const FX = join(import.meta.dirname, 'fixtures', 'projects');
const load = (name: string, o: LoadOptions = {}) => loadSessions({ roots: [join(FX, name)], ...o });
const NO_DROPS = { sameResponseLines: 0, sidechainReplays: 0, crossSessionCopies: 0 };

function totals(
  s: Session | Session[],
): Pick<Usage, 'input' | 'cacheWrite' | 'cacheRead' | 'output'> {
  const t = { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 };
  for (const x of Array.isArray(s) ? s : [s])
    for (const turn of x.turns) {
      if (turn.isSynthetic) continue;
      t.input += turn.usage.input;
      t.cacheWrite += turn.usage.cacheWrite;
      t.cacheRead += turn.usage.cacheRead;
      t.output += turn.usage.output;
    }
  return t;
}
const only = (sessions: Session[]): Session => {
  expect(sessions).toHaveLength(1);
  return sessions[0]!;
};
const results = (s: Session) =>
  s.turns.flatMap((t) =>
    t.toolResults.map((r) => ({
      name: r.toolName,
      chars: r.chars,
      est: r.estTokens,
      err: r.isError,
    })),
  );

describe('fixtures', () => {
  it('minimal-single-turn', async () => {
    const { sessions, stats } = await load('minimal-single-turn');
    const s = only(sessions);
    expect(s.id).toBe('89b7be2f-0000-4000-8000-000000000000');
    expect(s.project).toBe('-home-dev-minimal-single-turn');
    expect(s.cwd).toBe('/home/dev/minimal-single-turn');
    expect(s.isSubagent).toBe(false);
    expect(s.ccVersions).toEqual(['2.1.302']);
    expect(s.turns).toHaveLength(1);
    const t = s.turns[0]!;
    expect(t.usage).toEqual({
      input: 3,
      cacheWrite: 20000,
      cacheWrite5m: 20000,
      cacheWrite1h: 0,
      cacheRead: 0,
      output: 12,
    });
    expect(t).toMatchObject({
      index: 0,
      gapMs: null,
      model: 'claude-sonnet-4-5',
      isSynthetic: false,
      isSidechain: false,
    });
    expect(t.blockCounts).toEqual({ text: 1 });
    expect(t.source.line).toBe(2);
    expect(t.ts.toISOString()).toBe('2026-10-01T09:00:01.000Z');
    expect(s.prompts.map((p) => p.chars)).toEqual([6]);
    expect(s.prompts[0]!.text).toBeUndefined();
    expect(stats).toMatchObject({
      files: 1,
      lines: 2,
      blankLines: 0,
      malformedLines: 0,
      syntheticTurns: 0,
    });
    expect(stats.recordTypes).toEqual({ user: 1, assistant: 1 });
    expect(stats.unknownRecordTypes).toEqual({});
    expect(stats.dedupe).toEqual(NO_DROPS);
    expect(stats.warnings).toEqual({});
  });

  it('multi-block-same-msgid: one turn per response, usage from the largest output line', async () => {
    const { sessions, stats } = await load('multi-block-same-msgid');
    const s = only(sessions);
    expect(stats.lines).toBe(9);
    expect(stats.dedupe).toEqual({ ...NO_DROPS, sameResponseLines: 3 });
    expect(s.turns).toHaveLength(3);
    expect(totals(s)).toEqual({ input: 8, cacheWrite: 1700, cacheRead: 92500, output: 370 });
    expect(s.turns[0]!.usage.output).toBe(250);
    expect(s.turns[0]!.blockCounts).toEqual({ thinking: 1, text: 1, tool_use: 1 });
    expect(s.turns[0]!.stopReason).toBe('tool_use');
    expect(s.turns[0]!.source.line).toBe(2);
    expect(s.turns.map((t) => t.toolUses.map((u) => u.name))).toEqual([['Bash'], ['Read'], []]);
    expect(s.turns[0]!.toolUses[0]!.inputChars).toBe('{"command":"pnpm test"}'.length);
    expect(results(s)).toEqual([
      { name: 'Bash', chars: 120, est: 30, err: undefined },
      { name: 'Read', chars: 300, est: 75, err: undefined },
    ]);
  });

  it('sidechain-replay: the replayed parent response is dropped from the subagent', async () => {
    const { sessions, stats } = await load('sidechain-replay');
    expect(sessions).toHaveLength(2);
    const P = '109b484f-0000-4000-8000-000000000000';
    const parent = sessions.find((s) => s.id === P)!;
    const sub = sessions.find((s) => s.id === `${P}:agent-r1`)!;
    expect(sub).toMatchObject({ isSubagent: true, agentId: 'r1', parentSessionId: P });
    expect(stats.dedupe).toEqual({ ...NO_DROPS, sidechainReplays: 1 });
    expect(totals(parent)).toEqual({ input: 13, cacheWrite: 8150, cacheRead: 8000, output: 80 });
    expect(totals(sub)).toEqual({ input: 6, cacheWrite: 3100, cacheRead: 3000, output: 55 });
    expect(sub.turns.every((t) => t.isSidechain && t.agentId === 'r1')).toBe(true);
    expect(results(parent)).toEqual([{ name: 'Task', chars: 40, est: 10, err: undefined }]);
    expect(results(sub)).toEqual([{ name: 'Glob', chars: 200, est: 50, err: undefined }]);
    expect(stats.warnings).toEqual({});
  });

  it('cross-session-copy: a response copied into two files counts once (first by path)', async () => {
    const { sessions, stats } = await load('cross-session-copy');
    const a = sessions.find((s) => s.id.startsWith('aaaaaaaa'))!;
    const b = sessions.find((s) => s.id.startsWith('bbbbbbbb'))!;
    expect(stats.files).toBe(2);
    expect(stats.dedupe).toEqual({
      sameResponseLines: 2,
      sidechainReplays: 0,
      crossSessionCopies: 2,
    });
    expect(a.turns.map((t) => t.messageId)).toEqual(['msg_copyX', 'msg_copyY']);
    expect(b.turns.map((t) => t.messageId)).toHaveLength(1);
    expect(totals(a)).toEqual({ input: 14, cacheWrite: 5300, cacheRead: 5000, output: 150 });
    expect(totals(b)).toEqual({ input: 2, cacheWrite: 100, cacheRead: 5300, output: 30 });
    expect(totals(sessions)).toEqual({
      input: 16,
      cacheWrite: 5400,
      cacheRead: 10300,
      output: 180,
    });
  });

  it('synthetic-error-turn: flagged, counted, and an api-error event', async () => {
    const { sessions, stats } = await load('synthetic-error-turn');
    const s = only(sessions);
    expect(s.turns.map((t) => t.isSynthetic)).toEqual([true, false]);
    expect(s.turns[0]!.model).toBe('<synthetic>');
    expect(s.turns[0]!.requestId).toBeUndefined();
    expect(s.turns[1]!.gapMs).toBe(122_000);
    expect(stats.syntheticTurns).toBe(1);
    expect(s.events).toHaveLength(1);
    expect(s.events[0]).toMatchObject({ kind: 'api-error', detail: 'authentication_failed' });
    expect(totals(s)).toEqual({ input: 3, cacheWrite: 19000, cacheRead: 0, output: 9 });
  });

  it('ttl-gap-rebuild: gaps between turns', async () => {
    const s = only((await load('ttl-gap-rebuild')).sessions);
    expect(s.turns.map((t) => t.gapMs)).toEqual([null, 32_000, 362_000]);
    expect(s.turns.map((t) => t.index)).toEqual([0, 1, 2]);
    expect(s.turns.map((t) => t.usage.cacheRead)).toEqual([0, 20000, 0]);
    expect(totals(s)).toEqual({ input: 8, cacheWrite: 41100, cacheRead: 20000, output: 270 });
    expect(s.firstTs.toISOString()).toBe('2026-10-01T09:00:00.000Z');
    expect(s.lastTs.toISOString()).toBe('2026-10-01T09:06:35.000Z');
  });

  it('version-change-rebuild: versions per turn and per record', async () => {
    const { sessions, stats } = await load('version-change-rebuild');
    const s = only(sessions);
    expect(s.ccVersions).toEqual(['2.1.300', '2.1.302']);
    expect(s.turns.map((t) => t.ccVersion)).toEqual(['2.1.300', '2.1.300', '2.1.302']);
    expect(stats.ccVersions).toEqual({ '2.1.300': 4, '2.1.302': 2 });
    expect(totals(s)).toEqual({ input: 8, cacheWrite: 41400, cacheRead: 20000, output: 135 });
  });

  it('model-switch', async () => {
    const s = only((await load('model-switch')).sessions);
    expect(s.turns.map((t) => t.model)).toEqual([
      'claude-sonnet-4-5',
      'claude-sonnet-4-5',
      'claude-opus-4-1',
    ]);
    expect(totals(s)).toEqual({ input: 8, cacheWrite: 36700, cacheRead: 18000, output: 115 });
  });

  it('big-bash-output: string and text-block tool results, is_error', async () => {
    const s = only((await load('big-bash-output')).sessions);
    expect(results(s)).toEqual([
      { name: 'Bash', chars: 48000, est: 12000, err: undefined },
      { name: 'Bash', chars: 32000, est: 8000, err: true },
    ]);
    expect(
      s.turns.flatMap((t) => t.toolUses.map((u) => (u.input as { command: string }).command)),
    ).toEqual(['pnpm test', 'pnpm build --verbose']);
    expect(totals(s)).toEqual({ input: 7, cacheWrite: 22200, cacheRead: 61100, output: 95 });
  });

  it('repeated-read-unchanged', async () => {
    const s = only((await load('repeated-read-unchanged')).sessions);
    const uses = s.turns.flatMap((t) => t.toolUses);
    expect(uses.map((u) => u.name)).toEqual(['Read', 'Read', 'Read']);
    expect(new Set(uses.map((u) => (u.input as { file_path: string }).file_path)).size).toBe(1);
    expect(results(s).map((r) => r.chars)).toEqual([4000, 4000, 4000]);
    expect(totals(s)).toEqual({ input: 7, cacheWrite: 6300, cacheRead: 46000, output: 105 });
  });

  it('repeated-read-after-edit', async () => {
    const s = only((await load('repeated-read-after-edit')).sessions);
    expect(s.turns.flatMap((t) => t.toolUses.map((u) => u.name))).toEqual(['Read', 'Edit', 'Read']);
    expect(results(s).map((r) => r.chars)).toEqual([4000, 50, 4100]);
    expect(totals(s)).toEqual({ input: 6, cacheWrite: 4200, cacheRead: 37100, output: 150 });
  });

  it('malformed-lines: counted and skipped', async () => {
    const { sessions, stats } = await load('malformed-lines');
    expect(stats).toMatchObject({ lines: 12, blankLines: 2, malformedLines: 6 });
    expect(stats.recordTypes).toEqual({ user: 1, assistant: 3 });
    expect(stats.warnings).toEqual({
      'assistant without message': 1,
      'assistant without message.usage': 1,
    });
    const s = only(sessions);
    expect(s.turns.map((t) => t.messageId)).toEqual([s.turns[0]!.messageId, 'msg_nousage']);
    expect(s.turns[1]!.usage).toEqual({ input: 0, cacheWrite: 0, cacheRead: 0, output: 0 });
    expect(totals(s)).toEqual({ input: 3, cacheWrite: 100, cacheRead: 0, output: 5 });
  });

  it('nested-subagents-dir: one session per agent file, linked to the parent', async () => {
    const { sessions, stats } = await load('nested-subagents-dir');
    const P = '0d25164f-0000-4000-8000-000000000000';
    expect(sessions.map((s) => s.id).sort()).toEqual([P, `${P}:agent-n1`, `${P}:agent-n2`]);
    const get = (id: string) => sessions.find((s) => s.id === id)!;
    expect(get(P).isSubagent).toBe(false);
    for (const a of ['n1', 'n2'])
      expect(get(`${P}:agent-${a}`)).toMatchObject({
        isSubagent: true,
        agentId: a,
        parentSessionId: P,
        // n1 via agent-n1.meta.json, n2 via the parent's toolUseResult.agentId.
        parentToolUseId: `toolu_agent_${a}`,
      });
    expect(get(P).parentToolUseId).toBeUndefined();
    expect(totals(get(P))).toEqual({ input: 9, cacheWrite: 9200, cacheRead: 9000, output: 100 });
    expect(totals(get(`${P}:agent-n1`))).toEqual({
      input: 5,
      cacheWrite: 4300,
      cacheRead: 4000,
      output: 35,
    });
    expect(totals(get(`${P}:agent-n2`))).toEqual({
      input: 3,
      cacheWrite: 4100,
      cacheRead: 0,
      output: 12,
    });
    expect(results(get(P)).map((r) => [r.name, r.chars])).toEqual([
      ['Agent', 7],
      ['Agent', 7],
    ]);
    expect(get(`${P}:agent-n1`).turns.every((t) => t.isSidechain && t.agentId === 'n1')).toBe(true);
    expect(stats.dedupe).toEqual({ ...NO_DROPS, sameResponseLines: 1 });
    expect(stats.warnings).toEqual({});
  });

  it('persisted-tool-output: externalized output keeps its inline size and the reported size', async () => {
    const { sessions, stats } = await load('persisted-tool-output');
    const s = only(sessions);
    expect(stats.files).toBe(1); // tool-results/*.txt is not parsed
    expect(stats.warnings).toEqual({});
    const rs = s.turns.flatMap((t) => t.toolResults);
    // 19 + (49 + 132 + 1) + 1 + 21 + (2048 + 1) + 19 chars of preview, as logged inline.
    expect(rs.map((r) => [r.toolName, r.chars, r.estTokens, r.persisted])).toEqual([
      ['Bash', 2291, 573, { reportedBytes: 37274 }],
      ['Bash', 300, 75, undefined],
    ]);
    expect(totals(s)).toEqual({ input: 6, cacheWrite: 2800, cacheRead: 49700, output: 90 });
  });

  it('unknown-record-types: counted; attachments and compaction become events', async () => {
    const { sessions, stats } = await load('unknown-record-types');
    expect(stats.lines).toBe(20);
    expect(stats.recordTypes).toEqual({
      'queue-operation': 1,
      attachment: 4,
      user: 3,
      assistant: 2,
      'ai-title': 1,
      'last-prompt': 1,
      'atis-latch': 1,
      'cost-state': 1,
      system: 1,
      summary: 1,
      'future-thing': 2,
      mystery: 1,
      '(missing)': 1,
    });
    expect(stats.unknownRecordTypes).toEqual({ 'future-thing': 2, mystery: 1, '(missing)': 1 });
    expect(stats.attachmentTypes).toEqual({
      instructions: 1,
      prompt_snapshot: 1,
      total_tokens_reminder: 2,
    });
    expect(stats.ccVersions).toEqual({ '2.1.302': 12 });
    expect(stats.warnings).toEqual({});
    const s = only(sessions);
    expect(s.firstTs.toISOString()).toBe('2026-10-01T08:59:59.000Z');
    expect(s.prompts.map((p) => p.chars)).toEqual([2, 16]);
    expect(s.events.map((e) => (e.kind === 'compaction' ? e.marker : e.kind))).toEqual([
      'instructions',
      'tools-snapshot',
      'system:compact_boundary',
      'isCompactSummary',
      'summary',
    ]);
    expect(s.events[0]).toMatchObject({
      files: [
        {
          path: '/home/dev/unknown-record-types/CLAUDE.md',
          chars: 18,
          hash: '7044add7d381158db266dffdc81fa1ed26e6c3bb6f606af231b8deffa6bc9fde',
        },
      ],
    });
    expect(JSON.stringify(s.events[0])).not.toContain('Use pnpm');
    expect(s.events[1]).toMatchObject({
      tools: [
        { name: 'Bash', chars: 15 },
        { name: 'Read', chars: 43 },
      ],
      systemPromptChars: 29,
    });
    expect(totals(s)).toEqual({ input: 5, cacheWrite: 21000, cacheRead: 0, output: 45 });
  });

  it('string-vs-array-content', async () => {
    const s = only((await load('string-vs-array-content')).sessions);
    expect(s.prompts.map((p) => p.chars)).toEqual([11, 8]);
    expect(s.turns.map((t) => t.blockCounts)).toEqual([{ text: 1 }, { tool_use: 2 }, { text: 1 }]);
    expect(results(s)).toEqual([
      { name: 'Bash', chars: 100, est: 25, err: undefined },
      { name: 'Read', chars: 50, est: 13, err: undefined },
    ]);
    expect(totals(s)).toEqual({ input: 7, cacheWrite: 800, cacheRead: 1100, output: 45 });
    expect(results(s).every((r) => !('text' in r))).toBe(true);
  });
});

describe('loadSessions options', () => {
  it('includeContent keeps prompt and tool_result text; default keeps none', async () => {
    const s = only((await load('string-vs-array-content', { includeContent: true })).sessions);
    expect(s.prompts.map((p) => p.text)).toEqual(['hello there', 'abcdefgh']);
    expect(s.turns[1]!.toolResults.map((r) => r.text?.length)).toEqual([100, 50]);
    const d = only((await load('string-vs-array-content')).sessions);
    expect(d.prompts.map((p) => p.text)).toEqual([undefined, undefined]);
    expect(d.turns[1]!.toolResults.map((r) => r.text)).toEqual([undefined, undefined]);
  });

  it('since/until filter turns, keep session-wide index/gapMs, and drop empty sessions', async () => {
    const since = new Date('2026-10-01T09:00:30.000Z');
    const s = only((await load('ttl-gap-rebuild', { since })).sessions);
    // Regression (review #4): the first in-window turn keeps its real 32 s gap and index 1.
    expect(s.turns.map((t) => [t.index, t.gapMs])).toEqual([
      [1, 32_000],
      [2, 362_000],
    ]);
    expect(s.firstTs.toISOString()).toBe('2026-10-01T09:00:00.000Z');
    const until = new Date('2026-10-01T09:00:10.000Z');
    expect(only((await load('ttl-gap-rebuild', { until })).sessions).turns).toHaveLength(1);
    expect((await load('ttl-gap-rebuild', { since: new Date('2026-10-02') })).sessions).toEqual([]);
  });

  it('project filter matches the project dir or cwd, case-insensitively', async () => {
    const roots = ['model-switch', 'ttl-gap-rebuild', 'minimal-single-turn'].map((n) =>
      join(FX, n),
    );
    const ids = async (project: string) =>
      (await loadSessions({ roots, project })).sessions.map((s) => s.project);
    expect(await ids('MODEL-Switch')).toEqual(['-home-dev-model-switch']);
    expect(await ids('/home/dev/ttl')).toEqual(['-home-dev-ttl-gap-rebuild']);
    expect(await ids('nope')).toEqual([]);
  });

  it('all fixtures together: no cross-fixture dedupe, exact session and turn counts', async () => {
    const { readdirSync } = await import('node:fs');
    const roots = readdirSync(FX).map((n) => join(FX, n));
    expect(roots).toHaveLength(16);
    const { sessions, stats } = await loadSessions({ roots });
    expect(sessions).toHaveLength(20);
    expect(sessions.reduce((a, s) => a + s.turns.length, 0)).toBe(47);
    expect(stats.files).toBe(20);
    expect(stats.dedupe).toEqual({
      sameResponseLines: 7,
      sidechainReplays: 1,
      crossSessionCopies: 2,
    });
    expect(stats.syntheticTurns).toBe(1);
  });
});
