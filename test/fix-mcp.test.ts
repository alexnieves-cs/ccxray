import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fixCommand } from '../src/commands/fix-mcp.js';
import { unifiedDiff } from '../src/fix/diff.js';
import { planMcpDeny } from '../src/fix/mcp.js';
import { main } from '../src/main.js';
import type { Finding } from '../src/model/index.js';

function usage(server: string, unused: string[], used: string[] = [], defChars?: number): Finding {
  return {
    analyzer: 'tool-usage',
    severity: 'info',
    title: `unused tools in ${server}`,
    tokens: { value: unused.length, kind: 'measured' },
    data: {
      server,
      unusedTools: unused.map((t) => `mcp__${server}__${t}`),
      usedTools: used.map((t) => `mcp__${server}__${t}`),
      ...(defChars !== undefined ? { defChars } : {}),
    },
    evidence: [],
    fix: { summary: '' },
  };
}

/** Apply a unified diff (as produced by unifiedDiff) to `before`; throws on a context mismatch. */
function applyPatch(before: string, diff: string): string {
  const src = before === '' ? [] : before.replace(/\n$/, '').split('\n');
  const out: string[] = [];
  let pos = 0;
  const lines = diff.replace(/\n$/, '').split('\n').slice(2);
  for (let i = 0; i < lines.length; i++) {
    const h = /^@@ -(\d+),(\d+) \+\d+,\d+ @@$/.exec(lines[i]!);
    if (!h) throw new Error(`bad hunk header: ${lines[i]}`);
    const start = Number(h[2]) === 0 ? Number(h[1]) : Number(h[1]) - 1;
    while (pos < start) out.push(src[pos++]!);
    while (i + 1 < lines.length && !lines[i + 1]!.startsWith('@@')) {
      const l = lines[++i]!;
      if (l.startsWith('\\')) continue;
      if (l[0] === '+') out.push(l.slice(1));
      else {
        if (src[pos] !== l.slice(1)) throw new Error(`context mismatch at ${pos}: ${l}`);
        if (l[0] === ' ') out.push(src[pos]!);
        pos++;
      }
    }
  }
  while (pos < src.length) out.push(src[pos++]!);
  return `${out.join('\n')}\n`;
}

const EXISTING = `${JSON.stringify(
  {
    model: 'opus',
    permissions: {
      allow: ['Bash(pnpm test:*)'],
      deny: ['Read(./.env)', 'mcp__github__delete_repo'],
      ask: [],
    },
    env: { FOO: '1' },
  },
  null,
  2,
)}\n`;

describe('planMcpDeny', () => {
  const findings = [
    usage('github', ['create_issue', 'delete_repo', 'list_prs'], ['get_issue']),
    usage('slack', ['post', 'search'], [], 4000),
  ];

  it('merges into existing settings, keeps other keys and their order, adds no duplicates', () => {
    const plan = planMcpDeny(findings, EXISTING, { label: '.claude/settings.local.json' });
    expect(plan.added).toEqual([
      'mcp__github__create_issue',
      'mcp__github__list_prs',
      'mcp__slack',
    ]);
    expect(Object.keys(plan.settings)).toEqual(['model', 'permissions', 'env']);
    const perms = plan.settings.permissions as Record<string, unknown>;
    expect(Object.keys(perms)).toEqual(['allow', 'deny', 'ask']);
    expect(perms.allow).toEqual(['Bash(pnpm test:*)']);
    expect(perms.deny).toEqual([
      'Read(./.env)',
      'mcp__github__delete_repo',
      'mcp__github__create_issue',
      'mcp__github__list_prs',
      'mcp__slack',
    ]);
    expect(plan.servers.find((s) => s.server === 'slack')).toMatchObject({ defChars: 4000 });
  });

  it('the diff applies to the original and yields valid JSON equal to the merged settings', () => {
    const plan = planMcpDeny(findings, EXISTING);
    expect(plan.diff).toMatch(/^--- a\/settings\.json\n\+\+\+ b\/settings\.json\n@@ /);
    const patched = applyPatch(EXISTING, plan.diff);
    expect(patched).toBe(plan.text);
    expect(JSON.parse(patched)).toEqual(plan.settings);
    // The only removed lines are existing lines that gained a trailing comma.
    const diffLines = plan.diff.split('\n');
    const plus = new Set(diffLines.filter((l) => l.startsWith('+')).map((l) => l.slice(1)));
    const minus = diffLines.filter((l) => l.startsWith('-') && !l.startsWith('---'));
    expect(minus.length).toBeGreaterThan(0);
    for (const l of minus) expect(plus.has(`${l.slice(1)},`)).toBe(true);
  });

  it('is idempotent: a second run adds nothing and has an empty diff', () => {
    const first = planMcpDeny(findings, EXISTING);
    const second = planMcpDeny(findings, first.text);
    expect(second.added).toEqual([]);
    expect(second.diff).toBe('');
    expect(second.text).toBe(first.text);
  });

  it('creates permissions.deny in a missing or empty file, and keeps tab indentation', () => {
    const fresh = planMcpDeny(findings, null);
    expect(JSON.parse(fresh.text)).toEqual({
      permissions: {
        deny: [
          'mcp__github__create_issue',
          'mcp__github__delete_repo',
          'mcp__github__list_prs',
          'mcp__slack',
        ],
      },
    });
    expect(applyPatch('', fresh.diff)).toBe(fresh.text);
    const tabs = planMcpDeny(findings, '{\n\t"model": "opus"\n}\n');
    expect(tabs.text).toContain('\n\t"permissions"');
    expect(Object.keys(tabs.settings)).toEqual(['model', 'permissions']);
  });

  it('uses per-tool rules with serverRules: false and respects existing server rules', () => {
    const perTool = planMcpDeny([usage('slack', ['post', 'search'])], null, { serverRules: false });
    expect(perTool.added).toEqual(['mcp__slack__post', 'mcp__slack__search']);
    const covered = planMcpDeny(
      [usage('slack', ['post']), usage('jira', ['a'])],
      '{"permissions":{"deny":["mcp__slack__*","mcp__jira"]}}',
    );
    expect(covered.added).toEqual([]);
  });

  it('never denies a tool that was used, and ignores malformed findings and odd names', () => {
    const plan = planMcpDeny(
      [
        usage('gh', ['a', 'b'], ['x']),
        usage('gh', [], ['a']),
        { ...usage('bad', ['a']), data: { server: 'bad', unusedTools: 'nope' } },
        {
          ...usage('evil', ['a']),
          data: { server: 'evil', unusedTools: ['Bash(rm:*)'], usedTools: [] },
        },
        { ...usage('sp ace', ['a']) },
        { ...usage('o', ['a']), analyzer: 'something-else' },
      ],
      null,
    );
    expect(plan.added).toEqual(['mcp__gh__b']);
    expect(plan.skipped).toHaveLength(3);
    expect(plan.skipped.join(' ')).not.toContain('rm:');
  });

  it('refuses invalid or comment-bearing JSON and wrong shapes', () => {
    const f = [usage('gh', ['a'])];
    expect(() => planMcpDeny(f, '{ // comment\n}')).toThrow(/not valid JSON/);
    expect(() => planMcpDeny(f, '[]')).toThrow(/not a JSON object/);
    expect(() => planMcpDeny(f, '{"permissions": []}')).toThrow(/not an object/);
    expect(() => planMcpDeny(f, '{"permissions": {"deny": "x"}}')).toThrow(/not an array/);
  });
});

