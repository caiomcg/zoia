import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type HTMLAttributes,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import type { RoomMember } from '../livekit/useRoom';
import type { AccountRole, RoomInfo } from '../../shared/ipc';
import type { GridTarget } from './RemoteGrid';
import Avatar from './Avatar';
import { IconEye } from './Player';
import StatusMenu from './StatusMenu';
import { useT } from '../i18n';
import { useLeaving } from '../presence';
import type { PresenceController } from '../chat/usePresence';

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
  // By whole characters: an emoji is two or more code units, and half of one
  // shows as nothing. A name that starts with one shows just that emoji.
  const chars = (s: string) => [...SEGMENTER.segment(s)].map((g) => g.segment);
  const first = chars(name.trim())[0] ?? '';
  if (/\p{Extended_Pictographic}/u.test(first)) return first;
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length > 1) {
    const last = chars(words[words.length - 1]!);
    return (chars(words[0]!)[0]! + last.slice(0, 2).join('')).toUpperCase();
  }
  return chars(name).slice(0, 2).join('').toUpperCase();
}

const SEGMENTER = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

function readCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSED_KEY) === 'true';
  } catch {
    return false;
  }
}

/**
 * Whether the sidebar is down to avatars, remembered. Held by the app, which
 * lays the sidebar out; it is changed by dragging the sidebar's edge.
 */
export function useSidebarCollapsed(): [boolean, (collapsed: boolean) => void] {
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const set = useCallback((next: boolean) => {
    setCollapsed((current) => {
      if (current === next) return current;
      try {
        localStorage.setItem(COLLAPSED_KEY, String(next));
      } catch {
        // Remembering is a convenience; the sidebar still changes.
      }
      return next;
    });
  }, []);
  return [collapsed, set];
}

/** The sidebar's two widths; a drag snaps to the nearer when let go. */
const OPEN_WIDTH = 240;
const COLLAPSED_WIDTH = 56;
const SNAP_WIDTH = (OPEN_WIDTH + COLLAPSED_WIDTH) / 2;

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

/** Faces shown under a channel you are not in, before the rest become "+N". */
const MAX_FACES = 5;

/**
 * Whether a section of the sidebar (channels, chats) is unfolded, remembered
 * per section. Unfolded unless someone folded it.
 */
export function useFolded(key: string): [boolean, () => void, () => void] {
  const storageKey = `zoia.sidebar.${key}Folded`;
  const [folded, setFolded] = useState(() => {
    try {
      return localStorage.getItem(storageKey) === 'true';
    } catch {
      return false;
    }
  });
  const save = (value: boolean) => {
    setFolded(value);
    try {
      localStorage.setItem(storageKey, String(value));
    } catch {
      // Remembering is a convenience; folding still works.
    }
  };
  return [folded, () => save(!folded), () => save(false)];
}

/**
 * A section's title, which folds it, with how many it holds; and for an
 * admin, a + that shows on hover to add one. At the limit the + stays, and
 * says where the limit is changed rather than doing nothing silently.
 */
export function SectionHeading({
  title,
  count,
  folded,
  onToggle,
  add,
}: {
  title: string;
  count: number;
  folded: boolean;
  onToggle: () => void;
  add?: { label: string; full: string | null; onClick: () => void };
}) {
  return (
    <div className="section-heading">
      <button className="section-toggle" onClick={onToggle} aria-expanded={!folded}>
        <svg
          className={`section-chevron${folded ? ' folded' : ''}`}
          viewBox="0 0 24 24"
          width="12"
          height="12"
          aria-hidden="true"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M6 9l6 6 6-6" />
        </svg>
        <span className="section-title">{title}</span>
        <span className="section-count">{count}</span>
      </button>
      {add && (
        <button
          className="section-add"
          onClick={add.full ? undefined : add.onClick}
          aria-disabled={add.full ? 'true' : undefined}
          title={add.full ?? add.label}
          aria-label={add.full ?? add.label}
        >
          <svg
            viewBox="0 0 24 24"
            width="14"
            height="14"
            aria-hidden="true"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
          >
            <path d="M12 5v14M5 12h14" />
          </svg>
        </button>
      )}
    </div>
  );
}

