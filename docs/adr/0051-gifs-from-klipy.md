# 51. GIFs from KLIPY, searched through the server

- **Status:** proposed
- **Date:** 2026-11-05

## Context

People want to answer with a GIF in any chat: the text chats, direct messages and threads.
Tenor's API, the usual source, was switched off on 2026-06-30. GIPHY and KLIPY remain; KLIPY
has a free tier and an API close to Tenor's, and is what Discord moved to.

A GIF API needs a key, and a key shipped inside the app is a key anyone can take.

## Decision

- **The server searches, the app never sees the key.** `GET /api/gifs?q=&page=` (signed in,
  60 a minute per account) asks KLIPY's search, or its trending with no query, using
  `KLIPY_API_KEY` from the server's environment. Without a key it answers `503 gifs_off` and
  the app hides its GIF button.
- **KLIPY knows people only by a hash** of their account id, the same each time, as its
  `customer_id` asks.
- **Only KLIPY's own addresses get through.** The server keeps a medium GIF to send and a
  small one to preview, both on `https://*.klipy.com`, and drops anything else. The window's
  content security policy allows images from `https://*.klipy.com` and nowhere new.
- **A GIF is a message whose whole body is one KLIPY address.** The chat shows such a message
  as the GIF itself; a KLIPY address inside other text stays text. Nothing new is stored and
  older clients show the address as a link.
- **One picker for every chat**, beside the emoji button: trending until you type, then
  search, more as you scroll, a click sends. It says "Powered by KLIPY".

## Consequences

- Sending a GIF tells KLIPY, through the server, what was searched; it never learns who.
- Viewing a GIF loads it from KLIPY's servers, so they see the viewer's address, as they
  would for any linked image.
- If KLIPY changes its API or terms, only `server/src/gif-routes.js` and the picker change.
