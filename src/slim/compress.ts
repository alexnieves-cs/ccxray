// cc-slim prototype (SPEC §6 M5, docs/cc-slim.md): shrink a huge Bash output before it enters
// the context. Pure and deterministic. Rules, in order of priority:
//   1. never drop a failure line (error/fail/✗/Traceback/panic/non-zero exit…), keep it verbatim
//      with a little context around it;
//   2. keep the first `headLines` and last `tailLines` lines;
//   3. collapse runs of identical lines and stack frames already printed above, with counts;
//   4. replace everything else with "… N lines omitted" markers.
// Outputs at or under `threshold` chars, and outputs already compressed, are returned unchanged.
// No savings are claimed here; bench/slim.ts measures what it does on synthetic outputs.

export const SLIM_MARKER = '[cc-slim]';

export interface SlimOptions {
  /** Only outputs longer than this many chars are compressed. Default 20,000. */
  threshold?: number;
  headLines?: number;
  tailLines?: number;
  /** Lines kept before and after each failure line. Default 2. */
  context?: number;
  /** Longer non-failure lines are cut in the middle. Default 2,000. */
  maxLineChars?: number;
  /** Exit code of the command, when known. Non-zero doubles the tail. */
  exitCode?: number | null;
}

export interface SlimStats {
  changed: boolean;
  inputChars: number;
  outputChars: number;
  inputLines: number;
  outputLines: number;
  /** Failure lines kept (all of them). */
  failureLines: number;
  /** Lines folded into "repeated N times" markers. */
  collapsedRepeats: number;
  /** Stack-frame lines dropped because the same frame was printed above. */
  droppedFrames: number;
  /** Other lines dropped. */
  omittedLines: number;
}

const FAILURE: RegExp[] = [
  /\bERR!|\b(errors?|fail|failed|failing|failures?|fatal|panic|panicked|exceptions?|traceback|abort(ed)?|segmentation fault|assertion)\b/i,
  /\w(Error|Exception):/,
  /[✗✘❌]|^\s*×\s/,
  /\bexit(ed)?( with)?( exit)? (code|status):? *[1-9]/i,
  /\bnon-zero exit\b/i,
];
const FRAME: RegExp[] = [
  /^\s+at\s+\S/, // JS, Java, C#
  /^\s+File "[^"]+", line \d+/, // Python
  /^\s+\S+\.(go|rs|rb|c|cc|cpp|h):\d+/, // Go, Rust, Ruby, C
  /^\s+\d+:\s+0x[0-9a-f]+|^\s+\d+:\s+\S+::/, // Rust backtrace
  /^\s+from\s+\S+:\d+/, // Ruby
];

export const isFailureLine = (l: string): boolean => FAILURE.some((re) => re.test(l));
const isFrame = (l: string, prev: string | undefined): boolean =>
  FRAME.some((re) => re.test(l)) ||
  // Python prints the source line under its frame.
  (prev !== undefined && FRAME[1]!.test(prev) && /^\s{4,}\S/.test(l));

interface Entry {
  text: string;
  /** Consecutive identical lines folded into this one. */
  count: number;
  failure: boolean;
  repeatFrame: boolean;
}

function cutLine(l: string, max: number): string {
  if (l.length <= max) return l;
  const half = Math.floor(max / 2);
  return `${l.slice(0, half)} … ${SLIM_MARKER} ${l.length - 2 * half} chars omitted … ${l.slice(-half)}`;
}

export function compressBashOutput(
  text: string,
  opts: SlimOptions = {},
): { text: string; stats: SlimStats } {
  const threshold = opts.threshold ?? 20_000;
  const head = opts.headLines ?? 30;
  const tail = (opts.tailLines ?? 60) * (opts.exitCode ? 2 : 1);
  const context = opts.context ?? 2;
  const maxLine = opts.maxLineChars ?? 2_000;
  const raw = text.split('\n');
  const stats: SlimStats = {
    changed: false,
    inputChars: text.length,
    outputChars: text.length,
    inputLines: raw.length,
    outputLines: raw.length,
    failureLines: 0,
    collapsedRepeats: 0,
    droppedFrames: 0,
    omittedLines: 0,
  };
  if (text.length <= threshold || text.startsWith(SLIM_MARKER)) return { text, stats };

  // Fold runs of identical lines, then mark stack frames already seen above.
  const entries: Entry[] = [];
  const seenFrames = new Set<string>();
  let prevRaw: string | undefined;
  for (const l of raw) {
    const last = entries[entries.length - 1];
    if (last && last.text === l) {
      last.count++;
      continue;
    }
    const failure = isFailureLine(l);
    let repeatFrame = false;
    if (!failure && isFrame(l, prevRaw)) {
      const key = l.trim();
      repeatFrame = seenFrames.has(key);
      seenFrames.add(key);
    }
    entries.push({ text: l, count: 1, failure, repeatFrame });
    prevRaw = l;
  }

  const keep = new Array<boolean>(entries.length).fill(false);
  for (let i = 0; i < entries.length; i++) {
    if (i < head || i >= entries.length - tail) keep[i] = true;
    if (entries[i]!.failure)
      for (let k = Math.max(0, i - context); k <= Math.min(entries.length - 1, i + context); k++)
        keep[k] = true;
  }

  const body: string[] = [];
  let gapLines = 0;
  let gapFrames = 0;
  const flushGap = (): void => {
    if (gapLines + gapFrames === 0) return;
    const parts: string[] = [];
    if (gapLines) parts.push(`${gapLines} lines omitted`);
    if (gapFrames) parts.push(`${gapFrames} repeated stack frames omitted (printed above)`);
    body.push(`… ${SLIM_MARKER} ${parts.join(', ')}`);
    stats.omittedLines += gapLines;
    stats.droppedFrames += gapFrames;
    gapLines = gapFrames = 0;
  };
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]!;
    if (e.failure) stats.failureLines += e.count;
    if (!e.failure && (e.repeatFrame || !keep[i])) {
      if (e.repeatFrame) gapFrames += e.count;
      else gapLines += e.count;
      continue;
    }
    flushGap();
    body.push(e.failure ? e.text : cutLine(e.text, maxLine));
    if (e.count > 1) {
      body.push(`… ${SLIM_MARKER} previous line repeated ${e.count - 1} more times`);
      stats.collapsedRepeats += e.count - 1;
    }
  }
  flushGap();

  const kept = body.join('\n');
  const header =
    `${SLIM_MARKER} Bash output compressed from ${text.length} chars / ${raw.length} lines. ` +
    `Every failure line, the first ${head} and last ${tail} lines are kept verbatim; ` +
    `the omitted lines are not available. Re-run with a narrower command if you need them.`;
  const out = `${header}\n${kept}`;
  if (out.length >= text.length) {
    // Nothing worth removing (e.g. almost every line is a failure line): leave it alone.
    return { text, stats: { ...stats, collapsedRepeats: 0, droppedFrames: 0, omittedLines: 0 } };
  }
  stats.changed = true;
  stats.outputChars = out.length;
  stats.outputLines = body.length + 1;
  return { text: out, stats };
}
