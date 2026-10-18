import { describe, expect, it } from 'vitest';
import { scrubJsonl, Scrubber } from '../scripts/scrub-fixture.js';

const line = JSON.stringify({
  type: 'assistant',
  uuid: '3f2b1c4d-1111-4222-8333-944445555666',
  sessionId: '9a8b7c6d-1111-4222-8333-944445555666',
  timestamp: '2026-10-18T10:00:05.000Z',
  requestId: 'req_011CUabcdefghijklmnop123',
  cwd: '/Users/alex/secret-project',
  version: '2.1.302',
  message: {
    id: 'msg_01ABCdefGHIjklMNOpqrSTU1',
    model: 'claude-opus-5-5',
    content: [
      {
        type: 'tool_use',
        id: 'toolu_01XYZabcDEFghiJKLmnoPQR2',
        name: 'Bash',
        input: { command: 'pnpm test --silent' },
      },
    ],
    usage: {
      input_tokens: 3,
      cache_creation_input_tokens: 1200,
      cache_read_input_tokens: 45000,
      output_tokens: 87,
    },
  },
});

describe('scrub-fixture', () => {
  it('keeps structure, numbers and lengths but not text', () => {
    const { output, leaks } = scrubJsonl(line, { salt: 's' });
    expect(leaks).toBe(0);
    const o = JSON.parse(output);
    expect(o.message.usage).toEqual({
      input_tokens: 3,
      cache_creation_input_tokens: 1200,
      cache_read_input_tokens: 45000,
      output_tokens: 87,
    });
    expect(o.message.model).toBe('claude-opus-5-5');
    expect(o.version).toBe('2.1.302');
    expect(o.message.content[0].name).toBe('Bash');
    expect(o.message.id).toMatch(/^msg_[0-9a-f]+$/);
    expect(o.message.id).toHaveLength('msg_01ABCdefGHIjklMNOpqrSTU1'.length);
    expect(o.requestId.startsWith('req_')).toBe(true);
    expect(o.uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(o.cwd).toHaveLength('/Users/alex/secret-project'.length);
    expect(o.cwd).not.toContain('alex');
    expect(o.cwd.split('/')).toHaveLength(4);
    expect(o.message.content[0].input.command.split(' ')).toHaveLength(3);
    expect(o.timestamp).toBe('2026-01-01T00:00:00.000Z');
  });

  it('is deterministic for a salt and keeps equal strings equal', () => {
    const sc = new Scrubber({ salt: 'k' });
    expect(sc.scrubText('/a/b/file.ts')).toBe(sc.scrubText('/a/b/file.ts'));
    expect(new Scrubber({ salt: 'other' }).scrubText('/a/b/file.ts')).not.toBe(
      sc.scrubText('/a/b/file.ts'),
    );
  });

  it('keeps relative time between lines', () => {
    const a = JSON.stringify({ type: 'user', timestamp: '2026-10-18T10:00:00.000Z' });
    const b = JSON.stringify({ type: 'user', timestamp: '2026-10-18T10:07:30.000Z' });
    const out = scrubJsonl(`${a}\n${b}`, { salt: 's' })
      .output.split('\n')
      .map((l) => JSON.parse(l));
    expect(Date.parse(out[1].timestamp) - Date.parse(out[0].timestamp)).toBe(450_000);
  });

  it('does not treat usage keys as ids', () => {
    const o = JSON.parse(
      scrubJsonl(JSON.stringify({ usage: { input_tokens: 1 } }), { salt: 's' }).output,
    );
    expect(o.usage.input_tokens).toBe(1);
  });

  it('scrubs malformed lines instead of copying them', () => {
    const { output } = scrubJsonl('{"type": "user", secret text', { salt: 's' });
    expect(output).not.toContain('secret');
  });
});
