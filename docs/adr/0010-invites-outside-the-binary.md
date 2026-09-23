# 10. The invitation lives outside the binary

- **Status:** accepted
- **Date:** 2026-09-23
- **Extends** [ADR 0007](0007-device-pairing.md), which put the pairing token *in* the build

## Context

[ADR 0007](0007-device-pairing.md) established that a build carries a **pairing token** — an
invitation, not a key — so the person receiving an `.exe` configures nothing. It stated the
caveat plainly: a secret inside a distributed binary is extractable. That was an acceptable
trade when every binary was hand-built and handed to one person.

Two things made it untenable.

**Publishing on GitHub.** A binary anyone can download is a binary whose contents are public.
The pairing token in it would be a public token, the server hostname in it a public hostname.
Neither can be built in CI either, because a public build has no private input to inject.

**The repository is public and documents self-hosting.** Whoever downloads a release will be
running *their own* server. A binary wired to one deployment is not merely insecure for them,
it is useless — there is no version of "bake in the URL" that works for a stranger.

There was also a quieter cost that had been paid for months: because the build *was* the
credential, adding one person meant rebuilding and re-sending 130 MB, and revoking a leaked
exe meant cutting off everyone who shared that token.

## Decision

The published binary knows nothing. No server URL, no pairing token.

Both arrive at runtime in a **`zoia-invite.json`** the operator generates on their own server
and sends out of band:

```json
{ "serverUrl": "https://zoia.example.com", "pairingToken": "zpair_a1b2c3d4_…" }
```

Config is resolved once at startup, first hit winning: environment variables (for `npm run
dev`), then the server named by a stored credential, then an invite file — beside the exe,
or in the app's data directory — and finally the compiled-in values, which still work so
`make-exe.bat` can produce a private build that pairs with no file to hand over.

`keytool pair:new --invite <path>` writes the file, `0600`, and does **not** also print the
token: writing a secret to a file and echoing it to a terminal are different disclosures, and
scrollback is shared far more casually than files.

## Why validate the URL

This is the one genuinely new attack surface. The app now points wherever a file it was given
says to point, so `src/main/invite.ts` refuses anything but `https`, except on loopback where
a self-hoster has no certificate yet. Honouring `http://` would put a device credential — and
every later request carrying the session cookie — on the wire in the clear, at the choosing of
whoever wrote the file.

The token's shape is checked for a duller reason: a mistyped token should fail as "that is not
a pairing token" rather than as an opaque 401 after a round trip.

## Consequences

- **First run is two files instead of one**, and the small one is the one that matters. An
  invite in a Downloads folder is a credential somewhere nobody treats as sensitive. This is a
  real regression in how easy it is to misplace access, accepted because the alternative is a
  credential on a public download page.
- **The artifact stops being a credential**, so it can be linked publicly, mirrored and
  checksummed — none of which was true before. Revoking an invite no longer means rebuilding.
- **CI compiles C++ now**, which it never did. A Windows runner image change can break
  releases in a way no pull request would catch. `release.yml` pins `windows-2025` rather than
  `windows-latest` for exactly that reason.
- **The `findstr` guard in `make-exe.bat` inverted.** It used to fail a build with no token.
  A tokenless build is now the normal kind, so it fails instead when a `--public` build comes
  out *with* one. The old failure was inconvenient; the new one would be a credential
  published to the internet, which cannot be withdrawn, only revoked.
- **Old credentials keep working.** `device.enc` records written before this have no
  `serverUrl`; they fall back to whatever config resolved, and if nothing did, the app says
  the machine is paired but this build does not know to what — rather than failing obscurely.
- **A bug was fixed on the way past.** `restoreSession()` deleted the stored credential on
  *any* failure, so a brief network problem un-paired a working machine. With an
  operator-supplied URL that would have un-paired everybody at once during a server outage.
  Only a 401 clears it now.
- The published exe is still unsigned and still bundles a third-party ffmpeg downloaded at
  build time. The release verifies it is a GnuTLS build with NVENC before packaging, which is
  a check, not a supply-chain guarantee.
