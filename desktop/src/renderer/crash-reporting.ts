/**
 * Renderer-side failure reporting.
 *
 * The main process reports its own crashes; this covers the half that happens
 * in the UI, where a thrown render or a rejected promise otherwise leaves
 * only a blank panel and a puzzled user.
 */
export function installCrashReporting(): void {
  window.addEventListener('error', (event) => {
    window.zoia.report({
      kind: 'renderer-error',
      message: event.message,
      stack: event.error instanceof Error ? event.error.stack : undefined,
      context: `${event.filename}:${event.lineno}`,
    });
  });

  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason;
    window.zoia.report({
      kind: 'renderer-unhandled-rejection',
      message: reason instanceof Error ? reason.message : String(reason),
      stack: reason instanceof Error ? reason.stack : undefined,
    });
  });
}
