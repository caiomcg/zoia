import { Room, RoomEvent, Track } from 'https://cdn.jsdelivr.net/npm/livekit-client@2.22.3/+esm';

const WHIP_SUFFIX = '-gpu';
const state = {
  room: null,
  selected: new Set(),
  audioOwner: null,
  volumes: new Map(),
  broadcasters: new Map(),
  qualityMode: 'auto',
  focusedId: null,
  audioOnly: new Set(),
  noticeTimer: null,
};

const $ = (id) => document.getElementById(id);
const ownerIdentity = (identity) =>
  identity.endsWith(WHIP_SUFFIX) ? identity.slice(0, -WHIP_SUFFIX.length) : identity;

function broadcastMetadata(participant) {
  try {
    const value = JSON.parse(participant.metadata || '');
    return {
      sourceName:
        typeof value.sourceName === 'string' && value.sourceName ? value.sourceName : null,
      sourceKind: ['screen', 'window', 'camera'].includes(value.sourceKind)
        ? value.sourceKind
        : null,
    };
  } catch {
    return { sourceName: null, sourceKind: null };
  }
}

function sourceLabel(person) {
  if (!person.sourceName) return null;
  const kind =
    person.sourceKind === 'window' ? 'Janela' : person.sourceKind === 'screen' ? 'Tela' : '';
  return kind ? `${kind}: ${person.sourceName}` : person.sourceName;
}

async function request(path, options) {
  const response = await fetch(path, { credentials: 'same-origin', ...options });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    const error = new Error(body.error || `Request failed (${response.status})`);
    error.status = response.status;
    throw error;
  }
  return response.json();
}

function showScreen(name) {
  $('login-screen').hidden = name !== 'login';
  $('loading-screen').hidden = name !== 'loading';
  $('room-screen').hidden = name !== 'room';
}

function showMessage(message, persistent = false) {
  const element = $('room-message');
  element.textContent = message;
  element.hidden = false;
  clearTimeout(state.noticeTimer);
  if (!persistent) state.noticeTimer = setTimeout(() => (element.hidden = true), 5000);
}

function setConnection(message, warning = false) {
  const element = $('connection-status');
  element.textContent = message;
  element.classList.toggle('warn', warning);
}

function participantForOwner(ownerId) {
  if (state.room.localParticipant.identity === ownerId) return state.room.localParticipant;
  return state.room.remoteParticipants.get(ownerId);
}

function videoPublication(participant) {
  return (
    participant.getTrackPublication(Track.Source.ScreenShare) ??
    [...participant.videoTrackPublications.values()].find((publication) => publication)
  );
}

function applyMediaSettings() {
  for (const participant of state.room.remoteParticipants.values()) {
    const identity = ownerIdentity(participant.identity);
    const subscribed = state.selected.has(identity);
    const videoSubscribed = subscribed && !state.audioOnly.has(identity);
    const low = state.qualityMode === 'low' || (state.focusedId && state.focusedId !== identity);
    for (const publication of participant.videoTrackPublications.values()) {
      publication.setSubscribed(videoSubscribed);
      publication.setVideoQuality(low ? 0 : 2);
    }
    for (const publication of participant.audioTrackPublications.values()) {
      publication.setSubscribed(subscribed);
    }
  }
}

function refreshBroadcasters() {
  const next = new Map();
  for (const participant of state.room.remoteParticipants.values()) {
    const video = videoPublication(participant);
    if (!video) continue;
    const ownerId = ownerIdentity(participant.identity);
    const owner = participantForOwner(ownerId) ?? participant;
    if (!next.has(ownerId)) {
      const metadata = broadcastMetadata(participant);
      const ownerMetadata = broadcastMetadata(owner);
      next.set(ownerId, {
        id: ownerId,
        name: owner.name || ownerId,
        sourceName: metadata.sourceName ?? ownerMetadata.sourceName,
        sourceKind: metadata.sourceKind ?? ownerMetadata.sourceKind,
      });
    }
  }
  state.broadcasters = next;
  for (const id of state.selected) if (!next.has(id)) state.selected.delete(id);
  renderSidebar();
  renderGrid();
}

