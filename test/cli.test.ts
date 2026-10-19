import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { main } from '../src/main.js';
import { VERSION } from '../src/version.js';

describe('cli', () => {
  it('prints the version', () => {
    let out = '';
    expect(main(['--version'], (s) => (out += s))).toBe(0);
    expect(out.trim()).toBe(VERSION);
  });

  it('prints help by default', () => {
    let out = '';
    main([], (s) => (out += s));
    expect(out).toContain('Usage:');
  });

  it('the built bin runs', () => {
    const bin = join(import.meta.dirname, '..', 'bin', 'ccxray.js');
    expect(execFileSync(process.execPath, [bin, '--version'], { encoding: 'utf8' }).trim()).toBe(
      VERSION,
    );
  });
});
