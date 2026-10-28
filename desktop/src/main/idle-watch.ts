/**
 * Whether this machine has gone untouched (ADR 0038): no keyboard or mouse
 * anywhere on it for IDLE_AWAY_MS, or the screen locked. The server shows
 * someone online as away while every machine of theirs says so.
 *
 * The idle time is the system's, so typing in another program counts as
 * being there. Kept apart from Electron, which index.ts hands it, so it can
 * be tested on its own.
 */

/** How often the system's idle time is read. */
const CHECK_MS = 15_000;

export function createIdleWatch({
  idleMs,
  report,
  thresholdMs,
  checkMs = CHECK_MS,
}: {
  /** How long the system has gone without input. */
  idleMs: () => number;
  /** Tells the server; a failure is retried at the next change or reconnect. */
  report: (idle: boolean) => Promise<void>;
  thresholdMs: number;
  checkMs?: number;
}) {
  let timer: ReturnType<typeof setInterval> | null = null;
  let locked = false;
  let idle = false;

  function send() {
    void report(idle).catch(() => {});
  }

  function check() {
    const now = locked || idleMs() >= thresholdMs;
    if (now === idle) return;
    idle = now;
    send();
  }

  return {
    start() {
      if (timer) return;
      idle = false;
      timer = setInterval(check, checkMs);
      timer.unref?.();
      check();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
    /**
     * The stream (re)connected. The server forgot this machine with its last
     * stream, so it is told again, unless there is nothing to tell.
     */
    connected() {
      if (timer && idle) send();
    },
    /** The screen locked or unlocked: away at once, not minutes later. */
    setLocked(value: boolean) {
      locked = value;
      if (timer) check();
    },
  };
}
