# Distributing builds

A build carries a pairing token, so the person receiving it does not configure anything —
they run the exe and it joins. That also means a build is a credential, and should be
treated like one.

## Building

From Windows, in `desktop/`:

```bat
make-exe.bat
```

That is the whole thing. On the first run it asks for a pairing token and remembers it in
`.pairing-token`, which is gitignored; later runs just build. The result lands in
`desktop/release/Zoia-<version>-portable.exe`.

The script deliberately refuses to report success unless it can find the token inside the
built output. A build without one reaches the pairing screen and dead-ends there, which is
only discovered by whoever you sent it to.

It also closes any running copy first: a running `Zoia.exe` holds `release/win-unpacked`
open, and the build fails one line before writing the exe.

## Minting a token

On the server:

```bash
node server/bin/keytool.js pair:new --name "friends" --max-activations 5
```

`--max-activations` caps how many machines that token can ever pair. One token per batch of
builds makes it possible to cut off a batch without touching anyone else.

## What to expect when you send it

The binaries are unsigned, because code signing certificates cost money this project does
not have. On first run Windows shows **"Windows protected your PC"**; the way through is
*More info* → *Run anyway*. Tell people that before they see it, or they will assume the
file is broken.

The portable exe is large — around 200 MB — because it carries Electron and ffmpeg.

## Revoking

Two independent levers, both immediate:

```bash
node server/bin/keytool.js pair:revoke <pairingId>            # no new machines
node server/bin/keytool.js pair:revoke <pairingId> --cascade  # also cut off machines it paired
node server/bin/keytool.js device:revoke <deviceId>           # one machine only
```

Revoking a pairing token stops it activating anywhere new, and leaves already-paired
machines working. `--cascade` takes those with it. Revoking a single device cuts off one
machine and nobody notices but them. Both take effect on the next request, not at some
refresh interval.

`pair:list` and `device:list` show what exists, including how many activations a token has
left and when each device was last seen.
