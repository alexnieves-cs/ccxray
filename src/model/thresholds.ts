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
  /** A11: agents of one session tree that must read the same file to flag it. */
  crossAgentReadMinAgents: number;
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
  crossAgentReadMinAgents: 3,
};

/**
 * Parse `--threshold.key=value` overrides. Throws on an unknown key (own keys of `base` only, so
 * `toString` or `__proto__` are unknown), an empty or non-numeric value, a `…Fraction` value
 * outside [0, 1], or any other value below 0.
 */
export function applyThresholdOverrides(
  base: Thresholds,
  overrides: Record<string, string>,
): Thresholds {
  const out: Thresholds = { ...base };
  for (const [key, raw] of Object.entries(overrides)) {
    if (!Object.hasOwn(base, key)) throw new Error(`unknown threshold: ${key}`);
    const value = raw.trim() === '' ? NaN : Number(raw);
    if (!Number.isFinite(value)) throw new Error(`threshold ${key} must be a number, got "${raw}"`);
    if (key.endsWith('Fraction') ? value < 0 || value > 1 : value < 0)
      throw new Error(
        `threshold ${key} must be ${key.endsWith('Fraction') ? 'between 0 and 1' : '>= 0'}, got ${raw}`,
      );
    (out as unknown as Record<string, number>)[key] = value;
  }
  return out;
}
