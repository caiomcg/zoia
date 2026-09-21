/** Conventional Commits, with scopes matching the repo layout. */
export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'scope-enum': [
      2,
      'always',
      ['auth', 'api', 'web', 'livekit', 'infra', 'deploy', 'docs', 'test', 'adr', ''],
    ],
    'header-max-length': [2, 'always', 100],
  },
};
