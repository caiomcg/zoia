import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { bestError, isWhipHandshakeFailure, untag } from '../src/main/ffmpeg-log.ts';

/**
 * Every transcript here was taken off a real run: the first from a broadcast
 * on a Radeon RX 9070 XT against the production SFU, the others from a local
 * LiveKit 1.13.7 reproducing the same failure two starts in ten.
 */

/** The failure the muxer refuses an answer with, as ffmpeg writes it. */
const TCP_CANDIDATE = [
  '[WHIP muxer @ 0000000000762640] Protocol tcp is not supported by RTC, choose udp, line 18 a=candidate:890631320 1 tcp 1671430143 206.42.10.147 7881 typ host tcptype passive ufrag KfhmNdBHctnmlFYJ of v=0\no=- 1459754246826747082 1791127896 IN IP4 0.0.0.0\ns=-',
  '[WHIP muxer @ 0000000000762640] Failed to read response from DELETE url=https://sfu.example.com/whip/v1/PA_5P3FMN92MvMJ',
  '[WHIP muxer @ 0000000000762640] Failed to dispose resource, ret=-5',
  '[out#0/whip @ 00000000006ed980] Could not write header (incorrect codec parameters ?): I/O error',
  '[af#0:1 @ 000000000076ea40] Error sending frames to consumers: I/O error',
  '[af#0:1 @ 000000000076ea40] Task finished with error code: -5 (I/O error)',
  '[af#0:1 @ 000000000076ea40] Terminating thread with return code -5 (I/O error)',
  '[out#0/whip @ 00000000006ed980] Nothing was written into output file, because at least one of its streams received no packets.',
  'frame=    0 fps=0.0 q=0.0 Lsize=       0KiB time=00:00:00.26 bitrate=   0.0kbits/s speed=0.358x',
  'Conversion failed!',
];

describe('untag', () => {
  test('takes off the component tag ffmpeg prefixes', () => {
    assert.equal(
      untag('[af#0:1 @ 000000000076ea40] Task finished with error code: -5 (I/O error)'),
      'Task finished with error code: -5 (I/O error)',
    );
  });

  test('leaves an untagged line alone', () => {
    assert.equal(untag('Conversion failed!'), 'Conversion failed!');
  });
});

describe('bestError', () => {
  test('names the refused answer rather than the thread that died of it', () => {
    const error = bestError(TCP_CANDIDATE);
    assert.ok(error, 'expected an error');
    assert.match(error, /^Protocol tcp is not supported by RTC/);
    // This is what it used to report, and it names neither WHIP nor the answer.
    assert.doesNotMatch(error, /Terminating thread/);
  });

  test('cuts the SDP answer out of the muxer’s message', () => {
    const error = bestError(TCP_CANDIDATE) as string;
    assert.ok(error.length <= 301, `expected a message a dialog can hold, got ${error.length}`);
    assert.doesNotMatch(error, /\n/);
  });

  test('falls back to where it surfaced when the muxer gave no reason', () => {
    // The local flavour of the same failure: the header fails with nothing
    // above it, because what went wrong was only logged at verbose.
    assert.match(
      bestError([
        '[out#0/whip @ 00000000006e5940] Could not write header (incorrect codec parameters ?): I/O error',
        '[af#0:1 @ 000000000071e5c0] Error sending frames to consumers: I/O error',
        '[af#0:1 @ 000000000071e5c0] Task finished with error code: -5 (I/O error)',
        '[af#0:1 @ 000000000071e5c0] Terminating thread with return code -5 (I/O error)',
      ]) as string,
      /^Could not write header/,
    );
  });

  test('never blames the DELETE of a session that ended cleanly', () => {
    // Both of these appear on a healthy ten-second publish that shut down
    // normally, measured against a local LiveKit.
    const error = bestError([
      '[WHIP muxer @ 0000000000787e40] Failed to read response from DELETE url=http://localhost:7880/whip/v1/PA_Uf29dc5rzKJF',
      '[WHIP muxer @ 0000000000787e40] Failed to dispose resource, ret=-5',
      'frame=  600 fps=160 q=0.0 Lsize=N/A time=00:00:09.98 bitrate=N/A speed=2.66x',
    ]);
    assert.equal(error, null);
  });

  test('picks a rejected argument out of a chunk holding several lines', () => {
    assert.match(
      bestError([
        'Press [q] to stop, [?] for help\n[libx264 @ 000000000071e5c0] Error setting profile baseline.\nTask finished with error code: -22 (Invalid argument)\nError opening output files: Invalid argument',
      ]) as string,
      /^Error setting profile baseline/,
    );
  });

  test('says nothing when ffmpeg only reported progress', () => {
    assert.equal(
      bestError(['frame=  600 fps= 37 q=0.0 size=N/A time=00:00:09.98 speed=0.609x']),
      null,
    );
  });
});

describe('isWhipHandshakeFailure', () => {
  test('recognises an answer the muxer refused', () => {
    assert.equal(isWhipHandshakeFailure(TCP_CANDIDATE), true);
  });

  test('recognises a header that failed with no reason above it', () => {
    assert.equal(
      isWhipHandshakeFailure([
        '[out#0/whip @ 00000000006e5940] Could not write header (incorrect codec parameters ?): I/O error',
      ]),
      true,
    );
  });

  test('a session that opened and then failed is not a handshake failure', () => {
    // The retry for this one has to release the previous publisher first, so
    // telling them apart is the point.
    assert.equal(
      isWhipHandshakeFailure([
        '[WHIP muxer @ 0000000000700040] Muxer state=10, buffer_size=4096, max_packet_size=1184',
        '[WHIP muxer @ 0000000000700040] Consent Freshness expired after 30012.00ms (limited 30000ms), terminate session',
      ]),
      false,
    );
  });

  test('a healthy run is not a handshake failure', () => {
    assert.equal(
      isWhipHandshakeFailure([
        'frame=  134 fps= 65 q=0.0 size=N/A time=00:00:02.21 bitrate=N/A speed=1.08x',
      ]),
      false,
    );
  });
});
