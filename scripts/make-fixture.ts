// Synthetic transcript builder (SPEC §7) and the committed fixtures under test/fixtures/projects.
//
//   pnpm fixtures      # regenerate test/fixtures/projects/<name>/ for every fixture below
//
// Deterministic: ids derive from the session name and a counter, timestamps from a clock that
// advances 1 s per record (plus explicit gaps). Multi-block responses are written one line per
// block, like Claude Code 2.1.302 (docs/FORMAT.md). All content is synthetic.

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

type Rec = Record<string, unknown>;

export interface UsageSpec {
  input?: number;
  cacheWrite?: number;
  cacheWrite5m?: number;
  cacheWrite1h?: number;
  cacheRead?: number;
  output?: number;
}

export const text = (t: string): Rec => ({ type: 'text', text: t });
export const thinking = (chars = 40): Rec => ({
  type: 'thinking',
  thinking: 't'.repeat(chars),
  signature: 'sig',
});
export const toolUse = (name: string, input: unknown = {}, id?: string): Rec => ({
  type: 'tool_use',
  ...(id !== undefined ? { id } : {}),
  name,
  input,
});
export const textBlocks = (...chars: number[]): Rec[] => chars.map((n) => text('o'.repeat(n)));

export function usage(u: UsageSpec = {}): Rec {
  const o: Rec = {
    input_tokens: u.input ?? 0,
    cache_creation_input_tokens: u.cacheWrite ?? 0,
    cache_read_input_tokens: u.cacheRead ?? 0,
    output_tokens: u.output ?? 0,
  };
  if (u.cacheWrite5m !== undefined || u.cacheWrite1h !== undefined)
    o.cache_creation = {
      ephemeral_5m_input_tokens: u.cacheWrite5m ?? 0,
      ephemeral_1h_input_tokens: u.cacheWrite1h ?? 0,
    };
  o.service_tier = 'standard';
  return o;
}

