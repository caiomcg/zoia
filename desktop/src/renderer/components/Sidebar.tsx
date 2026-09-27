import { useEffect, useRef, useState } from 'react';
import type { RoomMember } from '../livekit/useRoom';
import type { RoomInfo } from '../../shared/ipc';
import Avatar from './Avatar';
import { IconEye } from './Player';

/**
 * Who is in the room, and who is sharing. Your own name sits in the footer,
 * next to the way into Settings, which is where it is changed.
 */

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
        placeholder="Channel name"
        aria-label="Channel name"
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
}: {
  members: RoomMember[];
  myName: string;
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
}) {
  // Your own channel is listed from the live room, which is current to the
  // second; the others come from the server's poll. Sharers first.
  const liveMembers = [
    ...members.filter((m) => m.isBroadcasting),
    ...members.filter((m) => !m.isBroadcasting),
  ];
  const here = new Set(members.map((m) => m.identity));
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

  const label = (m: RoomMember) => (m.isLocal ? `${m.name} (you)` : m.name);
  // Which channel is being renamed, or 'new' while one is being named.
  const [editing, setEditing] = useState<string | null>(null);

  return (
    <aside className={`sidebar${collapsed ? ' collapsed' : ''}`}>
      <div className="sidebar-header">
        <button
          className="sidebar-toggle"
          onClick={toggleCollapsed}
          aria-expanded={!collapsed}
          title={collapsed ? 'Expand list' : 'Collapse list'}
          aria-label={collapsed ? 'Expand list' : 'Collapse list'}
        >
          <IconPanel collapsed={collapsed} />
        </button>
      </div>
      <div className="sidebar-scroll">
        {channels.length > 0 && (
          <section className="member-group channel-group">
            <h2 className="member-heading">Channels</h2>
            {channels.map((c) => {
              const current = c.id === currentChannel;
              const live = c.broadcasters.length;
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
                      title={
                        current
                          ? `${c.name} — you are here`
                          : `Join ${c.name} (${c.participants.length} ${
                              c.participants.length === 1 ? 'person' : 'people'
                            })`
                      }
                    >
                      <span className="channel-short" aria-hidden="true">
                        {shortName(c.name)}
                      </span>
                      <span className="channel-name">{c.name}</span>
                      {live > 0 && (
                        <span className="channel-live" title={`${live} live`}>
                          {live} live
                        </span>
                      )}
                      <span className="channel-count">
                        {current ? liveMembers.length : othersInChannel(c, here).length}
                      </span>
                    </button>
                    <span className="channel-actions">
                      <button
                        className="channel-action"
                        onClick={() => setEditing(c.id)}
                        title={`Rename ${c.name}`}
                        aria-label={`Rename ${c.name}`}
                      >
                        <IconPencil />
                      </button>
                      {/* Only an empty channel that is not the default. */}
                      {!c.isDefault && c.participants.length === 0 && (
                        <button
                          className="channel-action"
                          onClick={() => onRemoveChannel(c.id)}
                          title={`Delete ${c.name}`}
                          aria-label={`Delete ${c.name}`}
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
                      {liveMembers.map((m) => (
                        <div
                          className={`member${m.isBroadcasting ? ' live' : ''}`}
                          key={m.identity}
                          title={label(m)}
                        >
                          <Avatar name={m.name} live={m.isBroadcasting} />
                          <span className="member-name">{m.name}</span>
                          {m.isLocal && <span className="you-tag">you</span>}
                          {viewerIds.has(m.identity) && <WatchingYou />}
                          {!m.isLocal && loadingRemoteIds.has(m.identity) && (
                            <span className="stream-state">Loading…</span>
                          )}
                          {m.isBroadcasting && (
                            <span className="live-dot" title="Sharing their screen" />
                          )}
                        </div>
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
                  title={`New channel (${channels.length} of ${maxChannels})`}
                >
                  <span className="channel-short" aria-hidden="true">
                    +
                  </span>
                  <span className="channel-name">+ New channel</span>
                </button>
              )
            )}
          </section>
        )}

        {/* Before the first channel poll lands, or against a server without
            channels, the room's people still need a home. */}
        {channels.length === 0 && (
          <section className="member-group">
            <h2 className="member-heading">In room — {liveMembers.length}</h2>
            {liveMembers.map((m) => (
              <div
                className={`member${m.isBroadcasting ? ' live' : ''}`}
                key={m.identity}
                title={label(m)}
              >
                <Avatar name={m.name} live={m.isBroadcasting} />
                <span className="member-name">{m.name}</span>
                {m.isLocal && <span className="you-tag">you</span>}
                {viewerIds.has(m.identity) && <WatchingYou />}
                {m.isBroadcasting && <span className="live-dot" title="Sharing their screen" />}
              </div>
            ))}
          </section>
        )}
      </div>

      <div className="sidebar-footer" title={collapsed ? myName : undefined}>
        <Avatar name={myName} live={false} />
        {!collapsed && (
          <span className="sidebar-name" title={myName}>
            {myName}
          </span>
        )}
        <button
          className="icon-button sidebar-settings"
          onClick={onOpenSettings}
          title="Settings"
          aria-label="Settings"
        >
          <IconSliders />
        </button>
      </div>
    </aside>
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
  return (
    <span className="watching-you" title="Watching your screen" aria-label="Watching your screen">
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
