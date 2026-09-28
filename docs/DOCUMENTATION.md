# Zoia Technical Documentation

## 1. Overview and Engineering Intent

Zoia is an open-source, private, self-hosted screen broadcasting platform delivering sub-second latency (typically 200 to 500 milliseconds) for small groups and teams.

The project was created to address a fundamental architectural limitation present in modern web browsers and generic video conferencing tools: the inability to capture the isolated audio stream of a single application process on the Windows operating system.

### The Application Audio Problem in Browsers

Web browsers do not provide an API to isolate audio by process identifier (PID). Standard web capture APIs (`getDisplayMedia`) offer only two options:
1. Capture audio originating within a browser tab.
2. Capture the composite audio mix of the entire operating system.

Capturing the global system mix inevitably exposes personal notifications, background conversations in voice apps, and media player playback. Commercial platforms bypass this limitation only through proprietary desktop clients, while browser-based streaming forces silent screen sharing or complete mix leakage.

Zoia solves this by combining an Electron desktop application with low-level Win32 Windows Audio Session API (WASAPI) process loopback capture. The audio of the selected window is captured directly from its process, formatted as linear PCM S16LE at 48 kHz stereo, completely isolated from other applications on the host system.

### Core System Features

- Per-process audio isolation: audio capture locked strictly to the PID of the chosen application window.
- Claimable rotating stage model: any authenticated participant can claim a broadcast slot in the current channel without requiring administrative roles.
- Selective Forwarding Unit (SFU) topology: each broadcaster uploads a single media stream to the LiveKit SFU, which distributes raw RTP packets to subscribed viewers without performing server-side transcoding.
- Independent multi-channel support: up to 5 concurrent channels per deployment, each operating as an isolated LiveKit room with its own stage and permissions.
- Device-oriented security model: public application binaries contain no credentials or server addresses. Access is granted through individual invite files and stored locally using Windows DPAPI, with immediate per-request revocation validation on the server.
- Hardware-accelerated encoding and WHIP ingestion: optional direct GPU encoding (NVIDIA NVENC, AMD AMF, Intel Quick Sync) published via the WebRTC-HTTP Ingestion Protocol (WHIP) straight into the LiveKit SFU.
- Dynamic game window handoff: automated, bidirectional tracking for multi-process games (such as League of Legends), shifting video and audio between launcher and match windows seamlessly.

---

## 2. System Architecture

The architecture consists of three core operational layers:

```
  DESKTOP CLIENT (Windows)                           ZOIA SERVER
+---------------------------------+        +------------------------------+
|  Main Process (Node.js)         |        |  Caddy (TLS Edge Proxy)      |
|   |-- desktopCapturer (Windows) |        |    zoia.<domain> -> App      |
|   |-- node-window-manager (PID) |        |    sfu.<domain>  -> LiveKit  |
|   |-- WASAPI Loopback (PCM)     |        |    Certificates: DNS-01      |
|   \-- safeStorage (DPAPI)       |        +-------+--------------+-------+
|                                 |                |              |
|  Renderer Process (UI)          |                v              v
|   |-- React 19 + TypeScript     |            Node App        LiveKit
|   |-- AudioWorklet (Ring Buffer)|             :3000           :7880
|   \-- livekit-client (WebRTC)   |   WSS :443     |              |
+---------------------------------+ ---------------+              |
                 |                                                |
                 |              UDP :7882 (RTP Media Stream)      |
                 \----------------------------------------------->|
                                                                  |
  SUBSCRIBERS (Same Desktop App) <--------------------------------/
```

### Infrastructure Components

1. **Caddy (TLS Edge and Reverse Proxy)**:
   - Exposes public port 443 TCP.
   - Strictly terminates TLS for two configured domain names: the web application (`zoia.<domain>`) and SFU signaling (`sfu.<domain>`).
   - Automatically issues and renews wildcard certificates using the Cloudflare DNS-01 challenge. Port 80 HTTP remains closed to the internet.
   - Media traffic does not route through Caddy: WebRTC audio and video packets flow directly to the host machine and the LiveKit container.

2. **LiveKit SFU (Media Server)**:
   - Handles WebRTC media routing on port 7882 UDP (single-port mux) and port 7881 TCP (fallback).
   - Ingests incoming RTP streams and forwards them untouched to viewers.
   - Performs zero server-side video transcoding, keeping server CPU consumption minimal (typically below 5% to 10% during active multi-user broadcasts). Upstream network bandwidth on the server is the primary scaling factor.

