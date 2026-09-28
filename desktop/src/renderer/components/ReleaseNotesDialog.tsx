import { useEffect, useState } from 'react';
import type { ReleaseInfo } from '../../shared/ipc';
import { tNow, useT } from '../i18n';
import Markdown from './Markdown';

interface ReleaseNotesDialogProps {
  onClose: () => void;
  /** Notes already read, as after an update; otherwise they are read on open. */
  release?: ReleaseInfo;
  /** Fading out: it stays on screen for that, and ignores clicks. */
  closing?: boolean;
}

/**
 * What changed in the running version, from its GitHub release. Opened once
 * by itself on the first start after an update, and from the version number
 * in Settings → About at any time.
 */
export default function ReleaseNotesDialog({
  onClose,
  release,
  closing = false,
}: ReleaseNotesDialogProps) {
  const t = useT();
  // undefined while loading; null when this version has no published release.
  const [loaded, setLoaded] = useState<ReleaseInfo | null | undefined>(release);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (release) return undefined;
    let cancelled = false;
    setError(null);
    setLoaded(undefined);
    window.zoia.updater
      .releaseNotes()
      .then((notes) => {
        if (!cancelled) setLoaded(notes);
      })
      .catch(() => {
        if (!cancelled) setError(tNow('changelog.failed'));
      });
    return () => {
      cancelled = true;
    };
  }, [release, attempt]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className={`picker-backdrop${closing ? ' closing' : ''}`} onClick={onClose}>
      <section
        className="picker release-dialog"
        role="dialog"
        aria-label={t('changelog.title')}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="settings-header">
          <h2>
            {loaded
              ? t('changelog.titleVersion', { version: loaded.version })
              : t('changelog.title')}
          </h2>
          <button
            className="icon-button"
            onClick={onClose}
            aria-label={t('common.close')}
            title={t('common.close')}
          >
            ×
          </button>
        </div>

        <div className="release-body">
          {error && (
            <div className="settings-actions changelog-error">
              <p className="settings-error">{error}</p>
              <button type="button" onClick={() => setAttempt((n) => n + 1)}>
                {t('changelog.retry')}
              </button>
            </div>
          )}
          {!error && loaded === undefined && <p className="muted">{t('common.loading')}</p>}
          {loaded === null && <p className="muted">{t('changelog.none')}</p>}
          {loaded && (
            <>
              {loaded.publishedAt && (
                <time className="muted release-date" dateTime={loaded.publishedAt}>
                  {new Date(loaded.publishedAt).toLocaleDateString()}
                </time>
              )}
              <Markdown source={loaded.notes} />
            </>
          )}
        </div>

        <div className="release-footer">
          {loaded && (
            <a className="release-link" href={loaded.url} target="_blank" rel="noreferrer">
              {t('changelog.viewOnGitHub')}
            </a>
          )}
          <button type="button" className="primary" onClick={onClose}>
            {t('common.ok')}
          </button>
        </div>
      </section>
    </div>
  );
}
