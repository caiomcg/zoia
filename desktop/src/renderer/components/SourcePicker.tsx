import { useEffect, useMemo, useState } from 'react';
import type { SourceInfo } from '../../shared/ipc';
import { useCameraDevices } from '../livekit/useCamera';

export default function SourcePicker({
  onPick,
  onPickCamera,
  onCancel,
}: {
  onPick: (source: SourceInfo) => void;
  onPickCamera: (constraints: MediaStreamConstraints) => void;
  onCancel: () => void;
}) {
  const camera = useCameraDevices();
  const [sources, setSources] = useState<SourceInfo[] | null>(null);
  const [query, setQuery] = useState('');
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    window.zoia.sources
      .list()
      .then((list) => {
        if (!cancelled) setSources(list);
      })
      .catch((err) => {
        if (!cancelled) setLoadError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const filtered = useMemo(() => {
    if (!sources) return [];
    const q = query.trim().toLowerCase();
    return q ? sources.filter((s) => s.name.toLowerCase().includes(q)) : sources;
  }, [sources, query]);

  const screens = filtered.filter((s) => s.kind === 'screen');
  const windows = filtered.filter((s) => s.kind === 'window');

  return (
    <div className="picker-backdrop" onClick={onCancel}>
      <div className="picker" onClick={(e) => e.stopPropagation()}>
        <header>
          <h2>Choose what to share</h2>
          <input
            autoFocus
            placeholder="Search windows…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </header>

        {loadError && <p className="error">{loadError}</p>}
        {!sources && !loadError && <p className="muted">Loading sources…</p>}

        {sources && (
          <div className="picker-body">
            {screens.length > 0 && (
              <section>
                <h3>Screens</h3>
                <div className="picker-grid">
                  {screens.map((s) => (
                    <SourceTile key={s.id} source={s} onClick={() => onPick(s)} />
                  ))}
                </div>
              </section>
            )}
            {windows.length > 0 && (
              <section>
                <h3>Windows</h3>
                <div className="picker-grid">
                  {windows.map((s) => (
                    <SourceTile key={s.id} source={s} onClick={() => onPick(s)} />
                  ))}
                </div>
              </section>
            )}
            {camera.devices.cameras.length > 0 && !query && (
              <section>
                <h3>Camera</h3>
                <div className="camera-row">
                  <label>
                    <span className="muted">Camera</span>
                    <select
                      value={camera.cameraId}
                      onChange={(e) => camera.chooseCamera(e.target.value)}
                    >
                      {/* An empty value means whatever Windows considers the
                          default, which is what most people want. */}
                      <option value="">Default</option>
                      {camera.devices.cameras.map((c) => (
                        <option key={c.deviceId} value={c.deviceId}>
                          {c.label}
                        </option>
                      ))}
                    </select>
                  </label>

                  <label>
                    <span className="muted">Microphone</span>
                    <select
                      value={camera.microphoneId}
                      onChange={(e) => camera.chooseMicrophone(e.target.value)}
                    >
                      <option value="">Default</option>
                      {camera.devices.microphones.map((m) => (
                        <option key={m.deviceId} value={m.deviceId}>
                          {m.label}
                        </option>
                      ))}
                    </select>
                  </label>

                  <button className="primary" onClick={() => onPickCamera(camera.constraints())}>
                    Share camera
                  </button>
                </div>
                {camera.error && <p className="error">{camera.error}</p>}
              </section>
            )}

            {filtered.length === 0 && <p className="muted">No matching sources.</p>}
          </div>
        )}

        <footer>
          <button onClick={onCancel}>Cancel</button>
        </footer>
      </div>
    </div>
  );
}

function SourceTile({ source, onClick }: { source: SourceInfo; onClick: () => void }) {
  return (
    <button className="picker-tile" onClick={onClick} title={source.name}>
      {source.thumbnailDataUrl ? (
        <img src={source.thumbnailDataUrl} alt="" />
      ) : (
        <div className="picker-tile-blank" />
      )}
      <span>{source.name}</span>
      {source.kind === 'window' && source.processId === null && (
        <em className="picker-tile-warn">audio unavailable</em>
      )}
    </button>
  );
}
