// Heuristic token estimator (SPEC §4.5). Every value from here is *estimated*, never measured.
//
// Two rates. Tool output (tool_result content) uses TOOL_OUTPUT_CHARS_PER_TOKEN, calibrated from
// measured context growth (src/tokens/calibrate.ts) on seven corpora: the maintainer's logs and
// six public ones, about 2.0 to 2.3 chars per token in each (bench/REVIEW.md, "Outside logs").
// Everything else (tool definitions, CLAUDE.md files, tool inputs, `capture` request parts) keeps
// the chars/4 baseline. UNVERIFIED: no log measures those, so the baseline is uncalibrated there.

export const CHARS_PER_TOKEN = 4;

/** 2.2 chars per token, kept as the ratio 11/5 so that ceil() below is exact. */
export const TOOL_OUTPUT_CHARS_PER_TOKEN = 11 / 5;

export function estimateTokensFromChars(chars: number): number {
  return chars <= 0 ? 0 : Math.ceil(chars / CHARS_PER_TOKEN);
}

/** Estimated tokens of tool output (a tool_result's content) of this many characters. */
export function estimateToolOutputTokens(chars: number): number {
  return chars <= 0 ? 0 : Math.ceil((chars * 5) / 11);
}

export function estimateTokens(text: string): number {
  return estimateTokensFromChars(text.length);
}

export function estimateJsonTokens(value: unknown): number {
  return estimateTokensFromChars(JSON.stringify(value ?? '').length);
}
