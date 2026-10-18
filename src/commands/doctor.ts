// `ccxray doctor`: what the parser found. Counts only, never content (CLAUDE.md hard rule 4).

import { defaultRoots } from '../discover.js';
import { loadSessions } from '../parser/index.js';
import { quirksFor } from '../parser/quirks.js';

const WIDTH = 100;
const n = (x: number): string => x.toLocaleString('en-US');
/** Keep a line within WIDTH columns, eliding the middle (paths keep both ends). */
const fit = (s: string): string =>
  s.length <= WIDTH ? s : `${s.slice(0, 40)}…${s.slice(s.length - (WIDTH - 41))}`;

function table(title: string, m: Record<string, number>): string[] {
  const rows = Object.entries(m).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  if (rows.length === 0) return [`${title}: none`];
  const w = Math.min(60, Math.max(...rows.map(([k]) => k.length)));
  return [`${title}:`, ...rows.map(([k, v]) => fit(`  ${k.padEnd(w)}  ${n(v).padStart(10)}`))];
}

export async function doctor(
  opts: { roots?: string[]; json?: boolean },
  out: (s: string) => void,
): Promise<number> {
  const roots = opts.roots ?? defaultRoots();
  const { sessions, stats } = await loadSessions({ roots });
  if (opts.json) {
    out(`${JSON.stringify(stats, null, 2)}\n`);
    return stats.files > 0 ? 0 : 1;
  }
  const lines: string[] = [
    'ccxray doctor (counts only; no prompt or file content is read out)',
    '',
  ];
  if (stats.roots.length === 0) {
    lines.push(
      'No Claude Code log directories found. Checked:',
      ...roots.map((r) => fit(`  ${r}`)),
    );
    out(`${lines.join('\n')}\n`);
    return 1;
  }
  const turns = sessions.reduce((a, s) => a + s.turns.length, 0);
  const subagents = sessions.filter((s) => s.isSubagent).length;
  const d = stats.dedupe;
  lines.push(
    'Roots:',
    ...stats.roots.map((r) => fit(`  ${r}`)),
    `Files: ${n(stats.files)} · ${(stats.bytes / 1e6).toFixed(1)} MB`,
    `Lines: ${n(stats.lines)} · blank ${n(stats.blankLines)} · malformed ${n(stats.malformedLines)}`,
    `Sessions: ${n(sessions.length)} (${n(subagents)} subagent) · assistant turns ${n(turns)}` +
      ` · synthetic turns ${n(stats.syntheticTurns)}`,
    `Dedupe drops: same-response lines ${n(d.sameResponseLines)} · sidechain replays` +
      ` ${n(d.sidechainReplays)} · cross-session copies ${n(d.crossSessionCopies)}`,
    '',
    ...table('Record types', stats.recordTypes),
    ...table('Unknown record types', stats.unknownRecordTypes),
    ...table('Attachment types', stats.attachmentTypes),
    ...table('Claude Code versions (records)', stats.ccVersions),
    ...table('Warnings', stats.warnings),
  );
  const notes = new Map<string, string[]>();
  for (const v of Object.keys(stats.ccVersions))
    for (const q of quirksFor(v)) notes.set(q.id, [...(notes.get(q.id) ?? []), v]);
  lines.push(notes.size === 0 ? 'Quirks: none' : 'Quirks:');
  for (const [id, versions] of notes) {
    const q = quirksFor(versions[0]!).find((x) => x.id === id)!;
    lines.push(`  ${id} [${q.evidence}]`, fit(`    ${q.note}`));
  }
  out(`${lines.join('\n')}\n`);
  return 0;
}
