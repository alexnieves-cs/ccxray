// Read-only structural probe of Claude Code transcripts (SPEC §4.4, docs/FORMAT.md).
//
//   pnpm probe [--root DIR ...] > probe.json
//
// Prints counts and key paths only: no prompt text, no file contents, no paths beyond the
// layout shape. Safe to paste into an issue or PR. Run it locally; never commit its input.

import { createReadStream, existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, sep } from 'node:path';
import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';

type Counter = Map<string, number>;
const inc = (m: Counter, k: string, n = 1): void => {
  m.set(k, (m.get(k) ?? 0) + n);
};
type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);

function defaultRoots(): string[] {
  const roots: string[] = [];
  for (const d of (process.env.CLAUDE_CONFIG_DIR ?? '').split(',').filter(Boolean)) {
    roots.push(join(d.trim(), 'projects'));
  }
  roots.push(
    join(homedir(), '.config', 'claude', 'projects'),
    join(homedir(), '.claude', 'projects'),
  );
  return roots;
}

function walk(dir: string, out: string[]): void {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.jsonl')) out.push(p);
  }
}

function quantiles(a: number[]): Record<string, number> {
  if (a.length === 0) return { n: 0 };
  a.sort((x, y) => x - y);
  const q = (k: number): number => a[Math.min(a.length - 1, Math.floor(k * a.length))]!;
  return { n: a.length, p50: q(0.5), p90: q(0.9), p99: q(0.99), max: a[a.length - 1]! };
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { root: { type: 'string', multiple: true } } });
  const roots = (values.root ?? defaultRoots()).filter((r) => existsSync(r));
  const files: { path: string; root: string }[] = [];
  for (const root of roots) {
    const list: string[] = [];
    walk(root, list);
    for (const p of list) files.push({ path: p, root });
  }
  const c = {
    layout: new Map(),
    nestedDirs: new Map(),
    type: new Map(),
    envelopeKeys: new Map(),
    messageKeys: new Map(),
    usageKeys: new Map(),
    contentKind: new Map(),
    blockTypes: new Map(),
    toolResultContentKind: new Map(),
    attachmentTypes: new Map(),
    attachmentKeys: new Map(),
    systemSubtypes: new Map(),
    versions: new Map(),
    requestIdPresent: new Map(),
    isSidechain: new Map(),
    compactionMarkers: new Map(),
    toolUseResultKeys: new Map(),
    models: new Map(),
    linesPerResponse: new Map(),
  } satisfies Record<string, Counter>;
  let bytes = 0,
    lines = 0,
    malformed = 0;
  const toolResultChars: number[] = [];
  const responses = new Map<string, number>();
  for (const f of files) {
    bytes += statSync(f.path).size;
    const rel = f.path.slice(f.root.length + 1).split(sep);
    inc(
      c.layout,
      rel.length === 2 ? 'projects/{project}/{session}.jsonl' : `nested, depth ${rel.length}`,
    );
    if (rel.length > 2) inc(c.nestedDirs, ['{session}', ...rel.slice(2, -1)].join('/'));
    const rl = createInterface({ input: createReadStream(f.path) });
    for await (const line of rl) {
      if (!line.trim()) continue;
      lines++;
      let o: unknown;
      try {
        o = JSON.parse(line);
      } catch {
        malformed++;
        continue;
      }
      if (!isRec(o)) {
        malformed++;
        continue;
      }
      const t = String(o.type);
      inc(c.type, t);
      for (const k of Object.keys(o)) inc(c.envelopeKeys, `${t}.${k}`);
      if (typeof o.version === 'string') inc(c.versions, o.version);
      inc(c.requestIdPresent, `${t}:${'requestId' in o}`);
      inc(c.isSidechain, `${t}:${String(o.isSidechain)}`);
      if ('isCompactSummary' in o)
        inc(c.compactionMarkers, `isCompactSummary=${String(o.isCompactSummary)}`);
      if (t === 'summary') inc(c.compactionMarkers, 'type=summary');
      if (t === 'system') {
        inc(c.systemSubtypes, String(o.subtype));
        if (o.subtype === 'compact_boundary') inc(c.compactionMarkers, 'system:compact_boundary');
      }
      if (isRec(o.toolUseResult))
        for (const k of Object.keys(o.toolUseResult)) inc(c.toolUseResultKeys, k);
      if (t === 'attachment' && isRec(o.attachment)) {
        const at = String(o.attachment.type);
        inc(c.attachmentTypes, at);
        for (const k of Object.keys(o.attachment)) inc(c.attachmentKeys, `${at}.${k}`);
      }
      const m = o.message;
      if (!isRec(m)) continue;
      for (const k of Object.keys(m)) inc(c.messageKeys, `${t}.message.${k}`);
      if (typeof m.model === 'string') inc(c.models, m.model);
      if (t === 'assistant' && typeof m.id === 'string') {
        const k = `${m.id}|${String(o.requestId)}`;
        responses.set(k, (responses.get(k) ?? 0) + 1);
      }
      if (isRec(m.usage)) {
        for (const [k, v] of Object.entries(m.usage)) {
          inc(c.usageKeys, k);
          if (isRec(v)) for (const k2 of Object.keys(v)) inc(c.usageKeys, `${k}.${k2}`);
        }
      }
      if (typeof m.content === 'string') inc(c.contentKind, `${t}:string`);
      else if (Array.isArray(m.content)) {
        inc(c.contentKind, `${t}:array`);
        for (const b of m.content) {
          if (!isRec(b)) continue;
          inc(c.blockTypes, `${t}:${String(b.type)}`);
          if (b.type === 'tool_result') {
            inc(c.toolResultContentKind, Array.isArray(b.content) ? 'array' : typeof b.content);
            toolResultChars.push(
              typeof b.content === 'string'
                ? b.content.length
                : JSON.stringify(b.content ?? '').length,
            );
          }
        }
      }
    }
  }
  for (const n of responses.values()) inc(c.linesPerResponse, String(n));
  const out: Record<string, unknown> = {
    roots: roots.length,
    files: files.length,
    bytes,
    lines,
    malformed,
  };
  for (const [k, v] of Object.entries(c))
    out[k] = Object.fromEntries([...v].sort((a, b) => b[1] - a[1]));
  out.toolResultChars = quantiles(toolResultChars);
  process.stdout.write(`${JSON.stringify(out, null, 1)}\n`);
}

void main();
