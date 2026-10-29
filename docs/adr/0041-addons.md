# 41. Addons: containers the super admin installs, behind an API of permissions

- **Status:** proposed
- **Date:** 2026-10-29

## Context

People want more from the server than it does: a music bot in voice first, and others after
it that nobody here will write. Each would otherwise be a change to Zoia itself, deployed
with it, holding everything Zoia holds.

An addon needs to:

- answer commands typed in a chat (`!play …`);
- write in that chat, as a bot of its own;
- play audio, or share video, in a channel;
- read the channels, the people, and the server's name; manage people, sometimes;
- be configured by the super admin, from the app.

Three places it could run were weighed:

- **Inside the app**, as a child process under Node's permission model. No Docker
  socket, but an addon shares the app's container, its files and its network, and cannot
  bring what it needs (ffmpeg, yt-dlp) without Zoia's image carrying it for everyone.
- **Anywhere, run by whoever wants it**, with Zoia only registering its address. Zoia
  holds no privilege, but installing becomes "deploy it yourself, then connect it", which
  is not what was asked.
- **In a container of its own**, started on the VM by a small service that holds the
  Docker socket. Each addon brings its own image and dependencies, sees nothing of Zoia's
  but the API, and the super admin installs it with a click.

## Decision

**An addon is a container image, published to ghcr.io by its GitHub repository, run on the
VM by the addon host.**

**Installing.** The super admin names a repository (`owner/name`). The server reads its
latest GitHub release and the `zoia-addon.json` attached to it: the addon's id, name,
version, image, the permissions it asks for, its `!` commands and its settings. The app
shows the permissions; on confirmation the server records the addon, mints its token, and
asks the host to pull the image and start it. The image is named by digest
(`ghcr.io/…@sha256:…`), never by tag, so what runs is what was shown, whatever is pushed
afterwards. Updating reads the new latest release the same way, and a release asking for a
permission not yet granted needs the super admin to grant it.

**The addon host** (`addon-host/`) is the one container given `/var/run/docker.sock`. It
listens only on the compose network, answers only the app (a shared secret,
`ADDON_HOST_SECRET`), and does five things: pull by digest, run, stop, remove, read logs. An
addon's container gets its token and Zoia's internal address in its environment, a network
of its own that reaches the app and the internet, 512 MB and one CPU, no new privileges,
no Docker socket and no volumes of Zoia's.

**The API** is `/api/addon/v1`, authenticated by `Authorization: Bearer zaddon_<id>_<secret>`.
The token is checked like every credential, and the addon is re-read on every request: one
disabled or uninstalled is refused at once. Every route requires one permission:

| Permission | Allows |
|---|---|
| `chat.read` | Read the chats it is bound to |
| `chat.write` | Write in them, as one of its bots |
| `commands` | Its `!` commands in them |
| `channels.read` | The channels and who is in each |
| `users.read` | Names, roles and pictures; never emails |
| `users.manage` | Disable, enable and move people who are not admins |
| `bots.create` | Up to five bot users of its own |
| `voice.publish` | Audio in a channel, as a bot |
| `video.publish` | Video in a channel, as a bot |
| `server.read` | The server's name and limits |

Events reach the addon on a server-sent event stream it opens (`GET /events`), so its
container publishes no port.

**Commands.** The super admin binds an addon to chats. A message in a bound chat that
starts with one of its commands is stored as any other, then sent to the addon as a
`command` event: who wrote it, the arguments, and which voice channel they are in. The
super admin renames commands for everyone (`!play` to `!p`); autocomplete in the app
offers the names as they are on the server.

**Bots** are accounts with an `addon_id`: active at once, always `user`, with no password,
no reset code and no way to be made admin. They go when their addon is uninstalled. A bot
in a channel is a LiveKit participant `bot-<account id>` with the attribute `zoia.bot`.

**Publishing is the one exception to invariant 1.** A bot of an addon granted
`voice.publish` is given a token that may publish the microphone alone, with the voice
attribute set: to everyone in the channel it is someone in voice, played and turned down as
a person is, and it holds no broadcast slot (ADR 0039). `video.publish` adds a camera. The
token is minted by the server, for that bot's identity only; nobody's own join token
changes.

**Settings** are declared by the manifest as fields of known types (text, secret, number,
on/off, choice, chat, channel) and drawn by the app. No addon code runs in the app. A
secret is sent to the addon and never back to the app: the app only learns whether it is
set.

## Consequences

- **The addon host is root on the VM in all but name**, as anything holding the Docker
  socket is. It accepts nothing from the internet and only digest-pinned images, but
  installing an addon is trusting its author, and the install dialog says so.
- An addon's container reaches the internet, which a music addon needs; one that only
  needs Zoia still has it. A network policy per addon is left for when one needs it.
- Addons are found on GitHub and pulled from ghcr.io. A private repository or image would
  need credentials the host does not have, so addons are public.
- A bot's audio is a microphone track, so Android plays it as anyone's voice, with no
  change there.
- The permission list is an API: renaming one breaks every addon asking for it. New ones
  can be added; old ones are kept.
