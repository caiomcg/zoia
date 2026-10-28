/**
 * Disconnecting a machine from its channel, and doing it to whoever sits in a
 * channel doing nothing. See ADR 0037.
 *
 * The app learns why, an admin or idleness, from a message on KICK_TOPIC sent
 * just before the server removes it from its room; LiveKit's removal alone
 * cannot say. It leaves the channel and says so; the chats stay open to it.
 * The removal does not rely on the app: one that ignores the message is
 * still out of the room.
 */

import { ownerOf } from './whip.js';

/** Must match KICK_TOPIC in desktop/src/renderer/livekit/useRoom.ts. */
export const KICK_TOPIC = 'zoia.kick';

/**
 * How long the message gets to arrive before the removal. It travels on the
 * data channel and the removal on the signalling connection, so without a
 * pause the removal can win and the app takes it for a channel disconnect.
 */
export const KICK_GRACE_MS = 750;

/** How often the sweep looks for idle people. */
export const IDLE_SWEEP_MS = 60_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Tells one machine why it is being kicked, then takes it out of its room. */
export async function kick(stage, identity, reason, { graceMs = KICK_GRACE_MS } = {}) {
  try {
    await stage.send(identity, KICK_TOPIC, { reason });
    if (graceMs > 0) await sleep(graceMs);
  } catch {
    // Unheard, the removal still happens; the app just says less about it.
  }
  await stage.disconnect([identity]);
}

/**
 * Kicks whoever has been in a channel for `idleMs` neither sharing (a screen,
 * a camera, a hardware broadcast), nor talking, nor watching anyone's
 * picture. Watching and voice are read from attributes on the participant,
 * since LiveKit tells nobody who subscribes to what. Everyone in a channel is
 * in voice (ADR 0039), so being in it is no activity: talking is having the
 * microphone on while someone else in voice could hear it.
 *
 * Timers live in memory: a restart gives everyone a fresh `idleMs`, which errs
 * towards keeping people rather than dropping them.
 */
export function createIdleSweeper({
  channels,
  idleMs,
  graceMs = KICK_GRACE_MS,
  logger = console,
  now = () => Date.now(),
}) {
  // By channel and identity: moving channels is activity of a sort, and
  // starts the clock again.
  const lastActive = new Map();

  return {
    async sweep() {
      const seen = new Set();
      const kicks = [];
      for (const channel of await channels.list()) {
        let participants;
        try {
          participants = await channel.stage.participants();
        } catch {
          // LiveKit unreachable for this room: judge nobody on missing data.
          for (const key of lastActive.keys()) {
            if (key.startsWith(`${channel.id}\n`)) seen.add(key);
          }
          continue;
        }
        const sharing = new Set(
          participants.filter((p) => p.publishing).map((p) => ownerOf(p.identity)),
        );
        const inVoice = participants.filter((p) => p.voice).length;
        for (const p of participants) {
          const talking = p.audible && inVoice > 1;
          if (ownerOf(p.identity) !== p.identity) continue;
          const key = `${channel.id}\n${p.identity}`;
          seen.add(key);
          if (sharing.has(p.identity) || p.watching || talking || !lastActive.has(key)) {
            lastActive.set(key, now());
          } else if (now() - lastActive.get(key) >= idleMs) {
            lastActive.delete(key);
            logger.info(`[idle] kicked ${p.identity} from ${channel.id}`);
            kicks.push(kick(channel.stage, p.identity, 'idle', { graceMs }));
          }
        }
      }
      for (const key of lastActive.keys()) if (!seen.has(key)) lastActive.delete(key);
      await Promise.allSettled(kicks);
    },

    /** Sweeps every IDLE_SWEEP_MS until stopped. */
    start(every = IDLE_SWEEP_MS) {
      const timer = setInterval(() => {
        this.sweep().catch((err) => logger.warn(`[idle] sweep failed: ${err?.message ?? err}`));
      }, every);
      timer.unref?.();
      return () => clearInterval(timer);
    },
  };
}
