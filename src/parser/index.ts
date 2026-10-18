// Parser entry point (SPEC §4): discover → stream parse → dedupe → sessions. Never throws on
// bad input; everything odd is counted in ParseStats.

import { readFile } from 'node:fs/promises';
import { discover } from '../discover.js';
import type { ParseStats, Session } from '../model/index.js';
import { dedupeAcrossFiles } from './dedupe.js';
import { counter, inc, isRec, str } from './records.js';
import { buildSessions, FileParser, finalize, type FileData } from './session.js';
import { emptyCounts, streamJsonl } from './stream.js';

export interface LoadOptions {
  /** Projects roots; defaults to `defaultRoots()`. */
  roots?: string[];
  /** Keep only turns with ts >= since. */
  since?: Date;
  /** Keep only turns with ts <= until. */
  until?: Date;
  /** Case-insensitive substring of the project dir name or cwd. */
  project?: string;
  /** Keep prompt and tool_result text (off by default, CLAUDE.md hard rule 4). */
  includeContent?: boolean;
}

export const emptyStats = (roots: string[] = []): ParseStats => ({
  roots,
  files: 0,
  bytes: 0,
  lines: 0,
  blankLines: 0,
  malformedLines: 0,
  recordTypes: counter(),
  unknownRecordTypes: counter(),
  attachmentTypes: counter(),
  dedupe: { sameResponseLines: 0, sidechainReplays: 0, crossSessionCopies: 0 },
  syntheticTurns: 0,
  ccVersions: counter(),
  warnings: counter(),
});

export async function loadSessions(
  opts: LoadOptions = {},
): Promise<{ sessions: Session[]; stats: ParseStats }> {
  const found = await discover(opts.roots);
  const stats = emptyStats(found.roots);
  for (let i = 0; i < found.errors; i++) inc(stats.warnings, 'unreadable file or directory');
  const counts = emptyCounts();
  const files: FileData[] = [];
  // Sequential and in sorted path order, so cross-session dedupe is deterministic.
  for (const f of found.files) {
    stats.files++;
    stats.bytes += f.size;
    const p = new FileParser(f, stats, opts.includeContent === true);
    await streamJsonl(f.path, p.onRecord, counts);
    const data = p.finish();
    if (f.metaPath !== undefined) data.metaToolUseId = await readMetaToolUseId(f.metaPath, stats);
    files.push(data);
  }
  stats.lines = counts.lines;
  stats.blankLines = counts.blankLines;
  stats.malformedLines = counts.malformedLines;
  if (counts.readErrors > 0) stats.warnings['file read error'] = counts.readErrors;
  if (counts.handlerErrors > 0) stats.warnings['internal parser error'] = counts.handlerErrors;

  const kept = dedupeAcrossFiles(
    files.map((f) => f.responses),
    stats,
  );
  const sessions = buildSessions(files, kept, stats);
  return { sessions: filterSessions(sessions, opts), stats };
}

/** `toolUseId` of a subagent's `agent-<id>.meta.json` ([M] 2.1.302). Only that key is read. */
async function readMetaToolUseId(path: string, stats: ParseStats): Promise<string | undefined> {
  try {
    const v: unknown = JSON.parse(await readFile(path, 'utf8'));
    return isRec(v) ? str(v.toolUseId) : undefined;
  } catch {
    inc(stats.warnings, 'unreadable agent meta.json');
    return undefined;
  }
}

function filterSessions(sessions: Session[], opts: LoadOptions): Session[] {
  const { since, until } = opts;
  const needle = opts.project?.toLowerCase();
  const inWindow = (d: Date): boolean =>
    (since === undefined || d >= since) && (until === undefined || d <= until);
  const out: Session[] = [];
  for (const s of sessions) {
    if (
      needle !== undefined &&
      !s.project.toLowerCase().includes(needle) &&
      !(s.cwd ?? '').toLowerCase().includes(needle)
    )
      continue;
    if (since !== undefined || until !== undefined) {
      s.turns = s.turns.filter((t) => inWindow(t.ts));
      if (s.turns.length === 0) continue;
      s.prompts = s.prompts.filter((p) => inWindow(p.ts));
      s.events = s.events.filter((e) => inWindow(e.ts));
      s.firstTs = s.turns[0]!.ts;
      s.lastTs = s.turns[s.turns.length - 1]!.ts;
      finalize(s);
    }
    out.push(s);
  }
  return out;
}
