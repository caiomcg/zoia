/**
 * The global shortcuts, heard while Zoia is in the background: voice's (ADR
 * 0039) and the soundboard pads' (ADR 0040).
 *
 * Electron's globalShortcut takes keys only, and says nothing of a release,
 * which push to talk is all about. uiohook-napi hooks the keyboard and the
 * mouse at the OS instead. It is an optional dependency: without it, or on a
 * Mac that has not given Zoia Accessibility access, there are no shortcuts and
 * the settings say so.
 *
 * The hook runs only while something is bound or being recorded. What it
 * reads is turned into shortcut presses here and nothing else is kept.
 */

import { app } from 'electron';
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  assign,
  bindingLabel,
  BindingRecorder,
  boundActions,
  ChordTracker,
  keyCode,
  mouseCode,
  parseBindings,
  type Binding,
  type Bindings,
  type ShortcutAction,
  type ShortcutEvent,
  type ShortcutsState,
} from '../shared/shortcuts';

interface HookEvent {
  keycode?: number;
  button?: unknown;
}

interface Hook {
  on(event: 'keydown' | 'keyup' | 'mousedown' | 'mouseup', listener: (e: HookEvent) => void): void;
  start(): void;
  stop(): void;
}

/** How long a recording waits for input before giving up. */
const RECORD_TIMEOUT_MS = 15_000;

const require = createRequire(import.meta.url);
const prefsPath = () => join(app.getPath('userData'), 'shortcuts.json');

let hook: Hook | null = null;
let keyNames = new Map<number, string>();
let available: boolean | null = null;
let running = false;

let bindings: Bindings | null = null;
const tracker = new ChordTracker(parseBindings({}));
let recording: {
  recorder: BindingRecorder;
  finish: (binding: Binding | null) => void;
} | null = null;

let send: (event: ShortcutEvent) => void = () => {};

function current(): Bindings {
  if (!bindings) {
    try {
      bindings = parseBindings(JSON.parse(readFileSync(prefsPath(), 'utf8')));
    } catch {
      bindings = parseBindings({});
    }
    tracker.setBindings(bindings);
  }
  return bindings;
}

function save(next: Bindings) {
  bindings = next;
  emit(tracker.setBindings(next));
  try {
    mkdirSync(dirname(prefsPath()), { recursive: true });
    writeFileSync(prefsPath(), JSON.stringify(next));
  } catch {
    // Remembering is a convenience; the binding still applies this session.
  }
  sync();
}

function emit(events: ShortcutEvent[]) {
  for (const event of events) send(event);
}

function input(code: string, pressed: boolean) {
  if (recording) {
    const result = pressed ? recording.recorder.down(code) : recording.recorder.up(code);
    if (result !== undefined) recording.finish(result);
    return;
  }
  emit(pressed ? tracker.down(code) : tracker.up(code));
}

/** Loads the hook once. False for good if it cannot: an optional dependency. */
function load(): boolean {
  if (available !== null) return available;
  try {
    const module = require('uiohook-napi') as {
      uIOhook: Hook;
      UiohookKey: Record<string, number>;
    };
    hook = module.uIOhook;
    keyNames = new Map(Object.entries(module.UiohookKey).map(([name, code]) => [code, name]));
    hook.on('keydown', (e) => e.keycode !== undefined && input(keyCode(e.keycode), true));
    hook.on('keyup', (e) => e.keycode !== undefined && input(keyCode(e.keycode), false));
    hook.on('mousedown', (e) => typeof e.button === 'number' && input(mouseCode(e.button), true));
    hook.on('mouseup', (e) => typeof e.button === 'number' && input(mouseCode(e.button), false));
    available = true;
  } catch (err) {
    console.warn(`[shortcuts] input hook unavailable: ${(err as Error)?.message ?? err}`);
    available = false;
  }
  return available;
}

/** Runs the hook exactly while it has something to listen for. */
function sync() {
  if (!load() || !hook) return;
  const saved = current();
  const wanted = !!recording || boundActions(saved).some((a) => saved[a]);
  if (wanted === running) return;
  try {
    if (wanted) hook.start();
    else hook.stop();
    running = wanted;
  } catch (err) {
    console.warn(`[shortcuts] input hook failed: ${(err as Error)?.message ?? err}`);
    available = false;
  }
  // Whatever was held when it stopped is let go, so push to talk never sticks.
  if (!running) emit(tracker.reset());
}

export function state(): ShortcutsState {
  const saved = current();
  const label = (binding: Binding | null) =>
    binding ? { codes: binding, label: bindingLabel(binding, keyNames) } : null;
  load();
  const bindings: ShortcutsState['bindings'] = {
    pushToTalk: label(saved.pushToTalk),
    toggleMute: label(saved.toggleMute),
    toggleDeafen: label(saved.toggleDeafen),
  };
  for (const action of boundActions(saved)) bindings[action] = label(saved[action] ?? null);
  return { available: available === true, bindings };
}

/** Records the next binding for `action`; null if cancelled or unavailable. */
export function record(action: ShortcutAction): Promise<ShortcutsState | null> {
  cancelRecording();
  if (!load()) return Promise.resolve(null);
  // Nothing fires while recording: the keys pressed are the new binding.
  emit(tracker.reset());
  return new Promise((resolve) => {
    const timer = setTimeout(() => finish(null), RECORD_TIMEOUT_MS);
    const finish = (binding: Binding | null) => {
      clearTimeout(timer);
      recording = null;
      if (binding) save(assign(current(), action, binding));
      else sync();
      resolve(binding ? state() : null);
    };
    recording = { recorder: new BindingRecorder(), finish };
    sync();
  });
}

export function cancelRecording() {
  recording?.finish(null);
}

export function clear(action: ShortcutAction): ShortcutsState {
  save(assign(current(), action, null));
  return state();
}

/** Starts listening, if anything is bound, and hands each press to `target`. */
export function initShortcuts(target: (event: ShortcutEvent) => void) {
  send = target;
  current();
  sync();
  app.on('will-quit', () => {
    if (running) hook?.stop();
    running = false;
  });
}
