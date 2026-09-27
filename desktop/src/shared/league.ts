import type { SourceInfo } from './ipc';

export const LEAGUE_GAME_EXECUTABLE = 'league of legends.exe';
export const LEAGUE_CLIENT_EXECUTABLES = ['leagueclientux.exe', 'leagueclient.exe'] as const;

export function executableName(source: SourceInfo): string {
  const path = source.processPath?.replaceAll('\\', '/');
  return path?.slice(path.lastIndexOf('/') + 1).toLowerCase() ?? '';
}

/**
 * Checks if a window source is the active League of Legends match game.
 */
export function isLeagueGame(source: SourceInfo): boolean {
  if (source.kind !== 'window') return false;
  const exe = executableName(source);
  if (exe === LEAGUE_GAME_EXECUTABLE) return true;
  if (source.processPath && /league of legends\.exe$/i.test(source.processPath)) return true;
  const name = source.name.trim().toLowerCase();
  if (name.includes('league of legends (tm) client')) return true;
  return false;
}

/**
 * Checks if a window source is the League of Legends client
 * (champion selection, lobby, shop, profile).
 */
export function isLeagueClient(source: SourceInfo): boolean {
  if (source.kind !== 'window') return false;
  if (isLeagueGame(source)) return false;
  const exe = executableName(source);
  if (LEAGUE_CLIENT_EXECUTABLES.includes(exe as (typeof LEAGUE_CLIENT_EXECUTABLES)[number])) {
    return true;
  }
  if (source.processPath && /leagueclient(ux)?\.exe$/i.test(source.processPath)) return true;
  const name = source.name.trim().toLowerCase();
  if (name === 'league of legends' || name.startsWith('league of legends')) return true;
  return false;
}

/**
 * Checks if a window source belongs to League of Legends (either the client or the match).
 */
export function isLeagueSource(source: SourceInfo): boolean {
  return isLeagueGame(source) || isLeagueClient(source);
}

/**
 * Identifies both parts of League of Legends from a list of sources.
 */
export function findLeagueSources(sources: SourceInfo[]): {
  game: SourceInfo | null;
  client: SourceInfo | null;
} {
  const game = sources.find(isLeagueGame) ?? null;
  const client = sources.find(isLeagueClient) ?? null;
  return { game, client };
}

/**
 * Resolves the target League of Legends window according to Discord's behavior:
 * If the match is running (game window is open), opt for the game.
 * Otherwise, opt for the client window (champion selection / lobby).
 */
export function resolveLeagueTarget(
  sources: SourceInfo[],
  fallback?: SourceInfo | null,
): SourceInfo | null {
  const { game, client } = findLeagueSources(sources);
  if (game) return game;
  if (client) return client;
  if (fallback && isLeagueSource(fallback)) return fallback;
  return null;
}
