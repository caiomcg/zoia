import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { SourceInfo } from '../src/shared/ipc.ts';
import {
  isLeagueGame,
  isLeagueClient,
  isLeagueSource,
  findLeagueSources,
  resolveLeagueTarget,
  executableName,
} from '../src/shared/league.ts';

const clientSource: SourceInfo = {
  id: 'window:1001:0',
  name: 'League of Legends',
  kind: 'window',
  thumbnailDataUrl: '',
  processId: 1001,
  processPath: 'C:\\Riot Games\\League of Legends\\LeagueClientUx.exe',
  hwnd: 1001,
};

const gameSource: SourceInfo = {
  id: 'window:2002:0',
  name: 'League of Legends (TM) Client',
  kind: 'window',
  thumbnailDataUrl: '',
  processId: 2002,
  processPath: 'C:\\Riot Games\\League of Legends\\Game\\League of Legends.exe',
  hwnd: 2002,
};

const discordSource: SourceInfo = {
  id: 'window:3003:0',
  name: 'Discord',
  kind: 'window',
  thumbnailDataUrl: '',
  processId: 3003,
  processPath: 'C:\\Users\\User\\AppData\\Local\\Discord\\app-1.0.9000\\Discord.exe',
  hwnd: 3003,
};

const screenSource: SourceInfo = {
  id: 'screen:0:0',
  name: 'Screen 1',
  kind: 'screen',
  thumbnailDataUrl: '',
  processId: null,
  processPath: null,
  hwnd: null,
};

describe('League of Legends source detection', () => {
  test('executableName handles Windows and POSIX paths', () => {
    assert.equal(executableName(clientSource), 'leagueclientux.exe');
    assert.equal(executableName(gameSource), 'league of legends.exe');
    assert.equal(
      executableName({
        ...clientSource,
        processPath: '/opt/riot/LeagueClient.exe',
      }),
      'leagueclient.exe',
    );
    assert.equal(executableName(screenSource), '');
  });

  test('isLeagueGame identifies the match window', () => {
    assert.equal(isLeagueGame(gameSource), true);
    assert.equal(isLeagueGame(clientSource), false);
    assert.equal(isLeagueGame(discordSource), false);
    assert.equal(isLeagueGame(screenSource), false);

    // Fallback on window title when path is missing
    const noPathGame: SourceInfo = {
      ...gameSource,
      processPath: null,
    };
    assert.equal(isLeagueGame(noPathGame), true);
  });

  test('isLeagueClient identifies the champion select / lobby window', () => {
    assert.equal(isLeagueClient(clientSource), true);
    assert.equal(isLeagueClient(gameSource), false);
    assert.equal(isLeagueClient(discordSource), false);
    assert.equal(isLeagueClient(screenSource), false);

    // Recognizes LeagueClient.exe as well
    const legacyClient: SourceInfo = {
      ...clientSource,
      processPath: 'C:\\Riot Games\\League of Legends\\LeagueClient.exe',
    };
    assert.equal(isLeagueClient(legacyClient), true);

    // Recognizes title fallback
    const titleOnlyClient: SourceInfo = {
      ...clientSource,
      processPath: null,
    };
    assert.equal(isLeagueClient(titleOnlyClient), true);
  });

  test('isLeagueSource matches both parts and excludes non-League sources', () => {
    assert.equal(isLeagueSource(clientSource), true);
    assert.equal(isLeagueSource(gameSource), true);
    assert.equal(isLeagueSource(discordSource), false);
    assert.equal(isLeagueSource(screenSource), false);
  });

  test('findLeagueSources extracts both game and client', () => {
    const both = findLeagueSources([discordSource, clientSource, gameSource, screenSource]);
    assert.equal(both.client?.id, clientSource.id);
    assert.equal(both.game?.id, gameSource.id);

    const clientOnly = findLeagueSources([discordSource, clientSource]);
    assert.equal(clientOnly.client?.id, clientSource.id);
    assert.equal(clientOnly.game, null);

    const none = findLeagueSources([discordSource, screenSource]);
    assert.equal(none.client, null);
    assert.equal(none.game, null);
  });

  test('resolveLeagueTarget opts for the game when game is open', () => {
    // If both game and client are open, it must opt for the game
    const targetWithBoth = resolveLeagueTarget([clientSource, gameSource]);
    assert.equal(targetWithBoth?.id, gameSource.id);

    // Even if game is later in the array
    const targetReversed = resolveLeagueTarget([gameSource, clientSource]);
    assert.equal(targetReversed?.id, gameSource.id);
  });

  test('resolveLeagueTarget opts for the client when game is closed', () => {
    // Only client is open (champion select / lobby)
    const targetClientOnly = resolveLeagueTarget([clientSource]);
    assert.equal(targetClientOnly?.id, clientSource.id);
  });

  test('resolveLeagueTarget falls back safely when neither is open', () => {
    const targetNone = resolveLeagueTarget([discordSource]);
    assert.equal(targetNone, null);

    const targetWithFallback = resolveLeagueTarget([discordSource], clientSource);
    assert.equal(targetWithFallback?.id, clientSource.id);
  });
});
