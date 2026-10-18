import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { compressBashOutput, SLIM_MARKER } from '../src/slim/compress.js';

const T = { threshold: 1_000, headLines: 5, tailLines: 5 };
const filler = (n: number, tag = 'ok'): string[] =>
  Array.from({ length: n }, (_, i) => `  ${tag} line ${i} ${'.'.repeat(30)}`);

describe('compressBashOutput', () => {
  it('leaves short outputs untouched', () => {
    const text = filler(10).join('\n');
    const r = compressBashOutput(text, { threshold: 10_000 });
    expect(r.text).toBe(text);
    expect(r.stats.changed).toBe(false);
  });

  it('keeps the head and tail and replaces the middle with a counted marker', () => {
    const lines = filler(200);
    const r = compressBashOutput(lines.join('\n'), T);
    expect(r.stats.changed).toBe(true);
    expect(r.text.startsWith(SLIM_MARKER)).toBe(true);
    for (const l of [...lines.slice(0, 5), ...lines.slice(-5)]) expect(r.text).toContain(l);
    expect(r.text).not.toContain(lines[100]);
    expect(r.text).toContain(`… ${SLIM_MARKER} 190 lines omitted`);
    expect(r.stats).toMatchObject({ inputLines: 200, omittedLines: 190 });
    expect(r.text.length).toBe(r.stats.outputChars);
  });

  it('never drops failure lines, and keeps context around them', () => {
    const failures = [
      ' FAIL  src/a.test.ts > adds',
      'TypeError: x is not a function',
      'AssertionError: expected 1 to be 2',
      '  ✗ renders the footer',
      'Traceback (most recent call last):',
      "thread 'main' panicked at src/main.rs:3:5",
      'npm ERR! code ELIFECYCLE',
      'Process exited with exit code 2',
      'error[E0308]: mismatched types',
    ];
    const lines = filler(400);
    failures.forEach((f, k) => lines.splice(40 + k * 40, 0, f));
    const r = compressBashOutput(lines.join('\n'), T);
    expect(r.stats.changed).toBe(true);
    for (const f of failures) expect(r.text).toContain(f);
    expect(r.stats.failureLines).toBe(failures.length);
    const at = lines.indexOf(failures[0]!);
    expect(r.text).toContain(lines[at - 1]);
    expect(r.text).toContain(lines[at + 2]);
  });

  it('keeps a long failure line whole but cuts other long lines', () => {
    const errLine = `Error: ${'x'.repeat(5_000)}`;
    const longOk = 'y'.repeat(5_000);
    const r = compressBashOutput([longOk, errLine, ...filler(100)].join('\n'), {
      ...T,
      maxLineChars: 200,
    });
    expect(r.text).toContain(errLine);
    expect(r.text).not.toContain(longOk);
    expect(r.text).toContain('chars omitted');
  });

  it('dedupes repeated stack frames and identical lines with a count', () => {
    const frames = ['    at recurse (src/r.ts:3:9)', '    at step (src/r.ts:7:3)'];
    const lines = [
      'RangeError: Maximum call stack size exceeded',
      ...Array.from({ length: 300 }, (_, i) => frames[i % 2]!),
      ...Array.from({ length: 50 }, () => 'warning: deprecated option --foo'),
      ...filler(20),
    ];
    const r = compressBashOutput(lines.join('\n'), {
      threshold: 1_000,
      headLines: 400,
      tailLines: 400,
    });
    expect(r.stats.changed).toBe(true);
    expect(r.text.split(frames[0]!).length - 1).toBe(1);
    expect(r.text.split(frames[1]!).length - 1).toBe(1);
    expect(r.text).toContain(`… ${SLIM_MARKER} 298 repeated stack frames omitted (printed above)`);
    expect(r.text.split('warning: deprecated option --foo').length - 1).toBe(1);
    expect(r.text).toContain(`… ${SLIM_MARKER} previous line repeated 49 more times`);
    expect(r.stats).toMatchObject({ droppedFrames: 298, collapsedRepeats: 49 });
    expect(r.text).toContain('RangeError: Maximum call stack size exceeded');
  });

  it('dedupes a Python frame together with its source line', () => {
    const frame = ['  File "app.py", line 3, in f', '    return f(n - 1)'];
    const lines = [
      'Traceback (most recent call last):',
      ...Array.from({ length: 200 }, () => frame).flat(),
      'RecursionError: maximum recursion depth exceeded',
    ];
    const r = compressBashOutput(lines.join('\n'), {
      threshold: 1_000,
      headLines: 500,
      tailLines: 0,
    });
    expect(r.text.split('return f(n - 1)').length - 1).toBe(1);
    expect(r.text).toContain('RecursionError: maximum recursion depth exceeded');
  });

  it('a non-zero exit code keeps a longer tail', () => {
    const lines = filler(200);
    const r = compressBashOutput(lines.join('\n'), { ...T, exitCode: 1 });
    expect(r.text).toContain(lines[200 - 10]);
    expect(r.text).toContain('last 10 lines');
  });

  it('is idempotent', () => {
    const lines = filler(300);
    lines.splice(150, 0, 'Error: boom');
    const once = compressBashOutput(lines.join('\n'), T);
    const twice = compressBashOutput(once.text, T);
    expect(twice.text).toBe(once.text);
    expect(twice.stats.changed).toBe(false);
  });

  it('leaves output alone when nothing can be removed', () => {
    const text = Array.from({ length: 100 }, (_, i) => `error ${i}: ${'z'.repeat(20)}`).join('\n');
    const r = compressBashOutput(text, T);
    expect(r.text).toBe(text);
    expect(r.stats.changed).toBe(false);
  });
});

describe('hooks/cc-slim-posttooluse.mjs (built dist/slim.js)', () => {
  const hook = join(import.meta.dirname, '..', 'hooks', 'cc-slim-posttooluse.mjs');
  const run = (input: string, args: string[] = []): string =>
    execFileSync(process.execPath, [hook, ...args], {
      input,
      encoding: 'utf8',
      env: { ...process.env, CC_SLIM_THRESHOLD: '1000' },
    });
  const big = [...filler(300), 'Error: boom', ...filler(300)].join('\n');

  it('answers a big Bash PostToolUse with the compressed output', () => {
    const out = run(
      JSON.stringify({
        hook_event_name: 'PostToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'pnpm test' },
        tool_response: { stdout: big, stderr: '', interrupted: false, isImage: false },
      }),
    );
    const res = JSON.parse(out);
    expect(res.hookSpecificOutput.hookEventName).toBe('PostToolUse');
    const updated = res.hookSpecificOutput.updatedMCPToolOutput;
    expect(updated.stdout.startsWith(SLIM_MARKER)).toBe(true);
    expect(updated.stdout).toContain('Error: boom');
    expect(updated).toMatchObject({ stderr: '', interrupted: false });
  });

  it('prints nothing for short output, other tools and malformed input (fail open)', () => {
    const base = {
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      tool_response: { stdout: 'hi' },
    };
    expect(run(JSON.stringify(base))).toBe('');
    expect(run(JSON.stringify({ ...base, tool_name: 'Read', tool_response: big }))).toBe('');
    expect(run('not json')).toBe('');
  });

  it('--filter compresses plain stdin', () => {
    const out = run(big, ['--filter']);
    expect(out.startsWith(SLIM_MARKER)).toBe(true);
    expect(out).toContain('Error: boom');
  });
});
