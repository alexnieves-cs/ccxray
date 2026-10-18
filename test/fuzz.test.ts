// Property test (SPEC §6 M1, §7): randomly mutated lines never make loadSessions throw, and the
// line counters add up. 10 runs × 100 lines = 1,000 mutated lines per test run, including
// 20k-deep nesting and ~1 MB lines.

import fc from 'fast-check';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { FIXTURES } from '../scripts/make-fixture.js';
import { loadSessions } from '../src/parser/index.js';

const TMP = mkdtempSync(join(tmpdir(), 'ccxray-fuzz-'));
afterAll(() => rmSync(TMP, { recursive: true, force: true }));

const BASE = Object.values(FIXTURES)
  .flatMap((build) => build().flatMap((b) => b.lines))
  .filter((l) => {
    try {
      const v: unknown = JSON.parse(l);
      return typeof v === 'object' && v !== null && !Array.isArray(v);
    } catch {
      return false;
    }
  });

const value = fc.oneof(
  fc.constant(null),
  fc.boolean(),
  fc.integer(),
  fc.double(),
  fc.string(),
  fc.constant([]),
  fc.constant({}),
  fc.array(fc.anything(), { maxLength: 3 }),
  fc.dictionary(fc.string(), fc.anything(), { maxKeys: 3 }),
  fc.constantFrom(
    'user',
    'assistant',
    'attachment',
    'system',
    'summary',
    'tool_use',
    'tool_result',
  ),
);
const mutation = fc.record({
  line: fc.nat(),
  // 0-5: structural mutations; 6: 20k-deep nesting; 7: a ~1 MB line. Weighted to keep runs fast.
  op: fc.oneof(
    { weight: 14, arbitrary: fc.integer({ min: 0, max: 5 }) },
    fc.constant(6),
    fc.constant(7),
  ),
  path: fc.array(fc.nat(), { maxLength: 6 }),
  val: value,
  cut: fc.nat(),
  garbage: fc.string(),
});
type Mutation = typeof mutation extends fc.Arbitrary<infer T> ? T : never;

type Node = Record<string, unknown> | unknown[];
const isNode = (v: unknown): v is Node => typeof v === 'object' && v !== null;

/** Walk `path` into the object; returns the container and key of the last reachable step. */
function locate(root: Node, path: number[]): [Node, string | number] | undefined {
  let cur: Node = root;
  let hit: [Node, string | number] | undefined;
  for (const step of path) {
    const keys: (string | number)[] = Array.isArray(cur) ? cur.map((_, i) => i) : Object.keys(cur);
    if (keys.length === 0) break;
    const k = keys[step % keys.length]!;
    hit = [cur, k];
    const next = (cur as Record<string | number, unknown>)[k];
    if (!isNode(next)) break;
    cur = next;
  }
  return hit;
}

const DEEP = `${'['.repeat(20_000)}${']'.repeat(20_000)}`;

function mutate(m: Mutation): string {
  const src = BASE[m.line % BASE.length]!;
  // Deep nesting: JSON.parse accepts it but JSON.stringify of it throws (review #6).
  if (m.op === 6) return src.replace(/"(input|content|usage|attachment)":/, `"$1":${DEEP},"was":`);
  if (m.op === 7) return `${src.slice(0, -1)},"pad":"${'x'.repeat(1_000_000)}"}`;
  if (m.op === 0) return src.slice(0, m.cut % (src.length + 1));
  if (m.op === 4) return m.garbage;
  const obj = JSON.parse(src) as Record<string, unknown>;
  if (m.op === 1) obj.type = m.val;
  const at = locate(obj, m.path);
  if (at !== undefined) {
    const [node, k] = at;
    const rec = node as Record<string | number, unknown>;
    if (m.op === 2) {
      if (Array.isArray(node)) node.splice(k as number, 1);
      else delete rec[k];
    } else if (m.op === 3) rec[k] = m.val;
    else if (m.op === 5 && !Array.isArray(node)) rec[`x${m.cut}`] = m.val;
  }
  return JSON.stringify(obj) ?? 'undefined';
}

function classify(line: string): 'blank' | 'malformed' | 'record' {
  if (/^\s*$/.test(line)) return 'blank';
  try {
    const v: unknown = JSON.parse(line);
    return typeof v === 'object' && v !== null && !Array.isArray(v) ? 'record' : 'malformed';
  } catch {
    return 'malformed';
  }
}

describe('fuzz', () => {
  it('never throws on mutated lines and the counters add up', async () => {
    let run = 0;
    await fc.assert(
      fc.asyncProperty(fc.array(mutation, { minLength: 100, maxLength: 100 }), async (ms) => {
        // One line per array entry: line breaks inside a mutation would split it.
        const lines = ms.map((m) => mutate(m).replace(/[\r\n]/g, ' '));
        const root = join(TMP, String(run++));
        const sid = 'ffffffff-0000-4000-8000-000000000000';
        const sub = join(root, '-fuzz', sid, 'subagents');
        mkdirSync(sub, { recursive: true });
        writeFileSync(join(root, '-fuzz', `${sid}.jsonl`), `${lines.slice(0, 50).join('\n')}\n`);
        writeFileSync(join(sub, 'agent-f.jsonl'), `${lines.slice(50).join('\n')}\n`);

        const { sessions, stats } = await loadSessions({
          roots: [root],
          includeContent: run % 2 === 0,
        });
        const kinds = lines.map(classify);
        const n = (k: string) => kinds.filter((x) => x === k).length;
        expect(stats.lines).toBe(100);
        expect(stats.blankLines).toBe(n('blank'));
        expect(stats.malformedLines).toBe(n('malformed'));
        expect(Object.values(stats.recordTypes).reduce((a, b) => a + b, 0)).toBe(n('record'));
        expect(stats.warnings['internal parser error']).toBeUndefined();
        for (const s of sessions)
          for (const t of s.turns) {
            expect(
              Number.isFinite(
                t.usage.input + t.usage.output + t.usage.cacheRead + t.usage.cacheWrite,
              ),
            ).toBe(true);
            expect(Number.isNaN(t.ts.getTime())).toBe(false);
          }
      }),
      // Fixed seed so CI is reproducible; fast-check prints the seed and counterexample on failure.
      { numRuns: 10, seed: 20261018 },
    );
  });
});
