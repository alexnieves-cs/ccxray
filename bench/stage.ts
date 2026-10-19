// One benchmark stage in a fresh process (bench/perf.ts spawns this), so peak RSS is honest.
//
//   node --import tsx bench/stage.ts <load|pipeline> <projectsRoot>
//
// Prints one JSON line: { workMs, maxRssKiB, ... }. Both stages run src/ under tsx: importing
// from dist/ would need a library entry in the published package (dist/ has only cli.js,
// capture.js and slim.js bundles); the `doctor --json` stage in perf.ts runs dist/cli.js.
// process.resourceUsage().maxRSS is in KiB on every platform per the Node docs (libuv divides
// macOS's byte value by 1024).

import { DEFAULT_THRESHOLDS } from '../src/model/index.js';
import { loadSessions } from '../src/parser/index.js';
import { buildReport } from '../src/pipeline.js';

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
  // The real pipeline as the default command runs it (src/commands/analyze.ts): loadSessions,
  // then buildReport with every registered analyzer. No date window, so the whole corpus counts.
  const now = new Date();
  const t0 = performance.now();
  const { sessions, stats } = await loadSessions({ roots: [root] });
  const t1 = performance.now();
  const report = buildReport({
    sessions,
    stats,
    ctx: { thresholds: DEFAULT_THRESHOLDS, now, includeContent: false },
    window: { since: '1970-01-01', until: null, project: null },
    includeContent: false,
  });
  const t2 = performance.now();
  emit({
    workMs: t2 - t0,
    loadMs: t1 - t0,
    buildReportMs: t2 - t1,
    bytes: stats.bytes,
    files: stats.files,
    sessions: sessions.length,
    findings: report.findings.length,
  });
} else {
  process.stderr.write(`unknown stage: ${stage}\n`);
  process.exit(2);
}
