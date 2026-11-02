# 46. Entrance sounds, chosen on each machine and named by the arriving app

- **Status:** proposed
- **Date:** 2026-11-02
- **Amends** [ADR 0040](0040-soundboard.md), whose rules for a sound assumed a click

## Context

People want what Discord sells: a sound of their own that plays for the channel as they
arrive. The soundboard (ADR 0040) already finds sounds on Myinstants, fetches them from main
and plays them at each listener's volume, so the sounds themselves are solved. What differs is
when one plays and who is held to what.

A soundboard message does not fit. Its rules need the sender's microphone on, and at arrival
the microphone is not published yet; and a message can be sent at any moment, so nothing would
tell an arrival from a second soundboard with looser limits.

Keeping the sound on the account was built first: a column, routes, and the sound in the join
token, so listeners had it with the arrival itself and it could replace the join cue. It was
dropped before release to keep the feature out of the server, which ADR 0040 also does, at the
price of a sound per machine and of keeping the cue.

## Decision

**The sound is the machine's,** chosen in Settings › Sounds with Myinstants' search and kept
with the soundpad. The server takes no part: nothing in it changes, and no grant does.

**The arriving app names it in an attribute of its own participant,** `zoia.entrance`, once it
has connected, with the permission it already has for its picture and its deafened state. A
reconnect does not set it again, so a reconnect plays nothing.

**Arriving is arriving in a channel,** every time, moving between channels included, since being
in a channel is being in its voice (ADR 0039). The arriving app plays the sound too, at its own
entrance volume. A sound chosen while in a channel applies from the next arrival.

**The join cue still plays, at once, as it always did;** the sound follows it. A listener cannot
know at the arrival whether someone has a sound, so replacing the cue would mean holding every
cue back for everyone, sound or not.

**Each listener holds the rules for itself,** as with every sound (ADR 0040). It watches someone
only for `ENTRANCE_WAIT_MS` (eight seconds) from when they appear, and it plays the sound unless:

- the link is not one of Myinstants' own files (`isSoundUrl`), since everyone fetches it;
- the channel is the away channel (ADR 0044), or the person does not come into voice in time;
- their microphone is muted when it is published: unmuting a moment later does not bring it back;
- it would be less than a minute since this listener last played that person's, whichever
  channel it was in;
- the listener has muted entrance sounds, or that person's.

So setting the attribute later, or again, plays nothing. Whatever plays stops at five seconds,
fading out, by the listener's own player. Longer sounds are accepted: Myinstants does not say how
long a sound is, and the first five seconds of anything is a usable entrance.

**Entrance sounds are not effects.** They have a volume and a mute of their own, kept per machine
with the rest of the soundboard's settings, and neither mute reaches the other: muting someone's
effects leaves their entrance, and muting their entrance leaves their effects. The people menu
has a checkbox for each. They still share the one-sound-per-person rule, so a Zumbido from
someone cuts their entrance sound.

## Consequences

- Someone with two computers chooses a sound on each, and may arrive with different ones. Signing
  out does not clear it, so someone else signing in on that machine arrives with the same sound.
- Everyone hears the cue and then the sound, a moment apart: the time the arriving app takes to
  publish its microphone.
- The rules are each listener's, so a modified app can name what it likes; the app that receives
  it still plays nothing that breaks them. The minute is counted per listener and per identity,
  and an identity is a machine: two computers of one person have a minute each, and muting
  someone's entrance sound mutes that machine of theirs, as muting their effects does.
- The minute lives in memory, so a listener who restarts their app hears the next arrival
  regardless.
- Everyone in a channel fetches each new entrance sound from Myinstants, which sees their
  address, as it does for the soundboard.
- Android ignores the attribute and plays nothing, as it does with the soundboard. Apps before
  this one ignore it as well.
