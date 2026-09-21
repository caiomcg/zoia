/**
 * Zoia browser client.
 *
 * One tier of user: everyone watches, anyone may claim the stage. Publish
 * rights are granted by the server only while the stage is free, and LiveKit
 * enforces them — claiming is a permission change, not a UI state.
 *
 * Audio and video are put on a single MediaStream attached to one <video>
 * element. LiveKit's own attach() would replace the element's stream per track,
 * which silently drops the audio; one stream also means the volume control,
 * mute and fullscreen behave as they do in any other player.
 */

import {
  LocalAudioTrack,
  LocalVideoTrack,
  Room,
  RoomEvent,
  Track,
} from './vendor/livekit-client.esm.mjs';

/**
 * Screen capture is done directly rather than through LiveKit's helper so the
 * Chrome-specific audio hints can be set. `systemAudio: 'include'` is the one
 * that matters: without it the picker is less likely to offer sound at all.
 *
 * There is no permission prompt for any of this. Screen and system audio are
 * granted by what the user picks in the browser's own share dialog, which is
 * why "share audio" is a checkbox there and not something the page can ask for.
 */
async function captureScreen() {
  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: {
      frameRate: { ideal: quality.maxFramerate, max: quality.maxFramerate },
      width: { ideal: quality.width },
      height: { ideal: quality.height },
    },
    audio: true,
    systemAudio: 'include',
    surfaceSwitching: 'include',
    monitorTypeSurfaces: 'include',
    selfBrowserSurface: 'exclude',
  });

  const [videoMst] = stream.getVideoTracks();
  const [audioMst] = stream.getAudioTracks();

  const tracks = [];
  if (videoMst) {
    videoMst.contentHint = 'detail';
    const track = new LocalVideoTrack(videoMst, undefined, false);
    track.source = Track.Source.ScreenShare;
    tracks.push(track);
  }
  if (audioMst) {
    const track = new LocalAudioTrack(audioMst, undefined, false);
    track.source = Track.Source.ScreenShareAudio;
    tracks.push(track);
  }
  return tracks;
}

const PUBLISH = {
  simulcast: false,
  degradationPreference: 'maintain-resolution',
};

let quality = {
  maxBitrate: 12_000_000,
  maxFramerate: 60,
  width: 1920,
  height: 1080,
  codec: 'h264',
};

const $ = (id) => document.getElementById(id);
const el = Object.fromEntries(
  [
    'login',
    'login-form',
    'key-input',
    'login-error',
    'room',
    'status',
    'whoami',
    'logout',
    'player',
    'video',
    'overlay',
    'overlay-title',
    'overlay-text',
    'overlay-action',
    'overlay-hint',
    'unmute',
    'controls',
    'live',
    'mute',
    'volume',
    'now-playing',
    'stats',
    'stats-toggle',
    'pip',
    'fullscreen',
    'people',
    'people-list',
    'people-toggle',
    'people-count',
    'share',
    'stop',
    'share-note',
    'no-audio',
    'no-audio-retry',
    'audio-source',
    'audio-permit',
    'toast',
  ].map((id) => [id.replace(/-(\w)/g, (_, c) => c.toUpperCase()), $(id)]),
);

/**
 * A missing element must not take the whole page down. Attaching a listener to
 * an undefined element throws at module scope, which leaves a blank screen and
 * no clue why — so listeners go through here, and anything missing is reported
 * loudly instead of fatally.
 */
const missing = Object.entries(el)
  .filter(([, node]) => !node)
  .map(([name]) => name);
if (missing.length > 0) console.error(`[zoia] missing elements: ${missing.join(', ')}`);

const on = (target, event, handler) => target?.addEventListener(event, handler);

let session = null;
let room = null;
let publishedTracks = [];
let broadcasting = false;
let connecting = false;
let statsTimer = null;

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

let toastTimer;
function toast(message) {
  el.toast.textContent = message;
  el.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.toast.hidden = true), 6000);
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

// ---------------------------------------------------------------------------
// the stream shown in the player
// ---------------------------------------------------------------------------

