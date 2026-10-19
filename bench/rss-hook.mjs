// Preloaded with `node --import` by bench/perf.ts to read the peak RSS of a CLI run it cannot
// instrument otherwise. Writes { maxRssKiB } to $CCXRAY_BENCH_RSS_OUT on exit. Bench only; never
// part of the package.
import { writeFileSync } from 'node:fs';

const out = process.env.CCXRAY_BENCH_RSS_OUT;
if (out) {
  process.on('exit', () => {
    writeFileSync(out, JSON.stringify({ maxRssKiB: process.resourceUsage().maxRSS }));
  });
}
