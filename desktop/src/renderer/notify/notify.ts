/**
 * Notifications: what happened that you should know about. Inside Zoia they
 * gather under the bell in your bar at the bottom of the sidebar, grouped (three
 * messages from one person are one entry); Windows says them too while Zoia is
 * not the window in front. Each kind can be turned off in either place, in
 * Settings › Notifications; the choice is kept on this machine.
 *
 * The bookkeeping is pure and exported for tests; `notify` is what the app calls.
 */

import { useSyncExternalStore } from 'react';

export type NotifyKind = 'event' | 'direct' | 'mention';

export const NOTIFY_KINDS: readonly NotifyKind[] = ['event', 'direct', 'mention'];

/** Where each kind is said: under the bell, and by Windows. */
export interface NotifyPrefs {
  inApp: Record<NotifyKind, boolean>;
  system: Record<NotifyKind, boolean>;
}

export const DEFAULT_NOTIFY_PREFS: NotifyPrefs = {
  inApp: { event: true, direct: true, mention: true },
  system: { event: true, direct: true, mention: true },
};

const PREFS_KEY = 'zoia.notifications';

/** Preferences from storage, repaired: anything missing or odd is on. */
export function parseNotifyPrefs(raw: string | null): NotifyPrefs {
  let stored: unknown;
  try {
    stored = raw ? JSON.parse(raw) : null;
  } catch {
    stored = null;
  }
  const source = (stored && typeof stored === 'object' ? stored : {}) as Partial<
    Record<'inApp' | 'system', Record<string, unknown>>
  >;
  const read = (place: 'inApp' | 'system') =>
    Object.fromEntries(
      NOTIFY_KINDS.map((kind) => {
        const value = source[place]?.[kind];
        return [kind, typeof value === 'boolean' ? value : DEFAULT_NOTIFY_PREFS[place][kind]];
      }),
    ) as Record<NotifyKind, boolean>;
  return { inApp: read('inApp'), system: read('system') };
}

let prefs: NotifyPrefs = (() => {
  try {
    return parseNotifyPrefs(localStorage.getItem(PREFS_KEY));
  } catch {
    return DEFAULT_NOTIFY_PREFS;
  }
})();
const prefListeners = new Set<() => void>();

export function setNotifyPrefs(next: NotifyPrefs) {
  prefs = next;
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(next));
  } catch {
    // Remembering is a convenience; the choice holds until the app closes.
  }
  for (const listen of prefListeners) listen();
}

export function useNotifyPrefs(): NotifyPrefs {
  return useSyncExternalStore(
    (listen) => {
      prefListeners.add(listen);
      return () => prefListeners.delete(listen);
    },
    () => prefs,
  );
}

// ---- the bell's list ---------------------------------------------------------

/**
 * Where a notification leads: a channel to join, a chat to open, or nowhere.
 * Kept as data, not as a function, so it survives a restart, and so a click
 * acts on the app as it is when clicked, not as it was when it arrived.
 */
export type NotifyTarget =
  | { type: 'channel'; id: string }
  | { type: 'chat'; id: string }
  /** An event: its channel when it has one the app knows, else the event itself. */
  | { type: 'event'; id: string; channelId: string | null };

/** One entry under the bell: one thing, or several of the same grouped. */
export interface InboxItem {
  id: number;
  kind: NotifyKind;
  /** What groups it: the same chat's messages, the same event. */
  group: string;
  title: string;
  /** The latest of the group. */
  body: string;
  /** How many it holds. */
  count: number;
  /** When the latest arrived, in ms since the epoch. */
  at: number;
  read: boolean;
  target?: NotifyTarget;
  /** What clicking it does, in words: "Join Sineminha". */
  actionLabel?: string;
}

/** Entries kept at most; the oldest go. */
export const INBOX_MAX = 50;

/** Entries older than this are forgotten. */
export const INBOX_KEEP_MS = 24 * 60 * 60_000;

/**
 * The list with something new in it, newest first: an unread entry of the
 * same group takes it (one more, the latest words, now); otherwise it is an
 * entry of its own.
 */
export function addToInbox(
  list: InboxItem[],
  item: Omit<InboxItem, 'count' | 'read'>,
): InboxItem[] {
  const same = list.find((x) => x.group === item.group && !x.read);
  const entry: InboxItem = same
    ? {
        ...same,
        title: item.title,
        body: item.body,
        at: item.at,
        target: item.target,
        actionLabel: item.actionLabel,
        count: same.count + 1,
      }
    : { ...item, count: 1, read: false };
  return [entry, ...list.filter((x) => x !== same)].slice(0, INBOX_MAX);
}

/** The list without entries older than a day. The same list when none are. */
export function pruneInbox(list: InboxItem[], now: number): InboxItem[] {
  const kept = list.filter((x) => now - x.at < INBOX_KEEP_MS);
  return kept.length === list.length ? list : kept;
}