describe('unifiedDiff', () => {
  it('marks a missing final newline and is empty for equal inputs', () => {
    expect(unifiedDiff('a\n', 'a\n', { from: 'a', to: 'b' })).toBe('');
    const d = unifiedDiff('{}', '{\n  "x": 1\n}\n', { from: 'a', to: 'b' });
    expect(d).toContain('-{}\n\\ No newline at end of file\n+{\n');
  });
});

describe('ccxray fix mcp', () => {
  const findings = [usage('github', ['create_issue'], ['get_issue']), usage('slack', ['post'])];
  const now = new Date('2026-10-18T12:34:56.789Z');
  function setup(content: string | null): { cwd: string; file: string } {
    const cwd = mkdtempSync(join(tmpdir(), 'ccxray-fix-'));
    const file = join(cwd, '.claude', 'settings.local.json');
    if (content !== null) {
      mkdirSync(join(cwd, '.claude'));
      writeFileSync(file, content);
    }
    return { cwd, file };
  }
  async function run(argv: string[], cwd: string): Promise<{ code: number; out: string }> {
    let out = '';
    const code = await fixCommand(argv, (s) => (out += s), {
      cwd,
      now,
      loadFindings: async () => findings,
    });
    return { code, out };
  }

  it('without --apply prints the diff and writes nothing', async () => {
    const { cwd, file } = setup(EXISTING);
    const { code, out } = await run(['fix', 'mcp'], cwd);
    expect(code).toBe(0);
    expect(out).toContain(`target ${join('.claude', 'settings.local.json')}`);
    expect(out).toContain('+      "mcp__github__create_issue",');
    expect(out).toContain('Dry run: nothing was written');
    expect(readFileSync(file, 'utf8')).toBe(EXISTING);
    expect(readdirSync(join(cwd, '.claude'))).toEqual(['settings.local.json']);
  });

  it('without --apply does not create a missing settings file', async () => {
    const { cwd, file } = setup(null);
    expect((await run(['fix', 'mcp'], cwd)).out).toContain('(new file)');
    expect(existsSync(file)).toBe(false);
  });

  it('--apply writes a timestamped backup first, then valid JSON; a rerun is a no-op', async () => {
    const { cwd, file } = setup(EXISTING);
    const { code, out } = await run(['fix', 'mcp', '--apply'], cwd);
    expect(code).toBe(0);
    const backup = `${file}.ccxray-backup-2026-10-18T12-34-56-789Z`;
    expect(readFileSync(backup, 'utf8')).toBe(EXISTING);
    expect(out).toContain('Wrote 2 deny rule(s)');
    const written = JSON.parse(readFileSync(file, 'utf8'));
    expect(written.permissions.deny).toEqual([
      'Read(./.env)',
      'mcp__github__delete_repo',
      'mcp__github__create_issue',
      'mcp__slack',
    ]);
    const again = await run(['fix', 'mcp', '--apply'], cwd);
    expect(again.out).toContain('Nothing to add');
    expect(readdirSync(join(cwd, '.claude')).sort()).toEqual([
      'settings.local.json',
      'settings.local.json.ccxray-backup-2026-10-18T12-34-56-789Z',
    ]);
  });

  it('--settings targets another file; invalid JSON is reported and left untouched', async () => {
    const { cwd } = setup(null);
    writeFileSync(join(cwd, 'custom.json'), '{ "a": 1, }');
    const { code, out } = await run(['fix', 'mcp', '--settings', 'custom.json', '--apply'], cwd);
    expect(code).toBe(2);
    expect(out).toContain('custom.json: settings file is not valid JSON');
    expect(readFileSync(join(cwd, 'custom.json'), 'utf8')).toBe('{ "a": 1, }');
  });

  it('is routed from main (usage without a subcommand)', async () => {
    let out = '';
    expect(await main(['fix'], (s) => (out += s))).toBe(2);
    expect(out).toContain('Usage: ccxray fix mcp');
  });
});
