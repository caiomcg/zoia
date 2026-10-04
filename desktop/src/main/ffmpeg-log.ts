/**
 * Reading ffmpeg's stderr: which of its lines carries the reason a run failed,
 * and which ones are only the wreckage afterwards.
 *
 * ffmpeg tags most lines with the component that emitted them:
 *
 *     [af#0:1 @ 000000000076ea40] Task finished with error code: -5 (I/O error)
 *
 * The filter that was meant to skip lines like that was anchored at the start
 * of the line, so the tag defeated it and nothing was ever skipped. Scanning
 * backwards for "a line that mentions an error" then reliably picked the last
 * thread to fall over instead of the thing that pushed it: a WHIP answer the
 * muxer refused was reported as `Terminating thread with return code -5`,
 * which names neither WHIP nor the answer. That one sentence is what the UI
 * shows, what the log surfaces and what the crash report carries, and it cost
 * two wrong diagnoses of the same failure.
 *
 * This module is separate from encoder.ts so these can be tested without
 * Electron, the way media-clock.ts is. `ffmpeg-log.test.ts` guards them with
 * real transcripts.
 */

/** ffmpeg's component tag: `[out#0/whip @ 00000000006ed980] `. */
const TAG = /^\[[^\]]*@\s*[0-9a-fx]+\]\s*/i;

/** The line as it reads without the tag, which every matcher below wants. */
export function untag(line: string): string {
  return line.replace(TAG, '').trim();
}

/**
 * Lines that announce a failure while saying nothing about it. The cause, when
 * there is one, is always above them.
 *
 * The last two are not failures at all: a WHIP session that ends gets its
 * resource DELETEd, and both lines appear on a perfectly healthy run — they
 * were measured against a local LiveKit 1.13.7 on a stream that published for
 * ten seconds and shut down cleanly. Reporting either as the reason a
 * broadcast failed points at the SFU for something it did not do.
 */
const AFTERMATH =
  /^(Conversion failed|Exiting|Terminating thread|Task finished with error code|Error sending frames to consumers|Error while filtering|Nothing was written into output file|Last message repeated|Failed to dispose resource|Failed to read response from DELETE)/i;

/**
 * Where a failure surfaced, which is worth saying when nothing above it said
 * why. "Could not write header" is the muxer reporting that the session never
 * opened; the reason is a line the muxer logged first, if it logged one.
 */
const SYMPTOM = /^(Could not write header|Error opening (output|input) files?)/i;

/** Anything that reads like a reason. */
const REASON =
  /error|failed|invalid|cannot|unsupported|not (yet )?(implemented|supported)|no such|refused|timed? ?out/i;

/** ffmpeg's progress lines, which are never an error however a run ended. */
const PROGRESS = /^(frame=|size=|video:)/;

/**
 * The WHIP muxer prints the entire SDP answer in the body of one message, so
 * the reason has to be cut back to something a dialog can hold.
 */
const MAX_LENGTH = 300;

function trim(line: string): string {
  return line.length > MAX_LENGTH ? `${line.slice(0, MAX_LENGTH)}…` : line;
}

/**
 * The most informative thing ffmpeg said, from its last lines backwards: a
 * reason if it gave one, otherwise where the failure surfaced, otherwise
 * whatever it said last that was not progress or wreckage.
 *
 * `chunks` are taken as read from the stream, so one may hold several lines.
 */
export function bestError(chunks: string[]): string | null {
  const lines = chunks
    .flatMap((chunk) => chunk.split('\n'))
    .map(untag)
    .filter(Boolean);

  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i] as string;
    if (AFTERMATH.test(line) || SYMPTOM.test(line) || PROGRESS.test(line)) continue;
    if (REASON.test(line)) return trim(line);
  }
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i] as string;
    if (SYMPTOM.test(line)) return trim(line);
  }
  const rest = lines.filter((line) => !AFTERMATH.test(line) && !PROGRESS.test(line));
  const last = rest[rest.length - 1];
  return last ? trim(last) : null;
}

/**
 * True when the muxer never opened the WHIP session.
 *
 * This is worth telling apart from every other way a broadcast fails, because
 * ffmpeg does not exit when it happens. The audio filter thread dies, the
 * audio input closes, and the process sits there draining the video pipe at a
 * frame or two a second with a `frame=` counter stuck at zero — so waiting for
 * it to exit, or for the startup timeout, costs ten seconds and looks for all
 * the world like a broadcast that came up and then stuttered.
 *
 * It is also common. Measured against LiveKit 1.13.7: two of ten starts, and
 * the cause is in ffmpeg's muxer rather than anything either end did wrong.
 * `parse_answer` keeps only the *first* `a=candidate:` line of the answer
 * (`&& !whip->ice_protocol`) and returns `AVERROR(EIO)` if that one is not
 * UDP. LiveKit offers its TCP fallback candidates (`rtc.tcp_port`, port 7881)
 * and its UDP ones in whatever order ICE gathered them, so whenever a TCP
 * candidate lands first the whole answer is refused. Another attempt gets a
 * different order, which is the whole fix available to us from this side.
 */
export function isWhipHandshakeFailure(chunks: string[]): boolean {
  return chunks
    .flatMap((chunk) => chunk.split('\n'))
    .map(untag)
    .some(
      (line) =>
        /^Could not write header/i.test(line) ||
        /^Protocol \w+ is not supported by RTC/i.test(line),
    );
}
