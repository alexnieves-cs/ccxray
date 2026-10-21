// fp-check (scripts/fp-check.ts): sampling and the raw-line re-checks, on synthetic sessions
// built with scripts/make-fixture.ts. All content is synthetic.
import { readFileSync, writeFileSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import { session, text, toolUse, type SessionBuilder } from '../scripts/make-fixture.js';
import {
  allPassed,
  checkFinding,
  DISCLAIMER,
  formatChecks,
  indexRaw,
  sampleFindings,
} from '../scripts/fp-check.js';
import { hashId } from '../scripts/validate-real.js';
import { DEFAULT_THRESHOLDS, type Finding } from '../src/model/index.js';
import { loadSessions } from '../src/parser/index.js';
import { buildReport } from '../src/pipeline.js';
import { cleanup, toolDef, tree } from './helpers/analyze.js';

afterAll(cleanup);

const FILE = '/home/dev/app/src/secret-name.ts';

/** A cache rebuild (turn 3) and a file read 3× unchanged. */
function rebuildAndRereads(): SessionBuilder {
  const s = session('fp/main');
  s.prompt('p1').assistant({
    usage: { input: 3, cacheWrite: 20_000, output: 50 },
    blocks: [toolUse('Read', { file_path: FILE })],
  });
  s.toolResult(4000);
  s.assistant({
    usage: { input: 2, cacheWrite: 1_100, cacheRead: 20_000, output: 40 },
    blocks: [toolUse('Read', { file_path: FILE })],
  });
  s.toolResult(4000);
  s.gap('10m').prompt('p2');
  s.assistant({
    usage: { input: 3, cacheWrite: 22_000, cacheRead: 0, output: 45 },
    blocks: [toolUse('Read', { file_path: FILE })],
  });
  s.toolResult(4000);
  s.assistant({ usage: { input: 1, cacheWrite: 500, cacheRead: 22_000, output: 10 } });
  return s;
}

async function analyze(builders: SessionBuilder[]) {
  const root = tree(builders);
  const { sessions, stats } = await loadSessions({ roots: [root] });
  const report = buildReport({
    sessions,
    stats,
    ctx: { thresholds: DEFAULT_THRESHOLDS, now: new Date('2026-10-18'), includeContent: false },
    window: { since: null, until: null, project: null },
    includeContent: false,
  });
  return { root, sessions, report };
}

const by = (fs: readonly Finding[], a: string): Finding => {
  const f = fs.find((x) => x.analyzer === a);
  if (f === undefined) throw new Error(`no ${a} finding`);
  return f;
};

describe('fp-check', () => {
  it('passes evidence, measured usage and invariants when raw lines agree', async () => {
    const { sessions, report } = await analyze([rebuildAndRereads()]);
    const rebuild = by(report.findings, 'cache-rebuild');
    const c = checkFinding(rebuild, { sessions });
    expect(c).toMatchObject({ evidence: 'pass', usage: 'pass', invariant: 'pass', notes: [] });
    expect(c.session).toBe(hashId(sessions[0]!.id));
    expect(allPassed(c)).toBe(true);

    const reads = by(report.findings, 'repeated-read');
    expect(reads.tokens.kind).toBe('estimated');
    expect(checkFinding(reads, { sessions })).toMatchObject({
      evidence: 'pass',
      usage: 'n.a.',
      invariant: 'pass',
    });
  });

  it('fails the usage check when the raw usage disagrees with the finding', async () => {
    const { sessions, report } = await analyze([rebuildAndRereads()]);
    const rebuild = by(report.findings, 'cache-rebuild');
    const file = rebuild.evidence[0]!.source!.file;
    // Edit the raw transcript after parsing: the rebuild turn now claims a different write.
    const edited = readFileSync(file, 'utf8').replace(
      '"cache_creation_input_tokens":22000',
      '"cache_creation_input_tokens":21999',
    );
    expect(edited).not.toBe(readFileSync(file, 'utf8'));
    writeFileSync(file, edited);
    const c = checkFinding(rebuild, { sessions });
    expect(c.usage).toBe('fail');
    expect(c.evidence).toBe('pass');
    expect(c.notes).toContain('cache_creation_input_tokens differs');
    expect(c.notes).toContain('quoted cache_creation_input_tokens differs');
    expect(allPassed(c)).toBe(false);
  });

  it('fails the evidence check when the record is gone, and the invariant when it breaks', async () => {
    const { sessions, report } = await analyze([rebuildAndRereads()]);
    const rebuild = by(report.findings, 'cache-rebuild');
    const ghost: Finding = {
      ...rebuild,
      evidence: [{ ...rebuild.evidence[0]!, turnUuid: 'no-such-uuid' }],
    };
    expect(checkFinding(ghost, { sessions })).toMatchObject({ evidence: 'fail' });

    // Raw cache_read on the rebuild turn now equals the previous turn's: no rebuild on raw lines.
    const file = rebuild.evidence[0]!.source!.file;
    const lines = readFileSync(file, 'utf8').split('\n');
    const i = rebuild.evidence[0]!.source!.line - 1;
    lines[i] = lines[i]!.replace('"cache_read_input_tokens":0', '"cache_read_input_tokens":20000');
    writeFileSync(file, lines.join('\n'));
    const c = checkFinding(rebuild, { sessions });
    expect(c.invariant).toBe('fail');
    expect(c.usage).toBe('fail');
  });

  it('skips synthetic responses when finding the previous turn, as the analyzer does', async () => {
    const s = session('fp/synth');
    s.prompt('p1').assistant({ usage: { input: 3, cacheWrite: 20_000, output: 50 } });
    s.prompt('p2').assistant({
      usage: { input: 2, cacheWrite: 1_100, cacheRead: 20_000, output: 40 },
    });
    // A synthetic error turn (no API call, zero usage) right before the rebuild.
    s.prompt('p3').assistant({ model: '<synthetic>', usage: { input: 0, output: 0 } });
    s.gap('10m').prompt('p4');
    s.assistant({ usage: { input: 3, cacheWrite: 22_000, cacheRead: 0, output: 45 } });
    const { sessions, report } = await analyze([s]);
    const rebuild = by(report.findings, 'cache-rebuild');
    expect(checkFinding(rebuild, { sessions }).invariant).toBe('pass');
  });

  it('a failed rebuild invariant names the raw token counts it saw', async () => {
    const { sessions, report } = await analyze([rebuildAndRereads()]);
    const rebuild = by(report.findings, 'cache-rebuild');
    const file = rebuild.evidence[0]!.source!.file;
    const lines = readFileSync(file, 'utf8').split('\n');
    const i = rebuild.evidence[0]!.source!.line - 1;
    lines[i] = lines[i]!.replace('"cache_read_input_tokens":0', '"cache_read_input_tokens":20000');
    writeFileSync(file, lines.join('\n'));
    const out = formatChecks([checkFinding(rebuild, { sessions })], 1).join('\n');
    expect(out).toMatch(/prev read 20000 → read 20000, write 22000, prev context \d+, gap \d+s/);
  });

  it('fails repeated-read when the raw Reads do not repeat the path', async () => {
    const { sessions, report } = await analyze([rebuildAndRereads()]);
    const reads = by(report.findings, 'repeated-read');
    const file = reads.evidence[0]!.source!.file;
    const raw = readFileSync(file, 'utf8');
    let n = 0;
    writeFileSync(
      file,
      raw.replace(/secret-name\.ts/g, (m) => (n++ === 0 ? m : `other-${n}.ts`)),
    );
    expect(checkFinding(reads, { sessions }).invariant).toBe('fail');
  });

  it("strict pointer: fails when the evidence line is not the uuid record's own line", async () => {
    const { sessions, report } = await analyze([rebuildAndRereads()]);
    const rebuild = by(report.findings, 'cache-rebuild');
    const ev = rebuild.evidence[0]!;
    expect(checkFinding(rebuild, { sessions }).evidence).toBe('pass');
    const moved: Finding = {
      ...rebuild,
      evidence: [{ ...ev, source: { ...ev.source!, line: ev.source!.line - 1 } }],
    };
    const c = checkFinding(moved, { sessions });
    expect(c.evidence).toBe('fail');
    expect(c.notes).toContain('evidence line pointer off');
  });

  it('snapshot pointer: fixed-overhead and tool-usage may point at a prompt_snapshot in the same file', async () => {
    const s = session('fp/snap')
      .attachment({
        type: 'prompt_snapshot',
        systemPrompt: ['x'.repeat(50)],
        tools: [toolDef('Bash', 200), toolDef('mcp__github__create_issue', 700)],
      })
      .prompt('hi')
      .assistant({ usage: { input: 4, cacheWrite: 15_000 }, blocks: [toolUse('Bash', {})] });
    s.toolResult(10);
    s.assistant({ usage: { input: 1, cacheWrite: 100, cacheRead: 15_000 } });
    const { sessions, report } = await analyze([s]);
    for (const a of ['fixed-overhead', 'tool-usage']) {
      const fs = report.findings.filter((x) => x.analyzer === a);
      const snapEv = fs.flatMap((x) => x.evidence).find((e) => e.source?.line === 1);
      expect(snapEv, a).toBeDefined(); // line 1 is the prompt_snapshot attachment
      const f = fs.find((x) => x.evidence.includes(snapEv!))!;
      expect(checkFinding(f, { sessions }).evidence, a).toBe('pass');
      // The same pointer moved to a non-snapshot line (the prompt) fails.
      const off: Finding = {
        ...f,
        evidence: [{ ...snapEv!, source: { ...snapEv!.source!, line: 2 } }],
      };
      expect(checkFinding(off, { sessions }).evidence, a).toBe('fail');
    }
    // Any other analyzer pointing at the snapshot instead of the turn's own line fails.
    const tu = report.findings.find((x) => x.analyzer === 'tool-usage')!;
    const other: Finding = {
      ...tu,
      analyzer: 'cache-rebuild',
      evidence: [tu.evidence.find((e) => e.source?.line === 1)!],
    };
    const c = checkFinding(other, { sessions });
    expect(c.evidence).toBe('fail');
    expect(c.notes).toContain('evidence line pointer off');
  });

  it('samples round-robin by analyzer, highest impact first, deterministically', () => {
    const f = (analyzer: string, usd: number, tokens = 0): Finding => ({
      analyzer,
      severity: 'info',
      title: `${analyzer} ${usd}`,
      tokens: { value: tokens, kind: 'measured' },
      evidence: [],
      fix: { summary: '' },
      impact: {
        costUsd: usd,
        savingsUsd: usd,
        basis: '',
        confidence: 'measured-tokens',
        savingsMainUsd: usd,
        savingsSubagentUsd: 0,
      },
    });
    const all = [
      f('repeated-read', 1),
      f('repeated-read', 5),
      f('repeated-read', 3),
      f('cache-rebuild', 2),
      f('zzz-unknown', 9),
    ];
    const pick = sampleFindings(all, 4).map((x) => x.title);
    expect(pick).toEqual([
      'cache-rebuild 2',
      'repeated-read 5',
      'zzz-unknown 9',
      'repeated-read 3',
    ]);
    expect(sampleFindings([...all].reverse(), 4).map((x) => x.title)).toEqual(pick);
    expect(sampleFindings(all, 100)).toHaveLength(5);
  });

  it('prints counts and hashed ids only, with the disclaimer', async () => {
    const { root, sessions, report } = await analyze([rebuildAndRereads()]);
    const checks = sampleFindings(report.findings).map((x) => checkFinding(x, { sessions }));
    const out = formatChecks(checks, report.findings.length).join('\n');
    expect(out).toContain(`SUMMARY: ${checks.length} findings checked`);
    expect(out).toContain(DISCLAIMER);
    expect(out).not.toContain('secret-name');
    expect(out).not.toContain(root);
    expect(out).not.toContain(sessions[0]!.id);
    expect(out).not.toMatch(/p1|p2/);
  });

  it('indexes raw lines defensively', () => {
    const r = indexRaw(
      [
        'not json',
        '[1,2]',
        JSON.stringify({
          type: 'assistant',
          uuid: 'u1',
          message: { id: 'm', usage: { input_tokens: 'x' } },
        }),
        '',
      ].join('\n'),
    );
    expect(r.recs).toHaveLength(1);
    expect(r.byUuid.get('u1')?.line).toBe(3);
    expect(r.byUuid.get('u1')?.usage).toEqual({ input: 0, cacheWrite: 0, cacheRead: 0, output: 0 });
  });

  it('keeps synthetic text out of indexes (no content stored)', () => {
    const s = session('fp/text')
      .prompt('hello')
      .assistant({ blocks: [text('private words')] });
    const r = indexRaw(s.toJsonl());
    expect(JSON.stringify(r.recs)).not.toContain('private words');
  });
});