3. **Node.js Backend (Application and Auth Controller)**:
   - Runs internally on port 3000, reachable only through the Caddy proxy.
   - Built on Express 5 using native ECMAScript Modules (ESM).
   - Handles device pairing, session validation, stage permission claims, LiveKit JWT generation, and crash report intake.
   - Utilizes atomic JSON storage with memory mutex locks and write-then-rename operations, avoiding database overhead for small-scale deployments.

4. **Desktop Application (Electron 44 + React 19 + TypeScript)**:
   - Target platform: Windows x64.
   - Built with modern React 19, functional components, and native support for English, Spanish, and Portuguese.
   - Houses a native C++ module for Win32 and DirectX 11 integrations.

---

## 3. Technical Implementation Details

### Audio Subsystem (WASAPI Process Loopback)

Process-isolated audio is the foundational feature of the application. Audio capture executes in the Electron main process and streams to the renderer through IPC:

```
WASAPI loopback           Main Process                     Audio Format
 (Window PID)      -->   src/main/audio.ts   -->   S16LE 48 kHz stereo
                                                            |
                                                            | IPC Channel
                                                            v
  MediaStreamTrack  <--   AudioWorklet (Ring Buffer) <--   Renderer
    (Published)               pcm-worklet.js
```

1. **OS-Level Capture**:
   The native `loopback-capture` library opens a WASAPI loopback session targeted at the PID of the chosen window. Audio is extracted as uncompressed PCM (Signed 16-bit Little Endian) locked at a sample rate of 48 kHz stereo.

2. **Sample Rate Pinning**:
   The web renderer initializes its `AudioContext` with `sampleRate: 48000`. By matching WASAPI's fixed native rate, Chromium does not insert a software resampler, eliminating a major source of audio drift during extended streaming sessions.

3. **AudioWorklet Ring Buffer (`pcm-worklet.js`)**:
   Audio processing runs on a dedicated Web Audio thread. A custom ring buffer manages IPC transfer jitter:
   - Priming cushion: retains initial frames upon startup to absorb transmission jitter.
   - Latency ceiling: if the sender machine experiences temporary processing lag, the worklet systematically discards oldest frames to enforce a bounded audio-video offset, preventing latency from accumulating over time.

4. **Screen Share Audio Invariant**:
   When a user shares an entire desktop display rather than an individual application window, audio capture is intentionally disabled. A desktop display does not belong to a single process; the only possible audio would be the global OS mix, which violates the privacy principle of the application.

### Video Subsystem and Hardware Encoding (WHIP and WGC)

Chromium on Windows does not provide hardware-accelerated video encoding for WebRTC (measured through profiling, not assumed). When sharing high-resolution content (1080p60 or 4K), software encoding on the CPU can cause performance degradation during intensive gaming.

Zoia provides an alternative GPU pipeline:

```
Target Application Window
     |
     v (Windows Graphics Capture - WGC)
D3D11 Texture in GPU Memory
     |
     v (Hardware Encoding)
NVIDIA (NVENC) / AMD (AMF) / Intel (Quick Sync)
     |
     v (Compressed H.264 Stream)
Bundled FFmpeg Process
     |
     v (HTTPS POST / WHIP Protocol)
Caddy (sfu.<domain>/whip/v1)
     |
     v (Internal Port 7880)
LiveKit SFU --> UDP 7882 Forwarding to Room Subscribers
```

#### GPU Pipeline Stability Measures (ADR 0024)

Broadcasting from gaming rigs revealed several critical stability challenges that required dedicated safeguards:

- **Source Framerate Throttling**:
  Windows Graphics Capture generates frames on presentation events. In games running at 144 Hz, 240 Hz, or with unlocked framerates, WGC delivered hundreds of frames per second. Uncompressed BGRA frames (~8.3 MB per frame at 1080p) flooded the Node.js V8 heap, causing severe Garbage Collection pauses and freezing the application interface. The native C++ module (`addon.cpp`) introduces a hardware-level frame drop: any frame arriving earlier than `(1000 / targetFps) - 2 ms` is discarded immediately in DirectX 11 before memory copying.

- **Backpressure Frame Dropping**:
  If the internal FFmpeg process slows its consumption of `stdin`, uncompressed buffers are discarded immediately to protect memory usage. For pre-compressed NVENC streams, NAL packets are maintained to prevent corrupting GOP reference structures.

- **Atomic Software Fallback**:
  If GPU initialization or WHIP negotiation fails during broadcast startup, the client switches transparently to CPU window capture while retaining its reserved stage slot, avoiding stream disruption or user-facing crashes.

