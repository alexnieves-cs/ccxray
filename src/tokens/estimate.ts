// Heuristic token estimator (SPEC §4.5). Every value from here is *estimated*, never measured.

export const CHARS_PER_TOKEN = 4;

export function estimateTokensFromChars(chars: number): number {
  return chars <= 0 ? 0 : Math.ceil(chars / CHARS_PER_TOKEN);
}

export function estimateTokens(text: string): number {
  return estimateTokensFromChars(text.length);
}

export function estimateJsonTokens(value: unknown): number {
  return estimateTokensFromChars(JSON.stringify(value ?? '').length);
}
