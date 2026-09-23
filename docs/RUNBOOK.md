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

## Helper scripts

| Script | Run it | Does |
|---|---|---|
| `scripts/bootstrap-vm.sh` | on the VM, once | Installs Docker, guest agent, creates `/opt/zoia` |
| `scripts/gen-env.sh` | on the VM | Generates `.env` with consistent secrets |
| `scripts/preflight.sh` | on the VM, after deploying | Checks every failure mode that looks like an app bug |
| `deploy.sh` | from the workstation | rsync + `docker compose up -d --build` |

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

Finally mint a pairing token, which is what a build carries:

```bash
docker compose exec app node server/bin/keytool.js \
  pair:new --name "friends" --max-activations 5
```

It prints once. Bake it into an `.exe` with `desktop/make-exe.bat` — see
[DISTRIBUTING.md](DISTRIBUTING.md).

> `keytool add` still exists and still mints invite keys. Nothing consumes them since the
> browser client was retired ([ADR 0008](adr/0008-retire-the-browser-client.md)); the desktop
> app pairs instead ([ADR 0007](adr/0007-device-pairing.md)).

---

## Day to day

### Invite someone

Send them a build. The pairing token inside it is what grants access, so the question is
which token that build carries — mint one per group rather than one for everyone:

```bash
docker compose exec app node server/bin/keytool.js \
  pair:new --name "friends" --max-activations 5
```

Printed once, and not recoverable. `--max-activations` caps how many machines it can ever
enrol, which bounds the damage if it gets passed around. `--expires-in-days 30` works too.

Then build an `.exe` carrying it: [DISTRIBUTING.md](DISTRIBUTING.md).

### See who has access

```bash
docker compose exec app node server/bin/keytool.js device:list
```

One row per machine, with the token it came from and when it was last seen. `lastSeen`
updates on every token renewal, not just at launch, so a machine that has been streaming all
week reads as current.

### Revoke someone

Two levers, and which one to reach for depends on what went wrong:

```bash
# One machine loses access. Nobody else notices.
docker compose exec app node server/bin/keytool.js device:revoke <deviceId>

# No NEW machines can activate. Everyone already paired keeps working.
docker compose exec app node server/bin/keytool.js pair:list
docker compose exec app node server/bin/keytool.js pair:revoke <pairingId>
```

Both take effect on the next request, not the next launch — the session cookie holds an id
that is re-resolved against the store every time. See
[ADR 0007](adr/0007-device-pairing.md).

Revoking a pairing token does **not** cut off machines that already paired with it. If a
build leaked and you want everyone on it gone, revoke the token *and* the devices it
enrolled — `device:list` shows which those are.

### Deploy a change

```bash
./deploy.sh
```

The script refuses to proceed if `.env` is missing on the server, and never transfers `.env`
or `server/data` — secrets and the access records live only on the VM.

### Back up the access records

Three files, and all of them matter — devices and pairings are what the desktop app runs on:

```bash
ssh zoia@<server-ip> 'tar czf - -C /opt/zoia server/data' \
  > zoia-data-$(date +%F).tar.gz
```

They hold scrypt hashes, not secrets, but losing them means re-pairing every machine. Keep
them out of git — `deploy.sh` already refuses to transfer `server/data` in either
direction.

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

Publishing is a server-side permission, granted only while the stage is free. If the share
button does nothing:

1. **Somebody else holds the stage.** Only one person broadcasts at a time. Ask for it — the
   holder can hand over, and if they have wandered off it can be taken after thirty seconds.
2. **A previous broadcaster's machine died without releasing.** This resolves itself: the
   stage is derived from LiveKit's participant list, not stored, so a participant who has
   gone simply is not in it. See [ADR 0005](adr/0005-one-tier-claimable-stage.md).
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

Raw pairing tokens, device credentials and invite keys must never appear there. If one
does, that is a bug — fix it, then revoke and reissue whatever leaked. There are tests
asserting this for the pairing flow, because it is the kind of guarantee that breaks
silently.

Client-side crashes are reported automatically and readable without asking anyone to find a
log file:

```bash
curl -s --cookie "$COOKIE" https://zoia.<domain>/api/reports | jq .
```
