import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type HTMLAttributes,
  type ReactNode,
} from 'react';
import type { RoomMember } from '../livekit/useRoom';
import type { AccountRole, RoomInfo } from '../../shared/ipc';
import type { GridTarget } from './RemoteGrid';
import Avatar from './Avatar';
import { IconEye } from './Player';
import { useT } from '../i18n';
import { useLeaving } from '../presence';

/**
 * Who is in the room, and who is sharing. Your own name sits in the footer,
 * next to the way into Settings, which is where it is changed.
 *
 * It is also where broadcasts are found: hovering someone sharing shows their
 * thumbnail beside the list, and clicking them puts them on stage, where their
 * avatar's ring turns from green to the accent. See GridControls in RemoteGrid.
 */

/** Whose broadcast is on your stage, and whose camera. */
export interface StageMarks {
  watching: ReadonlySet<string>;
  cameras: ReadonlySet<string>;
  localWatched: boolean;
}

const COLLAPSED_KEY = 'zoia.sidebarCollapsed';

/** What a person dragged onto a channel carries: their identity. */
const DRAG_TYPE = 'application/x-zoia-member';

/** "Room 3" → "R3", "Games" → "GA": what a collapsed sidebar shows. */
export function shortName(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length > 1) return (words[0]![0]! + words[words.length - 1]!.slice(0, 2)).toUpperCase();
  return name.slice(0, 2).toUpperCase();
}

function readCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSED_KEY) === 'true';
  } catch {
    return false;
  }
}

function IconPanel({ collapsed }: { collapsed: boolean }) {
  // Points the way the panel will move: out when collapsed, in when open.
  return (
    <svg
      viewBox="0 0 24 24"
      width="16"
      height="16"
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d={collapsed ? 'M15 6l-6 6 6 6' : 'M9 6l6 6-6 6'} />
    </svg>
  );
}

export function IconPencil() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="14"
      height="14"
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M4 20h4L19 9l-4-4L4 16v4zM13.5 6.5l4 4" />
    </svg>
  );
}

export function IconTrash() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="14"
      height="14"
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13" />
    </svg>
  );
}

/**
 * How many channels or chats there may be, for an admin to change: "3 of 5"
 * between a minus and a plus. The server checks the role and the range again.
 */
export function LimitStepper({
  count,
  max,
  ceiling,
  onChange,
  title,
  less,
  more,
}: {
  count: number;
  max: number;
  ceiling: number;
  onChange: (max: number) => void;
  title: string;
  less: string;
  more: string;
}) {
  const t = useT();
  return (
    <span className="chat-limit" title={title}>
      <button
        className="channel-action"
        disabled={max <= 1}
        onClick={() => onChange(max - 1)}
        aria-label={less}
        title={less}
      >
        −
      </button>
      <span className="chat-limit-value">{t('chat.limitValue', { count, max })}</span>
      <button
        className="channel-action"
        disabled={max >= ceiling}
        onClick={() => onChange(max + 1)}
        aria-label={more}
        title={more}
      >
        +
      </button>
    </span>
  );
}

/** Naming a channel in place: Enter keeps it, Escape or an empty name drops it. */
export function ChannelNameField({
  initial,
  onDone,
  label,
}: {
  initial: string;
  onDone: (name: string | null) => void;
  /** What the field names; a channel unless said otherwise. */
  label?: string;
}) {
  const t = useT();
  const name = label ?? t('sidebar.channelName');
  const [value, setValue] = useState(initial);
  const inputRef = useRef<HTMLInputElement>(null);
  // Enter, then the blur that follows it, must not create the channel twice.
  const doneRef = useRef(false);
  const finish = (name: string | null) => {
    if (doneRef.current) return;
    doneRef.current = true;
    onDone(name);
  };

  useEffect(() => {
    inputRef.current?.select();
  }, []);

  return (
    <div className="channel-edit">
      <input
        ref={inputRef}
        value={value}
        maxLength={32}
        placeholder={name}
        aria-label={name}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') finish(value.trim() || null);
          if (event.key === 'Escape') finish(null);
        }}
        onBlur={() => finish(value.trim() || null)}
      />
    </div>
  );
}

