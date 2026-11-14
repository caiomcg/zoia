# 54. Not moving to an audio device just plugged in

- **Status:** proposed
- **Date:** 2026-11-12

## Context

Voice and playback follow the system default unless a device is chosen in Settings › Voice,
and they follow it live: a default that changes moves the microphone and the sound with it.
Windows makes a headset the default the moment it is plugged in, Bluetooth ones included,
so plugging one in mid-call moved the call to it unasked: the microphone to a headset still
in its case, the sound away from the speakers everyone in the room was listening to.

## Decision

**A default that moves onto a device that has just appeared is not followed.** One listener
(`voice/device-watch.ts`) takes in every device change before the microphone and playback
react, and they take the device to use from it. When the default moves onto a device that was
not listed before, and the device in use is still plugged in, Zoia holds on to the device in
use. Nothing is shown: someone who wants the new device picks it in Settings › Voice or the
quick device menu, as they would pick any other.

While a device is held, "System default" in those menus names it, since that is what is in
use, rather than the device Windows now has as its default. Picking "System default" there,
even though it already was, follows Windows again.

**Everything else is as before.** A default that moves because the device in use was unplugged
is followed at once, since there is nothing to keep. A device chosen in Settings is never moved
by the default. A default changed by hand in Windows, to a device that was already there, is
followed.

What is held lasts until a device is picked, the held device is unplugged, or Zoia restarts.

## Consequences

- The new device stays plugged in, unused by Zoia, while Windows and other apps use it.
- After a restart Zoia follows whatever Windows has as its default then, which is the headset
  if it is still plugged in: holding on is for the session, not a setting.
- An earlier version of this asked, with a prompt in the corner. It was dropped: the person
  wanted the switch avoided, not another question to answer mid-call.
- The meter in Settings › Voice measures the device chosen there, not one held by this.
