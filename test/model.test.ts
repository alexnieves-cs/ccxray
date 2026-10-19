import { describe, expect, it } from 'vitest';
import { applyThresholdOverrides, DEFAULT_THRESHOLDS } from '../src/model/index.js';
import { estimateJsonTokens, estimateTokens } from '../src/tokens/estimate.js';

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
  it('is ceil(chars / 4)', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('abcde')).toBe(2);
    expect(estimateJsonTokens({ a: 1 })).toBe(2);
  });
});
