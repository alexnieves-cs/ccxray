// Regression tests for the M1 review findings (numbered as in the review). Expected numbers are
// written by hand from the inputs below.

import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { session, text, toolUse, writeTree, type AssistantSpec } from '../scripts/make-fixture.js';
import { discover } from '../src/discover.js';
import { main } from '../src/main.js';
import { loadSessions } from '../src/parser/index.js';
import { emptyCounts, streamJsonl } from '../src/parser/stream.js';

const FX = join(import.meta.dirname, 'fixtures', 'projects');
const TMP = mkdtempSync(join(tmpdir(), 'ccxray-review-'));
afterAll(() => rmSync(TMP, { recursive: true, force: true }));
let n = 0;
const freshRoot = (): string => {
  const d = join(TMP, `r${n++}`);
  mkdirSync(d, { recursive: true });
  return d;
};
const writeLines = (root: string, rel: string, lines: unknown[]): void => {
  const p = join(root, rel);
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(
    p,
    `${lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n')}\n`,
  );
};

describe('review regressions', () => {
  it('#1 first line without usage or timestamp does not zero the turn or set ts to epoch', async () => {
    const root = freshRoot();
    const env = { type: 'assistant', sessionId: 's1', requestId: 'req_1' };
    writeLines(root, join('-p', 's1.jsonl'), [
      { ...env, uuid: 'u-a', message: { id: 'msg_1', model: 'm', content: [text('a')] } },
      {
        ...env,
        uuid: 'u-b',
        timestamp: '2026-10-01T09:00:05.000Z',
        message: {
          id: 'msg_1',
          content: [toolUse('Bash', { command: 'ls' }, 'toolu_1')],
          usage: { input_tokens: 5, cache_read_input_tokens: 9000, output_tokens: 0 },
        },
      },
    ]);
    const { sessions, stats } = await loadSessions({ roots: [root] });
    const t = sessions[0]!.turns[0]!;
    expect(t.usage).toEqual({ input: 5, cacheWrite: 0, cacheRead: 9000, output: 0 });
    expect(t.ts.toISOString()).toBe('2026-10-01T09:00:05.000Z');
    expect(t).toMatchObject({ uuid: 'u-a', model: 'm', blockCounts: { text: 1, tool_use: 1 } });
    expect(stats.warnings).toEqual({
      'assistant without message.usage': 1,
      'assistant without timestamp': 1,
    });
  });

  it('#2 the same file under two roots merges without duplicating prompts or tool_results', async () => {
    const copy = freshRoot();
    cpSync(join(FX, 'multi-block-same-msgid'), copy, { recursive: true });
    const { sessions, stats } = await loadSessions({
      roots: [join(FX, 'multi-block-same-msgid'), copy],
    });
    expect(sessions).toHaveLength(1);
    const s = sessions[0]!;
    expect(s.files).toHaveLength(2);
    expect(s.prompts).toHaveLength(1);
    expect(s.turns.map((t) => t.toolResults.length)).toEqual([1, 1, 0]);
    expect(stats.dedupe.crossSessionCopies).toBe(3);
  });

  it('#3 index and gapMs are per chain when sidechain turns sit in the main file', async () => {
    const root = freshRoot();
    const s = session('rev3', { project: '-p' })
      .prompt('a')
      .assistant({ usage: { input: 1 } })
      .assistant({ sidechain: true, envelope: { agentId: 'side1' }, usage: { input: 2 } })
      .gap('60s')
      .assistant({ usage: { input: 3 } });
    writeTree(root, [s]);
    const turns = (await loadSessions({ roots: [root] })).sessions[0]!.turns;
    // prompt @0 s, main @1 s, sidechain @2 s, +60 s gap, main @63 s.
    expect(turns.map((t) => [t.usage.input, t.index, t.gapMs])).toEqual([
      [1, 0, null],
      [2, 0, null],
      [3, 1, 62_000],
    ]);
  });

  describe('#5 cross-session copy keeps the original, not the first path', () => {
    const X: AssistantSpec = {
      msgId: 'msg_X',
      requestId: 'req_X',
      usage: { input: 10, cacheWrite: 5000, output: 100 },
      blocks: [text('x')],
    };
    const ORIG = 'zzzzzzzz-0000-4000-8000-000000000001';
    const COPY = 'aaaaaaaa-0000-4000-8000-000000000002';
    const ownerOf = async (root: string) =>
      (await loadSessions({ roots: [root] })).sessions
        .filter((s) => s.turns.some((t) => t.messageId === 'msg_X'))
        .map((s) => s.id);

    it('prefers the file whose sessionId matches the record envelope', async () => {
      const root = freshRoot();
      const orig = session('rev5a/orig', {
        id: ORIG,
        project: '-p',
        start: '2026-10-01T09:00:00.000Z',
      });
      orig.prompt('p').assistant(X);
      // The copy file starts earlier and sorts first, but the copied line keeps the original id.
      const copy = session('rev5a/copy', {
        id: COPY,
        project: '-p',
        start: '2026-10-01T08:00:00.000Z',
      });
      copy.prompt('p').assistant({ ...X, envelope: { sessionId: ORIG } });
      writeTree(root, [orig, copy]);
      expect(await ownerOf(root)).toEqual([ORIG]);
    });

    it('else prefers the file with the earliest first timestamp', async () => {
      const root = freshRoot();
      const orig = session('rev5b/orig', {
        id: ORIG,
        project: '-p',
        start: '2026-10-01T09:00:00.000Z',
      });
      orig.prompt('p').assistant(X);
      const copy = session('rev5b/copy', {
        id: COPY,
        project: '-p',
        start: '2026-10-01T10:00:00.000Z',
      });
      copy.prompt('p').assistant(X);
      writeTree(root, [orig, copy]);
      expect(await ownerOf(root)).toEqual([ORIG]);
    });
  });

  it('#6 un-stringifiable (20k-deep) tool input still yields a complete turn', async () => {
    const root = freshRoot();
    const deep = `${'['.repeat(20_000)}${']'.repeat(20_000)}`;
    const line =
      `{"type":"assistant","uuid":"u1","sessionId":"s6","requestId":"req_6",` +
      `"timestamp":"2026-10-01T09:00:00.000Z","message":{"id":"msg_6","content":[` +
      `{"type":"tool_use","id":"toolu_6","name":"Bash","input":${deep}}],` +
      `"usage":{"input_tokens":1,"output_tokens":2}}}`;
    const snapshot =
      `{"type":"attachment","uuid":"u2","sessionId":"s6","timestamp":"2026-10-01T09:00:01.000Z",` +
      `"attachment":{"type":"prompt_snapshot","tools":[${deep}]}}`;
    writeLines(root, join('-p', 's6.jsonl'), [line, snapshot]);
    for (const includeContent of [false, true]) {
      const { sessions, stats } = await loadSessions({ roots: [root], includeContent });
      const t = sessions[0]!.turns[0]!;
      expect(t.toolUses.map((u) => [u.id, u.inputChars])).toEqual([['toolu_6', line.length]]);
      expect(t.usage.output).toBe(2);
      expect(sessions[0]!.events[0]).toMatchObject({ tools: [{ chars: snapshot.length }] });
      expect(stats.warnings).toEqual({});
    }
  });

  it('#7 follows symlinked dirs and survives a symlink loop', async (ctx) => {
    const root = freshRoot();
    try {
      symlinkSync(
        join(FX, 'minimal-single-turn', '-home-dev-minimal-single-turn'),
        join(root, '-linked'),
        'junction',
      );
      symlinkSync(root, join(root, 'loop'), 'junction');
    } catch {
      ctx.skip(); // no symlink permission on this machine
    }
    const d = await discover([root]);
    expect(d.files.map((f) => f.project)).toEqual(['-linked']);
    expect((await loadSessions({ roots: [root] })).sessions[0]!.turns).toHaveLength(1);
  });

  it('#8 tool_use input is slim without includeContent, raw with it', async () => {
    const root = join(FX, 'repeated-read-after-edit');
    const edit = async (includeContent: boolean) =>
      (await loadSessions({ roots: [root], includeContent })).sessions[0]!.turns.flatMap(
        (t) => t.toolUses,
      ).find((u) => u.name === 'Edit')!;
    const file_path = '/home/dev/repeated-read-after-edit/src/api/client.ts';
    const slim = await edit(false);
    expect(slim.input).toEqual({ file_path });
    // Raw input: `{"file_path":"` 14 + path + `"` 1 + `,"old_string":"a"` 17 + `,"new_string":"b"` 17 + `}` 1.
    expect(slim.inputChars).toBe(14 + file_path.length + 1 + 17 + 17 + 1);
    expect((await edit(true)).input).toEqual({ file_path, old_string: 'a', new_string: 'b' });
  });

  it('#8 a line over the cap is counted as malformed without being buffered', async () => {
    const f = join(freshRoot(), 'big.jsonl');
    // 300k chars spans several 64 KiB read chunks; the cap is 100k.
    writeFileSync(
      f,
      `{"pad":"${'x'.repeat(300_000)}"}\n{"type":"user"}\n{"a":"${'y'.repeat(150_000)}"}`,
    );
    const counts = emptyCounts();
    const seen: number[] = [];
    await streamJsonl(f, (_r, line) => seen.push(line), counts, 100_000);
    expect(seen).toEqual([2]);
    expect(counts).toMatchObject({ lines: 3, malformedLines: 2, oversizedLines: 2 });
  });

  it('#9 doctor escapes control characters in keys', async () => {
    const root = freshRoot();
    writeLines(root, join('-p', 's9.jsonl'), [{ type: '\u001b[31mred' }]);
    let out = '';
    await main(['doctor', '--root', root], (s) => (out += s));
    expect(out).toContain('\\x1b[31mred');
    expect(out).not.toContain('\u001b');
  });
});

