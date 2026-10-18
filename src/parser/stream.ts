// Streaming JSONL reader (SPEC §4, §8). readline over a read stream: never loads a whole file.
// Blank and malformed lines (invalid JSON, or JSON that is not an object) are counted and
// skipped. Never rejects: read errors are counted in `readErrors`.

import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import type { Rec } from './records.js';

export interface LineCounts {
  lines: number;
  blankLines: number;
  malformedLines: number;
  readErrors: number;
  /** Exceptions thrown by `onRecord` (a parser bug); the line is skipped. */
  handlerErrors: number;
}

export const emptyCounts = (): LineCounts => ({
  lines: 0,
  blankLines: 0,
  malformedLines: 0,
  readErrors: 0,
  handlerErrors: 0,
});

const BLANK = /^\s*$/;

export function streamJsonl(
  file: string,
  onRecord: (rec: Rec, line: number) => void,
  counts: LineCounts,
): Promise<void> {
  return new Promise((resolve) => {
    const input = createReadStream(file);
    const rl = createInterface({ input, crlfDelay: Infinity });
    let n = 0;
    let failed = false;
    // readline re-emits input errors on the interface; handle both, count once.
    const fail = (): void => {
      if (!failed) counts.readErrors++;
      failed = true;
      rl.close();
    };
    input.on('error', fail);
    rl.on('error', fail);
    rl.on('line', (line) => {
      n++;
      counts.lines++;
      if (n === 1 && line.charCodeAt(0) === 0xfeff) line = line.slice(1);
      if (BLANK.test(line)) {
        counts.blankLines++;
        return;
      }
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        counts.malformedLines++;
        return;
      }
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        counts.malformedLines++;
        return;
      }
      try {
        onRecord(value as Rec, n);
      } catch {
        counts.handlerErrors++;
      }
    });
    rl.on('close', () => resolve());
  });
}
