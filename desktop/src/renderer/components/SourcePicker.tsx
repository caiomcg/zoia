import { useEffect, useMemo, useState } from 'react';
import type { SourceInfo } from '../../shared/ipc';

export default function SourcePicker({
  onPick,
  onCancel,
}: {
  onPick: (source: SourceInfo) => void;
  onCancel: () => void;
}) {
  const [sources, setSources] = useState<SourceInfo[] | null>(null);
  const [query, setQuery] = useState('');
  const [loadError, setLoadError] = useState<string | null>(null);

  // Thumbnails came from a single call when the picker opened, so they were
  // a photograph of the moment it appeared — a window that changed, or was
  // opened afterwards, never showed it. The list is polled while the picker
  // is on screen instead; the main process keeps a warm cache, so this reads
  // whatever the latest capture produced rather than forcing a new one.
  useEffect(() => {
    let cancelled = false;

    const load = () =>
      window.zoia.sources
        .list()
        .then((list) => {
          if (!cancelled) {
            setSources(list);
            setLoadError(null);
          }
        })
        .catch((err) => {
          // Only surface a failure if there is nothing to show at all; a
          // refresh that fails while a good list is on screen is not worth
          // replacing it with an error.
          if (!cancelled) {
            setSources((current) => {
              if (!current) setLoadError(err instanceof Error ? err.message : String(err));
              return current;
            });
          }
        });

    void load();
    const timer = setInterval(() => void load(), 1500);
    return () => {
      cancelled = true;
      clearInterval(timer);
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
