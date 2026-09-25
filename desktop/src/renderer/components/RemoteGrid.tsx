import { useEffect, useRef, useState } from 'react';
import type { RemoteQualityMode, RemoteScreen } from '../livekit/useRoom';

export interface LoadingBroadcast {
  identity: string;
  name: string;
}

function RemoteTile({
  screen,
  audioActive,
  volume,
  audioOnly,
  focused,
  onActivateAudio,
  onVolumeChange,
  onToggleAudioOnly,
  onFocus,
}: {
  screen: RemoteScreen;
  audioActive: boolean;
  volume: number;
  audioOnly: boolean;
  focused: boolean;
  onActivateAudio: () => void;
  onVolumeChange: (value: number) => void;
  onToggleAudioOnly: () => void;
  onFocus: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const element = videoRef.current;
    if (!element) return;
    const tracks = screen.videoTrack ? [screen.videoTrack.mediaStreamTrack] : [];
    if (screen.audioTrack) tracks.push(screen.audioTrack.mediaStreamTrack);
    element.srcObject = new MediaStream(tracks);
    return () => {
      element.srcObject = null;
    };
  }, [screen.videoTrack, screen.audioTrack]);

  useEffect(() => {
    const element = videoRef.current;
    if (!element) return;
    element.muted = !audioActive;
    element.volume = audioActive ? volume : 0;
  }, [audioActive, volume]);

  return (
    <article className={`remote-tile${audioOnly ? ' audio-only-tile' : ''}`}>
      <video ref={videoRef} playsInline autoPlay />
      <div className="remote-tile-footer">
        <span>
          {screen.participantName}
          {screen.sourceName && (
            <small className="stream-source">
              {screen.sourceKind === 'window'
                ? 'Janela'
                : screen.sourceKind === 'screen'
                  ? 'Tela'
                  : ''}
              : {screen.sourceName}
            </small>
          )}
        </span>
        <div className="remote-tile-actions">
          <button onClick={onFocus}>{focused ? 'Foco ativo' : 'Focar'}</button>
          {screen.audioTrack && (
            <button onClick={onToggleAudioOnly}>{audioOnly ? 'Vídeo' : 'Somente áudio'}</button>
          )}
        </div>
        {screen.audioTrack && (
          <div className="remote-audio-controls">
            <span className={`remote-audio-label${audioActive ? ' active' : ''}`}>
              {audioActive ? 'Áudio ativo' : 'Áudio desligado'}
            </span>
            <button onClick={onActivateAudio}>
              {audioActive ? 'Silenciar áudio' : 'Ativar áudio'}
            </button>
            {audioActive && (
              <input
                type="range"
                min={0}
                max={1}
                step={0.01}
                value={volume}
                onChange={(event) => onVolumeChange(Number(event.target.value))}
                className="remote-volume"
                aria-label={`Volume de ${screen.participantName}`}
              />
            )}
          </div>
        )}
      </div>
    </article>
  );
}

export default function RemoteGrid({
  screens,
  loadingBroadcasts = [],
  showOnboarding = false,
  onStartSharing,
  onDismissOnboarding,
  qualityMode = 'auto',
  focusedIdentity = null,
  onQualityModeChange,
  onFocusChange,
  onToggleAudioOnly,
}: {
  screens: RemoteScreen[];
  loadingBroadcasts?: LoadingBroadcast[];
  showOnboarding?: boolean;
  onStartSharing?: () => void;
  onDismissOnboarding?: () => void;
  qualityMode?: RemoteQualityMode;
  focusedIdentity?: string | null;
  onQualityModeChange?: (mode: RemoteQualityMode) => void;
  onFocusChange?: (identity: string | null) => void;
  onToggleAudioOnly?: (identity: string, audioOnly: boolean) => void;
}) {
  const [audioOwner, setAudioOwner] = useState<string | null>(null);
  const [volumes, setVolumes] = useState<Record<string, number>>({});
  const [audioOnlyIds, setAudioOnlyIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    const withAudio = screens.find((screen) => screen.audioTrack);
    setAudioOwner((current) => {
      if (current && screens.some((screen) => screen.participantIdentity === current)) {
        return current;
      }
      return withAudio?.participantIdentity ?? null;
    });
  }, [screens]);

  if (screens.length === 0) {
    return (
      <section className="stage remote-empty">
        <div className="overlay">
          {loadingBroadcasts.length > 0 ? (
            <>
              <h2>Carregando transmissão…</h2>
              <p className="muted">
                {loadingBroadcasts.map((broadcast) => broadcast.name).join(', ')}{' '}
                {loadingBroadcasts.length === 1 ? 'está' : 'estão'} transmitindo, mas ainda
                {loadingBroadcasts.length === 1 ? ' está' : ' estão'} carregando.
              </p>
            </>
          ) : showOnboarding ? (
            <div className="onboarding-card">
              <p className="onboarding-step">Você entrou na sala</p>
              <h2>Pronto para começar</h2>
              <p className="muted">
                Assista a uma transmissão ao vivo pela lista ao lado ou compartilhe sua tela.
              </p>
              <ol className="onboarding-list">
                <li>
                  Clique em <strong>Compartilhar</strong>.
                </li>
                <li>Escolha uma janela ou tela.</li>
              </ol>
              <div className="onboarding-actions">
                <button className="primary" onClick={onStartSharing}>
                  Compartilhar tela
                </button>
                <button className="link" onClick={onDismissOnboarding}>
                  Agora não
                </button>
              </div>
            </div>
          ) : (
            <>
              <h2>Select a broadcast</h2>
              <p className="muted">Choose one or more live broadcasts from the room list.</p>
            </>
          )}
        </div>
      </section>
    );
  }

  return (
    <section className={`remote-grid count-${Math.min(screens.length, 4)}`}>
      <div className="remote-grid-toolbar">
        <span>
          {screens.length} {screens.length === 1 ? 'stream ativa' : 'streams ativas'}
          {screens.length > 1 && ' · maior consumo de banda'}
        </span>
        <label>
          Qualidade
          <select
            value={qualityMode}
            onChange={(event) => onQualityModeChange?.(event.target.value as RemoteQualityMode)}
          >
            <option value="auto">Automática</option>
            <option value="low">Baixa</option>
          </select>
        </label>
      </div>
      {screens.map((screen) => (
        <RemoteTile
          key={screen.participantIdentity}
          screen={screen}
          audioActive={audioOwner === screen.participantIdentity}
          volume={volumes[screen.participantIdentity] ?? 1}
          audioOnly={audioOnlyIds.has(screen.participantIdentity)}
          focused={focusedIdentity === screen.participantIdentity}
          onActivateAudio={() =>
            setAudioOwner((current) =>
              current === screen.participantIdentity ? null : screen.participantIdentity,
            )
          }
          onVolumeChange={(value) =>
            setVolumes((current) => ({
              ...current,
              [screen.participantIdentity]: value,
            }))
          }
          onToggleAudioOnly={() => {
            const audioOnly = !audioOnlyIds.has(screen.participantIdentity);
            setAudioOnlyIds((current) => {
              const next = new Set(current);
              if (audioOnly) next.add(screen.participantIdentity);
              else next.delete(screen.participantIdentity);
              return next;
            });
            onToggleAudioOnly?.(screen.participantIdentity, audioOnly);
          }}
          onFocus={() =>
            onFocusChange?.(
              focusedIdentity === screen.participantIdentity ? null : screen.participantIdentity,
            )
          }
        />
      ))}
    </section>
  );
}
