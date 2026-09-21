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
| Nginx Proxy Manager | `192.168.31.4` | Admin UI on `:81`, serving 80/443 |
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

The zone `example.com` is served by Cloudflare nameservers (`nadia`/`rudy.ns.cloudflare.com`),
and a Let's Encrypt wildcard `*.example.com` is already issued and renewing. That wildcard
covers both hostnames below, so **no new certificate is required** — NPM selects the existing
one from its dropdown.

Add two records in the **Cloudflare dashboard** → `example.com` → DNS → Records:

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
nslookup zoia.example.com 1.1.1.1
nslookup sfu.example.com  1.1.1.1
# both must print 206.42.10.147
```

### 2. The VM

On the Proxmox host:

```bash
wget https://cloud.debian.org/images/cloud/bookworm/latest/debian-12-generic-amd64.qcow2
qm create 120 --name zoia-vm --memory 6144 --cores 4 --cpu host \
  --net0 virtio,bridge=vmbr0 --scsihw virtio-scsi-pci --agent 1
qm importdisk 120 debian-12-generic-amd64.qcow2 local-lvm
qm set 120 --scsi0 local-lvm:vm-120-disk-0 --boot order=scsi0 \
  --ide2 local-lvm:cloudinit --serial0 socket --vga serial0
qm set 120 --ciuser zoia --sshkeys ~/.ssh/authorized_keys \
  --ipconfig0 ip=192.168.31.60/24,gw=192.168.31.1
qm resize 120 scsi0 32G && qm start 120
```

Adjust the subnet to the real LAN. Give the VM a **static IP or DHCP reservation** — both
the router forwards and NPM address it by IP, and a lease change breaks both silently.

Then prepare it and **take a snapshot** before any app code lands:

```bash
ssh zoia@192.168.31.60 'bash -s' < scripts/bootstrap-vm.sh
```

### 3. Router

Leave 80/443 pointed at NPM. Add two forwards to the VM:

| Port | Proto | Why |
|---|---|---|
| 7882 | UDP | WebRTC media. One rule serves every viewer |
| 7881 | TCP | Fallback for networks that block UDP |

Do not expose 7880.

### 4. Nginx Proxy Manager

**Proxy Host — app**
- `zoia.<domain>` → `http://192.168.31.60:3000`
- Websockets Support · Block Common Exploits · Force SSL · HTTP/2
- SSL: select the **existing `*.example.com` wildcard** from the dropdown. Do not request
  a new certificate — the wildcard already covers this hostname. Force SSL, HTTP/2

**Proxy Host — SFU signalling**
- `sfu.<domain>` → `http://192.168.31.60:7880`
- Websockets Support (this host is nothing but a WebSocket)
- Advanced:
  ```nginx
  proxy_read_timeout 86400s;
  proxy_send_timeout 86400s;
  ```
  Nginx's 60 s default severs signalling mid-broadcast, and the stream then hiccups every
  minute in a way that looks like an application bug.

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

Fix with a local DNS override mapping `zoia.<domain>` and `sfu.<domain>` to NPM's LAN IP
(`192.168.31.4`). You already run a Pi-hole at `192.168.31.3`, so that is the place to do it:
**Settings → Local DNS → DNS Records**, one entry per hostname. Every LAN client that uses
the Pi-hole then resolves correctly, without per-machine `/etc/hosts` edits.

Check that LAN clients actually use the Pi-hole for DNS first — if the router hands out its
own address instead, the override will not be consulted.

### The host has no "Start broadcast" button

`getDisplayMedia` is missing. Either the page is not on HTTPS (the page says which), or the
browser is not Chrome/Edge on desktop.

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
