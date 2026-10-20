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

A camera is never drawn over a screen. An earlier version put it in the screen's corner, as
Discord does; in use it covered what was being shared and could not be watched apart, so each
picture is now a tile of its own.

**The stage.** What is on the stage is shown all at once: the screens chosen from someone's
row in the channel list, your own screen and camera, and the cameras put there by a camera
button. Nothing of anyone else opens by itself, cameras included. Someone's row opens their
screen, as before, and only their screen: a camera shared alone does not make the row live.
While their camera is on, a camera button sits at the end of their row; it puts the camera on
the stage, stays lit while it is there, and takes it off when clicked again. Your own row has
no camera button: your screen and camera are on your stage for as long as they are on, and
their tiles have no close.

The two layouts show the same stage. The **mosaic** puts it side by side; a click on a tile
enlarges it with the rest on the strip, and a click on the enlarged one brings the mosaic
back. Your own screen is a tile in both, and with your preview off it says you are live and
carries the eye that turns the picture on, rather than leaving the stage with no way to.

Both layouts order the stage by one preference: your screen, your camera, the screens chosen
from the list (in the order they were), then the cameras put on by their buttons. The
**spotlight** shows the first of them large and the rest on the strip, until something is
clicked to be large: a row in the list, or a small window. Switching layout goes back to the
preference. The close on someone else's tile takes it off the stage, and a camera's button
goes dark with it.

You see your own camera mirrored, as the camera dialog shows it; viewers get it the right way
round. Going live no longer puts your own preview on the stage by itself.

**Sound.** A microphone starts muted on both ends. The camera dialog's "mute the microphone"
box starts ticked every time, not remembered, and the sender unmutes from the dialog or the
player. And each viewer hears nobody's microphone until they turn it on, per person, from
the tile; that is not remembered either. Shared audio follows the person's volume and mute.

Only what is watched is heard. Someone's microphone plays with any picture of theirs on the
stage, once turned on; the sound of their screen only with their screen, not with their camera
alone. Sound is played once per person by the grid, not by a tile, so two pictures of one
person on the stage never play it twice.
Your own sound, shared or microphone, is never played back to you.

## Consequences

- Sharing both costs the sender about 2.5 Mbps more upload, plus the 360p layer.
- ADR 0013's "nothing opens by itself" holds for cameras too: a camera costs a viewer nothing
  until they choose it, and a camera shared alone is found only by its button, not by the
  row, so someone looking for cameras has to look for that button.
- Someone who wants to be heard has to unmute, and each viewer has to turn them on too.
  Two clicks to be heard is the price of nobody being heard by accident.
- A camera's video flows only while its tile is on screen, large or small, like any
  other picture; off the stage it is paused, though its microphone still plays.
- Watching someone's screen and camera together takes two tiles of room; the mosaic and the
  strip are where they fit.
- Older viewers pick the `ScreenShare` track first, so they see the screen and not the camera
  of someone sharing both, and they do not hear that person's microphone. A camera shared
  alone still reaches them: it keeps the `camera` label in the participant's metadata.
- The Android viewer, as released with 0.7.3, still follows the first version of this
  decision: the camera over the screen's corner (tap to enlarge), and choosing someone's
  sound plays their microphone at once. It has no camera button and no way to watch the
  camera apart. It should follow the desktop's rules in a later change. Android versions
  before 0.7.3 play only one of a person's tracks.
- The sender's footer has one stop button: it stops the screen if there is one, otherwise
  the camera. Changing channel or signing out stops both.
