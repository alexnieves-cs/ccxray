// Guards the benchmark corpus generator (bench/corpus.ts) against rot: a tiny corpus must parse
// with no crashes, the expected malformed count and no accidental dedupe collisions.
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { generateCorpus, parseSize } from '../bench/corpus.js';
import { loadSessions } from '../src/parser/index.js';

const dirs: string[] = [];
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'ccxray-corpus-'));
  dirs.push(d);
  return d;
};
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

function digest(root: string): string {
  const h = createHash('sha256');
  const files = readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => join(e.parentPath, e.name))
    .sort();
  for (const f of files) h.update(f.slice(root.length)).update(readFileSync(f));
  return h.digest('hex');
}

describe('bench corpus generator', () => {
  it('parses sizes', () => {
    expect(parseSize('200kb')).toBe(200_000);
    expect(parseSize('10MB')).toBe(10_000_000);
    expect(parseSize('1gb')).toBe(1_000_000_000);
    expect(() => parseSize('10 parsecs')).toThrow();
  });

  it('a 200 KB corpus parses with 0 crashes and the expected counts', async () => {
    const root = tmp();
    const sum = await generateCorpus({ root, targetBytes: parseSize('200kb') });
    expect(sum.bytes).toBeGreaterThanOrEqual(200_000);
    expect(sum.malformedLines).toBeGreaterThan(0);
    expect(sum.subagents).toBeGreaterThan(0);

    const { sessions, stats } = await loadSessions({ roots: [root] });
    expect(stats).toMatchObject({
      files: sum.files,
      bytes: sum.bytes,
      lines: sum.lines,
      blankLines: 0,
      malformedLines: sum.malformedLines,
      syntheticTurns: 0,
      unknownRecordTypes: {},
      warnings: {},
      dedupe: { sidechainReplays: 0, crossSessionCopies: 0 },
    });
    expect(sessions).toHaveLength(sum.sessions + sum.subagents);
    const subs = sessions.filter((s) => s.isSubagent);
    expect(subs).toHaveLength(sum.subagents);
    expect(subs.every((s) => s.parentToolUseId !== undefined)).toBe(true);
    expect(sessions.reduce((a, s) => a + s.turns.length, 0)).toBe(sum.assistantResponses);
    const results = sessions.reduce(
      (a, s) => a + s.turns.reduce((b, t) => b + t.toolResults.length, 0),
      0,
    );
    expect(results).toBe(sum.toolResults);
  });

  it('is deterministic for a given seed', async () => {
    const [a, b] = [tmp(), tmp()];
    const sa = await generateCorpus({ root: a, targetBytes: 100_000, seed: 7 });
    const sb = await generateCorpus({ root: b, targetBytes: 100_000, seed: 7 });
    expect(sb).toEqual(sa);
    expect(digest(b)).toBe(digest(a));
  });
});