function remoteScreen() {
  for (const p of room?.remoteParticipants?.values() ?? []) {
    const video = p.getTrackPublication(Track.Source.ScreenShare);
    if (video?.track) {
      // Every audio track the broadcaster publishes, not only screen audio:
      // a microphone or a virtual cable arrives as Microphone.
      const audio = [Track.Source.ScreenShareAudio, Track.Source.Microphone]
        .map((src) => p.getTrackPublication(src)?.track)
        .filter(Boolean);
      return { participant: p, video: video.track, audio };
    }
  }
  return null;
}

/** Rebuilds the player's MediaStream from whatever should currently be shown. */
function updatePlayer() {
  const stream = new MediaStream();
  let hasAudio = false;
  let label = '';

  if (broadcasting) {
    for (const t of publishedTracks) {
      stream.addTrack(t.mediaStreamTrack);
      if (t.kind === Track.Kind.Audio) hasAudio = true;
    }
    label = 'Your screen';
    // Never play your own audio back at yourself.
    el.video.muted = true;
  } else {
    const remote = remoteScreen();
    if (remote) {
      stream.addTrack(remote.video.mediaStreamTrack);
      for (const track of remote.audio) {
        stream.addTrack(track.mediaStreamTrack);
        hasAudio = true;
      }
      label = `${remote.participant.name || remote.participant.identity} is broadcasting`;
      el.video.muted = false;
    }
  }

  if (stream.getTracks().length === 0) {
    el.video.srcObject = null;
    el.nowPlaying.textContent = '';
    return false;
  }

  el.video.srcObject = stream;
  el.nowPlaying.textContent = hasAudio ? label : `${label} · no audio`;
  el.video.play().catch(() => {
    // Autoplay with sound refused until the viewer interacts; render() decides
    // whether the unmute affordance is actually warranted.
    if (hasAudio && !broadcasting) el.unmute.hidden = false;
  });
  return true;
}

// ---------------------------------------------------------------------------
// render
// ---------------------------------------------------------------------------

function render() {
  try {
    if (!room) return;

    const showing = updatePlayer();

    el.overlay.hidden = showing;
    el.share.hidden = broadcasting;
    el.stop.hidden = !broadcasting;
    el.live.hidden = !showing;
    // The control bar stays put. Hiding it when idle took fullscreen and
    // volume away exactly when someone might reach for them.
    el.controls.classList.toggle('dim', !showing);

    // Only offer the unmute affordance when there is sound to unmute.
    const wantsAudio = showing && !broadcasting && el.video.srcObject?.getAudioTracks().length > 0;
    el.unmute.hidden = !wantsAudio || Boolean(room.canPlaybackAudio);

    if (broadcasting) setStatus('you are broadcasting', 'live');
    else if (showing) setStatus('watching', 'live');
    else {
      setStatus('idle');
      el.share.disabled = false;
      showOverlay({
        title: 'Nobody is broadcasting',
        text: 'Anyone here can share their screen — one at a time.',
      });
    }

    if (!showing) {
      el.player.classList.remove('idle');
      clearTimeout(idleTimer);
    }

    renderPeople();
  } catch (err) {
    // A silent render failure looks like a dead UI; make it visible instead.
    toast(`UI error: ${err?.message ?? err}`);
    console.error(err);
  }
}

function renderPeople() {
  const remote = remoteScreen();
  const people = [];

  if (room?.localParticipant) {
    people.push({ name: session?.name ?? 'You', you: true, live: broadcasting });
  }
  for (const p of room?.remoteParticipants?.values() ?? []) {
    people.push({
      name: p.name || p.identity,
      you: false,
      live: remote?.participant?.identity === p.identity,
    });
  }

  el.peopleCount.textContent = String(people.length);
  el.peopleList.replaceChildren(
    ...people.map((person) => {
      const li = document.createElement('li');
      const dot = document.createElement('span');
      dot.className = person.live ? 'dot live' : 'dot';
      const label = document.createElement('span');
      label.textContent = person.you ? `${person.name} (you)` : person.name;
      li.append(dot, label);
      if (person.live) {
        const tag = document.createElement('em');
        tag.textContent = 'broadcasting';
        li.append(tag);
      }
      return li;
    }),
  );
}

