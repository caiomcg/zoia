# Zoia — private screen broadcast (1 host → many viewers)

## Context

You want a self-hosted page where **one person shares their screen** — a browser tab, a
desktop workspace, or a single app window — and **everyone else with the link watches it
live**, with audio. It runs on your Proxmox box (Ryzen 5 3500U, 4C/8T, 10 GB DDR4 free),
everyone gets the same URL, and only people you've explicitly invited can get in.

The build is a **self-hosted LiveKit SFU** plus a **small Node app you own** that serves the
page, checks who you are, and mints LiveKit tokens. The SFU is what lets one uploader feed
15 downloaders without the host's PC melting; the Node app is what makes "host" and "viewer"
real roles rather than an honour system. Your existing **Nginx Proxy Manager** is the front
door — no new TLS layer, no new public ports for HTTP.

Two facts drive most of the decisions below:

- **Screen capture requires HTTPS.** `getDisplayMedia()` simply does not exist on plain
  HTTP, so TLS is a hard prerequisite, not polish.
- **Roles are enforced server-side.** Viewers receive a token whose grant says `canPublish:
  false`, and LiveKit rejects publish attempts from such a token. "Single producer" is a
  property of the system, not of everyone behaving in the browser console.

---

## What I verified

| Check | Result |
|---|---|
| `206.42.10.147` matches your actual public IP | ✅ Confirmed — your Squarespace A record points at the right address |
| Static IP | ✅ Per you, never changes — no DDNS needed |
| Ports 80/443 from inside the LAN | Answered by **nginx 1.12.2 with a `MIWIFI ROOT CA` cert** — i.e. your Xiaomi router's own admin UI |
| Port 8080 | Open (also the router) |
| Ports 22, 7880, 7881, 8006, 8443 | Closed from outside ✅ |

Since NPM is already public on 80/443, that MiWiFi response was the router answering its own
WAN IP **from inside the LAN** — normal hairpin behaviour, not an exposed admin panel.
Nothing to fix. But it has one consequence that matters a great deal here:

> ### ⚠️ Verify LAN hairpin before building
> If a machine **on your home network** browses to `https://zoia.<domain>` and gets the
> MiWiFi login page instead of NPM, your router isn't hairpinning — and since **the host PC
> is on that LAN**, the person broadcasting couldn't reach the app at all. Test this first.
> If it fails, the fix is a local DNS override pointing `zoia.<domain>` at NPM's LAN IP (a
> custom hosts entry on the MiWiFi, Pi-hole, or worst case `/etc/hosts` on the host PC).
> This costs five minutes to check now and is maddening to diagnose later.

---

## Architecture

```
  HOST PC (Chrome/Edge)                 PROXMOX  (Ryzen 5 3500U)
┌────────────────────┐          ┌──────────────────────────────────────┐
│ getDisplayMedia()  │          │  ┌────────────────────────────────┐  │
│   screen + audio   │          │  │ Nginx Proxy Manager (existing) │  │
└─────────┬──────────┘          │  │   zoia.<domain> → app:3000     │  │
          │                     │  │   sfu.<domain>  → livekit:7880 │  │
          │  WSS :443 ──────────┼─►│   wildcard cert, Cloudflare DNS│  │
          │  (signalling)       │  └────────────┬───────────────────┘  │
          │                     │               │                      │
          │  UDP :7882 ─────────┼───────────────┼──► ┌──────────────┐  │
          │  (media, direct)    │               └───►│ zoia-vm      │  │
          │                     │                    │ 4 vCPU / 6GB │  │
  VIEWERS ×15                   │                    │              │  │
┌────────────────────┐          │                    │ node app:3000│  │
│ <video> + audio    │◄─────────┼── UDP :7882 ──────►│ livekit :7880│  │
└────────────────────┘          │                    │        :7881 │  │
                                │                    │        :7882 │  │
                                └────────────────────┴──────────────┘  │
```

Signalling rides your existing 443 through NPM. **Media does not touch NPM** — nginx cannot
proxy WebRTC, so UDP 7882 goes straight to the VM. Latency host→viewer ≈ **200–500 ms**.

---

## Router ports — only two new rules

80/443 are already forwarded to NPM and stay exactly as they are. Add:

