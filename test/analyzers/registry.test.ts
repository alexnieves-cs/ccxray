// All registered analyzers over every committed fixture: deterministic, sorted, content-free.
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ANALYZERS } from '../../src/analyzers/index.js';
import { loadSessions } from '../../src/parser/index.js';
import { ctx } from '../helpers/analyze.js';

const FX = join(import.meta.dirname, '..', 'fixtures', 'projects');
const roots = readdirSync(FX).map((d) => join(FX, d));
const specNo = (s: string) => Number(s.slice(1));

describe('analyzer registry', () => {
  it('is sorted by SPEC number with unique ids', () => {
    const specs = ANALYZERS.map((a) => specNo(a.spec));
    expect(specs).toEqual([...specs].sort((a, b) => a - b));
    expect(new Set(ANALYZERS.map((a) => a.id)).size).toBe(ANALYZERS.length);
  });

  it('is deterministic and keeps prompt, file and command content out of findings', async () => {
    const runAll = async () => {
      const { sessions } = await loadSessions({ roots });
      return JSON.stringify(ANALYZERS.flatMap((a) => a.run(sessions, ctx())));
    };
    const a = await runAll();
    expect(await runAll()).toBe(a);
    // A5 (M2) shows a Bash command's first two words by design (SPEC §5), e.g. `pnpm test`; the
    // rest of a command (here `--verbose` of `pnpm build --verbose`) must never appear.
    for (const secret of ['say hi', 'Use pnpm', '--verbose', 'look around', 'Synthetic title'])
      expect(a).not.toContain(secret);
    for (const id of [
      'cache-rebuild',
      'fixed-overhead',
      'big-tool-output',
      'repeated-read',
      'tool-usage',
      'subagent-cost',
      'error-waste',
      'cross-agent-read',
    ])
      expect(a).toContain(`"analyzer":"${id}"`);
  });
});
