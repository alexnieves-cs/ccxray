import { defineConfig } from 'tsup';

export default defineConfig({
  // slim.js is used by hooks/cc-slim-posttooluse.mjs.
  entry: { cli: 'src/cli.ts', slim: 'src/slim/compress.ts' },
  format: ['esm'],
  target: 'node20',
  platform: 'node',
  outDir: 'dist',
  clean: true,
  sourcemap: false,
  splitting: false,
  dts: false,
  banner: { js: '#!/usr/bin/env node' },
});
