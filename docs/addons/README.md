# Zoia addons

An addon adds to what a Zoia server does: a music bot in voice, a quiz in a chat, a bridge to
somewhere else. It is a program of yours, in a container image of yours, that the server's
super admin installs from your GitHub repository with a click. It talks to Zoia only through
the [addon API](api.md), and only as far as the permissions the super admin granted.

- [manifest.md](manifest.md): `zoia-addon.json`, what your addon is and asks for.
- [api.md](api.md): every endpoint and event, and the permission each needs.
- [publishing.md](publishing.md): building, releasing, and getting it installed.
- [example/](example/): Echo, a complete addon in about a hundred lines, which Zoia's own
  tests run against a real server.

The decision behind all this is [ADR 0041](../adr/0041-addons.md).

## What an addon can do

| With | It can |
|---|---|
| `commands` | Answer `!` commands typed at the start of a message in the chats it is bound to |
| `commands.delete` | Delete those commands once answered, to keep the chat tidy |
| `chat.read` | Hear every message in those chats |
| `chat.write` | Write in them, as one of its bots |
| `bots.create` | Have up to five bot users: always plain users, never admins, never signing in |
| `voice.publish` | Put a bot in voice in a channel and play audio there |
| `video.publish` | Share a camera as a bot, besides audio |
| `channels.read` | See the channels and who is in each, and in voice |
| `users.read` | See everyone's name, role and picture, never their email |
| `users.manage` | Disable, enable and move people who are not admins |
| `server.read` | Read the server's name and limits |

It can never see an email, a password or a device credential, never act as a person, and
never touch an admin.

## Its life on a server

1. **Install.** The super admin types your repository in Settings › Addons. The server reads
   your latest GitHub release and its `zoia-addon.json`, and shows what the addon is and asks
   for. On their yes, it records the addon, mints its token, and has the addon host pull your
   image by digest and start it.
2. **Run.** Your container starts with three variables:
   - `ZOIA_URL`: where Zoia is, from inside (`http://app:3000`).
   - `ZOIA_ADDON_TOKEN`: your addon's token. Send it as `Authorization: Bearer …`.
   - `ZOIA_LIVEKIT_URL`: where LiveKit is, from inside, for joining voice.

   It reads `GET /me` for its settings and chats, opens `GET /events`, and acts on what
   arrives. It restarts with the server, and after a crash.
3. **Configure.** The super admin binds it to chats, renames its commands for everyone, and
   fills in its settings. Each change reaches it as an event; it never has to restart.
4. **Off.** Turned off, its token is refused at once, its event stream ends, its bots leave
   voice, and its container stops. Turned on again, it gets a **new token**: the old one is
   worthless from then on.
5. **Update.** The super admin updates it to your latest release. A release asking for a
   permission it did not have needs their yes first.
6. **Uninstall.** The container goes, and so do its bots, settings and chats.

## The container it runs in

Every addon runs under the same limits, whatever it would like:

- 512 MB of memory, two CPUs, 256 processes;
- every Linux capability dropped, no new privileges;
- a **read-only root filesystem**, with a 256 MB `/tmp`: write caches and downloads there;
- no volumes: nothing survives a restart but what Zoia keeps for you (settings, bots);
- its own network, from which it reaches Zoia and the internet, and publishes nothing.

Design for a restart at any time: read your state from `GET /me` when you start.

## Security, for the super admin

Installing an addon is trusting its author. It runs their code on your server, with the
internet at hand, and with whatever you granted it. The limits above keep it away from
Zoia's data and from the machine; they do not make a hostile addon harmless to what it was
allowed to do. Read what it asks for, and install addons from people you trust.
