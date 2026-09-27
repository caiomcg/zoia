/**
 * Who is watching whom. LiveKit tells nobody who subscribes to a track, so
 * each client lists the broadcasts it is watching in a participant attribute,
 * and a broadcaster reads everyone's lists to find itself. Attributes rather
 * than metadata, which already carries the broadcast's source label.
 *
 * Kept free of imports so `node --test` can load it directly.
 */

export const WATCHING_ATTRIBUTE = 'zoia.watching';

/**
 * The attribute value for this client. Watching means the picture is flowing:
 * a paused thumbnail, which only grabs the odd snapshot, does not count.
 * Sorted, so an unchanged set never looks like a change worth sending.
 */
export function watchingValue(selected: ReadonlySet<string>, paused: ReadonlySet<string>): string {
  return [...selected]
    .filter((id) => !paused.has(id))
    .sort()
    .join(',');
}

/** Whether a participant's attributes say they are watching `identity`. */
export function isWatching(
  attributes: Readonly<Record<string, string>> | undefined,
  identity: string,
): boolean {
  const value = attributes?.[WATCHING_ATTRIBUTE];
  return Boolean(value) && value!.split(',').includes(identity);
}
