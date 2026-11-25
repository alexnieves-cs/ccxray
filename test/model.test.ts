import { describe, expect, it } from 'vitest';
import { applyThresholdOverrides, DEFAULT_THRESHOLDS } from '../src/model/index.js';
import fc from 'fast-check';
import {
  estimateJsonTokens,
  estimateTokens,
  estimateToolOutputTokens,
  TOOL_OUTPUT_CHARS_PER_TOKEN,
} from '../src/tokens/estimate.js';

describe('thresholds', () => {
  it('applies numeric overrides', () => {
    const t = applyThresholdOverrides(DEFAULT_THRESHOLDS, { bigToolOutputTokens: '8000' });
    expect(t.bigToolOutputTokens).toBe(8000);
    expect(DEFAULT_THRESHOLDS.bigToolOutputTokens).toBe(5000);
  });
  it('rejects unknown keys and non-numbers', () => {
    expect(() => applyThresholdOverrides(DEFAULT_THRESHOLDS, { nope: '1' })).toThrow(/unknown/);
    expect(() => applyThresholdOverrides(DEFAULT_THRESHOLDS, { ttl5mMs: 'x' })).toThrow(/number/);
  });
});

describe('estimator', () => {
  it('is ceil(chars / 4) for text that is not tool output', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('abcde')).toBe(2);
    expect(estimateJsonTokens({ a: 1 })).toBe(2);
  });
  it('is ceil(chars / 2.2) for tool output, exactly at multiples of 11', () => {
    expect(TOOL_OUTPUT_CHARS_PER_TOKEN).toBe(2.2);
    expect(estimateToolOutputTokens(0)).toBe(0);
    expect(estimateToolOutputTokens(-5)).toBe(0);
    expect(estimateToolOutputTokens(1)).toBe(1);
    expect(estimateToolOutputTokens(11)).toBe(5);
    expect(estimateToolOutputTokens(12)).toBe(6);
    expect(estimateToolOutputTokens(10_997)).toBe(4_999);
    expect(estimateToolOutputTokens(10_998)).toBe(5_000);
    expect(estimateToolOutputTokens(11_000)).toBe(5_000);
  });
  it('tool-output tokens are the smallest n with n × 2.2 ≥ chars', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 1e9 }), (chars) => {
        const n = estimateToolOutputTokens(chars);
        return n * 11 >= chars * 5 && (n - 1) * 11 < chars * 5;
      }),
    );
  });
});
