# 35. A homolog environment on a VM of its own

- **Status:** accepted
- **Date:** 2026-10-25
- **Extends** [ADR 0004](0004-isolated-caddy-front-end.md), which limited Caddy to two hostnames

## Context

Every build was tested against production: the only server there was. A server change that
broke sign-in, a migration that went wrong, a desktop build that misbehaved in a room: each was
found by the people using it. We want a second environment, `zoia-homolog.example.com`, where
another branch's server, web front and database can run without touching production's.

The network allows one public IP, and its 443, 7881/TCP and 7882/UDP already go to the zoia
VM. A second environment cannot have a 443 of its own. Nginx Proxy Manager stays out of it for
the reasons in ADR 0004.

## Decision

**The homolog runs on a separate Proxmox VM**, which runs only the app
(`docker-compose.homolog.yml`). It has its own `.env`, its own session secret and its own
`server/data`. `./deploy.sh --homolog` deploys whatever is checked out to it.

**It has production's people, in a database of its own.** `scripts/seed-homolog.sh` copies a
consistent backup of production's database and profile pictures to it, streamed between the
VMs and never written to the workstation. Everyone signs in to the homolog with the account
they already have, and nothing done there reaches production. A live shared database was not
an option: SQLite cannot be shared between two machines, and sharing it would put an untested
build's migrations on production's data. Channels are not copied, because their ids name
rooms on the shared SFU.

**The production Caddy routes the homolog hostname to that VM**, over plain HTTP on the LAN.
It is the third hostname ADR 0004 said would be a decision. The site lives in
`caddy/sites/homolog.caddy` on the production server only. Caddy imports `caddy/sites/*.caddy`.
The folder is gitignored and deploy.sh never transfers or deletes it. A glob that matches
nothing is not an error, so a server without the file, such as anyone self-hosting from
this repository, still serves exactly two hostnames.

**The homolog shares the production LiveKit.** Clients reach it at the same public
`wss://sfu…`. The app reaches its API over the LAN at `http://<prod-vm-ip>:7880`.
The homolog has its own API key, added to production's `LIVEKIT_KEYS` as a YAML map
(`{key1: secret1, key2: secret2}`; LiveKit 1.13.7 rejects a comma-separated list). Its
`ROOM_NAME` is `zoia-homolog`, and every channel's room id starts with it, so its rooms
never meet production's.

The desktop and Android apps need nothing: since ADR 0031 they ask for a server address.

## Consequences

- **No new router rules, no new public surface on the homolog VM.** It is reachable from the
  internet only through the production Caddy, for one hostname.
- **The homolog cannot test LiveKit itself.** A version bump or a `livekit.yaml` change runs
  against production's SFU or not at all. Splitting it off later means a second SFU hostname,
  two more port forwards and another grey-cloud record.
- **Production's SFU is not isolated from the homolog.** A LiveKit API key is not scoped to
  rooms, so a homolog server bug could act on production's rooms. Only the room prefix keeps
  them apart, and nothing enforces it. Load is shared too: a heavy test broadcast uses
  production's upload.
- **The production Caddy must be up for the homolog to be reachable.** Restarting it to add
  or change the site briefly drops production's signalling too.
- **Homolog traffic crosses the LAN unencrypted** between the two VMs, passwords and session
  cookies included. Both VMs sit on the same Proxmox bridge; the homolog's port 3000 is
  reachable by anything on the LAN, as production's LiveKit API on 7880 already is.
- **The homolog's accounts are a snapshot.** Someone who signs up, changes their password or
  is disabled on production is not affected on the homolog until it is seeded again, and
  seeding discards whatever changed on the homolog. A person disabled on production keeps
  homolog access until the next seed.
- **The homolog holds every email and password hash**, as production does. It needs the same
  care: it is not a place to hand out shell access to test something.
- **Only branches that contain `docker-compose.homolog.yml` can be deployed there.** Anything
  older needs this commit merged in first.
