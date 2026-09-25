/**
 * Zoia spectator.
 *
 * Signs in with an invite key, joins the room, and plays whoever is on the
 * stage. Publishing is impossible here: the token is subscribe-only, and this
 * file never claims the stage or opens a capture device. Sharing stays in
 * the desktop app.
 *
 * Audio and video go on one MediaStream attached to one <video>. LiveKit's
 * attach() replaces the element's stream per track, which drops the audio.
 */

import { Room, RoomEvent, Track } from './vendor/livekit-client.esm.mjs';

const $ = (id) => document.getElementById(id);

const el = {
  login: $('login'),
  loginForm: $('login-form'),
  nameInput: $('name-input'),
  loginError: $('login-error'),
  room: $('room'),
  status: $('status'),
  whoami: $('whoami'),
  logout: $('logout'),
  player: $('player'),
  video: $('video'),
  overlay: $('overlay'),
  overlayTitle: $('overlay-title'),
  overlayText: $('overlay-text'),
  overlayAction: $('overlay-action'),
  unmute: $('unmute'),
  mute: $('mute'),
  volume: $('volume'),
  nowPlaying: $('now-playing'),
  fullscreen: $('fullscreen'),
  toast: $('toast'),
};

let session = null;
let room = null;
let connecting = false;
let leaving = false;
let soundOn = false;
let currentStreamKey = '';
let idleTimer = 0;
let toastTimer = 0;

function toast(message) {
  el.toast.textContent = message;
  el.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.toast.hidden = true;
  }, 4000);
}

function setStatus(text, kind = '') {
  el.status.textContent = text;
  el.status.className = `pill${kind ? ` ${kind}` : ''}`;
}

function showOverlay({ title, text = '', action = null, onAction = null }) {
  el.overlay.hidden = false;
  el.overlayTitle.textContent = title;
  el.overlayText.textContent = text;
  el.overlayAction.hidden = !action;
  el.overlayAction.textContent = action ?? '';
  el.overlayAction.onclick = action
    ? () => {
        el.overlayAction.onclick = null;
        onAction?.();
      }
    : null;
}

function hideOverlay() {
  el.overlay.hidden = true;
  el.overlayAction.onclick = null;
}

/**
 * The desktop app publishes two ways. The in-app path is a screen share. The
 * hardware path is a LiveKit ingress, which joins as "<identity>-nvenc" and
 * publishes a camera and a microphone, because WHIP has no screen-share
 * source. A viewer that only looks for ScreenShare shows black for that path.
 */
function findRemote() {
  if (!room) return null;

  for (const participant of room.remoteParticipants.values()) {
    const videoPub =
      participant.getTrackPublication(Track.Source.ScreenShare) ??
      [...participant.videoTrackPublications.values()].find((pub) => pub.track);
    if (!videoPub?.track) continue;

    const audioPub =
      participant.getTrackPublication(Track.Source.ScreenShareAudio) ??
      participant.getTrackPublication(Track.Source.Microphone) ??
      [...participant.audioTrackPublications.values()].find((pub) => pub.track);

    const ownerId = participant.identity.replace(/-nvenc$/, '');
    const owner =
      ownerId === participant.identity
        ? participant
        : ([...room.remoteParticipants.values()].find((p) => p.identity === ownerId) ??
          participant);

    return {
      name: owner.name || owner.identity,
      video: videoPub.track,
      audio: audioPub?.track ?? null,
    };
  }
  return null;
}

function updatePlayer() {
  const remote = findRemote();
  const tracks = [];
  if (remote) {
    tracks.push(remote.video.mediaStreamTrack);
    if (remote.audio) tracks.push(remote.audio.mediaStreamTrack);
  }

  const key = tracks
    .map((track) => track.id)
    .sort()
    .join('|');

  if (key !== currentStreamKey) {
    currentStreamKey = key;
    if (tracks.length === 0) {
      el.video.srcObject = null;
    } else {
      // Stay muted until a tap. iOS will not start a stream that has sound
      // without a gesture, and a rejected play() takes the picture with it.
      el.video.muted = !soundOn;
      el.video.srcObject = new MediaStream(tracks);
      el.video.play().catch(() => {
        soundOn = false;
        el.video.muted = true;
      });
    }
  }

  const hasAudio = Boolean(remote?.audio);
  el.unmute.hidden = !remote || !hasAudio || soundOn;
  el.nowPlaying.textContent = remote
    ? hasAudio
      ? `${remote.name} is sharing`
      : `${remote.name} is sharing · no audio`
    : '';

  if (remote) {
    hideOverlay();
    setStatus('live', 'live');
    return;
  }

  if (room?.state === 'connected') {
    showOverlay({
      title: 'Waiting',
      text: 'Nobody is sharing right now.',
    });
    setStatus('waiting');
  }
}

function render() {
  if (!room || leaving) return;
  updatePlayer();
}

async function holdWakeLock() {
  if (!navigator.wakeLock) return;
  try {
    await navigator.wakeLock.request('screen');
  } catch {
    // Refused outside a user gesture, or missing on older iOS.
  }
}

function showLogin(message) {
  el.room.hidden = true;
  el.login.hidden = false;
  if (message) {
    el.loginError.textContent = message;
    el.loginError.hidden = false;
  } else {
    el.loginError.hidden = true;
  }
  el.nameInput.focus();
}

function pairError(body) {
  switch (body.error) {
    case 'too_many_attempts':
      return 'Too many attempts. Wait a minute and try again.';
    case 'exhausted':
      return 'This token has no activations left.';
    case 'device_name_required':
      return 'A name is required.';
    default:
      return 'That token was not accepted.';
  }
}