### Dynamic Multi-Process Tracking: League of Legends

Games such as League of Legends execute across separate processes for the client lobby and the active match:
- The lobby and champion selection screen run under Chromium Embedded Framework via `LeagueClientUx.exe`.
- The gameplay match executes inside `League of Legends.exe`.

The `league.ts` module in the desktop client handles this automatically:
1. When League of Legends is selected, the application monitors both executables.
2. When the game match starts, video capture and WASAPI audio switch automatically to the match window (`League of Legends.exe`).
3. When the match concludes and the game window terminates, the system enters a 7.5-second grace window while the post-game lobby window reinitializes, resuming capture and audio without dropping the live stream.

---

## 4. Security and Access Model

Zoia uses a zero-trust model for media publishing, avoiding traditional username-password management while guaranteeing immediate access control.

### Fundamental Security Invariants

1. **Tokens Join Subscribe-Only**:
   Every JWT minted by `/api/token` is issued with `canPublish: false`. No connecting user has permission to publish media upon joining.

2. **Server-Side Stage Elevation**:
   Publishing rights are granted strictly by the backend server calling the LiveKit Server SDK (`updateParticipant`) upon a successful stage claim. Client-side tampering with local JavaScript cannot bypass this, as LiveKit validates packet authorization at the protocol level.

3. **Derived Broadcast State**:
   Broadcast slot occupancy is derived dynamically from LiveKit's active participant list rather than tracked in static memory variables. If a broadcaster abruptly disconnects or closes their device, the slot is released automatically.

4. **Inert Distribution Binaries**:
   The compiled Windows installer contains zero hardcoded keys and no default server endpoint. The binary can be distributed publicly without exposing infrastructure secrets.

### Device Pairing Workflow

```
Administrator                        New User                          Zoia Server
     |                                    |                                  |
     |  keytool pair:new                  |                                  |
     +----------------------------------->|                                  |
     |  (Outputs zoia-invite.json)        |                                  |
     |                                    |  Drag invite file into app       |
     |                                    +--------------------------------->| POST /api/pair
     |                                    |                                  | (Consumes activation)
     |                                    |<---------------------------------+ Returns device
     |                                    |                                  | credential
     |                                    |  Saved to Windows DPAPI          |
     |                                    |                                  |
     |                                    |  App launch session request      |
     |                                    +--------------------------------->| POST /api/device/session
     |                                    |<---------------------------------+ Signed cookie
     |                                    |                                  | zoia_sid (device:<id>)
```

1. The server administrator issues an invitation file (`zoia-invite.json`) with an activation cap (`--max-activations`).
2. The invite contains the server URL and a single-use pairing token (`zpair_...`).
3. The user opens the app and imports the invite file, which posts the token to `/api/pair`.
4. The server validates the token, registers a new device entry, and returns a high-entropy 256-bit credential.
5. The desktop client stores this credential in the OS secure storage via Electron `safeStorage` (Windows DPAPI).
6. Future launches authenticate via `/api/device/session`, receiving a signed session cookie holding only the device identifier (`device:<id>`).

### Immediate Revocation

Because session cookies contain only identifiers and the backend re-validates the ID against storage on every incoming HTTP request:
- Revoking a device on the server terminates access on the subsequent HTTP request, without waiting for cookie expiration.
- Two levels of control are available:
  1. Pairing token revocation (`pair:revoke`): blocks new device pairings while leaving already paired machines intact.
  2. Device revocation (`device:revoke`): instantly severs access for a specific machine.

---

## 5. Server Deployment and Operations

### Prerequisites

- Linux server (Ubuntu 22.04 LTS or newer), 2 vCPUs and 2 GB RAM minimum.
- Docker Engine with Docker Compose v2+.
- Domain managed on Cloudflare (required for automated DNS-01 TLS validation).
- Public IPv4 address (static or dynamically updated).
- Firewall and router port forwarding rules directed to the host:
  - `443` TCP: Caddy unified HTTPS and WSS entry point.
  - `7882` UDP: LiveKit WebRTC media transport (essential).
  - `7881` TCP: LiveKit WebRTC fallback transport.

### Step 1: Cloudflare DNS Setup

Create two `A` records pointing to your server's public IP address:
- `zoia.yourdomain.com`
- `sfu.yourdomain.com`

**Critical Rule**: set both records to **DNS Only (Grey Cloud)**. Cloudflare CDN proxying (Orange Cloud) does not proxy UDP WebRTC packets and introduces latency to WebSocket connections.

### Step 2: Cloudflare API Token