| Port | Proto | → | Why |
|------|-------|---|-----|
| **7882** | UDP | zoia-vm | WebRTC media. Single-port mux, so this one rule serves every viewer. **The critical one** |
| **7881** | TCP | zoia-vm | WebRTC-over-TCP fallback for viewers on corporate/hotel Wi-Fi that blocks UDP |

Do **not** expose 7880 — that's LiveKit's plaintext signalling port, and NPM already fronts
it on 443 with TLS.

One LiveKit setting is non-negotiable: **`rtc.use_external_ip: true`**. LiveKit STUNs itself
to learn your public IP and advertises it in ICE candidates. Without it, viewers connect to
signalling, see the room, and then stare at a black video forever — a failure that looks
like an app bug and isn't.

---

## DNS at Cloudflare

You're moving nameservers to Cloudflare (domain stays registered at Squarespace). That
unlocks automated DNS-01 renewal, which NPM supports natively.

1. Add the domain to Cloudflare (free plan) → it imports existing records.
2. **Verify the import** — confirm your current live records came across before switching,
   or other services go dark at cutover.
3. Change the nameservers at Squarespace to the two Cloudflare assigns. Propagation is
   usually under an hour.
4. Records needed — both **DNS-only (grey cloud)**:

| Type | Name | Value | Proxy |
|---|---|---|---|
| A | `zoia` | 206.42.10.147 | **DNS only** |
| A | `sfu` | 206.42.10.147 | **DNS only** |

> **The grey cloud is mandatory.** Cloudflare's orange-cloud proxy will not carry WebRTC
> media, and proxying the signalling subdomain adds nothing but breakage. If video mysteriously
> fails later, this is the first thing to check.

5. Create a Cloudflare API token scoped to **Zone:DNS:Edit** for this zone only, and paste
   it into NPM's DNS challenge config.

Two subdomains rather than path-routing `/rtc` and `/twirp` through one host: NPM's custom
locations are fiddly with WebSocket upgrades, and a second proxy host is less to debug.
Request a **wildcard `*.<domain>` cert** via DNS-01 while you're there — one cert for this
and anything else you host later.

---

## Bandwidth — the real ceiling

The SFU fans out, so your **upload** is `viewers × bitrate`:

| Viewers | @ 2.5 Mbps | @ 4 Mbps |
|---|---|---|
| 5 | 12.5 Mbps | 20 Mbps |
| 10 | 25 Mbps | 40 Mbps |
| 15 | **37.5 Mbps** | **60 Mbps** |

Check your actual upload before building. The plan defaults (2.5 Mbps / 15 fps) are already
tuned for a typical residential link — desktop and text content compresses far better than
video. If you're tighter than ~40 Mbps up, enable simulcast so LiveKit serves lower layers
to some viewers instead of stalling everyone. The 3500U will not be the bottleneck; an SFU
forwards packets and does no transcoding.

---

## Proxmox VM

Create **`zoia-vm`**, Debian 12, sized to your "half the threads" budget:

| Setting | Value |
|---|---|
| CPU | 4 vCPU, type `host` |
| RAM | 6144 MB |
| Disk | 32 GB on local-lvm |
| Network | virtio on `vmbr0` |
| Guest agent | Enabled |

Fastest path is the Debian 12 generic cloud image plus cloud-init, which lets you set the
static LAN IP, SSH key and user without touching an installer:

