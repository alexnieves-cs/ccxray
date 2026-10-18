// One benchmark stage in a fresh process (bench/perf.ts spawns this), so peak RSS is honest.
//
//   node --import tsx bench/stage.ts <load|pipeline> <projectsRoot>
//
// Prints one JSON line: { workMs, maxRssKiB, ... } or { skipped: "<reason>" }.
// process.resourceUsage().maxRSS is in KiB on every platform per the Node docs (libuv divides
// macOS's byte value by 1024).

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadSessions } from '../src/parser/index.js';

const [stage, root] = process.argv.slice(2);
if (root === undefined) {
  process.stderr.write('usage: node --import tsx bench/stage.ts <load|pipeline> <projectsRoot>\n');
  process.exit(2);
}

const emit = (o: Record<string, unknown>): void => {
  process.stdout.write(`${JSON.stringify({ ...o, maxRssKiB: process.resourceUsage().maxRSS })}\n`);
};

if (stage === 'load') {
  const t0 = performance.now();
  const { sessions, stats } = await loadSessions({ roots: [root] });
  const workMs = performance.now() - t0;
  emit({ workMs, bytes: stats.bytes, files: stats.files, sessions: sessions.length });
} else if (stage === 'pipeline') {
  // The full report pipeline (M2/M4) is not on this branch yet. When src/pipeline.ts lands this
  // stage runs automatically; adapt the call below to its export if the name differs.
  const path = resolve(import.meta.dirname, '..', 'src', 'pipeline.ts');
  if (!existsSync(path)) {
    emit({ skipped: 'src/pipeline.ts not present on this branch' });
  } else {
    const spec = '../src/pipeline.js';
    const mod = (await import(spec)) as Record<string, unknown>;
    const run = mod.runPipeline;
    if (typeof run !== 'function') {
      emit({ skipped: 'src/pipeline.ts has no runPipeline export' });
    } else {
      const t0 = performance.now();
      await (run as (o: { roots: string[] }) => Promise<unknown>)({ roots: [root] });
      emit({ workMs: performance.now() - t0 });
    }
  }
} else {
  process.stderr.write(`unknown stage: ${stage}\n`);
  process.exit(2);
}
