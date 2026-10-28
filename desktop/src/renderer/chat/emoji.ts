/**
 * The emoji offered beside the message box, by kind, and the ones you used
 * last. Every other emoji is in the system's own picker, a click away.
 */

export type EmojiGroup = 'smileys' | 'gestures' | 'hearts' | 'fun' | 'food' | 'nature' | 'things';

const list = (s: string) => s.split(' ');

export const EMOJI_GROUPS: ReadonlyArray<{ id: EmojiGroup; emoji: readonly string[] }> = [
  {
    id: 'smileys',
    emoji: list(
      '😀 😃 😄 😁 😆 😅 😂 🤣 😊 🙂 🙃 😉 😍 🥰 😘 😋 😛 😜 🤪 😎 🤩 🥳 ' +
        '🤔 🤨 😐 😑 😶 🙄 😏 😬 😴 🤤 😪 😮 😯 😲 😳 🥺 😢 😭 😤 😠 😡 🤬 ' +
        '🤯 😱 😨 😰 🤗 🤭 🫡 🤫 🤐 🥴 😵 🤢 🤮 🤧 😷 🤒 🤠 🤓 🧐 😈 💀 👻 🤡 💩 🤖',
    ),
  },
  {
    id: 'gestures',
    emoji: list(
      '👍 👎 👌 🤌 ✌️ 🤞 🤟 🤘 🤙 👈 👉 👆 👇 ☝️ 👋 🤚 ✋ 🖐️ 👏 🙌 🫶 👐 🤲 🙏 🤝 💪 ✍️ 👀 🧠 🫠',
    ),
  },
  {
    id: 'hearts',
    emoji: list(
      '❤️ 🧡 💛 💚 💙 💜 🖤 🤍 🤎 💔 ❣️ 💕 💞 💓 💗 💖 💘 💝 💯 💢 💥 💫 💦 💤 ✨ 🔥 ⭐ 🌟',
    ),
  },
  {
    id: 'fun',
    emoji: list(
      '🎉 🎊 🎈 🎁 🏆 🥇 🎮 🕹️ 👾 🎲 🧩 ♟️ 🎯 ⚽ 🏀 🏐 🎾 🎬 📺 🍿 🎵 🎶 🎧 🎤 🎸 🥁 📢 🚀',
    ),
  },
  {
    id: 'food',
    emoji: list(
      '🍕 🍔 🍟 🌭 🌮 🌯 🍣 🍜 🍝 🥗 🍩 🍪 🎂 🍰 🍫 🍿 🍎 🍓 🍉 🍌 ☕ 🍵 🧃 🥤 🍺 🍻 🍷 🥂',
    ),
  },
  {
    id: 'nature',
    emoji: list(
      '🐶 🐱 🐭 🐹 🐰 🦊 🐻 🐼 🐨 🐯 🦁 🐮 🐷 🐸 🐵 🐔 🐧 🐦 🦄 🐝 🦋 🐢 🐍 🐙 🌸 🌻 🌈 ☀️ 🌙 ⚡ ❄️ 🌊',
    ),
  },
  {
    id: 'things',
    emoji: list(
      '💻 🖥️ ⌨️ 🖱️ 📱 📷 🎥 💡 🔧 🛠️ ⚙️ 🔒 🔑 📌 📎 ✏️ 📝 📚 📅 ⏰ ⌛ 💰 🛒 🚗 ✈️ 🏠 🌎 ✅ ❌ ⚠️ ❓ ❗',
    ),
  },
];

/** How many recently used emoji are kept. */
export const RECENT_MAX = 16;

/** The recent list with `emoji` at its front, once, cut to `max`. */
export function pushRecent(recent: readonly string[], emoji: string, max = RECENT_MAX): string[] {
  return [emoji, ...recent.filter((e) => e !== emoji)].slice(0, max);
}

/**
 * `insert` put in place of the selection from `start` to `end` of `text`,
 * and where the caret goes after it; null when it would pass `max`.
 */
export function insertText(
  text: string,
  insert: string,
  start: number,
  end: number,
  max: number,
): { text: string; caret: number } | null {
  const next = text.slice(0, start) + insert + text.slice(end);
  if (next.length > max) return null;
  return { text: next, caret: start + insert.length };
}
