// Performance benchmark against the SPEC §8 targets. Every number it prints is [M] measured on
// the machine it runs on; nothing here writes to README or docs.
//
//   pnpm bench          # 10 MB + 100 MB
//   pnpm bench:full     # adds 1 GB (and deletes the corpora afterwards)
//   tsx bench/perf.ts [--sizes 10mb,100mb] [--iterations 3] [--out DIR] [--seed N]
//                     [--cold-start-size 50mb] [--clean]
//
// Needs a built dist/ (`pnpm bench` builds first). Each run is a fresh process, so peak RSS is
// per run. Writes DIR/perf-<UTC date>.json and .md (DIR defaults to bench/out, gitignored).
// Exits 1 only on script errors (a stage crashed, bad output); missing a target never fails.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { cpus, arch, release, tmpdir, totalmem, type } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import {
  DEFAULT_SEED,
  ensureCorpus,
  GENERATOR_VERSION,
  OUT_DIR,
  parseSize,
  type CorpusInfo,
} from './corpus.js';

const ROOT = resolve(import.meta.dirname, '..');
const RSS_HOOK = pathToFileURL(join(import.meta.dirname, 'rss-hook.mjs')).href;

/** SPEC §8 (targets are for an M-series laptop). */
export const TARGETS = {
  throughputMBps: 100,
  oneGbSeconds: 15,
  /** SPEC §8 "300 MB": decimal, 300 × 10^6 bytes. */
  rssBytes: 300e6,
  coldStartSeconds: 1.5,
  coldStartCorpus: '50mb',
  packageBytes: 1e6,
};

interface Sample {
  wallMs: number;
  /** In-process time of the measured call (excludes process start and module load). */
  workMs?: number;
  maxRssKiB: number;
}

interface StageResult {
  stage: string;
  size: string;
  bytes: number;
  samples: Sample[];
  skipped?: string;
}

/**
 * Stages run per corpus size. To add one, append a line here. `pipeline` runs automatically once
 * src/pipeline.ts exists (see bench/stage.ts); until then it is recorded as skipped.
 */
const STAGES: { name: string; args: (root: string) => string[]; viaHook?: boolean }[] = [
  { name: 'loadSessions', args: (root) => ['--import', 'tsx', 'bench/stage.ts', 'load', root] },
  { name: 'pipeline', args: (root) => ['--import', 'tsx', 'bench/stage.ts', 'pipeline', root] },
  {
    name: 'doctor --json',
    viaHook: true,
    args: (root) => ['dist/cli.js', 'doctor', '--root', root, '--json'],
  },
];

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};
const mbps = (bytes: number, ms: number): number => bytes / 1e6 / (ms / 1000);
/** maxRSS KiB → MB (10^6 bytes), the unit of the SPEC target. */
const rssMB = (kib: number): number => (kib * 1024) / 1e6;
const f1 = (x: number): string => x.toFixed(1);
const f2 = (x: number): string => x.toFixed(2);

export function machine(): Record<string, string | number> {
  const c = cpus();
  return {
    cpu: c[0]?.model.trim() ?? 'unknown',
    cores: c.length,
    os: `${type()} ${release()} ${arch()}`,
    memGiB: Math.round(totalmem() / 2 ** 30),
    node: process.version,
  };
}

/** Run `node ...args` in ROOT; returns stdout and wall time. Throws on a non-zero exit. */
function node(args: string[], opts: { hook?: boolean } = {}): { stdout: string; sample: Sample } {
  const rssFile = join(tmpdir(), `ccxray-bench-rss-${process.pid}.json`);
  rmSync(rssFile, { force: true });
  const full = opts.hook ? ['--import', RSS_HOOK, ...args] : args;
  const t0 = performance.now();
  const r = spawnSync(process.execPath, full, {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    env: { ...process.env, CCXRAY_BENCH_RSS_OUT: rssFile },
  });
  const wallMs = performance.now() - t0;
  if (r.error) throw r.error;
  if (r.status !== 0)
    throw new Error(`node ${args.join(' ')} exited ${r.status}: ${r.stderr.slice(0, 2000)}`);
  let maxRssKiB = NaN;
  if (opts.hook && existsSync(rssFile)) {
    maxRssKiB = (JSON.parse(readFileSync(rssFile, 'utf8')) as { maxRssKiB: number }).maxRssKiB;
    rmSync(rssFile, { force: true });
  }
  return { stdout: r.stdout, sample: { wallMs, maxRssKiB } };
}

