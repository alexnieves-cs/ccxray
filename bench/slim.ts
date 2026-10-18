// Benchmark script for the cc-slim prototype (docs/cc-slim.md). It runs compressBashOutput over
// SYNTHETIC outputs and prints chars before/after. This is a measurement of the compressor on
// made-up inputs, not a savings claim: real savings need the SPEC §8 benchmark on real sessions.
//   pnpm bench:slim
import { compressBashOutput } from '../src/slim/compress.js';
import { estimateTokensFromChars } from '../src/tokens/estimate.js';

function testLog(files: number, failing: number[]): string {
  const out = ['> pnpm test', '', ' RUN  v3.2.7 /repo', ''];
  for (let f = 0; f < files; f++) {
    const fail = failing.includes(f);
    out.push(
      ` ${fail ? '❯' : '✓'} src/module${f}.test.ts (12 tests${fail ? ' | 1 failed' : ''}) 42ms`,
    );
    for (let t = 0; t < 12; t++)
      out.push(`   ${fail && t === 3 ? '×' : '✓'} module${f} > case ${t} does the thing ${t}ms`);
    if (fail)
      out.push(
        ` FAIL  src/module${f}.test.ts > module${f} > case 3`,
        'AssertionError: expected 41 to be 42 // Object.is equality',
        `    at src/module${f}.test.ts:31:17`,
        '    at node_modules/vitest/dist/runner.js:120:9',
      );
  }
  out.push(
    '',
    ` Test Files  ${failing.length} failed | ${files - failing.length} passed (${files})`,
  );
  return out.join('\n');
}

function recursionTrace(depth: number): string {
  const out = ['RangeError: Maximum call stack size exceeded'];
  for (let i = 0; i < depth; i++)
    out.push('    at walk (src/tree.ts:12:10)', '    at visit (src/tree.ts:20:5)');
  out.push('    at main (src/index.ts:3:1)', 'Process exited with code 1');
  return out.join('\n');
}

function repeatedWarnings(n: number): string {
  const out: string[] = [];
  for (let i = 0; i < n; i++)
    out.push('warning: package.json: "repository" field missing', `building chunk ${i}`);
  out.push('done in 3.2s');
  return out.join('\n');
}

const cases: [string, string, number | null][] = [
  ['pnpm test, 200 files, 2 failing', testLog(200, [17, 140]), 1],
  ['pnpm test, 200 files, all passing', testLog(200, []), 0],
  ['stack overflow trace, depth 2000', recursionTrace(2000), 1],
  ['build log, 3000 repeated warnings', repeatedWarnings(3000), 0],
  ['short output', 'ok\n', 0],
];

const n = (x: number): string => x.toLocaleString('en-US');
console.log('cc-slim compressor on synthetic outputs (not a savings claim; see docs/cc-slim.md)');
console.log(
  `${'case'.padEnd(36)} ${'before [M]'.padStart(12)} ${'after [M]'.padStart(11)} ` +
    `${'before [E]'.padStart(11)} ${'after [E]'.padStart(10)}  failure lines kept`,
);
for (const [name, text, exitCode] of cases) {
  const { stats } = compressBashOutput(text, { exitCode });
  console.log(
    `${name.padEnd(36)} ${`${n(stats.inputChars)} ch`.padStart(12)} ${`${n(stats.outputChars)} ch`.padStart(11)} ` +
      `${`~${n(estimateTokensFromChars(stats.inputChars))} tok`.padStart(11)} ` +
      `${`~${n(estimateTokensFromChars(stats.outputChars))} tok`.padStart(10)}  ${stats.failureLines}`,
  );
}
console.log('[M] = chars counted by this script; [E] = tokens estimated as chars/4.');
