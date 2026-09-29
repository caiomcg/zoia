# 27. Profile pictures: a version in the room, the picture from the app server

- **Status:** proposed
- **Date:** 2026-09-29

## Context

People are shown by their initials on a colour. They asked to use a picture instead, set
from Settings › Profile by clicking that circle. The picture has to reach everyone in the
room at once, like a rename does, and still be there after a restart or for someone who
joins later.

The obvious carrier is LiveKit itself: put the picture in a participant attribute. But the
`zoia.watching` attribute changes every time someone picks or pauses a broadcast, and each
change resends the participant's attributes to the whole room. A few KB of picture would
ride along with every one of those updates, to every viewer.

## Decision

- **The app server stores the picture**, one file per device under `server/data/avatars/`
  (so it shares the key store's volume and `deploy.sh`'s exclude). The client crops and
  scales it to a 256px WebP before upload; the server accepts at most 256KB, judges the
  type by the bytes (PNG, JPEG or WebP only), and serves it back with that type and
  `nosniff`.
- **The room carries only a version**: a 16-character hash of the picture, in the
  `zoia.avatar` attribute. The join token sets it from the device record, and a change is
  pushed live with `setAttributes`, which `canUpdateOwnMetadata` already allows. The channel
  list (`/api/rooms`) passes it on for people in other channels.
- **Clients fetch the picture once per version**, by the participant's identity, through
  the main process (which holds the session cookie), as a `data:` URL the page's CSP
  already allows.

## Consequences

- The attribute is only a cache key. A client can set any value it likes on itself, but a
  picture is always looked up by identity, so it can only ever show its own.
- The picture is tied to a device, like the display name. Someone on two machines sets it
  on each.
- Invite-key (browser) sessions cannot set one: the browser client is retired
  ([ADR 0021](0021-retire-the-browser-viewer.md)), and a key id could collide with a device
  id.
- A revoked device's picture stops being served, though its file stays on disk until the
  device sets or removes one.
