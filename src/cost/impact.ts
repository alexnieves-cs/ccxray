// Finding.impact helpers (SPEC §5.2). Pure.
import type { Impact } from '../model/index.js';
import { usd } from './cost.js';

/**
 * Build an Impact, rounded to micro-dollars. `savingsSubagentUsd` is the part of `savingsUsd`
 * spent in subagents; savings are capped at the cost (a fix cannot save more than was spent).
 */
export function impact(o: {
  costUsd: number;
  savingsUsd: number;
  savingsSubagentUsd?: number;
  basis: string;
  confidence: Impact['confidence'];
}): Impact {
  const cost = Math.max(0, o.costUsd);
  const savings = Math.min(cost, Math.max(0, o.savingsUsd));
  const sub = Math.min(savings, Math.max(0, o.savingsSubagentUsd ?? 0));
  return {
    costUsd: usd(cost),
    savingsUsd: usd(savings),
    basis: o.basis,
    confidence: o.confidence,
    savingsMainUsd: usd(savings - sub),
    savingsSubagentUsd: usd(sub),
  };
}
