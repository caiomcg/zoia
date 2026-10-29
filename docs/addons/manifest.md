# The manifest: `zoia-addon.json`

Each release of your addon carries a `zoia-addon.json` as a release asset. It is what the
super admin is shown before installing, so the server refuses anything it does not
understand rather than ignoring it.

```json
{
  "id": "zouve",
  "name": "Zouve",
  "version": "1.2.0",
  "description": "Plays music in voice, from links or a search.",
  "image": "ghcr.io/caiomcg/zouve@sha256:0f3c…",
  "permissions": ["chat.write", "commands", "bots.create", "voice.publish", "channels.read"],
  "commands": [
    { "name": "play", "description": "Plays a song, or adds it to the queue", "usage": "<link or search>" },
    { "name": "skip", "description": "Skips to the next song" }
  ],
  "settings": [
    { "key": "volume", "type": "number", "label": "Volume", "min": 0, "max": 100, "default": 60 },
    { "key": "spotifyClientSecret", "type": "secret", "label": "Spotify client secret" }
  ]
}
```

## Fields

| Field | Required | What it is |
|---|---|---|
| `id` | yes | Your addon's id: 2 to 32 of `a-z`, `0-9`, `-`, starting with a letter. The same in every release; a release with another id is refused as an update. |
| `name` | yes | What people see, up to 40 characters. |
| `version` | yes | `MAJOR.MINOR.PATCH`, with an optional `-prerelease`. Each release must change it. |
| `description` | no | One or two sentences, up to 300 characters. |
| `image` | yes | `ghcr.io/<owner>/<name>@sha256:<64 hex>`. By digest only, never by tag, and under **the same owner as the repository** it is installed from. |
| `permissions` | no | What it asks for, from the list in [README.md](README.md). Each at most once. |
| `commands` | no | Up to 20. Needs the `commands` permission. |
| `settings` | no | Up to 30 fields the super admin fills in. |

## Commands

| Field | |
|---|---|
| `name` | What it is typed as, after the `!`: 1 to 24 of `a-z`, `0-9`, `-`, starting with a letter. Unique in your addon. |
| `description` | Up to 120 characters, shown in autocomplete. |
| `usage` | Optional, up to 80: what goes after it, such as `<link or search>`. |

The super admin may rename a command on their server (`!play` to `!p`). Your addon always
receives the name **you** gave it, as `command`; what was typed is in `name`.

## Settings

Each field has a `key` (letters, digits and `_`, up to 40, starting with a letter), a
`label` (up to 80), a `type`, and optionally a `description` and `required: true`.

| Type | Is | Extra |
|---|---|---|
| `string` | Text | `default` |
| `secret` | Text shown as dots, and never sent back to the app once saved | no `default` |
| `number` | A number | `min`, `max`, `default` |
| `boolean` | On or off | `default` |
| `select` | One of a list | `options: [{ "value", "label" }]` (1 to 50), `default` |
| `chat` | One of the server's chats, by id | |
| `channel` | One of the server's voice channels, by id | |

Your addon reads the values, defaults filled in and secrets included, from `GET /me`, and
receives a `settings` event whenever they change. A setting a new release no longer
declares is dropped.