describe('subagent classification (m2 repro: root one level above projects/ trees)', () => {
  const summary = (sessions: { id: string; project: string; isSubagent: boolean }[]) =>
    sessions.map((s) => `${s.project} ${s.id} ${s.isSubagent}`).sort();

  it('a root above <fixture>/<project>/ gives the same sessions as per-fixture roots', async () => {
    const { readdirSync } = await import('node:fs');
    const all = await loadSessions({ roots: [FX] });
    const each = [];
    for (const name of readdirSync(FX))
      each.push(...(await loadSessions({ roots: [join(FX, name)] })).sessions);
    expect(summary(all.sessions)).toEqual(summary(each));
    // Hand count (FORMAT.md "Fixtures"): 20 sessions, 3 of them subagents.
    expect(all.sessions).toHaveLength(20);
    expect(all.sessions.filter((s) => s.isSubagent)).toHaveLength(3);
    expect(all.sessions.filter((s) => !s.isSubagent).every((s) => !s.id.includes(':'))).toBe(true);
    expect(all.sessions.every((s) => s.project.startsWith('-home-dev-'))).toBe(true);
  });

  it('a deeper file is a main session of its parent dir unless its layout or records say subagent', async () => {
    const root = freshRoot();
    const sid = 'abcdef01-0000-4000-8000-000000000000';
    const sid2 = 'abcdef02-0000-4000-8000-000000000000';
    let k = 0;
    const line = (o: Record<string, unknown>) => ({
      type: 'assistant',
      sessionId: sid,
      uuid: `u-${++k}`,
      timestamp: '2026-10-01T09:00:00.000Z',
      message: {
        id: `m-${k}`,
        role: 'assistant',
        content: [],
        usage: { input_tokens: 1, output_tokens: 1 },
      },
      requestId: 'r',
      ...o,
    });
    // Two levels above the project dir: a normal session.
    writeLines(root, join('a', 'b', '-home-dev-p', `${sid}.jsonl`), [line({})]);
    // agent-*.jsonl in a dir that is not a sessionId, not all sidechain: a normal session.
    writeLines(root, join('-home-dev-q', 'misc', 'agent-x.jsonl'), [line({ sessionId: sid2 })]);
    // Every line isSidechain with agentId, in an arbitrary dir: a subagent of the envelope session.
    writeLines(root, join('-home-dev-r', 'old', 'side.jsonl'), [
      line({ isSidechain: true, agentId: 'y' }),
    ]);
    // `{sessionId}/agent-<id>.jsonl` and `{sessionId}/subagents/*.jsonl` layouts.
    writeLines(root, join('-home-dev-s', sid, 'agent-z.jsonl'), [
      line({ agentId: 'z', isSidechain: true, cwd: '/s' }),
    ]);
    writeLines(root, join('-home-dev-t', sid, 'subagents', 'w.jsonl'), [line({ cwd: '/t' })]);
    const { sessions } = await loadSessions({ roots: [root] });
    expect(
      sessions.map((s) => [s.project, s.id, s.isSubagent, s.parentSessionId ?? null]).sort(),
    ).toEqual(
      [
        ['-home-dev-p', sid, false, null],
        ['misc', sid2, false, null],
        ['old', `${sid}:agent-y`, true, sid],
        ['-home-dev-s', `${sid}:agent-z`, true, sid],
        ['-home-dev-t', `${sid}:w`, true, sid],
      ].sort(),
    );
  });
});
