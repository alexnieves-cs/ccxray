import type { Analyzer } from '../model/index.js';
import { bigToolOutput } from './big-tool-output.js';
import { cacheRebuild } from './cache-rebuild.js';
import { contextGrowth } from './context-growth.js';
import { errorWaste } from './error-waste.js';
import { fixedOverhead } from './fixed-overhead.js';
import { repeatedRead } from './repeated-read.js';
import { subagentCost } from './subagent-cost.js';
import { toolUsage } from './tool-usage.js';

/**
 * Registry of analyzers run by the default command, in SPEC §5 order. A1 totals is not a
 * finding analyzer (src/analyzers/totals.ts fills Report.totals) and A3 runs inside A2.
 */
export const ANALYZERS: Analyzer[] = [
  cacheRebuild, // A2 (+ A3 causes)
  fixedOverhead, // A4
  bigToolOutput, // A5
  repeatedRead, // A6
  toolUsage, // A7
  contextGrowth, // A8
  subagentCost, // A9
  errorWaste, // A10
];