/** What a channel or chat name may start with, offered beside the name field. */
const NAME_EMOJI = (
  '🎮 🕹️ 👾 🎲 🧩 🏆 ⚽ 🏀 🎬 📺 🍿 🎵 🎧 🎤 📢 💬 🗣️ 💻 🛠️ 📚 ' +
  '🎨 📷 ☕ 🍕 🍺 🔥 ⭐ 🎉 🚀 🌙 🌎 ❤️ 😂 😎 🤖 🐱 🐶 💤 🔒 ✨ ' +
  '🎯 🥳 💀 👀 🙌 🍔 🌈'
).split(' ');
/** As the server counts it: UTF-16 units, so an emoji takes two or more. */
const NAME_MAX = 32;

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
  const [picking, setPicking] = useState(false);
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

  /** Puts an emoji where the caret is, replacing any selection, if it fits. */
  const insert = (emoji: string) => {
    const input = inputRef.current;
    const start = input?.selectionStart ?? value.length;
    const end = input?.selectionEnd ?? value.length;
    const next = value.slice(0, start) + emoji + value.slice(end);
    if (next.length > NAME_MAX) return;
    setValue(next);
    requestAnimationFrame(() =>
      input?.setSelectionRange(start + emoji.length, start + emoji.length),
    );
  };
  // The field finishes on blur, so nothing here may take the focus from it.
  const keepFocus = (event: ReactMouseEvent) => event.preventDefault();

  return (
    <div className="channel-edit">
      <div className="channel-edit-row">
        <input
          ref={inputRef}
          value={value}
          maxLength={NAME_MAX}
          placeholder={name}
          aria-label={name}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') finish(value.trim() || null);
            if (event.key === 'Escape') finish(null);
          }}
          onBlur={() => finish(value.trim() || null)}
        />
        <button
          type="button"
          className={`channel-edit-emoji${picking ? ' active' : ''}`}
          onMouseDown={keepFocus}
          onClick={() => setPicking((open) => !open)}
          aria-expanded={picking}
          title={t('sidebar.addEmoji')}
          aria-label={t('sidebar.addEmoji')}
        >
          🙂
        </button>
      </div>
      {picking && (
        <div className="emoji-grid" role="group" aria-label={t('sidebar.addEmoji')}>
          {NAME_EMOJI.map((emoji) => (
            <button
              key={emoji}
              type="button"
              onMouseDown={keepFocus}
              onClick={() => insert(emoji)}
              aria-label={emoji}
            >
              {emoji}
            </button>
          ))}
          {/* Every other emoji, with search: the system's own picker, which
              types into this field since it keeps the focus. */}
          <button
            type="button"
            className="emoji-more"
            onMouseDown={keepFocus}
            onClick={() => void window.zoia.app.emojiPanel()}
            title={t('sidebar.moreEmoji')}
            aria-label={t('sidebar.moreEmoji')}
          >
            …
          </button>
        </div>
      )}
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
  onCreateChannel,
  onRenameChannel,
  onRemoveChannel,
  onMoveMember,
  stage,
  onHoverBroadcast,
  onWatchBroadcast,
  onToggleCamera,
  chats,
  people,
  presence,
  onKickMember,
  collapsed,
  onCollapsedChange,
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
  /** Everyone on the server and their status (ADR 0038), under the chats. */
  people?: (collapsed: boolean) => ReactNode;
  /** Your status, on your picture in the footer, which is where it is chosen. */
  presence?: PresenceController;
  /** Admins only: takes someone off the server, chat and all (ADR 0037). */
  onKickMember?: (identity: string, name: string) => void;
  /** Down to avatars, names in tooltips. */
  collapsed: boolean;
  /** Dragging the edge past halfway, a double-click on it, or the keyboard. */
  onCollapsedChange: (collapsed: boolean) => void;
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
  // Any admin may kick anyone else off the server, whatever their role:
  // keeping order is not about rank. Never yourself: leaving is the button in
  // the footer. The server checks it again.
  const mayKick = (identity: string) =>
    Boolean(onKickMember) && canManageChannels && identity !== myIdentity && listed.has(identity);
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

  // The width while the edge is being dragged; null otherwise.
  const [dragWidth, setDragWidth] = useState<number | null>(null);
  const startResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);
    const right = handle.parentElement!.getBoundingClientRect().right;
    const widthAt = (x: number) => Math.min(OPEN_WIDTH, Math.max(COLLAPSED_WIDTH, right - x));
    const move = (e: PointerEvent) => {
      const width = widthAt(e.clientX);
      setDragWidth(width);
      onCollapsedChange(width < SNAP_WIDTH);
    };
    const end = (e: PointerEvent) => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', end);
      handle.removeEventListener('pointercancel', end);
      setDragWidth(null);
      onCollapsedChange(widthAt(e.clientX) < SNAP_WIDTH);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
  };

  // Folded, the channels list keeps only the one you are in.
  const [channelsFolded, toggleChannelsFolded, unfoldChannels] = useFolded('channels');
  const shownChannels =
    collapsed || !channelsFolded ? channels : channels.filter((c) => c.id === currentChannel);

  // Your picture in the footer opens your status, from where it sits.
  const [statusAnchor, setStatusAnchor] = useState<DOMRect | null>(null);
  const closeStatus = useCallback(() => setStatusAnchor(null), []);

  // Right-clicking someone an admin may kick opens what they can do to them.
  const [menu, setMenu] = useState<{
    identity: string;
    name: string;
    role?: AccountRole;
    x: number;
    y: number;
  } | null>(null);
  const openMenu = (
    event: ReactMouseEvent,
    identity: string,
    name: string,
    role: AccountRole | undefined,
  ) => {
    event.preventDefault();
    event.stopPropagation();
    onHoverBroadcast(null);
    setMenu({ identity, name, role, x: event.clientX, y: event.clientY });
  };

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
  }, [channels, currentChannel, collapsed, editing, members, channelsFolded]);

  return (
    <aside
      className={`sidebar${collapsed ? ' collapsed' : ''}${dragWidth !== null ? ' resizing' : ''}`}
      style={dragWidth !== null ? { width: dragWidth } : undefined}
    >
      {/* The edge facing the stage: drag it to open or close the sidebar. It
          follows the pointer, swaps to avatars past halfway, and settles on
          the nearer width when let go. */}
      <div
        className="sidebar-resize"
        role="separator"
        aria-orientation="vertical"
        aria-label={collapsed ? t('sidebar.expand') : t('sidebar.collapse')}
        title={t('sidebar.resizeHint')}
        tabIndex={0}
        onPointerDown={startResize}
        onDoubleClick={() => onCollapsedChange(!collapsed)}
        onKeyDown={(event) => {
          // The sidebar is on the right: left opens it, right closes it.
          if (event.key === 'ArrowLeft') onCollapsedChange(false);
          else if (event.key === 'ArrowRight') onCollapsedChange(true);
          else if (event.key === 'Enter' || event.key === ' ') onCollapsedChange(!collapsed);
          else return;
          event.preventDefault();
        }}
      />
      <div className="sidebar-scroll">
        {channels.length > 0 && (
          <section
            className={`member-group channel-group${indicator ? ' has-indicator' : ''}`}
            ref={channelGroupRef}
          >
            {/* In the list, like the chats' heading, not on the panel button's
                line: two folding controls side by side read as one. */}
            {!collapsed && (
              <SectionHeading
                title={t('sidebar.channels')}
                count={channels.length}
                folded={channelsFolded}
                onToggle={toggleChannelsFolded}
                add={
                  canManageChannels
                    ? {
                        label: t('sidebar.newChannel'),
                        full: channels.length >= maxChannels ? t('sidebar.channelsFull') : null,
                        onClick: () => {
                          unfoldChannels();
                          setEditing('new');
                        },
                      }
                    : undefined
                }
              />
            )}
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
            {shownChannels.map((c) => {
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
                      {/* A screen, as a chat has its #: what a channel is for. */}
                      <svg
                        className="channel-icon"
                        viewBox="0 0 24 24"
                        width="16"
                        height="16"
                        aria-hidden="true"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                      >
                        <rect x="2.5" y="4" width="19" height="13" rx="2" />
                        <path d="M8 20.5h8" />
                      </svg>
                      <span className="channel-name">{c.name}</span>
                      {/* Only someone there is worth a number; an empty one says nothing. */}
                      {(current ? liveMembers.length : othersInChannel(c, here).length) > 0 && (
                        <span className="channel-count">
                          {current ? liveMembers.length : othersInChannel(c, here).length}
                        </span>
                      )}
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
                          onContextMenu={
                            !leaving && mayKick(m.identity)
                              ? (event) => openMenu(event, m.identity, m.name, roleOf(m))
                              : undefined
                          }
                          {...rowProps}
                        />
                      ))}
                    </div>
                  ) : (
                    othersInChannel(c, here).length > 0 && (
                      // Just faces until you join: enough to see who is where,
                      // and past a handful, how many more.
                      <div className="channel-people">
                        {othersInChannel(c, here)
                          .slice(0, MAX_FACES)
                          .map((p) => (
                            <span
                              key={p.identity}
                              title={[
                                p.role ? `${p.name} · ${t(`account.role.${p.role}`)}` : p.name,
                                ...(mayKick(p.identity) ? [t('sidebar.kickHint')] : []),
                              ].join('\n')}
                              onContextMenu={
                                mayKick(p.identity)
                                  ? (event) => openMenu(event, p.identity, p.name, p.role)
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
                        {othersInChannel(c, here).length > MAX_FACES && (
                          <span
                            className="channel-people-more"
                            title={othersInChannel(c, here)
                              .slice(MAX_FACES)
                              .map((p) => p.name)
                              .join('\n')}
                          >
                            +{othersInChannel(c, here).length - MAX_FACES}
                          </span>
                        )}
                      </div>
                    )
                  )}
                </div>
              );
            })}
            {editing === 'new' && (
              <ChannelNameField
                initial=""
                onDone={(name) => {
                  setEditing(null);
                  if (name) onCreateChannel(name);
                }}
              />
            )}
          </section>
        )}

        {chats?.(collapsed)}

        {people?.(collapsed)}

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

      <div className="sidebar-footer">
        {collapsed ? (
          // Collapsed, your picture is all there is: clicking it opens the
          // sidebar, where leaving and settings are. Sign-ups waiting for an
          // admin still show, on the picture.
          <button
            className="sidebar-me"
            onClick={() => onCollapsedChange(false)}
            title={`${myName}\n${t('sidebar.expand')}`}
            aria-label={t('sidebar.expand')}
          >
            <Avatar
              name={myName}
              identity={myIdentity}
              live={false}
              role={myRole}
              status={presence?.own}
            />
            {settingsBadge > 0 && (
              <span className="settings-dot" aria-hidden="true">
                {settingsBadge}
              </span>
            )}
          </button>
        ) : presence?.chosen ? (
          // Your status is chosen from your picture, as in most chat apps.
          <button
            className="sidebar-me"
            onClick={(event) => setStatusAnchor(event.currentTarget.getBoundingClientRect())}
            title={t('presence.choose')}
            aria-label={t('presence.choose')}
            aria-haspopup="menu"
            aria-expanded={statusAnchor !== null}
          >
            <Avatar
              name={myName}
              identity={myIdentity}
              live={false}
              role={myRole}
              status={presence.own}
            />
          </button>
        ) : (
          <Avatar name={myName} identity={myIdentity} live={false} role={myRole} />
        )}
        {!collapsed && (
          <span className="sidebar-who">
            <span className="sidebar-name" title={myName}>
              {myName}
            </span>
            {presence?.own && (
              <span className="sidebar-status">{t(`presence.${presence.own}`)}</span>
            )}
          </span>
        )}
        {/* Only while in a channel: outside one there is nothing to leave. */}
        {!collapsed && currentChannel !== null && (
          <button
            className="icon-button sidebar-settings sidebar-leave"
            onClick={onLeaveChannel}
            title={t('sidebar.leave')}
            aria-label={t('sidebar.leave')}
          >
            <IconLeave />
          </button>
        )}
        {!collapsed && (
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
        )}
      </div>
      {statusAnchor && presence?.chosen && (
        <StatusMenu
          anchor={statusAnchor}
          chosen={presence.chosen}
          onChoose={(status) => void presence.choose(status)}
          onClose={closeStatus}
        />
      )}
      {menu && onKickMember && (
        <MemberMenu
          {...menu}
          onClose={() => setMenu(null)}
          onKick={() => onKickMember(menu.identity, menu.name)}
        />
      )}
    </aside>
  );
}

