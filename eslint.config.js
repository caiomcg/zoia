import js from '@eslint/js';
import globals from 'globals';

export default [
  // desktop/ has its own config; android/ has no JavaScript, only what Gradle
  // generates into its build output.
  { ignores: ['node_modules/', 'coverage/', 'server/public/vendor/', 'desktop/', 'android/'] },
  js.configs.recommended,
  {
    files: ['server/src/**/*.js', 'server/bin/**/*.js', 'server/test/**/*.js', 'scripts/**/*.js'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      eqeqeq: ['error', 'always'],
      'no-console': 'off',
    },
  },
  {
    files: ['server/public/**/*.js'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: { ...globals.browser },
    },
  },
];
