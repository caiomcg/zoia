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
  closing = false,
}: {
  onPick: (source: SourceInfo) => void;
  onCancel: () => void;
  presetId: string;
  onPresetChange: (id: string) => void;
  /** Fading out: it stays on screen for that, and ignores clicks. */
  closing?: boolean;
}) {
  const t = useT();
  const [sources, setSources] = useState<SourceInfo[] | null>(null);
  const [query, setQuery] = useState('');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);

  const handleRefresh = async () => {
    if (isRefreshing) return;
    setIsRefreshing(true);
    try {
      const list = await window.zoia.sources.list(true);
      setSources(list);
      setLoadError(null);
    } catch (err) {
      const message = (err instanceof Error ? err.message : String(err)).replace(
        /^Error invoking remote method '[^']+': (Error: )?/,
        '',
      );
      setSources((current) => {
        if (!current) setLoadError(message);
        return current;
      });
    } finally {
      setIsRefreshing(false);
    }
  };

  // Thumbnails came from a single call when the picker opened, so they were
  // a photograph of the moment it appeared — a window that changed, or was
  // opened afterwards, never showed it. The list is polled while the picker
  // is on screen instead.
  //
  // What is polled is `instant()`, not `list()`. Measured on this machine,
  // `desktopCapturer.getSources` with thumbnails takes 3.3 seconds, because a
  // thumbnail is a real capture of each window — about 630ms apiece. Naming
  // the same windows natively takes 8ms. So the list that arrives is the one
  // that is current, and `list()` is called alongside it only to keep the
  // thumbnail refresh turning over; its pictures are merged in by id as they
  // land, and a tile without one renders the blank placeholder meanwhile.
  //
  // That ordering is the point: when someone clicks Share they are waiting to
  // find a window, not to look at it.
  useEffect(() => {
    let cancelled = false;

    const load = () => {
      // Returns the warm cache immediately; refreshes behind it when stale.
      void window.zoia.sources.list().catch(() => {});
      return window.zoia.sources
        .instant()
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
              // Electron prefixes errors thrown in main with the IPC channel
              // name, which means nothing to the person reading it.
              const message = (err instanceof Error ? err.message : String(err)).replace(
                /^Error invoking remote method '[^']+': (Error: )?/,
                '',
              );
              if (!current) setLoadError(message);
              return current;
            });
          }
        });
    };

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
    <div className={`picker-backdrop${closing ? ' closing' : ''}`} onClick={onCancel}>
      <div className="picker" onClick={(e) => e.stopPropagation()}>
        <header>
          <h2>{t('picker.title')}</h2>
          <div className="picker-header-actions">
            <input
              autoFocus
              placeholder={t('picker.search')}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <button
              type="button"
              className={`picker-refresh-btn${isRefreshing ? ' refreshing' : ''}`}
              onClick={() => void handleRefresh()}
              title={t('picker.refresh')}
              aria-label={t('picker.refresh')}
              disabled={isRefreshing}
            >
              <IconRefresh />
            </button>
          </div>
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

            <div className="picker-game-tip">
              <span className="picker-game-tip-icon">💡</span>
              <p className="picker-game-tip-text">
                {t('picker.gameTip')
                  .split(/({borderless}|{screen})/)
                  .map((part, i) => {
                    if (part === '{borderless}') {
                      return <strong key={i}>{t('picker.borderlessMode')}</strong>;
                    }
                    if (part === '{screen}') {
                      return <strong key={i}>{t('picker.screenMode')}</strong>;
                    }
                    return part;
                  })}
              </p>
            </div>
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
        <div className="picker-tile-blank">
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            aria-hidden="true"
          >
            <rect x="2" y="3" width="20" height="14" rx="2" />
            <line x1="8" y1="21" x2="16" y2="21" />
            <line x1="12" y1="17" x2="12" y2="21" />
          </svg>
        </div>
      )}
      <span>{source.name}</span>
      {isGame && <em className="picker-tile-badge">{t('picker.leagueGameBadge')}</em>}
      {isClient && <em className="picker-tile-badge">{t('picker.leagueClientBadge')}</em>}
      {/* On macOS no window has a PID here, yet every share carries system audio. */}
      {source.kind === 'window' &&
        source.processId === null &&
        window.zoia.app.platform === 'win32' && (
          <em className="picker-tile-warn">{t('picker.audioUnavailable')}</em>
        )}
    </button>
  );
}

function IconRefresh() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="none">
      <path
        d="M20 12a8 8 0 1 1-2.34-5.66L20 8.5"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M20 3.5v5h-5"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
