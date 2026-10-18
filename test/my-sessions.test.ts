import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { main } from '../bench/my-sessions.js';
import { loadSessions } from '../src/parser/index.js';
import { FIXTURES_DIR, writeTree } from '../scripts/make-fixture.js';
import { demoSessions } from '../scripts/demo-corpus.js';

const tmp = mkdtempSync(join(tmpdir(), 'ccxray-my-sessions-'));
const demoRoot = join(tmp, 'projects');
writeTree(demoRoot, demoSessions());
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

async function run(roots: string[]): Promise<{ md: string; file: string }> {
  const out = join(tmp, 'MY_SESSIONS.md');
  let md = '';
  const code = await main([...roots.flatMap((r) => ['--root', r]), '--out', out], {
    out: (s) => (md += s),
    err: () => {},
  });
  expect(code).toBe(0);
  return { md, file: readFileSync(out, 'utf8') };
}

describe('bench/my-sessions (aggregate only)', () => {
  it('prints totals and per-analyzer rows with [M]/[E] labels', async () => {
    const { md, file } = await run([demoRoot]);
    expect(file).toBe(md);
    expect(md).toContain('| sessions | 7 |');
    expect(md).toContain('| subagent transcripts | 1 |');
    expect(md).toMatch(/\| cache-rebuild \| \d+ \| [\d,]+ \[M\] \|/);
    expect(md).toMatch(/\| big-tool-output \| \d+ \| - \| [\d,]+ \[E\] \|/);
  });

  it('contains no fixture path, project name, session id or record id', async () => {
    const roots = [demoRoot, FIXTURES_DIR];
    const { md } = await run(roots);
    const { sessions } = await loadSessions({ roots });
    expect(sessions.length).toBeGreaterThan(10);

    const forbidden = new Set<string>([tmp, demoRoot, FIXTURES_DIR, '/home/', '.jsonl']);
    for (const r of roots)
      for (const d of readdirSync(r)) {
        forbidden.add(d); // encoded project dir, e.g. -home-dev-acme-api
        forbidden.add(d.replace(/^-home-dev-/, '')); // the project's own name
      }
    for (const s of sessions) {
      forbidden.add(s.id);
      forbidden.add(s.id.slice(0, 8)); // the short id reporters print
      forbidden.add(s.project);
      if (s.cwd !== undefined) forbidden.add(s.cwd).add(basename(s.cwd));
      for (const t of s.turns) forbidden.add(t.uuid);
    }
    for (const f of forbidden) if (f.length >= 4) expect(md, f).not.toContain(f);
    expect(md).not.toMatch(/msg_|req_|toolu_|\bagent-/);
  });
});
