# Architecture decision records

One file per decision that would otherwise be re-litigated, or re-discovered the hard way.
Each records the context at the time, what was chosen, and what it cost — including the
options that were tried and abandoned, which is usually the part worth reading.

They are not updated as the system changes. A decision that stops being true gets a new
record that supersedes it, so the history stays legible.

| # | Decision | Status |
|---|---|---|
| [0001](0001-livekit-sfu.md) | Use a self-hosted LiveKit SFU | accepted |
| [0002](0002-invite-keys-over-shared-password.md) | Per-person invite keys, not a shared password | accepted, extended by [0007](0007-device-pairing.md) |
| [0003](0003-npm-as-front-door.md) | Reuse an existing reverse proxy as the front door | superseded by [0004](0004-isolated-caddy-front-end.md) |
| [0004](0004-isolated-caddy-front-end.md) | An isolated Caddy front end on the VM | accepted |
| [0005](0005-one-tier-claimable-stage.md) | One tier of user, with a claimable stage | accepted |
| [0006](0006-native-desktop-client.md) | A native desktop client, for per-application audio | accepted |
| [0007](0007-device-pairing.md) | Device pairing, not a key in the binary | accepted, extended by [0010](0010-invites-outside-the-binary.md) |
| [0008](0008-retire-the-browser-client.md) | Retire the browser client | accepted |
| [0009](0009-hardware-encoding.md) | Hardware encoding via WGC and NVENC | accepted, partly superseded by [0011](0011-hardware-encoding-over-the-internet.md) |
| [0010](0010-invites-outside-the-binary.md) | The invitation lives outside the binary | accepted |
| [0011](0011-hardware-encoding-over-the-internet.md) | Hardware encoding over the internet, on any GPU | accepted |

## The two that explain the most

If you read only two: [0006](0006-native-desktop-client.md) is why this is a desktop app at
all rather than a web page, and [0009](0009-hardware-encoding.md) is why encoding on a GPU
turned out to require bypassing the browser's video stack entirely.

## Adding one

Copy the shape of an existing file: a title, `Status`, `Date`, then **Context**,
**Decision**, **Consequences**. Number sequentially. If it replaces an earlier decision, say
so in the header of both and leave the old one in place.

The consequences section is the one that earns its keep — write the costs down, including
the ones that make the decision look bad.
