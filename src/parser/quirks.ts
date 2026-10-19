// Claude Code version → format quirks (SPEC §4.4 Q6, docs/FORMAT.md). `doctor` prints the
// notes for the versions it sees. Add a row whenever a probe finds new drift.

export interface Quirk {
  id: string;
  /** Inclusive version bounds; omitted = open-ended. */
  min?: string;
  max?: string;
  /** measured = seen in a probed log; documented = ccusage docs; reported = GitHub issue. */
  evidence: 'measured' | 'documented' | 'reported';
  note: string;
}

export const QUIRKS: readonly Quirk[] = [
  {
    id: 'one-block-per-line',
    evidence: 'measured',
    note: 'one JSONL line per content block, usage repeated per line; deduped by message.id+requestId',
  },
  {
    id: 'ai-title-record',
    min: '2.1.302',
    evidence: 'measured',
    note: 'new record type `ai-title` (no uuid/timestamp); counted, otherwise ignored',
  },
  {
    id: 'prompt-snapshot-tools',
    min: '2.1.302',
    evidence: 'measured',
    note: 'attachment `prompt_snapshot` logs tool definitions (seen on the web entrypoint only)',
  },
  {
    id: 'cost-state-record',
    min: '2.1.296',
    max: '2.1.296',
    evidence: 'measured',
    note: '`cost-state` record (totalCostUSD, modelUsage); not seen in 2.1.302',
  },
  {
    id: 'cache-creation-inflation',
    min: '2.1.100',
    evidence: 'reported',
    note: 'cache_creation reported ~20k tokens higher per request (anthropics/claude-code#46917)',
  },
];

/** Numeric compare of dotted versions; non-numeric parts compare as 0. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.');
  const pb = b.split('.');
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (parseInt(pa[i] ?? '0', 10) || 0) - (parseInt(pb[i] ?? '0', 10) || 0);
    if (d !== 0) return d;
  }
  return 0;
}

export function quirksFor(version: string): Quirk[] {
  return QUIRKS.filter(
    (q) =>
      (q.min === undefined || compareVersions(version, q.min) >= 0) &&
      (q.max === undefined || compareVersions(version, q.max) <= 0),
  );
}
