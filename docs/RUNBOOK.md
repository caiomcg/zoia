# Runbook

Operating Zoia: first deployment, day-to-day tasks, and what to do when it
misbehaves.

This is one real deployment written down in full — a worked example, with the addresses and
quirks of one particular network. For the generic version, start with
[SELF_HOSTING.md](SELF_HOSTING.md) and come back here for the detail.

## Network inventory

Discovered on the LAN (`<lan-prefix>.0/24`), for reference while following this guide:

| Host | Address | Notes |
|---|---|---|
| Router (your router) | `<lan-prefix>.1` | Port forwarding and DHCP reservations live here |
| Proxmox | `<lan-prefix>.2:8006` | Web UI |
| your local DNS | `<lan-prefix>.3` | **Where the split-horizon DNS override goes, if hairpin fails** |
| an existing reverse proxy | `<lan-prefix>.4` | LAN/VPN only — **not** exposed, and not used by this project |
| Mesh node / repeater | `<lan-prefix>.200` | Also answers with the router's certificate |
| Workstation | `<lan-prefix>.230` | |
| **zoia-vm** | `<server-ip>` | Verified free by ping and ARP on 2026-09-21. `.50` was taken |
| Public IP | `<public-ip>` | Static |

## Getting onto the server

```bash
ssh zoia@<server-ip>
```

**There is no password.** cloud-init created the `zoia` user with the workstation's SSH
public key (`qm set --ciuser zoia --sshkeys …` in the VM section below) and no password at
all, so login works only from a machine holding the matching private key, normally
`~/.ssh/id_ed25519`. If that key is lost, get back in through the Proxmox console and add a
new key to `~zoia/.ssh/authorized_keys`.

Everything lives in `/opt/zoia`. `docker compose ps` there shows the five services (app,
caddy, livekit, ingress, redis).

## Helper scripts

| Script | Run it | Does |
|---|---|---|
| `scripts/bootstrap-vm.sh` | on the VM, once | Installs Docker, guest agent, creates `/opt/zoia` |
| `scripts/gen-env.sh` | on the VM | Generates `.env` with consistent secrets |
| `scripts/preflight.sh` | on the VM, after deploying | Checks every failure mode that looks like an app bug |
| `deploy.sh` | from the workstation | rsync + `docker compose up -d --build`; `--homolog` targets the homolog VM |
| `scripts/seed-homolog.sh` | from the workstation | Copies production's accounts to the homolog |

---

## First deployment

### 1. DNS (Cloudflare)

The zone `example.com` is served by Cloudflare nameservers, and a Let's Encrypt wildcard
`*.example.com` is already issued and renewing. Caddy on the VM obtains its own certificates
for the two hostnames below over a Cloudflare DNS-01 challenge, so nothing here depends on
that existing wildcard.

Add two records in the **Cloudflare dashboard** → `example.com` → DNS → Records:

| Type | Name | IPv4 address | Proxy status | TTL |
|---|---|---|---|---|
| A | `zoia` | `<public-ip>` | **DNS only** (grey) | Auto |
| A | `sfu` | `<public-ip>` | **DNS only** (grey) | Auto |

> **Cloudflare defaults new records to Proxied (orange). Both of these must be toggled to
> DNS only.** The apex record on this zone *is* proxied, so the habit is easy to carry over
> by accident. Proxying breaks this app in two ways: Cloudflare's network does not carry
> WebRTC media (UDP) at all, and routing the signalling WebSocket through it adds latency
> and failure modes for no benefit. `scripts/preflight.sh` checks both records and fails
> loudly if either is proxied.

Confirm before going further — both must return the origin address, not a Cloudflare one:

```bash
nslookup zoia.example.com 1.1.1.1
nslookup sfu.example.com  1.1.1.1
# both must print <public-ip>
```

### 2. The VM

Verified against this host: **Proxmox 9.2.11**, storage `local-lvm`, bridge `vmbr0`.

