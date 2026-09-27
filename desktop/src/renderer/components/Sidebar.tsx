import { useEffect, useRef, useState } from 'react';
import type { RoomMember } from '../livekit/useRoom';
import type { RoomInfo } from '../../shared/ipc';
import Avatar from './Avatar';

/**
 * Who is in the room, and who is sharing. Deliberately the only place a
 * person's name is shown or changed, so the rename flow has one home.
 */

function RenameField({
  current,
  onRename,
}: {
  current: string;
  onRename: (name: string) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(current);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!editing) setValue(current);
  }, [current, editing]);

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  async function commit() {
    const next = value.trim();
    if (!next || next === current) {
      setEditing(false);
      setValue(current);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onRename(next);
      setEditing(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Rename failed');
    } finally {
      setBusy(false);
    }
  }

  if (!editing) {
    return (
      <div className="rename-row">
        <span className="rename-name" title={current}>
          {current}
        </span>
        <button className="rename-button" onClick={() => setEditing(true)} title="Change your name">
          Edit
        </button>
      </div>
    );
  }

  return (
    <div className="rename-row editing">
      <input
        ref={inputRef}
        value={value}
        maxLength={32}
        disabled={busy}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void commit();
          if (e.key === 'Escape') {
            setEditing(false);
            setValue(current);
          }
        }}
        aria-label="Your display name"
      />
      <button className="rename-button primary" disabled={busy} onClick={() => void commit()}>
        {busy ? '…' : 'Save'}
      </button>
      {error && <p className="rename-error">{error}</p>}
    </div>
  );
}

const COLLAPSED_KEY = 'zoia.sidebarCollapsed';

/** "Sala 3" → "S3", "Jogos" → "JO": what a collapsed sidebar shows. */
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

export default function Sidebar({
  members,
  myName,
  onRename,
  loadingRemoteIds,
  channels,
  currentChannel,
  onJoinChannel,
}: {
  members: RoomMember[];
  myName: string;
  onRename: (name: string) => Promise<void>;
  loadingRemoteIds: Set<string>;
  /** Every channel, who is in it and who is live, polled from the server. */
  channels: RoomInfo[];
  currentChannel: string | null;
  onJoinChannel: (id: string) => void;
}) {
  const broadcasting = members.filter((m) => m.isBroadcasting);
  const watching = members.filter((m) => !m.isBroadcasting);
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

  const label = (m: RoomMember) => (m.isLocal ? `${m.name} (você)` : m.name);

  return (
    <aside className={`sidebar${collapsed ? ' collapsed' : ''}`}>
      <div className="sidebar-header">
        <button
          className="sidebar-toggle"
          onClick={toggleCollapsed}
          aria-expanded={!collapsed}
          title={collapsed ? 'Expandir lista' : 'Recolher lista'}
          aria-label={collapsed ? 'Expandir lista' : 'Recolher lista'}
        >
          <IconPanel collapsed={collapsed} />
        </button>
      </div>
      <div className="sidebar-scroll">
        {channels.length > 1 && (
          <section className="member-group channel-group">
            <h2 className="member-heading">Canais</h2>
            {channels.map((c) => {
              const current = c.id === currentChannel;
              const live = c.broadcasters.length;
              return (
                <div key={c.id} className="channel-block">
                  <button
                    className={`channel${current ? ' current' : ''}`}
                    onClick={() => onJoinChannel(c.id)}
                    aria-current={current ? 'true' : undefined}
                    title={
                      current
                        ? `${c.name} — você está aqui`
                        : `Entrar em ${c.name} (${c.participants.length} ${
                            c.participants.length === 1 ? 'pessoa' : 'pessoas'
                          })`
                    }
                  >
                    <span className="channel-short" aria-hidden="true">
                      {shortName(c.name)}
                    </span>
                    <span className="channel-name">{c.name}</span>
                    {live > 0 && (
                      <span className="channel-live" title={`${live} ao vivo`}>
                        {live} ao vivo
                      </span>
                    )}
                    <span className="channel-count">{c.participants.length}</span>
                  </button>
                  {/* Who is where, for the channels you are not in; your
                      own channel's people are listed in full below. */}
                  {!current && c.participants.length > 0 && (
                    <div className="channel-people">
                      {c.participants.slice(0, 6).map((p) => (
                        <span key={p.identity} title={p.name}>
                          <Avatar
                            name={p.name}
                            live={c.broadcasters.some((b) => b.identity === p.identity)}
                          />
                        </span>
                      ))}
                      {c.participants.length > 6 && (
                        <span className="channel-more">+{c.participants.length - 6}</span>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </section>
        )}

        {broadcasting.length > 0 && (
          <section className="member-group">
            <h2 className="member-heading">Ao vivo — {broadcasting.length}</h2>
            {broadcasting.map((m) => (
              <div className="member live" key={m.identity} title={label(m)}>
                <Avatar name={m.name} live />
                <span className="member-name">{m.name}</span>
                {m.isLocal && <span className="you-tag">you</span>}
                {!m.isLocal && loadingRemoteIds.has(m.identity) && (
                  <span className="stream-state">Carregando…</span>
                )}
                <span className="live-dot" title="Sharing their screen" />
              </div>
            ))}
          </section>
        )}

        <section className="member-group">
          <h2 className="member-heading">In room — {watching.length}</h2>
          {watching.length === 0 && <p className="member-empty">Nobody else is here yet.</p>}
          {watching.map((m) => (
            <div className="member" key={m.identity} title={label(m)}>
              <Avatar name={m.name} live={false} />
              <span className="member-name">{m.name}</span>
              {m.isLocal && <span className="you-tag">you</span>}
            </div>
          ))}
        </section>
      </div>

      <div className="sidebar-footer" title={collapsed ? myName : undefined}>
        <Avatar name={myName} live={false} />
        {!collapsed && <RenameField current={myName} onRename={onRename} />}
      </div>
    </aside>
  );
}
