/**
 * What shows while Zoia starts: the logo and a spinner, instead of a pairing
 * screen or an empty room that flash past on the way to the real one.
 */
export default function Splash() {
  return (
    <div className="splash" role="status" aria-label="Starting Zoia">
      <img className="splash-logo" src="logo.png" alt="Zoia" draggable={false} />
      <span className="splash-spinner" aria-hidden="true" />
    </div>
  );
}