function publicationsFor(ownerId) {
  const candidates = [ownerId, `${ownerId}${WHIP_SUFFIX}`]
    .map((id) => state.room.remoteParticipants.get(id))
    .filter(Boolean);
  const result = { video: null, audio: null };
  for (const participant of candidates) {
    result.video ??= videoPublication(participant);
    result.audio ??=
      participant.getTrackPublication(Track.Source.ScreenShareAudio) ??
      [...participant.audioTrackPublications.values()].find((publication) => publication);
  }
  return result;
}

function setSubscribed(identity, subscribed) {
  if (subscribed) state.selected.add(identity);
  else state.selected.delete(identity);
  applyMediaSettings();
  renderSidebar();
  renderGrid();
}

function renderSidebar() {
  const list = $('live-list');
  list.replaceChildren();
  $('no-live').hidden = state.broadcasters.size > 0;
  const watching = [...state.selected].filter((id) => state.broadcasters.has(id)).length;
  $('watching-count').textContent = `Assistindo ${watching} de ${state.broadcasters.size}`;
  for (const person of state.broadcasters.values()) {
    const row = document.createElement('div');
    row.className = 'live-person';
    const dot = document.createElement('span');
    dot.className = 'live-dot';
    const name = document.createElement('span');
    name.className = 'person-name';
    name.textContent = person.name;
    const source = document.createElement('small');
    source.className = 'person-source';
    source.textContent = sourceLabel(person) ?? '';
    const button = document.createElement('button');
    const watchingThis = state.selected.has(person.id);
    button.className = `watch-button${watchingThis ? ' active' : ''}`;
    button.textContent = watchingThis ? 'Parar' : 'Assistir';
    button.ariaPressed = String(watchingThis);
    button.addEventListener('click', () =>
      setSubscribed(person.id, !state.selected.has(person.id)),
    );
    row.append(dot, name, source, button);
    list.append(row);
  }
}

function renderGrid() {
  const grid = $('grid');
  const current = new Map();
  for (const identity of state.selected) {
    const publications = publicationsFor(identity);
    if (publications.video?.track || publications.audio?.track) current.set(identity, publications);
  }
  grid.replaceChildren();
  if (current.size === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    const title = document.createElement('h1');
    title.textContent = state.selected.size ? 'Carregando transmissão…' : 'Escolha uma transmissão';
    const text = document.createElement('p');
    text.className = 'muted';
    text.textContent = state.selected.size
      ? 'A pessoa está transmitindo, mas o vídeo ainda está carregando.'
      : 'Selecione uma ou mais pessoas na lista ao lado.';
    empty.append(title, text);
    grid.append(empty);
    return;
  }
  const toolbar = document.createElement('div');
  toolbar.className = 'grid-toolbar';
  const notice = document.createElement('span');
  notice.textContent = `${current.size} ${current.size === 1 ? 'stream ativa' : 'streams ativas'}${current.size > 1 ? ' · maior consumo de banda' : ''}`;
  const quality = document.createElement('select');
  for (const [value, label] of [
    ['auto', 'Automática'],
    ['low', 'Baixa'],
  ]) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    quality.append(option);
  }
  quality.value = state.qualityMode;
  quality.addEventListener('change', () => {
    state.qualityMode = quality.value;
    applyMediaSettings();
  });
  const qualityLabel = document.createElement('label');
  qualityLabel.append('Qualidade', quality);
  toolbar.append(notice, qualityLabel);
  grid.append(toolbar);
  for (const [identity, publications] of current) {
    const tile = document.createElement('article');
    const audioOnly = state.audioOnly.has(identity);
    tile.className = `tile${audioOnly ? ' audio-only' : ''}`;
    const video = document.createElement('video');
    video.autoplay = true;
    video.playsInline = true;
    const tracks = publications.video?.track ? [publications.video.track.mediaStreamTrack] : [];
    if (publications.audio?.track) tracks.push(publications.audio.track.mediaStreamTrack);
    video.srcObject = new MediaStream(tracks);
    const audioActive = state.audioOwner === identity;
    video.muted = !audioActive;
    video.volume = audioActive ? (state.volumes.get(identity) ?? 1) : 0;
    const footer = document.createElement('div');
    footer.className = 'tile-footer';
    const name = document.createElement('span');
    const person = state.broadcasters.get(identity);
    name.textContent = person?.name ?? identity;
    const source = document.createElement('small');
    source.className = 'tile-source';
    source.textContent = person ? (sourceLabel(person) ?? '') : '';
    const identityLabel = document.createElement('span');
    identityLabel.append(name, source);
    footer.append(identityLabel);
    const tileActions = document.createElement('div');
    tileActions.className = 'tile-actions';
    const focusButton = document.createElement('button');
    focusButton.className = state.focusedId === identity ? 'active' : '';
    focusButton.textContent = state.focusedId === identity ? 'Foco ativo' : 'Focar';
    focusButton.addEventListener('click', () => {
      state.focusedId = state.focusedId === identity ? null : identity;
      applyMediaSettings();
      renderGrid();
    });
    tileActions.append(focusButton);
    if (publications.audio?.track) {
      const audioOnlyButton = document.createElement('button');
      audioOnlyButton.textContent = audioOnly ? 'Vídeo' : 'Somente áudio';
      audioOnlyButton.addEventListener('click', () => {
        if (audioOnly) state.audioOnly.delete(identity);
        else state.audioOnly.add(identity);
        applyMediaSettings();
        renderGrid();
      });
      tileActions.append(audioOnlyButton);
    }
    footer.append(tileActions);
    if (publications.audio?.track) {
      const controls = document.createElement('div');
      controls.className = 'audio-controls';
      const audioButton = document.createElement('button');
      audioButton.textContent = audioActive ? 'Silenciar' : 'Ativar áudio';
      audioButton.addEventListener('click', () => {
        state.audioOwner = audioActive ? null : identity;
        renderGrid();
      });
      const volume = document.createElement('input');
      volume.className = 'volume';
      volume.type = 'range';
      volume.min = '0';
      volume.max = '1';
      volume.step = '0.01';
      volume.value = String(state.volumes.get(identity) ?? 1);
      volume.ariaLabel = `Volume de ${name.textContent}`;
      volume.addEventListener('input', () => {
        state.volumes.set(identity, Number(volume.value));
        video.volume = Number(volume.value);
      });
      controls.append(audioButton, volume);
      footer.append(controls);
    }
    tile.append(video, footer);
    grid.append(tile);
  }
}

