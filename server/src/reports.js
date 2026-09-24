/**
 * Crash and error reports from clients.
 *
 * Every problem in this app so far arrived as a screenshot of a dialog, or a
 * sentence relayed from someone else's machine. This is so the next one
 * arrives with its stack, on the machine that can act on it.
 *
 * Deliberately small: a bounded ring in memory and a line in the log. There
 * is no dashboard and no retention policy, because a handful of friends
 * sharing screens does not need one, and anything persisted would be one more
 * thing holding personal data.
 */

const MAX_REPORTS = 200;
const MAX_FIELD = 4000;
/**
 * Diagnostics get far more room than a message does.
 *
 * This was 1000 characters, about twelve lines of ffmpeg output, which threw
 * away everything above the generic last line — so a failed GPU broadcast
 * reported "Conversion failed!" and nothing that said why. The body limit is
 * 16kb, so this still cannot be used to push anything substantial into memory.
 */
const MAX_CONTEXT = 12000;

/** Trims to something loggable, and stringifies whatever odd shape arrived. */
function clip(value, limit = MAX_FIELD) {
  if (value === undefined || value === null) return null;
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.length > limit ? `${text.slice(0, limit)}…[truncated]` : text;
}

export function createReportStore({ logger = console, now = () => Date.now() } = {}) {
  const reports = [];

  return {
    add(report, user) {
      const entry = {
        at: new Date(now()).toISOString(),
        // Who, so a report can be matched to a machine without asking.
        device: user?.name ?? 'unknown',
        deviceId: user?.id ?? null,
        kind: clip(report?.kind, 40) ?? 'error',
        message: clip(report?.message),
        stack: clip(report?.stack),
        context: clip(report?.context, MAX_CONTEXT),
        appVersion: clip(report?.appVersion, 40),
      };

      reports.push(entry);
      if (reports.length > MAX_REPORTS) reports.shift();

      logger.error(
        `[report] ${entry.device}: ${entry.kind}: ${entry.message}` +
          (entry.context ? ` (${entry.context})` : ''),
      );
      if (entry.stack) logger.error(`[report] ${entry.stack}`);

      return entry;
    },

    list() {
      return [...reports].reverse();
    },
  };
}