```bash
# on the Proxmox host
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

Adjust the subnet to your actual LAN (MiWiFi defaults to `192.168.31.0/24`). Give it a
**static IP or DHCP reservation** — the router port-forwards and NPM both point at it by
address, so a lease change breaks both silently.

Then install Docker + Compose, and take a Proxmox snapshot once it's clean, before any app
code lands. Rolling back a bad experiment then costs seconds.

---

## The stack on the VM

```
zoia/                             # git repo root → private GitHub repo
├── AGENTS.md                     # agent-facing conventions (source of truth)
├── CLAUDE.md                     # one line: "See AGENTS.md"
├── README.md                     # what it is, quickstart, how to broadcast
├── docs/
│   ├── ARCHITECTURE.md           # the diagram + data flow + why an SFU
│   ├── SECURITY.md               # threat model, key lifecycle, revocation
│   ├── RUNBOOK.md                # deploy, rotate keys, restore, debug black video
│   ├── PLAN.md                   # this plan, committed
│   └── adr/
│       ├── 0001-livekit-sfu.md
│       ├── 0002-invite-keys-over-shared-password.md
│       └── 0003-npm-as-front-door.md
├── .github/workflows/ci.yml
├── .gitignore  .env.example  commitlint.config.js  eslint.config.js
├── deploy.sh
├── docker-compose.yml
├── livekit.yaml                  # no secrets — keys injected via env
└── server/
    ├── package.json              # express, livekit-server-sdk, cookie-session,
    │                             # express-rate-limit, @node-rs/argon2
    ├── Dockerfile
    ├── bin/keytool.js            # CLI: add / list / revoke invite keys
    ├── src/
    │   ├── index.js              # routes
    │   ├── keys.js               # key store: load / verify / revoke
    │   └── token.js              # LiveKit AccessToken minting
    ├── test/
    │   ├── keys.test.js
    │   ├── token.test.js         # the security regression tests
    │   └── routes.test.js
    ├── data/keys.json            # server-only, gitignored, never deployed over
    └── public/
        ├── index.html            # login screen + room screen
        ├── app.js                # livekit-client: host publishes, viewer subscribes
        └── style.css
```

**Secrets never enter git.** `.gitignore` covers `.env*` (except `.env.example`),
`server/data/`, `node_modules`, `*.p12`. `livekit.yaml` is committed *without* keys — LiveKit
reads them from the `LIVEKIT_KEYS` environment variable instead, so the config file stays
safe to publish and there's no "did I scrub it?" moment before the first push.

Two containers — no Caddy, since NPM already terminates TLS:

- **`livekit`** — `livekit/livekit-server`, **`network_mode: host`**. WebRTC behind Docker's
  NAT is a long, unrewarding fight; host networking skips it entirely.
- **`app`** — the Node server on 3000, with `server/data` as a named volume.

**`livekit.yaml`**
```yaml
port: 7880
rtc:
  tcp_port: 7881
  udp_port: 7882          # single-port mux → one router rule
  use_external_ip: true   # ← without this, video never arrives
keys:
  <API_KEY>: <API_SECRET>  # generate: docker run --rm livekit/generate
room:
  auto_create: false       # only the app creates the room
logging:
  level: info
```

---

## Nginx Proxy Manager configuration

**Proxy Host 1 — the app**
- Domain: `zoia.<domain>` → `http://192.168.31.60:3000`
- ✅ Websockets Support · ✅ Block Common Exploits · ✅ Force SSL + HTTP/2
- SSL: the wildcard cert (Cloudflare DNS challenge)

**Proxy Host 2 — LiveKit signalling**
- Domain: `sfu.<domain>` → `http://192.168.31.60:7880`
- ✅ Websockets Support (**essential** — this host is nothing but a WebSocket)
- Advanced:
  ```nginx
  proxy_read_timeout 86400s;
  proxy_send_timeout 86400s;
  ```

That timeout matters: nginx defaults to dropping a connection after 60 s of read silence,
which would cut signalling mid-broadcast. The client then reconnects and the stream hiccups
every minute — another failure that reads as an app bug.

The browser connects to `wss://sfu.<domain>`; the Node app hands that URL to the client
alongside the token.

---

## The Node app

### Routes

| Route | Does |
|---|---|
| `GET /?k=<key>` | Verify key → set session cookie → **302 to `/`**, stripping the key from URL, history and referrer |
| `GET /` | Session → room page. No session → "paste your key" form |
| `POST /api/login` | Same check, for pasted keys |
| `POST /api/token` | Session → LiveKit JWT scoped to that person's role |
| `POST /api/logout` | Clear session |
| `GET /healthz` | Monitoring |

### Token grants — where the single-producer rule lives

```js
// server/src/token.js
const at = new AccessToken(API_KEY, API_SECRET, {
  identity: user.id, name: user.name, ttl: '10m',
});
at.addGrant({
  roomJoin: true,
  room: 'zoia',
  canPublish:     user.role === 'host',   // ← the entire security model
  canSubscribe:   true,
  canPublishData: false,
});
```

The short TTL gates only *joining*; once connected LiveKit maintains its own session, so
nobody is kicked mid-broadcast.

### Client behaviour (`public/app.js`)

