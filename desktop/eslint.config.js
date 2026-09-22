import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';

export default tseslint.config(
  {
    // Build output and generated files — never source, never worth linting.
    ignores: ['out/', 'node_modules/', '*.tsbuildinfo', 'dist/'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Main and preload run in Node, under Electron's process model.
    files: ['src/main/**/*.ts', 'src/preload/**/*.ts', 'src/shared/**/*.ts'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      'no-console': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  {
    // The renderer is a browser page; it never sees Node globals.
    files: ['src/renderer/**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: { ...globals.browser },
    },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      // Only the two rules that apply to hand-written React without the
      // Compiler pipeline. v7's "recommended" bundles ~25 React-Compiler
      // safety rules (immutability, preserve-manual-memoization, purity, …)
      // that assume a compilation step this project doesn't have, and flag
      // ordinary, correct hook patterns as unsafe for a compiler that never
      // runs.
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  {
    files: ['**/*.d.ts'],
    rules: { '@typescript-eslint/no-unused-vars': 'off' },
  },
  {
    // AudioWorkletGlobalScope: runs on the dedicated audio rendering thread,
    // not the main renderer thread, with its own globals that the "globals"
    // package has no preset for.
    files: ['src/renderer/public/pcm-worklet.js'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'script',
      globals: { AudioWorkletProcessor: 'readonly', registerProcessor: 'readonly' },
    },
  },
  {
    // Ad hoc verification tooling at the project root, not part of the
    // shipped app — one-off CDP/capture probes written during manual testing.
    files: ['*.cjs'],
    languageOptions: { ecmaVersion: 2022, sourceType: 'commonjs', globals: { ...globals.node } },
    rules: { '@typescript-eslint/no-require-imports': 'off', 'no-redeclare': 'off' },
  },
);
