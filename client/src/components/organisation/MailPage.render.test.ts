import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { parseMailPage, type MailPageData, type SentMail } from '../../api/mail';
import { buildIssueBody, parseIssued } from '../../api/invitations';
import { utf8 } from '../../crypto/bytes';
import { LinkCard } from './InvitePanel';
import { howItWent, MailView } from './MailPage';

// Steward › Mail (ADR-0085, the alpha card's Mail): what the page says, given what the server answered.

const noop = () => undefined;
const T = 1_794_679_445;

const mail = (over: Partial<SentMail>): SentMail => ({
  id: 'mail_1',
  kind: 'invitation',
  state: 'sent',
  to: 'sam@example.org',
  what: 'Invitation for Sam Lee',
  attempts: 1,
  createdAtUnix: T,
  nextAttemptAtUnix: null,
  finishedAtUnix: T + 4,
  lastReply: '250 2.0.0 Ok: queued as 4F2A1',
  ...over,
});

const ready: MailPageData = { setUp: true, links: true, fromAddress: 'fathom@example.net', problem: null, mail: [] };

describe('Steward › Mail', () => {
  it('says where mail comes from when it is set up, and that nothing has gone yet', () => {
    const out = renderToStaticMarkup(createElement(MailView, { data: ready, onRefresh: noop, busy: false }));
    expect(out).toContain('fathom@example.net');
    expect(out).toContain('Nothing has been mailed for this organisation yet.');
    expect(out).toContain('Password reset');
    expect(out).toContain('The sign-in name is never in the mail');
    expect(out).not.toContain('not set up');
  });

  it('says plainly that nothing is mailed, and what to do instead, when it is not set up', () => {
    const data = { ...ready, setUp: false, fromAddress: null, problem: 'This server’s mail is not set up. An operator sets it in the console.' };
    const out = renderToStaticMarkup(createElement(MailView, { data, onRefresh: noop, busy: false }));
    expect(out).toContain('steward-mail-not-set-up');
    expect(out).toContain('hand invitation links over yourself');
  });

  it('lists each mail with how it went and the mail server’s own answer, never a body', () => {
    const data = {
      ...ready,
      mail: [
        mail({}),
        mail({ id: 'mail_2', state: 'queued', attempts: 2, finishedAtUnix: null, nextAttemptAtUnix: T + 300, lastReply: '451 4.3.0 try later' }),
        mail({ id: 'mail_3', state: 'failed', attempts: 1, lastReply: '550 5.1.1 no such user' }),
      ],
    };
    const out = renderToStaticMarkup(createElement(MailView, { data, onRefresh: noop, busy: false }));
    expect(out).toContain('250 2.0.0 Ok: queued as 4F2A1');
    expect(out).toContain('Tried 2 of 6 times');
    expect(out).toContain('550 5.1.1 no such user');
    expect(out).toContain('data-state="failed"');
  });

  it('words each state', () => {
    expect(howItWent(mail({ state: 'queued', attempts: 0, finishedAtUnix: null }))).toBe('Waiting to be sent');
    expect(howItWent(mail({ state: 'failed', attempts: 6 }))).toBe('Not sent, after 6 tries');
    expect(howItWent(mail({ state: 'sent' }))).toMatch(/^Sent /);
  });

  it('reads the server’s answer, nulls included', () => {
    const parsed = parseMailPage(
      utf8(
        JSON.stringify({
          set_up: false,
          links: false,
          from_address: null,
          problem: 'x',
          mail: [{ id: 'mail_1', kind: 'reset', state: 'queued', to: 'a@b.c', what: 'Password reset', attempts: 0, created_at_unix: T, next_attempt_at_unix: T, finished_at_unix: null, last_reply: null }],
        }),
      ),
    );
    expect(parsed.mail[0].kind).toBe('reset');
    expect(parsed.mail[0].lastReply).toBeNull();
    expect(() => parseMailPage(utf8(JSON.stringify({ ...ready, set_up: true, mail: [{ state: 'lost' }] })))).toThrow();
  });
});

describe('Email them the link', () => {
  it('adds one field, "mail", only when asked', () => {
    const base = { name: 'Sam', email: 'sam@example.org', capability: 'draw' as const, scopeId: null };
    expect(buildIssueBody({ ...base, mail: true }).length - buildIssueBody(base).length).toBe(4 + 4);
    expect(buildIssueBody({ ...base, mail: false })).toEqual(buildIssueBody(base));
  });

  it('reads whether it was mailed, and an older server’s answer as not mailed', () => {
    const token = `inv_${'a'.repeat(64)}`;
    const good = { invitation: 'I', account: 'A', sign_in_name: 'n', token, link_path: '/invite#x', expires_at_unix: T };
    expect(parseIssued(utf8(JSON.stringify(good))).mailed).toBe('no');
    expect(parseIssued(utf8(JSON.stringify({ ...good, mail: 'queued' }))).mailed).toBe('queued');
  });

  it('tells the Steward the link is on its way, and that the sign-in name is theirs to give', () => {
    const token = `inv_${'a'.repeat(64)}`;
    const out = renderToStaticMarkup(
      createElement(LinkCard, {
        invitation: { invitation: 'I', account: 'A', signInName: 'jo-kim-abcd1234', token, linkPath: `/invite#${token}`, expiresAtUnix: T, mailed: 'queued' },
        access: 'Draw · LON1',
        name: 'Jo Kim',
        added: true,
        notAddedBecause: null,
        origin: 'https://fathom.example',
        onDone: noop,
        onAnother: noop,
      }),
    );
    expect(out).toContain('The link is on its way by mail.');
    expect(out).toContain('Give them the sign-in name yourself');
  });
});
