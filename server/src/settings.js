/**
 * Settings admins change while the app runs, such as how many channels and
 * chats there may be. One row each in the database's `settings` table, so a
 * change needs no redeploy and survives a restart.
 */

/**
 * A whole-number setting between `min` and `max`. Reading falls back to
 * `fallback` when the row is missing or holds something else, and clamps a
 * value written past this code to the range.
 */
export function createLimitSetting({ db, key, fallback, min = 1, max }) {
  const { sqlite } = db;
  const within = (value) => Number.isInteger(value) && value >= min && value <= max;

  return {
    min,
    max,

    get() {
      const row = sqlite.prepare('SELECT value FROM settings WHERE key = ?').get(key);
      const value = row ? Number(row.value) : fallback;
      if (!Number.isInteger(value)) return fallback;
      return Math.min(Math.max(value, min), max);
    },

    /** Resolves to `{ ok: true, value }`, or `{ ok: false, reason: 'invalid_limit' }`. */
    async set(value) {
      if (!within(value)) return { ok: false, reason: 'invalid_limit' };
      await db.transaction(() => {
        sqlite
          .prepare(
            'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value',
          )
          .run(key, String(value));
      });
      return { ok: true, value };
    },
  };
}
