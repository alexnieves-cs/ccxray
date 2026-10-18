export * from './types.js';
export * from './thresholds.js';
export * from './analyzer.js';

/** Bump when the JSON report shape changes incompatibly; keep schema/report.v<N>.json in sync. */
export const REPORT_SCHEMA_VERSION = 1 as const;
