import type { ChatPerson, ShownPresence } from '../../shared/ipc';
import { useAccountAvatar } from '../chat/avatars';
import { byPresence, type Dot } from '../chat/status';
import type { PresenceController } from '../chat/usePresence';
import Avatar from './Avatar';
import { useT } from '../i18n';

/**
 * Everyone on the server, in the sidebar's People tab (ADR 0038): those
 * there first, with their status, then everyone offline, dimmed, each under
 * a heading with how many. Collapsed, only those there show, as pictures.
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
  const listed = byPresence(people, presence.people);
  const isThere = (p: (typeof listed)[number]) => p.status !== 'offline' || p.id === me;
  const groups = [
    { key: 'online', title: t('presence.online'), people: listed.filter(isThere) },
    {
      key: 'offline',
      title: t('presence.offline'),
      people: collapsed ? [] : listed.filter((p) => !isThere(p)),
    },
  ];

  return (
    <section className="member-group people-group">
      {groups.map(
        (group) =>
          group.people.length > 0 && (
            <div className="people-block" key={group.key}>
              {!collapsed && (
                <h2 className="member-heading">
                  {group.title} — {group.people.length}
                </h2>
              )}
              {group.people.map((p) => (
                <Person
                  key={p.id}
                  person={p}
                  status={p.id === me ? (presence.own ?? p.status) : p.status}
                  isMe={p.id === me}
                />
              ))}
            </div>
          ),
      )}
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
