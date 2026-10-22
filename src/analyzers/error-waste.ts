// A10 error-waste (SPEC §5): API errors (synthetic turns and api-error events) with their
// retries [M], and failed tool calls re-issued with the same input, with no prompt between [E].

import type { Analyzer, Finding, Session, SourcePointer, Turn } from '../model/index.js';
import { estimateTokensFromChars } from '../tokens/estimate.js';
import { chain, fmt, turnTokens } from './rules.js';
import { sessionLabel } from './util.js';

/** A retry is the next real turn within this window after an error, on the same model. */
export const RETRY_WINDOW_MS = 60_000;
/** How many following turns to search for a repeat of a failed tool call. */
export const RECALL_LOOKAHEAD_TURNS = 3;

interface ApiError {
  ts: number;
  uuid: string;
  label: string;
  tokens: number;
  synthetic: boolean;
  source: SourcePointer;
}

/**
 * API errors of the chain, each counted once. Two sources: synthetic turns (the parser's
 * api-error event for a synthetic turn has the turn's uuid and is the same error), and
 * standalone events such as `system`/`api_error` records. A standalone event followed by a
 * synthetic turn with no real turn between them is one error, kept as the synthetic turn.
 * Events derived from turns outside chain() (inline sidechain turns) are skipped.
 * UNVERIFIED: that Claude Code writes both a system api_error record and a synthetic turn for one
 * failure (neither has been seen in a real log yet).
 */
export function apiErrors(s: Session): ApiError[] {
  const turns = chain(s);
  const inChain = new Set(turns.map((t) => t.uuid));
  const allTurns = new Set(s.turns.map((t) => t.uuid));
  const labels = new Map<string, string>();
  const standalone: ApiError[] = [];
  for (const e of s.events) {
    if (e.kind !== 'api-error') continue;
    if (e.uuid !== undefined && allTurns.has(e.uuid)) {
      if (inChain.has(e.uuid)) labels.set(e.uuid, e.detail);
      continue;
    }
    const uuid = e.uuid ?? `${e.source.file}:${e.source.line}`;
    standalone.push({
      ts: e.ts,
      uuid,
      label: e.detail,
      tokens: 0,
      synthetic: false,
      source: e.source,
    });
  }
  const out: ApiError[] = [];
  const linked = new Set<ApiError>();
  for (const t of turns) {
    if (!t.isSynthetic) continue;
    const at = t.ts;
    const prevReal = turns.filter((x) => !x.isSynthetic && x.ts <= at).pop();
    const from = prevReal?.ts ?? -Infinity;
    const ev = standalone.find((e) => !linked.has(e) && e.ts <= at && e.ts >= from);
    if (ev !== undefined) linked.add(ev);
    out.push({
      ts: at,
      uuid: t.uuid,
      label: labels.get(t.uuid) ?? ev?.label ?? 'synthetic turn',
      tokens: turnTokens(t.usage),
      synthetic: true,
      source: t.source,
    });
  }
  out.push(...standalone.filter((e) => !linked.has(e)));
  return out.sort((a, b) => a.ts - b.ts);
}

/**
 * Same tool, same input: equal name, raw input size and raw input hash (32-bit FNV-1a, so a
 * collision is possible but rare), plus equal input as kept (raw with --include-content, else the
 * slim input). A retry with a changed argument of the same length is not a re-call.
 */
const sameCall = (a: Turn['toolUses'][number], b: Turn['toolUses'][number]): boolean =>
  a.name === b.name &&
  a.inputChars === b.inputChars &&
  a.inputHash === b.inputHash &&
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
  description: 'API errors and retries; failed tool calls re-issued with the same input',
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
          const before = [...real].reverse().find((t) => t.ts <= e.ts);
          const after = real.find((t) => t.ts > e.ts);
          if (
            after !== undefined &&
            after.ts - e.ts <= RETRY_WINDOW_MS &&
            (before === undefined || before.model === after.model)
          )
            retries++;
        }
        const tokens = errors.reduce((a, e) => a + e.tokens, 0);
        const synthetic = errors.filter((e) => e.synthetic).length;
        findings.push({
          analyzer: 'error-waste',
          severity: 'info',
          title:
            `${errors.length} API error${errors.length === 1 ? '' : 's'} in ${sessionLabel(s)}` +
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
            source: e.source,
          })),
          fix: {
            summary:
              'Check `tknxray doctor` and your login/network; errors themselves usually bill nothing',
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
            // A prompt in between (e.g. the user granting a permission) can fix the cause, so a
            // re-call after it is not counted (real-log review 2026-10-22).
            if (s.prompts.some((p) => p.ts > t.ts && p.ts <= again.ts)) break;
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
      // Raw inputs are compared only with --include-content; otherwise the match is weaker.
      const same = 'same input';
      findings.push({
        analyzer: 'error-waste',
        severity: 'info',
        title: `${tool} failed and was re-called (${same}) ${rs.length}× (~${fmt(tokens)} tokens [E])`,
        tokens: { value: tokens, kind: 'estimated' },
        data: {
          tool,
          recalls: rs.length,
          sessions: new Set(rs.map((r) => r.s.id)).size,
          match: 'identical',
        },
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
