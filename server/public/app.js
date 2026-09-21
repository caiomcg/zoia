/**
 * Zoia browser client.
 *
 * Two roles, one page. A host publishes a screen-share track; everyone else
 * subscribes to it. The role comes from the server with the token — nothing
 * here decides it, and changing it here would achieve nothing, because LiveKit
 * validates the grant server-side.
 */

import { Room, RoomEvent, Track, createLocalScreenTracks } from './vendor/livekit-client.esm.mjs';

/** Screen content is mostly text. These settings are chosen for legibility. */
const SCREEN_PUBLISH_OPTIONS = {
  videoEncoding: { maxBitrate: 2_500_000, maxFramerate: 15 },
  // Shed frame rate, never resolution. The default does the opposite, which
  // turns an IDE or a spreadsheet into unreadable mush under load.
  degradationPreference: 'maintain-resolution',
  videoCodec: 'vp9',
  simulcast: false,
};

const $ = (id) => document.getElementById(id);
const el = {
  login: $('login'),
  loginForm: $('login-form'),
  keyInput: $('key-input'),
  loginError: $('login-error'),
  room: $('room'),
  status: $('status'),
  whoami: $('whoami'),
  viewers: $('viewers'),
  logout: $('logout'),
  video: $('video'),
  overlay: $('overlay'),
  overlayTitle: $('overlay-title'),
  overlayText: $('overlay-text'),
  overlayAction: $('overlay-action'),
  overlayHint: $('overlay-hint'),
  controls: $('controls'),
  share: $('share'),
  stop: $('stop'),
  shareNote: $('share-note'),
  toast: $('toast'),
};

let session = null;
let room = null;
let publishedTracks = [];

// ---------------------------------------------------------------------------
// small ui helpers
// ---------------------------------------------------------------------------

let toastTimer;
function toast(message) {
  el.toast.textContent = message;
  el.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.toast.hidden = true;
  }, 5000);
}

function setStatus(text, state = '') {
  el.status.textContent = text;
  if (state) el.status.dataset.state = state;
  else delete el.status.dataset.state;
}

function showOverlay({ title, text = '', action = null, onAction = null, hint = '' }) {
  el.overlayTitle.textContent = title;
  el.overlayText.textContent = text;
  el.overlayHint.textContent = hint;
  el.overlayHint.hidden = !hint;

  el.overlayAction.hidden = !action;
  if (action) {
    el.overlayAction.textContent = action;
    el.overlayAction.disabled = false;
    el.overlayAction.onclick = onAction;
  }
  el.overlay.hidden = false;
}

function hideOverlay() {
  el.overlay.hidden = true;
}

// ---------------------------------------------------------------------------
// session
// ---------------------------------------------------------------------------

async function loadSession() {
  const res = await fetch('/api/session');
  return res.ok ? res.json() : null;
}

function showLogin(message) {
  el.room.hidden = true;
  el.login.hidden = false;
  if (message) {
    el.loginError.textContent = message;
    el.loginError.hidden = false;
  }
  el.keyInput.focus();
}

el.loginForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = el.loginForm.querySelector('button');
  button.disabled = true;
  el.loginError.hidden = true;

  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: el.keyInput.value.trim() }),
    });

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      showLogin(
        body.error === 'too_many_attempts'
          ? 'Too many attempts. Wait a minute and try again.'
          : 'That key was not accepted. Check it, or ask for a new one.',
      );
      return;
    }

    el.keyInput.value = '';
    session = await res.json();
    await enterRoom();
  } catch {
    showLogin('Could not reach the server. Check your connection and try again.');
  } finally {
    button.disabled = false;
  }
});

el.logout.addEventListener('click', async () => {
  await room?.disconnect();
  await fetch('/api/logout', { method: 'POST' });
  location.replace('/');
});

// ---------------------------------------------------------------------------
// room
// ---------------------------------------------------------------------------

async function fetchToken() {
  const res = await fetch('/api/token', { method: 'POST' });
  if (res.status === 401) {
    // The key was revoked, or the session expired, while the page was open.
    showLogin('Your access has ended. Ask for a new invite key.');
    return null;
  }
  if (!res.ok) throw new Error(`token request failed (${res.status})`);
  return res.json();
}

/** Attaches a remote screen-share track to the stage. */
function attachTrack(track) {
  if (track.kind === Track.Kind.Video) {
    track.attach(el.video);
    hideOverlay();
    setStatus('live', 'live');
  } else if (track.kind === Track.Kind.Audio) {
    // Audio rides the same element so a single user gesture unlocks both.
    track.attach(el.video);
  }
}

function remoteScreenTrack() {
  for (const participant of room?.remoteParticipants?.values() ?? []) {
    const pub = participant.getTrackPublication(Track.Source.ScreenShare);
    if (pub?.track) return pub.track;
  }
  return null;
}

function updateViewerCount() {
  if (session?.role !== 'host' || !room) return;
  const count = room.remoteParticipants.size;
  el.viewers.hidden = false;
  el.viewers.textContent = count === 1 ? '1 viewer' : `${count} viewers`;
}

function showWaiting() {
  el.video.srcObject = null;
  showOverlay({
    title: 'Waiting for the broadcast',
    text: 'The stream will appear here as soon as the host starts sharing.',
  });
  setStatus('waiting');
}