Host — screen and audio in one call:
```js
const tracks = await room.localParticipant.createScreenTracks({ audio: true });
```
Published with settings tuned for text, not motion:
```js
{ videoEncoding: { maxBitrate: 2_500_000, maxFramerate: 15 },
  degradationPreference: 'maintain-resolution',
  videoCodec: 'vp9' }
```
plus `track.mediaStreamTrack.contentHint = 'text'`.

`maintain-resolution` is the one that matters. The default is to shed resolution under
pressure, which turns an IDE or a web page into unreadable mush; for desktop content you
want frame rate to sag instead. Sharing a spreadsheet at 10 fps and sharp beats 30 fps and
blurry every time.

Viewer — subscribe to the remote track, attach to `<video>`, show a "waiting for host" state
when nobody is publishing.

**Audio caveats to tell your users up front:** capturing system/tab audio works in **Chrome
and Edge on desktop only** — Firefox can't, Safari can't. Everyone can *listen* fine; this
only constrains who can host. On Windows the "share system audio" checkbox appears only when
sharing a tab or the whole screen, never a single window. Autoplay policy also means viewers
need one click before audio starts, so the page opens with a **Join** button rather than
auto-connecting.

---

## Security: per-person invite keys

Each person gets a 32-byte random key, stored **hashed** (argon2id) in `data/keys.json`:

```json
{ "id": "k_7f3a", "name": "Alice", "role": "viewer",
  "hash": "$argon2id$...", "createdAt": "...", "lastSeen": "...",
  "revoked": false, "expiresAt": null }
```

`keytool add --name Alice --role viewer` prints a one-time URL to send them:
`https://zoia.<domain>/?k=<key>`. They open it once; the cookie carries them after that. You
mint exactly one host key for yourself.

Why this rather than the single shared password you floated: **you can revoke one person.**
`keytool revoke k_7f3a` cuts Alice off without making everyone else learn a new passphrase,
and `lastSeen` tells you who is actually using their key. The key never crosses the wire in
cleartext (TLS), never lands in nginx or app logs (the redirect strips it), and 32 random
bytes aren't guessable.

Non-obvious requirements:

- **Re-validate the session against the key store on every request**, not just at login.
  Otherwise a revocation doesn't take effect until the cookie expires — which quietly makes
  revocation useless exactly when you need it.
- `express-rate-limit` at ~10 attempts/min/IP on the login routes.
- Cookies: `Secure`, `HttpOnly`, `SameSite=Lax`, signed, 30-day expiry.
- **Set `app.set('trust proxy', 1)`** — behind NPM every request otherwise appears to come
  from the proxy's IP, so rate limiting would throttle all your users as one client.

### If you later want stronger

The per-person key above *is* the practical form of your keyfile idea. Two genuinely
stronger options, both compatible with this design:

- **mTLS client certificates** — the literal keyfile. Issue each person a `.p12`; NPM
  rejects anyone without a valid cert, so unauthenticated traffic never reaches your app at
  all. Strongest available here. The cost is real: installing a client cert on an iPhone is
  a multi-step slog, and re-issuing when someone replaces a laptop falls to you. Worth it if
  the group is small, technical and stable.
- **Tailscale** — put the VM on your tailnet and open **zero** router ports. The app becomes
  unreachable from the public internet entirely, which beats any authentication scheme
  because the attack surface is gone rather than guarded. The cost is a VPN client on every
  viewer's machine. Best security-per-effort if your group tolerates it, and it layers
  cleanly on top of the invite keys.

Middle path if the group grows: Authelia or oauth2-proxy in front with a Google/GitHub
allowlist, so nobody holds a secret at all. Overkill for 15 people you know.

---

## Repository and conventions

`git init` on day one, branch `main`, commit as you go. The GitHub private repo doesn't
exist yet — create and attach it later with:

```bash
gh repo create zoia --private --source=. --remote=origin --push
```

Nothing in the plan depends on the remote existing, so local history starts immediately and
pushes cleanly once it does.

