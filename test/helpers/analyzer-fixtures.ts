// Load fixtures for analyzer tests through the real parser: committed M1 fixtures from disk, or
// synthetic DSL builders written to a temp dir. All content is synthetic.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeTree, type SessionBuilder } from '../../scripts/make-fixture.js';
import {
  DEFAULT_THRESHOLDS,
  type AnalyzerContext,
  type Session,
  type Thresholds,
} from '../../src/model/index.js';
import { loadSessions } from '../../src/parser/index.js';

export const FX = join(import.meta.dirname, '..', 'fixtures', 'projects');

let tmp: string | undefined;
export function cleanupTmp(): void {
  if (tmp !== undefined) rmSync(tmp, { recursive: true, force: true });
  tmp = undefined;
}

/** Sessions of one committed fixture (test/fixtures/projects/<name>). */
export async function fixture(...names: string[]): Promise<Session[]> {
  return (await loadSessions({ roots: names.map((n) => join(FX, n)) })).sessions;
}

/** Sessions of DSL builders, written under a fresh temp dir. */
export async function built(name: string, builders: SessionBuilder[]): Promise<Session[]> {
  tmp ??= mkdtempSync(join(tmpdir(), 'ccxray-analyzers-'));
  const root = join(tmp, name);
  writeTree(root, builders);
  return (await loadSessions({ roots: [root] })).sessions;
}

export function ctx(over: Partial<Thresholds> = {}): AnalyzerContext {
  return {
    thresholds: { ...DEFAULT_THRESHOLDS, ...over },
    now: new Date('2026-10-18T00:00:00.000Z'),
    includeContent: false,
  };
}
