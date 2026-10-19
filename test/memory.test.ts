// Regression guard for parser memory (SPEC §8: < 300 MB RSS at 1 GB). Peak RSS is too noisy to
// assert in CI, so this checks the heap retained by loadSessions() per MB of a small synthetic
// corpus after a full GC. That number is deterministic to within a few percent; the threshold
// leaves ~35% headroom over the measured value (see FORMAT.md "Implementation notes: memory").

import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { afterAll, describe, expect, it } from 'vitest';
import { loadSessions } from '../src/parser/index.js';
import { session, toolUse, writeTree, type SessionBuilder } from '../scripts/make-fixture.js';

setFlagsFromString('--expose-gc');
const gc = runInNewContext('gc') as () => void;
const heapAfterGc = (): number => {
  gc();
  gc();
  return process.memoryUsage().heapUsed;
};

const dir = mkdtempSync(join(tmpdir(), 'ccxray-mem-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** ~8 MB: 20 sessions x 100 tool round trips, a prompt every 10. */
function corpus(): SessionBuilder[] {
  const out: SessionBuilder[] = [];
  for (let s = 0; s < 20; s++) {
    const b = session(`mem-${s}`, { project: `-home-dev-p${s % 4}` });
    for (let i = 0; i < 100; i++) {
      if (i % 10 === 0) b.prompt(`step ${i}: ${'p'.repeat(200)}`);
      b.assistant({
        usage: { input: 3, cacheRead: 20_000 + i * 50, cacheWrite: 400, output: 120 },
        blocks: [
          { type: 'text', text: 'o'.repeat(600) },
          toolUse('Read', { file_path: `/home/dev/app/src/file${i % 37}.ts`, limit: 200 }),
        ],
      });
      b.toolResult(3000);
    }
    out.push(b);
  }
  return out;
}

async function warmUp(): Promise<void> {
  const { sessions } = await loadSessions({ roots: [dir] });
  expect(sessions).toHaveLength(20);
}

describe('memory', () => {
  it('retains under 0.20 MiB of heap per MB of transcript', async () => {
    writeTree(dir, corpus());
    // Warm-up run (in its own function, so no frame keeps its result alive): compiles the
    // parser and fills interning tables, so they are not counted.
    await warmUp();
    const before = heapAfterGc();
    const { sessions, stats } = await loadSessions({ roots: [dir] });
    const retained = heapAfterGc() - before;
    expect(sessions).toHaveLength(20);
    expect(stats.bytes).toBe(
      sessions.reduce((a, s) => a + s.files.reduce((b, f) => b + statSync(f).size, 0), 0),
    );
    const perMB = retained / 2 ** 20 / (stats.bytes / 1e6);
    // [M] this container, Node 22.22: 0.148 MiB/MB with epoch-ms timestamps (0.147-0.148 over
    // runs); 0.181 with Date timestamps, 0.285 before the memory pass. 0.20 keeps ~35% headroom.
    expect(perMB).toBeLessThan(0.2);
    expect(sessions.length).toBe(20); // keep `sessions` alive until after the measurement
  });
});
