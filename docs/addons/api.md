# The addon API

Base: `$ZOIA_URL/api/addon/v1`. Every request carries the addon's token:

```
Authorization: Bearer $ZOIA_ADDON_TOKEN
```

Bodies are JSON. A refusal is a status and `{ "error": "<code>" }`, sometimes with more:

| Status | `error` | Means |
|---|---|---|
| 401 | `unauthenticated` | No token, a wrong one, or the addon was uninstalled. |
| 403 | `addon_disabled` | The super admin turned it off. Wait; you get a new token when it is back on. |
| 403 | `missing_permission` | Not granted; `permission` says which. |
| 403 | `not_bound` | The chat is not one the addon is bound to. |
| 403 | `forbidden` | Not someone this addon may act on (an admin, another addon's bot). |
| 404 | `not_found`, `unknown_account`, `unknown_room` | No such thing; `field` may say which. |
| 429 | `too_many_requests` | More than 50 requests in 10 seconds. |
| 503 | `chat_unavailable` | The chat database is down for now. |

## Who you are

### `GET /me`

No permission needed.

```json
{
  "id": "a1b2c3d4",
  "key": "zouve",
  "name": "Zouve",
  "version": "1.2.0",
  "permissions": ["chat.write", "commands", "bots.create", "voice.publish"],
  "settings": { "volume": 60, "spotifyClientSecret": "…" },
  "commands": { "play": "p", "skip": "skip" },
  "chats": ["9f8e7d6c"],
  "bots": [{ "id": "0badc0de", "name": "Zouve", "role": "user", "status": "active", "avatar": null, "bot": true }]
}
```

`commands` maps each of your commands to what it is typed as on this server.

## Events

### `GET /events`

A [server-sent event](https://html.spec.whatwg.org/multipage/server-sent-events.html) stream.
Open it, keep it open, and open it again when it ends, after a pause. Lines starting with `:`
keep it alive. At most three at once per addon.

| Event | Needs | `data` |
|---|---|---|
| `command` | `commands` | One of your commands, typed at the start of a message in a bound chat. |
| `message` | `chat.read` | Any message in a bound chat. |
| `settings` | | `{ "settings": {…} }`, after the super admin saves them. |
| `commands` | | `{ "commands": {…} }`, after a command is renamed. |
| `chats` | | `{ "chats": [ids] }`, after the bound chats change. |

A `command`:

```json
{
  "chatId": "9f8e7d6c",
  "messageId": "e1c9a2b0-…",
  "body": "!p never gonna give you up",
  "author": { "id": "5e5e5e5e", "name": "Ana", "role": "user" },
  "command": "play",
  "name": "p",
  "args": "never gonna give you up",
  "voice": { "channel": "zoia" }
}
```

`command` is the name you gave it; `name` is what was typed. `voice` is the channel the
author is in voice in, or `null`. A `message` has the same fields up to `author`. Messages
by bots, yours included, are never commands and never sent as events.

## The server

### `GET /server` (`server.read`)

```json
{ "name": "Zoia", "channels": { "count": 3, "max": 5 }, "chats": { "count": 2, "max": 10 } }
```

### `GET /channels` (`channels.read`)

```json
{ "channels": [{ "id": "zoia", "name": "Geral", "isDefault": true,
  "people": [{ "accountId": "5e5e5e5e", "name": "Ana", "voice": true, "bot": false }] }] }
```

## People

### `GET /users` (`users.read`)

Everyone approved: `{ "users": [{ "id", "name", "role", "status", "avatar", "bot" }] }`.

### `POST /users/:id/disable`, `POST /users/:id/enable` (`users.manage`)

Only a plain user, or a bot of your own. Disabling takes them out of every channel at once.
Answers `{ "user": {…} }`.

### `POST /users/:id/move` (`users.manage`)

`{ "channel": "<id>" }`. Asks each of their machines in a channel to switch to it, as an
admin's drag does. Answers `{ "moved": <machines> }`; `409 not_connected` if they are in
none.

## Bots

### `GET /bots`

Your bots: `{ "bots": [...] }`.

### `POST /bots` (`bots.create`)

`{ "name": "Zouve" }`, made unique on the server if it is taken. Up to five per addon; they
outlive your container, so look in `GET /me` before making one. Answers `201 { "bot": {…} }`.

### `DELETE /bots/:id` (`bots.create`)

## Chats

### `POST /chats/:id/messages` (`chat.write`)

```json
{ "bot": "0badc0de", "body": "Now playing: …", "replyTo": "e1c9a2b0-…" }
```

Up to 4000 characters, written as the bot, in a chat the addon is bound to. `replyTo` is
optional. Answers `201 { "message": {…} }`.

## Voice

### `POST /voice/token` (`voice.publish`)

```json
{ "bot": "0badc0de", "channel": "zoia", "video": false }
```

A LiveKit token for the bot to join that channel's room, already in voice: it may publish a
microphone track, and a camera with `video: true` (which needs `video.publish`), and
nothing else. It subscribes to nothing.

```json
{ "token": "eyJ…", "wsUrl": "wss://sfu.example.com", "room": "zoia",
  "identity": "bot-0badc0de", "name": "Zouve" }
```

Join with a LiveKit SDK for servers, such as
[`@livekit/rtc-node`](https://www.npmjs.com/package/@livekit/rtc-node), at
`ZOIA_LIVEKIT_URL` when it is set (it is, inside Zoia's addon host), else `wsUrl`. Publish
your audio as the **microphone** source: everyone hears a bot as they hear a person in
voice, with its own volume slider, and it never counts as a broadcast. The token lasts ten
minutes; a connected participant stays connected, but ask for a new one to rejoin.

### `POST /voice/leave` (`voice.publish`)

`{ "bot": "…", "channel": "…" }`. Takes the bot out of that channel's room from the server's
side.
