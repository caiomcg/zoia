/**
 * Disconnecting a machine from its channel, and doing it to whoever sits in a
 * channel doing nothing. See ADR 0037. Where the server has an away channel
 * (ADR 0044), the idle are moved there instead, and only disconnected once
 * they have sat out its own limit too.
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
 * Asks a machine to switch channels, as a click would; an admin's move uses
 * it too. Must match MOVE_TOPIC in desktop/src/renderer/livekit/useRoom.ts.
 */
export const MOVE_TOPIC = 'zoia.move';

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
 * Acts on whoever has been in a channel for `idleMs` neither sharing (a
 * screen, a camera, a hardware broadcast), nor talking, nor watching anyone's
 * picture, nor using their computer. Watching and voice are read from
 * attributes on the participant, since LiveKit tells nobody who subscribes to
 * what. Everyone in a channel is in voice (ADR 0039), so being in it is no
 * activity: talking is having the microphone on while someone else in voice
 * could hear it. Using the computer is `inUse`, the machine's own report of
 * keyboard and mouse (ADR 0038): someone playing a game with the channel
 * open, only listening, is there.
 *
 * With an away channel (ADR 0044), someone idle elsewhere is moved there. One
 * whose app does not switch (an Android viewer, an app from before this) is
 * still there at the next sweep, and is disconnected then. The away channel
 * has a limit of its own, `awayIdleMs`, after which they are disconnected.
 * A limit of 0 acts on nobody in the channels it covers.
 *
 * Timers live in memory: a restart gives everyone a fresh `idleMs`, which errs
 * towards keeping people rather than dropping them.
 */
export function createIdleSweeper({
  channels,
  idleMs,
  awayIdleMs = idleMs,
  inUse = () => false,
  graceMs = KICK_GRACE_MS,
  logger = console,
  now = () => Date.now(),
}) {
  // By channel and identity: moving channels is activity of a sort, and
  // starts the clock again.
  const lastActive = new Map();
  // Asked to go to the away channel, by the same key: whoever is still here
  // at a later sweep did not go, and is disconnected instead.
  const moved = new Set();

  return {
    async sweep() {
      const seen = new Set();
      const kicks = [];
      const list = await channels.list();
      const away = list.find((c) => c.away) ?? null;
      for (const channel of list) {
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
        const limit = channel.away ? awayIdleMs : idleMs;
        for (const p of participants) {
          const talking = p.audible && inVoice > 1;
          if (ownerOf(p.identity) !== p.identity) continue;
          const key = `${channel.id}\n${p.identity}`;
          seen.add(key);
          if (
            sharing.has(p.identity) ||
            p.watching ||
            talking ||
            inUse(p.identity) ||
            !lastActive.has(key)
          ) {
            lastActive.set(key, now());
            moved.delete(key);
          } else if (moved.has(key)) {
            moved.delete(key);
            lastActive.delete(key);
            logger.info(`[idle] kicked ${p.identity} from ${channel.id}: did not move`);
            kicks.push(kick(channel.stage, p.identity, 'idle', { graceMs }));
          } else if (limit > 0 && now() - lastActive.get(key) >= limit) {
            if (away && !channel.away) {
              // Their clock stays: still here next time is not arriving.
              moved.add(key);
              logger.info(`[idle] moved ${p.identity} from ${channel.id} to ${away.id}`);
              kicks.push(
                channel.stage
                  .send(p.identity, MOVE_TOPIC, { channel: away.id, reason: 'idle' })
                  .catch(() => {
                    // Unheard: the next sweep finds them here and disconnects them.
                  }),
              );
            } else {
              lastActive.delete(key);
              logger.info(`[idle] kicked ${p.identity} from ${channel.id}`);
              kicks.push(kick(channel.stage, p.identity, 'idle', { graceMs }));
            }
          }
        }
      }
      for (const key of lastActive.keys()) if (!seen.has(key)) lastActive.delete(key);
      for (const key of moved) if (!seen.has(key)) moved.delete(key);
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
