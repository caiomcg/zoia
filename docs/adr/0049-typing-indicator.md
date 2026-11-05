# 49. Typing indicator, said and forgotten

- **Status:** proposed
- **Date:** 2026-11-05
- **Amends** [ADR 0036](0036-text-chat-in-scylladb.md)

## Context

In a conversation it helps to know the other person is answering, so you wait rather than
write over them. Every chat app shows it.

## Decision

**Nothing is stored.** While someone writes in a chat, a direct chat or a thread, their app
calls `POST /api/chats/:id/typing` at most every three seconds. The server checks they may
read the chat and tells whoever else may, on the live stream, as a `typing` event with the
chat, their account id and their name. It answers `204` and keeps nothing.

**The other apps show it** under the message box ("Ana is typing…", "Ana and Bia are
typing…", "Several people are typing…") for six seconds after the last such event, or until
that person's message arrives, whichever is first. Your own typing is never shown to you.

**It is rate limited** per account, apart from sending (twenty in ten seconds), so a broken
client cannot flood the stream.

## Consequences

- **It is approximate.** Someone who stops typing shows for up to six seconds more, and
  someone who deletes what they wrote still showed as typing. That is how every chat app
  does it.
- **It cannot be turned off.** Anyone reading the chat learns you are writing in it. A
  setting to hide it is not built.
- One request every three seconds while typing, per person, and one stream frame to every
  reader. Nothing that grows with history.