/** Entries from storage: well-formed ones under a day old, newest first. */
export function parseInbox(raw: string | null, now: number): InboxItem[] {
  let stored: unknown;
  try {
    stored = raw ? JSON.parse(raw) : null;
  } catch {
    return [];
  }
  if (!Array.isArray(stored)) return [];
  const items = stored.filter(
    (x): x is InboxItem =>
      x !== null &&
      typeof x === 'object' &&
      typeof x.id === 'number' &&
      NOTIFY_KINDS.includes(x.kind) &&
      typeof x.group === 'string' &&
      typeof x.title === 'string' &&
      typeof x.body === 'string' &&
      typeof x.count === 'number' &&
      typeof x.at === 'number' &&
      typeof x.read === 'boolean',
  );
  return pruneInbox(items, now).slice(0, INBOX_MAX);
}

/** How many entries are unread: the bell's badge. */
export const unreadCount = (list: InboxItem[]) => list.filter((x) => !x.read).length;

const INBOX_KEY = 'zoia.notifications.inbox';

let inbox: InboxItem[] = (() => {
  try {
    return parseInbox(localStorage.getItem(INBOX_KEY), Date.now());
  } catch {
    return [];
  }
})();
let nextId = inbox.reduce((max, x) => Math.max(max, x.id), 0) + 1;
const inboxListeners = new Set<() => void>();
const changed = () => {
  try {
    localStorage.setItem(INBOX_KEY, JSON.stringify(inbox));
  } catch {
    // Kept for the session all the same.
  }
  for (const listen of inboxListeners) listen();
};

// A day on, an entry goes, while the app runs too.
const pruning = setInterval(() => {
  const kept = pruneInbox(inbox, Date.now());
  if (kept !== inbox) {
    inbox = kept;
    changed();
  }
}, 5 * 60_000);
// Under Node (the tests) the timer must not keep the process alive.
(pruning as { unref?: () => void }).unref?.();

/** The bell's entries as they are now, for code outside React (and the tests). */
export const currentInbox = () => inbox;

export function useInbox(): InboxItem[] {
  return useSyncExternalStore(
    (listen) => {
      inboxListeners.add(listen);
      return () => inboxListeners.delete(listen);
    },
    () => inbox,
  );
}

export function markAllRead() {
  if (inbox.every((x) => x.read)) return;
  inbox = inbox.map((x) => (x.read ? x : { ...x, read: true }));
  changed();
}

export function clearInbox() {
  inbox = [];
  changed();
}

/**
 * What following a notification does, set by the app as it is now. Kept on
 * the window rather than in this module, so a fresh copy of the module (a
 * reload while developing) still finds the one the app set.
 */
const holder = globalThis as { __zoiaNotifyFollow?: (target: NotifyTarget) => void };

/** The app's way to follow a notification: join its channel, open its chat. */
export function setNotifyHandler(handler: (target: NotifyTarget) => void) {
  holder.__zoiaNotifyFollow = handler;
}

function follow(target: NotifyTarget) {
  const handler = holder.__zoiaNotifyFollow;
  console.info(`[notify] following ${target.type} ${target.id}${handler ? '' : ' (no handler!)'}`);
  handler?.(target);
}

/** Goes where an entry leads, and marks it read. */
export function openInboxItem(id: number) {
  const item = inbox.find((x) => x.id === id);
  if (!item) return;
  inbox = inbox.map((x) => (x.id === id ? { ...x, read: true } : x));
  changed();
  if (item.target) follow(item.target);
  else console.info(`[notify] entry ${id} leads nowhere`);
}

// ---- telling --------------------------------------------------------------

/** Where each Windows notification leads, by its id; forgotten once clicked. */
const clicks = new Map<number, NotifyTarget>();

/**
 * Says something happened: under the bell, and by Windows while Zoia is not
 * in front, each as this machine's settings allow. Clicking either goes to
 * `target`, the Windows one bringing Zoia forward first.
 */
export function notify(
  input: {
    kind: NotifyKind;
    group: string;
    title: string;
    body: string;
    target?: NotifyTarget;
    actionLabel?: string;
  },
  /** Show Windows' one even with Zoia in front: the example in Settings. */
  { evenInFront = false }: { evenInFront?: boolean } = {},
) {
  if (prefs.inApp[input.kind]) {
    inbox = addToInbox(inbox, { ...input, id: nextId++, at: Date.now() });
    changed();
  }
  if (prefs.system[input.kind] && (evenInFront || !document.hasFocus())) {
    const id = nextId++;
    if (input.target) clicks.set(id, input.target);
    void window.zoia.notify.show(id, input.title, input.body).catch(() => false);
  }
}

/** Follows a clicked Windows notification. Call once, when the app starts. */
export function listenForNotificationClicks(): () => void {
  return window.zoia.notify.onClick((id) => {
    const target = clicks.get(id);
    clicks.delete(id);
    if (target) follow(target);
  });
}
