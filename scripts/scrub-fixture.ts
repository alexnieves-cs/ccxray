// Turn a real Claude Code transcript into a shareable fixture (CLAUDE.md hard rule 4).
//
//   pnpm scrub <in.jsonl> [-o out.jsonl] [--salt S] [--hash-tool-names]
//
// What is kept: JSON structure and keys (except keys that are ids), numbers and booleans (so every `usage` field
// survives), record/block/attachment `type` values, model names, CC `version`, stop
// reasons, tool names (unless --hash-tool-names), and timestamps *relative* to the first
// one (re-based onto 2026-01-01T00:00:00Z).
// What is replaced: every other string. Ids keep their prefix (`msg_`, `req_`, `toolu_`)
// or uuid shape. Free text and paths are scrubbed token by token: each whitespace-separated
// token becomes a same-length hash, so lengths, line structure, path equality and the
// "first two tokens of a Bash command" grouping all survive, but the words do not.
// Hashes are salted. The default salt is random per run, so output is not reversible
// by dictionary; pass --salt to make a run reproducible.
//
// The output is checked for leaks: any original scrubbed string of 6+ chars that still
// appears in the output aborts the run.

import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

const ID_KEYS = new Set([
  'uuid',
  'parentUuid',
  'logicalParentUuid',
  'sessionId',
  'leafUuid',
  'promptId',
  'requestId',
  'agentId',
  'id',
  'tool_use_id',
  'toolUseID',
  'toolUseId',
  'sourceToolAssistantUUID',
  'source_uuid',
  'commandUuid',
  'deliveryId',
  'delivery_id',
  'messageId',
]);

// String values under these keys are structural, not user content.
const KEEP_KEYS = new Set([
  'type',
  'subtype',
  'role',
  'model',
  'requestedModel',
  'advisorModel',
  'version',
  'stop_reason',
  'service_tier',
  'userType',
  'entrypoint',
  'operation',
  'speed',
  'inference_geo',
  'permissionMode',
  'contextRendering',
  'level',
  'effort',
  'hookEvent',
  'media_type',
]);

const TIME_KEYS = new Set(['timestamp', 'startTime']);
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// `msg_01Ab…`, `req_011C…`, `toolu_01…`: a short prefix, then a long id with digits.
const PREFIXED_ID_RE = /^([a-z]{2,8}_(?:[a-z0-9]{2,8}_)?)(?=[A-Za-z0-9]*\d)([A-Za-z0-9]{16,})$/;
const BASE_TS = Date.parse('2026-01-01T00:00:00Z');

export interface ScrubOptions {
  salt: string;
  hashToolNames?: boolean;
}

export class Scrubber {
  private firstTs: number | null = null;
  /** Original strings that were replaced (for the leak check). */
  readonly replaced = new Set<string>();
  /** Strings kept verbatim (structural values); excluded from the leak check. */
  readonly kept = new Set<string>();

  constructor(private readonly opts: ScrubOptions) {}

  private hex(s: string, len: number): string {
    let out = '';
    let i = 0;
    while (out.length < len) {
      out += createHash('sha256').update(`${this.opts.salt}\0${i++}\0${s}`).digest('hex');
    }
    return out.slice(0, len);
  }

  scrubId(s: string): string {
    this.remember(s);
    if (UUID_RE.test(s)) {
      const h = this.hex(s, 32);
      return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
    }
    const m = PREFIXED_ID_RE.exec(s);
    if (m) return m[1] + this.hex(s, m[2]!.length);
    return this.scrubText(s);
  }

  /** Same-length, token-by-token replacement that keeps whitespace and `/` separators. */
  scrubText(s: string): string {
    this.remember(s);
    return s.replace(/[^\s/\\]+/g, (tok) => this.hex(tok, tok.length));
  }

  scrubTime(s: string): string {
    const t = Date.parse(s);
    if (Number.isNaN(t)) return this.scrubText(s);
    if (this.firstTs === null) this.firstTs = t;
    return new Date(BASE_TS + (t - this.firstTs)).toISOString();
  }

