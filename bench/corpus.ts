// Deterministic synthetic corpus for benchmarks (SPEC §8). All content is synthetic.
//
//   tsx bench/corpus.ts --size 10mb|100mb|1gb [--dir DIR] [--seed N]
//
// Writes a projects tree to DIR/projects (default bench/out/corpus-<size>/, gitignored) and a
// manifest to DIR/manifest.json. Records come from the M1 fixture DSL (scripts/make-fixture.ts),
// so the envelope and block layout match what the parser is tested against: one line per content
// block, tool_use/tool_result pairs, subagents under {sessionId}/subagents/ with a meta.json, a
// few malformed lines. Lines are flushed to disk after every assistant step, so memory stays flat
// whatever the size. Same seed and size → byte-identical files.

import { once } from 'node:events';
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
  type WriteStream,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import {
  session,
  text,
  thinking,
  toolUse,
  type SessionBuilder,
  type ToolResultSpec,
} from '../scripts/make-fixture.js';

/** Bump when the output for a given seed and size changes (invalidates cached corpora). */
export const GENERATOR_VERSION = 1;
export const DEFAULT_SEED = 0x5eed;
export const OUT_DIR = resolve(import.meta.dirname, 'out');

export interface CorpusSummary {
  generatorVersion: number;
  seed: number;
  targetBytes: number;
  /** Bytes of *.jsonl written (what the parser reads; ParseStats.bytes should match). */
  bytes: number;
  /** *.jsonl files (main sessions + subagents). */
  files: number;
  lines: number;
  malformedLines: number;
  projects: number;
  sessions: number;
  subagents: number;
  assistantResponses: number;
  toolResults: number;
  /** prompt_snapshot attachments (~100 KB each). */
  largeAttachments: number;
}

/** '200kb', '10mb', '1gb' (decimal units: 1 MB = 10^6 bytes). */
export function parseSize(s: string): number {
  const m = /^(\d+(?:\.\d+)?)\s*(kb|mb|gb)$/i.exec(s.trim());
  if (!m) throw new Error(`bad size: ${s} (expected e.g. 200kb, 10mb, 1gb)`);
  const unit = { kb: 1e3, mb: 1e6, gb: 1e9 }[m[2]!.toLowerCase() as 'kb' | 'mb' | 'gb'];
  return Math.round(Number(m[1]) * unit);
}

/** mulberry32: small, fast, good enough for synthetic data. */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORDS = (
  'const let function return if else for while import export from await async type interface ' +
  'string number boolean null undefined true false new class extends this map filter reduce ' +
  'error result value config options session token cache read write file path test expect it ' +
  'describe parse stream line record usage input output model tool assistant user message ' +
  'the a to of and in is that for with on as be by not or are this at have from'
).split(' ');
const PUNCT = ['', '', '', '', ',', '.', ';', '()', '{', '}', '"x"', ' =', ' =>', ':'];
const TOOLS = ['Read', 'Bash', 'Grep', 'Edit', 'Glob', 'Write', 'Read', 'Bash', 'Read'];
const MODELS = ['claude-sonnet-4-5', 'claude-sonnet-4-5', 'claude-opus-4-1'];
const VERSIONS = ['2.1.300', '2.1.302', '2.1.302'];
const BASE_TS = Date.parse('2026-09-01T00:00:00.000Z');

/** Appends to one *.jsonl file, flushing the builder's lines and honoring backpressure. */
class Sink {
  private readonly ws: WriteStream;
  bytes = 0;
  lines = 0;
  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.ws = createWriteStream(path);
  }
  async flush(b: SessionBuilder): Promise<void> {
    const ls = b.lines.splice(0);
    if (ls.length === 0) return;
    const s = `${ls.join('\n')}\n`;
    this.bytes += Buffer.byteLength(s);
    this.lines += ls.length;
    if (!this.ws.write(s)) await once(this.ws, 'drain');
  }
  async close(): Promise<void> {
    this.ws.end();
    await once(this.ws, 'finish');
  }
}

class Generator {
  private readonly r: () => number;
  private readonly pool: string;
  private ids = 0;
  readonly sum: CorpusSummary;
  private readonly projects: { dir: string; cwd: string }[];

