import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'coverage/**', 'node_modules/**', 'bench/out/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: { process: 'readonly', console: 'readonly' },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      // Hard rule 1 (CLAUDE.md): no network in runtime code. The dist scan in
      // test/no-network.test.ts is the real gate; this catches it at lint time.
      'no-restricted-imports': [
        'error',
        {
          paths: [
            'http',
            'https',
            'net',
            'tls',
            'dgram',
            'http2',
            'undici',
            'node:http',
            'node:https',
            'node:net',
            'node:tls',
            'node:dgram',
            'node:http2',
          ].map((name) => ({
            name,
            message: 'No network access in ccxray runtime code (CLAUDE.md hard rule 1).',
          })),
        },
      ],
      'no-restricted-globals': [
        'error',
        {
          name: 'fetch',
          message: 'No network access in ccxray runtime code (CLAUDE.md hard rule 1).',
        },
        {
          name: 'WebSocket',
          message: 'No network access in ccxray runtime code (CLAUDE.md hard rule 1).',
        },
      ],
    },
  },
  {
    // `ccxray capture` (opt-in, docs/capture.md) is the one module allowed node:http. It is built
    // into dist/capture.js, which test/no-network.test.ts checks binds 127.0.0.1 and never
    // connects out. Its test talks to it over loopback.
    files: ['src/capture/index.ts', 'test/capture.test.ts'],
    rules: { 'no-restricted-imports': 'off' },
  },
);
