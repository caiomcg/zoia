/** In-memory fixtures for the browser preview; loaded only by dev mode with ?demo. */
import type { ZoiaBridge } from '../preload/index.d';
import type { ChatAuthor, ChatEvent, ChatInfo, ChatMessage, PairingStatus } from '../shared/ipc';
import { applyReaction } from './chat/model';

export function installDemo() {
  const me = 'demo-me';
  const status: PairingStatus = {
    paired: true,
    deviceName: 'Você (demo)',
    deviceId: 'demo-device',
    error: null,
    serverUrl: null,
    account: { id: me, email: 'demo@example.invalid', role: 'user', status: 'active' },
  };
  const chats: ChatInfo[] = [
    'Geral',
    'Desenvolvimento',
    'Design',
    'Jogos',
    'Música',
    'Aleatório',
  ].map((name, i) => ({
    id: `demo-${i}`,
    name,
    isDefault: i === 0,
    unread: i === 0 ? 0 : i + 1,
    mentions: i === 2 ? 1 : 0,
  }));
  const authors: Record<string, NonNullable<ChatAuthor>> = {
    [me]: { name: 'Você', avatar: null },
    'demo-ana': { name: 'Ana', avatar: null },
    'demo-bruno': { name: 'Bruno', avatar: null },
  };
  let sequence = 0;
  const id = () => `${(++sequence).toString(16).padStart(8, '0')}-0000-1000-8000-000000000000`;
  const messages = new Map<string, ChatMessage[]>();
  const readers = new Map<string, Record<string, string>>();
  for (const chat of chats) {
    messages.set(chat.id, [
      {
        id: id(),
        chatId: chat.id,
        authorId: 'demo-ana',
        body: `Bem-vindo ao chat ${chat.name}!`,
        sentAt: new Date(Date.now() - 120000).toISOString(),
      },
      {
        id: id(),
        chatId: chat.id,
        authorId: 'demo-bruno',
        body: 'Abra outros chats pela barra lateral para testar as abas. Passe o mouse na aba para ver o botão de fechar.',
        sentAt: new Date(Date.now() - 60000).toISOString(),
      },
    ]);
    readers.set(chat.id, {});
  }
  const listeners = new Set<(event: ChatEvent) => void>();
  const emit = (event: ChatEvent) => listeners.forEach((cb) => cb(structuredClone(event)));
  const ok = <T>(value: T) => Promise.resolve({ ok: true as const, value: structuredClone(value) });
  const done = () => ok(undefined);
  const noop = async () => {};
  const subscribe = () => () => {};
  const unavailable = async () => ({ ok: false as const, error: 'unavailable_in_demo' });
  const unsupported = async (): Promise<never> => {
    throw new Error('Disponível apenas no aplicativo conectado a um servidor.');
  };
  const shortcuts = {
    available: false,
    bindings: { pushToTalk: null, toggleMute: null, toggleDeafen: null },
  };

  const bridge: ZoiaBridge = {
    pairing: { status: async () => status, onChange: subscribe },
    account: {
      signIn: unavailable,
      signUp: unavailable,
      setBirthday: unavailable,
      redeem: unavailable,
      refresh: async () => status,
      signOut: async () => status,
      changePassword: unavailable,
      devices: () => ok([]),
      removeDevice: unavailable,
    },
    addons: {
      list: unavailable,
      preview: unavailable,
      install: unavailable,
      enable: unavailable,
      disable: unavailable,
      update: unavailable,
      uninstall: unavailable,
      settings: unavailable,
      commands: unavailable,
      chats: unavailable,
      logs: unavailable,
    },
    admin: {
      accounts: () => ok([]),
      bots: () => ok([]),
      setBotAvatar: unavailable,
      removeBotAvatar: unavailable,
      act: unavailable,
      moveDevice: unavailable,
      kickDevice: unavailable,
    },
    token: { get: unsupported },
    rooms: {
      setAway: unavailable,
      list: async () => ({
        rooms: [
          { id: 'demo-stage', name: 'Geral', isDefault: true, participants: [], broadcasters: [] },
        ],
        max: 10,
        ceiling: 20,
      }),
      create: unavailable,
      rename: unavailable,
      remove: unavailable,
      setLimit: unavailable,
    },
    stage: { get: unsupported, claim: unsupported, release: async () => ({ ok: true }) },
    voice: { join: async () => false, leave: async () => ({ ok: true }) },
    shortcuts: {
      get: async () => shortcuts,
      record: async () => null,
      cancel: noop,
      clear: async () => shortcuts,
      onFire: subscribe,
    },
    soundboard: { search: async () => null, sound: async () => null },
    sources: {
      list: async () => [],
      instant: async () => [],
      select: noop,
      title: async () => null,
      league: async () => ({ game: null, client: null }),
      windows: async () => [],
    },
    browserVideo: {
      status: async () => [],
      fix: async () => ({ ok: false as const, reason: 'unsupported' as const }),
      undo: async () => ({ ok: false as const, reason: 'unsupported' as const }),
    },
    encoder: { start: unsupported, stop: noop, onStatus: subscribe },
    nativeVideo: {
      start: unsupported,
      stop: noop,
      requestKeyframe: noop,
      setBitrate: noop,
      onError: subscribe,
    },
    device: {
      rename: unavailable,
      setAvatar: unsupported,
      removeAvatar: async () => ({ ok: true }),
    },
    avatars: { get: async () => null },
    chat: {
      list: () => ok({ chats, available: true, max: 10, ceiling: 20 }),
      create: unavailable,
      rename: unavailable,
      remove: unavailable,
      setLimit: unavailable,
      messages: (chatId) =>
        ok({
          messages: messages.get(chatId) ?? [],
          authors,
          readers: readers.get(chatId) ?? {},
          hasMore: false,
        }),
      send: (chatId, body, extras) => {
        const message: ChatMessage = {
          id: id(),
          chatId,
          authorId: me,
          body,
          sentAt: new Date().toISOString(),
          mentions: (extras?.mentions ?? []).map((id) => ({ id, name: authors[id]?.name ?? id })),
        };
        const reply = messages.get(chatId)?.find((m) => m.id === extras?.replyTo);
        if (reply) message.replyTo = { id: reply.id, authorId: reply.authorId, body: reply.body };
        messages.get(chatId)?.push(message);
        emit({ type: 'message', message, author: authors[me]! });
        return ok({ message, author: authors[me]! });
      },
      sendMedia: unavailable,
      people: () => ok(Object.entries(authors).map(([id, author]) => ({ id, ...author }))),
      commands: () => ok([]),
      direct: unavailable,
      typing: done,
      deleteMessage: (chatId, messageId) => {
        messages.set(
          chatId,
          (messages.get(chatId) ?? []).filter((m) => m.id !== messageId),
        );
        emit({ type: 'deleted', chatId, messageId });
        return done();
      },
      editMessage: (chatId, messageId, body) => {
        const message = messages.get(chatId)?.find((m) => m.id === messageId);
        if (!message) return unavailable();
        message.body = body;
        message.editedAt = new Date().toISOString();
        emit({ type: 'edited', chatId, message });
        return ok(message);
      },
      saveMedia: unavailable,
      copyMedia: unavailable,
      gifs: unavailable,
      react: (chatId, messageId, emoji, on) => {
        const message = messages.get(chatId)?.find((m) => m.id === messageId);
        if (message) message.reactions = applyReaction(message.reactions, emoji, me, on);
        emit({
          type: 'reaction',
          chatId,
          messageId,
          emoji,
          accountId: me,
          on,
          reactor: authors[me]!,
        });
        return done();
      },
      read: (chatId, messageId) => {
        readers.set(chatId, { ...readers.get(chatId), [me]: messageId });
        const chat = chats.find((c) => c.id === chatId);
        if (chat) {
          chat.unread = 0;
          chat.mentions = 0;
        }
        return done();
      },
      listen: noop,
      onEvent: (cb) => {
        listeners.add(cb);
        return () => {
          listeners.delete(cb);
        };
      },
      avatar: async () => null,
    },
    notify: { show: async () => false, onClick: subscribe },
    schedule: {
      list: () => ok([]),
      create: unavailable,
      update: unavailable,
      remove: unavailable,
      rsvp: unavailable,
    },
    presence: {
      get: () =>
        ok({
          status: 'online' as const,
          people: {
            'demo-me': 'online' as const,
            'demo-ana': 'online' as const,
            'demo-bruno': 'away' as const,
          },
        }),
      set: (status) => ok({ status }),
    },
    report: () => {},
    gpu: {
      status: async () => ({
        hardwareEncoder: false,
        windowCapture: false,
        encoderReason: null,
        adapter: 'Preview',
        gpuVendor: '',
        gpuEncoder: 'none',
      }),
    },
    updater: {
      config: async () => ({ repository: '', checkOnStartup: false }),
      save: async (config) => config,
      reset: async () => ({ repository: '' }),
      check: async () => ({ status: 'disabled' }),
      install: noop,
      openInstaller: noop,
      releaseNotes: async () => null,
    },
    app: {
      version: async () => '0.0.0-demo',
      elevated: async () => false,
      restartUnelevated: async () => false,
      emojiPanel: noop,
      platform: 'linux',
    },
    language: {
      get: async () => ({ preference: 'pt', language: 'pt', system: 'pt' }),
      set: async (preference) => ({
        preference,
        language: preference === 'system' ? 'pt' : preference,
        system: 'pt',
      }),
    },
    tray: { closeToTray: async () => false, setCloseToTray: async (value) => value },
    devTools: { isEnabled: async () => false, setEnabled: async (value) => value, open: noop },
    audio: { start: unsupported, stop: noop, onChunk: subscribe },
  };
  window.zoia = bridge;
}