  /** Object keys are structural and kept, except keys that are themselves ids. */
  private key(k: string): string {
    if (UUID_RE.test(k) || PREFIXED_ID_RE.test(k)) return this.scrubId(k);
    return this.keep(k);
  }

  private keep(s: string): string {
    this.kept.add(s);
    return s;
  }

  private remember(s: string): void {
    if (s.length >= 6) this.replaced.add(s);
  }

  value(v: unknown, key: string | null, parent: Record<string, unknown> | null): unknown {
    if (typeof v === 'string') return this.string(v, key, parent);
    if (Array.isArray(v)) return v.map((x) => this.value(x, key, parent));
    if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(o)) out[this.key(k)] = this.value(x, k, o);
      return out;
    }
    return v;
  }

  private string(s: string, key: string | null, parent: Record<string, unknown> | null): string {
    if (key !== null && TIME_KEYS.has(key)) return this.scrubTime(s);
    if (ISO_RE.test(s)) return this.scrubTime(s);
    if (key !== null && KEEP_KEYS.has(key)) return this.keep(s);
    if (key === 'name' && !this.opts.hashToolNames && parent && isToolLike(parent))
      return this.keep(s);
    if (key !== null && ID_KEYS.has(key)) return this.scrubId(s);
    return this.scrubText(s);
  }

  line(raw: string): string {
    let obj: unknown;
    try {
      obj = JSON.parse(raw);
    } catch {
      // Keep malformed lines malformed, but never keep their text.
      return this.scrubText(raw);
    }
    return JSON.stringify(this.value(obj, null, null));
  }
}

function isToolLike(o: Record<string, unknown>): boolean {
  // tool_use blocks, tools-snapshot entries and toolUseResult objects carry tool names.
  return o.type === 'tool_use' || 'input_schema' in o || 'schema' in o || 'description' in o;
}

/**
 * Originals that still appear in the output. Kept structural strings (keys, tool and model
 * names) are blanked out first, so "github" inside a kept `mcp__github__create_issue` does
 * not count as a leak.
 */
export function findLeaks(
  output: string,
  replaced: Iterable<string>,
  kept: Iterable<string> = [],
): string[] {
  let text = output;
  for (const k of [...kept].sort((a, b) => b.length - a.length)) {
    if (k.length >= 3) text = text.split(JSON.stringify(k).slice(1, -1)).join('\u0000');
  }
  const leaks: string[] = [];
  for (const s of replaced) if (text.includes(s)) leaks.push(s);
  return leaks;
}

export function scrubJsonl(input: string, opts: ScrubOptions): { output: string; leaks: number } {
  const sc = new Scrubber(opts);
  const output = input
    .split('\n')
    .map((l) => (l.trim() === '' ? l : sc.line(l)))
    .join('\n');
  // JSON-escaped forms of the originals are what would actually appear in the output.
  const escaped = [...sc.replaced]
    .filter((s) => !sc.kept.has(s))
    .map((s) => JSON.stringify(s).slice(1, -1));
  return { output, leaks: findLeaks(output, escaped, sc.kept).length };
}

function cli(): void {
  const { values, positionals } = parseArgs({
    options: {
      out: { type: 'string', short: 'o' },
      salt: { type: 'string' },
      'hash-tool-names': { type: 'boolean' },
    },
    allowPositionals: true,
  });
  const file = positionals[0];
  if (!file) {
    process.stderr.write(
      'usage: pnpm scrub <in.jsonl> [-o out.jsonl] [--salt S] [--hash-tool-names]\n',
    );
    process.exit(2);
  }
  const { output, leaks } = scrubJsonl(readFileSync(file, 'utf8'), {
    salt: values.salt ?? randomBytes(16).toString('hex'),
    hashToolNames: values['hash-tool-names'] ?? false,
  });
  if (leaks > 0) {
    process.stderr.write(`refusing to write: ${leaks} original strings survived scrubbing\n`);
    process.exit(1);
  }
  if (values.out) writeFileSync(values.out, output);
  else process.stdout.write(output);
  process.stderr.write(`scrubbed ${output.split('\n').filter(Boolean).length} lines, 0 leaks\n`);
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'))) cli();