/** '30s', '6m', '2h', '500ms' or a number of ms. */
export function ms(d: string | number): number {
  if (typeof d === 'number') return d;
  const m = /^(\d+)(ms|s|m|h)$/.exec(d);
  if (!m) throw new Error(`bad duration: ${d}`);
  return Number(m[1]) * { ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[m[2] as 'ms'];
}

function hash8(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0;
  return h.toString(16).padStart(8, '0');
}

export interface SessionOpts {
  id?: string;
  project?: string;
  cwd?: string;
  version?: string;
  model?: string;
  start?: string;
}

export interface AssistantSpec {
  usage?: UsageSpec;
  blocks?: Rec[];
  /** Raw message.content written on a single line (e.g. a string). Overrides blocks. */
  content?: unknown;
  msgId?: string;
  /** null omits requestId. */
  requestId?: string | null;
  model?: string;
  /** output_tokens per block line (older-version style partial usage); default: all equal. */
  lineOutputs?: number[];
  sidechain?: boolean;
  /** Extra envelope fields, e.g. { isApiErrorMessage: true }. */
  envelope?: Rec;
  stopReason?: string;
}

export interface ToolResultSpec {
  chars?: number;
  content?: unknown;
  isError?: boolean;
  toolUseId?: string;
  /** Extra envelope fields, e.g. { toolUseResult: { agentId } }. */
  envelope?: Rec;
}

export class SessionBuilder {
  readonly id: string;
  readonly lines: string[] = [];
  /** Path relative to the projects root. */
  relPath: string;
  private readonly h: string;
  private n = 0;
  private clock: number;
  private parent: string | null = null;
  private pending: string[] = [];
  private sidechain = false;
  private agentId?: string;
  private readonly extra = new Map<string, string>();

  constructor(
    readonly name: string,
    private readonly o: SessionOpts & {
      project: string;
      cwd: string;
      version: string;
      model: string;
    },
  ) {
    this.h = hash8(name);
    this.id = o.id ?? `${this.h}-0000-4000-8000-000000000000`;
    this.clock = Date.parse(o.start ?? '2026-10-01T09:00:00.000Z');
    this.relPath = join(o.project, `${this.id}.jsonl`);
  }

  private seq(): string {
    return (++this.n).toString(16).padStart(12, '0');
  }

  private envelope(type: string, extra: Rec): Rec {
    const uuid = `${this.h}-0000-4000-8000-${this.seq()}`;
    const e: Rec = {
      parentUuid: this.parent,
      isSidechain: this.sidechain,
      userType: 'external',
      cwd: this.o.cwd,
      sessionId: this.id,
      version: this.o.version,
      gitBranch: 'main',
      ...(this.agentId !== undefined ? { agentId: this.agentId } : {}),
      type,
      ...extra,
      uuid,
      timestamp: new Date(this.clock).toISOString(),
    };
    this.parent = uuid;
    return e;
  }

  /** A record with the standard envelope, e.g. record('system', { subtype: 'compact_boundary' }). */
  record(type: string, fields: Rec = {}): this {
    this.lines.push(JSON.stringify(this.envelope(type, fields)));
    this.clock += 1000;
    return this;
  }

  /** A record written as-is, without envelope or clock tick (metadata records). */
  meta(obj: Rec): this {
    this.lines.push(JSON.stringify(obj));
    return this;
  }

  raw(line: string): this {
    this.lines.push(line);
    return this;
  }

  prompt(content: string | Rec[], envelope: Rec = {}): this {
    return this.record('user', { message: { role: 'user', content }, ...envelope });
  }

  attachment(attachment: Rec): this {
    return this.record('attachment', { attachment });
  }

  assistant(spec: AssistantSpec = {}): this {
    const k = this.seq();
    const msgId = spec.msgId ?? `msg_${this.h}${k}`;
    const requestId = spec.requestId === null ? undefined : (spec.requestId ?? `req_${this.h}${k}`);
    const blocks = (spec.blocks ?? [text('ok')]).map((b) =>
      b.type === 'tool_use' && b.id === undefined
        ? { ...b, id: `toolu_${this.h}${this.seq()}` }
        : b,
    );
    this.pending = blocks.filter((b) => b.type === 'tool_use').map((b) => b.id as string);
    const contents = spec.content !== undefined ? [spec.content] : blocks.map((b) => [b]);
    const stop = spec.stopReason ?? (this.pending.length > 0 ? 'tool_use' : 'end_turn');
    contents.forEach((content, i) => {
      const message = {
        id: msgId,
        type: 'message',
        role: 'assistant',
        model: spec.model ?? this.o.model,
        content,
        stop_reason: i === contents.length - 1 ? stop : null,
        stop_sequence: null,
        usage: usage({ ...spec.usage, output: spec.lineOutputs?.[i] ?? spec.usage?.output }),
      };
      const extra: Rec = { message, ...(requestId !== undefined ? { requestId } : {}) };
      if (spec.sidechain !== undefined) extra.isSidechain = spec.sidechain;
      this.lines.push(JSON.stringify(this.envelope('assistant', { ...extra, ...spec.envelope })));
    });
    this.clock += 1000;
    return this;
  }

  /** A user line with one tool_result, answering the next tool_use of the latest response. */
  toolResult(spec: number | ToolResultSpec): this {
    const s = typeof spec === 'number' ? { chars: spec } : spec;
    const block: Rec = {
      tool_use_id: s.toolUseId ?? this.pending.shift() ?? 'toolu_orphan',
      type: 'tool_result',
      content: s.content ?? 'o'.repeat(s.chars ?? 0),
    };
    if (s.isError !== undefined) block.is_error = s.isError;
    return this.record('user', { message: { role: 'user', content: [block] }, ...s.envelope });
  }

  gap(d: string | number): this {
    this.clock += ms(d);
    return this;
  }

  version(v: string): this {
    this.o.version = v;
    return this;
  }

  model(m: string): this {
    this.o.model = m;
    return this;
  }

  /** Continue this session's clock from another builder's (e.g. after a subagent finished). */
  sync(other: SessionBuilder): this {
    this.clock = Math.max(this.clock, other.clock);
    return this;
  }

  /**
   * A subagent transcript sharing this sessionId, with isSidechain and agentId set. Written to
   * `{sessionId}/subagents/agent-<id>.jsonl`, or `agent-<id>.jsonl` next to the parent if flat.
   */
  agent(agentId: string, opts: { flat?: boolean; meta?: Rec; prefix?: Rec } = {}): SessionBuilder {
    const a = new SessionBuilder(`${this.name}/${agentId}`, { ...this.o, id: this.id });
    a.clock = this.clock;
    a.sidechain = true;
    a.agentId = agentId;
    a.relPath = opts.flat
      ? join(this.o.project, `agent-${agentId}.jsonl`)
      : join(this.o.project, this.id, 'subagents', `agent-${agentId}.jsonl`);
    const stem = a.relPath.slice(0, -'.jsonl'.length);
    if (opts.meta) a.sideFile(`${stem}.meta.json`, `${JSON.stringify(opts.meta)}\n`);
    if (opts.prefix) a.sideFile(`${stem}.prefix.json`, `${JSON.stringify(opts.prefix)}\n`);
    return a;
  }

  /** Path relative to the projects root, inside this session's `{sessionId}/` dir. */
  sessionPath(...parts: string[]): string {
    return join(this.o.project, this.id, ...parts);
  }

  /** A non-JSONL file written next to the transcript (meta.json, tool-results/*.txt…). */
  sideFile(relPath: string, content: string): this {
    this.extra.set(relPath, content);
    return this;
  }

  toJsonl(): string {
    return `${this.lines.join('\n')}\n`;
  }

  /** Every file this builder writes: [path relative to the projects root, content]. */
  files(): [string, string][] {
    return [[this.relPath, this.toJsonl()], ...this.extra];
  }
}

export function session(name: string, o: SessionOpts = {}): SessionBuilder {
  return new SessionBuilder(name, {
    project: '-home-dev-app',
    cwd: '/home/dev/app',
    version: '2.1.302',
    model: 'claude-sonnet-4-5',
    ...o,
  });
}

/** Write builders as a projects tree under `root`. */
export function writeTree(root: string, builders: readonly SessionBuilder[]): void {
  for (const b of builders)
    for (const [rel, content] of b.files()) {
      const p = join(root, rel);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, content);
    }
}

