// A10 error-waste (SPEC §5): API errors (synthetic turns and api-error events) with their
// retries [M], and failed tool calls re-issued with identical input [E].

import type { Analyzer, Finding, Session, Turn } from '../model/index.js';
import { estimateTokensFromChars } from '../tokens/estimate.js';
import { fmt, short, turnTokens } from './rules.js';

/** A retry is the next real turn within this window after an error, on the same model. */
export const RETRY_WINDOW_MS = 60_000;
/** How many following turns to search for an identical re-call of a failed tool. */
export const RECALL_LOOKAHEAD_TURNS = 3;

interface ApiError {
  ts: number;
  uuid: string;
  label: string;
  tokens: number;
}

/** The chain analyzers follow: every turn of a subagent, else the main chain. */
function chain(s: Session): Turn[] {
  return s.turns.filter((t) => s.isSubagent || !t.isSidechain);
}

function apiErrors(s: Session): ApiError[] {
  const out = new Map<string, ApiError>();
  const labels = new Map<string, string>();
  for (const e of s.events)
    if (e.kind === 'api-error') {
      const uuid = e.uuid ?? `${e.source.file}:${e.source.line}`;
      labels.set(uuid, e.detail);
      out.set(uuid, { ts: e.ts.getTime(), uuid, label: e.detail, tokens: 0 });
    }
  // A synthetic turn and the api-error event the parser derives from it (same uuid) are one error.
  for (const t of chain(s))
    if (t.isSynthetic)
      out.set(t.uuid, {
        ts: t.ts.getTime(),
        uuid: t.uuid,
        label: labels.get(t.uuid) ?? 'synthetic turn',
        tokens: turnTokens(t.usage),
      });
  return [...out.values()].sort((a, b) => a.ts - b.ts);
}

/**
 * Same tool, same input. With --include-content the input is raw; otherwise it is the parser's
 * slim input (only a few primitive fields, `{}` for most tools) plus the raw input size, so two
 * calls of an unknown tool with equal-length inputs look identical. Heuristic, hence [E].
 */
const sameCall = (a: Turn['toolUses'][number], b: Turn['toolUses'][number]): boolean =>
  a.name === b.name &&
  a.inputChars === b.inputChars &&
  JSON.stringify(a.input ?? null) === JSON.stringify(b.input ?? null);

interface Recall {
  s: Session;
  failed: Turn;
  again: Turn;
  tokens: number;
}

export const errorWaste: Analyzer = {
  id: 'error-waste',
  spec: 'A10',
  description: 'API errors and retries; failed tool calls re-issued with identical input',
  run(sessions) {
    const findings: Finding[] = [];
    const recalls = new Map<string, Recall[]>();
    for (const s of sessions) {
      const turns = chain(s);
      const real = turns.filter((t) => !t.isSynthetic);

      const errors = apiErrors(s);
      if (errors.length > 0) {
        let retries = 0;
        for (const e of errors) {
          const before = [...real].reverse().find((t) => t.ts.getTime() <= e.ts);
          const after = real.find((t) => t.ts.getTime() > e.ts);
          if (
            after !== undefined &&
            after.ts.getTime() - e.ts <= RETRY_WINDOW_MS &&
            (before === undefined || before.model === after.model)
          )
            retries++;
        }
        const tokens = errors.reduce((a, e) => a + e.tokens, 0);
        const synthetic = turns.filter((t) => t.isSynthetic).length;
        findings.push({
          analyzer: 'error-waste',
          severity: 'info',
          title:
            `${errors.length} API error${errors.length === 1 ? '' : 's'} in session ${short(s.id)}` +
            `, ${retries} retried within ${RETRY_WINDOW_MS / 1000} s`,
          tokens: { value: tokens, kind: 'measured' },
          data: {
            errors: errors.length,
            syntheticTurns: synthetic,
            apiErrorEvents: errors.length - synthetic,
            retries,
          },
          evidence: errors.slice(0, 5).map((e) => ({
            sessionId: s.id,
            turnUuid: e.uuid,
            detail: `API error: ${e.label}`,
          })),
          fix: {
            summary:
              'Check `ccxray doctor` and your login/network; errors themselves usually bill nothing',
          },
        });
      }

      real.forEach((t, i) => {
        for (const r of t.toolResults) {
          if (r.isError !== true) continue;
          const u = t.toolUses.find((x) => x.id === r.toolUseId);
          if (u === undefined) continue;
          const later = real.slice(i + 1, i + 1 + RECALL_LOOKAHEAD_TURNS);
          for (const again of later) {
            const v = again.toolUses.find((x) => sameCall(u, x));
            if (v === undefined) continue;
            const tokens = r.estTokens + estimateTokensFromChars(v.inputChars);
            recalls.set(u.name, [...(recalls.get(u.name) ?? []), { s, failed: t, again, tokens }]);
            break;
          }
        }
      });
    }
    for (const [tool, rs] of [...recalls.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      const tokens = rs.reduce((a, r) => a + r.tokens, 0);
      findings.push({
        analyzer: 'error-waste',
        severity: 'info',
        title: `${tool} failed and was re-called with identical input ${rs.length}× (~${fmt(tokens)} tokens [E])`,
        tokens: { value: tokens, kind: 'estimated' },
        data: { tool, recalls: rs.length, sessions: new Set(rs.map((r) => r.s.id)).size },
        evidence: rs.slice(0, 5).map((r) => ({
          sessionId: r.s.id,
          turnUuid: r.again.uuid,
          detail: `identical ${tool} call after a failed one at turn ${r.failed.index + 1}`,
          source: r.again.source,
        })),
        fix: {
          summary:
            'Repeating a failed call rarely helps: fix the cause (permissions, paths, flags) first',
        },
      });
    }
    return findings;
  },
};
