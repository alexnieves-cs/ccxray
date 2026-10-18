import { defineConfig } from 'tsup';

export default defineConfig({
  // capture.js is the only bundle allowed to use node:http (test/no-network.test.ts); the CLI
  // loads it with a dynamic import only when `ccxray capture` runs. slim.js is used by hooks/.
  entry: { cli: 'src/cli.ts', capture: 'src/capture/index.ts', slim: 'src/slim/compress.ts' },
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