async function connect() {
  const token = await request('/api/token', { method: 'POST' });
  state.room = new Room({ adaptiveStream: true, dynacast: true });
  state.room
    .on(RoomEvent.ParticipantConnected, refreshBroadcasters)
    .on(RoomEvent.ParticipantDisconnected, (participant) => {
      const name = participant.name || participant.identity;
      refreshBroadcasters();
      showMessage(`${name} saiu da sala`);
    })
    .on(RoomEvent.TrackSubscribed, refreshBroadcasters)
    .on(RoomEvent.TrackUnsubscribed, refreshBroadcasters)
    .on(RoomEvent.ParticipantMetadataChanged, refreshBroadcasters)
    .on(RoomEvent.Reconnecting, () => setConnection('Reconectando…', true))
    .on(RoomEvent.Reconnected, () => {
      setConnection('Conectado');
      refreshBroadcasters();
      applyMediaSettings();
    })
    .on(RoomEvent.Disconnected, () => setConnection('Desconectado', true));
  await state.room.connect(token.wsUrl, token.token);
  setConnection('Conectado');
  refreshBroadcasters();
  for (const person of state.broadcasters.values()) state.selected.add(person.id);
  applyMediaSettings();
  renderSidebar();
  renderGrid();
}

async function start() {
  try {
    await request('/api/session');
    showScreen('room');
    await connect();
  } catch (error) {
    if (error.status === 401) {
      showScreen('login');
      return;
    }
    showScreen('room');
    showMessage(`Não foi possível conectar: ${error.message}`, true);
    setConnection('Erro', true);
  }
}

$('login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = event.currentTarget.querySelector('button');
  button.disabled = true;
  $('login-error').hidden = true;
  try {
    await request('/api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: $('invite-key').value.trim() }),
    });
    showScreen('room');
    await connect();
  } catch (error) {
    $('login-error').textContent =
      error.status === 401 ? 'Convite inválido ou revogado.' : error.message;
    $('login-error').hidden = false;
  } finally {
    button.disabled = false;
  }
});

$('logout').addEventListener('click', async () => {
  await fetch('/api/logout', { method: 'POST', credentials: 'same-origin' });
  window.location.reload();
});

$('watch-all').addEventListener('click', () => {
  for (const person of state.broadcasters.values()) setSubscribed(person.id, true);
});

$('watch-none').addEventListener('click', () => {
  for (const identity of [...state.selected]) setSubscribed(identity, false);
});

void start();
