# Distributing builds

There are two ways to get Zoia onto someone's machine, and they differ in **where the
invitation lives**.

| | The binary | What you send |
|---|---|---|
| **Public release** | Knows nothing | The exe is a public link; the invite is private |
| **Private build** | Carries a token | One file, nothing to configure |

Either way the invitation is capped and revocable — see
[ADR 0007](adr/0007-device-pairing.md) and [ADR 0010](adr/0010-invites-outside-the-binary.md).

## Public releases

The published binary contains **no server URL and no pairing token**, so it is not a
credential and can be linked anywhere. It is inert until someone supplies an invite.

Tag a version and CI does the rest:

```bash
npm version 0.2.0 --no-git-tag-version
npm version 0.2.0 --no-git-tag-version --prefix desktop
git commit -am "chore: release 0.2.0"
git tag v0.2.0
git push --follow-tags
```

`.github/workflows/release.yml` then builds on a Windows runner — the native capture addon,
the installer and the portable exe — and attaches them to a GitHub Release with a
`SHA256SUMS.txt`.

**The tag must match both `package.json` files.** electron-builder names its artifacts from
`desktop/package.json`, not from the tag, so a mismatch would publish `Zoia-0.1.0-portable.exe`
under a release called v0.2.0. The workflow refuses before building anything. Check it
yourself first with `npm run version:check v0.2.0`.

To exercise the pipeline without publishing — worth doing before the first real tag, since
this is the only place CI compiles C++ — run the workflow by hand from the Actions tab with
**publish** left off. The binaries appear as a workflow artifact instead.

Verifying a download:

```powershell
Get-FileHash Zoia-0.2.0-portable.exe -Algorithm SHA256   # compare with SHA256SUMS.txt
```

## The invite

What people actually need from you. Generate it on your server:

```bash
node server/bin/keytool.js pair:new --name "friends" --max-activations 5 \
  --invite zoia-invite.json
```

It writes a small file, mode `0600`, and deliberately does **not** also print the token —
terminal scrollback is shared far more casually than files are:

```json
{
  "serverUrl": "https://zoia.example.com",
  "pairingToken": "zpair_a1b2c3d4_…"
}
```

**Treat this file as the credential, because it is one.** The exe is not.

Send it over something private. The person then either drops it next to the portable exe,
drags it onto the Zoia window, or uses **Choose invite file…** on the pairing screen. An
installed copy has no useful "next to the exe", so the drop and the picker are the paths that
matter there. Zoia copies it into its own data directory, so it does not have to stay where
they put it.

`--max-activations` caps how many machines that invite can ever pair, which bounds the damage
if it is forwarded. One invite per group makes it possible to cut off a group without touching
anyone else.

## Private builds

Still the quickest way to hand Zoia to one person: the token is baked in, and they configure
nothing at all. From Windows, in `desktop/`:

```bat
make-exe.bat
```

It asks for a pairing token on first run and remembers it in the gitignored `.pairing-token`.
The result is in `desktop/release/`.

```bat
make-exe.bat --public
```

builds the tokenless kind instead — the same thing CI publishes, useful for testing the invite
flow locally.

The script verifies the build **in both directions**, and the second check is the important
one now:

- A private build that came out *without* its token fails, because it would dead-end on the
  pairing screen and only whoever you sent it to would find out.
- A `--public` build that came out *with* one fails loudly with **DO NOT DISTRIBUTE**. A
  stale `ZOIA_PAIRING_TOKEN` in the shell is the usual cause. That exe is a credential, and
  publishing it cannot be undone — only revoked.

It also closes any running copy first: a running `Zoia.exe` holds `release/win-unpacked` open
and the build fails one line before writing the exe.

## What to expect when you send it

The binaries are unsigned, because code signing certificates cost money this project does not
have. On first run Windows shows **"Windows protected your PC"**; the way through is
*More info* → *Run anyway*. Tell people that before they see it, or they will assume the file
is broken.

The portable exe is large — around 125 MB — because it carries Electron and ffmpeg. The
ffmpeg build alone is about 100 MB of that.

## Revoking

Two independent levers, both immediate:

```bash
node server/bin/keytool.js pair:revoke <pairingId>            # no new machines
node server/bin/keytool.js pair:revoke <pairingId> --cascade  # also cut off machines it paired
node server/bin/keytool.js device:revoke <deviceId>           # one machine only
```

Revoking an invite stops it pairing anywhere new and leaves already-paired machines working;
`--cascade` takes those with it. Both take effect on the next request, not at some refresh
interval.

Because the invitation is no longer inside the binary, **revoking one no longer means
rebuilding or re-sending anything** — issue a new invite and carry on.

`pair:list` and `device:list` show what exists, including how many activations an invite has
left and when each device was last seen.