// ---------------------------------------------------------------------------
// quality stats — turns "it looks bad" into numbers
// ---------------------------------------------------------------------------

let lastBytes = 0;
let lastAt = 0;

async function sampleStats() {
  if (el.stats.hidden || !room) return;

  const pub = broadcasting
    ? room.localParticipant.getTrackPublication(Track.Source.ScreenShare)
    : remoteScreen()?.video?.sid
      ? null
      : null;

  const track = broadcasting ? pub?.track : remoteScreen()?.video;
  if (!track?.mediaStreamTrack) return;

  const settings = track.mediaStreamTrack.getSettings?.() ?? {};
  let line = `${settings.width ?? '?'}×${settings.height ?? '?'}`;

  try {
    const report = await track.getRTCStatsReport?.();
    let bytes = 0;
    let fps = null;
    let frameW = null;
    let frameH = null;
    report?.forEach((s) => {
      if (s.type === 'outbound-rtp' && s.kind === 'video') {
        bytes = s.bytesSent ?? bytes;
        fps = s.framesPerSecond ?? fps;
        frameW = s.frameWidth ?? frameW;
        frameH = s.frameHeight ?? frameH;
      }
      if (s.type === 'inbound-rtp' && s.kind === 'video') {
        bytes = s.bytesReceived ?? bytes;
        fps = s.framesPerSecond ?? fps;
        frameW = s.frameWidth ?? frameW;
        frameH = s.frameHeight ?? frameH;
      }
    });

    if (frameW) line = `${frameW}×${frameH}`;
    if (fps != null) line += ` @ ${Math.round(fps)}fps`;

    const now = performance.now();
    if (lastAt && bytes > lastBytes) {
      const mbps = ((bytes - lastBytes) * 8) / ((now - lastAt) / 1000) / 1e6;
      line += ` · ${mbps.toFixed(1)} Mbps`;
    }
    lastBytes = bytes;
    lastAt = now;
  } catch {
    // Stats are a diagnostic, never a reason to break playback.
  }

  el.stats.textContent = line;
}

// ---------------------------------------------------------------------------
// session
// ---------------------------------------------------------------------------

function showLogin(message) {
  el.room.hidden = true;
  el.login.hidden = false;
  if (message) {
    el.loginError.textContent = message;
    el.loginError.hidden = false;
  }
  el.keyInput.focus();
}

on(el.loginForm, 'submit', async (event) => {
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

on(el.logout, 'click', async () => {
  await stopBroadcast().catch(() => {});
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
    showLogin('Your access has ended. Ask for a new invite key.');
    return null;
  }
  if (!res.ok) throw new Error(`token request failed (${res.status})`);
  return res.json();
}

function wireRoomEvents() {
  const rerender = () => render();
  room
    .on(RoomEvent.TrackSubscribed, rerender)
    .on(RoomEvent.TrackUnsubscribed, rerender)
    .on(RoomEvent.TrackPublished, rerender)
    .on(RoomEvent.TrackUnpublished, rerender)
    .on(RoomEvent.LocalTrackPublished, rerender)
    .on(RoomEvent.LocalTrackUnpublished, rerender)
    .on(RoomEvent.ParticipantConnected, rerender)
    .on(RoomEvent.ParticipantDisconnected, rerender)
    .on(RoomEvent.ParticipantNameChanged, rerender)
    .on(RoomEvent.ConnectionStateChanged, rerender)
    .on(RoomEvent.Reconnecting, () => setStatus('reconnecting…'))
    .on(RoomEvent.Reconnected, rerender)
    .on(RoomEvent.AudioPlaybackStatusChanged, rerender)
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
      // Both would send fewer pixels when the viewer's element is small.
      adaptiveStream: false,
      dynacast: false,
    });
    wireRoomEvents();

    await room.connect(credentials.wsUrl, credentials.token);
    await room.startAudio().catch(() => {});
    render();
  } finally {
    connecting = false;
  }
}

