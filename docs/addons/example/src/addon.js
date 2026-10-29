/**
 * Echo: the smallest useful Zoia addon. It makes one bot, listens to the chats
 * the super admin binds it to, and answers `!echo <text>` with the text.
 *
 * Plain Node 22, no dependencies, so every line of talking to Zoia is here to
 * read. Copy it as a starting point; docs/addons/api.md has the rest.
 */

/** The bot this addon speaks as. */
const BOT_NAME = 'Echo';

/**
 * @param {object} options
 * @param {string} options.zoiaUrl where Zoia is: ZOIA_URL in the container
 * @param {string} options.token the addon's token: ZOIA_ADDON_TOKEN
 */
export function createEchoAddon({ zoiaUrl, token, fetchImpl = fetch, logger = console }) {
  const base = `${zoiaUrl.replace(/\/+$/, '')}/api/addon/v1`;
  let bot = null;
  let controller = null;

  /** One call to the addon API, as JSON; a refusal throws with its code. */
  async function api(method, path, body) {
    const res = await fetchImpl(`${base}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${data.error ?? ''}`);
    return data;
  }

  /** The bot from last time, or a new one: bots outlive the container. */
  async function ensureBot() {
    const me = await api('GET', '/me');
    bot = me.bots.find((b) => b.name === BOT_NAME) ?? me.bots[0] ?? null;
    if (!bot) bot = (await api('POST', '/bots', { name: BOT_NAME })).bot;
    return bot;
  }

  /** What to do with one event from the stream. */
  async function handle(event, data) {
    if (event !== 'command' || data.command !== 'echo') return;
    const text = data.args || '…';
    await api('POST', `/chats/${data.chatId}/messages`, {
      bot: bot.id,
      body: text,
      replyTo: data.messageId,
    });
  }

  /**
   * Reads the event stream until it ends: server-sent events, one frame per
   * blank line, `event:` and `data:` lines in each. Lines starting with `:`
   * are the server saying it is alive.
   */
  async function listen() {
    controller = new AbortController();
    const res = await fetchImpl(`${base}/events`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`events: ${res.status}`);
    const decoder = new TextDecoder();
    let buffer = '';
    for await (const chunk of res.body) {
      buffer += decoder.decode(chunk, { stream: true });
      let end;
      while ((end = buffer.indexOf('\n\n')) !== -1) {
        const frame = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        let event = 'message';
        let data = '';
        for (const line of frame.split('\n')) {
          if (line.startsWith('event: ')) event = line.slice(7);
          else if (line.startsWith('data: ')) data += line.slice(6);
        }
        if (!data) continue;
        await handle(event, JSON.parse(data)).catch((err) => logger.error(`[echo] ${err.message}`));
      }
    }
  }

  return {
    handle,
    /**
     * Runs until stopped, connecting again after a pause whenever the stream
     * ends: Zoia restarting, or the addon being turned off and on.
     */
    async run({ retryMs = 5_000, once = false } = {}) {
      for (;;) {
        try {
          await ensureBot();
          logger.info(`[echo] speaking as ${bot.name}`);
          await listen();
        } catch (err) {
          if (controller?.signal.aborted) return;
          logger.warn(`[echo] ${err.message}; trying again in ${retryMs / 1000}s`);
        }
        if (once || controller?.signal.aborted) return;
        await new Promise((r) => setTimeout(r, retryMs));
      }
    },
    stop() {
      controller?.abort();
    },
    get bot() {
      return bot;
    },
  };
}
