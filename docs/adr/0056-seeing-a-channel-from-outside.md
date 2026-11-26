# 56. Seeing a channel from outside: voice state and broadcast previews

- **Status:** proposed
- **Date:** 2026-11-26
- **Extends** [ADR 0015](0015-channels.md) and [ADR 0039](0039-voice-channels.md)

## Context

The channel list already shows who is in every channel, from the server's poll of
`/api/rooms`. Everything else about a channel was only visible from inside it: whether the
people there are muted or deafened, and what anyone live there is sharing. Finding out meant
joining, which drops you out of the channel you were in, plays your entrance sound to
everyone, and stops your own broadcast.

## Decision

**Voice state rides on the channel list.** Each participant in `/api/rooms` now carries
`voice`, and in voice `muted` and `deafened`, read from the same one-second shared LiveKit
read as the rest of the list: muted is in voice with no unmuted microphone, deafened is the
`zoia.deafened` attribute each app sets on itself. The desktop draws the same mark beside
them as their row inside the channel has. Display only: nothing is decided from either.

**A broadcast's label rides on it too.** Each broadcaster carries `source` (`name`, `kind`),
parsed from the metadata their app already sets for viewers inside the channel.

**The picture is a still the broadcaster sends.** While live, the broadcaster's app grabs
one frame of what it shares every 15 s (3 s after going live or switching), scales it to a
320×180 JPEG at quality 0.7 (10–25 KB) and `PUT`s it to `/api/stage/preview`. The server
keeps the latest per broadcaster in memory and lists its version on the broadcaster in
`/api/rooms`; others fetch it from `/api/rooms/:id/preview/:identity`, through the main
process for the cookie, and see it on hovering a live person in another channel.

- Only someone broadcasting in that channel may set one, read live from LiveKit as a claim is
  (`409 not_stage_holder` otherwise). It must start like a JPEG and weigh at most 64 KB, and
  comes no faster than every 5 s (`429`).
- It goes when the broadcast does: dropped on release, not served once its owner is no longer
  live there (a crash, a kick, a move), and forgotten 60 s after its last upload whatever
  happens.
- A camera with a background effect (ADR 0053) is grabbed from the processed track, never
  the raw one, so the preview shows only what viewers already receive.
- Anyone signed in may fetch it, as anyone signed in may join the channel and watch.

**Alternatives not taken.** Letting outsiders subscribe to the video (a hidden LiveKit
participant on the low layer) would make the preview live, but costs the broadcaster upstream
bandwidth per person hovering, needs a token for a room the person is not in, and a hardware
(WHIP) broadcast has no low layer to give. Having the server render frames itself would need
it to subscribe and decode, which is the transcoding the SFU exists to avoid.

## Consequences

- A broadcaster uploads one small picture every 15 s whether or not anyone outside looks:
  about 1.5 KB/s, negligible beside the broadcast itself.
- The picture can be up to 15 s old, and the voice marks as old as the channel poll. It says
  what is on, not what is happening this second.
- Window titles and the picture, so far seen only by those in the channel, are now seen by
  everyone signed in without joining. On a server where every account may join every channel
  that widens nothing, but it does mean someone can glance at your screen without the channel
  ever showing them there, and without your "who is watching" counting them.
- Previews live in the server's memory: up to 64 KB per broadcaster, lost on a restart until
  the next upload.
- An older app sends no previews; its broadcasts show the label alone, or "no picture yet".
  An older server sends neither field and the list looks as before.
