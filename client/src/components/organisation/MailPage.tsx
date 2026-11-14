// Steward › Mail (ADR-0085 decision 7, the alpha card's Mail, 2026-11-14). Whether this server
// can send mail and from which address, what Fathom mails, and every mail sent for this
// organisation with how it went and the mail server's own answer. Never what a mail said.

import { useCallback, useEffect, useState } from 'react';

import { describeError } from '../../api/invitations';
import { fetchMailPage, type MailPageData, type SentMail } from '../../api/mail';
import { dateTimeLabel } from './model';

type Load = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; value: MailPageData };

/** The six tries a mail gets: the first, then after 1, 5 and 30 minutes, 2 and 12 hours. */
const TRIES = 6;

/** How one mail went, in words. */
export function howItWent(m: SentMail): string {
  if (m.state === 'sent') return m.finishedAtUnix === null ? 'Sent' : `Sent ${dateTimeLabel(m.finishedAtUnix)}`;
  if (m.state === 'failed') return m.attempts > 1 ? `Not sent, after ${m.attempts} tries` : 'Not sent';
  if (m.attempts === 0) return 'Waiting to be sent';
  const next = m.nextAttemptAtUnix === null ? '' : `, next at ${dateTimeLabel(m.nextAttemptAtUnix)}`;
  return `Tried ${m.attempts} of ${TRIES} times${next}`;
}

/** The page, given what the server answered. Separate so a test can render it without a server. */
export function MailView({ data, onRefresh, busy }: { data: MailPageData; onRefresh: () => void; busy: boolean }) {
  return (
    <section className="org-page" data-testid="steward-mail">
      <div className="org-page__title">Mail</div>
      <p className="org-field__hint">
        What Fathom mails to people in this organisation, and how each mail went. A mail says what happened and gives a link; it never
        carries designs, addresses, notes or passwords.
      </p>
      {data.setUp ? (
        <dl className="org-facts" data-testid="steward-mail-ready">
          <dt>Sent from</dt>
          <dd className="org-mono">{data.fromAddress}</dd>
          <dt>Set by</dt>
          <dd>This server’s operator, in the console</dd>
        </dl>
      ) : (
        <p className="home__error" role="status" data-testid="steward-mail-not-set-up">
          {data.problem ?? (data.links ? 'Mail is not set up on this server.' : 'This server does not know its own address, so it cannot put links in mail.')}{' '}
          Until it is, nothing is mailed: hand invitation links over yourself, and people who forget their password ask you.
        </p>
      )}
      <div className="org-field__label">What Fathom mails</div>
      <table className="org-table org-mail__kinds">
        <tbody>
          <tr>
            <td>
              <strong>Password reset</strong>
            </td>
            <td>When someone asks, to their own sign-in address. Always on. They still need their authenticator app to sign in.</td>
          </tr>
          <tr>
            <td>
              <strong>Invitation link</strong>
            </td>
            <td>
              When you tick <em>Email them the link</em> while adding someone. The sign-in name is never in the mail: you give it to them
              yourself.
            </td>
          </tr>
          <tr className="org-mail__later">
            <td>
              <strong>Work and order notices</strong>
            </td>
            <td>Not yet. They come with the Work screens, and each person will choose their own.</td>
          </tr>
        </tbody>
      </table>
      <div className="org-mail__head">
        <div className="org-field__label">Sent for this organisation</div>
        <button type="button" className="home__btn btn-small" disabled={busy} onClick={onRefresh} data-testid="steward-mail-refresh">
          {busy ? 'Checking…' : 'Check again'}
        </button>
      </div>
      {data.mail.length === 0 ? (
        <p className="org-field__hint" data-testid="steward-mail-empty">
          Nothing has been mailed for this organisation yet.
        </p>
      ) : (
        <div className="org-scroll">
          <table className="org-table" data-testid="steward-mail-list">
            <thead>
              <tr>
                <th>When</th>
                <th>What</th>
                <th>To</th>
                <th>How it went</th>
                <th>The mail server said</th>
              </tr>
            </thead>
            <tbody>
              {data.mail.map((m) => (
                <tr key={m.id} data-state={m.state}>
                  <td className="org-mail__when">{dateTimeLabel(m.createdAtUnix)}</td>
                  <td>{m.what}</td>
                  <td className="org-mono">{m.to}</td>
                  <td className={`org-mail__state org-mail__state--${m.state}`}>{howItWent(m)}</td>
                  <td className="org-mono org-mail__reply">{m.lastReply ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="org-field__hint">Kept for 90 days. What each mail said is not kept once it is sent.</p>
    </section>
  );
}

export function MailPage({ organisationId }: { organisationId: string }) {
  const [load, setLoad] = useState<Load>({ status: 'loading' });
  const [busy, setBusy] = useState(false);

  const reload = useCallback(() => {
    setBusy(true);
    fetchMailPage(organisationId).then(
      (value) => {
        setLoad({ status: 'ready', value });
        setBusy(false);
      },
      (e: unknown) => {
        setLoad({ status: 'error', message: describeError(e) });
        setBusy(false);
      },
    );
  }, [organisationId]);
  useEffect(reload, [reload]);

  if (load.status === 'loading') return <p className="home__muted">Loading…</p>;
  if (load.status === 'error') {
    return (
      <section className="org-page">
        <div className="org-page__title">Mail</div>
        <p className="home__error" role="alert">
          {load.message}
        </p>
      </section>
    );
  }
  return <MailView data={load.value} onRefresh={reload} busy={busy} />;
}
