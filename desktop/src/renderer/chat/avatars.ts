/**
 * Chat authors' pictures. Authors are accounts rather than people in a room,
 * so they are fetched by account and version, once each, and kept here.
 */

import { useEffect, useSyncExternalStore } from 'react';

// By `${accountId}:${version}`. null means "has none", so it is not asked again.
const images = new Map<string, string | null>();
const pending = new Set<string>();
const listeners = new Set<() => void>();
let revision = 0;

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function load(key: string, accountId: string, version: string) {
  if (images.has(key) || pending.has(key)) return;
  pending.add(key);
  window.zoia.chat
    .avatar(accountId, version)
    .then((image) => {
      images.set(key, image);
      revision += 1;
      for (const listener of listeners) listener();
    })
    .catch(() => {
      // The initials stand in; the next message from them tries again.
    })
    .finally(() => pending.delete(key));
}

/** The picture of an account as a URL to show, or undefined for initials. */
export function useAccountAvatar(
  accountId: string,
  version: string | null | undefined,
): string | undefined {
  useSyncExternalStore(subscribe, () => revision);
  const key = version ? `${accountId}:${version}` : null;
  useEffect(() => {
    if (key && version) load(key, accountId, version);
  }, [key, accountId, version]);
  return key ? (images.get(key) ?? undefined) : undefined;
}
