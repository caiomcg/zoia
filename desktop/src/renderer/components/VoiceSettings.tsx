/**
 * Settings › Voice (ADR 0039): the microphone and how it is sent, what is
 * done to it on the way, and the global shortcuts.
 *
 * Every change applies to the live microphone at once; the meter shows what
 * the channel hears, and where the sensitivity cuts it off.
 */

import { useCallback, useEffect, useState } from 'react';
import { useT } from '../i18n';
import type { MessageKey } from '../../shared/i18n';
import { useCameraDevices } from '../livekit/useCamera';
import { useMicLevel } from '../voice/useMicLevel';
import {
  dbFraction,
  levelToDb,
  SENSITIVITY_MAX,
  SENSITIVITY_MIN,
  setVoiceSettings,
  useVoiceSettings,
  type InputMode,
  type NoiseSuppression,
  type VoiceSettings,
} from '../voice/settings';
import { SHORTCUT_ACTIONS, type ShortcutAction, type ShortcutsState } from '../../shared/shortcuts';

const INPUT_MODES: readonly InputMode[] = ['voiceActivity', 'pushToTalk'];
const NOISE_MODES: readonly NoiseSuppression[] = ['off', 'standard', 'enhanced'];

/** Segments in the meter, and from which one it is too loud. */
const METER_SEGMENTS = 40;
const METER_HOT = 37;

/** One choice of several, as the sounds section has them. */
function Segmented<T extends string>({
  label,
  options,
  value,
  name,
  onChange,
}: {
  label: string;
  options: readonly T[];
  value: T;
  name: (option: T) => string;
  onChange: (option: T) => void;
}) {
  return (
    <div className="sound-styles voice-segmented" role="radiogroup" aria-label={label}>
      {options.map((option) => (
        <button
          key={option}
          type="button"
          role="radio"
          aria-checked={value === option}
          className={value === option ? 'active' : undefined}
          onClick={() => onChange(option)}
        >
          {name(option)}
        </button>
      ))}
    </div>
  );
}

/**
 * The level, with the sensitivity as a marker dragged across it: what is
 * left of the marker is dimmed, and never sent. Push to talk has no marker.
 */
function LevelMeter({
  settings,
  level,
  autoThreshold,
}: {
  settings: VoiceSettings;
  level: number;
  autoThreshold: number;
}) {
  const t = useT();
  const sensing = settings.inputMode === 'voiceActivity';
  const auto = settings.autoSensitivity;
  const always = !auto && settings.sensitivity <= SENSITIVITY_MIN;
  const cut = auto ? autoThreshold : settings.sensitivity;
  const lit = Math.round(dbFraction(levelToDb(level)) * METER_SEGMENTS);
  const threshold = sensing && !always ? Math.round(dbFraction(cut) * METER_SEGMENTS) : 0;
  const value = sensitivityValue(t, settings, autoThreshold);

  return (
    <div className="voice-level">
      <div
        className="level-meter voice-meter"
        role="meter"
        aria-label={t('voiceSettings.level')}
        aria-valuemin={0}
        aria-valuemax={1}
        aria-valuenow={level}
      >
        {Array.from({ length: METER_SEGMENTS }, (_, i) => (
          <span
            key={i}
            className={`level-seg${i >= METER_HOT ? ' hot' : ''}${i < threshold ? ' gated' : ''}${i < lit ? ' on' : ''}`}
          />
        ))}
      </div>
      {/* Automatic: the marker follows the room on its own, and is not dragged. */}
      {sensing && auto && (
        <span
          className="voice-threshold-auto"
          style={{ left: `${dbFraction(cut) * 100}%` }}
          aria-hidden="true"
        />
      )}
      {sensing && !auto && (
        <input
          type="range"
          className="voice-threshold"
          min={SENSITIVITY_MIN}
          max={SENSITIVITY_MAX}
          step={1}
          value={settings.sensitivity}
          onChange={(event) =>
            setVoiceSettings({ ...settings, sensitivity: Number(event.target.value) })
          }
          aria-label={t('voiceSettings.sensitivity')}
          aria-valuetext={value}
          title={value}
        />
      )}
    </div>
  );
}

