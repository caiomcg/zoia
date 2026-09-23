/** Conventional Commits, with scopes matching the repo layout. */
export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'scope-enum': [
      2,
      'always',
      [
        'auth',
        'api',
        'web',
        'desktop',
        'livekit',
        'infra',
        'deploy',
        'docs',
        'test',
        'adr',
        // Dependabot's own scopes. It writes `build(deps-dev):` and
        // `build(deps):` and cannot be told otherwise, so without these every
        // dependency PR fails commitlint on its own commit message.
        'deps',
        'deps-dev',
        '',
      ],
    ],
    'header-max-length': [2, 'always', 100],
    // A warning, not an error. Dependabot's bodies are markdown tables of
    // package URLs, which run past 100 characters on their own and cannot be
    // reflowed by anyone. Whether a grouped update passed was down to how long
    // its longest package name happened to be. Humans still get the nudge.
    'body-max-line-length': [1, 'always', 100],
  },
};