  constructor(
    private readonly root: string,
    targetBytes: number,
    seed: number,
  ) {
    this.r = prng(seed);
    const words: string[] = [];
    for (let n = 0; n < 512 * 1024;) {
      const w = this.pick(WORDS) + this.pick(PUNCT);
      const sep = this.chance(0.08) ? `\n${'  '.repeat(this.int(0, 3))}` : ' ';
      words.push(w, sep);
      n += w.length + sep.length;
    }
    this.pool = words.join('');
    const nProjects = Math.min(200, Math.max(2, Math.round(targetBytes / 5e6)));
    this.projects = Array.from({ length: nProjects }, (_, i) => {
      const name = `proj-${String(i).padStart(3, '0')}`;
      return { dir: `-home-dev-${name}`, cwd: `/home/dev/${name}` };
    });
    this.sum = {
      generatorVersion: GENERATOR_VERSION,
      seed,
      targetBytes,
      bytes: 0,
      files: 0,
      lines: 0,
      malformedLines: 0,
      projects: 0,
      sessions: 0,
      subagents: 0,
      assistantResponses: 0,
      toolResults: 0,
      largeAttachments: 0,
    };
  }

  // ---- random helpers
  private chance(p: number): boolean {
    return this.r() < p;
  }
  private int(lo: number, hi: number): number {
    return lo + Math.floor(this.r() * (hi - lo + 1));
  }
  private pick<T>(xs: readonly T[]): T {
    return xs[Math.floor(this.r() * xs.length)]!;
  }
  private logUniform(lo: number, hi: number): number {
    return Math.round(lo * Math.exp(this.r() * Math.log(hi / lo)));
  }
  private normal(): number {
    return Math.sqrt(-2 * Math.log(1 - this.r())) * Math.cos(2 * Math.PI * this.r());
  }
  private hex(n: number): string {
    let s = '';
    while (s.length < n)
      s += Math.floor(this.r() * 0x10000)
        .toString(16)
        .padStart(4, '0');
    return s.slice(0, n);
  }
  private uuid(): string {
    return `${this.hex(8)}-${this.hex(4)}-4${this.hex(3)}-8${this.hex(3)}-${this.hex(12)}`;
  }
  private txt(n: number): string {
    const start = this.int(0, this.pool.length - n - 1);
    return this.pool.slice(start, start + n);
  }
  private id(prefix: string): string {
    return `${prefix}_bench${(++this.ids).toString(36).padStart(8, '0')}`;
  }

  /** Mostly < 2 KB, ~17% 2–10 KB, ~3% 10–30 KB. */
  private resultChars(): number {
    const u = this.r();
    if (u < 0.8) return this.int(40, 2000);
    if (u < 0.97) return this.logUniform(2000, 10_000);
    return this.logUniform(10_000, 30_000);
  }

  private toolInput(name: string, cwd: string): Record<string, unknown> {
    const file_path = `${cwd}/src/${this.pick(WORDS)}/${this.pick(WORDS)}.ts`;
    switch (name) {
      case 'Bash':
        return { command: `pnpm ${this.pick(['test', 'lint', 'build', 'typecheck'])}` };
      case 'Grep':
        return { pattern: this.pick(WORDS), path: `${cwd}/src` };
      case 'Glob':
        return { pattern: `src/**/*.${this.pick(['ts', 'tsx', 'json'])}` };
      case 'Edit':
        return {
          file_path,
          old_string: this.txt(this.int(20, 1500)),
          new_string: this.txt(this.int(20, 1500)),
        };
      case 'Write':
        return { file_path, content: this.txt(this.int(300, 6000)) };
      default:
        return { file_path };
    }
  }

  /** ~100 KB, shaped like the [M] 2.1.302 prompt_snapshot (15 system parts, 64 tools). */
  private promptSnapshot(): Record<string, unknown> {
    return {
      type: 'prompt_snapshot',
      systemPrompt: Array.from({ length: 15 }, (_, i) =>
        i % 3 === 0 ? { type: 'text', text: this.txt(2000) } : this.txt(2000),
      ),
      tools: Array.from({ length: 64 }, (_, i) => {
        const name = `tool_${i}`;
        const description = this.txt(this.int(300, 1500));
        return {
          name,
          description,
          schema: {
            name,
            description,
            input_schema: { type: 'object', properties: { arg: { type: 'string' } } },
          },
        };
      }),
    };
  }

  private toolResult(): ToolResultSpec {
    if (this.chance(0.005)) {
      const kb = (this.int(30_000, 200_000) / 1024).toFixed(1);
      return {
        content:
          `<persisted-output>\nOutput too large (${kb}KB). Full output saved to: ` +
          `/home/dev/.claude/projects/x/tool-results/${this.hex(12)}.txt\n\n` +
          `Preview (first 2KB):\n${this.txt(2048)}\n</persisted-output>`,
      };
    }
    return {
      content: this.txt(this.resultChars()),
      ...(this.chance(0.03) ? { isError: true } : {}),
    };
  }

