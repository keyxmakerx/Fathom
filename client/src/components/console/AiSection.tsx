// Admin › AI (ADR-0072 decision 9; mockup r33-ai-admin-a, approved). The operator turns AI
// off for the whole server, and sees every connection and turns any one off with a reason
// its owner and the organisation's Stewards read. An operator cannot turn AI on for an
// organisation, make a connection, widen one, or see a design.

import { useCallback, useEffect, useState } from 'react';

import { disableAiKeyAsAdmin, fetchServerAi, setServerAi, type OrganisationRow, type ServerAi, type ServerAiKey } from '../../api/console';
import { describeConsoleError } from './describeConsoleError';
import { SkeletonRows } from '../ui/Skeleton';

const APP: Record<string, string> = { helper: 'Fathom AI helper', claude: 'Claude', 'claude-code': 'Claude Code', other: 'Other app' };

function ago(unix: number | null): string {
  if (unix === null) return 'never';
  const s = Math.max(0, Date.now() / 1000 - unix);
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min ago`;
  if (s < 86400 * 2) return `${Math.round(s / 3600)} hours ago`;
  return `${Math.round(s / 86400)} days ago`;
}

export function AiSection({ organisations }: { organisations: OrganisationRow[] }) {
  const [ai, setAi] = useState<ServerAi | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [reason, setReason] = useState('');
  const [stopping, setStopping] = useState<ServerAiKey | null>(null);
  const [why, setWhy] = useState('');

  const load = useCallback(() => {
    fetchServerAi().then(
      (v) => {
        setAi(v);
        setError(null);
      },
      (e: unknown) => setError(describeConsoleError(e)),
    );
  }, []);
  useEffect(load, [load]);

  const orgName = (id: string) => organisations.find((o) => o.id === id)?.displayName ?? id;

  async function act(work: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await work();
      setStopping(null);
      setWhy('');
      setReason('');
      load();
    } catch (e) {
      setError(describeConsoleError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="console-ai">
      <p className="console__note">
        An admin can turn AI off for the whole server, and see every AI connection and turn any one off. An admin can’t turn AI on
        for an organisation, make a connection, change what one can see, or see any design.
      </p>
      {error && (
        <p className="console__error" role="alert">
          {error}
        </p>
      )}
      {!ai && !error && <SkeletonRows label="Loading AI on this server…" rows={3} />}
      {ai && (
        <>
          <div className="console-ai__switch">
            <strong>AI {ai.allowed ? 'allowed' : 'off'} on this server.</strong>{' '}
            {ai.allowed ? 'Turning it off stops every connection in every organisation at its next request.' : ai.reason ? `Reason: “${ai.reason}”.` : ''}
          </div>
          <div className="console-ai__row">
            <input
              className="console__input"
              value={reason}
              maxLength={200}
              placeholder={ai.allowed ? 'Why (organisations’ Stewards see this)' : 'Optional note'}
              onChange={(e) => setReason(e.target.value)}
            />
            <button
              type="button"
              className={ai.allowed ? 'console__btn btn-danger' : 'console__btn btn-main'}
              disabled={busy || (ai.allowed && reason.trim() === '')}
              onClick={() => void act(() => setServerAi(!ai.allowed, reason.trim(), ai.version))}
            >
              {ai.allowed ? 'Turn AI off' : 'Allow AI again'}
            </button>
          </div>
          {ai.keys.length === 0 ? (
            <p className="console__note">No AI connection on this server.</p>
          ) : (
            <table className="console__table">
              <thead>
                <tr>
                  <th>App</th>
                  <th>Person</th>
                  <th>Organisation</th>
                  <th>Sees</th>
                  <th>Last used</th>
                  <th>State</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {ai.keys.map((k) => (
                  <tr key={k.id}>
                    <td>{APP[k.app] ?? k.app}</td>
                    <td>
                      {k.ownerName}
                      {k.ownerEmail && <div className="console__note">{k.ownerEmail}</div>}
                      <div className="console__note">
                        {k.aiAccount ? `AI account ${k.aiAccount}, as given; not checked` : 'AI account not given'}
                      </div>
                    </td>
                    <td>{orgName(k.organisation)}</td>
                    <td>{k.sees.join(', ')}</td>
                    <td>{ago(k.lastUsedAt)}</td>
                    <td>
                      {!k.verifies ? 'DOES NOT VERIFY' : k.state === 'on' ? 'On' : k.state === 'expired' ? 'Ended' : 'Off'}
                      {k.stoppedReason ? ` · “${k.stoppedReason}”` : ''}
                    </td>
                    <td>
                      {k.state === 'on' && (
                        <button type="button" className="console__btn" onClick={() => setStopping(k)}>
                          Turn off
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {stopping && (
            <div className="console-ai__stop" role="dialog" aria-label="Turn off an AI connection">
              <strong>
                Turn off {APP[stopping.app] ?? stopping.app} for {stopping.ownerName} in {orgName(stopping.organisation)}
              </strong>
              <input
                className="console__input"
                value={why}
                maxLength={200}
                placeholder="May be compromised: used from 81.2.69.160 at 03:12"
                onChange={(e) => setWhy(e.target.value)}
              />
              <p className="console__note">
                Stops on its next request. {stopping.ownerName} and the organisation’s Stewards are told, with your reason. It can’t be
                turned back on; its owner connects again.
              </p>
              <div className="console-ai__row">
                <button
                  type="button"
                  className="console__btn btn-danger"
                  disabled={busy || why.trim() === ''}
                  onClick={() => void act(() => disableAiKeyAsAdmin(stopping.organisation, stopping.id, why.trim()))}
                >
                  Turn off now
                </button>
                <button type="button" className="console__btn" onClick={() => setStopping(null)}>
                  Cancel
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
