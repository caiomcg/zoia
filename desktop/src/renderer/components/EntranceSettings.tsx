import { useState } from 'react';
import { MAX_ENTRANCE_SECONDS, type Sound } from '../../shared/soundboard';
import { useT } from '../i18n';
import {
  entranceSound,
  soundboardSettings,
  stepEntranceVolume,
  useEntranceSound,
  useSoundboardSettings,
} from '../soundboard/library';
import { playSound } from '../soundboard/player';
import { useSoundSearch } from '../soundboard/useSoundSearch';
import { SettingsCard, SettingsToggle } from './SettingsCard';
import { IconClose, IconNote, IconPreview, IconSearch } from './SoundboardPanel';
import { useWheelRange } from './useWheelRange';

/**
 * Entrance sounds in Settings › Sounds (ADR 0046): the one you arrive with,
 * found on Myinstants, and how those of everyone else play for you. All of it
 * is kept on this machine.
 */
export default function EntranceSettingsSection() {
  const t = useT();
  const settings = useSoundboardSettings();
  const chosen = useEntranceSound();
  const [previewFailed, setPreviewFailed] = useState<string | null>(null);
  const { query, setQuery, search, loadMore } = useSoundSearch();
  const percent = Math.round(settings.entranceVolume * 100);
  const volumeRef = useWheelRange(stepEntranceVolume);

  const choose = (sound: Sound) => {
    entranceSound.set(sound);
    setQuery('');
  };

  const preview = async (sound: Sound) => {
    setPreviewFailed(null);
    if ((await playSound('preview', sound, false, 'entrance')) === null) {
      setPreviewFailed(sound.name);
    }
  };

  const previewButton = (sound: Sound) => (
    <button
      type="button"
      className="icon-button soundboard-icon"
      onClick={() => void preview(sound)}
      disabled={settings.entrancesMuted}
      title={t('soundboard.preview', { name: sound.name })}
      aria-label={t('soundboard.preview', { name: sound.name })}
    >
      <IconPreview />
    </button>
  );

  return (
    <SettingsCard id="settings-sounds-entrance" title={t('entrance.title')}>
      <p className="muted settings-card-note">
        {t('entrance.intro', { seconds: MAX_ENTRANCE_SECONDS })}
      </p>

      {chosen ? (
        <div className="soundboard-row entrance-chosen">
          <span className="soundboard-play">
            <IconNote />
            <span className="soundboard-name">{chosen.name}</span>
          </span>
          {previewButton(chosen)}
          <button
            type="button"
            className="icon-button soundboard-icon"
            onClick={() => entranceSound.set(null)}
            title={t('entrance.remove')}
            aria-label={t('entrance.remove')}
          >
            <IconClose />
          </button>
        </div>
      ) : (
        <p className="soundboard-note">{t('entrance.none')}</p>
      )}
      {previewFailed && (
        <p className="soundboard-note">{t('soundboard.previewFailed', { name: previewFailed })}</p>
      )}

      <div className="soundboard-search">
        <IconSearch />
        <input
          type="search"
          placeholder={t('soundboard.search')}
          aria-label={t('soundboard.search')}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          spellCheck={false}
        />
      </div>
      {search && (
        <div className="soundboard-list entrance-results">
          {search.sounds.map((sound) => (
            <div key={sound.slug} className="soundboard-row">
              <button
                type="button"
                className="soundboard-play"
                onClick={() => choose(sound)}
                title={t('entrance.use', { name: sound.name })}
              >
                <IconNote />
                <span className="soundboard-name">{sound.name}</span>
              </button>
              {previewButton(sound)}
            </div>
          ))}
          {search.loading && <p className="soundboard-note">{t('soundboard.searching')}</p>}
          {search.failed && <p className="soundboard-note">{t('soundboard.searchFailed')}</p>}
          {!search.loading && !search.failed && search.sounds.length === 0 && (
            <p className="soundboard-note">{t('soundboard.noResults')}</p>
          )}
          {search.next && !search.loading && (
            <button type="button" className="soundboard-more" onClick={loadMore}>
              {t('soundboard.more')}
            </button>
          )}
        </div>
      )}

      <SettingsToggle
        label={t('entrance.muteAll')}
        checked={settings.entrancesMuted}
        onChange={(entrancesMuted) => soundboardSettings.set({ ...settings, entrancesMuted })}
      />
      <label className="settings-field">
        <span>
          {t('entrance.volume')} · {percent}%
        </span>
        <input
          ref={volumeRef}
          className="settings-range"
          type="range"
          min={0}
          max={100}
          step={1}
          value={percent}
          disabled={settings.entrancesMuted}
          onChange={(event) =>
            soundboardSettings.set({
              ...settings,
              entranceVolume: Number(event.target.value) / 100,
            })
          }
        />
      </label>
    </SettingsCard>
  );
}
