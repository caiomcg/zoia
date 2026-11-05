# 47. Direct messages, private to the two people in them

- **Status:** proposed
- **Date:** 2026-11-05
- **Amends** [ADR 0036](0036-text-chat-in-scylladb.md), under which every chat is visible to
  every approved account, and [ADR 0038](0038-presence.md), whose People tab moves into Chats

## Context

Every chat is public to everyone let in. There is nowhere to say something to one person
without the server reading it out to everyone else's app, so people leave Zoia for that.

The chat machinery (messages, replies, mentions, reactions, edits, photos, read markers, the
live stream) is general. What a private conversation needs is a different answer to "who may
see this", asked everywhere the public chats assume "everyone".

## Decision

**A direct chat is a chat of two.** It is a row in a new SQLite table, `direct_chats`
(schema version 5): an id of its own shape, `dm-` and sixteen hex characters, and the two
account ids, the lower first, unique as a pair and checked so the pair cannot be written the
other way round. It goes when either account is deleted. Its messages are in ScyllaDB under
its id, in the same tables as any chat's, so everything a chat does a direct chat does.

**Only its two members can reach it, and to anyone else it does not exist.** The chat routes
resolve every id through one function: a direct chat is found only when the caller is one of
its two, and otherwise answers `404` exactly as an id that was never made, so nobody can tell
whether one exists. **Admins are not an exception**: moderation stops at the public chats.
The admin routes that rename and remove chats only know the public list.

**Its live events go only to its members.** The chat hub's `publish` takes the account ids
allowed to hear an event; every message, read, edit, deletion, reaction and typing event of a
direct chat names its two. Events of the public chats go to everyone, as before.

**Its photos and videos are its members' too.** They are kept in a folder named after the
direct chat, and the file route now checks the caller may read the chat before serving one,
which it did not need to while every chat was public.

**Opening one** is `POST /api/chats/direct` with the other person's account id: it returns the
pair's chat, made if there was none. Never with yourself, someone not let in, or a bot: an
addon must not be handed anyone's private conversation. **The list** (`GET /api/chats`) now
carries `direct`, the caller's own, each with who it is with and its unread count, newest
conversation first. A direct chat shows to whoever opened it, and to the other once someone
has written in it, so opening one by mistake does not appear on the other person's screen.

**Mentions** in a direct chat can only name its two members. **Addons** never hear a direct
message: the hook that hands messages to addons runs for the public chats alone, and an addon
can only be bound to a public chat.

In the app, the sidebar has two tabs, Channels and Chats, and a button for events (ADR 0050).
Channels is voice alone. Chats holds the text chats, then direct messages, then the people on
the server, online first and offline folded: the People tab of ADR 0038 is folded into it,
since the one thing done there, writing to someone, belongs beside the conversations. The
Chats tab carries the unread count and an @ when someone wrote to you, so the list announces
itself while Channels is open.
Voice channels list everyone in them, which pushed any section below them out of sight once a
few people joined: attention falls off sharply below the first screen (NN/g, "Scrolling and
Attention"), and Slack and Teams both give direct messages a place of their own. Clicking
someone in the people list, or the + over direct messages, opens one; the list shows a count
beside whoever has written to you. A direct message plays the mention sound.

## Consequences

- **A server admin can still read them.** "Private" means private from the other people on
  the server and from addons, not from whoever runs the VM: the messages are in the same
  Scylla keyspace, unencrypted, and `cqlsh` reads them. End-to-end encryption would need keys
  on every device and is not worth it for a server among friends. The app should not claim
  more than this.
- **No moderation.** An admin cannot delete an abusive direct message; the recipient can
  only stop answering. Blocking someone is not built.
- **`hub.publish` gained an audience.** A new event about a direct chat that forgets to pass
  it goes to everyone. `messaging.test.js` checks a direct chat's message, typing and
  reaction never reach a third person's stream; it fails if the audience is dropped.
- A direct chat is never removed. Deleting an account removes the row, and its messages stay
  in Scylla under an id nobody can reach any more, as a removed chat's do when Scylla is down.
- The Android viewer does not show chat at all, direct or not.