**Conventional Commits**, enforced by commitlint (hook locally via husky, and in CI so it
can't be bypassed). Types: `feat` `fix` `docs` `test` `ci` `build` `chore` `refactor`.
Scopes matching the layout: `auth` `api` `web` `livekit` `infra` `deploy` `docs`.

```
feat(auth): add argon2id invite-key store with revocation
fix(livekit): advertise external IP so remote ICE succeeds
docs(adr): record why invite keys beat a shared password
```

This isn't ceremony — it's what lets `git-cliff` or `release-please` generate a changelog
later without you writing one, and it makes the history readable to an agent picking the
project up cold months from now.

### AGENTS.md

The cross-tool standard, and the file that actually earns its keep here. `CLAUDE.md` is a
one-line pointer to it so both conventions resolve to the same content. It should carry:

- What the project is, and the architecture in a paragraph
- Commands: `npm test`, `npm run lint`, `./deploy.sh`, `keytool add|list|revoke`
- Layout and where things belong
- **Invariants stated as rules an agent must not break**, which is the part that matters:
  - Viewer tokens must never receive `canPublish` — change this and the security model is gone
  - Never log a raw invite key, anywhere
  - Never commit `.env`, `server/data/`, or keys in `livekit.yaml`
  - `deploy.sh` must keep excluding `server/data` — deleting it locks out every user
- The environment gotchas that cost hours: `use_external_ip`, grey-cloud DNS,
  `proxy_read_timeout`, Chrome/Edge-only audio capture

Write it early, not at the end. Its whole value is being there before the next session (or
the next agent) needs it.

---

## Testing

Runner: **`node:test`** (built into Node 20+) with `supertest`. Zero extra runtime deps for
a project this size.

**Unit — `token.test.js` is the important one.** Mint a viewer token, decode the JWT, assert
the grant contains `canPublish: false`; mint a host token and assert `true`. This is a
security regression test: if a refactor ever hands viewers publish rights, the suite fails
instead of you discovering it when someone paints over your screen share.

**Unit — `keys.test.js`:** hashing round-trips, wrong key rejected, revoked key rejected,
expired key rejected, verification is timing-safe.

**Integration — `routes.test.js`:** `GET /?k=<valid>` sets a cookie and 302s to `/` with the
key stripped; invalid and revoked keys land on the login form; `/api/token` refuses without a
session; rate limiting trips after N attempts; **no raw key appears in any log line** during
the run.

**E2E — worth it once, as a stretch:** Playwright with two browser contexts. Rather than
fighting headless `getDisplayMedia`, publish from the LiveKit CLI (`lk room join
--publish-demo`) and assert the viewer's `<video>` reaches non-zero dimensions and
`readyState > 2`. That covers the path the unit tests can't: token → connect → media flows.

What's deliberately *not* tested: LiveKit's own SFU behaviour, and NPM config. Those are
verified by hand once (see Verification) rather than mocked into a suite that would only
prove the mocks work.

---

## CI

`.github/workflows/ci.yml`, on push and PR:

| Job | Does |
|---|---|
| `lint` | ESLint + Prettier check |
| `test` | `node --test`, with coverage reported |
| `commitlint` | Conventional Commits on the PR's commits |
| `build` | `docker compose build` + `docker compose config` — catches a broken Dockerfile or compose file before it reaches the server |
| `gitleaks` | Secret scanning. Genuinely load-bearing here: the repo's whole risk is an API secret or invite key slipping into history |

Plus a `dependabot.yml` for npm and Actions.

**No CD.** The server sits behind home NAT with no inbound path from GitHub, so deploys stay
a manual `./deploy.sh`. A self-hosted runner on the VM could close that loop, but it means
GitHub-triggered code execution inside your LAN — not a trade worth making for a 15-viewer
app. Worth saying out loud so the absence reads as a decision rather than an omission.

---

## Delivery pipeline

`deploy.sh` in the repo root:

```bash
#!/usr/bin/env bash
set -euo pipefail
HOST="zoia@192.168.31.60"
DEST="/opt/zoia"

rsync -az --delete \
  --exclude node_modules --exclude .git \
  --exclude .env --exclude 'server/data' \
  ./ "$HOST:$DEST/"

ssh "$HOST" "cd $DEST && docker compose up -d --build && docker compose ps"
```

The two excludes carry the whole design: **`.env` and `server/data` live only on the
server.** Secrets never sit in the workspace, and `--delete` never wipes your invite-key
store — which would otherwise lock every user out on your next deploy, including you.

Set up an SSH key to `zoia@192.168.31.60` first so deploys are non-interactive.

---

## Build order

Each step ends in a commit, so history reads as the build sequence.

| # | Step | Commit |
|---|------|--------|
| 1 | `git init`, `.gitignore`, `.env.example`, ESLint/Prettier, commitlint + husky | `chore: scaffold repository and tooling` |
| 2 | `AGENTS.md`, `CLAUDE.md` pointer, `README`, `docs/` skeleton, the three ADRs, this plan as `docs/PLAN.md` | `docs: add agent guide, architecture and ADRs` |
| 3 | Move DNS to Cloudflare; `zoia` + `sfu` A records **grey cloud**; verify imported records survived | — |
| 4 | **Test LAN hairpin** against an existing NPM service. If a LAN machine gets the MiWiFi page, add the local DNS override now — the host PC depends on it | — |
| 5 | Provision `zoia-vm`; static IP; Docker + Compose; clean Proxmox snapshot | — |
| 6 | Forward 7881/TCP + 7882/UDP to the VM | — |
| 7 | `docker-compose.yml` + `livekit.yaml` (keys via env). Bring LiveKit up alone; add the `sfu.<domain>` proxy host with wildcard cert and long timeouts; confirm TLS | `feat(infra): add compose stack and livekit config` |
| 8 | Key store + `keytool` CLI, with unit tests | `feat(auth): add invite-key store and keytool CLI` |
| 9 | Login flow, session cookie, rate limiting, `trust proxy`; route tests. Add the `zoia.<domain>` proxy host | `feat(api): add invite-key login and sessions` |
| 10 | `/api/token` with role-dependent grants **+ the grant regression test** | `feat(api): mint role-scoped livekit tokens` |
| 11 | Room page: host publish path, viewer subscribe path, waiting state | `feat(web): add host and viewer room page` |
| 12 | CI workflow + dependabot | `ci: add lint, test, build and secret scanning` |
| 13 | Tune encoding against real content — an IDE and a text-heavy page, not a video | `fix(web): tune screen encoding for text legibility` |
| 14 | `docs/RUNBOOK.md`: deploy, mint/revoke keys, debug black video | `docs: add operations runbook` |
| 15 | `gh repo create zoia --private --source=. --push` | — |

Steps 1–2 before any application code is deliberate: the conventions and the agent guide
exist before there's code to be inconsistent about, which is the only time writing them is
cheap.

---

## Verification

**Connectivity**
- Open the URL from **cellular with Wi-Fi off**. This is the only test that proves the port
  forwards and `use_external_ip` are correct.
- Open it from a **LAN machine** too — this is the hairpin test, and the host PC's path.
- In `chrome://webrtc-internals` on a viewer, confirm the selected candidate pair is
  `srflx`/`host` over UDP. If everything lands on TCP 7881, UDP 7882 isn't reaching the VM
  and you're running on the fallback without knowing it.
- Leave a session idle 5+ minutes to confirm the nginx timeout fix holds signalling open.

**Roles — the test that matters most**
- In a viewer session, from the browser console, try
  `room.localParticipant.setMicrophoneEnabled(true)` and a `createScreenTracks()` publish.
  Both must be **rejected by the server**, not merely hidden by the UI. If either succeeds,
  the grant is wrong and the whole model is decorative.
- Confirm a second host-token client can't silently displace the first — decide the
  behaviour you want (reject the newcomer, or hand over) and test it.

**Access control**
- `keytool revoke` a test key, then reload that person's still-open tab: they should land on
  the login screen, proving sessions are re-checked per request.
- Hit `/` with no cookie and with a garbage `?k=` — both show only the login form.
- Grep the app and NPM logs afterwards to confirm **no raw key was ever written**.

**Quality and load**
- Share a full desktop with an IDE open and read the text from a viewer at full screen. This
  is the real acceptance test; fuzzy text means encoding settings, not network.
- Share a tab playing audio; confirm viewers hear it after their first click.
- Open 8–10 viewer tabs across a couple of machines and watch the VM's upstream throughput
  against the bandwidth table.

**Repository**
- `npm test` green locally and in CI; the viewer-token grant test fails if you temporarily
  flip `canPublish` to `true` — prove the test actually bites before trusting it.
- `gitleaks detect` clean against **full history**, not just the working tree, before the
  first push to GitHub. A secret committed and later removed is still in the history.
- Clone the repo fresh into a temp directory and confirm it contains no `.env`, no
  `server/data/`, and no API secret in `livekit.yaml`.
- Try a non-conventional commit message and confirm the hook rejects it.
