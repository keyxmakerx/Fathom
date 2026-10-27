import { useCallback, useEffect, useState } from 'react';

import { type ActivityEntry, fetchActivity } from '../../api/activity';
import { SkeletonRows } from '../ui/Skeleton';
import './console.css';

/**
 * Admin › Activity (sign-offs r52, 2026-10-27). Who signed in, who was refused
 * and what was done on this console, newest first, with the address each came
 * from. It is read out of the sealed site history rather than a log file, so
 * nothing on it can have been edited since; an entry that does not verify says
 * so instead of showing what it claims.
 *
 * "From" is the client's own address. "Through" is the connection's peer,
 * which behind a reverse proxy is the proxy; when the two are always the same
 * address and a proxy is in front, `FATHOM_TRUSTED_PROXIES` is not set
 * (`docs/OPERATING.md`).
 */

const WORDS: Record<string, string> = {
  operator_signin: 'Signed in to Admin',
  operator_signin_failed: 'Admin sign-in refused',
  operator_signed_out: 'Signed out of Admin',
  account_signin: 'Signed in',
  account_signin_failed: 'Sign-in refused',
  account_signed_out: 'Signed out',
  account_created: 'Account created',
  account_disabled: 'Account disabled',
  account_enabled: 'Account enabled',
  account_renamed: 'Account renamed',
  operator_created: 'Operator invited',
  operator_seconded: 'Operator seconded',
  operator_enrolled: 'Operator enrolled',
  operator_disabled: 'Operator disabled',
  operator_read: 'Admin read',
  enrolment_token_issued: 'Enrolment link issued',
  enrolment_token_redeemed: 'Enrolment link used',
  setting_requested: 'Setting change requested',
  setting_seconded: 'Setting change seconded',
  setting_applied: 'Setting applied',
  setting_cancelled: 'Setting change cancelled',
  console_placement_requested: 'Console move requested',
  console_placement_confirmed: 'Console move confirmed',
  console_placement_reverted: 'Console move reverted',
  org_shell_created: 'Organisation created',
  deployment_started: 'Server started',
  ai_switch_changed: 'AI switch changed',
  ai_key_disabled: 'AI key disabled',
};

/** Plain words for an entry type; an unknown one is shown as itself. */
export function entryWords(entryType: string): string {
  return WORDS[entryType] ?? entryType.replace(/_/g, ' ');
}

export type ActivityFilter = 'all' | 'signins' | 'refused';

export function matchesFilter(e: ActivityEntry, filter: ActivityFilter): boolean {
  if (filter === 'refused') return e.entryType.endsWith('_failed');
  if (filter === 'signins') return /signin|signed_out/.test(e.entryType);
  return true;
}

function when(unix: number): string {
  if (!Number.isFinite(unix) || unix <= 0) return '?';
  return new Date(unix * 1000).toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
}

export interface ActivityViewProps {
  loaded: { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; value: ActivityEntry[] };
  filter: ActivityFilter;
}

export function ActivityView({ loaded, filter }: ActivityViewProps) {
  if (loaded.status === 'loading') return <SkeletonRows label="Loading activity…" rows={4} />;
  if (loaded.status === 'error') return <p className="console__warn">Could not read the activity: {loaded.message}</p>;
  const rows = loaded.value.filter((e) => matchesFilter(e, filter));
  if (rows.length === 0) return <p className="console__note">Nothing to show.</p>;
  return (
    <table className="console__table" data-testid="activity-table">
      <thead>
        <tr>
          <th>When</th>
          <th>What</th>
          <th>Who</th>
          <th>From</th>
          <th>Through</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((e) => (
          <tr key={e.seq}>
            <td>{when(e.at)}</td>
            {e.verified ? (
              <>
                <td>
                  {entryWords(e.entryType)}
                  {e.reason && <span className="console__note"> ({e.reason.replace(/_/g, ' ')})</span>}
                </td>
                <td>{e.name || (e.account ? <code>{e.account}</code> : '—')}</td>
                <td>{e.client ? <code>{e.client}</code> : <span className="console__note">not recorded</span>}</td>
                <td>{e.via ? <code>{e.via}</code> : '—'}</td>
              </>
            ) : (
              <td colSpan={4} className="console__warn">
                Entry {e.seq} ({entryWords(e.entryType)}) did not verify: its row was changed in the database. Treat it as an incident.
              </td>
            )}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

const FILTERS: [ActivityFilter, string][] = [
  ['all', 'Everything'],
  ['signins', 'Sign-ins'],
  ['refused', 'Refused'],
];

export function ActivityPanel() {
  const [loaded, setLoaded] = useState<ActivityViewProps['loaded']>({ status: 'loading' });
  const [filter, setFilter] = useState<ActivityFilter>('all');
  const [more, setMore] = useState(true);
  const fail = (error: unknown) =>
    setLoaded({ status: 'error', message: error instanceof Error ? error.message : String(error) });
  const refresh = useCallback(() => {
    fetchActivity()
      .then((value) => {
        setLoaded({ status: 'ready', value });
        setMore(value.length > 0);
      })
      .catch(fail);
  }, []);
  useEffect(refresh, [refresh]);
  const older = () => {
    if (loaded.status !== 'ready' || loaded.value.length === 0) return;
    const oldest = loaded.value[loaded.value.length - 1].seq;
    fetchActivity(oldest)
      .then((page) => {
        setLoaded({ status: 'ready', value: [...loaded.value, ...page] });
        setMore(page.length > 0);
      })
      .catch(fail);
  };
  return (
    <div className="console__form" aria-label="Activity">
      <p className="console__note">
        From the sealed history, so it cannot have been edited. "From" is the person's own address; "Through" is the
        proxy in front, if there is one.
      </p>
      <div className="console__tabs" role="tablist" aria-label="Show">
        {FILTERS.map(([key, label]) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={filter === key}
            className={filter === key ? 'console__tab console__tab--on' : 'console__tab'}
            onClick={() => setFilter(key)}
          >
            {label}
          </button>
        ))}
      </div>
      <ActivityView loaded={loaded} filter={filter} />
      <div>
        <button type="button" className="console__btn console__btn--quiet" onClick={refresh}>
          Refresh
        </button>
        {more && loaded.status === 'ready' && (
          <button type="button" className="console__btn console__btn--quiet" onClick={older}>
            Older
          </button>
        )}
      </div>
    </div>
  );
}