```bash
# 1. fetch the image on the host — no browser upload
cd /var/lib/vz/template/iso
wget https://cloud.debian.org/images/cloud/bookworm/latest/debian-12-generic-amd64.qcow2

# 2. create the VM
qm create 120 --name zoia-vm \
  --memory 6144 --cores 4 --cpu host \
  --net0 virtio,bridge=vmbr0 \
  --scsihw virtio-scsi-pci --ostype l26 \
  --agent enabled=1 --serial0 socket --vga serial0

# 3. import and attach the disk (PVE 8.1+; no manual volume naming)
qm set 120 --scsi0 local-lvm:0,import-from=/var/lib/vz/template/iso/debian-12-generic-amd64.qcow2
qm set 120 --boot order=scsi0
qm disk resize 120 scsi0 32G

# 4. cloud-init
qm set 120 --ide2 local-lvm:cloudinit
qm set 120 --ciuser zoia --sshkeys /root/zoia-key.pub
qm set 120 --ipconfig0 ip=<server-ip>/24,gw=<lan-prefix>.1
qm set 120 --nameserver <lan-prefix>.3 --searchdomain example.com

# 5. start, then snapshot before any app code lands
qm start 120
qm snapshot 120 clean-debian --description "fresh cloud-init, pre-docker"
```

`--cpu host` exposes AES-NI to the guest, which both TLS and the SFU use. The nameserver
points at the local DNS server, so the VM honours any local DNS overrides added for hairpin.

`/root/zoia-key.pub` is the workstation's SSH public key, written to the host beforehand.

On Proxmox 7 or earlier, replace step 3 with `qm importdisk 120 <path> local-lvm`, then read
the generated volume name from `qm config 120` and attach it as `scsi0` by hand.

Give the VM a **static address or a DHCP reservation** — all three router forwards address
it by IP, and a lease change would break them silently. `.60` was verified free by
ping and ARP; `.50` is occupied.

Then prepare it and **take a snapshot** before any app code lands:

```bash
ssh zoia@<server-ip> 'bash -s' < scripts/bootstrap-vm.sh
```

### 3. Router

Nothing on this network was previously published to the internet — everything is reached over
the VPN. Zoia is the first exposed service, so these are the first forwards.

All three point at the **VM**, `<server-ip>`:

| External port | Proto | → | Why |
|---|---|---|---|
| **443** | TCP | <server-ip> | Caddy: the page and LiveKit signalling |
| **7882** | UDP | <server-ip> | WebRTC media. One rule serves every viewer |
| **7881** | TCP | <server-ip> | Fallback for networks that block UDP |

**Do not forward 80.** Certificates come from a DNS-01 challenge, which needs no inbound
HTTP. Caddy publishes 80 for a LAN-side redirect only.

**Do not forward anything to an existing reverse proxy.** It routes by `Host` header, so exposing
it would make every service behind it reachable from the internet. It stays LAN/VPN only.
See ADR 0004.

### 4. TLS (Caddy on the VM)

No NPM proxy hosts are involved. Caddy obtains certificates itself over a Cloudflare DNS-01
challenge, which is the same mechanism already issuing the `*.example.com` wildcard.

Create a token at **Cloudflare → My Profile → API Tokens → Create Token → Edit zone DNS**:

- Permissions: `Zone` · `DNS` · `Edit`
- Zone Resources: `Include` · `Specific zone` · `example.com`

Scope it to this zone only. It can edit DNS for the zone, so treat it as a real secret; it
lives in `.env` on the server and never in git.

Paste it into `/opt/zoia/.env` as `CLOUDFLARE_API_TOKEN`.

Caddy serves exactly `zoia.example.com` and `sfu.example.com`. Any other Host header
reaches nothing, which is the point.

### 5. The app

```bash
ssh zoia@<server-ip>
sudo mkdir -p /opt/zoia && sudo chown zoia:zoia /opt/zoia
```

From the workspace:

```bash
./deploy.sh --dry-run     # confirm what will transfer
./deploy.sh
```

Then generate `/opt/zoia/.env` on the server:

```bash
ssh zoia@<server-ip>
cd /opt/zoia
./scripts/gen-env.sh zoia.<domain> sfu.<domain> > .env
chmod 600 .env
docker compose up -d --build
```

The generator exists because the LiveKit credentials appear in three places that must
agree — `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`, and `LIVEKIT_KEYS` as `"key: secret"`.
Out of step, they fail at connect time with no useful error.

Then verify:

```bash
bash scripts/preflight.sh
```

Finally sign up from the app yourself, at `https://<PUBLIC_HOST>`, and make that account the
super admin — the one who approves people and makes other admins:

