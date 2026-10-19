// Streaming JSONL reader (SPEC §4, §8). Splits a read stream on '\n' itself (readline cannot cap a
// line's length), so it never loads a whole file and never buffers one line beyond
// `maxLineBytes`. Blank lines, malformed lines (invalid JSON, or JSON that is not an object) and
// oversized lines are counted and skipped. A trailing '\r' (CRLF) is stripped; a lone '\r' is not
// a line break (JSONL lines end in '\n'). Never rejects: read errors are counted in `readErrors`.

import { createReadStream } from 'node:fs';
import type { Rec } from './records.js';

export interface LineCounts {
  lines: number;
  blankLines: number;
  /** Includes oversized lines. */
  malformedLines: number;
  /** Lines longer than `maxLineBytes`, skipped without buffering them. */
  oversizedLines: number;
  readErrors: number;
  /** Exceptions thrown by `onRecord` (a parser bug); the line is skipped. */
  handlerErrors: number;
}

export const emptyCounts = (): LineCounts => ({
  lines: 0,
  blankLines: 0,
  malformedLines: 0,
  oversizedLines: 0,
  readErrors: 0,
  handlerErrors: 0,
});

export const MAX_LINE_BYTES = 64 * 1024 * 1024;
const BLANK = /^\s*$/;
const NL = 0x0a;

export function streamJsonl(
  file: string,
  onRecord: (rec: Rec, line: number, rawLength: number) => void,
  counts: LineCounts,
  maxLineBytes = MAX_LINE_BYTES,
): Promise<void> {
  return new Promise((resolve) => {
    let n = 0;
    let parts: Buffer[] = [];
    let partLen = 0;
    let skipping = false;
    let settled = false;
    const finish = (): void => {
      if (!settled) resolve();
      settled = true;
    };

    const oversized = (): void => {
      n++;
      counts.lines++;
      counts.malformedLines++;
      counts.oversizedLines++;
    };
    const handle = (buf: Buffer): void => {
      n++;
      counts.lines++;
      let line = buf.toString('utf8');
      if (line.charCodeAt(line.length - 1) === 0x0d) line = line.slice(0, -1);
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
        onRecord(value as Rec, n, line.length);
      } catch {
        counts.handlerErrors++;
      }
    };

    const input = createReadStream(file);
    input.on('data', (chunk: Buffer | string) => {
      const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      let start = 0;
      for (let nl = buf.indexOf(NL, start); nl !== -1; nl = buf.indexOf(NL, start)) {
        if (skipping || partLen + (nl - start) > maxLineBytes) oversized();
        else if (partLen === 0) handle(buf.subarray(start, nl));
        else handle(Buffer.concat([...parts, buf.subarray(start, nl)]));
        skipping = false;
        parts = [];
        partLen = 0;
        start = nl + 1;
      }
      if (start < buf.length && !skipping) {
        const rest = buf.subarray(start);
        if (partLen + rest.length > maxLineBytes) {
          skipping = true;
          parts = [];
          partLen = 0;
        } else {
          parts.push(rest);
          partLen += rest.length;
        }
      }
    });
    input.on('end', () => {
      if (skipping) oversized();
      else if (partLen > 0) handle(Buffer.concat(parts));
      finish();
    });
    input.on('error', () => {
      counts.readErrors++;
      finish();
    });
  });
}