Generate an API token in Cloudflare:
1. Navigate to: *My Profile > API Tokens > Create Token*.
2. Select the *Edit zone DNS* template.
3. Set permissions to: `Zone > DNS > Edit`.
4. Scope resource access to your specific domain zone.
5. Save the generated token value.

### Step 3: Server Configuration

Clone the repository to your host:

```bash
git clone https://github.com/caiomcg/zoia.git /opt/zoia
cd /opt/zoia
```

Generate the initial `.env` file using the configuration script:

```bash
./scripts/gen-env.sh zoia.yourdomain.com sfu.yourdomain.com > .env
chmod 600 .env
```

Edit `.env` and assign your Cloudflare API token:

```ini
CLOUDFLARE_API_TOKEN=your_token_here
```

### Step 4: Container Startup

Launch the stack using Docker Compose:

```bash
docker compose up -d
```

Run the preflight diagnostic check:

```bash
bash scripts/preflight.sh
```

The script will confirm DNS resolution, certificate issuance, and container health.

### Step 5: Generating Invites

Generate an invite file for users:

```bash
docker compose exec app node server/bin/keytool.js \
  pair:new --name "team" --max-activations 5 --invite zoia-invite.json
```

Securely deliver the generated `zoia-invite.json` file to the intended participants.

---

## 6. Desktop Client Usage Guide

### Requirements

- Operating System: Windows 10 or Windows 11 (64-bit).
- Standard WASAPI-compatible sound output device.

### Initial Setup

1. Download the latest installer (`Zoia-Setup-x.x.x-x64.exe`) from the GitHub Releases page.
2. Run the installer (confirm the initial Windows SmartScreen notice if prompted).
3. Drag the `zoia-invite.json` file directly into the application window.
4. The client will complete the pairing exchange and store the credentials in Windows DPAPI.

### Broadcasting Content

1. Select a channel from the sidebar.
2. Click the broadcast action button to open the source picker.
3. Select your desired input:
   - **Application Window**: captures visual window contents and isolated audio for that specific process.
   - **Entire Screen**: captures the full desktop visual without audio (preserving private notifications).
   - **Camera**: publishes webcam video alongside your chosen microphone with live level metering.
4. For supported multi-process games (such as League of Legends), click the dedicated "Transmit LoL" banner to enable automated window and audio handoff.

### Viewing Streams

- Multiple participants can broadcast concurrently within the same channel.
- Each viewer chooses which stream to enlarge or focus.
- To prevent conflicting audio playback, only one remote audio stream is active by default. Viewers can adjust individual stream volumes or switch audio focus via controls on each stream tile.

---

## 7. Administrative CLI Reference (Keytool)

Manage server authorizations using `server/bin/keytool.js`:

```bash
# List all active pairing invites and activation seat counts
docker compose exec app node server/bin/keytool.js pair:list

# Create a new pairing invite with an activation limit
docker compose exec app node server/bin/keytool.js pair:new --name "CoreTeam" --max-activations 3 --invite invite.json

# Revoke a pairing invite (prevents further activations)
docker compose exec app node server/bin/keytool.js pair:revoke <pairingId>

# List all paired devices along with their last active timestamp (lastSeen)
docker compose exec app node server/bin/keytool.js device:list

# Instantly revoke access for a specific device
docker compose exec app node server/bin/keytool.js device:revoke <deviceId>
```

---

## 8. Engineering Highlights for Portfolio and LinkedIn

When discussing Zoia in technical publications or portfolio reviews, emphasize these architectural solutions:

1. **Resolving the Per-Process Audio Limitation**:
   - How integrating Win32 WASAPI process loopback with an Electron AudioWorklet overcame web sandbox constraints to achieve pure, application-isolated audio capture.

2. **Real-Time Media Topology (SFU vs Mesh)**:
   - Mathematical justification for choosing SFU packet routing over P2P mesh: keeping broadcaster upload bandwidth constant at 1 stream while enabling multiple viewers without server-side transcoding costs.

3. **Zero-Trust Media Authorization**:
   - The security boundary design where join tokens are strictly subscribe-only, requiring explicit server-side elevation to prevent client-side authorization bypass.

4. **Mitigating V8 Heap Pressure During High-Framerate Capture**:
   - Techniques for managing memory backpressure in Node.js when ingesting 144Hz to 240Hz frame rates from Windows Graphics Capture, using temporal frame throttling in C++ and DirectX 11.

5. **Lean Production Architecture**:
   - How combining Caddy DNS-01 automation, Docker Compose isolation, and atomic file persistence achieved reliable operations without the maintenance footprint of external databases.