/** "Automatic · −42 dB", "Always on" or "−42 dB": where the sensitivity cuts. */
function sensitivityValue(
  t: ReturnType<typeof useT>,
  settings: VoiceSettings,
  autoThreshold: number,
): string {
  if (settings.autoSensitivity) {
    return `${t('voiceSettings.sensitivityAuto')} · ${t('voiceSettings.sensitivityDb', { db: autoThreshold })}`;
  }
  return settings.sensitivity <= SENSITIVITY_MIN
    ? t('voiceSettings.sensitivityAlways')
    : t('voiceSettings.sensitivityDb', { db: settings.sensitivity });
}

/** The shortcuts main holds, and recording a new one. */
function useShortcuts() {
  const [state, setState] = useState<ShortcutsState | null>(null);
  const [recording, setRecording] = useState<ShortcutAction | null>(null);

  useEffect(() => {
    let live = true;
    void window.zoia.shortcuts.get().then((s) => live && setState(s));
    return () => {
      live = false;
    };
  }, []);

  // While recording, what is pressed is the binding, not a key for the page:
  // Escape must not close the dialog, nor Space press a button.
  useEffect(() => {
    if (!recording) return;
    const swallow = (event: Event) => {
      event.preventDefault();
      event.stopPropagation();
    };
    const types = ['keydown', 'keyup', 'keypress', 'auxclick'] as const;
    for (const type of types) window.addEventListener(type, swallow, true);
    return () => {
      for (const type of types) window.removeEventListener(type, swallow, true);
    };
  }, [recording]);

  // Leaving the pane mid-recording must not leave main listening for one.
  useEffect(() => () => void window.zoia.shortcuts.cancel(), []);

  const record = useCallback(async (action: ShortcutAction) => {
    setRecording(action);
    const next = await window.zoia.shortcuts.record(action);
    setRecording((current) => (current === action ? null : current));
    if (next) setState(next);
  }, []);

  const cancel = useCallback(() => {
    void window.zoia.shortcuts.cancel();
  }, []);

  const clear = useCallback(async (action: ShortcutAction) => {
    setState(await window.zoia.shortcuts.clear(action));
  }, []);

  return { state, recording, record, cancel, clear };
}

function Shortcuts({ state, recording, record, cancel, clear }: ReturnType<typeof useShortcuts>) {
  const t = useT();

  if (state && !state.available) {
    return <p className="muted voice-card-note">{t('voiceSettings.shortcutsUnavailable')}</p>;
  }

  return (
    <div className="voice-shortcuts">
      {SHORTCUT_ACTIONS.map((action) => {
        const bound = state?.bindings[action];
        const name = t(`shortcut.${action}` as MessageKey);
        const listening = recording === action;
        return (
          <div className="voice-shortcut" key={action}>
            <span className="voice-shortcut-name">{name}</span>
            <button
              type="button"
              className={`voice-keybind${listening ? ' recording' : ''}${bound ? '' : ' unset'}`}
              onClick={() => (listening ? cancel() : void record(action))}
              aria-label={t('shortcut.change', { action: name })}
              disabled={!state}
            >
              {listening
                ? t('shortcut.recording')
                : bound
                  ? bound.label.split(' + ').map((key, i) => <kbd key={i}>{key}</kbd>)
                  : t('shortcut.unset')}
            </button>
            <button
              type="button"
              className="icon-button voice-shortcut-clear"
              onClick={() => void clear(action)}
              disabled={!bound || listening}
              title={t('shortcut.clear', { action: name })}
              aria-label={t('shortcut.clear', { action: name })}
            >
              <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
                <path
                  d="M6 6l12 12M18 6L6 18"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                />
              </svg>
            </button>
          </div>
        );
      })}
    </div>
  );
}

