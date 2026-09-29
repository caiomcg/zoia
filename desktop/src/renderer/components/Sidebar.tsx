import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { RoomMember } from '../livekit/useRoom';
import type { RoomInfo } from '../../shared/ipc';
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

/** Whose broadcast is on your stage. */
export interface StageMarks {
  watching: ReadonlySet<string>;
  localWatched: boolean;
}

const COLLAPSED_KEY = 'zoia.sidebarCollapsed';

/** "Room 3" → "R3", "Games" → "GA": what a collapsed sidebar shows. */
function shortName(name: string): string {
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

function IconPencil() {
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

function IconTrash() {
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

/** Naming a channel in place: Enter keeps it, Escape or an empty name drops it. */
function ChannelNameField({
  initial,
  onDone,
}: {
  initial: string;
  onDone: (name: string | null) => void;
}) {
  const t = useT();
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
        placeholder={t('sidebar.channelName')}
        aria-label={t('sidebar.channelName')}
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
  loadingRemoteIds,
  channels,
  currentChannel,
  onJoinChannel,
  maxChannels,
  onCreateChannel,
  onRenameChannel,
  onRemoveChannel,
  stage,
  onHoverBroadcast,
  onWatchBroadcast,
}: {
  members: RoomMember[];
  myName: string;
  /** Yours, for your own profile picture in the footer. */
  myIdentity?: string;
  /** Who is watching your broadcast right now; empty while you are not live. */
  viewerIds: ReadonlySet<string>;
  onOpenSettings: () => void;
  loadingRemoteIds: Set<string>;
  /** Every channel, who is in it and who is live, polled from the server. */
  channels: RoomInfo[];
  currentChannel: string | null;
  onJoinChannel: (id: string) => void;
  /** The most channels the server holds, the default included. */
  maxChannels: number;
  onCreateChannel: (name: string) => void;
  onRenameChannel: (id: string, name: string) => void;
  onRemoveChannel: (id: string) => void;
  stage: StageMarks;
  onHoverBroadcast: (target: GridTarget | null, anchor?: DOMRect) => void;
  onWatchBroadcast: (target: GridTarget) => void;
}) {
  const t = useT();
  // Your own channel is listed from the live room, which is current to the
  // second; the others come from the server's poll. Sharers first.
  const liveMembers = [
    ...members.filter((m) => m.isBroadcasting),
    ...members.filter((m) => !m.isBroadcasting),
  ];
  const here = new Set(members.map((m) => m.identity));
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
                <div key={c.id} className="channel-block">
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
                  </div>
                  {/* Everyone sits under the channel they are in: in full for
                      yours, as faces for the rest, so who is where reads at a
                      glance. */}
                  {current ? (
                    <div className="channel-members">
                      {shownMembers.map(({ item: m, key, leaving }) => (
                        <MemberRow key={key} member={m} leaving={leaving} {...rowProps} />
                      ))}
                    </div>
                  ) : (
                    othersInChannel(c, here).length > 0 && (
                      // Just faces until you join: enough to see who is where.
                      <div className="channel-people">
                        {othersInChannel(c, here).map((p) => (
                          <span key={p.identity} title={p.name}>
                            <Avatar
                              name={p.name}
                              identity={p.identity}
                              live={c.broadcasters.some((b) => b.identity === p.identity)}
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

        {/* Before the first channel poll lands, or against a server without
            channels, the room's people still need a home. */}
        {channels.length === 0 && (
          <section className="member-group">
            <h2 className="member-heading">{t('sidebar.inRoom', { count: liveMembers.length })}</h2>
            {shownMembers.map(({ item: m, key, leaving }) => (
              <MemberRow key={key} member={m} leaving={leaving} {...rowProps} />
            ))}
          </section>
        )}
      </div>

      <div className="sidebar-footer" title={collapsed ? myName : undefined}>
        <Avatar name={myName} identity={myIdentity} live={false} />
        {!collapsed && (
          <span className="sidebar-name" title={myName}>
            {myName}
          </span>
        )}
        <button
          className="icon-button sidebar-settings"
          onClick={onOpenSettings}
          title={t('sidebar.settings')}
          aria-label={t('sidebar.settings')}
        >
          <IconSliders />
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
  leaving,
  viewerIds,
  loadingRemoteIds,
  stage,
  onHover,
  onWatch,
}: {
  member: RoomMember;
  leaving: boolean;
  viewerIds: ReadonlySet<string>;
  loadingRemoteIds: Set<string>;
  stage: StageMarks;
  onHover: (target: GridTarget | null, anchor?: DOMRect) => void;
  onWatch: (target: GridTarget) => void;
}) {
  const t = useT();
  const live = m.isBroadcasting;
  const target = { identity: m.identity, isLocal: m.isLocal };
  const loading = !m.isLocal && loadingRemoteIds.has(m.identity);
  const watching = live && (m.isLocal ? stage.localWatched : stage.watching.has(m.identity));
  const show = (element: HTMLElement) => onHover(target, element.getBoundingClientRect());

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
      onMouseEnter={live ? (event) => show(event.currentTarget) : undefined}
      onMouseLeave={live ? () => onHover(null) : undefined}
      onFocus={live ? (event) => show(event.currentTarget) : undefined}
      onBlur={live ? () => onHover(null) : undefined}
    >
      <span className="avatar-wrap">
        <Avatar name={m.name} identity={m.identity} live={live} />
        {viewerIds.has(m.identity) && <WatchingYou />}
      </span>
      <span className="member-name">{m.name}</span>
      {m.isLocal && <span className="you-tag">{t('common.youTag')}</span>}
      {loading && <span className="stream-state">{t('common.loading')}</span>}
    </div>
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