```bash
docker compose exec app node server/bin/keytool.js account:super you@example.com
```

That is the only step done on the server; everything after it is done in the app
([ADR 0031](adr/0031-accounts-with-admin-approval.md)).

---

## Day to day

### Let someone in

Send them a release (or a build from `desktop/make-exe.bat`) and your server's address. They
create an account in the app; it waits for approval. Admins see a count on the settings
button and a notice when someone new is waiting, and approve or reject them in
**Settings › Accounts**.

Approve only people you recognise. The email is not verified — there is no mail — so the
approval is the check.

### Admins

Admins approve sign-ups, disable and re-enable people, and issue password reset codes. Only
the super admin makes or removes admins, from the same list. Nobody can touch the super
admin from the app; to hand the role to someone else:

```bash
docker compose exec app node server/bin/keytool.js account:super new-owner@example.com
```

The previous super admin becomes an admin.

### Someone forgot their password

An admin picks **Reset password** next to them in Settings › Accounts and passes the code on;
it works once, for 24 hours. The person chooses **Have a code from an admin?** on the sign-in
screen. Every machine of theirs is signed out when it is used.

When the locked-out person is the only admin, issue the code on the server instead. It is
written to a file, never printed:

```bash
docker compose exec app node server/bin/keytool.js account:list
docker compose exec app node server/bin/keytool.js account:reset <accountId> --codes /tmp/code.json
docker compose exec app cat /tmp/code.json && docker compose exec app rm /tmp/code.json
```

Ten wrong passwords lock an account for 15 minutes on their own; that needs no action.

### Cut someone off

**Disable** them in Settings › Accounts. Every machine of theirs loses access on its next
request, not its next launch: the session is re-checked against the database every time.

One machine only, such as a lost laptop: they can sign it out themselves under Settings ›
Profile, or on the server:

```bash
docker compose exec app node server/bin/keytool.js device:list <accountId>
docker compose exec app node server/bin/keytool.js device:revoke <deviceId>
```

### Disconnect someone, or find out why they were

Right-click someone in the channel list and choose **Disconnect**: their app leaves its
channel and says an admin disconnected it; the chats stay open, and they can join again. It is not a ban; keeping someone out is
Disable, above. The server also disconnects anyone who has sat in a channel for
`IDLE_KICK_MINUTES` (thirty) neither sharing nor watching. Both are logged:

```bash
docker compose logs app | grep -E '\[admin\].*kicked|\[idle\] kicked'
```

### Chat photos and videos disappear

All chats' photos and videos share `CHAT_MEDIA_CAP_GB` (5 GB). Past it, the oldest files are
deleted to make room, and their messages say the file is no longer available. That is the cap
working, not a fault: `docker compose logs app | grep 'over its cap'` shows when it happened.
Raise the cap in `.env` if the disk has room, then `docker compose up -d app`.

### Deploy a change

```bash
./deploy.sh
```

The script refuses to proceed if `.env` is missing on the server, and never transfers `.env`
or `server/data` — secrets and the access records live only on the VM.

### Back up the database

Every account and device is in `server/data/zoia.db`
([ADR 0032](adr/0032-sqlite-for-credentials.md)). Take a consistent copy while the server
runs, then fetch it:

```bash
ssh zoia@<server-ip> 'cd /opt/zoia && docker compose exec -T app \
  node server/bin/keytool.js db:backup server/data/backup.db'
scp zoia@<server-ip>:/opt/zoia/server/data/backup.db zoia-$(date +%F).db
ssh zoia@<server-ip> 'rm /opt/zoia/server/data/backup.db'
```

It holds password hashes and every email: keep it private, and out of git — `deploy.sh`
already refuses to transfer `server/data` in either direction. Losing it means everyone
signs up again. Profile pictures are beside it, in `server/data/avatars/`, and photos and
videos sent in chats in `server/data/chat-media/`; copy those folders as they are. The list
of chats and their limit are in this file too.

### Back up the chat messages

Messages and read markers are in ScyllaDB, in the `scylla_data` volume
([ADR 0036](adr/0036-text-chat-in-scylladb.md)), not in `server/data`. A snapshot is a set of
hard links, consistent while Scylla runs; archive it, fetch it, then clear it:

