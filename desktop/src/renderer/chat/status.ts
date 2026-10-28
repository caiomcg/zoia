/**
 * Statuses as the sidebar shows them (ADR 0038). Kept apart from the hook,
 * which needs the window, so they can be tested on their own.
 */

import type { ChatPerson, Presence, ShownPresence } from '../../shared/ipc';

/** What a dot can say: how someone is shown, or, on your own, invisible. */
export type Dot = ShownPresence | 'invisible';

/**
 * Your own dot. Invisible is only ever yours to see; otherwise it is what
 * everyone else sees, which is how an idle machine shows you as away. Until
 * the server has said, it is what you chose.
 */
export function ownDot(
  chosen: Presence | null,
  people: Record<string, ShownPresence>,
  me: string | null,
): Dot | null {
  if (!chosen) return null;
  if (chosen === 'invisible') return 'invisible';
  return (me && people[me]) || chosen;
}

/** Everyone, those on the server first, each group by name. */
export function byPresence(
  people: ChatPerson[],
  shown: Record<string, ShownPresence>,
): Array<ChatPerson & { status: ShownPresence }> {
  return people
    .map((p) => ({ ...p, status: shown[p.id] ?? ('offline' as const) }))
    .sort(
      (a, b) =>
        Number(a.status === 'offline') - Number(b.status === 'offline') ||
        a.name.localeCompare(b.name),
    );
}
