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
  },
};
