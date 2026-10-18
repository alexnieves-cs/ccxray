import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { main } from '../src/main.js';
import { VERSION } from '../src/version.js';

const FX = join(import.meta.dirname, 'fixtures', 'projects');
async function run(argv: string[]): Promise<{ code: number; out: string }> {
  let out = '';
  const code = await main(argv, (s) => (out += s));
  return { code, out };
}

describe('cli', () => {
  it('prints the version', async () => {
    const { code, out } = await run(['--version']);
    expect(code).toBe(0);
    expect(out.trim()).toBe(VERSION);
  });

  it('prints help with --help', async () => {
    expect((await run(['--help'])).out).toContain('Usage:');
  });

  it('the built bin runs', () => {
    const bin = join(import.meta.dirname, '..', 'bin', 'ccxray.js');
    expect(execFileSync(process.execPath, [bin, '--version'], { encoding: 'utf8' }).trim()).toBe(
      VERSION,
    );
  });
});

describe('doctor', () => {
  const roots = ['unknown-record-types', 'malformed-lines', 'nested-subagents-dir'].flatMap((n) => [
    '--root',
    join(FX, n),
  ]);

  it('prints counts, unknown types and quirks within 100 columns, without content', async () => {
    const { code, out } = await run(['doctor', ...roots]);
    expect(code).toBe(0);
    expect(out).toContain('Files: 5');
    expect(out).toMatch(/Lines: 44 · blank 2 · malformed 6/);
    expect(out).toMatch(/Unknown record types:\n {2}future-thing +2\n/);
    expect(out).toContain('Sessions: 5 (2 subagent) · assistant turns 9');
    expect(out).toContain('ai-title-record');
    expect(out).toContain('Persisted tool outputs: 0 · subagents linked to a tool_use: 2');
    for (const line of out.split('\n')) expect(line.length).toBeLessThanOrEqual(100);
    for (const secret of ['Use pnpm', 'Synthetic title', 'continuing', 'TODOs', 'say hi'])
      expect(out).not.toContain(secret);
  });

  it('--json prints ParseStats', async () => {
    const { code, out } = await run(['doctor', '--json', ...roots]);
    expect(code).toBe(0);
    const stats = JSON.parse(out);
    expect(stats).toMatchObject({ files: 5, lines: 44, malformedLines: 6 });
    expect(stats.unknownRecordTypes).toEqual({ 'future-thing': 2, mystery: 1, '(missing)': 1 });
  });

  it('exits 1 when no log directory exists', async () => {
    const { code, out } = await run(['doctor', '--root', join(FX, 'does-not-exist')]);
    expect(code).toBe(1);
    expect(out).toContain('No Claude Code log directories found');
  });
});
