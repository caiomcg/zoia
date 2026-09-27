import { useEffect, useMemo, useState } from 'react';
import { QUALITY_PRESETS, type SourceInfo } from '../../shared/ipc';
import { findLeagueSources, isLeagueClient, isLeagueGame } from '../../shared/league';
import { useT } from '../i18n';

/**
 * Quality lives here rather than in the top bar because this is the moment it
 * is decided. In the bar it spent almost all of its time disabled — it cannot
 * be changed mid-share — and was read, if at all, long after the choice had
 * been made. Hardware encoding moved to Settings.
 */
export default function SourcePicker({
  onPick,
  onCancel,
  presetId,
  onPresetChange,
}: {
  onPick: (source: SourceInfo) => void;
  onCancel: () => void;
  presetId: string;
  onPresetChange: (id: string) => void;
}) {
  const t = useT();
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

  const league = useMemo(() => findLeagueSources(sources ?? []), [sources]);
  const hasLeague = Boolean(league.game || league.client);

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
          <h2>{t('picker.title')}</h2>
          <input
            autoFocus
            placeholder={t('picker.search')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </header>

        {loadError && <p className="error">{loadError}</p>}
        {!sources && !loadError && <p className="muted">{t('picker.loading')}</p>}

        {sources && (
          <div className="picker-body">
            {hasLeague && (
              <section className="picker-league-section">
                <div className="picker-league-banner">
                  <div className="picker-league-info">
                    <div className="picker-league-badge">
                      <span className="picker-league-icon">🎮</span>
                      <strong>League of Legends</strong>
                    </div>
                    <p className="picker-league-status">
                      {league.game ? t('picker.leagueInGame') : t('picker.leagueInClient')}
                    </p>
                    <span className="picker-league-tip">
                      💡 {t('picker.leagueTip').split('{mode}')[0]}
                      <strong>{t('picker.leagueBorderless')}</strong>
                      {t('picker.leagueTip').split('{mode}')[1]}
                    </span>
                  </div>
                  <button
                    className="picker-league-button"
                    onClick={() => onPick((league.game ?? league.client)!)}
                  >
                    {t('picker.leagueShare')}
                  </button>
                </div>
              </section>
            )}

            {screens.length > 0 && (
              <section>
                <h3>{t('picker.screens')}</h3>
                <div className="picker-grid">
                  {screens.map((s) => (
                    <SourceTile key={s.id} source={s} onClick={() => onPick(s)} />
                  ))}
                </div>
              </section>
            )}
            {windows.length > 0 && (
              <section>
                <h3>{t('picker.windows')}</h3>
                <div className="picker-grid">
                  {windows.map((s) => (
                    <SourceTile key={s.id} source={s} onClick={() => onPick(s)} />
                  ))}
                </div>
              </section>
            )}
            {filtered.length === 0 && <p className="muted">{t('picker.none')}</p>}
          </div>
        )}

        <footer className="picker-footer">
          <div className="picker-options">
            <label className="picker-option">
              <span>{t('picker.quality')}</span>
              <select value={presetId} onChange={(e) => onPresetChange(e.target.value)}>
                {QUALITY_PRESETS.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <button onClick={onCancel}>{t('common.cancel')}</button>
        </footer>
      </div>
    </div>
  );
}

function SourceTile({ source, onClick }: { source: SourceInfo; onClick: () => void }) {
  const t = useT();
  const isGame = isLeagueGame(source);
  const isClient = isLeagueClient(source);

  return (
    <button className="picker-tile" onClick={onClick} title={source.name}>
      {source.thumbnailDataUrl ? (
        <img src={source.thumbnailDataUrl} alt="" />
      ) : (
        <div className="picker-tile-blank" />
      )}
      <span>{source.name}</span>
      {isGame && <em className="picker-tile-badge">{t('picker.leagueGameBadge')}</em>}
      {isClient && <em className="picker-tile-badge">{t('picker.leagueClientBadge')}</em>}
      {source.kind === 'window' && source.processId === null && (
        <em className="picker-tile-warn">{t('picker.audioUnavailable')}</em>
      )}
    </button>
  );
}