export default function VoiceSettingsSection() {
  const t = useT();
  const settings = useVoiceSettings();
  const { devices } = useCameraDevices();
  const mic = useMicLevel(settings);
  const shortcuts = useShortcuts();
  const pushToTalk = shortcuts.state?.bindings.pushToTalk?.label ?? null;

  const sensing = settings.inputMode === 'voiceActivity';
  const levelHint = mic.error
    ? mic.error
    : sensing
      ? settings.autoSensitivity
        ? t('voiceSettings.sensitivityAutoHint')
        : t('voiceSettings.sensitivityHint')
      : pushToTalk
        ? t('voiceSettings.pushToTalkHint', { keys: pushToTalk })
        : t('voiceSettings.pushToTalkUnset');

  return (
    <>
      <h3>{t('settings.nav.voice')}</h3>
      <p className="muted settings-note">{t('voiceSettings.live')}</p>

      <section className="voice-card" aria-labelledby="voice-input">
        <h4 id="voice-input">{t('voiceSettings.input')}</h4>

        <label className="settings-field">
          <span>{t('voiceSettings.microphone')}</span>
          <select
            className="settings-select"
            value={settings.microphoneId}
            onChange={(event) =>
              setVoiceSettings({ ...settings, microphoneId: event.target.value })
            }
          >
            <option value="">{t('voiceSettings.systemDefault')}</option>
            {devices.microphones.map((m) => (
              <option key={m.deviceId} value={m.deviceId}>
                {m.label}
              </option>
            ))}
          </select>
        </label>

        <div className="voice-row">
          <span className="voice-label">{t('voiceSettings.mode')}</span>
          <Segmented
            label={t('voiceSettings.mode')}
            options={INPUT_MODES}
            value={settings.inputMode}
            name={(mode) => t(`voiceSettings.mode.${mode}`)}
            onChange={(inputMode) => setVoiceSettings({ ...settings, inputMode })}
          />
        </div>

        <div className="voice-meter-block">
          <div className="voice-row">
            <span className="voice-label">
              {sensing ? t('voiceSettings.sensitivity') : t('voiceSettings.level')}
            </span>
            {sensing && (
              <span className="voice-value">
                {sensitivityValue(t, settings, mic.autoThreshold)}
              </span>
            )}
          </div>
          <LevelMeter settings={settings} level={mic.level} autoThreshold={mic.autoThreshold} />
          {sensing && (
            <label className="voice-toggle voice-toggle-compact">
              <span>{t('voiceSettings.sensitivityAutoToggle')}</span>
              <input
                type="checkbox"
                role="switch"
                checked={settings.autoSensitivity}
                onChange={(event) =>
                  setVoiceSettings({ ...settings, autoSensitivity: event.target.checked })
                }
              />
            </label>
          )}
          <p className={`voice-card-note${mic.error ? ' settings-error' : ' muted'}`}>
            {levelHint}
          </p>
        </div>
      </section>

      <section className="voice-card" aria-labelledby="voice-processing">
        <h4 id="voice-processing">{t('voiceSettings.processing')}</h4>

        <div className="voice-row">
          <span className="voice-label">{t('voiceSettings.noise')}</span>
          <Segmented
            label={t('voiceSettings.noise')}
            options={NOISE_MODES}
            value={settings.noiseSuppression}
            name={(mode) => t(`voiceSettings.noise.${mode}`)}
            onChange={(noiseSuppression) => setVoiceSettings({ ...settings, noiseSuppression })}
          />
        </div>
        <p className="muted voice-card-note">
          {t(`voiceSettings.noise.${settings.noiseSuppression}Hint`)}
        </p>

        <label className="voice-toggle">
          <span>
            {t('voiceSettings.echo')}
            <small className="muted">{t('voiceSettings.echoHint')}</small>
          </span>
          <input
            type="checkbox"
            role="switch"
            checked={settings.echoCancellation}
            onChange={(event) =>
              setVoiceSettings({ ...settings, echoCancellation: event.target.checked })
            }
          />
        </label>

        <label className="voice-toggle">
          <span>
            {t('voiceSettings.agc')}
            <small className="muted">{t('voiceSettings.agcHint')}</small>
          </span>
          <input
            type="checkbox"
            role="switch"
            checked={settings.autoGainControl}
            onChange={(event) =>
              setVoiceSettings({ ...settings, autoGainControl: event.target.checked })
            }
          />
        </label>
      </section>

      <section className="voice-card" aria-labelledby="voice-shortcuts">
        <h4 id="voice-shortcuts">{t('voiceSettings.shortcuts')}</h4>
        <p className="muted voice-card-note">{t('voiceSettings.shortcutsHint')}</p>
        <Shortcuts {...shortcuts} />
      </section>
    </>
  );
}