// ---- Committed fixtures (SPEC §7). Expected totals are written by hand in test/parser.test.ts.

const fx = (fixture: string, name: string, o: SessionOpts = {}): SessionBuilder =>
  session(`${fixture}/${name}`, {
    project: `-home-dev-${fixture}`,
    cwd: `/home/dev/${fixture}`,
    ...o,
  });

const plain = (name: string, turns: UsageSpec[], each?: (s: SessionBuilder, i: number) => void) => {
  const s = fx(name, 'main');
  turns.forEach((u, i) => {
    each?.(s, i);
    s.prompt(`prompt ${i + 1}`).assistant({ usage: u, blocks: [text(`reply ${i + 1}`)] });
  });
  return [s];
};

export const FIXTURES: Record<string, () => SessionBuilder[]> = {
  'minimal-single-turn': () => [
    fx('minimal-single-turn', 'main')
      .prompt('say hi')
      .assistant({
        usage: { input: 3, cacheWrite: 20000, cacheWrite5m: 20000, cacheWrite1h: 0, output: 12 },
        blocks: [text('hi')],
      }),
  ],

  'multi-block-same-msgid': () => [
    fx('multi-block-same-msgid', 'main')
      .prompt('run the tests')
      .assistant({
        usage: { input: 5, cacheWrite: 1000, cacheRead: 30000, output: 250 },
        lineOutputs: [3, 3, 250],
        blocks: [thinking(), text('Running.'), toolUse('Bash', { command: 'pnpm test' })],
      })
      .toolResult(120)
      .assistant({
        usage: { input: 2, cacheWrite: 500, cacheRead: 31000, output: 80 },
        blocks: [text('Reading.'), toolUse('Read', { file_path: '/home/dev/m/src/a.ts' })],
      })
      .toolResult(300)
      .assistant({
        usage: { input: 1, cacheWrite: 200, cacheRead: 31500, output: 40 },
        blocks: [text('Done.')],
      }),
  ],

  'sidechain-replay': () => {
    const p = fx('sidechain-replay', 'main');
    const task = toolUse(
      'Task',
      { description: 'explore', prompt: 'look around' },
      'toolu_task0001',
    );
    const replayed: AssistantSpec = {
      msgId: 'msg_replayed0001',
      requestId: 'req_replayed0001',
      usage: { input: 10, cacheWrite: 8000, output: 60 },
      blocks: [task],
    };
    p.prompt('explore the repo').assistant(replayed);
    const a = p
      .agent('r1', { flat: true })
      .prompt('look around')
      .assistant(replayed)
      .assistant({
        usage: { input: 4, cacheWrite: 3000, output: 30 },
        blocks: [toolUse('Glob', { pattern: '**/*.ts' })],
      })
      .toolResult(200)
      .assistant({
        usage: { input: 2, cacheWrite: 100, cacheRead: 3000, output: 25 },
        blocks: [text('found 3')],
      });
    p.sync(a)
      .toolResult(40)
      .assistant({
        usage: { input: 3, cacheWrite: 150, cacheRead: 8000, output: 20 },
        blocks: [text('ok')],
      });
    return [p, a];
  },

  'cross-session-copy': () => {
    const X: AssistantSpec = {
      msgId: 'msg_copyX',
      requestId: 'req_copyX',
      usage: { input: 10, cacheWrite: 5000, output: 100 },
      blocks: [thinking(), text('x')],
    };
    const Y: AssistantSpec = {
      msgId: 'msg_copyY',
      requestId: 'req_copyY',
      usage: { input: 4, cacheWrite: 300, cacheRead: 5000, output: 50 },
      blocks: [text('y')],
    };
    const a = fx('cross-session-copy', 'a', { id: 'aaaaaaaa-0000-4000-8000-000000000001' });
    a.prompt('first').assistant(X).prompt('second').assistant(Y);
    const b = fx('cross-session-copy', 'b', {
      id: 'bbbbbbbb-0000-4000-8000-000000000002',
      start: '2026-10-01T10:00:00.000Z',
    });
    b.prompt('first').assistant(X).prompt('second').assistant(Y).gap('1h').prompt('third');
    b.assistant({
      usage: { input: 2, cacheWrite: 100, cacheRead: 5300, output: 30 },
      blocks: [text('z')],
    });
    return [b, a];
  },

  'synthetic-error-turn': () => [
    fx('synthetic-error-turn', 'main')
      .prompt('hi')
      .assistant({
        model: '<synthetic>',
        requestId: null,
        blocks: [text('Not logged in · Please run /login')],
        envelope: { isApiErrorMessage: true, error: 'authentication_failed' },
      })
      .gap('2m')
      .prompt('hi again')
      .assistant({ usage: { input: 3, cacheWrite: 19000, output: 9 }, blocks: [text('hello')] }),
  ],

  'ttl-gap-rebuild': () =>
    plain(
      'ttl-gap-rebuild',
      [
        { input: 3, cacheWrite: 20000, output: 100 },
        { input: 2, cacheWrite: 500, cacheRead: 20000, output: 80 },
        { input: 3, cacheWrite: 20600, output: 90 },
      ],
      (s, i) => (i === 1 ? s.gap('30s') : i === 2 ? s.gap('6m') : s),
    ),

  'version-change-rebuild': () =>
    plain(
      'version-change-rebuild',
      [
        { input: 3, cacheWrite: 20000, output: 50 },
        { input: 2, cacheWrite: 400, cacheRead: 20000, output: 40 },
        { input: 3, cacheWrite: 21000, output: 45 },
      ],
      (s, i) => (i === 0 ? s.version('2.1.300') : i === 2 ? s.version('2.1.302') : s),
    ),

  'model-switch': () =>
    plain(
      'model-switch',
      [
        { input: 3, cacheWrite: 18000, output: 30 },
        { input: 2, cacheWrite: 300, cacheRead: 18000, output: 25 },
        { input: 3, cacheWrite: 18400, output: 60 },
      ],
      (s, i) => (i === 2 ? s.model('claude-opus-4-1') : s),
    ),

  'big-bash-output': () => [
    fx('big-bash-output', 'main')
      .prompt('run tests')
      .assistant({
        usage: { input: 3, cacheWrite: 2000, cacheRead: 15000, output: 40 },
        blocks: [toolUse('Bash', { command: 'pnpm test' })],
      })
      .toolResult(48000)
      .assistant({
        usage: { input: 2, cacheWrite: 12100, cacheRead: 17000, output: 35 },
        blocks: [toolUse('Bash', { command: 'pnpm build --verbose' })],
      })
      .toolResult({ content: textBlocks(30000, 2000), isError: true })
      .assistant({
        usage: { input: 2, cacheWrite: 8100, cacheRead: 29100, output: 20 },
        blocks: [text('Failed.')],
      }),
  ],

  'repeated-read-unchanged': () => {
    const s = fx('repeated-read-unchanged', 'main').prompt('look at client.ts three times');
    const file_path = '/home/dev/repeated-read-unchanged/src/api/client.ts';
    [0, 1, 2].forEach((i) =>
      s
        .assistant({
          usage: {
            input: 2,
            cacheWrite: i === 0 ? 3000 : 1100,
            cacheRead: 10000 + 1000 * i,
            output: 30,
          },
          blocks: [toolUse('Read', { file_path })],
        })
        .toolResult(4000),
    );
    return [s.assistant({ usage: { input: 1, cacheWrite: 1100, cacheRead: 13000, output: 15 } })];
  },

  'repeated-read-after-edit': () => {
    const file_path = '/home/dev/repeated-read-after-edit/src/api/client.ts';
    const s = fx('repeated-read-after-edit', 'main')
      .prompt('read, edit, read')
      .assistant({
        usage: { input: 2, cacheWrite: 3000, cacheRead: 10000, output: 30 },
        blocks: [toolUse('Read', { file_path })],
      })
      .toolResult(4000)
      .assistant({
        usage: { input: 2, cacheWrite: 1100, cacheRead: 13000, output: 90 },
        blocks: [toolUse('Edit', { file_path, old_string: 'a', new_string: 'b' })],
      })
      .toolResult(50)
      .assistant({
        usage: { input: 2, cacheWrite: 100, cacheRead: 14100, output: 30 },
        blocks: [toolUse('Read', { file_path })],
      })
      .toolResult(4100);
    return [s];
  },

  'malformed-lines': () => [
    fx('malformed-lines', 'main')
      .prompt('hello')
      .raw('{"type": "user", "message": {"role": "us')
      .raw('not json at all')
      .raw('[1,2,3]')
      .raw('"just a string"')
      .raw('null')
      .raw('42')
      .raw('')
      .raw('   ')
      .assistant({ usage: { input: 3, cacheWrite: 100, output: 5 }, blocks: [text('hi')] })
      .record('assistant', { message: 'not an object' })
      .record('assistant', {
        message: { id: 'msg_nousage', model: 'claude-sonnet-4-5', content: [text('x')] },
      }),
  ],

  'nested-subagents-dir': () => {
    const p = fx('nested-subagents-dir', 'main');
    p.prompt('do two things').assistant({
      usage: { input: 5, cacheWrite: 9000, output: 70 },
      blocks: [
        toolUse('Agent', { description: 'a', prompt: 'a' }, 'toolu_agent_n1'),
        toolUse('Agent', { description: 'b', prompt: 'b' }, 'toolu_agent_n2'),
      ],
    });
    // n1 is linked by its meta.json (CC 2.1.302 layout); n2 only by the parent's toolUseResult.
    const n1 = p
      .agent('n1', {
        meta: { agentType: 'general-purpose', description: 'a', toolUseId: 'toolu_agent_n1' },
        prefix: { v: 1, by: 'synthetic', state: {}, outlines: [] },
      })
      .prompt('a')
      .assistant({
        usage: { input: 3, cacheWrite: 4000, output: 20 },
        blocks: [toolUse('Grep', { pattern: 'TODO' })],
      })
      .toolResult(900)
      .assistant({
        usage: { input: 2, cacheWrite: 300, cacheRead: 4000, output: 15 },
        blocks: [text('3 TODOs')],
      });
    const n2 = p
      .agent('n2')
      .prompt('b')
      .assistant({ usage: { input: 3, cacheWrite: 4100, output: 12 }, blocks: [text('nothing')] });
    p.sync(n1)
      .toolResult(7)
      .toolResult({
        chars: 7,
        envelope: { toolUseResult: { isAsync: false, status: 'completed', agentId: 'n2' } },
      })
      .assistant({
        usage: { input: 4, cacheWrite: 200, cacheRead: 9000, output: 30 },
        blocks: [text('both done')],
      });
    return [p, n1, n2];
  },

  'persisted-tool-output': () => {
    const s = fx('persisted-tool-output', 'main');
    const id = 'toolu_persisted0001';
    // POSIX path inside the content, so the fixture is byte-identical on every OS.
    const saved = `/home/dev/.claude/projects/-home-dev-persisted-tool-output/${s.id}/tool-results/${id}.txt`;
    const preview =
      `<persisted-output>\nOutput too large (36.4KB). Full output saved to: ${saved}\n\n` +
      `Preview (first 2KB):\n${'o'.repeat(2048)}\n</persisted-output>`;
    s.prompt('run the full suite')
      .assistant({
        usage: { input: 3, cacheWrite: 2000, cacheRead: 15000, output: 40 },
        blocks: [toolUse('Bash', { command: 'pnpm test' }, id)],
      })
      .toolResult({ content: preview })
      .assistant({
        usage: { input: 2, cacheWrite: 700, cacheRead: 17000, output: 30 },
        blocks: [toolUse('Bash', { command: 'pnpm lint' })],
      })
      .toolResult(300)
      .assistant({ usage: { input: 1, cacheWrite: 100, cacheRead: 17700, output: 20 } })
      .sideFile(s.sessionPath('tool-results', `${id}.txt`), 'o'.repeat(37277));
    return [s];
  },

  'unknown-record-types': () => {
    const s = fx('unknown-record-types', 'main');
    s.meta({
      type: 'queue-operation',
      operation: 'enqueue',
      timestamp: '2026-10-01T08:59:59.000Z',
      sessionId: s.id,
    })
      .attachment({
        type: 'instructions',
        files: [
          {
            path: '/home/dev/unknown-record-types/CLAUDE.md',
            type: 'Project',
            content: '# Rules\nUse pnpm.\n',
          },
        ],
      })
      .attachment({
        type: 'prompt_snapshot',
        systemPrompt: ['You are Claude Code.', { type: 'text', text: 'Be brief.' }],
        tools: [{ name: 'Bash' }, { name: 'Read', description: 'Read a file' }],
      })
      .prompt('go')
      .attachment({ type: 'total_tokens_reminder' })
      .attachment({ type: 'total_tokens_reminder' })
      .assistant({ usage: { input: 3, cacheWrite: 15000, output: 20 }, blocks: [text('going')] })
      .meta({ type: 'ai-title', aiTitle: 'Synthetic title', sessionId: s.id })
      .meta({ type: 'last-prompt', leafUuid: 'leaf', sessionId: s.id })
      .meta({ type: 'atis-latch', atis: 1, sessionId: s.id })
      .meta({ type: 'cost-state', totalCostUSD: 0.01, sessionId: s.id })
      .record('system', { subtype: 'compact_boundary', content: 'Conversation compacted' })
      .prompt('This session is being continued from a previous conversation.', {
        isCompactSummary: true,
      })
      .meta({ type: 'summary', summary: 'Synthetic summary', leafUuid: 'leaf' })
      .record('future-thing', { data: 1 })
      .record('future-thing', { data: 2 })
      .meta({ type: 'mystery' })
      .meta({ noType: true })
      .prompt('after compaction')
      .assistant({
        usage: { input: 2, cacheWrite: 6000, output: 25 },
        blocks: [text('continuing')],
      });
    return [s];
  },

  'string-vs-array-content': () => [
    fx('string-vs-array-content', 'main')
      .prompt('hello there')
      .prompt([text('abc'), text('defgh')])
      .assistant({
        usage: { input: 3, cacheWrite: 500, output: 10 },
        content: 'plain string reply',
      })
      .assistant({
        usage: { input: 2, cacheWrite: 100, cacheRead: 500, output: 20 },
        blocks: [
          toolUse('Bash', { command: 'ls' }),
          toolUse('Read', { file_path: '/home/dev/s/a.md' }),
        ],
      })
      .toolResult(100)
      .toolResult({
        content: [
          text('x'.repeat(50)),
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
        ],
      })
      .assistant({
        usage: { input: 2, cacheWrite: 200, cacheRead: 600, output: 15 },
        blocks: [text('done')],
      }),
  ],
};

export const FIXTURES_DIR = resolve(import.meta.dirname, '..', 'test', 'fixtures', 'projects');

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  for (const [name, build] of Object.entries(FIXTURES)) {
    const dir = join(FIXTURES_DIR, name);
    rmSync(dir, { recursive: true, force: true });
    writeTree(dir, build());
  }
  process.stdout.write(`wrote ${Object.keys(FIXTURES).length} fixtures to ${FIXTURES_DIR}\n`);
}
