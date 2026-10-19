// End to end: the built CLI runs `fix mcp` (dry run) through the real pipeline (loadSessions →
// buildReport → A7) on a synthetic fixture with an unused MCP server.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { session, toolUse, writeTree } from '../scripts/make-fixture.js';
import { toolDef } from './helpers/analyze.js';

const TMP = mkdtempSync(join(tmpdir(), 'ccxray-fix-cli-'));
afterAll(() => rmSync(TMP, { recursive: true, force: true }));
const BIN = join(import.meta.dirname, '..', 'bin', 'tknxray.js');

describe('built CLI: tknxray fix mcp', () => {
  it('prints a permissions.deny diff for an unused MCP server and writes nothing', () => {
    const root = join(TMP, 'projects');
    const cwd = join(TMP, 'work');
    mkdirSync(root, { recursive: true });
    mkdirSync(cwd, { recursive: true });
    const s = session('fix-cli/unused-mcp').prompt('go');
    s.assistant({ blocks: [toolUse('mcp__github__list_prs')] }).toolResult(10);
    s.attachment({
      type: 'prompt_snapshot',
      tools: [
        toolDef('Bash', 100),
        toolDef('mcp__github__list_prs', 200),
        toolDef('mcp__github__create_issue', 300),
        toolDef('mcp__linear__search', 100),
      ],
    });
    writeTree(root, [s]);

    const out = execFileSync(
      process.execPath,
      [BIN, 'fix', 'mcp', '--root', root, '--since', '2026-01-01'],
      { cwd, encoding: 'utf8' },
    );
    expect(out).toContain('--- ');
    expect(out).toContain('+++ ');
    expect(out).toMatch(/^\+.*"mcp__linear"/m);
    expect(out).toMatch(/^\+.*"mcp__github__create_issue"/m);
    expect(out).not.toMatch(/^\+.*"mcp__github__list_prs"/m);
    expect(existsSync(join(cwd, '.claude', 'settings.local.json'))).toBe(false);
  });
});