function runStage(
  st: (typeof STAGES)[number],
  size: string,
  corpus: CorpusInfo,
  iterations: number,
): StageResult {
  const res: StageResult = { stage: st.name, size, bytes: corpus.summary.bytes, samples: [] };
  for (let i = 0; i < iterations; i++) {
    const { stdout, sample } = node(st.args(corpus.root), { hook: st.viaHook });
    if (st.viaHook) {
      const stats = JSON.parse(stdout) as { bytes: number; files: number };
      if (stats.bytes !== corpus.summary.bytes || stats.files !== corpus.summary.files)
        throw new Error(`${st.name} @${size}: read ${stats.bytes} bytes / ${stats.files} files`);
    } else {
      const o = JSON.parse(stdout.trim().split('\n').pop()!) as {
        skipped?: string;
        workMs?: number;
        maxRssKiB: number;
        bytes?: number;
      };
      if (o.skipped !== undefined) return { ...res, skipped: o.skipped };
      if (o.bytes !== undefined && o.bytes !== corpus.summary.bytes)
        throw new Error(
          `${st.name} @${size}: read ${o.bytes} bytes, corpus has ${corpus.summary.bytes}`,
        );
      sample.workMs = o.workMs;
      sample.maxRssKiB = o.maxRssKiB;
    }
    res.samples.push(sample);
    const work = sample.workMs !== undefined ? ` work ${f2(sample.workMs / 1000)} s` : '';
    process.stderr.write(
      `  ${st.name} @${size} #${i + 1}: wall ${f2(sample.wallMs / 1000)} s${work}, RSS ${f1(rssMB(sample.maxRssKiB))} MB\n`,
    );
  }
  return res;
}

function packageSize(): { unpackedBytes: number; packedBytes: number; files: number } {
  const r = spawnSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
    cwd: ROOT,
    encoding: 'utf8',
    shell: process.platform === 'win32',
  });
  if (r.status !== 0) throw new Error(`npm pack --dry-run failed: ${r.stderr.slice(0, 2000)}`);
  const [p] = JSON.parse(r.stdout) as { unpackedSize: number; size: number; entryCount: number }[];
  if (p === undefined) throw new Error('npm pack --dry-run printed no package');
  return { unpackedBytes: p.unpackedSize, packedBytes: p.size, files: p.entryCount };
}

interface Report {
  date: string;
  label: string;
  machine: Record<string, string | number>;
  iterations: number;
  seed: number;
  generatorVersion: number;
  targets: typeof TARGETS;
  corpora: Record<string, CorpusInfo['summary'] & { genMs: number; reused: boolean }>;
  stages: StageResult[];
  coldStart?: { versionMs: number[]; doctor: StageResult };
  pkg?: ReturnType<typeof packageSize>;
  errors: string[];
}

function summarize(r: StageResult): {
  wall: number;
  work?: number;
  rssBytes: number;
  rate: number;
} {
  const wall = median(r.samples.map((s) => s.wallMs));
  const works = r.samples.map((s) => s.workMs).filter((x): x is number => x !== undefined);
  const work = works.length ? median(works) : undefined;
  const rssBytes = Math.max(...r.samples.map((s) => s.maxRssKiB * 1024));
  return { wall, work, rssBytes, rate: mbps(r.bytes, work ?? wall) };
}

const verdict = (ok: boolean): string => (ok ? 'meets' : 'misses');

