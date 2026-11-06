# 48. Threads, kept as chats of their own

- **Status:** proposed
- **Date:** 2026-11-05
- **Amends** [ADR 0036](0036-text-chat-in-scylladb.md)

## Context

A busy chat interleaves conversations. A reply (ADR 0036) quotes what it answers but still
lands in the main flow, so a side discussion about one message pushes everything else up.
People want to answer a message somewhere beside the chat, and see from the chat that there
is something there to read.

## Decision

**A thread is a chat whose id is its chat's and its message's**: `<chat id>~<message id>`.
Every message route takes it as a chat id, so replying in a thread, editing, deleting,
reacting, sending a photo, marking read and saying you are typing need no routes of their own.
Its replies are stored in the `messages` table under that id, partitioned by month like any
chat's, never in the chat's own partitions: the chat's pages do not change.

- **Resolving one** takes the part before the `~` as a chat (a public chat, or a direct chat
  the caller is in, ADR 0047), and the part after as a message that must exist in it, read by
  its full key. Whoever may see the chat may see its threads; a direct chat's threads are its
  two's. A thread of a thread is refused: one level, as in most chat apps.
- **Its files** go in its chat's folder, so removing the chat removes them.
- **A summary** of each thread sits beside the chat's messages, in a new table, `threads`
  (Scylla schema version 7), keyed `(chat_id, root_id)`: how many replies, the last one's id,
  and up to five people who replied. A page of messages reads the summaries of its messages
  in one `IN` query and sends each as `thread` on the message.
- **The summary is recounted**, not incremented, each time a reply is written or deleted: the
  thread's replies are paged (up to 1000) and the row rewritten. Counters cannot sit in a table
  with other columns, and a read-modify-write without a lightweight transaction (refused by
  the keyspace's tablets) could lose a reply sent at the same time; a recount cannot.
- **On the live stream**, a reply is a `message` event with the thread's id, which apps
  without the thread open ignore unless it @mentions them, and a `thread` event with the
  chat, the message and the new summary, so the chat's line "3 replies" moves at once.
- **Deleting the message deletes its thread** — replies, reactions, read markers and summary
  — and removing a chat deletes every thread in it, found through the summaries.
- **A thread's page** also returns the message it answers, as it reads now, so the panel can
  show it when the chat's page holding it is not loaded.

In the app, a message's actions offer "Reply in thread", and a message with replies says how
many and when the last came. Either opens the thread in a panel beside the chat, with the
message at the top and a box to reply. Unread replies in threads are not counted in the
chat's badge; an @mention in one plays the mention sound and is a notification. In a direct
chat (ADR 0047) every reply from the other person is written to you, so it calls you as a
direct message does: the sound, and a notification that opens the direct chat. Neither
happens while that thread is open on screen with the window in front, as no message does
while its chat is.

## Consequences

- **No unread count for threads.** You find out about a reply by its line under the message,
  by being mentioned, or, in a direct chat, by its notification. Following a thread, and its own unread badge, are not built.
- **A thread past 1000 replies shows "999+"** and its participants are those of its latest
  thousand replies: the recount reads no further.
- **Each reply costs a recount**: one paged read of the thread and one write. Threads are
  small; a thread of a thousand replies reads a thousand rows per reply.
- **Deleting a message reads its summary** to know whether there is a thread to delete. When
  there is, deleting walks the months from the message to now, as removing a chat does.
- A summary written while its message was being deleted can survive it; the message is gone,
  so no page asks for the summary again.
- Addons do not see thread replies: only messages in a public chat reach them.
