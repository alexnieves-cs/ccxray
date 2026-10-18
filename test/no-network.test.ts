// CLAUDE.md hard rule 1: nothing in the runtime code may make a network call.
// This scans the built bundle (dist/) and package.json. `pnpm test` builds first.
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..');
const DIST = join(ROOT, 'dist');

const NETWORK_MODULES = ['http', 'https', 'net', 'tls', 'dgram', 'http2', 'dns', 'undici'];
const moduleAlt = NETWORK_MODULES.join('|');
const PATTERNS: { name: string; re: RegExp }[] = [
  {
    name: 'import of a network module',
    re: new RegExp(`from\\s*["'](?:node:)?(?:${moduleAlt})(?:/[^"']*)?["']`),
  },
  {
    name: 'require of a network module',
    re: new RegExp(`require\\(\\s*["'](?:node:)?(?:${moduleAlt})(?:/[^"']*)?["']\\s*\\)`),
  },
  {
    name: 'dynamic import of a network module',
    re: new RegExp(`import\\(\\s*["'](?:node:)?(?:${moduleAlt})(?:/[^"']*)?["']\\s*\\)`),
  },
  { name: 'fetch()', re: /(?<![\w$.])fetch\s*\(/ },
  { name: 'globalThis.fetch', re: /globalThis\s*\.\s*fetch/ },
  { name: 'XMLHttpRequest', re: /\bXMLHttpRequest\b/ },
  { name: 'WebSocket', re: /\bnew\s+WebSocket\b/ },
  { name: 'EventSource', re: /\bnew\s+EventSource\b/ },
];

export function scanSource(src: string): string[] {
  return PATTERNS.filter((p) => p.re.test(src)).map((p) => p.name);
}

const CAPTURE = join(DIST, 'capture.js');
const OUTBOUND: { name: string; re: RegExp }[] = [
  { name: 'http.request', re: /\bhttps?\s*\.\s*(request|get)\s*\(/ },
  { name: 'https.request', re: /\bhttps\s*\.\s*request/ },
  { name: 'fetch(', re: /(?<![\w$.])fetch\s*\(|\.fetch\s*\(/ },
  { name: 'net.connect', re: /\b(net|tls)\s*\.\s*(connect|createConnection)\s*\(/ },
  { name: 'tls.connect', re: /\btls\s*\.\s*connect/ },
  { name: 'createConnection', re: /\bcreateConnection\b/ },
  { name: 'undici', re: /undici/ },
  { name: 'WebSocket', re: /\bWebSocket\b/ },
  { name: 'import of node:https', re: /["'](?:node:)?(https|net|tls|dgram|http2|dns)["']/ },
];

/** Problems in the capture bundle: outbound calls, other network modules, non-loopback listen. */
export function scanCapture(src: string): string[] {
  const hits = OUTBOUND.filter((p) => p.re.test(src)).map((p) => p.name);
  for (const m of src.matchAll(/\.listen\(([^)]*)\)/g))
    if (!/^\s*[\w$.]+\s*,\s*["']127\.0\.0\.1["']/.test(m[1]!))
      hits.push('listen without 127.0.0.1');
  return hits;
}

function listJs(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...listJs(p));
    else if (/\.(c|m)?js$/.test(name)) out.push(p);
  }
  return out;
}

describe('no-network', () => {
  it('the scanner itself detects network use (self-test)', () => {
    expect(scanSource(`import http from "node:http";`)).toContain('import of a network module');
    expect(scanSource(`const x = require('https')`)).toContain('require of a network module');
    expect(scanSource(`await import("undici")`)).toContain('dynamic import of a network module');
    expect(scanSource(`await fetch(url)`)).toContain('fetch()');
    expect(scanSource(`globalThis.fetch(u)`)).toContain('globalThis.fetch');
    expect(scanSource(`new WebSocket(u)`)).toContain('WebSocket');
    expect(scanSource(`import { readFile } from "node:fs"; prefetch(x); obj.fetch(1)`)).toEqual([]);
  });

  it('dist/ contains no network calls (except the allowlisted capture bundle)', () => {
    expect(existsSync(DIST), 'dist/ missing: run `pnpm build` first').toBe(true);
    const files = listJs(DIST).filter((f) => f !== CAPTURE);
    expect(files.length).toBeGreaterThan(0);
    expect(files).toContain(join(DIST, 'cli.js'));
    const hits = files.flatMap((f) => scanSource(readFileSync(f, 'utf8')).map((h) => `${f}: ${h}`));
    expect(hits).toEqual([]);
  });

  // `ccxray capture` (opt-in, docs/capture.md) is the single allowlisted file: a local listener
  // that may import node:http, but must never open an outbound connection or bind beyond loopback.
  it('dist/capture.js only listens on 127.0.0.1 and makes no outbound calls', () => {
    expect(existsSync(CAPTURE), 'dist/capture.js missing: run `pnpm build` first').toBe(true);
    const src = readFileSync(CAPTURE, 'utf8');
    expect(scanCapture(src)).toEqual([]);
    expect(src).toMatch(/\.listen\(/);
  });

  it('the capture scanner detects outbound calls and non-loopback binds (self-test)', () => {
    const ok = `import { createServer } from "node:http";\nserver.listen(opts.port, "127.0.0.1", cb);`;
    expect(scanCapture(ok)).toEqual([]);
    expect(scanCapture(`${ok}\nhttp.request(u)`)).toContain('http.request');
    expect(scanCapture(`${ok}\nawait fetch(u)`)).toContain('fetch(');
    expect(scanCapture(`${ok}\nnet.connect(1)`)).toContain('net.connect');
    expect(scanCapture(`${ok}\nimport("undici")`)).toContain('undici');
    expect(scanCapture(`${ok}\nserver.listen(8080)`)).toContain('listen without 127.0.0.1');
    expect(scanCapture(`${ok}\nserver.listen(p, "0.0.0.0")`)).toContain('listen without 127.0.0.1');
    expect(scanCapture(`import https from "node:https";`)).toContain('import of node:https');
  });

  it('runtime dependencies are on the allowlist', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
    };
    const allow = new Set(
      (JSON.parse(readFileSync(join(ROOT, 'deps-allowlist.json'), 'utf8')) as { runtime: string[] })
        .runtime,
    );
    const deps = Object.keys({
      ...pkg.dependencies,
      ...pkg.optionalDependencies,
      ...pkg.peerDependencies,
    });
    expect(deps.filter((d) => !allow.has(d))).toEqual([]);
  });
});
