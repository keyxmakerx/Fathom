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
            <th>id</th>
            <th>name</th>
            <th>address</th>
            <th>created by</th>
            <th>state</th>
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
              <td>{row.address ?? <span className="console__muted">no address of record</span>}</td>
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
      <button type="button" className="console__btn console__btn--quiet" onClick={() => setConfirming(true)}>
        Disable
      </button>
    );
  }
  return (
    <>
      <button type="button" className="console__btn" disabled={busy} onClick={act}>
        {busy ? 'Disabling…' : 'Disable, and there is no re-enable'}
      </button>
      <button
        type="button"
        className="console__btn console__btn--quiet"
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
      <div className="console__form-title">Add an operator</div>
      <p className="console__note">
        Two operators is the standing shape: one person who is unreachable should not take the install with them.
        The request is signed with the operator key in this browser, waits out its delay, and is recorded on the
        site trail; refreshing this register after the delay is what applies it.
      </p>
      <p className="console__warn">
        Their way in is not complete in this build. When the request applies, the server mints the colleague's
        single-use enrolment token — and there is no route that hands it to you: the register discards it
        (<code>admin.rs</code>'s <code>list_operators</code>), and nothing is emailed until mail is set above and
        the mail client ships. So request a colleague here to record the intent, and expect to finish it from the
        host.
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
        className="console__btn"
        disabled={busy || displayName.trim().length === 0 || address.trim().length < 3}
      >
        {busy ? 'Requesting…' : 'Request this colleague'}
      </button>
      {pending && (
        <p className="console__muted">
          Requested. Change <code>{pending.id}</code> applies at{' '}
          {new Date(pending.effectiveAtUnix * 1000).toLocaleString()}. Until then it is a pending request on the
          site trail; this build has no route that cancels one.
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
