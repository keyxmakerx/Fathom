import { useState, type FormEvent } from 'react';

import {
  disableOperator,
  requestOperator,
  type OperatorRow,
  type PendingChange,
} from '../../api/console';
import { describeConsoleError } from './describeConsoleError';
import '../../styles/console.css';

/**
 * The operator register and the two verbs on it -- ADR-0055 decisions 3, 4
 * and 5.
 *
 * **A colleague is invited at an address**, not only under a display name:
 * decision 5's handoff is "add the successor, they sign in on their own",
 * and an operator with no address of record has nowhere to be told anything.
 * The address is inside the assertion the requesting operator signs, so the
 * operator signs where the invitation goes.
 *
 * With one live operator the quorum is `min(2, live)` = 1: the request
 * stands alone and waits out the 24-hour delay. That is not a weaker rule
 * than §3.5's for stewards; it is the same rule, finally ported.
 */
export interface OperatorsProps {
  actingOperatorId: string;
  rows: OperatorRow[];
  onChanged: () => void;
}

export function Operators({ actingOperatorId, rows, onChanged }: OperatorsProps) {
  return (
    <>
      <table className="console__table">
        <thead>
          <tr>
            <th>ID</th>
            <th>Name</th>
            <th>Email</th>
            <th>Added by</th>
            <th>Status</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id} className={row.disabled ? 'console__row--disabled' : undefined}>
              <td>
                <code>{row.id}</code>
              </td>
              <td>{row.displayName}</td>
              <td>{row.address ?? <span className="console__muted">no email on file</span>}</td>
              <td>{row.createdBy ? <code>{row.createdBy}</code> : 'first start'}</td>
              <td>
                {row.disabled
                  ? 'disabled'
                  : row.neverIndependentlySignedIn
                    ? 'never independently signed in'
                    : 'active'}
              </td>
              <td>
                {!row.disabled && row.id !== actingOperatorId && (
                  <DisableButton operatorId={row.id} onChanged={onChanged} />
                )}
                {row.id === actingOperatorId && <span className="console__muted">you</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <AddColleague actingOperatorId={actingOperatorId} onChanged={onChanged} />
    </>
  );
}

function DisableButton({ operatorId, onChanged }: { operatorId: string; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  async function act() {
    setBusy(true);
    setError(null);
    try {
      await disableOperator(operatorId);
      setConfirming(false);
      onChanged();
    } catch (e) {
      setError(describeConsoleError(e));
    } finally {
      setBusy(false);
    }
  }

  if (!confirming) {
    return (
      <button type="button" className="console__btn" onClick={() => setConfirming(true)}>
        Disable
      </button>
    );
  }
  return (
    <>
      <button type="button" className="console__btn btn-danger" disabled={busy} onClick={act}>
        {busy ? 'Disabling…' : 'Disable, and there is no re-enable'}
      </button>
      <button
        type="button"
        className="console__btn"
        disabled={busy}
        onClick={() => setConfirming(false)}
      >
        Keep
      </button>
      {error && (
        <p className="console__error" role="alert">
          {error}
        </p>
      )}
    </>
  );
}

function AddColleague({
  actingOperatorId,
  onChanged,
}: {
  actingOperatorId: string;
  onChanged: () => void;
}) {
  const [displayName, setDisplayName] = useState('');
  const [address, setAddress] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingChange | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      setPending(await requestOperator(actingOperatorId, displayName.trim(), address.trim()));
      setDisplayName('');
      setAddress('');
      onChanged();
    } catch (e) {
      setError(describeConsoleError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="console__form" onSubmit={submit}>
      <div className="console__form-title">Add a server admin</div>
      <p className="console__note">
        Fathom wants two server admins, so that one person being away does not lock everyone out. Your request is
        signed in this browser, waits out a delay, and is written to the history. When the delay is over, press
        Refresh and it takes effect.
      </p>
      <p className="console__warn">
        Not finished. When the delay ends, the server makes a one-time invitation for your colleague, but this
        screen cannot show it to you yet and Fathom does not email it. Request here to record the intent, then
        finish from the server machine.
      </p>
      <label className="console__label" htmlFor="console-operator-name">
        Display name
      </label>
      <input
        id="console-operator-name"
        className="console__input"
        type="text"
        autoComplete="off"
        value={displayName}
        onChange={(e) => setDisplayName(e.target.value)}
        disabled={busy}
        required
      />
      <label className="console__label" htmlFor="console-operator-address">
        Address
      </label>
      <input
        id="console-operator-address"
        className="console__input"
        type="text"
        autoComplete="off"
        value={address}
        onChange={(e) => setAddress(e.target.value)}
        disabled={busy}
        required
      />
      <button
        type="submit"
        className="console__btn btn-main"
        disabled={busy || displayName.trim().length === 0 || address.trim().length < 3}
      >
        {busy ? 'Requesting…' : 'Ask for this server admin'}
      </button>
      {pending && (
        <p className="console__muted">
          Requested. Change <code>{pending.id}</code> applies at{' '}
          {new Date(pending.effectiveAtUnix * 1000).toLocaleString()}. Until then it is a pending request in the
          history; this build has no route that cancels one.
        </p>
      )}
      {error && (
        <p className="console__error" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}
