// `ccxray doctor`: what the parser found. Counts only, never content (CLAUDE.md hard rule 4).

import { defaultRoots } from '../discover.js';
import { loadSessions } from '../parser/index.js';
import { quirksFor } from '../parser/quirks.js';
import { calibrate } from '../tokens/calibrate.js';

const WIDTH = 100;
const n = (x: number): string => x.toLocaleString('en-US');
/** Keep a line within WIDTH columns, eliding the middle (paths keep both ends). */
const fit = (s: string): string =>
  s.length <= WIDTH ? s : `${s.slice(0, 40)}…${s.slice(s.length - (WIDTH - 41))}`;

/** Keys come from the logs: show control characters as \xNN so they cannot drive the terminal. */
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;
const esc = (s: string): string =>
  s.replace(CONTROL, (c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, '0')}`);

function table(title: string, m: Record<string, number>): string[] {
  const rows = Object.entries(m)
    .map(([k, v]): [string, number] => [esc(k), v])
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  if (rows.length === 0) return [`${title}: none`];
  const w = Math.min(60, Math.max(...rows.map(([k]) => k.length)));
  return [`${title}:`, ...rows.map(([k, v]) => fit(`  ${k.padEnd(w)}  ${n(v).padStart(10)}`))];
}

/** SPEC §4.5: one line, labeled as an estimate check. */
function calibrationLine(sessions: Parameters<typeof calibrate>[0]): string {
  const c = calibrate(sessions);
  return c.medianRatio === null
    ? 'Estimator calibration [E]: no usable samples (needs turns that added exactly one tool_result)'
    : `Estimator calibration [E]: chars/4 estimate ÷ measured = ${c.medianRatio.toFixed(2)} ` +
        `(median of ${n(c.samples)} single-tool_result turns)`;
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
      ...roots.map((r) => fit(`  ${esc(r)}`)),
    );
    out(`${lines.join('\n')}\n`);
    return 1;
  }
  const turns = sessions.reduce((a, s) => a + s.turns.length, 0);
  const subagents = sessions.filter((s) => s.isSubagent).length;
  const linked = sessions.filter((s) => s.parentToolUseId !== undefined).length;
  const persisted = sessions.reduce(
    (a, s) => a + s.turns.reduce((b, t) => b + t.toolResults.filter((r) => r.persisted).length, 0),
    0,
  );
  const d = stats.dedupe;
  lines.push(
    'Roots:',
    ...stats.roots.map((r) => fit(`  ${esc(r)}`)),
    `Files: ${n(stats.files)} · ${(stats.bytes / 1e6).toFixed(1)} MB`,
    `Lines: ${n(stats.lines)} · blank ${n(stats.blankLines)} · malformed ${n(stats.malformedLines)}`,
    `Sessions: ${n(sessions.length)} (${n(subagents)} subagent) · assistant turns ${n(turns)}` +
      ` · synthetic turns ${n(stats.syntheticTurns)}`,
    `Persisted tool outputs: ${n(persisted)} · subagents linked to a tool_use: ${n(linked)}`,
    calibrationLine(sessions),
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