function wireRoomEvents() {
  room
    .on(RoomEvent.TrackSubscribed, (track) => attachTrack(track))
    .on(RoomEvent.TrackUnsubscribed, (track) => {
      track.detach(el.video);
      if (!remoteScreenTrack()) showWaiting();
    })
    .on(RoomEvent.ParticipantConnected, updateViewerCount)
    .on(RoomEvent.ParticipantDisconnected, updateViewerCount)
    .on(RoomEvent.Reconnecting, () => setStatus('reconnecting…'))
    .on(RoomEvent.Reconnected, () => setStatus(remoteScreenTrack() ? 'live' : 'waiting', 'live'))
    .on(RoomEvent.Disconnected, (reason) => {
      setStatus('disconnected', 'error');
      showOverlay({
        title: 'Disconnected',
        text: reason ? `The connection ended (${reason}).` : 'The connection ended.',
        action: 'Reconnect',
        onAction: () => connect(),
      });
    })
    .on(RoomEvent.MediaDevicesError, (err) => toast(`Media error: ${err.message}`));
}

async function connect() {
  const credentials = await fetchToken();
  if (!credentials) return;

  setStatus('connecting…');
  room = new Room({ adaptiveStream: true, dynacast: true });
  wireRoomEvents();

  await room.connect(credentials.wsUrl, credentials.token);

  // Browsers block audio until a user gesture; connect() is always reached
  // from a click, so this is the moment it is allowed to succeed.
  await room.startAudio().catch(() => {});

  updateViewerCount();

  const existing = remoteScreenTrack();
  if (existing) attachTrack(existing);
  else if (session.role === 'host') hideOverlay();
  else showWaiting();
}

// ---------------------------------------------------------------------------
// broadcasting (host only)
// ---------------------------------------------------------------------------

async function startBroadcast() {
  el.share.disabled = true;
  try {
    const tracks = await createLocalScreenTracks({ audio: true });

    for (const track of tracks) {
      if (track.kind === Track.Kind.Video) {
        // Tells the encoder to preserve sharp edges over smooth motion.
        track.mediaStreamTrack.contentHint = 'text';
        await room.localParticipant.publishTrack(track, SCREEN_PUBLISH_OPTIONS);
        track.attach(el.video);
      } else {
        await room.localParticipant.publishTrack(track);
      }
    }

    publishedTracks = tracks;
    hideOverlay();
    setStatus('broadcasting', 'live');
    el.share.hidden = true;
    el.stop.hidden = false;

    const sharedAudio = tracks.some((t) => t.kind === Track.Kind.Audio);
    el.shareNote.textContent = sharedAudio
      ? 'Sharing screen and audio.'
      : 'Sharing screen only — tick “share audio” in the picker to include sound.';

    // The browser's own "Stop sharing" bar ends the track behind our back.
    tracks[0]?.mediaStreamTrack.addEventListener('ended', () => stopBroadcast());
  } catch (err) {
    if (err?.name === 'NotAllowedError') {
      toast('Screen sharing was cancelled.');
    } else {
      toast(`Could not start sharing: ${err?.message ?? err}`);
    }
  } finally {
    el.share.disabled = false;
  }
}

async function stopBroadcast() {
  for (const track of publishedTracks) {
    await room?.localParticipant.unpublishTrack(track, true);
  }
  publishedTracks = [];
  el.video.srcObject = null;
  el.share.hidden = false;
  el.stop.hidden = true;
  el.shareNote.textContent = '';
  setStatus('idle');
  showOverlay({
    title: 'Ready when you are',
    text: 'Start a broadcast to share your screen with everyone connected.',
  });
}

el.share.addEventListener('click', startBroadcast);
el.stop.addEventListener('click', stopBroadcast);

// ---------------------------------------------------------------------------
// entry
// ---------------------------------------------------------------------------

function canCaptureScreen() {
  return Boolean(navigator.mediaDevices?.getDisplayMedia);
}

async function enterRoom() {
  el.login.hidden = true;
  el.room.hidden = false;
  el.whoami.textContent = `${session.name} · ${session.role}`;

  if (session.role === 'host') {
    if (!canCaptureScreen()) {
      // Almost always the real cause: an insecure origin.
      showOverlay({
        title: 'Screen capture unavailable',
        text: 'This browser will not allow screen capture on this page.',
        hint: window.isSecureContext
          ? 'Use Chrome or Edge on a desktop to broadcast.'
          : 'The page must be served over HTTPS for screen capture to be possible.',
      });
      setStatus('unsupported', 'error');
      return;
    }

    el.controls.hidden = false;
    showOverlay({
      title: 'Ready when you are',
      text: 'Start a broadcast to share your screen with everyone connected.',
      action: 'Start broadcast',
      onAction: async () => {
        el.overlayAction.disabled = true;
        await connect();
        await startBroadcast();
      },
      hint: 'Audio capture needs Chrome or Edge on desktop, and is offered for a tab or a whole screen — not a single window.',
    });
    setStatus('idle');
    return;
  }

  // Viewers join on a click: browsers refuse to start audio without a gesture.
  showOverlay({
    title: 'Join the broadcast',
    action: 'Join',
    onAction: async () => {
      el.overlayAction.disabled = true;
      try {
        await connect();
      } catch (err) {
        showOverlay({
          title: 'Could not connect',
          text: err?.message ?? String(err),
          action: 'Try again',
          onAction: () => connect(),
        });
        setStatus('error', 'error');
      }
    },
  });
  setStatus('ready');
}

async function main() {
  const params = new URLSearchParams(location.search);
  if (params.has('error')) {
    history.replaceState(null, '', '/');
  }

  session = await loadSession();
  if (!session) {
    showLogin(params.get('error') === 'invalid_key' ? 'That invite key was not accepted.' : '');
    return;
  }
  await enterRoom();
}

main().catch((err) => {
  showLogin(`Something went wrong: ${err?.message ?? err}`);
});
