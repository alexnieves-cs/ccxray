// Every threshold is documented in docs/THRESHOLDS.md and read by some analyzer or command.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_THRESHOLDS } from '../src/model/index.js';

const ROOT = join(import.meta.dirname, '..');
const doc = readFileSync(join(ROOT, 'docs', 'THRESHOLDS.md'), 'utf8');
const code = ['analyzers', 'commands']
  .flatMap((d) =>
    readdirSync(join(ROOT, 'src', d))
      .filter((f) => f.endsWith('.ts'))
      .map((f) => join(ROOT, 'src', d, f)),
  )
  .map((f) => readFileSync(f, 'utf8'))
  .join('\n');

describe('thresholds', () => {
  for (const [key, value] of Object.entries(DEFAULT_THRESHOLDS)) {
    it(`${key} is documented with its default`, () => {
      const row = doc.split('\n').find((l) => l.startsWith(`| \`${key}\` |`));
      expect(row, `docs/THRESHOLDS.md has no row for ${key}`).toBeDefined();
      expect(row!.split('|')[2]!.trim().split(' ')[0]).toBe(String(value));
    });
    it(`${key} is used by an analyzer or command`, () => {
      expect(code).toMatch(new RegExp(`\\b${key}\\b`));
    });
  }
});
