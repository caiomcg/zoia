# Runbook

Operating Zoia: first deployment, day-to-day tasks, and what to do when it
misbehaves.

---

## First deployment

### 1. DNS (Cloudflare)

Registration stays at Squarespace; only the nameservers move, which is what makes
automated certificate renewal possible.

1. Add the zone at Cloudflare and **verify the imported records** before switching — other
   services go dark at cutover otherwise.
2. Point the Squarespace nameservers at the two Cloudflare assigns. Propagation is usually
   under an hour.
3. Add two records, both **DNS only (grey cloud)**:

   | Type | Name | Value |
   |---|---|---|
   | A | `zoia` | `206.42.10.147` |
   | A | `sfu` | `206.42.10.147` |

   The grey cloud is not optional: Cloudflare's proxy will not carry WebRTC media.
4. Create an API token scoped to **Zone:DNS:Edit** on this zone for NPM's DNS challenge.

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
  --ipconfig0 ip=192.168.31.50/24,gw=192.168.31.1
qm resize 120 scsi0 32G && qm start 120
```

Adjust the subnet to the real LAN. Give the VM a **static IP or DHCP reservation** — both
the router forwards and NPM address it by IP, and a lease change breaks both silently.

Then install Docker and Compose, and **take a snapshot** before any app code lands.

### 3. Router

Leave 80/443 pointed at NPM. Add two forwards to the VM:

| Port | Proto | Why |
|---|---|---|
| 7882 | UDP | WebRTC media. One rule serves every viewer |
| 7881 | TCP | Fallback for networks that block UDP |

Do not expose 7880.

### 4. Nginx Proxy Manager

**Proxy Host — app**
- `zoia.<domain>` → `http://192.168.31.50:3000`
- Websockets Support · Block Common Exploits · Force SSL · HTTP/2
- SSL: wildcard cert via the Cloudflare DNS challenge

**Proxy Host — SFU signalling**
- `sfu.<domain>` → `http://192.168.31.50:7880`
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
ssh zoia@192.168.31.50
sudo mkdir -p /opt/zoia && sudo chown zoia:zoia /opt/zoia
```

From the workspace:

```bash
./deploy.sh --dry-run     # confirm what will transfer
./deploy.sh
```

Then, on the server, create `/opt/zoia/.env` from `.env.example`:

```bash
docker run --rm livekit/generate           # api key + secret
openssl rand -base64 48                    # SESSION_SECRET
```

`LIVEKIT_KEYS` must be `"<api key>: <api secret>"` — the same pair the app uses.

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
scp zoia@192.168.31.50:/opt/zoia/server/data/keys.json ./keys-backup-$(date +%F).json
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

Fix with a local DNS override mapping `zoia.<domain>` to NPM's LAN IP — a custom hosts entry
on the router, a Pi-hole, or `/etc/hosts` on the host PC.

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
