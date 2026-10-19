# 34. A camera beside the screen

- **Status:** accepted
- **Date:** 2026-10-19
- **Amends** [ADR 0013](0013-multiple-broadcast-slots.md)

## Context

A person could share a screen or a camera, never both: starting the camera stopped the
screen. The camera also published as `ScreenShare` and `ScreenShareAudio`, so a viewer could
not have told the two apart even if both were sent. Showing your face while you play or
present is the commonest thing people asked for once the camera existed.

The stage does not stand in the way. `canPublish` is granted to a participant, not to a
track, so whoever holds a slot can publish any number of tracks on the same connection.

## Decision

The camera and the screen are independent on the sender. The top bar's two buttons each
start and stop their own share; the camera never stops the screen and the screen never stops
the camera. The camera publishes as `Camera` and `Microphone`, always through Chromium, with
a 360p simulcast layer. The stage is claimed by whichever starts first and released only when
both have stopped, because a release revokes publishing for the whole participant.

For viewers, a person's tracks are gathered from their own participant and their WHIP ingress
(`-gpu`): everything an ingress sends is the screen, since WHIP may label it CAMERA, and only
the person's own `Camera` and `Microphone` are their camera. Someone sharing both offers two
**pictures**, watched apart: the screen under their identity and the camera under
`<identity>#camera`. A camera shared alone is their one picture. The viewer pauses and picks
the quality of each picture on its own; subscription and sound stay per person.

Watching a screen shows that person's camera small over its corner, as in Discord. Clicking
the camera makes it larger (and asks for its high layer), clicking again makes it small, and
the footer hides it. Watching the camera itself shows it alone, and the corner is not drawn
twice when both are on the stage.

**The overview.** While nothing is watched, the stage is no longer dark: it shows every
camera that is on, side by side, live on its 360p layer, with your own screen and camera
while your preview is on. Someone else's screen is not offered there; it is chosen from the
channel list, as before. You see your own camera mirrored, as the camera dialog shows it;
viewers get it the right way round. Clicking a tile watches it, clicking the large picture
again stops watching it, and once nothing is watched the overview is back. Going live no
longer puts your own preview on the stage; you appear in the overview, as in a call. Your own
screen preview does not carry your camera in its corner: it would only cover what you share,
and your camera has its own overview tile.

**Sound.** A microphone starts muted on both ends. The camera dialog's "mute the microphone"
box starts ticked every time, not remembered, and the sender unmutes from the dialog or the
player. And each viewer hears nobody's microphone until they turn it on, per person, from
the tile; that is not remembered either. Shared audio follows the person's volume and mute.

In the overview the cameras on it are heard: their microphones, once turned on (and all of a
camera shared alone, which may be an older client's). A screen nobody chose is not heard.
Otherwise, as before, only the people being watched are heard. Sound is played once per person
by the grid, not by a tile, so two pictures of one person on the stage never play it twice.
Your own sound, shared or microphone, is never played back to you.

## Consequences

- Sharing both costs the sender about 2.5 Mbps more upload, plus the 360p layer.
- This reverses ADR 0013's "nothing opens by itself" for cameras: the overview plays every
  camera before anyone chooses. Screens still wait to be chosen, and microphones stay off
  until turned on. With five cameras on, an idle viewer downloads about 2.5 Mbps.
- Someone who wants to be heard has to unmute, and each viewer has to turn them on too.
  Two clicks to be heard is the price of nobody being heard by accident.
- A camera's video stops flowing whenever it is on no screen: a hidden corner, or a screen
  watched without it. The low layer is used except when it is large.
- The corner can cover part of the screen (a minimap, a chat), which is why it can be hidden
  or made small. It is not movable yet.
- Popping a broadcast out shows the screen without the camera; its sound still plays.
- Older viewers pick the `ScreenShare` track first, so they see the screen and not the camera
  of someone sharing both, and they do not hear that person's microphone. A camera shared
  alone still reaches them: it keeps the `camera` label in the participant's metadata.
- The Android viewer follows the same rules: a person's own participant and their ingress
  are one tile, the screen is the picture with the camera over its corner (tap to enlarge),
  and choosing someone's sound plays both their shared audio and their microphone. It has
  no overview of cameras and no way to watch the camera apart; it shows every broadcast in
  its grid already. Android versions before this still play only one of a person's tracks.
- The sender's footer has one stop button: it stops the screen if there is one, otherwise
  the camera. Changing channel or signing out stops both.
