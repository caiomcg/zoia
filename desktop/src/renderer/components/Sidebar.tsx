import { useEffect, useRef, useState } from 'react';
import type { RoomMember } from '../livekit/useRoom';

/**
 * Who is in the room, and who is sharing. Deliberately the only place a
 * person's name is shown or changed, so the rename flow has one home.
 */

/** Stable per-person colour, so the same person keeps the same avatar. */
function avatarHue(seed: string): number {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) | 0;
  return Math.abs(hash) % 360;
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase();
}

function Avatar({ name, live }: { name: string; live: boolean }) {
  return (
    <span
      className={`avatar${live ? ' live' : ''}`}
      style={{ background: `hsl(${avatarHue(name)} 45% 32%)` }}
      aria-hidden="true"
    >
      {initials(name)}
    </span>
  );
}

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

export default function Sidebar({
  members,
  myName,
  onRename,
  selectedRemoteIds,
  onToggleRemote,
  onWatchAll,
  onWatchNone,
}: {
  members: RoomMember[];
  myName: string;
  onRename: (name: string) => Promise<void>;
  selectedRemoteIds: Set<string>;
  onToggleRemote: (identity: string) => void;
  onWatchAll: () => void;
  onWatchNone: () => void;
}) {
  const broadcasting = members.filter((m) => m.isBroadcasting);
  const remoteBroadcasting = broadcasting.filter((m) => !m.isLocal);
  const selectedCount = remoteBroadcasting.filter((m) => selectedRemoteIds.has(m.identity)).length;
  const watching = members.filter((m) => !m.isBroadcasting);

  return (
    <aside className="sidebar">
      <div className="sidebar-scroll">
        {broadcasting.length > 0 && (
          <section className="member-group">
            <div className="live-heading-row">
              <h2 className="member-heading">Ao vivo — {broadcasting.length}</h2>
              {remoteBroadcasting.length > 0 && (
                <span className="live-count">
                  Assistindo {selectedCount} de {remoteBroadcasting.length}
                </span>
              )}
            </div>
            {remoteBroadcasting.length > 1 && (
              <div className="live-actions">
                <button onClick={onWatchAll}>Assistir todas</button>
                <button onClick={onWatchNone}>Parar todas</button>
              </div>
            )}
            {broadcasting.map((m) => (
              <div className="member live" key={m.identity}>
                <Avatar name={m.name} live />
                {!m.isLocal && (
                  <button
                    className="watch-button"
                    onClick={() => onToggleRemote(m.identity)}
                    aria-pressed={selectedRemoteIds.has(m.identity)}
                  >
                    {selectedRemoteIds.has(m.identity) ? 'Parar de assistir' : 'Assistir'}
                  </button>
                )}
                <span className="member-name">{m.name}</span>
                {m.isLocal && <span className="you-tag">you</span>}
                <span className="live-dot" title="Sharing their screen" />
              </div>
            ))}
          </section>
        )}

        <section className="member-group">
          <h2 className="member-heading">In room — {watching.length}</h2>
          {watching.length === 0 && <p className="member-empty">Nobody else is here yet.</p>}
          {watching.map((m) => (
            <div className="member" key={m.identity}>
              <Avatar name={m.name} live={false} />
              <span className="member-name">{m.name}</span>
              {m.isLocal && <span className="you-tag">you</span>}
            </div>
          ))}
        </section>
      </div>

      <div className="sidebar-footer">
        <Avatar name={myName} live={false} />
        <RenameField current={myName} onRename={onRename} />
      </div>
    </aside>
  );
}
