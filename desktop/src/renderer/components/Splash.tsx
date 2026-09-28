import { tNow } from '../i18n';

/**
 * What shows while Zoia starts: the logo and a spinner, instead of a pairing
 * screen or an empty room that flash past on the way to the real one.
 */
export default function Splash() {
  // tNow, not useT: the splash shows before the language provider is ready.
  return (
    <div className="splash" role="status" aria-label={tNow('common.startingZoia')}>
      <img className="splash-logo" src="logo.png" alt="Zoia" draggable={false} />
      <span className="splash-spinner" aria-hidden="true" />
    </div>
  );
}
