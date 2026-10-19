// Synthetic corpus for the README demo GIF (docs/demo.tape) and screenshot (docs/report.png).
//
//   tsx scripts/demo-corpus.ts <dir>
//
// Writes <dir>/.claude/projects/..., so `HOME=<dir> tknxray` reads it through the default
// discovery and nothing real is touched. Everything is synthetic: made-up projects, file names,
// commands and usage numbers, built with the fixture DSL (scripts/make-fixture.ts). The numbers
// are chosen so most analyzers have something to show; they say nothing about real usage.
// Dates are fixed (2026-10-12 to 2026-10-16), so run tknxray with `--since 2026-10-12`.

import { mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  session,
  text,
  toolUse,
  writeTree,
  type SessionBuilder,
  type SessionOpts,
} from './make-fixture.js';

const desc = (n: number): string => 'd'.repeat(n);

/** Tool definitions logged in a prompt_snapshot attachment (sizes only matter). */
function tools(): Record<string, unknown>[] {
  const builtin = ['Bash', 'Read', 'Edit', 'Write', 'Grep', 'Glob', 'Agent'].map((name, i) => ({
    name,
    description: desc(3000 + i * 400),
    input_schema: { type: 'object' },
  }));
  const mcp = [
    'mcp__github__create_issue',
    'mcp__github__list_pull_requests',
    'mcp__github__get_file_contents',
    'mcp__github__search_code',
    'mcp__tracker__create_ticket',
    'mcp__tracker__list_tickets',
    'mcp__tracker__update_ticket',
  ].map((name, i) => ({
    name,
    description: desc(1800 + i * 250),
    input_schema: { type: 'object' },
  }));
  return [...builtin, ...mcp];
}

const API = { project: '-home-dev-acme-api', cwd: '/home/dev/acme-api' };
const WEB = { project: '-home-dev-webapp', cwd: '/home/dev/webapp' };

function start(name: string, o: SessionOpts, baseline: number): SessionBuilder {
  return session(name, { model: 'claude-sonnet-4-5', ...o })
    .attachment({ type: 'prompt_snapshot', systemPrompt: ['s'.repeat(6000)], tools: tools() })
    .prompt('synthetic prompt')
    .assistant({
      usage: {
        input: 4,
        cacheWrite: baseline,
        cacheWrite5m: baseline,
        cacheWrite1h: 0,
        output: 90,
      },
      blocks: [toolUse('Grep', { pattern: 'TODO', path: 'src' })],
    })
    .toolResult(1200);
}

/** A run of ordinary turns: the cache grows by `step` per turn and is read back. */
function work(s: SessionBuilder, ctx: number, turns: number, step = 1500): number {
  for (let i = 0; i < turns; i++) {
    s.gap(`${20 + ((i * 37) % 70)}s`)
      .assistant({
        usage: { input: 3, cacheWrite: step, cacheRead: ctx, output: 120 },
        blocks: [toolUse('Glob', { pattern: `src/**/*.ts` })],
      })
      .toolResult(600);
    ctx += step;
  }
  return ctx;
}

export function demoSessions(): SessionBuilder[] {
  const out: SessionBuilder[] = [];

  // 1. acme-api on 2.1.300: big test output, repeated reads, a TTL rebuild, a subagent.
  const a = start(
    'demo/api-1',
    { ...API, version: '2.1.300', start: '2026-10-12T09:00:00.000Z' },
    19_200,
  );
  let ctx = work(a, 20_400, 3);
  for (let i = 0; i < 2; i++) {
    a.gap('95s')
      .assistant({
        usage: { input: 3, cacheWrite: 900, cacheRead: ctx, output: 60 },
        blocks: [toolUse('Bash', { command: 'pnpm test' })],
      })
      .toolResult(46_000);
    ctx += 12_400;
  }
  for (let i = 0; i < 3; i++) {
    a.gap('48s')
      .assistant({
        usage: { input: 3, cacheWrite: i === 0 ? 3200 : 3100, cacheRead: ctx, output: 50 },
        blocks: [toolUse('Read', { file_path: '/home/dev/acme-api/src/api/client.ts' })],
      })
      .toolResult(12_000);
    ctx += 3200;
  }
  a.gap('14m')
    .prompt('synthetic prompt')
    .assistant({
      usage: { input: 5, cacheWrite: ctx, cacheRead: 0, output: 80 },
      blocks: [toolUse('Agent', { description: 'explore', prompt: 'p' }, 'toolu_demo_agent1')],
    });
  const sub = a
    .agent('d1', {
      meta: { agentType: 'Explore', description: 'explore', toolUseId: 'toolu_demo_agent1' },
    })
    .prompt('explore')
    .assistant({
      usage: { input: 6, cacheWrite: 14_000, output: 200 },
      blocks: [toolUse('Grep', { pattern: 'handler' })],
    })
    .toolResult(3000)
    .assistant({
      usage: { input: 4, cacheWrite: 900, cacheRead: 14_000, output: 400 },
      blocks: [text('found it')],
    });
  a.sync(sub).toolResult(400);
  work(a, ctx, 4);
  out.push(a, sub);

  // 2-3. Two more 2.1.300 sessions (A4 compares a version's median after 3 sessions).
  for (const [i, day] of [
    [2, '2026-10-13'],
    [3, '2026-10-13'],
  ] as const) {
    const s = start(
      `demo/api-${i}`,
      { ...API, version: '2.1.300', start: `${day}T1${i}:00:00.000Z` },
      19_000 + i * 150,
    );
    work(s, 20_300, 5);
    out.push(s);
  }

  // 4-6. Sessions after an upgrade to 2.1.302: the first turn is bigger (A4), and one session
  // rebuilds right after the upgrade (A3 cause: version change).
  for (const [i, day] of [
    [4, '2026-10-14'],
    [5, '2026-10-15'],
    [6, '2026-10-15'],
  ] as const) {
    const s = start(
      `demo/api-${i}`,
      { ...API, version: '2.1.302', start: `${day}T0${i}:00:00.000Z` },
      23_400 + i * 100,
    );
    out.push(s);
    let c = work(s, 24_000, 6);
    if (i === 4) {
      s.version('2.1.303').prompt('synthetic prompt');
      s.assistant({
        usage: { input: 4, cacheWrite: c, cacheRead: 0, output: 70 },
        blocks: [text('ok')],
      });
      c = work(s, c, 2);
    }
  }

  // 7. webapp: an API error, a failed tool call repeated as is, and a long session (A8).
  const w = start(
    'demo/web-1',
    { ...WEB, version: '2.1.302', start: '2026-10-16T10:00:00.000Z' },
    23_800,
  );
  ctx = work(w, 25_000, 4);
  w.assistant({
    model: '<synthetic>',
    usage: {},
    blocks: [text('API Error: overloaded')],
    envelope: { isApiErrorMessage: true, error: 'overloaded' },
  });
  for (let i = 0; i < 2; i++) {
    w.assistant({
      usage: { input: 3, cacheWrite: 800, cacheRead: ctx, output: 60 },
      blocks: [toolUse('Bash', { command: 'npm run build' })],
    }).toolResult({ chars: 2400, isError: true });
    ctx += 800;
  }
  work(w, ctx, 24, 5200);
  out.push(w);

  return out;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const dir = process.argv[2];
  if (dir === undefined) {
    process.stderr.write('usage: tsx scripts/demo-corpus.ts <dir>\n');
    process.exit(2);
  }
  const root = join(resolve(dir), '.claude', 'projects');
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  writeTree(root, demoSessions());
  process.stdout.write(`wrote a synthetic corpus to ${root}\n`);
}
