#!/usr/bin/env node
/** Entry point: wires config, the database and the token issuer into the HTTP app. */

import { RoomServiceClient } from 'livekit-server-sdk';

import { loadConfig } from './config.js';
import { createTokenIssuer } from './token.js';
import { createStage } from './stage.js';
import { createWhipPublisher } from './whip.js';
import { createReportStore } from './reports.js';
import { createChannelStore } from './channels.js';
import { createAvatarStore } from './avatars.js';
import { openStores } from './stores.js';
import { connectInBackground } from './scylla.js';
import { createMessageStore } from './messages.js';
import { createApp } from './app.js';

try {
  process.loadEnvFile('.env');
} catch {
  // Container deployments inject the environment directly.
}

const config = loadConfig();

const {
  devices: deviceStore,
  accounts: accountStore,
  chats: chatStore,
} = openStores({
  databaseFile: config.databaseFile,
  maxPending: config.accounts.maxPending,
  defaultChatName: config.chat.defaultName,
});
const avatarStore = createAvatarStore({ dir: config.avatarDir });
const tokenIssuer = createTokenIssuer({
  apiKey: config.livekit.apiKey,
  apiSecret: config.livekit.apiSecret,
  apiUrl: config.livekit.apiUrl,
  wsUrl: config.livekit.wsUrl,
  roomName: config.roomName,
});

const rooms = new RoomServiceClient(
  config.livekit.apiUrl,
  config.livekit.apiKey,
  config.livekit.apiSecret,
);
// One LiveKit room per channel, each with its own stage and WHIP publisher.
// The WHIP endpoint is derived from LIVEKIT_WS_URL: the SFU's own, on the host
// clients already connect to, so there is no separate address to configure.
const channels = createChannelStore({
  file: config.channels.file,
  defaultId: config.roomName,
  defaultName: config.channels.defaultName,
  max: config.channels.max,
  makeRuntime: (id) => {
    const stage = createStage({ rooms, roomName: id });
    const whip = createWhipPublisher({
      apiKey: config.livekit.apiKey,
      apiSecret: config.livekit.apiSecret,
      wsUrl: config.livekit.wsUrl,
      roomName: id,
      rooms,
      stage,
    });
    return { stage, whip };
  },
});

const reports = createReportStore();

// Chat messages live in ScyllaDB (ADR 0035), which may take a minute to start.
// The app does not wait for it: until it answers, chat says it is unavailable
// and everything else works.
let messageStore = null;
if (config.chat.scylla) {
  connectInBackground({
    ...config.chat.scylla,
    onConnected: (client) => {
      messageStore = createMessageStore({ client, keyspace: config.chat.scylla.keyspace });
    },
  });
}

const app = createApp({
  config,
  tokenIssuer,
  channels,
  reports,
  deviceStore,
  avatarStore,
  accountStore,
  chatStore,
  messageStore: () => messageStore,
});

app.listen(config.port, () => {
  console.log(`[zoia] listening on :${config.port}`);
  console.log(`[zoia] public host  ${config.publicHost}`);
  console.log(`[zoia] livekit ws   ${config.livekit.wsUrl}`);
  console.log(`[zoia] channels     default ${config.roomName}, up to ${config.channels.max}`);
  const scylla = config.chat.scylla;
  console.log(
    `[zoia] chat         ${scylla ? `scylla at ${scylla.contactPoints.join(', ')}` : 'off (SCYLLA_CONTACT_POINTS not set)'}`,
  );
  if (config.trustProxy === 0) {
    console.warn('[zoia] TRUST_PROXY is 0 — behind a reverse proxy this breaks rate limiting');
  }
});