// ---------------------------------------------------------------------------
// broadcasting
// ---------------------------------------------------------------------------

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

/**
 * The server grants publish rights over the LiveKit API; the client learns of it
 * moments later over signalling. Publishing in that gap fails with
 * "insufficient permissions", so wait for the permission to actually land.
 */
function waitForPublishPermission(timeoutMs = 10_000) {
  const granted = () => Boolean(room?.localParticipant?.permissions?.canPublish);
  if (granted()) return Promise.resolve(true);

  return new Promise((resolve) => {
    let timer;
    let poll;
    const finish = (ok) => {
      room.off(RoomEvent.ParticipantPermissionsChanged, onChange);
      clearTimeout(timer);
      clearInterval(poll);
      resolve(ok);
    };
    const onChange = () => granted() && finish(true);
    room.on(RoomEvent.ParticipantPermissionsChanged, onChange);
    poll = setInterval(onChange, 150);
    timer = setTimeout(() => finish(granted()), timeoutMs);
  });
}

// ---------------------------------------------------------------------------
// audio input: microphone, line-in, or a virtual cable carrying one app's sound
// ---------------------------------------------------------------------------

async function refreshAudioDevices() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const inputs = devices.filter((d) => d.kind === 'audioinput');
    const chosen = el.audioSource.value;

    el.audioSource.replaceChildren(
      new Option('No extra audio', ''),
      ...inputs.map((d, i) => new Option(d.label || `Input ${i + 1}`, d.deviceId)),
    );
    el.audioSource.value = inputs.some((d) => d.deviceId === chosen) ? chosen : '';

    // Labels are blank until permission has been granted once.
    el.audioPermit.hidden = inputs.some((d) => d.label);
  } catch {
    el.audioPermit.hidden = false;
  }
}

/** Captures the selected input. Returns null when none is chosen. */
async function captureAudioInput() {
  const deviceId = el.audioSource.value;
  if (!deviceId) return null;

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      deviceId: { exact: deviceId },
      // This is a media feed, not a voice call. Browser voice processing
      // would gate, duck and denoise the very thing being shared.
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    },
  });

  const [mst] = stream.getAudioTracks();
  if (!mst) return null;
  const track = new LocalAudioTrack(mst, undefined, false);
  track.source = Track.Source.Microphone;
  return track;
}

on(el.audioPermit, 'click', async () => {
  try {
    // Prompting is the only way to learn device labels.
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    for (const t of stream.getTracks()) t.stop();
    await refreshAudioDevices();
  } catch (err) {
    toast(`Microphone access refused: ${err?.message ?? err}`);
  }
});

on(el.audioSource, 'change', async () => {
  if (!broadcasting) return;
  // Swap the live input without interrupting the screen.
  const existing = publishedTracks.find((t) => t.source === Track.Source.Microphone);
  if (existing) {
    await room.localParticipant.unpublishTrack(existing, true).catch(() => {});
    publishedTracks = publishedTracks.filter((t) => t !== existing);
  }
  const track = await captureAudioInput().catch((err) => {
    toast(`Could not open that input: ${err?.message ?? err}`);
    return null;
  });
  if (track) {
    await room.localParticipant.publishTrack(track, {
      source: Track.Source.Microphone,
      stream: 'screen',
    });
    publishedTracks.push(track);
  }
  render();
});

