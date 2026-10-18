import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { FIXTURES, FIXTURES_DIR } from '../scripts/make-fixture.js';
import { defaultRoots, discover } from '../src/discover.js';
import { compareVersions, quirksFor } from '../src/parser/quirks.js';
import { persistedInfo } from '../src/parser/session.js';
import { emptyCounts, streamJsonl } from '../src/parser/stream.js';

const TMP = mkdtempSync(join(tmpdir(), 'ccxray-units-'));
afterAll(() => rmSync(TMP, { recursive: true, force: true }));

function listFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? listFiles(join(dir, e.name)) : [join(dir, e.name)],
  );
}

describe('discover', () => {
  it('builds default roots from CLAUDE_CONFIG_DIR and home', () => {
    expect(defaultRoots({ CLAUDE_CONFIG_DIR: 'a, b,' }, 'h')).toEqual([
      join('a', 'projects'),
      join('b', 'projects'),
      join('h', '.config', 'claude', 'projects'),
      join('h', '.claude', 'projects'),
    ]);
    expect(defaultRoots({}, 'h')).toHaveLength(2);
  });

  it('dedupes roots by realpath, skips missing roots, flags nested files', async () => {
    const root = join(FIXTURES_DIR, 'nested-subagents-dir');
    const d = await discover([root, root + sep, join(root, '.'), join(TMP, 'missing')]);
    expect(d.roots).toEqual([root]);
    expect(d.files.map((f) => [f.project, f.nested, f.dirs.length])).toEqual([
      ['-home-dev-nested-subagents-dir', false, 0],
      ['-home-dev-nested-subagents-dir', true, 2],
      ['-home-dev-nested-subagents-dir', true, 2],
    ]);
    expect(d.files[1]!.dirs[1]).toBe('subagents');
    expect(d.files.map((f) => f.metaPath !== undefined)).toEqual([false, true, false]);
    expect(d.files[1]!.metaPath!.endsWith(`${sep}agent-n1.meta.json`)).toBe(true);
    expect(d.files.every((f) => f.size > 0 && f.mtimeMs > 0)).toBe(true);
  });
});

describe('streamJsonl', () => {
  it('handles BOM, CRLF, blank and malformed lines', async () => {
    const f = join(TMP, 'crlf.jsonl');
    writeFileSync(f, '﻿{"a":1}\r\n\r\n{"b":2}\r\nbad\r\n[]\r\n');
    const counts = emptyCounts();
    const seen: number[] = [];
    await streamJsonl(f, (_r, line) => seen.push(line), counts);
    expect(seen).toEqual([1, 3]);
    expect(counts).toMatchObject({ lines: 5, blankLines: 1, malformedLines: 2, readErrors: 0 });
  });

  it('counts a missing file as a read error instead of throwing', async () => {
    const counts = emptyCounts();
    await streamJsonl(join(TMP, 'nope.jsonl'), () => undefined, counts);
    expect(counts.readErrors).toBe(1);
  });

  it('counts handler exceptions instead of throwing', async () => {
    const f = join(TMP, 'one.jsonl');
    writeFileSync(f, '{"a":1}\n');
    const counts = emptyCounts();
    await streamJsonl(
      f,
      () => {
        throw new Error('bug');
      },
      counts,
    );
    expect(counts.handlerErrors).toBe(1);
  });
});

describe('persistedInfo', () => {
  it('parses the reported size (KB = 1024, UNVERIFIED) and tolerates a missing figure', () => {
    expect(persistedInfo('<persisted-output>\nOutput too large (36.4KB). Full output…')).toEqual({
      reportedBytes: 37274,
    });
    expect(
      persistedInfo([{ type: 'text', text: '<persisted-output>\nOutput too large (2MB).' }]),
    ).toEqual({
      reportedBytes: 2097152,
    });
    expect(persistedInfo('<persisted-output>\nsomething else')).toEqual({ reportedBytes: null });
    expect(persistedInfo('plain output')).toBeUndefined();
    expect(persistedInfo(42)).toBeUndefined();
  });
});

describe('quirks', () => {
  it('compares versions numerically', () => {
    expect(compareVersions('2.1.100', '2.1.99')).toBeGreaterThan(0);
    expect(compareVersions('2.1.302', '2.1.302')).toBe(0);
    expect(compareVersions('2.1', '2.1.0')).toBe(0);
  });
  it('selects quirks by version range', () => {
    const ids = (v: string) => quirksFor(v).map((q) => q.id);
    expect(ids('2.1.302')).toContain('ai-title-record');
    expect(ids('2.1.302')).not.toContain('cost-state-record');
    expect(ids('2.1.296')).toContain('cost-state-record');
    expect(ids('2.1.99')).not.toContain('cache-creation-inflation');
  });
});

describe('make-fixture', () => {
  it('committed fixtures match the generator (run `pnpm fixtures` to update)', () => {
    for (const [name, build] of Object.entries(FIXTURES)) {
      const dir = join(FIXTURES_DIR, name);
      const want = new Map(build().flatMap((b) => b.files()));
      const have = listFiles(dir).map((p) => relative(dir, p));
      expect(have.sort(), name).toEqual([...want.keys()].sort());
      for (const [rel, content] of want)
        expect(readFileSync(join(dir, rel), 'utf8'), rel).toBe(content);
    }
  });

  it('writes one line per content block and keeps ids deterministic', () => {
    const lines = FIXTURES['multi-block-same-msgid']!()[0]!.lines.map((l) => JSON.parse(l));
    const ids = lines.filter((l) => l.type === 'assistant').map((l) => l.message.id);
    expect(ids).toHaveLength(6);
    expect(new Set(ids).size).toBe(3);
    expect(FIXTURES['multi-block-same-msgid']!()[0]!.toJsonl()).toBe(
      FIXTURES['multi-block-same-msgid']!()[0]!.toJsonl(),
    );
  });
});
