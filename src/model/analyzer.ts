import type { Finding, Session } from './types.js';
import type { Thresholds } from './thresholds.js';

export interface AnalyzerContext {
  thresholds: Thresholds;
  /** Reference "now" so analyzers stay deterministic in tests. */
  now: Date;
  includeContent: boolean;
}

/** Analyzers are pure: same sessions + ctx in, same findings out. No I/O. */
export interface Analyzer {
  id: string;
  /** SPEC §5 number, e.g. 'A2'. */
  spec: string;
  description: string;
  run(sessions: readonly Session[], ctx: AnalyzerContext): Finding[];
}
