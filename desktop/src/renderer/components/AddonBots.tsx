/**
 * An addon's bots (ADR 0041) and their pictures, in its card in Settings ›
 * Addons. A bot has no app to set its own picture: it is set here, for
 * everyone, framed the way your own picture is.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { BotInfo } from '../../shared/ipc';
import { encodeAvatar, type AvatarCrop } from '../avatars';
import { useAccountAvatar } from '../chat/avatars';
import { useT } from '../i18n';
import { useExit } from '../presence';
import Avatar from './Avatar';
import AvatarCropDialog from './AvatarCropDialog';

const PICTURE_TYPES = ['image/png', 'image/jpeg', 'image/webp'];
/** As for your own picture: only what the framing dialog opens quickly. */
const MAX_PICTURE_MB = 10;

export default function AddonBots({ addonId }: { addonId: string }) {
  const t = useT();
  const [bots, setBots] = useState<BotInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Which bot a picture is being chosen, then framed, for.
  const [choosing, setChoosing] = useState<string | null>(null);
  const [picked, setPicked] = useState<{ bot: string; file: File } | null>(null);
  const [shown, setShown] = useState<{ bot: string; file: File } | null>(null);
  if (picked && picked !== shown) setShown(picked);
  const cropDialog = useExit(picked !== null);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    const outcome = await window.zoia.admin.bots();
    if (outcome.ok) setBots(outcome.value.filter((b) => b.addonId === addonId));
    else setError(t('bots.loadFailed'));
  }, [addonId, t]);

  useEffect(() => {
    void load();
  }, [load]);

  async function save(bot: string, file: File, crop: AvatarCrop) {
    const encoded = await encodeAvatar(file, crop);
    const outcome = await window.zoia.admin.setBotAvatar(bot, encoded.bytes);
    if (!outcome.ok) throw new Error(outcome.error);
    setPicked(null);
    await load();
  }

  async function remove(bot: string) {
    setError(null);
    const outcome = await window.zoia.admin.removeBotAvatar(bot);
    if (!outcome.ok) setError(t('bots.failed'));
    await load();
  }

  return (
    <>
      {bots === null && !error && <p className="muted">{t('common.loading')}</p>}
      <ul className="bot-pictures">
        {bots?.map((bot) => (
          <BotRow
            key={bot.id}
            bot={bot}
            onChange={() => {
              setChoosing(bot.id);
              fileRef.current?.click();
            }}
            onRemove={() => void remove(bot.id)}
          />
        ))}
      </ul>
      {error && <p className="settings-error">{error}</p>}
      <input
        ref={fileRef}
        type="file"
        accept={PICTURE_TYPES.join(',')}
        hidden
        onChange={(event) => {
          const file = event.target.files?.[0];
          // Cleared, so choosing the same file again still counts as a change.
          event.target.value = '';
          if (!file || !choosing) return;
          if (!PICTURE_TYPES.includes(file.type)) {
            setError(t('profile.pictureWrongType'));
            return;
          }
          if (file.size > MAX_PICTURE_MB * 1024 * 1024) {
            setError(t('profile.pictureTooLarge', { max: MAX_PICTURE_MB }));
            return;
          }
          setError(null);
          setPicked({ bot: choosing, file });
        }}
      />
      {cropDialog.mounted && shown && (
        <AvatarCropDialog
          file={shown.file}
          closing={cropDialog.closing}
          onCancel={() => setPicked(null)}
          onSave={(crop) => save(shown.bot, shown.file, crop)}
        />
      )}
    </>
  );
}

function BotRow({
  bot,
  onChange,
  onRemove,
}: {
  bot: BotInfo;
  onChange: () => void;
  onRemove: () => void;
}) {
  const t = useT();
  const image = useAccountAvatar(bot.id, bot.avatar);
  return (
    <li className="bot-picture">
      <Avatar name={bot.name} image={image} live={false} bot={bot.addon} />
      <span className="bot-picture-who">{bot.name}</span>
      <button type="button" onClick={onChange}>
        {t('bots.change')}
      </button>
      {bot.avatar && (
        <button type="button" className="link-button" onClick={onRemove}>
          {t('profile.removePicture')}
        </button>
      )}
    </li>
  );
}
