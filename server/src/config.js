/** Environment parsing. Validates once at startup so misconfiguration fails loudly. */

const required = ['SESSION_SECRET', 'LIVEKIT_API_KEY', 'LIVEKIT_API_SECRET', 'LIVEKIT_WS_URL'];

export function loadConfig(env = process.env) {
  const missing = required.filter((name) => !env[name]);
  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables: ${missing.join(', ')}. ` +
        'Copy .env.example to .env and fill them in.',
    );
  }

  if (env.SESSION_SECRET.length < 16) {
    throw new Error('SESSION_SECRET is too short; generate one with: openssl rand -base64 48');
  }

  return {
    port: Number(env.PORT ?? 3000),
    publicHost: env.PUBLIC_HOST ?? 'localhost:3000',
    sessionSecret: env.SESSION_SECRET,
    roomName: env.ROOM_NAME ?? 'zoia',
    // Number of proxy hops to trust. Behind the caddy front end this is 1; if it
    // stays 0, every request looks like it came from the proxy and the rate
    // limiter throttles all users as a single client.
    trustProxy: Number(env.TRUST_PROXY ?? 0),
    livekit: {
      apiKey: env.LIVEKIT_API_KEY,
      apiSecret: env.LIVEKIT_API_SECRET,
      wsUrl: env.LIVEKIT_WS_URL,
      // Server-side API endpoint, used only to create the room.
      apiUrl: env.LIVEKIT_API_URL ?? 'http://127.0.0.1:7880',
    },
    keyStoreFile: env.KEY_STORE_FILE ?? 'server/data/keys.json',
    // Broadcast quality. Tunable without a code change because the right
    // values depend entirely on the uplink: the server sends one copy of the
    // stream per remote viewer, so upload = bitrate x viewers.
    quality: {
      maxBitrate: Number(env.MAX_BITRATE ?? 12_000_000),
      maxFramerate: Number(env.MAX_FRAMERATE ?? 60),
      width: Number(env.CAPTURE_WIDTH ?? 1920),
      height: Number(env.CAPTURE_HEIGHT ?? 1080),
      codec: env.VIDEO_CODEC ?? 'h264',
    },
    // Cookies must be Secure in production; local development over plain HTTP
    // would otherwise never receive one back.
    secureCookies: (env.SECURE_COOKIES ?? 'true') !== 'false',
  };
}
