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

  it('dist/ contains no network calls', () => {
    expect(existsSync(DIST), 'dist/ missing: run `pnpm build` first').toBe(true);
    const files = listJs(DIST);
    expect(files.length).toBeGreaterThan(0);
    const hits = files.flatMap((f) => scanSource(readFileSync(f, 'utf8')).map((h) => `${f}: ${h}`));
    expect(hits).toEqual([]);
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
