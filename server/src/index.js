#!/usr/bin/env node
/** Entry point: wires config, key store and token issuer into the HTTP app. */

import { RoomServiceClient } from 'livekit-server-sdk';

import { loadConfig } from './config.js';
import { createKeyStore } from './keys.js';
import { createPairingStore } from './pairings.js';
import { createDeviceStore } from './devices.js';
import { createTokenIssuer } from './token.js';
import { createStage } from './stage.js';
import { createWhipPublisher } from './whip.js';
import { createReportStore } from './reports.js';
import { createChannelStore } from './channels.js';
import { createAvatarStore } from './avatars.js';
import { createApp } from './app.js';

try {
  process.loadEnvFile('.env');
} catch {
  // Container deployments inject the environment directly.
}

const config = loadConfig();

const keyStore = createKeyStore({ file: config.keyStoreFile });
const pairingStore = createPairingStore({ file: config.pairingStoreFile });
const deviceStore = createDeviceStore({ file: config.deviceStoreFile });
const avatarStore = createAvatarStore({ dir: config.avatarDir });
// Names are unique per server; settle any shared from before they were.
await deviceStore.dedupeNames();
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

const app = createApp({
  config,
  keyStore,
  tokenIssuer,
  channels,
  reports,
  pairingStore,
  deviceStore,
  avatarStore,
});

app.listen(config.port, () => {
  console.log(`[zoia] listening on :${config.port}`);
  console.log(`[zoia] public host  ${config.publicHost}`);
  console.log(`[zoia] livekit ws   ${config.livekit.wsUrl}`);
  console.log(`[zoia] channels     default ${config.roomName}, up to ${config.channels.max}`);
  if (config.trustProxy === 0) {
    console.warn('[zoia] TRUST_PROXY is 0 — behind a reverse proxy this breaks rate limiting');
  }
});
