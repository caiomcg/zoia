/**
 * Zoia browser client.
 *
 * One tier of user: everyone watches, anyone may claim the stage. Publish
 * rights are granted by the server only while the stage is free, and LiveKit
 * enforces them — claiming is not a UI state, it is a permission change.
 */

import { Room, RoomEvent, Track, createLocalScreenTracks } from './vendor/livekit-client.esm.mjs';

/**
 * Capture settings. LiveKit caps screen capture at 1080p unless a resolution is
 * given, so this asks for 2160p60 and lets the browser hand back whatever the
 * display actually is.
 */
let quality = {
  maxBitrate: 20_000_000,
  maxFramerate: 60,
  width: 3840,
  height: 2160,
  codec: 'vp9',
};

function captureOptions() {
  return {
    ...CAPTURE,
    resolution: { width: quality.width, height: quality.height, frameRate: quality.maxFramerate },
  };
}

function publishOptions() {
  const encoding = {
    maxBitrate: quality.maxBitrate,
    maxFramerate: quality.maxFramerate,
    priority: 'high',
  };
  return {
    ...PUBLISH,
    screenShareEncoding: encoding,
    videoEncoding: encoding,
    videoCodec: quality.codec,
  };
}

const CAPTURE = {
  video: true,
  // Browser voice processing is tuned for microphones and mangles music and
  // video soundtracks. Off, for system audio that sounds like the source.
  audio: {
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
  },
};

/**
 * Publish settings, tuned for legibility at high resolution. `screenShareEncoding`
 * is the field that applies to a screen-share source; `videoEncoding` is set to
 * the same values so nothing falls back to a default.
 */
const PUBLISH = {
  // Simulcast splits the budget across layers; a single high-quality stream is
  // the point here.
  simulcast: false,
  // Shed frame rate before resolution: blurry text is worse than fewer frames.
  degradationPreference: 'maintain-resolution',
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
  logout: $('logout'),
  stage: $('stage'),
  video: $('video'),
  remoteAudio: $('remote-audio'),
  overlay: $('overlay'),
  overlayTitle: $('overlay-title'),
  overlayText: $('overlay-text'),
  overlayAction: $('overlay-action'),
  overlayHint: $('overlay-hint'),
  unmute: $('unmute'),
  people: $('people'),
  peopleList: $('people-list'),
  peopleToggle: $('people-toggle'),
  peopleCount: $('people-count'),
  share: $('share'),
  stop: $('stop'),
  fullscreen: $('fullscreen'),
  shareNote: $('share-note'),
  toast: $('toast'),
};

let session = null;
let room = null;
let publishedTracks = [];
let broadcasting = false;
let connecting = false;

// ---------------------------------------------------------------------------
// ui helpers
// ---------------------------------------------------------------------------

let toastTimer;
function toast(message) {
  el.toast.textContent = message;
  el.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.toast.hidden = true;
  }, 6000);
}

function setStatus(text, state = '') {
  el.status.textContent = text;
  if (state) el.status.dataset.state = state;
  else delete el.status.dataset.state;
}

// ---------------------------------------------------------------------------
// state → view. One place decides what the stage shows, so "waiting for a
// broadcast" can never appear over your own screen share.
// ---------------------------------------------------------------------------

function remoteScreenPublication() {
  for (const participant of room?.remoteParticipants?.values() ?? []) {
    const pub = participant.getTrackPublication(Track.Source.ScreenShare);
    if (pub?.track) return { participant, track: pub.track };
  }
  return null;
}

