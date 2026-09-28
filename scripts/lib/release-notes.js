/**
 * Release notes written from the Conventional Commits between two tags,
 * grouped by what they mean to someone running the app rather than listed in
 * merge order. The desktop app shows these same notes after an update and
 * from Settings → About, so they say what changed and nothing else: no
 * install instructions, which only repeat what the updater already handles.
 */

const CONVENTIONAL = /^(?<type>[a-z]+)(?:\((?<scope>[^)]+)\))?(?<breaking>!)?:\s*(?<text>.+)$/;

const GROUPS = [
  { title: 'New', types: ['feat'] },
  { title: 'Fixed', types: ['fix'] },
  { title: 'Faster', types: ['perf'] },
  {
    title: 'Under the hood',
    types: ['refactor', 'docs', 'build', 'ci', 'test', 'style', 'revert'],
  },
];

/** Release bookkeeping says nothing about the app: version bumps, manifests. */
const SKIPPED_TYPES = new Set(['chore']);

/** Scopes that are the app itself go unsaid; anything else is named. */
const UNNAMED_SCOPES = new Set(['desktop', 'web']);

function capitalise(text) {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * @param {{ hash: string, subject: string }} commit
 * @returns {{ type: string, scope: string | null, breaking: boolean, text: string, hash: string }}
 */
export function parseCommit({ hash, subject }) {
  const match = CONVENTIONAL.exec(subject.trim());
  if (!match?.groups) return { type: 'other', scope: null, breaking: false, text: subject, hash };
  const { type, scope, breaking, text } = match.groups;
  return { type, scope: scope ?? null, breaking: Boolean(breaking), text, hash };
}

/**
 * @param {{
 *   tag: string,
 *   base: string | null,
 *   repository: string,
 *   commits: { hash: string, subject: string }[],
 *   entry?: string | null,
 * }} release
 *
 * `entry` is the release's changelog/<version>.md. When there is one it is the
 * body; the grouped commits are the fallback for releases from before the
 * changelog existed. Either way it closes with the link to the full list.
 */
export function formatReleaseNotes(release) {
  const { tag, base, repository } = release;
  const lines = [];

  if (release.entry?.trim()) {
    lines.push(release.entry.trim(), '');
  } else {
    lines.push(...commitSections(release));
  }

  if (base) {
    lines.push(`**Full changelog:** https://github.com/${repository}/compare/${base}...${tag}`, '');
  }
  return lines.join('\n');
}

function commitSections({ repository, commits }) {
  const lines = [];
  const parsed = commits.map(parseCommit).filter((commit) => !SKIPPED_TYPES.has(commit.type));
  const item = (commit) => {
    const scope = commit.scope && !UNNAMED_SCOPES.has(commit.scope) ? `**${commit.scope}:** ` : '';
    const breaking = commit.breaking ? '**Breaking:** ' : '';
    const link = `[${commit.hash.slice(0, 7)}](https://github.com/${repository}/commit/${commit.hash})`;
    return `- ${breaking}${scope}${capitalise(commit.text)} (${link})`;
  };

  const known = new Set(GROUPS.flatMap((group) => group.types));
  const sections = [
    ...GROUPS.map((group) => ({
      title: group.title,
      commits: parsed.filter((commit) => group.types.includes(commit.type)),
    })),
    { title: 'Other changes', commits: parsed.filter((commit) => !known.has(commit.type)) },
  ];
  for (const section of sections) {
    if (!section.commits.length) continue;
    lines.push(`### ${section.title}`, '', ...section.commits.map(item), '');
  }
  if (!parsed.length) lines.push('Maintenance only: no changes to describe.', '');
  return lines;
}