async function startBroadcast() {
  if (!room) {
    toast('Join the room first.');
    return;
  }
  el.share.disabled = true;
  let claimed = false;

  try {
    const res = await fetch('/api/stage/claim', { method: 'POST' });
    if (res.status === 409) {
      const body = await res.json().catch(() => ({}));
      toast(`${body.holder?.name ?? 'Someone else'} is broadcasting. Only one at a time.`);
      return;
    }
    if (!res.ok) throw new Error(`could not claim the stage (${res.status})`);
    claimed = true;

    const tracks = await captureScreen();
    publishedTracks = tracks;

    const videoTrack = tracks.find((t) => t.kind === Track.Kind.Video);
    if (videoTrack) videoTrack.mediaStreamTrack.contentHint = 'detail';

    // Show your own screen before the network is involved.
    broadcasting = true;
    render();

    if (!(await waitForPublishPermission())) {
      throw new Error('the stage was granted but the permission never arrived');
    }

    for (const track of tracks) {
      const opts =
        track.kind === Track.Kind.Video
          ? { ...publishOptions(), source: Track.Source.ScreenShare }
          : { source: Track.Source.ScreenShareAudio };
      // Same stream name keeps audio and video synchronised for viewers.
      await room.localParticipant.publishTrack(track, { ...opts, stream: 'screen' });
    }

    // Whatever input the broadcaster picked rides along with the screen.
    const inputTrack = await captureAudioInput().catch(() => null);
    if (inputTrack) {
      await room.localParticipant.publishTrack(inputTrack, {
        source: Track.Source.Microphone,
        stream: 'screen',
      });
      publishedTracks.push(inputTrack);
    }

    const settings = videoTrack?.mediaStreamTrack?.getSettings?.() ?? {};
    const hasAudio = publishedTracks.some((t) => t.kind === Track.Kind.Audio);
    el.shareNote.textContent = hasAudio
      ? `Sharing ${settings.width}×${settings.height} with audio.`
      : '';
    // A toast disappears; missing audio should stay visible until it is fixed.
    el.noAudio.hidden = hasAudio;

    tracks[0]?.mediaStreamTrack.addEventListener('ended', () => stopBroadcast());
    render();
  } catch (err) {
    for (const t of publishedTracks) t.stop?.();
    publishedTracks = [];
    broadcasting = false;
    if (claimed) await fetch('/api/stage/release', { method: 'POST' }).catch(() => {});
    if (err?.name === 'NotAllowedError') toast('Screen sharing was cancelled.');
    else toast(`Could not start sharing: ${err?.message ?? err}`);
    render();
  } finally {
    el.share.disabled = false;
  }
}

async function stopBroadcast() {
  // Local state and the server release happen whatever unpublishing does, so a
  // failure there cannot leave the stage held with nobody broadcasting.
  try {
    for (const track of publishedTracks) {
      await room?.localParticipant.unpublishTrack(track, true).catch(() => {});
      track.stop?.();
    }
  } finally {
    publishedTracks = [];
    broadcasting = false;
    el.shareNote.textContent = '';
    el.video.srcObject = null;
    render();
    await fetch('/api/stage/release', { method: 'POST' }).catch(() => {});
  }
}

on(el.noAudioRetry, 'click', async () => {
  el.noAudio.hidden = true;
  await stopBroadcast();
  await startBroadcast();
});

on(el.share, 'click', startBroadcast);
on(el.stop, 'click', stopBroadcast);

// ---------------------------------------------------------------------------
// player controls
// ---------------------------------------------------------------------------

on(el.unmute, 'click', async () => {
  try {
    await room?.startAudio();
    el.video.muted = false;
    await el.video.play();
    el.unmute.hidden = true;
  } catch (err) {
    toast(`Could not start audio: ${err?.message ?? err}`);
  }
});

function syncVolumeUi() {
  const silent = el.video.muted || el.video.volume === 0;
  el.mute.classList.toggle('muted', silent);
  el.mute.setAttribute('aria-label', silent ? 'Unmute' : 'Mute');
  el.volume.value = String(el.video.muted ? 0 : el.video.volume);
}

on(el.mute, 'click', () => {
  el.video.muted = !el.video.muted;
  if (!el.video.muted && el.video.volume === 0) el.video.volume = 1;
  syncVolumeUi();
});

on(el.volume, 'input', () => {
  el.video.volume = Number(el.volume.value);
  el.video.muted = el.video.volume === 0;
  syncVolumeUi();
});

on(el.video, 'volumechange', syncVolumeUi);

