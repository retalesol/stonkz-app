import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

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
      'index.html',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
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
