import type { ChatPerson, ShownPresence } from '../../shared/ipc';
import { useAccountAvatar } from '../chat/avatars';
import { byPresence, type Dot } from '../chat/status';
import type { PresenceController } from '../chat/usePresence';
import { SectionHeading, useFolded } from './Sidebar';
import Avatar from './Avatar';
import { useT } from '../i18n';

/**
 * Everyone on the server, under the chats in the sidebar (ADR 0038): those
 * there first, with their status, then everyone offline, dimmed. Collapsed,
 * only those there show, as pictures.
 */
export default function PeopleList({
  people,
  presence,
  me,
  collapsed,
}: {
  /** Everyone let in; the chat's list of who can be @mentioned. */
  people: ChatPerson[];
  presence: PresenceController;
  /** Your account id, whose dot is your own. */
  me: string | null;
  collapsed: boolean;
}) {
  const t = useT();
  const [folded, toggleFolded] = useFolded('people');
  const listed = byPresence(people, presence.people);
  const there = listed.filter((p) => p.status !== 'offline' || p.id === me).length;
  const shown = collapsed ? listed.filter((p) => p.status !== 'offline') : folded ? [] : listed;

  return (
    <section className="member-group people-group">
      {!collapsed && (
        <SectionHeading
          title={t('presence.people')}
          count={there}
          folded={folded}
          onToggle={toggleFolded}
        />
      )}
      {shown.map((p) => (
        <Person
          key={p.id}
          person={p}
          status={p.id === me ? (presence.own ?? p.status) : p.status}
          isMe={p.id === me}
        />
      ))}
    </section>
  );
}

function Person({
  person,
  status,
  isMe,
}: {
  person: ChatPerson & { status: ShownPresence };
  status: Dot;
  isMe: boolean;
}) {
  const t = useT();
  const image = useAccountAvatar(person.id, person.avatar);
  const offline = status === 'offline' || status === 'invisible';
  return (
    <div
      className={`member person${offline ? ' offline' : ''}`}
      title={`${person.name} · ${t(`presence.${status}`)}`}
    >
      <Avatar name={person.name} image={image} live={false} status={status} />
      <span className="member-name">{person.name}</span>
      {isMe && <span className="you-tag">{t('common.youTag')}</span>}
    </div>
  );
}