  async run(): Promise<CorpusSummary> {
    const usedProjects = new Set<number>();
    for (let idx = 0; this.sum.bytes < this.sum.targetBytes; idx++) {
      const p = Math.floor(this.projects.length * this.r() ** 2);
      usedProjects.add(p);
      await this.session(idx, this.projects[p]!);
    }
    this.sum.projects = usedProjects.size;
    return this.sum;
  }

  private async session(idx: number, proj: { dir: string; cwd: string }): Promise<void> {
    const target = this.sum.targetBytes;
    const cap = Math.min(8e6, Math.max(30_000, target / 4));
    const sessionTarget = Math.min(cap, Math.max(15_000, 400_000 * Math.exp(this.normal())));
    const b = session(`bench/${idx}`, {
      id: this.uuid(),
      project: proj.dir,
      cwd: proj.cwd,
      version: this.pick(VERSIONS),
      model: this.pick(MODELS),
      start: new Date(BASE_TS + Math.floor(this.r() * 30 * 86_400_000)).toISOString(),
    });
    const sink = new Sink(join(this.root, b.relPath));
    this.sum.sessions++;
    b.attachment({
      type: 'instructions',
      files: [
        { path: `${proj.cwd}/CLAUDE.md`, type: 'Project', content: this.txt(this.int(500, 3000)) },
      ],
    });
    if (sessionTarget >= 250_000 && this.chance(0.15)) {
      b.attachment(this.promptSnapshot());
      this.sum.largeAttachments++;
    }
    const ctx = { tokens: this.int(12_000, 30_000), added: 0, lastOutput: 0 };
    for (let p = 0; sink.bytes < sessionTarget && this.sum.bytes + sink.bytes < target; p++) {
      let rebuild = false;
      if (p > 0) {
        const gapMs = this.chance(0.08) ? this.int(6, 90) * 60_000 : this.int(5, 120) * 1000;
        b.gap(gapMs);
        rebuild = gapMs > 5 * 60_000;
      }
      const prompt = this.txt(this.int(20, 400));
      b.prompt(prompt);
      ctx.added += prompt.length;
      // Malformed lines (counted and skipped by the parser): session 0 always has one.
      if (p === 0 && idx % 20 === 0) {
        b.raw('{"type":"assistant","message":{"id":"msg_truncat');
        this.sum.malformedLines++;
      }
      if (p === 0 && idx % 40 === 0) {
        b.raw('<<< not json >>>');
        this.sum.malformedLines++;
      }
      if (this.chance(0.3)) b.attachment({ type: 'total_tokens_reminder' });
      const steps = this.int(1, 8);
      for (let s = 0; s <= steps; s++) {
        const last = s === steps;
        const spawn = !last && ((idx % 5 === 0 && p === 0 && s === 0) || this.chance(0.01));
        const blocks: Record<string, unknown>[] = [];
        if (this.chance(0.4)) blocks.push(thinking(this.int(200, 2000)));
        if (last || this.chance(0.7)) blocks.push(text(this.txt(this.int(50, 600))));
        const nTools = last ? 0 : spawn ? 1 : this.pick([1, 1, 1, 1, 1, 1, 1, 2, 2, 3]);
        const agentToolId = this.id('toolu');
        if (spawn) {
          const input = { description: 'explore', prompt: this.txt(this.int(100, 800)) };
          blocks.push(toolUse('Agent', input, agentToolId));
        } else
          for (let t = 0; t < nTools; t++) {
            const name = this.pick(TOOLS);
            blocks.push(toolUse(name, this.toolInput(name, proj.cwd), this.id('toolu')));
          }
        this.assistant(b, blocks, ctx, rebuild && s === 0);
        if (spawn) await this.subagent(b, agentToolId);
        else
          for (let t = 0; t < nTools; t++) {
            const spec = this.toolResult();
            b.toolResult(spec);
            ctx.added += typeof spec.content === 'string' ? spec.content.length : 0;
            this.sum.toolResults++;
          }
        await sink.flush(b);
      }
    }
    await sink.flush(b);
    await sink.close();
    this.account(sink);
  }

  private assistant(
    b: SessionBuilder,
    blocks: Record<string, unknown>[],
    ctx: { tokens: number; added: number; lastOutput: number },
    rebuild: boolean,
  ): void {
    const fresh = Math.ceil(ctx.added / 4) + ctx.lastOutput + this.int(0, 200);
    const cacheWrite = rebuild ? ctx.tokens + fresh : fresh;
    const output = this.int(20, 900);
    b.assistant({
      msgId: this.id('msg'),
      requestId: this.id('req'),
      blocks,
      usage: {
        input: this.int(1, 6),
        cacheRead: rebuild ? 0 : ctx.tokens,
        cacheWrite,
        cacheWrite5m: cacheWrite,
        cacheWrite1h: 0,
        output,
      },
    });
    ctx.tokens += fresh;
    ctx.added = 0;
    ctx.lastOutput = output;
    this.sum.assistantResponses++;
  }

