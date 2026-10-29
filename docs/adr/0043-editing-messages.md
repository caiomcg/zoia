# 43. Its author edits a message, in place, and everyone sees it was edited

- **Status:** proposed
- **Date:** 2026-10-29
- **Amends** [ADR 0036](0036-text-chat-in-scylladb.md), whose reply snapshots assumed
  messages are never edited

## Context

Chat messages (ADR 0036) could be sent and deleted, never changed. A typo meant deleting
the message and sending it again, which loses its replies' context, its reactions and its
place in the conversation. People asked to fix what they wrote, as every other chat app
lets them.

Three things had to be settled:

- **Who.** An admin may already delete anyone's message (ADR 0036). Editing is a different
  power: it puts words in someone's mouth, under their name.
- **What an edit may change.** The text, and so who it @mentions. A photo or video is the
  message; a reply is an answer to one message, not another.
- **What everyone else sees.** A message that changes silently under a reply makes the reply
  look wrong, or makes it look as if someone said what they did not.

## Decision

**Only a message's author may edit it**, an admin included: `PATCH
/api/chats/:id/messages/:messageId` answers `403 forbidden` to anyone else, and `404` for a
message that is not there (or was deleted). An admin who finds a message unacceptable
deletes it, as before. Addons cannot edit a person's message either; an addon with
`chat.write` may edit its **own bots'** messages, beside deleting them (ADR 0041), so a "now
playing" can be kept current instead of sent again.

**An edit is held to the rules of sending.** The text is cleaned by `cleanBody`: not empty,
at most 4000 characters, control characters dropped. A photo or video keeps its file and may
lose its caption, as one could be sent without. The mentions are read again from the new
text, as when sending: the app sends the account ids, and the server keeps only people who
are let in and whose `@Name` is still in the text. An edit notifies nobody again, and does
not move read markers or unread counts: it changes what was said, not who was called. The
same words again are not an edit and change nothing. Edits share the sending rate limit.

**The message is overwritten in place**, with no history: `body` and `mentions` are
replaced and a new column, `edited_at` (schema version 6), says when. The write is `UPDATE
... IF EXISTS`, a lightweight transaction, so an edit racing a delete cannot leave half a
row behind (an `UPDATE` in CQL is an upsert: without the condition it would bring back a
deleted message as a row with only the edited columns).

**Everyone sees it at once, and sees that it was edited.** The server publishes `edited` on
the chat's live stream, `{ chatId, message }` with the new body, mentions and `editedAt`;
every open app replaces the message's words in place, keeping its reactions, and shows
"(edited)" after them, with when on hover. In the desktop app the pencil beside reply and
delete, shown on your own messages only, opens the text for editing in place: Enter saves,
Shift+Enter is a new line, Escape cancels. Up in an empty message box edits your last
message. Emptying a text-only message offers to delete it instead.

**Replies show what they answer as it reads now.** A reply keeps a snapshot of the opening
words of what it answers (ADR 0036). Loading a page already reads each original by its full
key, to tell whether it was deleted; when the original has `edited_at`, the snapshot is
rebuilt from it there. The live `edited` event updates the quotes on screen the same way.

## Consequences

- **No history.** What a message said before an edit is gone from the database; nobody, an
  admin included, can see it. "(edited)" and its time are all that is left. Keeping
  versions would mean a table of them and a way to show it, for a group of friends that has
  not asked for it.
- An edit can still change the meaning of a message others answered. The mark is the only
  safeguard, as it is in the apps people already use.
- A lightweight transaction costs a few round trips inside Scylla, more than a plain write.
  Edits are rare, and on one node it is still a few milliseconds. Every other write to
  `messages` stays a plain one; mixing the two on a row is safe here because the only race
  that matters, a delete against an edit, resolves the same way in either order.
- An edited message carries `editedAt` in every message the API returns; one never edited
  has `null`. Older apps ignore the field and the `edited` event, and show the new text
  only when they load the page again.
- Every older reply to an edited message costs nothing extra: the original was already read
  for deletions.
- `edited_at` is one more column, written only by an edit; messages never edited do not
  store it.