async function toggleFullscreen() {
  if (document.fullscreenElement || document.webkitFullscreenElement) {
    await (document.exitFullscreen?.() ?? document.webkitExitFullscreen?.());
    return;
  }

  // Try the player first so the controls stay available, then the video, then
  // the iOS-only path. Report what actually failed rather than a blanket
  // "unavailable", which says nothing useful.
  const attempts = [
    ['player', () => el.player.requestFullscreen?.()],
    ['player (webkit)', () => el.player.webkitRequestFullscreen?.()],
    ['video', () => el.video.requestFullscreen?.()],
    ['video (ios)', () => el.video.webkitEnterFullscreen?.()],
  ];

  const errors = [];
  for (const [what, run] of attempts) {
    try {
      const result = run();
      if (result === undefined && !document.fullscreenElement) continue;
      await result;
      return;
    } catch (err) {
      errors.push(`${what}: ${err?.name ?? ''} ${err?.message ?? err}`.trim());
    }
  }

  toast(
    document.fullscreenEnabled === false
      ? 'This browser has fullscreen disabled for the page.'
      : `Fullscreen failed — ${errors[0] ?? 'no method available'}`,
  );
}

on(el.fullscreen, 'click', toggleFullscreen);
on(el.video, 'dblclick', toggleFullscreen);

on(el.pip, 'click', async () => {
  try {
    if (document.pictureInPictureElement) await document.exitPictureInPicture();
    else await el.video.requestPictureInPicture();
  } catch (err) {
    toast(`Picture-in-picture unavailable: ${err?.message ?? err}`);
  }
});

on(el.statsToggle, 'click', () => {
  el.stats.hidden = !el.stats.hidden;
  if (!el.stats.hidden) sampleStats();
});

document.addEventListener('keydown', (e) => {
  if (el.room.hidden || e.target !== document.body) return;
  if (e.key === 'f') toggleFullscreen();
  if (e.key === 'm') el.mute.click();
});

on(el.peopleToggle, 'click', () => {
  const open = el.people.hidden;
  el.people.hidden = !open;
  el.peopleToggle.setAttribute('aria-expanded', String(open));
});

/**
 * Auto-hide the control bar while the pointer is still — but only while
 * something is actually playing. Hiding it over an idle room left no way to
 * reach fullscreen or volume without knowing to waggle the mouse first.
 */
let idleTimer;
function wakeControls() {
  el.player.classList.remove('idle');
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    if (broadcasting || remoteScreen()) el.player.classList.add('idle');
  }, 3000);
}
on(el.player, 'mousemove', wakeControls);
on(el.player, 'touchstart', wakeControls, { passive: true });

// ---------------------------------------------------------------------------
// entry
// ---------------------------------------------------------------------------

async function enterRoom() {
  el.login.hidden = true;
  el.room.hidden = false;
  el.whoami.textContent = session.name;
  syncVolumeUi();

  // Open by default: "who else is here" is a primary question, not something
  // to go hunting for behind a toggle.
  el.people.hidden = false;
  el.peopleToggle.setAttribute('aria-expanded', 'true');

  if (!navigator.mediaDevices?.getDisplayMedia) {
    el.share.disabled = true;
    el.share.title = window.isSecureContext
      ? 'This browser cannot capture a screen. Use Chrome or Edge on a desktop.'
      : 'Screen capture needs HTTPS.';
  }

  // Connect straight away. Making people click through a modal before they can
  // see the room or who is in it was the wrong trade: the only thing a gesture
  // is actually needed for is audio, and that has its own affordance.
  showOverlay({ title: 'Connecting…', text: 'Joining the room.' });
  setStatus('connecting…');

  statsTimer ??= setInterval(sampleStats, 1000);
  wakeControls();
  refreshAudioDevices();
  navigator.mediaDevices?.addEventListener?.('devicechange', refreshAudioDevices);

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
}

async function main() {
  const params = new URLSearchParams(location.search);
  if (params.has('error')) history.replaceState(null, '', '/');

  session = await fetch('/api/session').then((r) => (r.ok ? r.json() : null));
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
