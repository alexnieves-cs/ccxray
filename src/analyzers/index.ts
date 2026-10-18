import type { Analyzer } from '../model/index.js';

/** Registry of analyzers run by the default command. Each stream appends its own. */
export const ANALYZERS: Analyzer[] = [];