el.loginForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = el.loginForm.querySelector('button');
  button.disabled = true;
  el.loginError.hidden = true;
  const deviceName = el.nameInput.value.trim();
  try {
    const res = await fetch('/api/spectator/join', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ deviceName }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      showLogin(pairError(body));
      return;
    }
    session = body;
    await enterRoom();
  } catch {
    showLogin('Could not reach the server. Check your connection and try again.');
  } finally {
    button.disabled = false;
  }
});

el.logout.addEventListener('click', async () => {
  leaving = true;
  await room?.disconnect();
  room = null;
  await fetch('/api/logout', { method: 'POST' });
  location.replace('/spectator');
});

async function fetchToken() {
  const res = await fetch('/api/token', { method: 'POST' });
  if (res.status === 401) {
    showLogin('Your access has ended. Pair again to continue.');
    return null;
  }
  if (!res.ok) throw new Error(`token request failed (${res.status})`);
  return res.json();
}

function wireRoomEvents() {
  room
    .on(RoomEvent.TrackSubscribed, render)
    .on(RoomEvent.TrackUnsubscribed, render)
    .on(RoomEvent.TrackPublished, render)
    .on(RoomEvent.TrackUnpublished, render)
    .on(RoomEvent.ParticipantConnected, render)
    .on(RoomEvent.ParticipantDisconnected, render)
    .on(RoomEvent.ParticipantNameChanged, render)
    .on(RoomEvent.Reconnecting, () => setStatus('reconnecting…'))
    .on(RoomEvent.Reconnected, render)
    .on(RoomEvent.Disconnected, () => {
      if (leaving) return;
      currentStreamKey = '';
      setStatus('disconnected', 'error');
      showOverlay({
        title: 'Disconnected',
        text: 'The connection ended.',
        action: 'Reconnect',
        onAction: () => connect(),
      });
    });
}

async function connect() {
  if (connecting) return;
  connecting = true;
  try {
    const credentials = await fetchToken();
    if (!credentials) return;

    setStatus('connecting…');
    showOverlay({ title: 'Connecting…', text: 'Joining the room.' });

    await room?.disconnect();
    currentStreamKey = '';
    room = new Room({ adaptiveStream: false, dynacast: false });
    wireRoomEvents();
    await room.connect(credentials.wsUrl, credentials.token);
    render();
  } catch (err) {
    setStatus('error', 'error');
    showOverlay({
      title: 'Could not connect',
      text: err?.message ?? String(err),
      action: 'Try again',
      onAction: () => connect(),
    });
  } finally {
    connecting = false;
  }
}

function syncVolumeUi() {
  const silent = el.video.muted || el.video.volume === 0;
  el.mute.classList.toggle('muted', silent);
  el.mute.setAttribute('aria-label', silent ? 'Unmute' : 'Mute');
  el.volume.value = String(el.video.muted ? 0 : el.video.volume);
}

el.mute.addEventListener('click', async () => {
  if (el.video.muted) {
    soundOn = true;
    el.video.muted = false;
    if (el.video.volume === 0) el.video.volume = 1;
    await room?.startAudio().catch(() => {});
    await el.video.play().catch(() => {});
    el.unmute.hidden = true;
    await holdWakeLock();
  } else {
    soundOn = false;
    el.video.muted = true;
  }
  syncVolumeUi();
});

el.volume.addEventListener('input', () => {
  el.video.volume = Number(el.volume.value);
  soundOn = el.video.volume > 0;
  el.video.muted = !soundOn;
  syncVolumeUi();
  if (soundOn) el.unmute.hidden = true;
});

el.unmute.addEventListener('click', async () => {
  soundOn = true;
  el.video.muted = false;
  el.unmute.hidden = true;
  await room?.startAudio().catch(() => {});
  await el.video.play().catch(() => {
    soundOn = false;
    el.video.muted = true;
    el.unmute.hidden = false;
  });
  syncVolumeUi();
  await holdWakeLock();
});

async function toggleFullscreen() {
  if (document.fullscreenElement || document.webkitFullscreenElement) {
    await (document.exitFullscreen?.() ?? document.webkitExitFullscreen?.());
    return;
  }

  const attempts = [
    () => el.player.requestFullscreen?.(),
    () => el.video.requestFullscreen?.(),
    () => el.video.webkitEnterFullscreen?.(),
  ];

  for (const run of attempts) {
    try {
      const result = run();
      if (result === undefined && !document.fullscreenElement) continue;
      await result;
      return;
    } catch {
      // Try the next path. iOS only implements the video-element one.
    }
  }
  toast('Fullscreen is not available in this browser.');
}

el.fullscreen.addEventListener('click', () => toggleFullscreen());
el.video.addEventListener('dblclick', () => toggleFullscreen());

function wakeControls() {
  el.player.classList.remove('idle');
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    if (findRemote()) el.player.classList.add('idle');
  }, 3000);
}

el.player.addEventListener('pointermove', wakeControls);
el.player.addEventListener('pointerdown', wakeControls);

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && !el.room.hidden) holdWakeLock();
});

async function enterRoom() {
  leaving = false;
  el.login.hidden = true;
  el.room.hidden = false;
  el.whoami.textContent = session.name ?? '';
  syncVolumeUi();
  wakeControls();
  await connect();
}

async function main() {
  session = await fetch('/api/session').then((res) => (res.ok ? res.json() : null));
  if (!session) {
    showLogin('');
    return;
  }
  await enterRoom();
}

main().catch((err) => showLogin(`Something went wrong: ${err?.message ?? err}`));