```bash
ssh zoia@<server-ip> 'cd /opt/zoia && docker compose exec -T scylla \
  sh -c "nodetool snapshot -t backup zoia && \
         tar czf /tmp/chat.tgz -C /var/lib/scylla/data/zoia --wildcards \"*/snapshots/backup\" && \
         nodetool clearsnapshot -t backup zoia" && \
  docker compose cp scylla:/tmp/chat.tgz /tmp/chat.tgz'
scp zoia@<server-ip>:/tmp/chat.tgz zoia-chat-$(date +%F).tgz
ssh zoia@<server-ip> 'rm /tmp/chat.tgz'
```

Losing it loses the history and who has read what; the chats themselves, being in
`zoia.db`, stay. `docker compose down -v` deletes the volume — never pass `-v` on the VM.

---

## Homolog environment

A second server for testing builds before production
([ADR 0035](adr/0035-homolog-environment.md)): its own VM, app, web front and database, at
`zoia-homolog.<domain>`. The production Caddy routes that hostname to it, and it uses the
production LiveKit, so it needs no router rules and no SFU of its own.

```
internet ─443─► prod VM caddy ─┬─ zoia.<domain>          → app (prod)
                               ├─ sfu.<domain>           → livekit (shared)
                               └─ zoia-homolog.<domain>  → http://<homolog-ip>:3000
homolog VM: app only ── LiveKit API over the LAN ──► http://<server-ip>:7880
```

### 1. DNS

An A record `zoia-homolog` → `<public-ip>`, **DNS only** (grey), like the other two.

### 2. The VM

