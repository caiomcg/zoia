# 40. A soundboard from Myinstants, played by each listener

- **Status:** proposed
- **Date:** 2026-10-28
- **Amended by** [ADR 0046](0046-entrance-sounds.md): a sound of your own may also play as you
  arrive, under rules and a volume of its own

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

In the app it is called **Zumbido**, in every language; "soundboard" stays the name in the
code, its files, settings keys and the room topic.

**A sound is played by a message, and heard by each listener playing it.** The app sends
`{slug, name, url, seconds?}` on the `zoia.soundboard` topic. Every other app in the room checks it,
fetches the file, and plays it through a gain of its own: the effects' volume, under deafen
like voices and cues (ADR 0039). The sender's app plays it too as it sends it, through the same
gain, so they hear what they played; the panel's preview plays a sound for them alone.

**The server takes no part.** Nothing in it changes, and no grant does. So each listener holds
the rules for itself, and ignores a sound unless:

- the link is one of Myinstants' own sound files (`isSoundUrl`): no other host, no query,
  no way out of `/media/sounds/`, since everyone in the room fetches it;
- the sender is in voice with their microphone on, read from the server's voice attribute
  and their microphone's mute;
- the sender's last sound has played out: a sound locks its sender out from when it
  starts playing to when it ends, exactly its decoded length, at most ten seconds (where
  every sound is cut) or where the sender cut it, if sooner. While it is still loading, the sender's app plays nothing else; its
  bar runs over the playing only. A listener holds the sender from when the sound starts
  playing there until it ends, less half a second, what the network may close up between
  two messages;
- the listener has not muted effects, or that person's.

One sound per person: a new one from someone cuts theirs. Every sound stops at ten seconds,
fading out.

**A sound may be cut shorter, by whoever plays it and by whoever hears it.** A pad may be cut
anywhere from half a second to the whole sound, by halves; the message then carries
`seconds`, and every listener stops it there, fading out, and holds the sender only that long.
Each listener may also cut every effect they hear, from one second to ten, their own as they
play it included and previews aside. That cut is theirs alone and shortens only what they
hear: the lock stays the sound's, on the sender's app and on theirs, so cutting what you hear
is no way to play more often, and a listener holds a sender exactly as long as one who does not
cut. A sound lasts only while its sender may play one: when they mute their microphone
or leave voice, their app cuts it for them and every listener's cuts it there, from the same
microphone mute and voice attribute that decide whether it plays at all. The lock still runs
its course, so muting and unmuting is no way round it.

**Myinstants is read from main.** It sends no CORS headers, and the page, loaded from
`file://`, could not read it. Main fetches the search and the files, and keeps each file in
`userData/soundboard`, up to 100 MB, those played longest ago going first. A sound played
again, or by someone else in the channel, starts at once.

**What is kept is per machine:** a soundpad of up to 10 sounds, the last 4 sounds played,
the effects' volume (up to 100 %, half by default) and mute, where every effect is cut for
you, and whose sounds are muted. Each
pad may be renamed, emoji included, be given an emoji to show, and have a global shortcut,
held by the same input hook as voice's. A pad plays under the name you gave it, its emoji
first, and is cut where you cut it: that is the name everyone else sees beside you while it
plays, and the length they hear. The file is still Myinstants', so the rules above do not
change.

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
  ten-second cut, the per-person mute and the lock for a sound's length are the answer,
  not a filter.
- The lock was two seconds for every sound until 2026-10-29. A long sound then left the
  sender free to cut it with the next long before it ended; now one person's sounds follow
  each other, never overlap. A listener still on the old rule drops a sound sent under a
  second and a half after the last, which only a sound shorter than that allows. The lock
  was first counted from the click, which freed the sender before a slow-loading sound
  ended; it is counted from when the sound starts.
- A pad's cut was added on 2026-11-26. An app from before it ignores `seconds`, plays the
  sound up to ten seconds and holds the sender that long, so it drops their next sound if it
  comes before then, as the sender's app now allows. Those listeners miss a sound, nothing
  more, until they update. A modified app may send any cut it likes; it can only make its
  sound shorter.
- A listener who cuts every effect short hears the start of each, never the rest; the lock
  still runs for the whole sound, so they may hear silence from someone who cannot play yet.
- Apps before this one ignore the topic, as they ignore anything a participant sends. Android
  plays no sounds until it learns to.
