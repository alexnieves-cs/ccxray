// Helpers for analyzer tests: write DSL-built sessions (scripts/make-fixture.ts) to a temp
// projects tree, load them with the real parser, and run an analyzer. All content is synthetic.
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { text, writeTree, type SessionBuilder } from '../../scripts/make-fixture.js';
import {
  DEFAULT_THRESHOLDS,
  type Analyzer,
  type AnalyzerContext,
  type Finding,
  type Session,
  type Thresholds,
} from '../../src/model/index.js';
import { loadSessions } from '../../src/parser/index.js';

const TMP = mkdtempSync(join(tmpdir(), 'ccxray-analyzers-'));
let n = 0;

export const cleanup = (): void => rmSync(TMP, { recursive: true, force: true });

/** Write builders to a fresh projects root and return its path. */
export function tree(builders: readonly SessionBuilder[]): string {
  const root = join(TMP, `r${n++}`);
  mkdirSync(root, { recursive: true });
  writeTree(root, builders);
  return root;
}

export async function load(builders: readonly SessionBuilder[]): Promise<Session[]> {
  return (await loadSessions({ roots: [tree(builders)] })).sessions;
}

export const ctx = (th: Partial<Thresholds> = {}): AnalyzerContext => ({
  thresholds: { ...DEFAULT_THRESHOLDS, ...th },
  now: new Date('2026-10-18T00:00:00.000Z'),
  includeContent: false,
});

export async function run(
  a: Analyzer,
  builders: readonly SessionBuilder[],
  th: Partial<Thresholds> = {},
): Promise<Finding[]> {
  return a.run(await load(builders), ctx(th));
}

/** A tool definition whose JSON.stringify length is exactly `chars` (28 + name + description). */
export function toolDef(name: string, chars: number): { name: string; description: string } {
  const d = chars - 28 - name.length;
  if (d < 0) throw new Error(`toolDef ${name}: ${chars} too small`);
  return { name, description: 'd'.repeat(d) };
}

export { text };
