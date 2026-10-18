// `ccxray capture` (opt-in). Talks to the server over loopback only.
import { request } from 'node:http';
import { describe, expect, it } from 'vitest';
import { startCapture } from '../src/capture/index.js';
import { formatMeasurement, measureRequest } from '../src/capture/measure.js';
import { captureCommand } from '../src/commands/capture.js';
import { main } from '../src/main.js';

const KEY = 'sk-ant-api03-SECRET-test-key';
const BODY = {
  model: 'claude-test',
  system: [{ type: 'text', text: 'SYSTEM-PROMPT-CONTENT' }],
  tools: [
    { name: 'Bash', description: 'TOOL-DESCRIPTION', input_schema: { type: 'object' } },
    { name: 'mcp__gh__create_issue', description: 'x', input_schema: {} },
  ],
  messages: [{ role: 'user', content: 'USER-MESSAGE-CONTENT' }],
};

function send(
  port: number,
  headers: Record<string, string>,
  body: string,
  path = '/v1/messages?beta=true',
): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port,
        path,
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
      },
      (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode ?? 0));
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

async function start(): Promise<{ port: number; done: Promise<number>; out: () => string }> {
  let out = '';
  const h = await startCapture({ port: 0, timeoutMs: 10_000, out: (s) => (out += s) });
  return { ...h, out: () => out };
}

describe('capture: measureRequest', () => {
  it('measures sizes per section and per tool, without content', () => {
    const m = measureRequest(BODY, 1234);
    expect(m.tools.map((t) => t.name)).toEqual(['Bash', 'mcp__gh__create_issue']);
    expect(m.tools[0]!.chars).toBe(JSON.stringify(BODY.tools[0]).length);
    expect(m.toolsChars).toBe(
      JSON.stringify(BODY.tools[0]).length + JSON.stringify(BODY.tools[1]).length,
    );
    expect(m.systemChars).toBe('SYSTEM-PROMPT-CONTENT'.length);
    expect(m.messagesChars).toBe(JSON.stringify(BODY.messages).length);
    const text = formatMeasurement(m);
    expect(text).toContain('tokens [E]');
    expect(text).toContain('chars [M]');
    for (const secret of ['SYSTEM-PROMPT', 'TOOL-DESCRIPTION', 'USER-MESSAGE'])
      expect(text).not.toContain(secret);
  });

  it('tolerates odd bodies', () => {
    expect(measureRequest(null, 0)).toMatchObject({ toolsChars: 0, systemChars: 0, messages: 0 });
    expect(
      measureRequest({ system: 'abc', tools: [null, { name: 'a\u001b[31m' }] }, 0).tools.map(
        (t) => t.name,
      ),
    ).toEqual(['(unnamed)', 'a?[31m']);
  });
});

describe('capture: server', () => {
  it('binds 127.0.0.1, measures the first API-key request, never prints the key, then stops', async () => {
    const s = await start();
    expect(await send(s.port, { 'x-api-key': KEY }, '{}', '/v1/models')).toBe(404);
    expect(await send(s.port, { 'x-api-key': KEY }, JSON.stringify(BODY))).toBe(400);
    expect(await s.done).toBe(0);
    const out = s.out();
    expect(out).toContain('tools (2)');
    expect(out).toContain('mcp__gh__create_issue');
    expect(out).not.toContain(KEY);
    expect(out).not.toContain('SECRET');
    for (const secret of ['SYSTEM-PROMPT', 'TOOL-DESCRIPTION', 'USER-MESSAGE'])
      expect(out).not.toContain(secret);
  });

  it('refuses and does not record OAuth (Authorization: Bearer) requests', async () => {
    const s = await start();
    const status = await send(
      s.port,
      { authorization: 'Bearer sk-ant-oat01-OAUTH', 'x-api-key': KEY },
      JSON.stringify(BODY),
    );
    expect(status).toBe(401);
    expect(await s.done).toBe(1);
    expect(s.out()).toContain('Nothing was recorded');
    expect(s.out()).not.toContain('tools (');
    expect(s.out()).not.toContain('OAUTH');
  });

  it('refuses requests without x-api-key', async () => {
    const s = await start();
    expect(await send(s.port, {}, JSON.stringify(BODY))).toBe(401);
    expect(await s.done).toBe(1);
  });

  it('times out when no request arrives', async () => {
    let out = '';
    const h = await startCapture({ port: 0, timeoutMs: 50, out: (x) => (out += x) });
    expect(await h.done).toBe(1);
    expect(out).toContain('No request');
  });
});

describe('ccxray capture command', () => {
  it('refuses to start without the explicit flag, before loading the server', async () => {
    let out = '';
    let loaded = false;
    const code = await captureCommand(
      ['capture'],
      (s) => (out += s),
      async () => {
        loaded = true;
        throw new Error('should not load');
      },
    );
    expect(code).toBe(2);
    expect(loaded).toBe(false);
    expect(out).toContain('--i-understand-this-is-api-key-only');
    let mainOut = '';
    expect(await main(['capture'], (s) => (mainOut += s))).toBe(2);
    expect(mainOut).toContain('Refusing to start');
  });

  it('starts the server with the flag and prints the base URL', async () => {
    let out = '';
    const code = await captureCommand(
      ['capture', '--i-understand-this-is-api-key-only', '--port', '0', '--timeout', '1'],
      (s) => (out += s),
      async () => ({ startCapture: async () => ({ port: 4321, done: Promise.resolve(0) }) }),
    );
    expect(code).toBe(0);
    expect(out).toContain('ANTHROPIC_BASE_URL=http://127.0.0.1:4321');
  });
});
