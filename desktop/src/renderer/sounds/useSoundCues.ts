import { useEffect, useRef } from 'react';
import { cuesBetween, type CueEvent, type CueMember } from './cues';
import { getSoundSettings } from './settings';
import { playCue } from './synth';

/**
 * The gap between the starts of two cues; one that arrives sooner waits its
 * turn. Swapping what is shared stops and restarts the broadcast within a
 * moment, and the two cues otherwise played on top of each other. Most cues
 * are over by then; a chime's tail may just overlap the next one's start.
 */
const CUE_SPACING_MS = 400;

/** When the last queued cue has finished and the next may start. */
let freeAt = 0;

function play(events: readonly CueEvent[]): void {
  const settings = getSoundSettings();
  for (const event of events) {
    if (!settings.cues[event].enabled) continue;
    const now = Date.now();
    const startAt = Math.max(now, freeAt);
    freeAt = startAt + CUE_SPACING_MS;
    const cue = () => playCue(event, settings.cues[event], settings.volume);
    if (startAt === now) cue();
    else setTimeout(cue, startAt - now);
  }
}

/**
 * Plays a cue when the channel's member list changes. The first list after
 * connecting is only a baseline: joining a channel, switching to another, or
 * reconnecting must not announce everyone who was already there.
 *
 * Arriving is announced once, to this device, when it joins a channel from
 * the list or moves to a different one — the click it just made. Reconnecting
 * to the same channel stays quiet. Leaving for no channel is announced too.
 *
 * This device's own going live and stopping follows `live`, the broadcast
 * state either path (in-app or GPU) reports, so the cue answers the click.
 */
export function useSoundCues(
  members: readonly CueMember[],
  connected: boolean,
  channel: string | null,
  live: boolean,
): void {
  const previous = useRef<readonly CueMember[] | null>(null);
  const arrivedIn = useRef<string | null>(null);

  useEffect(() => {
    if (!connected) {
      previous.current = null;
      return;
    }
    const before = previous.current;
    previous.current = members;

    let events: CueEvent[];
    if (before) {
      events = cuesBetween(before, members);
    } else {
      const arrived = arrivedIn.current !== channel;
      arrivedIn.current = channel;
      events = arrived ? ['join'] : [];
    }
    play(events);
    // The channel changes before the room does; the members are what say the
    // new room has arrived.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [members, connected]);

  // Left for no channel. Only after having arrived somewhere: a join that
  // failed before connecting also falls back to none, and has nothing to leave.
  useEffect(() => {
    if (channel !== null || arrivedIn.current === null) return;
    arrivedIn.current = null;
    play(['leave']);
  }, [channel]);

  const wasLive = useRef(live);
  useEffect(() => {
    if (live === wasLive.current) return;
    wasLive.current = live;
    play([live ? 'streamStart' : 'streamStop']);
  }, [live]);
}
