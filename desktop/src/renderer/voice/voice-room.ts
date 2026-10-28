/**
 * Who is in voice, read from the room (ADR 0039).
 *
 * The server sets the attribute together with the microphone-only permission,
 * so it is the one record of who joined, and it leaves with the participant.
 */

import { Track, type Participant, type TrackPublication } from 'livekit-client';

/** Must match VOICE_ATTRIBUTE in server/src/stage.js. */
export const VOICE_ATTRIBUTE = 'zoia.voice';

export function inVoice(participant: Participant | null | undefined): boolean {
  return participant?.attributes?.[VOICE_ATTRIBUTE] === '1';
}

/**
 * A microphone that belongs to voice rather than to a camera. Someone in
 * voice has one microphone, and a camera they share uses it, so every
 * microphone of theirs is voice.
 */
export function isVoiceMicrophone(
  participant: Participant,
  publication: TrackPublication,
): boolean {
  return publication.source === Track.Source.Microphone && inVoice(participant);
}
