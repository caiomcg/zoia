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
const stage = createStage({ rooms, roomName: config.roomName });
// Derived from LIVEKIT_WS_URL: the SFU's own WHIP endpoint on the host clients
// already connect to. There is no separate address to configure.
const whip = createWhipPublisher({
  apiKey: config.livekit.apiKey,
  apiSecret: config.livekit.apiSecret,
  wsUrl: config.livekit.wsUrl,
  roomName: config.roomName,
  rooms,
  stage,
});

const reports = createReportStore();

const app = createApp({
  config,
  keyStore,
  tokenIssuer,
  stage,
  whip,
  reports,
  pairingStore,
  deviceStore,
});

app.listen(config.port, () => {
  console.log(`[zoia] listening on :${config.port}`);
  console.log(`[zoia] public host  ${config.publicHost}`);
  if (config.upstream) console.log(`[zoia] room server  ${config.upstream}`);
  else console.log(`[zoia] livekit ws   ${config.livekit.wsUrl}`);
  console.log(`[zoia] room         ${config.roomName}`);
  if (config.trustProxy === 0) {
    console.warn('[zoia] TRUST_PROXY is 0 — behind a reverse proxy this breaks rate limiting');
  }
});
