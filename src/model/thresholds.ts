// Analyzer thresholds (SPEC §5). Overridable with --threshold.<key>=<value>.

export interface Thresholds {
  /** A2: minimum cache_creation tokens for a rebuild. */
  rebuildMinCacheWrite: number;
  /** A2: cache_creation must also be ≥ this fraction of the previous turn's context. */
  rebuildPrevContextFraction: number;
  /** A2: cache_read must drop by at least this fraction vs the previous turn. */
  rebuildReadDropFraction: number;
  /** A3: idle gap that expires a 5 minute cache entry. */
  ttl5mMs: number;
  /** A3: idle gap that expires a 1 hour cache entry. */
  ttl1hMs: number;
  /** A4: jump in median baseline between versions worth flagging. */
  baselineJumpTokens: number;
  /** A4: sessions a version needs before its median baseline is compared for a jump. */
  baselineMinSessions: number;
  /** A5: estimated tokens for a tool_result to count as big. */
  bigToolOutputTokens: number;
  /** A8: context size worth flagging. */
  contextLargeTokens: number;
  /** A8: compactions per session worth flagging. */
  compactionsPerSession: number;
}

export const DEFAULT_THRESHOLDS: Thresholds = {
  rebuildMinCacheWrite: 10_000,
  rebuildPrevContextFraction: 0.5,
  rebuildReadDropFraction: 0.5,
  ttl5mMs: 5 * 60_000,
  ttl1hMs: 60 * 60_000,
  baselineJumpTokens: 2_000,
  baselineMinSessions: 3,
  bigToolOutputTokens: 5_000,
  contextLargeTokens: 150_000,
  compactionsPerSession: 2,
};

/** Parse `--threshold.key=value` overrides. Unknown keys or non-numeric values throw. */
export function applyThresholdOverrides(
  base: Thresholds,
  overrides: Record<string, string>,
): Thresholds {
  const out: Thresholds = { ...base };
  for (const [key, raw] of Object.entries(overrides)) {
    if (!(key in base)) throw new Error(`unknown threshold: ${key}`);
    const value = Number(raw);
    if (!Number.isFinite(value)) throw new Error(`threshold ${key} must be a number, got ${raw}`);
    (out as unknown as Record<string, number>)[key] = value;
  }
  return out;
}