  /** A subagent transcript in {sessionId}/subagents/, linked by meta.json and toolUseResult. */
  private async subagent(parent: SessionBuilder, toolUseId: string): Promise<void> {
    const agentId = `a${this.hex(16)}`;
    const a = parent.agent(agentId);
    const sink = new Sink(join(this.root, a.relPath));
    writeFileSync(
      join(this.root, a.relPath.replace(/\.jsonl$/, '.meta.json')),
      `${JSON.stringify({ agentType: 'general-purpose', description: 'explore', toolUseId })}\n`,
    );
    a.prompt(this.txt(this.int(100, 800)));
    const ctx = { tokens: this.int(8000, 15_000), added: 0, lastOutput: 0 };
    const steps = this.int(2, 6);
    for (let s = 0; s <= steps; s++) {
      const last = s === steps;
      const blocks = [text(this.txt(this.int(30, 300)))];
      if (!last)
        blocks.push(toolUse(this.pick(TOOLS), { pattern: this.pick(WORDS) }, this.id('toolu')));
      this.assistant(a, blocks, ctx, false);
      if (!last) {
        const spec = this.toolResult();
        a.toolResult(spec);
        this.sum.toolResults++;
      }
      await sink.flush(a);
    }
    await sink.close();
    this.account(sink);
    this.sum.subagents++;
    parent.sync(a).toolResult({
      content: this.txt(this.int(200, 2000)),
      envelope: { toolUseResult: { isAsync: false, status: 'completed', agentId } },
    });
    this.sum.toolResults++;
  }

  private account(sink: Sink): void {
    this.sum.bytes += sink.bytes;
    this.sum.lines += sink.lines;
    this.sum.files++;
  }
}

/** Generate a projects tree under `root` (created; must not already hold a corpus). */
export async function generateCorpus(opts: {
  root: string;
  targetBytes: number;
  seed?: number;
}): Promise<CorpusSummary> {
  return new Generator(opts.root, opts.targetBytes, opts.seed ?? DEFAULT_SEED).run();
}

export interface CorpusInfo {
  /** Projects root to pass to loadSessions / `--root`. */
  root: string;
  dir: string;
  summary: CorpusSummary;
  reused: boolean;
  genMs: number;
}

/**
 * Generate DIR/projects and DIR/manifest.json, or reuse them when the manifest matches. Refuses
 * to delete a non-empty DIR that has no manifest (it is not ours).
 */
export async function ensureCorpus(
  dir: string,
  targetBytes: number,
  seed = DEFAULT_SEED,
): Promise<CorpusInfo> {
  const root = join(dir, 'projects');
  const manifest = join(dir, 'manifest.json');
  if (existsSync(manifest) && existsSync(root)) {
    try {
      const m = JSON.parse(readFileSync(manifest, 'utf8')) as CorpusSummary;
      if (
        m.generatorVersion === GENERATOR_VERSION &&
        m.seed === seed &&
        m.targetBytes === targetBytes
      )
        return { root, dir, summary: m, reused: true, genMs: 0 };
    } catch {
      // regenerate below
    }
  }
  if (existsSync(dir) && readdirSync(dir).length > 0 && !existsSync(manifest))
    throw new Error(`refusing to overwrite ${dir}: not empty and has no manifest.json`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  const t0 = performance.now();
  const summary = await generateCorpus({ root, targetBytes, seed });
  const genMs = performance.now() - t0;
  writeFileSync(manifest, `${JSON.stringify(summary, null, 2)}\n`);
  return { root, dir, summary, reused: false, genMs };
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseArgs({
    options: { size: { type: 'string' }, dir: { type: 'string' }, seed: { type: 'string' } },
  });
  if (values.size === undefined) {
    process.stderr.write(
      'usage: tsx bench/corpus.ts --size 10mb|100mb|1gb [--dir DIR] [--seed N]\n',
    );
    process.exit(2);
  }
  const dir = resolve(values.dir ?? join(OUT_DIR, `corpus-${values.size.toLowerCase()}`));
  const seed = values.seed !== undefined ? Number(values.seed) : DEFAULT_SEED;
  const info = await ensureCorpus(dir, parseSize(values.size), seed);
  process.stdout.write(
    `${JSON.stringify({ root: info.root, reused: info.reused, genMs: Math.round(info.genMs), ...info.summary }, null, 2)}\n`,
  );
}