function render() {
  if (!room) return;

  const remote = remoteScreenPublication();
  const showingSomething = broadcasting || Boolean(remote);

  el.overlay.hidden = showingSomething;
  el.share.hidden = broadcasting;
  el.stop.hidden = !broadcasting;

  if (broadcasting) {
    setStatus('you are broadcasting', 'live');
  } else if (remote) {
    setStatus(`${remote.participant.name || remote.participant.identity} is broadcasting`, 'live');
  } else {
    setStatus('idle');
    el.share.disabled = false;
    showOverlay({
      title: 'Nobody is broadcasting',
      text: 'Start broadcasting to share your screen with everyone here.',
    });
  }

  renderPeople(remote);
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

function renderPeople(remote) {
  const people = [];
  if (room?.localParticipant) {
    people.push({
      name: session.name,
      you: true,
      broadcasting,
    });
  }
  for (const p of room?.remoteParticipants?.values() ?? []) {
    people.push({
      name: p.name || p.identity,
      you: false,
      broadcasting: remote?.participant?.identity === p.identity,
    });
  }

  el.peopleCount.textContent = String(people.length);
  el.peopleList.replaceChildren(
    ...people.map((person) => {
      const li = document.createElement('li');
      const dot = document.createElement('span');
      dot.className = person.broadcasting ? 'dot live' : 'dot';
      const label = document.createElement('span');
      label.textContent = person.you ? `${person.name} (you)` : person.name;
      li.append(dot, label);
      if (person.broadcasting) {
        const tag = document.createElement('em');
        tag.textContent = 'broadcasting';
        li.append(tag);
      }
      return li;
    }),
  );
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
  await stopBroadcast().catch(() => {});
  await room?.disconnect();
  await fetch('/api/logout', { method: 'POST' });
  location.replace('/');
});

// ---------------------------------------------------------------------------
// media
// ---------------------------------------------------------------------------

function attachTrack(track) {
  if (track.kind === Track.Kind.Video) {
    track.attach(el.video);
    el.video.muted = true; // the video element carries no audio; see below
  } else if (track.kind === Track.Kind.Audio) {
    // Audio gets its own element. Attaching it to the video element would
    // replace that element's stream and the picture would go with it.
    track.attach(el.remoteAudio);
    el.remoteAudio.muted = false;
    el.remoteAudio.volume = 1;
    el.remoteAudio.play().catch(() => {
      // Autoplay refused until the viewer interacts.
      el.unmute.hidden = false;
    });
  }
  render();
}

function detachTrack(track) {
  track.detach(el.video);
  track.detach(el.remoteAudio);
  render();
}

el.unmute.addEventListener('click', async () => {
  try {
    await room?.startAudio();
    await el.remoteAudio.play();
    el.unmute.hidden = true;
  } catch (err) {
    toast(`Could not start audio: ${err?.message ?? err}`);
  }
});

// ---------------------------------------------------------------------------
// room
// ---------------------------------------------------------------------------

async function fetchToken() {
  const res = await fetch('/api/token', { method: 'POST' });
  if (res.status === 401) {
    showLogin('Your access has ended. Ask for a new invite key.');
    return null;
  }
  if (!res.ok) throw new Error(`token request failed (${res.status})`);
  return res.json();
}