/**
 * What an admin may do to someone, at the pointer. Closes on a choice, a
 * click elsewhere, Escape, or the window losing focus.
 */
function MemberMenu({
  identity,
  name,
  role,
  x,
  y,
  onClose,
  onKick,
}: {
  identity: string;
  name: string;
  role?: AccountRole;
  x: number;
  y: number;
  onClose: () => void;
  onKick: () => void;
}) {
  const t = useT();
  const ref = useRef<HTMLDivElement>(null);
  // Kept inside the window: measured once drawn, then nudged in.
  const [place, setPlace] = useState({ left: x, top: y });
  useLayoutEffect(() => {
    const box = ref.current?.getBoundingClientRect();
    if (!box) return;
    setPlace({
      left: Math.max(4, Math.min(x, window.innerWidth - box.width - 4)),
      top: Math.max(4, Math.min(y, window.innerHeight - box.height - 4)),
    });
    ref.current?.querySelector('button')?.focus();
  }, [x, y]);
  useEffect(() => {
    const onDown = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) onClose();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    window.addEventListener('blur', onClose);
    window.addEventListener('resize', onClose);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('blur', onClose);
      window.removeEventListener('resize', onClose);
    };
  }, [onClose]);
  const choose = (action: () => void) => () => {
    onClose();
    action();
  };
  return createPortal(
    <div
      ref={ref}
      className="member-menu"
      role="menu"
      aria-label={name}
      style={place}
      onContextMenu={(event) => event.preventDefault()}
    >
      {/* Who it is about, since a choice acts at once: a misclick shows here. */}
      <div className="member-menu-head">
        <Avatar name={name} identity={identity} live={false} role={role} />
        <span className="member-menu-who">
          <span className="member-menu-name">{name}</span>
          {role && <span className="member-menu-role">{t(`account.role.${role}`)}</span>}
        </span>
      </div>
      <button type="button" role="menuitem" className="member-menu-item" onClick={choose(onKick)}>
        <IconKick />
        {t('sidebar.kickAction')}
      </button>
    </div>,
    document.body,
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
  onContextMenu,
}: {
  /** Admins only: opens what they may do to this person. */
  onContextMenu?: (event: ReactMouseEvent) => void;
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
      onContextMenu={onContextMenu}
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
    </div>
  );
}

/** A door with an arrow leaving it: out of the server. */
function IconKick() {
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
      <path d="M15 4h4a1 1 0 011 1v14a1 1 0 01-1 1h-4M10 16l-4-4 4-4M6 12h10" />
    </svg>
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