export function toMarkdown(rep: Report): string {
  const m = rep.machine;
  const L: string[] = [
    `# ccxray perf, ${rep.date} [M]`,
    '',
    `All numbers are **[M] measured** on: ${m.cpu} (${m.cores} cores), ${m.os}, ${m.memGiB} GiB RAM, Node ${m.node}.`,
    'SPEC §8 targets are set for an M-series laptop; on any other machine read "meets/misses" as a rough guide.',
    `Median of ${rep.iterations} runs, each in a fresh process; peak RSS is the max over runs (process.resourceUsage().maxRSS, KiB on every platform per the Node docs, shown in MB = 10^6 bytes).`,
    `Corpora are synthetic (bench/corpus.ts, seed ${rep.seed}, generator v${rep.generatorVersion}); the OS page cache is warm (each corpus was just written or reused). MB = 10^6 bytes.`,
    '',
    '## Throughput and memory',
    '',
    '| corpus | stage | median wall | median in-process | MB/s | peak RSS | ≥ 100 MB/s | RSS < 300 MB |',
    '|---|---|---|---|---|---|---|---|',
  ];
  for (const r of rep.stages) {
    if (r.skipped !== undefined) {
      L.push(`| ${r.size} | ${r.stage} | skipped: ${r.skipped} | | | | | |`);
      continue;
    }
    const s = summarize(r);
    L.push(
      `| ${r.size} (${f1(r.bytes / 1e6)} MB) | ${r.stage} | ${f2(s.wall / 1000)} s [M] | ` +
        `${s.work !== undefined ? `${f2(s.work / 1000)} s [M]` : 'n/a'} | ${f1(s.rate)} [M] | ` +
        `${f1(s.rssBytes / 1e6)} MB [M] | ${verdict(s.rate >= TARGETS.throughputMBps)} | ${verdict(s.rssBytes < TARGETS.rssBytes)} |`,
    );
  }
  L.push(
    '',
    'MB/s uses the in-process time when there is one (loadSessions), else the wall time including Node startup (doctor).',
    'loadSessions runs from source under the tsx loader, so its RSS includes the loader; doctor runs the built dist/cli.js.',
    '',
    '## SPEC §8 targets',
    '',
    '| target | measured | status |',
    '|---|---|---|',
  );
  const done = rep.stages.filter((r) => r.skipped === undefined && r.samples.length > 0);
  const biggest = (stage: string): StageResult | undefined =>
    done.filter((r) => r.stage === stage).sort((a, b) => b.bytes - a.bytes)[0];
  const load = biggest('loadSessions');
  if (load) {
    const s = summarize(load);
    L.push(
      `| Parse throughput ≥ 100 MB/s | ${f1(s.rate)} MB/s [M] (loadSessions, ${load.size}) | ${verdict(s.rate >= 100)} |`,
    );
  }
  const gb = done.find((r) => r.stage === 'doctor --json' && r.size === '1gb');
  if (gb) {
    const s = summarize(gb);
    L.push(
      `| 1 GB in < 15 s | ${f2(s.wall / 1000)} s [M] (doctor --json end to end; full analysis not on this branch) | ${verdict(s.wall / 1000 < 15)} |`,
    );
  } else L.push('| 1 GB in < 15 s | not run (`pnpm bench:full`) | n/a |');
  if (done.length) {
    const worst = done
      .map((r) => ({ r, rss: summarize(r).rssBytes }))
      .sort((a, b) => b.rss - a.rss)[0]!;
    L.push(
      `| Peak RSS < 300 MB | ${f1(worst.rss / 1e6)} MB [M] (${worst.r.stage}, ${worst.r.size}) | ${verdict(worst.rss < TARGETS.rssBytes)} |`,
    );
  }
  if (rep.coldStart) {
    const d = summarize(rep.coldStart.doctor);
    const v = median(rep.coldStart.versionMs);
    const size = rep.coldStart.doctor.size;
    const spec =
      size === TARGETS.coldStartCorpus ? '' : ` (SPEC target is for ${TARGETS.coldStartCorpus})`;
    L.push(
      `| Cold start < ${TARGETS.coldStartSeconds} s for ${size}${spec} | ${f2(d.wall / 1000)} s [M] (\`node bin/ccxray.js doctor\`, ${f1(rep.coldStart.doctor.bytes / 1e6)} MB; not npx, report command not on this branch) | ${verdict(d.wall / 1000 < TARGETS.coldStartSeconds)} |`,
      `| (info) \`ccxray --version\` | ${Math.round(v)} ms [M] | n/a |`,
    );
  }
  if (rep.pkg)
    L.push(
      `| Package < 1 MB unpacked | ${f1(rep.pkg.unpackedBytes / 1e3)} kB [M] unpacked, ${f1(rep.pkg.packedBytes / 1e3)} kB packed, ${rep.pkg.files} files | ${verdict(rep.pkg.unpackedBytes < TARGETS.packageBytes)} |`,
    );
  L.push(
    '',
    '## Corpora',
    '',
    '| size | bytes | files | sessions | subagents | lines | malformed | generated in |',
    '|---|---|---|---|---|---|---|---|',
  );
  for (const [size, c] of Object.entries(rep.corpora))
    L.push(
      `| ${size} | ${c.bytes} | ${c.files} | ${c.sessions} | ${c.subagents} | ${c.lines} | ${c.malformedLines} | ${c.reused ? 'reused' : `${f2(c.genMs / 1000)} s`} |`,
    );
  if (rep.errors.length) L.push('', '## Errors', '', ...rep.errors.map((e) => `- ${e}`));
  return `${L.join('\n')}\n`;
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      sizes: { type: 'string', default: '10mb,100mb' },
      iterations: { type: 'string', default: '3' },
      out: { type: 'string' },
      seed: { type: 'string' },
      'cold-start-size': { type: 'string', default: TARGETS.coldStartCorpus },
      clean: { type: 'boolean', default: false },
    },
  });
  const out = resolve(values.out ?? OUT_DIR);
  const iterations = Math.max(1, Number(values.iterations));
  const seed = values.seed !== undefined ? Number(values.seed) : DEFAULT_SEED;
  const sizes = values.sizes
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (!existsSync(join(ROOT, 'dist', 'cli.js')))
    throw new Error('dist/cli.js missing: run `pnpm build` first');
  mkdirSync(out, { recursive: true });

  const rep: Report = {
    date: new Date().toISOString().slice(0, 10),
    label: '',
    machine: machine(),
    iterations,
    seed,
    generatorVersion: GENERATOR_VERSION,
    targets: TARGETS,
    corpora: {},
    stages: [],
    errors: [],
  };
  rep.label = `[M] measured on ${rep.machine.cpu}, ${rep.machine.os}, Node ${rep.machine.node}`;
  const made: string[] = [];
  const seen = new Map<string, CorpusInfo>();
  const corpus = async (size: string): Promise<CorpusInfo> => {
    // A size used twice (e.g. --cold-start-size equal to a main size) keeps its first record,
    // so its generation time is not overwritten by "reused".
    const prev = seen.get(size);
    if (prev) return prev;
    const dir = join(out, `corpus-${size}`);
    process.stderr.write(`corpus ${size}: `);
    const c = await ensureCorpus(dir, parseSize(size), seed);
    process.stderr.write(c.reused ? 'reused\n' : `generated in ${f2(c.genMs / 1000)} s\n`);
    rep.corpora[size] = { ...c.summary, genMs: c.genMs, reused: c.reused };
    made.push(dir);
    seen.set(size, c);
    return c;
  };
  const attempt = async (what: string, fn: () => unknown): Promise<void> => {
    try {
      await fn();
    } catch (e) {
      const msg = `${what}: ${e instanceof Error ? e.message : String(e)}`;
      rep.errors.push(msg);
      process.stderr.write(`ERROR ${msg}\n`);
    }
  };

  for (const size of sizes)
    await attempt(`size ${size}`, async () => {
      const c = await corpus(size);
      for (const st of STAGES) rep.stages.push(runStage(st, size, c, iterations));
    });

  await attempt('cold start', async () => {
    const size = values['cold-start-size'];
    const c = await corpus(size);
    const versionMs: number[] = [];
    for (let i = 0; i < Math.max(iterations, 5); i++)
      versionMs.push(node(['bin/ccxray.js', '--version']).sample.wallMs);
    const doctor: StageResult = {
      stage: 'doctor (cold start)',
      size,
      bytes: c.summary.bytes,
      samples: [],
    };
    for (let i = 0; i < iterations; i++)
      doctor.samples.push(
        node(['bin/ccxray.js', 'doctor', '--root', c.root], { hook: true }).sample,
      );
    rep.coldStart = { versionMs, doctor };
  });
  await attempt('package size', () => (rep.pkg = packageSize()));

  if (values.clean) for (const d of made) rmSync(d, { recursive: true, force: true });
  const base = join(out, `perf-${rep.date}`);
  writeFileSync(`${base}.json`, `${JSON.stringify(rep, null, 2)}\n`);
  const md = toMarkdown(rep);
  writeFileSync(`${base}.md`, md);
  process.stdout.write(`${md}\nwrote ${base}.json and ${base}.md\n`);
  return rep.errors.length > 0 ? 1 : 0;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
