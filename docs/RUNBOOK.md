# Runbook

Operating Zoia: first deployment, day-to-day tasks, and what to do when it
misbehaves.

## Network inventory

Discovered on the LAN (`192.168.31.0/24`), for reference while following this guide:

| Host | Address | Notes |
|---|---|---|
| Router (Xiaomi / MiWiFi) | `192.168.31.1` | Port forwarding and DHCP reservations live here |
| Proxmox | `192.168.31.2:8006` | Web UI |
| Pi-hole | `192.168.31.3` | **Where the split-horizon DNS override goes, if hairpin fails** |
| Nginx Proxy Manager | `192.168.31.4` | LAN/VPN only — **not** exposed, and not used by this project |
| Mesh node / repeater | `192.168.31.200` | Also answers with a MiWiFi certificate |
| Workstation | `192.168.31.230` | |
| **zoia-vm** | `192.168.31.60` | Verified free by ping and ARP on 2026-09-21. `.50` was taken |
| Public IP | `206.42.10.147` | Static |

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

The zone `nullptrlabs.com` is served by Cloudflare nameservers (`nadia`/`rudy.ns.cloudflare.com`),
and a Let's Encrypt wildcard `*.nullptrlabs.com` is already issued and renewing. That wildcard
Caddy on the VM obtains its own certificates for the two hostnames below over a Cloudflare
DNS-01 challenge, so nothing here depends on the existing wildcard.

Add two records in the **Cloudflare dashboard** → `nullptrlabs.com` → DNS → Records:

| Type | Name | IPv4 address | Proxy status | TTL |
|---|---|---|---|---|
| A | `zoia` | `206.42.10.147` | **DNS only** (grey) | Auto |
| A | `sfu` | `206.42.10.147` | **DNS only** (grey) | Auto |

> **Cloudflare defaults new records to Proxied (orange). Both of these must be toggled to
> DNS only.** The apex record on this zone *is* proxied, so the habit is easy to carry over
> by accident. Proxying breaks this app in two ways: Cloudflare's network does not carry
> WebRTC media (UDP) at all, and routing the signalling WebSocket through it adds latency
> and failure modes for no benefit. `scripts/preflight.sh` checks both records and fails
> loudly if either is proxied.

Confirm before going further — both must return the origin address, not a Cloudflare one:

```bash
nslookup zoia.nullptrlabs.com 1.1.1.1
nslookup sfu.nullptrlabs.com  1.1.1.1
# both must print 206.42.10.147
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
qm set 120 --ipconfig0 ip=192.168.31.60/24,gw=192.168.31.1
qm set 120 --nameserver 192.168.31.3 --searchdomain nullptrlabs.com

# 5. start, then snapshot before any app code lands
qm start 120
qm snapshot 120 clean-debian --description "fresh cloud-init, pre-docker"
```

`--cpu host` exposes AES-NI to the guest, which both TLS and the SFU use. The nameserver
points at the Pi-hole, so the VM honours any local DNS overrides added for hairpin.

`/root/zoia-key.pub` is the workstation's SSH public key, written to the host beforehand.

On Proxmox 7 or earlier, replace step 3 with `qm importdisk 120 <path> local-lvm`, then read
the generated volume name from `qm config 120` and attach it as `scsi0` by hand.

Give the VM a **static address or a DHCP reservation** — all three router forwards address
it by IP, and a lease change would break them silently. `.60` was verified free by
ping and ARP; `.50` is occupied.

Then prepare it and **take a snapshot** before any app code lands:

```bash
ssh zoia@192.168.31.60 'bash -s' < scripts/bootstrap-vm.sh
```

### 3. Router

Nothing on this network was previously published to the internet — everything is reached over
the VPN. Zoia is the first exposed service, so these are the first forwards.

All three point at the **VM**, `192.168.31.60`:

| External port | Proto | → | Why |
|---|---|---|---|
| **443** | TCP | 192.168.31.60 | Caddy: the page and LiveKit signalling |
| **7882** | UDP | 192.168.31.60 | WebRTC media. One rule serves every viewer |
| **7881** | TCP | 192.168.31.60 | Fallback for networks that block UDP |

**Do not forward 80.** Certificates come from a DNS-01 challenge, which needs no inbound
HTTP. Caddy publishes 80 for a LAN-side redirect only.

**Do not forward anything to Nginx Proxy Manager.** It routes by `Host` header, so exposing
it would make every service behind it reachable from the internet. It stays LAN/VPN only.
See ADR 0004.

### 4. TLS (Caddy on the VM)

No NPM proxy hosts are involved. Caddy obtains certificates itself over a Cloudflare DNS-01
challenge, which is the same mechanism already issuing the `*.nullptrlabs.com` wildcard.