The same steps as [the production VM](#2-the-vm), with a new id, name and address. It needs
less: no SFU runs on it.

```bash
qm create 121 --name zoia-homolog \
  --memory 2048 --cores 2 --cpu host \
  --net0 virtio,bridge=vmbr0 \
  --scsihw virtio-scsi-pci --ostype l26 \
  --agent enabled=1 --serial0 socket --vga serial0
qm set 121 --scsi0 local-lvm:0,import-from=/var/lib/vz/template/iso/debian-12-generic-amd64.qcow2
qm set 121 --boot order=scsi0
qm disk resize 121 scsi0 16G
qm set 121 --ide2 local-lvm:cloudinit
qm set 121 --ciuser zoia --sshkeys /root/zoia-key.pub
qm set 121 --ipconfig0 ip=<homolog-ip>/24,gw=<lan-prefix>.1
qm set 121 --nameserver <lan-prefix>.3 --searchdomain example.com
qm start 121
qm snapshot 121 clean-debian --description "fresh cloud-init, pre-docker"
```

Then bootstrap it, and from the homolog VM check that it can reach the production SFU's API:

```bash
ssh zoia@<homolog-ip> 'bash -s' < scripts/bootstrap-vm.sh
ssh zoia@<homolog-ip> 'curl -fsS http://<server-ip>:7880'   # prints OK
```

### 3. Its `.env`, and its key on the shared SFU

Deploy once so the scripts are on the VM. It stops at the missing `.env`, which is expected:

```bash
export ZOIA_HOMOLOG_HOST=zoia@<homolog-ip>
./deploy.sh --homolog
```

Generate the homolog's `.env` on the homolog VM:

```bash
ssh zoia@<homolog-ip>
cd /opt/zoia
./scripts/gen-env.sh --homolog zoia-homolog.<domain> sfu.<domain> <server-ip> > .env
chmod 600 .env
```

It prints a `LIVEKIT_KEYS` line on the terminal. On the **production** VM, put that in
`/opt/zoia/.env` in place of the existing line, with production's own key and secret first,
then restart LiveKit:

```bash
LIVEKIT_KEYS="{<prod key>: <prod secret>, <homolog key>: <homolog secret>}"
```

```bash
docker compose up -d livekit
bash scripts/preflight.sh     # "LIVEKIT_KEYS matches" must still pass
```

It has to be the `{…}` map; a comma-separated list stops LiveKit from starting.

### 4. The route on the production Caddy

On the production VM:

```bash
cd /opt/zoia
cp caddy/homolog.caddy.example caddy/sites/homolog.caddy
# set the real hostname and <homolog-ip> in it
docker compose restart caddy
docker compose logs -f caddy   # watch the certificate for zoia-homolog arrive
```

This file exists on the production server only. `deploy.sh` never transfers or deletes it.

### 5. Deploy and use it

```bash
git switch <branch-to-test>
./deploy.sh --homolog
```

Then give it production's people. This replaces the homolog's database and profile pictures
with a consistent copy of production's, so everyone signs in with the account they already
have, super admin included. Channels are not copied:

```bash
export ZOIA_HOST=zoia@<server-ip>
./scripts/seed-homolog.sh
```

Re-run it whenever the homolog should catch up with production. It discards whatever changed
on the homolog since. Point a desktop build at `https://zoia-homolog.<domain>` to use it.

Every `docker compose` command on the homolog VM needs `-f docker-compose.homolog.yml`.
`scripts/preflight.sh` is for the production VM only.

---

## Troubleshooting

### Viewers join, then see black video forever

Signalling works and media does not. In order of likelihood:

1. **`use_external_ip` is not set** in `livekit.yaml` — LiveKit is advertising only private
   ICE candidates. This is by far the most common cause.
2. **UDP 7882 is not reaching the VM.** Check the router forward.
3. **The Cloudflare record is orange-clouded.** It must be DNS only.

Confirm with `chrome://webrtc-internals` on a viewer: look at the selected candidate pair.

### Everything works, but only over TCP

If the selected candidate pair is on port 7881, UDP is being dropped and you are running on
the fallback — which works but adds latency and bandwidth. Check the UDP forward.

### The stream hiccups roughly once a minute

`proxy_read_timeout` on the `sfu.<domain>` proxy host. Nginx is closing the signalling
WebSocket at its 60 s default and the client is reconnecting.

### A LAN machine gets the router's login page instead of the app

The router is not hairpinning: it answers its own WAN address from inside the LAN. Since the
host PC is on that LAN, this blocks broadcasting entirely.

Fix with a local DNS override mapping `zoia.example.com` and `sfu.example.com` to the
VM (`<server-ip>`). You already run a your local DNS at `<lan-prefix>.3`, so that is the place:
**Settings → Local DNS → DNS Records**, one entry per hostname. Every LAN client that uses
the your local DNS then resolves correctly, without per-machine `/etc/hosts` edits.

Check that LAN clients actually use the your local DNS for DNS first — if the router hands out its
own address instead, the override will not be consulted.

### Somebody cannot start sharing

Publishing is a server-side permission, granted per person when they claim their own
broadcast slot. Anyone may broadcast alongside anyone else; nobody waits for a turn. See
[ADR 0013](adr/0013-multiple-broadcast-slots.md). If the share button does nothing:

1. **They are not connected to the room yet.** A claim from someone LiveKit does not list is
   refused with `409 not_in_room`. Wait for the app to show it is connected, or reconnect.
2. **The source label, or a rename, is refused mid-broadcast.** The server replaces the whole
   LiveKit permission on claim; `stage.js` must restate `canUpdateMetadata` or the client
   loses it. `server/test/stage.test.js` guards this.
3. **The device was revoked.** Their next request returns 401 and the app says so. Check
   `device:list`.

### Audio: what carries sound and what does not

This is the app's whole reason for existing, so it is worth being precise:

| Sharing | Audio |
|---|---|
| **A window** | ✅ That application's audio, captured per-process with WASAPI loopback |
| **A whole screen** | ❌ Silent **on purpose** |
| **A camera** | ✅ A microphone you pick, with a level meter before anything publishes |

A screen is silent by design, not by accident. A screen has no owning process, so the only
audio it could carry is the entire system mix — every notification, every other call, and
whatever music is playing. That is precisely what this app was built to avoid. Share the
window instead.

No virtual audio cable is needed, and installing one will not help. Earlier versions of this
document described routing audio through VB-Audio Virtual Cable, because a browser cannot do
per-application capture. The desktop app does it natively —
[ADR 0006](adr/0006-native-desktop-client.md).

### A window is shared but viewers hear nothing

In order of likelihood:

1. **It is a screen, not a window.** See above.
2. **The application is genuinely silent**, or plays through a device Windows does not route
   through the process. The level meter in the app answers this without a second machine:
   if it does not move, nothing is being captured.
3. **Windows is older than 10 build 19041 (2004).** Per-process loopback does not exist
   before that, and the app falls back to system audio and says so.
4. **The viewer has not clicked anything yet.** Browsers and Electron both refuse to start
   audio without one user gesture.

### The stream is choppy or audio drifts behind the picture

The app counts underruns, overruns and buffer depth, and shows them. Both counters should
sit at or near zero over a long broadcast.

- **Counters climbing steadily** means the capture clock and the playback clock disagree.
  There is a latency ceiling that drops the oldest frames to bound the offset; if it is
  working you will see `drifted` increase while latency stays flat.
- **Video choppy, audio fine** is usually upstream bandwidth. Lower `MAX_BITRATE`.

### A window stops updating when it is behind another window

Only on the hardware encoding path, and it is inherent to it: Windows Graphics Capture is
event-driven and delivers a frame when the window redraws. An occluded or minimised window
genuinely stops redrawing. See [ADR 0009](adr/0009-hardware-encoding.md). The default CPU
path does not have this behaviour.

### Hardware encoding fails for somebody

Read what their machine reported **before** changing anything. This is the lesson of
[ADR 0011](adr/0011-hardware-encoding-over-the-internet.md): four fixes landed before
anyone looked, and the first look found the cause.

```bash
docker compose logs app | grep -A40 '\[report\]'
```

A failed hardware broadcast reports as `gpu-broadcast-failed` or `gpu-start-failed`. The
report carries the reason, the exact ffmpeg command, the GPU and encoder chosen, and the
last 200 lines of ffmpeg's output. On their machine, `%APPDATA%\Zoia\ffmpeg.log` has the
same, uncut. Ignore `Conversion failed!`: that's ffmpeg's generic last line, and the cause is
above it.

| What the log says | What it means |
|---|---|
| `Connection to tcp://…:8085 failed: Error number -138` | An old build publishing to the removed Ingress at a LAN address. Update the app |
| `Failed to request url=https://sfu.<domain>/whip/v1` | The SFU rejected the publish token, usually because it expired before the connection finished. Retry; check the server's clock if it keeps happening |
| `409 not_stage_holder` from `/api/whip` | They released their slot, or never claimed one, before publishing started. Claim again |
| Connects, then no picture | UDP 7882 isn't reaching the server, the same fault viewers would see |
| No picture, and ffmpeg's `time=` stays frozen (e.g. `00:00:00.07`) under `Timestamps are unset in a packet` | Frames are going out without timestamps. The window-capture path copies the addon's H.264 and needs `-use_wallclock_as_timestamps 1` on that input. No failure report is filed, so read `ffmpeg.log` on their machine |
| `Unsupported audio channels 1 by RTC` | Mono audio reached the WHIP muxer. The app forces stereo, so this means a new code path forgot `-ac 2` |
| `Cannot load nvcuda.dll` | NVENC requested on a machine without an NVIDIA GPU |
| `NVENC: … status 15` / "older than this build expects" | Driver below 471.41. It falls back to the readback path automatically; updating the driver restores zero-copy |
| `Unsupported B frames by RTC` | An encoder produced B-frames, which WHIP refuses. Every path passes `-bf 0`, so this means a new path forgot to |
| `That window reports no visible area` | The window is minimised. Restore it |

A failure identical across very different GPUs almost always sits above the GPU:
reachability, configuration, or an argument on the shared list.

### The GPU path fails to start

```
NVENC is unavailable: nvEncodeAPI64.dll could not be loaded
```

That machine has no NVIDIA GPU. Capability is probed at startup and the app falls back to
the CPU path on its own; this message means the hardware path was requested explicitly. It
is off by default for exactly this reason.

### Text is blurry when the host shares an IDE

Check that the publish options still set `contentHint = 'text'` and
`degradationPreference: 'maintain-resolution'`. Without them the encoder drops resolution
under load instead of frame rate. If they are set and it is still soft, the link is short of
upstream bandwidth — lower the viewer count or enable simulcast.

### Logs

```bash
docker compose logs -f app
docker compose logs -f livekit
```

Passwords, device credentials, reset codes and email addresses must never appear there;
accounts and machines are logged by id. If one does, that is a bug — fix it, then reset or
revoke whatever leaked. There are tests asserting this, because it is the kind of guarantee
that breaks silently.

Client-side crashes are reported automatically and readable without asking anyone to find a
log file — with an admin's session cookie, since a report names someone's machine:

```bash
curl -s --cookie "$COOKIE" https://zoia.<domain>/api/reports | jq .
```
