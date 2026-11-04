/**
 * A native module the app can run without, loaded on first use.
 *
 * Windows' Smart App Control refuses unsigned native files (`.node`), and a
 * module required at the top of a file the main process imports took the whole
 * app down with it: it closed at startup with "An Application Control policy
 * has blocked this file". Loaded through this instead, a module that cannot
 * load turns its feature off and the app opens without it.
 *
 * The first attempt is remembered either way: a blocked file stays blocked, so
 * there is no point asking again, and the reason is logged once.
 */
export function optionalModule<T>(
  name: string,
  load: () => T,
  warn: (message: string) => void = console.warn,
): () => T | null {
  let loaded = false;
  let value: T | null = null;
  return () => {
    if (loaded) return value;
    loaded = true;
    try {
      value = load();
    } catch (err) {
      warn(`[${name}] unavailable: ${err instanceof Error ? err.message : String(err)}`);
      value = null;
    }
    return value;
  };
}
