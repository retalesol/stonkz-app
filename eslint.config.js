import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';
import stonkz from './eslint-local/no-raw-innerhtml.js';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      'coverage/**',
      'playwright-report/**',
      'test-results/**',
      // The visual oracle stays untouched.
      'legacy/**',
      // Foundry / Anchor trees carry vendored submodules (OpenZeppelin, forge-std)
      // and generated artifacts; they are linted by their own toolchains.
      'programs/**',
      // Agent / editor scratch.
      '.codex/**',
      '.cursor/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Build-time scripts and the local lint plugin run in Node, not the browser.
    files: ['**/*.mjs', 'eslint-local/**/*.js', '*.config.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.node },
    },
  },
  {
    // k6 scripts run inside k6's own goja runtime, not Node: `__ENV`, `__VU`,
    // and `console` are injected by the runner. Without this block every
    // loadtest script fails `no-undef` on globals it is supposed to use.
    files: ['apps/api/loadtest/k6/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        __ENV: 'readonly',
        __VU: 'readonly',
        __ITER: 'readonly',
        console: 'readonly',
        // k6's file reader, used by lib/config.js to load the seeded fixtures.
        open: 'readonly',
      },
    },
    rules: {
      // k6's `open()`/module resolution and the operator-facing logging in
      // these scripts are the point of them.
      'no-console': 'off',
    },
  },
  {
    files: ['**/*.ts'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-var': 'error',
      'prefer-const': 'error',
    },
  },
  {
    files: ['apps/web/**/*.ts'],
    languageOptions: {
      globals: { ...globals.browser },
    },
    plugins: { stonkz },
    rules: {
      // Escaping is structural: lib/html.ts is the only door to a markup sink.
      'stonkz/no-raw-innerhtml': 'error',
    },
  },
  {
    // The door itself.
    files: ['apps/web/src/lib/html.ts'],
    rules: { 'stonkz/no-raw-innerhtml': 'off' },
  },
  {
    files: ['packages/shared/src/**/*.ts'],
    rules: {
      // packages/shared is pure: no DOM, no timers, no I/O.
      'no-restricted-globals': [
        'error',
        { name: 'document', message: 'packages/shared must stay DOM-free.' },
        { name: 'window', message: 'packages/shared must stay DOM-free.' },
        { name: 'localStorage', message: 'packages/shared must stay DOM-free.' },
      ],
    },
  },
  prettier,
);