function wireRoomEvents() {
  room
    .on(RoomEvent.TrackSubscribed, attachTrack)
    .on(RoomEvent.TrackUnsubscribed, detachTrack)
    .on(RoomEvent.ParticipantConnected, render)
    .on(RoomEvent.ParticipantDisconnected, render)
    .on(RoomEvent.TrackPublished, render)
    .on(RoomEvent.TrackUnpublished, render)
    .on(RoomEvent.LocalTrackPublished, render)
    .on(RoomEvent.LocalTrackUnpublished, render)
    .on(RoomEvent.Reconnecting, () => setStatus('reconnecting…'))
    .on(RoomEvent.Reconnected, render)
    .on(RoomEvent.AudioPlaybackStatusChanged, () => {
      el.unmute.hidden = room.canPlaybackAudio;
    })
    .on(RoomEvent.Disconnected, (reason) => {
      broadcasting = false;
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
  if (connecting) return;
  connecting = true;
  try {
    const credentials = await fetchToken();
    if (!credentials) return;
    if (credentials.quality) quality = { ...quality, ...credentials.quality };

    setStatus('connecting…');
    room = new Room({
      // Both of these trade quality for bandwidth by sending fewer pixels when
      // the viewer's element is small. This deployment wants full quality.
      adaptiveStream: false,
      dynacast: false,
    });
    wireRoomEvents();

    await room.connect(credentials.wsUrl, credentials.token);
    await room.startAudio().catch(() => {});

    // Pick up anything already being broadcast.
    const existing = remoteScreenPublication();
    if (existing) attachTrack(existing.track);
    for (const p of room.remoteParticipants.values()) {
      const audio = p.getTrackPublication(Track.Source.ScreenShareAudio);
      if (audio?.track) attachTrack(audio.track);
    }
    render();
  } finally {
    connecting = false;
  }
}

// ---------------------------------------------------------------------------
// broadcasting
// ---------------------------------------------------------------------------

async function startBroadcast() {
  el.share.disabled = true;
  let claimed = false;

  try {
    // Ask the server for publish rights first. If someone else holds the stage
    // this fails before the browser ever prompts for a screen.
    const res = await fetch('/api/stage/claim', { method: 'POST' });
    if (res.status === 409) {
      const body = await res.json().catch(() => ({}));
      toast(`${body.holder?.name ?? 'Someone else'} is broadcasting. Only one at a time.`);
      return;
    }
    if (!res.ok) throw new Error(`could not claim the stage (${res.status})`);
    claimed = true;

    const tracks = await createLocalScreenTracks(captureOptions());

    for (const track of tracks) {
      if (track.kind === Track.Kind.Video) {
        // Tells the encoder to preserve sharp edges over smooth motion.
        track.mediaStreamTrack.contentHint = 'detail';
        await room.localParticipant.publishTrack(track, publishOptions());
        track.attach(el.video);
      } else {
        await room.localParticipant.publishTrack(track, { audioPreset: undefined });
      }
    }

    publishedTracks = tracks;
    broadcasting = true;

    const settings = tracks
      .find((t) => t.kind === Track.Kind.Video)
      ?.mediaStreamTrack?.getSettings?.();
    const sharedAudio = tracks.some((t) => t.kind === Track.Kind.Audio);
    el.shareNote.textContent = [
      settings
        ? `${settings.width}×${settings.height} @ ${Math.round(settings.frameRate ?? 0)}fps`
        : '',
      sharedAudio ? 'audio on' : 'no audio — tick “share audio” in the picker',
    ]
      .filter(Boolean)
      .join(' · ');

    // The browser's own "Stop sharing" bar ends the track behind our back.
    tracks[0]?.mediaStreamTrack.addEventListener('ended', () => stopBroadcast());

    render();
  } catch (err) {
    if (claimed) await fetch('/api/stage/release', { method: 'POST' }).catch(() => {});
    if (err?.name === 'NotAllowedError') toast('Screen sharing was cancelled.');
    else toast(`Could not start sharing: ${err?.message ?? err}`);
  } finally {
    el.share.disabled = false;
    render();
  }
}

async function stopBroadcast() {
  for (const track of publishedTracks) {
    await room?.localParticipant.unpublishTrack(track, true).catch(() => {});
  }
  publishedTracks = [];
  broadcasting = false;
  el.video.srcObject = null;
  el.shareNote.textContent = '';
  await fetch('/api/stage/release', { method: 'POST' }).catch(() => {});
  render();
}

el.share.addEventListener('click', startBroadcast);
el.stop.addEventListener('click', stopBroadcast);

// ---------------------------------------------------------------------------
// fullscreen and people panel
// ---------------------------------------------------------------------------

async function toggleFullscreen() {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await el.stage.requestFullscreen({ navigationUI: 'hide' });
  } catch (err) {
    toast(`Fullscreen unavailable: ${err?.message ?? err}`);
  }
}

el.fullscreen.addEventListener('click', toggleFullscreen);
el.video.addEventListener('dblclick', toggleFullscreen);
document.addEventListener('keydown', (e) => {
  if (e.key === 'f' && !el.room.hidden && e.target === document.body) toggleFullscreen();
});

el.peopleToggle.addEventListener('click', () => {
  const open = el.people.hidden;
  el.people.hidden = !open;
  el.peopleToggle.setAttribute('aria-expanded', String(open));
});

// ---------------------------------------------------------------------------
// entry
// ---------------------------------------------------------------------------

async function enterRoom() {
  el.login.hidden = true;
  el.room.hidden = false;
  el.whoami.textContent = session.name;

  if (!navigator.mediaDevices?.getDisplayMedia) {
    el.share.disabled = true;
    el.share.title = window.isSecureContext
      ? 'This browser cannot capture a screen. Use Chrome or Edge on a desktop.'
      : 'Screen capture needs HTTPS.';
  }

  showOverlay({
    title: 'Join the room',
    text: 'Audio needs a click before it can start.',
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
  if (params.has('error')) history.replaceState(null, '', '/');

  session = await loadSession();
  if (!session) {
    showLogin(params.get('error') === 'invalid_key' ? 'That invite key was not accepted.' : '');
    return;
  }
  await enterRoom();
}

window.addEventListener('pagehide', () => {
  if (broadcasting) navigator.sendBeacon?.('/api/stage/release');
});

main().catch((err) => showLogin(`Something went wrong: ${err?.message ?? err}`));
