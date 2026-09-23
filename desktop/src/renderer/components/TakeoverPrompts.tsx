import type { IncomingRequest, OutgoingRequest } from '../livekit/useTakeover';

/**
 * The two halves of handing the stage over.
 *
 * The holder is asked and can answer. The asker waits, and once the grace
 * period runs out may take it anyway — which is the case that matters, since
 * the usual reason nobody answers is that they walked away from a machine
 * left broadcasting.
 */

export function IncomingTakeover({
  request,
  onRespond,
}: {
  request: IncomingRequest;
  onRespond: (accept: boolean) => void;
}) {
  return (
    <div className="takeover incoming" role="alertdialog" aria-label="Someone wants to share">
      <div className="takeover-body">
        <strong>{request.name}</strong> wants to share.
      </div>
      <div className="takeover-actions">
        <button onClick={() => onRespond(false)}>Not now</button>
        <button className="primary" onClick={() => onRespond(true)}>
          Allow
        </button>
      </div>
    </div>
  );
}

export function OutgoingTakeover({
  request,
  onTake,
  onCancel,
}: {
  request: OutgoingRequest;
  onTake: () => void;
  onCancel: () => void;
}) {
  const ready = request.secondsLeft <= 0;

  return (
    <div className="takeover outgoing" role="status">
      <div className="takeover-body">
        {request.denied ? (
          <>
            <strong>{request.holderName}</strong> declined.
          </>
        ) : (
          <>
            Waiting for <strong>{request.holderName}</strong>
            {!ready && <> · {request.secondsLeft}s</>}
          </>
        )}
      </div>
      <div className="takeover-actions">
        <button onClick={onCancel}>Cancel</button>
        <button
          className="danger"
          onClick={onTake}
          disabled={!ready && !request.denied}
          title={
            ready || request.denied
              ? 'Take the stage anyway'
              : 'Available once the wait is over, in case nobody is there'
          }
        >
          Take over
        </button>
      </div>
    </div>
  );
}
