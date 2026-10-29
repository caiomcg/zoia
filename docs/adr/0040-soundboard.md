# 40. A soundboard from Myinstants, played by each listener

- **Status:** proposed
- **Date:** 2026-10-28

## Context

People in voice want a soundboard: search for a sound, play it to the channel, keep the ones
they use. Myinstants has the sounds, a search, and a JSON answer to it at
`/api/v1/instants/?name=…&format=json`. Each listener must be able to turn the effects down
or off, and to stop hearing one person's, apart from their voice.

There are three ways to get a sound to everyone:

- **Into the microphone.** It would arrive as part of the speaker's voice, so nobody could
  turn it down apart from them. It would also go through RNNoise and the input gate (ADR
  0039), which are made to remove what is not speech, and stop with push to talk.
- **As a track of its own.** Voice's grant publishes the microphone alone (ADR 0039); a
  second source would widen it for everyone in voice. Android plays any audio that is not
  `MICROPHONE` as a shared screen's, so a sound would look like a broadcast.
- **As a message.** The room already carries data from everyone (`canPublishData`). A
  message naming the sound is a few hundred bytes, and each listener fetches and plays it.

## Decision

**A sound is played by a message, and heard by each listener playing it.** The app sends
`{slug, name, url}` on the `zoia.soundboard` topic. Every other app in the room checks it,
fetches the file, and plays it through a gain of its own: the effects' volume, under deafen
like every other Zoia sound. The sender hears nothing of their own; the panel's preview is
for that.

**The server takes no part.** Nothing in it changes, and no grant does. So each listener holds
the rules for itself, and ignores a sound unless:

- the link is one of Myinstants' own sound files (`isSoundUrl`): no other host, no query,
  no way out of `/media/sounds/`, since everyone in the room fetches it;
- the sender is in voice with their microphone on, read from the server's voice attribute
  and their microphone's mute;
- the sender played nothing in the last 1.5 seconds. The sender's own app waits two; the
  half second is what the network may close up between two messages;
- the listener has not muted effects, or that person's.

One sound per person: a new one from someone cuts theirs. Every sound stops at ten seconds,
fading out.

**Myinstants is read from main.** It sends no CORS headers, and the page, loaded from
`file://`, could not read it. Main fetches the search and the files, and keeps each file in
`userData/soundboard`, up to 100 MB, those played longest ago going first. A sound played
again, or by someone else in the channel, starts at once.

**What is kept is per machine:** up to 20 favourites, the last 10 sounds played, the effects'
volume (up to 100 %, half by default) and mute, and whose sounds are muted. Each favourite
may have a global shortcut, held by the same input hook as voice's.

## Consequences

- Myinstants' API is not documented or promised. If it changes, search stops; favourites and
  recent sounds still play from what this machine kept, and from Myinstants' files while
  they are there.
- Everyone in the channel fetches each new sound from Myinstants, which sees their address.
- Listeners do not start at the same instant: the first play of a sound waits for its
  download. It is a few kilobytes, so the difference is small, and none once kept.
- The rules are each listener's, so a modified app can send what it likes; the app that
  receives it still plays nothing that breaks them. A rule that must hold for everyone needs
  the server, and would mean sending through it.
- Sounds are whatever people upload to Myinstants, loud or offensive ones included. The
  ten-second cut, the per-person mute and the two-second interval are the answer, not a
  filter.
- Apps before this one ignore the topic, as they ignore anything a participant sends. Android
  plays no sounds until it learns to.
