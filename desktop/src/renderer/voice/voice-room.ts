/**
 * Who is in voice, and who has stopped listening, read from the room (ADR
 * 0039).
 *
 * The server sets the voice attribute together with the microphone-only
 * permission, so it is the one record of who joined, and it leaves with the
 * participant. Deafened is set by the app itself, since only it knows.
 */

import { Track, type Participant, type TrackPublication } from 'livekit-client';

/** Must match VOICE_ATTRIBUTE in server/src/stage.js. */
export const VOICE_ATTRIBUTE = 'zoia.voice';

export function inVoice(participant: Participant | null | undefined): boolean {
  return participant?.attributes?.[VOICE_ATTRIBUTE] === '1';
}

/** Hearing nothing: deafened. Set by each app on its own participant. */
export const DEAFENED_ATTRIBUTE = 'zoia.deafened';

export function isDeafened(participant: Participant | null | undefined): boolean {
  return participant?.attributes?.[DEAFENED_ATTRIBUTE] === '1';
}

/**
 * A microphone that belongs to voice rather than to a camera. A camera sends
 * no microphone of its own any more, so every microphone of someone in voice
 * is voice; an older app's camera microphone is the exception this tells.
 */
export function isVoiceMicrophone(
  participant: Participant,
  publication: TrackPublication,
): boolean {
  return publication.source === Track.Source.Microphone && inVoice(participant);
}
