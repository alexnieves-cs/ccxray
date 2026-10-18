import { describe, expect, it } from 'vitest';
import {
  displayProject,
  displayRoot,
  formatCompact,
  formatDateRange,
  formatInt,
  formatPct,
  formatVersionRange,
  relSource,
  shortCommand,
  sanitizeText,
  shouldUseColor,
  truncate,
  visibleWidth,
} from '../../src/reporters/format.js';

describe('format helpers', () => {
  it('formats numbers without the host locale', () => {
    expect(formatInt(1318)).toBe('1,318');
    expect(formatInt(1_234_567)).toBe('1,234,567');
    expect(formatCompact(950)).toBe('950');
    expect(formatCompact(6_300)).toBe('6.3k');
    expect(formatCompact(31_400)).toBe('31k');
    expect(formatCompact(999_600)).toBe('1M');
    expect(formatCompact(1_200_000)).toBe('1.2M');
    expect(formatCompact(28_400_000)).toBe('28.4M');
    expect(formatCompact(2_100_000_000)).toBe('2.1B');
  });

  it('formats percentages', () => {
    expect(formatPct(24, 100)).toBe('24%');
    expect(formatPct(1, 1000)).toBe('<1%');
    expect(formatPct(0, 10)).toBe('0%');
    expect(formatPct(1, 0)).toBe('-');
  });

  it('formats UTC date ranges', () => {
    expect(formatDateRange('2026-10-11T00:30:00Z', '2026-10-18T23:59:00Z')).toBe('Oct 11–18 2026');
    expect(formatDateRange('2026-09-28T10:00:00Z', '2026-10-04T10:00:00Z')).toBe(
      'Sep 28–Oct 4 2026',
    );
    expect(formatDateRange('2025-12-30T10:00:00Z', '2026-01-02T10:00:00Z')).toBe(
      'Dec 30 2025–Jan 2 2026',
    );
    expect(formatDateRange('2026-10-18T01:00:00Z', '2026-10-18T02:00:00Z')).toBe('Oct 18 2026');
  });

  it('orders versions numerically', () => {
    expect(formatVersionRange(['2.1.100', '2.1.99', '2.1.296'])).toBe('2.1.99–2.1.296');
    expect(formatVersionRange([])).toBe('unknown version');
  });

  it('relativizes evidence paths to the projects root, never absolute', () => {
    const roots = ['/home/dev/.claude/projects', 'C:\\Users\\dev\\.claude\\projects'];
    expect(relSource({ file: '/home/dev/.claude/projects/-p/abc.jsonl', line: 3 }, roots)).toBe(
      '-p/abc.jsonl:3',
    );
    expect(
      relSource(
        { file: 'c:\\users\\dev\\.claude\\projects\\-p\\abc\\subagents\\a.jsonl', line: 9 },
        roots,
      ),
    ).toBe('-p/abc/subagents/a.jsonl:9');
    expect(relSource({ file: '/elsewhere/secret/-p/x.jsonl', line: 1 }, roots)).toBe(
      '-p/x.jsonl:1',
    );
    expect(displayRoot('/home/dev/.claude/projects', '/home/dev')).toBe('~/.claude/projects');
    expect(displayRoot('/opt/logs', '/home/dev')).toBe('/opt/logs');
  });

  it('keeps only the first two command words and never leaks assignments', () => {
    expect(shortCommand('pnpm test --reporter verbose')).toBe('pnpm test');
    expect(shortCommand('  API_KEY=sk-secret  curl -H x https://example.test ')).toBe('curl -H');
    expect(shortCommand('ls')).toBe('ls');
    expect(shortCommand('export TOKEN=sk-abc; ls')).toBe('');
    expect(shortCommand('env API_KEY=x curl https://e.test')).toBe('curl https://e.test');
    expect(shortCommand('env -i A=1 node app.js')).toBe('node app.js');
    expect(shortCommand('sudo -E apt install')).toBe('apt install');
    expect(shortCommand('FOO="a b" cmd --x')).toBe('cmd --x');
    expect(shortCommand("FOO='a; b' BAR=c cmd")).toBe('cmd');
    expect(shortCommand('curl --token=sk-abc https://e.test')).toBe('curl …');
    expect(shortCommand('git status && git push')).toBe('git status');
    expect(shortCommand('cat x | grep y')).toBe('cat x');
    expect(shortCommand('echo "a && b" more')).toBe('echo a && b');
    for (const c of ['export TOKEN=sk-abc; ls', 'env K=sk-abc x', 'a --k=sk-abc', 'K=sk-abc']) {
      expect(shortCommand(c)).not.toContain('sk-abc');
    }
  });

  it('collapses the encoded home prefix of project names', () => {
    expect(displayProject('-home-dev-src-acme-api', '/home/dev')).toBe('~-src-acme-api');
    expect(displayProject('-home-dev', '/home/dev')).toBe('~');
    expect(displayProject('-home-developer-x', '/home/dev')).toBe('-home-developer-x');
    expect(displayProject('C--Users-Dev-repo', 'c:\\users\\dev')).toBe('~-repo');
    expect(displayProject('-home-john-doe-repo', '/home/john.doe')).toBe('~-repo');
    expect(relSource({ file: '/r/-home-dev-app/s.jsonl', line: 2 }, ['/r'], '/home/dev')).toBe(
      '~-app/s.jsonl:2',
    );
    expect(displayRoot('C:\\Users\\Dev\\.claude', 'c:\\users\\dev')).toBe('~/.claude');
  });

  it('guards non-finite numbers', () => {
    expect(formatInt(NaN)).toBe('n/a');
    expect(formatCompact(Infinity)).toBe('n/a');
    expect(formatPct(NaN, 10)).toBe('n/a');
    expect(formatPct(1, Infinity)).toBe('n/a');
  });

  it('strips escapes and control characters from data strings', () => {
    expect(sanitizeText('a\x1b]0;pwned\x07b')).toBe('ab');
    expect(sanitizeText('a\x1b[2Jb\x1b[31mc')).toBe('abc');
    expect(sanitizeText('a\nb\tc\u009bd\x1be')).toBe('a b c de');
  });

  it('counts wide characters as two columns', () => {
    expect(visibleWidth('日本語')).toBe(6);
    expect(visibleWidth('a😀b')).toBe(4);
    const t = truncate('日本語のテキスト', 7);
    expect(visibleWidth(t)).toBeLessThanOrEqual(7);
    expect(t).toBe('日本語…');
  });

  it('truncates by visible width, ANSI-aware', () => {
    expect(truncate('abcdef', 4)).toBe('abc…');
    expect(truncate('abc', 4)).toBe('abc');
    const colored = truncate('\x1b[1mabcdef\x1b[22m', 4);
    expect(visibleWidth(colored)).toBe(4);
    expect(colored.endsWith('\x1b[0m')).toBe(true);
  });

  it('respects NO_COLOR, FORCE_COLOR and isTTY', () => {
    expect(shouldUseColor({}, true)).toBe(true);
    expect(shouldUseColor({}, false)).toBe(false);
    expect(shouldUseColor({ NO_COLOR: '1', FORCE_COLOR: '1' }, true)).toBe(false);
    expect(shouldUseColor({ FORCE_COLOR: '1' }, false)).toBe(true);
    expect(shouldUseColor({ FORCE_COLOR: '0' }, true)).toBe(false);
  });
});
