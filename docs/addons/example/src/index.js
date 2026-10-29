/** Starts Echo in its container, with what the addon host put in its environment. */

import { createEchoAddon } from './addon.js';

const { ZOIA_URL, ZOIA_ADDON_TOKEN } = process.env;
if (!ZOIA_URL || !ZOIA_ADDON_TOKEN) {
  console.error('ZOIA_URL and ZOIA_ADDON_TOKEN are set by the addon host; run this there.');
  process.exit(1);
}

const addon = createEchoAddon({ zoiaUrl: ZOIA_URL, token: ZOIA_ADDON_TOKEN });
process.on('SIGTERM', () => {
  addon.stop();
  process.exit(0);
});
await addon.run();