export default function Sidebar({
  members,
  myName,
  myIdentity,
  viewerIds,
  onOpenSettings,
  settingsBadge = 0,
  myRole,
  loadingRemoteIds,
  channels,
  currentChannel,
  onJoinChannel,
  onLeaveChannel,
  maxChannels,
  channelCeiling = maxChannels,
  onSetChannelLimit,
  onCreateChannel,
  onRenameChannel,
  onRemoveChannel,
  onMoveMember,
  stage,
  onHoverBroadcast,
  onWatchBroadcast,
  onToggleCamera,
  chats,
  onDisconnectMember,
}: {
  members: RoomMember[];
  myName: string;
  /** Yours, for your own profile picture in the footer. */
  myIdentity?: string;
  /** Who is watching your broadcast right now; empty while you are not live. */
  viewerIds: ReadonlySet<string>;
  onOpenSettings: () => void;
  /** Sign-ups waiting for an admin; shown on the settings button. */
  settingsBadge?: number;
  /** Yours, shown beside your name; nothing for a plain user. */
  myRole?: AccountRole;
  loadingRemoteIds: Set<string>;
  /** Every channel, who is in it and who is live, polled from the server. */
  channels: RoomInfo[];
  currentChannel: string | null;
  onJoinChannel: (id: string) => void;
  onLeaveChannel: () => void;
  /** The most channels the server holds, the default included. */
  maxChannels: number;
  /** The most channels an admin may allow. */
  channelCeiling?: number;
  /** Admins only: how many channels there may be. */
  onSetChannelLimit?: (max: number) => void;
  onCreateChannel: (name: string) => void;
  onRenameChannel: (id: string, name: string) => void;
  onRemoveChannel: (id: string) => void;
  /** Someone dropped on a channel: yourself, or, for an admin, someone else. */
  onMoveMember: (identity: string, channelId: string) => void;
  stage: StageMarks;
  onHoverBroadcast: (target: GridTarget | null, anchor?: DOMRect) => void;
  onWatchBroadcast: (target: GridTarget) => void;
  /** Puts someone's camera on stage, or takes it off again. */
  onToggleCamera: (identity: string) => void;
  /** The text chats (ADR 0036), listed under the channels. */
  chats?: (collapsed: boolean) => ReactNode;
  /** Admins only: takes someone out of the channel they are in. */
  onDisconnectMember?: (identity: string, name: string) => void;
}) {
  const t = useT();
  const canManageChannels = myRole === 'admin' || myRole === 'super_admin';
  // Your own channel is listed from the live room, which is current to the
  // second; the others come from the server's poll. Sharers first.
  const liveMembers = [
    ...members.filter((m) => m.isBroadcasting),
    ...members.filter((m) => !m.isBroadcasting),
  ];
  const here = new Set(members.map((m) => m.identity));
  // Who the admins are, from the server's channel poll: the live room only
  // knows what each client says about itself, and a role is not that.
  const roles = new Map<string, AccountRole>();
  for (const c of channels) {
    for (const p of c.participants) if (p.role) roles.set(p.identity, p.role);
  }
  const roleOf = (m: RoomMember) => (m.isLocal ? myRole : roles.get(m.identity));

  // Dragging a person onto a channel moves them there. Anyone may drag
  // themselves, which is the same as clicking the channel; an admin may drag
  // whoever they could manage in Settings. The server checks that again.
  const [dragging, setDragging] = useState<{ identity: string; from: string | null } | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  // Only someone strictly below you: admins and the super admin are each
  // other's equals or betters, and move themselves. Someone the server's list
  // has not shown yet has no known role, so they wait until it has.
  const listed = new Set(channels.flatMap((c) => c.participants.map((p) => p.identity)));
  const mayDrag = (identity: string, role?: AccountRole) =>
    identity === myIdentity ||
    (canManageChannels &&
      listed.has(identity) &&
      role !== 'super_admin' &&
      (role !== 'admin' || myRole === 'super_admin'));
  // Disconnecting someone follows the same rule, but never yourself: leaving
  // is the button in the footer.
  const mayDisconnect = (identity: string, role?: AccountRole) =>
    Boolean(onDisconnectMember) && identity !== myIdentity && mayDrag(identity, role);
  const dragFrom = (
    identity: string,
    role: AccountRole | undefined,
    from: string | null,
  ): HTMLAttributes<HTMLElement> =>
    mayDrag(identity, role)
      ? {
          draggable: true,
          onDragStart: (event) => {
            event.dataTransfer.setData(DRAG_TYPE, identity);
            event.dataTransfer.effectAllowed = 'move';
            setDragging({ identity, from });
            onHoverBroadcast(null);
          },
          onDragEnd: () => {
            setDragging(null);
            setDropTarget(null);
          },
        }
      : {};
  const dropOn = (channelId: string): HTMLAttributes<HTMLElement> =>
    dragging && dragging.from !== channelId
      ? {
          onDragOver: (event) => {
            event.preventDefault();
            event.dataTransfer.dropEffect = 'move';
            setDropTarget(channelId);
          },
          onDragLeave: (event) => {
            if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
            setDropTarget((previous) => (previous === channelId ? null : previous));
          },
          onDrop: (event) => {
            event.preventDefault();
            const identity = event.dataTransfer.getData(DRAG_TYPE);
            setDragging(null);
            setDropTarget(null);
            if (identity) onMoveMember(identity, channelId);
          },
        }
      : {};

  // Someone who leaves fades out rather than vanishing; see presence.ts.
  const shownMembers = useLeaving(liveMembers, (m) => m.identity, currentChannel ?? '');

  // Collapsed keeps only the avatars; names move into tooltips.
  const [collapsed, setCollapsed] = useState(readCollapsed);

  function toggleCollapsed() {
    setCollapsed((current) => {
      try {
        localStorage.setItem(COLLAPSED_KEY, String(!current));
      } catch {
        // Remembering is a convenience; the toggle still works.
      }
      return !current;
    });
  }

  const rowProps = {
    viewerIds,
    loadingRemoteIds,
    stage,
    onHover: onHoverBroadcast,
    onWatch: onWatchBroadcast,
    onToggleCamera,
    collapsed,
  };
  // Which channel is being renamed, or 'new' while one is being named.
  const [editing, setEditing] = useState<string | null>(null);

  // The current channel's highlight is one element that glides from channel
  // to channel on a hop, instead of jumping. It only glides for a hop: when
  // the sidebar opens (its width animates) or a member list above shifts a
  // channel, it follows the button's size and place at once, through a
  // ResizeObserver, since a single measurement mid-animation is stale.
  // Collapsed, the current channel is marked by a ring on its badge instead.
  const channelGroupRef = useRef<HTMLElement>(null);
  const [indicator, setIndicator] = useState<{
    top: number;
    left: number;
    width: number;
    height: number;
    animate: boolean;
  } | null>(null);
  const placedChannel = useRef<string | null>(null);
  useLayoutEffect(() => {
    const group = channelGroupRef.current;
    if (collapsed || !group) {
      placedChannel.current = null;
      setIndicator(null);
      return undefined;
    }
    const measure = () => {
      const button = group.querySelector<HTMLElement>('.channel.current');
      if (!button) {
        placedChannel.current = null;
        setIndicator((previous) => (previous ? null : previous));
        return;
      }
      const outer = group.getBoundingClientRect();
      const inner = button.getBoundingClientRect();
      const next = {
        top: inner.top - outer.top,
        left: inner.left - outer.left,
        width: inner.width,
        height: inner.height,
      };
      // A glide only when the channel itself changed and one was placed.
      const hop = placedChannel.current !== null && placedChannel.current !== currentChannel;
      placedChannel.current = currentChannel;
      setIndicator((previous) =>
        previous &&
        previous.top === next.top &&
        previous.left === next.left &&
        previous.width === next.width &&
        previous.height === next.height
          ? previous
          : { ...next, animate: hop },
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(group);
    return () => observer.disconnect();
  }, [channels, currentChannel, collapsed, editing, members]);

  return (
    <aside className={`sidebar${collapsed ? ' collapsed' : ''}`}>
      <div className="sidebar-header">
        <button
          className="sidebar-toggle"
          onClick={toggleCollapsed}
          aria-expanded={!collapsed}
          title={collapsed ? t('sidebar.expand') : t('sidebar.collapse')}
          aria-label={collapsed ? t('sidebar.expand') : t('sidebar.collapse')}
        >
          <IconPanel collapsed={collapsed} />
        </button>
        {/* On the arrow's line rather than a row of its own below it. */}
        {!collapsed && channels.length > 0 && (
          <h2 className="sidebar-title">{t('sidebar.channels')}</h2>
        )}
        {!collapsed && channels.length > 0 && canManageChannels && onSetChannelLimit && (
          <LimitStepper
            count={channels.length}
            max={maxChannels}
            ceiling={channelCeiling}
            onChange={onSetChannelLimit}
            title={t('sidebar.limitTitle')}
            less={t('sidebar.limitLess')}
            more={t('sidebar.limitMore')}
          />
        )}
      </div>
      <div className="sidebar-scroll">
        {channels.length > 0 && (
          <section
            className={`member-group channel-group${indicator ? ' has-indicator' : ''}`}
            ref={channelGroupRef}
          >
            {indicator && (
              <span
                className={`channel-indicator${indicator.animate ? ' animate' : ''}`}
                aria-hidden="true"
                style={{
                  transform: `translate(${indicator.left}px, ${indicator.top}px)`,
                  width: indicator.width,
                  height: indicator.height,
                }}
              />
            )}
            {channels.map((c) => {
              const current = c.id === currentChannel;
              if (editing === c.id) {
                return (
                  <ChannelNameField
                    key={c.id}
                    initial={c.name}
                    onDone={(name) => {
                      setEditing(null);
                      if (name && name !== c.name) onRenameChannel(c.id, name);
                    }}
                  />
                );
              }
              return (
                <div
                  key={c.id}
                  className={`channel-block${dropTarget === c.id ? ' drop-target' : ''}`}
                  {...dropOn(c.id)}
                >
                  <div className="channel-row">
                    <button
                      className={`channel${current ? ' current' : ''}`}
                      onClick={() => onJoinChannel(c.id)}
                      aria-current={current ? 'true' : undefined}
                      // Only when collapsed, where the name is hidden. Expanded, the
                      // name is on screen, and the tooltip only popped up over the
                      // faces listed under the channel.
                      title={
                        !collapsed
                          ? undefined
                          : current
                            ? t('sidebar.youAreHere', { channel: c.name })
                            : c.participants.length === 1
                              ? t('sidebar.joinOne', { channel: c.name })
                              : t('sidebar.joinMany', {
                                  channel: c.name,
                                  count: c.participants.length,
                                })
                      }
                    >
                      <span className="channel-short" aria-hidden="true">
                        {shortName(c.name)}
                      </span>
                      <span className="channel-name">{c.name}</span>
                      <span className="channel-count">
                        {current ? liveMembers.length : othersInChannel(c, here).length}
                      </span>
                    </button>
                    {/* Admins only: the server refuses anyone else anyway. */}
                    {canManageChannels && (
                      <span className="channel-actions">
                        <button
                          className="channel-action"
                          onClick={() => setEditing(c.id)}
                          title={t('sidebar.rename', { channel: c.name })}
                          aria-label={t('sidebar.rename', { channel: c.name })}
                        >
                          <IconPencil />
                        </button>
                        {/* Only an empty channel that is not the default. */}
                        {!c.isDefault && c.participants.length === 0 && (
                          <button
                            className="channel-action"
                            onClick={() => onRemoveChannel(c.id)}
                            title={t('sidebar.delete', { channel: c.name })}
                            aria-label={t('sidebar.delete', { channel: c.name })}
                          >
                            <IconTrash />
                          </button>
                        )}
                      </span>
                    )}
                  </div>
                  {/* Everyone sits under the channel they are in: in full for
                      yours, as faces for the rest, so who is where reads at a
                      glance. */}
                  {current ? (
                    <div className="channel-members">
                      {shownMembers.map(({ item: m, key, leaving }) => (
                        <MemberRow
                          key={key}
                          member={m}
                          role={roleOf(m)}
                          leaving={leaving}
                          drag={leaving ? {} : dragFrom(m.identity, roleOf(m), c.id)}
                          onDisconnect={
                            !leaving && mayDisconnect(m.identity, roleOf(m))
                              ? () => onDisconnectMember?.(m.identity, m.name)
                              : undefined
                          }
                          {...rowProps}
                        />
                      ))}
                    </div>
                  ) : (
                    othersInChannel(c, here).length > 0 && (
                      // Just faces until you join: enough to see who is where.
                      <div className="channel-people">
                        {othersInChannel(c, here).map((p) => (
                          <span
                            key={p.identity}
                            title={[
                              p.role ? `${p.name} · ${t(`account.role.${p.role}`)}` : p.name,
                              ...(mayDisconnect(p.identity, p.role)
                                ? [t('sidebar.disconnectHint')]
                                : []),
                            ].join('\n')}
                            onContextMenu={
                              mayDisconnect(p.identity, p.role)
                                ? (event) => {
                                    event.preventDefault();
                                    onDisconnectMember?.(p.identity, p.name);
                                  }
                                : undefined
                            }
                            {...dragFrom(p.identity, p.role, c.id)}
                          >
                            <Avatar
                              name={p.name}
                              identity={p.identity}
                              live={c.broadcasters.some((b) => b.identity === p.identity)}
                              role={p.role}
                            />
                          </span>
                        ))}
                      </div>
                    )
                  )}
                </div>
              );
            })}
            {editing === 'new' ? (
              <ChannelNameField
                initial=""
                onDone={(name) => {
                  setEditing(null);
                  if (name) onCreateChannel(name);
                }}
              />
            ) : (
              canManageChannels &&
              channels.length < maxChannels && (
                <button
                  className="channel channel-new"
                  onClick={() => setEditing('new')}
                  title={t('sidebar.newChannelTitle', { count: channels.length, max: maxChannels })}
                >
                  <span className="channel-short" aria-hidden="true">
                    +
                  </span>
                  <span className="channel-name">{t('sidebar.newChannel')}</span>
                </button>
              )
            )}
          </section>
        )}

        {chats?.(collapsed)}

        {/* Before the first channel poll lands, or against a server without
            channels, the room's people still need a home. */}
        {channels.length === 0 && (
          <section className="member-group">
            <h2 className="member-heading">{t('sidebar.inRoom', { count: liveMembers.length })}</h2>
            {shownMembers.map(({ item: m, key, leaving }) => (
              <MemberRow key={key} member={m} role={roleOf(m)} leaving={leaving} {...rowProps} />
            ))}
          </section>
        )}
      </div>

      <div className="sidebar-footer" title={collapsed ? myName : undefined}>
        <Avatar name={myName} identity={myIdentity} live={false} role={myRole} />
        {!collapsed && (
          <span className="sidebar-name" title={myName}>
            {myName}
          </span>
        )}
        {/* Only while in a channel: outside one there is nothing to leave. */}
        {currentChannel !== null && (
          <button
            className="icon-button sidebar-settings sidebar-leave"
            onClick={onLeaveChannel}
            title={t('sidebar.leave')}
            aria-label={t('sidebar.leave')}
          >
            <IconLeave />
          </button>
        )}
        <button
          className="icon-button sidebar-settings"
          onClick={onOpenSettings}
          title={
            settingsBadge > 0
              ? t('sidebar.settingsPending', { count: settingsBadge })
              : t('sidebar.settings')
          }
          aria-label={
            settingsBadge > 0
              ? t('sidebar.settingsPending', { count: settingsBadge })
              : t('sidebar.settings')
          }
        >
          <IconSliders />
          {settingsBadge > 0 && (
            <span className="settings-dot" aria-hidden="true">
              {settingsBadge}
            </span>
          )}
        </button>
      </div>
    </aside>
  );
}

/**
 * One person in your channel. Someone sharing is the way to their broadcast:
 * hovering shows its thumbnail beside the list, clicking puts it on stage.
 */
function MemberRow({
  member: m,
  role,
  leaving,
  drag,
  viewerIds,
  loadingRemoteIds,
  stage,
  onHover,
  onWatch,
  onToggleCamera,
  collapsed,
  onDisconnect,
}: {
  /** Admins only, for someone they may disconnect. */
  onDisconnect?: () => void;
  member: RoomMember;
  role?: AccountRole;
  leaving: boolean;
  /** Present when this person may be dragged onto another channel. */
  drag?: HTMLAttributes<HTMLElement>;
  viewerIds: ReadonlySet<string>;
  loadingRemoteIds: Set<string>;
  stage: StageMarks;
  onHover: (target: GridTarget | null, anchor?: DOMRect) => void;
  onWatch: (target: GridTarget) => void;
  onToggleCamera: (identity: string) => void;
  /** The list is down to avatars, with no room for the camera button. */
  collapsed: boolean;
}) {
  const t = useT();
  // The row is the way to someone's screen. Their camera never opens by
  // itself, nor from the row: it has its own button, beside their name.
  const live = m.sharesScreen;
  // Not on your own row: your camera is always in your grid while it is on.
  const camera = m.hasCamera && !m.isLocal;
  const cameraShown = camera && stage.cameras.has(m.identity);
  const target = { identity: m.identity, isLocal: m.isLocal };
  const loading = !m.isLocal && loadingRemoteIds.has(m.identity);
  const watching = live && (m.isLocal ? stage.localWatched : stage.watching.has(m.identity));
  const show = (element: HTMLElement) => onHover(target, element.getBoundingClientRect());
  // Hovering shows their card: their screen's thumbnail, and, with a camera
  // on, its button. Collapsed, that card is the only place the button is, so
  // someone with just a camera on gets one too.
  const hoverable = live || (collapsed && camera);

  return (
    <div
      className={`member${live ? ' live' : ''}${watching ? ' watching' : ''}${leaving ? ' leaving' : ''}`}
      // A live row's name and state are in its thumbnail; a tooltip would
      // only pop up over it.
      title={live ? undefined : m.isLocal ? `${m.name} (${t('common.youTag')})` : m.name}
      role={live ? 'button' : undefined}
      tabIndex={live ? 0 : undefined}
      aria-label={live ? t('sidebar.watchLive', { name: m.name }) : undefined}
      onClick={live ? () => onWatch(target) : undefined}
      onKeyDown={
        live
          ? (event) => {
              if (event.key !== 'Enter' && event.key !== ' ') return;
              event.preventDefault();
              onWatch(target);
            }
          : undefined
      }
      onMouseEnter={hoverable ? (event) => show(event.currentTarget) : undefined}
      onMouseLeave={hoverable ? () => onHover(null) : undefined}
      onFocus={hoverable ? (event) => show(event.currentTarget) : undefined}
      onBlur={hoverable ? () => onHover(null) : undefined}
      {...drag}
    >
      <span className="avatar-wrap">
        <Avatar name={m.name} identity={m.identity} live={live} role={role} />
        {viewerIds.has(m.identity) && <WatchingYou />}
      </span>
      <span className="member-name">{m.name}</span>
      {m.isLocal && <span className="you-tag">{t('common.youTag')}</span>}
      {loading && <span className="stream-state">{t('common.loading')}</span>}
      {camera && (
        <CameraToggle
          className="member-camera"
          name={m.name}
          shown={cameraShown}
          onToggle={() => onToggleCamera(m.identity)}
        />
      )}
      {onDisconnect && !collapsed && (
        <button
          className="member-disconnect"
          onClick={(event) => {
            event.stopPropagation();
            onDisconnect();
          }}
          title={t('sidebar.disconnect', { name: m.name })}
          aria-label={t('sidebar.disconnect', { name: m.name })}
        >
          <svg
            viewBox="0 0 24 24"
            width="14"
            height="14"
            aria-hidden="true"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M15 4h4a1 1 0 011 1v14a1 1 0 01-1 1h-4M10 16l-4-4 4-4M6 12h10" />
          </svg>
        </button>
      )}
    </div>
  );
}

/**
 * Puts someone's camera on the stage, or takes it off. At the end of their
 * row, in the open list only: the collapsed one has no room for it beside the
 * avatar, so a camera is put on from the open list.
 */
function CameraToggle({
  className,
  name,
  shown,
  onToggle,
}: {
  className: string;
  name: string;
  shown: boolean;
  onToggle: () => void;
}) {
  const t = useT();
  const label = shown ? t('sidebar.hideCamera', { name }) : t('sidebar.showCamera', { name });
  return (
    <button
      className={`${className}${shown ? ' active' : ''}`}
      aria-pressed={shown}
      title={label}
      aria-label={label}
      // The row behind it opens their screen; this is the camera only.
      onClick={(event) => {
        event.stopPropagation();
        onToggle();
      }}
      onKeyDown={(event) => event.stopPropagation()}
    >
      <svg
        viewBox="0 0 24 24"
        width="16"
        height="16"
        aria-hidden="true"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinejoin="round"
      >
        <rect x="2.5" y="6" width="13" height="12" rx="2" />
        <path d="M15.5 11l6-3.5v9l-6-3.5z" />
      </svg>
    </button>
  );
}

/**
 * A channel's people from the server's poll, sharers first. Anyone already in
 * `here` is left out: the live room knows the moment someone arrives, while
 * the poll can still list them where they came from.
 */
function othersInChannel(channel: RoomInfo, here: ReadonlySet<string>): RoomInfo['participants'] {
  const live = new Set(channel.broadcasters.map((b) => b.identity));
  const people = channel.participants.filter((p) => !here.has(p.identity));
  return [
    ...people.filter((p) => live.has(p.identity)),
    ...people.filter((p) => !live.has(p.identity)),
  ];
}

function WatchingYou() {
  const t = useT();
  return (
    <span
      className="watching-you"
      title={t('sidebar.watchingYou')}
      aria-label={t('sidebar.watchingYou')}
    >
      <IconEye />
    </span>
  );
}

/** A door with an arrow leaving through it. */
function IconLeave() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="18"
      height="18"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M10 4H5v16h5M14 8l4 4-4 4M18 12H9" />
    </svg>
  );
}

/** Two sliders: lighter than a gear at this size. */
function IconSliders() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="18"
      height="18"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d="M4 8h9M17 8h3M4 16h3M11 16h9" />
      <circle cx="15" cy="8" r="2" />
      <circle cx="9" cy="16" r="2" />
    </svg>
  );
}
