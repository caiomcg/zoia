/**
 * Release notes written from the Conventional Commits between two tags,
 * grouped by what they mean to someone running the app rather than listed in
 * merge order. The desktop app shows these same notes in Settings → What's
 * new, so they are written for the people using it: what is new, what is
 * fixed, and whether the update installs itself or needs the installer.
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
 * A Mac never updates in-app (see docs/adr/0025-macos-client.md): whatever
 * the Windows build does, it downloads the disk image for its processor.
 */
function macDownload(version) {
  return `**Mac:** download \`Zoia-${version}-mac-arm64.dmg\` (Apple silicon) or \`Zoia-${version}-mac-x64.dmg\` (Intel) below.`;
}

function describeUpdate({ version, updateType, minimumVersion, reasons, macos }) {
  const mac = macos ? ['', macDownload(version)] : [];
  if (updateType === 'asar') {
    const minimum = minimumVersion
      ? ` It needs Zoia ${minimumVersion} or newer; an older installation is offered the installer instead.`
      : '';
    const who = macos ? '**Windows: in-app update.**' : '**In-app update.**';
    return [
      `${who} Zoia downloads and installs this by itself, or from Settings → Updates → Check now.${minimum}`,
      ...mac,
    ].join('\n');
  }
  if (updateType === 'full') {
    const why = reasons.length ? ` (${[...new Set(reasons)].join('; ')})` : '';
    const who = macos ? '**Windows: installer required.**' : '**Installer required.**';
    return [
      `${who} This release changes more than the app code${why}, so it cannot be installed in-app. Download \`Zoia-Setup-${version}-x64.exe\` below.`,
      ...mac,
    ].join('\n');
  }
  return '**No desktop changes.** Nothing to install; this release changes the server only.';
}

/**
 * @param {{
 *   tag: string,
 *   base: string | null,
 *   repository: string,
 *   commits: { hash: string, subject: string }[],
 *   updateType: 'asar' | 'full' | 'none',
 *   minimumVersion: string | null,
 *   reasons: string[],
 *   entry?: string | null,
 *   macos?: boolean,
 * }} release
 *
 * `entry` is the release's changelog/<version>.md. When there is one it is the
 * body; the grouped commits are the fallback for releases from before the
 * changelog existed. The install line and the comparison link are generated
 * either way, so they always match what the updater will do.
 */
export function formatReleaseNotes(release) {
  const { tag, base, repository } = release;
  const version = tag.replace(/^v/, '');
  const lines = [describeUpdate({ ...release, version }), ''];

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
