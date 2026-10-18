import type { Analyzer } from '../model/index.js';
import { contextGrowth } from './context-growth.js';
import { errorWaste } from './error-waste.js';
import { fixedOverhead } from './fixed-overhead.js';
import { subagentCost } from './subagent-cost.js';
import { toolUsage } from './tool-usage.js';

/** Registry of analyzers run by the default command. Each stream appends its own. */
export const ANALYZERS: Analyzer[] = [
  fixedOverhead, // A4
  toolUsage, // A7
  contextGrowth, // A8
  subagentCost, // A9
  errorWaste, // A10
];
