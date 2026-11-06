/**
 * Notifications' bookkeeping: what is on, read back from storage, and how the
 * bell groups what arrives.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_NOTIFY_PREFS,
  INBOX_MAX,
  INBOX_KEEP_MS,
  addToInbox,
  currentInbox,
  notify,
  openInboxItem,
  parseInbox,
  parseNotifyPrefs,
  pruneInbox,
  setNotifyHandler,
  type NotifyTarget,
  unreadCount,
  type InboxItem,
} from '../src/renderer/notify/notify.ts';
import { CUE_EVENTS, DEFAULT_SOUND_SETTINGS, notesFor } from '../src/renderer/sounds/cues.ts';

describe('notification settings', () => {
  test('everything is on until turned off', () => {
    assert.deepEqual(parseNotifyPrefs(null), DEFAULT_NOTIFY_PREFS);
    assert.deepEqual(parseNotifyPrefs('not json'), DEFAULT_NOTIFY_PREFS);
  });

  test('keep what was chosen, and repair the rest', () => {
    const prefs = parseNotifyPrefs(
      JSON.stringify({ inApp: { direct: false }, system: { event: false, mention: 'no' } }),
    );
    assert.deepEqual(prefs.inApp, { event: true, direct: false, mention: true, alert: true });
    // The app's own errors stay in Zoia unless someone asks for them in Windows.
    assert.deepEqual(prefs.system, { event: false, direct: true, mention: true, alert: false });
  });
});

describe('the bell', () => {
  let id = 0;
  const item = (group: string, body = 'oi') => ({
    id: ++id,
    kind: 'direct' as const,
    group,
    title: 'amon',
    body,
    at: id,
    target: { type: 'chat' as const, id: 'dm-a' },
  });

  test('messages from one person are one entry, counted, with the latest words, on top', () => {
    let list: InboxItem[] = [];
    list = addToInbox(list, item('direct:dm-a', 'oi'));
    list = addToInbox(list, item('mention:c1'));
    list = addToInbox(list, item('direct:dm-a', 'bora?'));
    assert.equal(list.length, 2);
    assert.equal(list[0]!.group, 'direct:dm-a');
    assert.equal(list[0]!.count, 2);
    assert.equal(list[0]!.body, 'bora?');
    assert.equal(unreadCount(list), 2);
  });

  test('once read, the next one starts a new entry', () => {
    let list: InboxItem[] = addToInbox([], item('direct:dm-a'));
    list = list.map((x) => ({ ...x, read: true }));
    list = addToInbox(list, item('direct:dm-a'));
    assert.equal(list.length, 2);
    assert.equal(unreadCount(list), 1);
  });

  test('keeps the newest INBOX_MAX entries', () => {
    let list: InboxItem[] = [];
    for (let i = 0; i < INBOX_MAX + 5; i += 1) list = addToInbox(list, item(`g${i}`));
    assert.equal(list.length, INBOX_MAX);
    assert.equal(list[0]!.group, `g${INBOX_MAX + 4}`);
  });
});

describe('kept between restarts', () => {
  const entry = (at: number, extra: Partial<InboxItem> = {}): InboxItem => ({
    id: at,
    kind: 'event',
    group: `event:${at}`,
    title: 'Jogo',
    body: '#Jeral',
    count: 1,
    at,
    read: false,
    target: { type: 'channel', id: 'jeral' },
    actionLabel: 'Join Jeral',
    ...extra,
  });

  test('what was stored comes back, where it leads included', () => {
    const now = 10 * INBOX_KEEP_MS;
    const stored = JSON.stringify([entry(now - 1000), entry(now - 2000, { read: true })]);
    const back = parseInbox(stored, now);
    assert.equal(back.length, 2);
    assert.deepEqual(back[0]!.target, { type: 'channel', id: 'jeral' });
    assert.equal(back[1]!.read, true);
  });

  test('a day on, an entry is forgotten', () => {
    const now = 10 * INBOX_KEEP_MS;
    const list = [entry(now - 1000), entry(now - INBOX_KEEP_MS)];
    assert.deepEqual(
      pruneInbox(list, now).map((x) => x.at),
      [now - 1000],
    );
    const fresh = [entry(now - 1000)];
    assert.equal(pruneInbox(fresh, now), fresh);
    assert.equal(parseInbox(JSON.stringify(list), now).length, 1);
  });

  test('anything broken in storage is dropped, not trusted', () => {
    const now = 10 * INBOX_KEEP_MS;
    assert.deepEqual(parseInbox('not json', now), []);
    assert.deepEqual(parseInbox('{"a":1}', now), []);
    const odd = JSON.stringify([{ id: 'x' }, entry(now - 5, { kind: 'nope' as never })]);
    assert.deepEqual(parseInbox(odd, now), []);
  });
});

describe('clicking an entry', () => {
  test('goes where it leads, through the handler the app set, and is read', () => {
    // Zoia in front: no Windows notification, only the bell.
    (globalThis as { document?: unknown }).document = { hasFocus: () => true };
    const followed: NotifyTarget[] = [];
    setNotifyHandler((target) => followed.push(target));
    notify({
      kind: 'event',
      group: 'event:e1',
      title: 'Ranqueadinha? is starting',
      body: '#Sineminha',
      target: { type: 'event', id: 'e1', channelId: 'sineminha' },
      actionLabel: 'Join Sineminha',
    });
    const [entry] = currentInbox();
    assert.ok(entry);
    openInboxItem(entry.id);
    assert.deepEqual(followed, [{ type: 'event', id: 'e1', channelId: 'sineminha' }]);
    assert.equal(currentInbox()[0]!.read, true);
  });

  test('the handler set last is the one used, whoever set it', () => {
    const first: string[] = [];
    const second: string[] = [];
    setNotifyHandler((t) => first.push(t.id));
    setNotifyHandler((t) => second.push(t.id));
    notify({
      kind: 'direct',
      group: 'direct:dm-x',
      title: 'amon',
      body: 'oi',
      target: { type: 'chat', id: 'dm-x' },
    });
    openInboxItem(currentInbox()[0]!.id);
    assert.deepEqual(first, []);
    assert.deepEqual(second, ['dm-x']);
  });
});

describe('the event sound', () => {
  test('is a cue of its own, on by default, rising', () => {
    assert.ok(CUE_EVENTS.includes('eventStart'));
    assert.equal(DEFAULT_SOUND_SETTINGS.cues.eventStart.enabled, true);
    const notes = notesFor('eventStart', { style: 'chime', pitch: 0 });
    assert.equal(notes.length, 4);
    assert.ok(notes.every((n, i) => i === 0 || n.frequency > notes[i - 1]!.frequency));
  });
});
