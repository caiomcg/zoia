/**
 * Voice's global shortcuts (ADR 0039): push to talk, toggle mute, toggle
 * deafen. A binding is what has to be held at once, keys and mouse buttons
 * alike, so "Ctrl+Shift+M" and "Mouse 4" are the same kind of thing.
 *
 * Main feeds every press and release it sees (src/main/shortcuts.ts) through
 * the pure pieces here, which is what the tests exercise.
 */

export type ShortcutAction = 'pushToTalk' | 'toggleMute' | 'toggleDeafen';

export const SHORTCUT_ACTIONS: readonly ShortcutAction[] = [
  'pushToTalk',
  'toggleMute',
  'toggleDeafen',
];

/**
 * An input, as text so a binding is plain JSON: `k` and a uiohook keycode,
 * or `m` and a mouse button (3 middle, 4 and 5 the side buttons).
 */
export type InputCode = string;

/** Everything held together, in a stable order: modifiers first, mouse last. */
export type Binding = InputCode[];

export type Bindings = Record<ShortcutAction, Binding | null>;

/** A binding and how to show it, as main sends it. */
export interface BoundShortcut {
  codes: Binding;
  label: string;
}

export interface ShortcutsState {
  /** False where the input hook could not load: no shortcuts at all. */
  available: boolean;
  bindings: Record<ShortcutAction, BoundShortcut | null>;
}

export interface ShortcutEvent {
  action: ShortcutAction;
  /** True on the press, false on the release; push to talk needs both. */
  pressed: boolean;
}

export const keyCode = (keycode: number): InputCode => `k${keycode}`;
export const mouseCode = (button: number): InputCode => `m${button}`;

/** Ctrl, Shift, Alt and Meta, left and right, as uiohook numbers them. */
const MODIFIERS = new Set([29, 3613, 42, 54, 56, 3640, 3675, 3676].map(keyCode));

/** The left and right buttons click Zoia itself; binding them would break the mouse. */
const UNBINDABLE = new Set([mouseCode(1), mouseCode(2)]);

const ESCAPE = keyCode(1);

/** Most a binding may hold: past that it is a slip, not a shortcut. */
export const MAX_BINDING = 4;

function rank(code: InputCode): number {
  if (MODIFIERS.has(code)) return 0;
  return code.startsWith('m') ? 2 : 1;
}

export function normalize(codes: Iterable<InputCode>): Binding {
  return [...new Set(codes)].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

export function sameBinding(a: Binding | null, b: Binding | null): boolean {
  return !!a && !!b && a.length === b.length && a.every((code, i) => code === b[i]);
}

function validBinding(value: unknown): Binding | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_BINDING) return null;
  if (!value.every((c) => typeof c === 'string' && /^[km]\d+$/.test(c))) return null;
  if (value.some((c) => UNBINDABLE.has(c))) return null;
  return normalize(value as string[]);
}

/** What was saved, with anything unreadable as never set. */
export function parseBindings(raw: unknown): Bindings {
  const stored = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  return {
    pushToTalk: validBinding(stored.pushToTalk),
    toggleMute: validBinding(stored.toggleMute),
    toggleDeafen: validBinding(stored.toggleDeafen),
  };
}

/**
 * Sets one action's binding. One binding does one thing, so another action
 * holding the same is cleared.
 */
export function assign(bindings: Bindings, action: ShortcutAction, binding: Binding | null) {
  const next = { ...bindings, [action]: binding };
  if (binding) {
    for (const other of SHORTCUT_ACTIONS) {
      if (other !== action && sameBinding(next[other], binding)) next[other] = null;
    }
  }
  return next;
}

/**
 * Turns presses and releases into shortcut presses and releases: a binding
 * is down while all of it is held. Key repeat changes nothing.
 */
export class ChordTracker {
  private held = new Set<InputCode>();
  private active = new Set<ShortcutAction>();
  private bindings: Bindings;

  constructor(bindings: Bindings) {
    this.bindings = bindings;
  }

  setBindings(bindings: Bindings): ShortcutEvent[] {
    this.bindings = bindings;
    return this.settle();
  }

  down(code: InputCode): ShortcutEvent[] {
    this.held.add(code);
    return this.settle();
  }

  up(code: InputCode): ShortcutEvent[] {
    this.held.delete(code);
    return this.settle();
  }

  /** Lets go of everything, as when the hook stops: nothing stays pushed. */
  reset(): ShortcutEvent[] {
    this.held.clear();
    return this.settle();
  }

  private settle(): ShortcutEvent[] {
    const events: ShortcutEvent[] = [];
    for (const action of SHORTCUT_ACTIONS) {
      const binding = this.bindings[action];
      const down = !!binding && binding.every((code) => this.held.has(code));
      if (down === this.active.has(action)) continue;
      if (down) this.active.add(action);
      else this.active.delete(action);
      events.push({ action, pressed: down });
    }
    return events;
  }
}

/**
 * Records a binding: everything held at once, taken when it has all been let
 * go. Escape on its own cancels. Returns undefined while still recording,
 * null when cancelled.
 */
export class BindingRecorder {
  private held = new Set<InputCode>();
  private most = new Set<InputCode>();

  down(code: InputCode): Binding | null | undefined {
    if (UNBINDABLE.has(code)) return undefined;
    this.held.add(code);
    if (this.held.size > this.most.size && this.held.size <= MAX_BINDING) {
      this.most = new Set(this.held);
    }
    return undefined;
  }

  up(code: InputCode): Binding | null | undefined {
    if (!this.held.delete(code) || this.held.size > 0) return undefined;
    if (this.most.size === 1 && this.most.has(ESCAPE)) return null;
    return normalize(this.most);
  }
}

/** "CtrlRight" → "Right Ctrl", "NumpadAdd" → "Numpad Add", for the label. */
export function keyName(name: string): string {
  const side = /^(Ctrl|Shift|Alt|Meta)Right$/.exec(name);
  if (side) return `Right ${side[1]}`;
  return name.replace(/([a-z])([A-Z0-9])/g, '$1 $2');
}

/** "Ctrl + Shift + M", "Mouse 4", with names from the hook's key table. */
export function bindingLabel(binding: Binding, names: ReadonlyMap<number, string>): string {
  return binding
    .map((code) => {
      const n = Number(code.slice(1));
      if (code.startsWith('m')) return `Mouse ${n}`;
      const name = names.get(n);
      return name ? keyName(name) : `Key ${n}`;
    })
    .join(' + ');
}
