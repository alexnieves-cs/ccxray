import type { Analyzer } from '../model/index.js';
import { cacheRebuild } from './cache-rebuild.js';
import { bigToolOutput } from './big-tool-output.js';
import { repeatedRead } from './repeated-read.js';

/** Registry of analyzers run by the default command. Each stream appends its own. */
export const ANALYZERS: Analyzer[] = [
  cacheRebuild, // A2 (+ A3 causes)
  bigToolOutput, // A5
  repeatedRead, // A6
];