Create a token at **Cloudflare → My Profile → API Tokens → Create Token → Edit zone DNS**:

- Permissions: `Zone` · `DNS` · `Edit`
- Zone Resources: `Include` · `Specific zone` · `nullptrlabs.com`

Scope it to this zone only. It can edit DNS for the zone, so treat it as a real secret; it
lives in `.env` on the server and never in git.

Paste it into `/opt/zoia/.env` as `CLOUDFLARE_API_TOKEN`.

Caddy serves exactly `zoia.nullptrlabs.com` and `sfu.nullptrlabs.com`. Any other Host header
reaches nothing, which is the point.

### 5. The app

```bash
ssh zoia@192.168.31.60
sudo mkdir -p /opt/zoia && sudo chown zoia:zoia /opt/zoia
```

From the workspace:

```bash
./deploy.sh --dry-run     # confirm what will transfer
./deploy.sh
```

Then generate `/opt/zoia/.env` on the server:

```bash
ssh zoia@192.168.31.60
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

Finally mint yourself a host key:

```bash
docker compose exec app node server/bin/keytool.js add --name "Caio" --role host
```

---

## Day to day

### Invite someone

```bash
docker compose exec app node server/bin/keytool.js add --name "Alice" --role viewer
```

Send them the printed URL. It is shown once and cannot be recovered; a lost key is replaced,
not looked up.

Add `--expires-in-days 30` for temporary access.

### Revoke someone

```bash
docker compose exec app node server/bin/keytool.js list
docker compose exec app node server/bin/keytool.js revoke <keyId>
```

It takes effect on their next request, including on a tab they already have open.

### Deploy a change

```bash
./deploy.sh
```

The script refuses to proceed if `.env` is missing on the server, and never transfers `.env`
or `server/data` — secrets and the key store live only on the VM.

### Back up the key store

```bash
scp zoia@192.168.31.60:/opt/zoia/server/data/keys.json ./keys-backup-$(date +%F).json
```

It holds hashes, not keys, but losing it means re-inviting everyone. Keep it out of git.

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

Fix with a local DNS override mapping `zoia.nullptrlabs.com` and `sfu.nullptrlabs.com` to the
VM (`192.168.31.60`). You already run a Pi-hole at `192.168.31.3`, so that is the place:
**Settings → Local DNS → DNS Records**, one entry per hostname. Every LAN client that uses
the Pi-hole then resolves correctly, without per-machine `/etc/hosts` edits.

Check that LAN clients actually use the Pi-hole for DNS first — if the router hands out its
own address instead, the override will not be consulted.

### The host has no "Start broadcast" button

`getDisplayMedia` is missing. Either the page is not on HTTPS (the page says which), or the
browser is not Chrome/Edge on desktop.

### Sharing one application's sound (the Discord question)

To be precise about what Discord does, because it is easy to overstate:

- **Discord in a browser** shares audio using `getDisplayMedia`, exactly as this app does.
  Same API, same constraints: tab audio, or system audio for a whole screen.
- **Discord's desktop client** additionally captures a *specific application's* audio. That
  needs a native system hook and is not available to any web page.

So a browser can share sound — it just cannot single out one application. There is no web API
for "the sound of that window", deliberately, since it would let any page listen to
everything you play.

What works in a browser, in order of effort:

| Sharing | Audio |
|---|---|
| **Entire screen** | ✅ Tick "Share system audio" — everything you hear |
| **A Chrome tab** | ✅ Tick "Share tab audio" — just that tab |
| **A window** | ❌ Never. No platform supports it |

To get *per-application* audio anyway, route it through a virtual input device:

1. Install a virtual audio cable on the broadcasting machine — VB-Audio Virtual Cable is
   free and the usual choice on Windows.
2. Windows → Settings → System → Sound → **Volume mixer**, and set that application's
   output device to the cable.
3. In Zoia's side panel, under **Your audio**, click "Choose audio input…" (this is the one
   place a permission prompt appears) and select the cable.
4. Share the window as normal. The cable's audio is published alongside it.

To hear the app yourself while doing this, use VoiceMeeter or the cable's "listen to this
device" option, otherwise the sound goes only to viewers.

The same picker is how you **talk over a broadcast**: select your microphone instead.

### The host is sharing but there is no sound

System and tab audio capture works only in Chrome and Edge on desktop. The "share audio"
checkbox appears for a tab or a whole screen, never for a single window. Viewers also need
one click before audio can start; that is what the Join button is for.

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

Raw invite keys must never appear there. If one does, that is a bug — fix it and rotate the
affected key.
