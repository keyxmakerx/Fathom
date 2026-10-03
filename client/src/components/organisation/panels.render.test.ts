import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import type { CheckedProposal } from '../../api/invitations';
import { access, folder, invitation, person } from './fixtures';
import { InviteForm, LinkCard } from './InvitePanel';
import { PeopleList, PersonPage } from './PeoplePanel';
import { ReviewList, SecondingList, StewardCards, WaitingPanel, WaitingTable } from './WaitingPanel';
import { applyEdits, splitRows } from './model';

// Render-to-string tests, as `Enrol.render.test.ts` does: what each screen says
// and shows on first draw. What a click does is in `model.test.ts` and the API tests.

const noop = () => undefined;
const html = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(el);

describe('Invite someone', () => {
  it('asks name, optional email, Read/Draw/Steward and a folder, and says nothing is granted yet', () => {
    const out = html(
      createElement(InviteForm, { folders: [folder('S1', 'LON1')], organisationName: 'Northwind', busy: false, error: null, onSubmit: noop, onCancel: noop }),
    );
    expect(out).toContain('Invite someone');
    expect(out).toContain('Email (optional)');
    for (const word of ['Read', 'Draw', 'Steward']) expect(out).toContain(`<strong>${word}</strong>`);
    expect(out).toContain('LON1');
    expect(out).toContain('Whole organisation (Northwind)');
    expect(out).toContain('Fathom does not send anything to it');
    expect(out).toContain('This only makes an invitation');
  });

  it('shows the link once, with the sign-in name, and says Fathom does not email it', () => {
    const token = `inv_${'a'.repeat(64)}`;
    const out = html(
      createElement(LinkCard, {
        invitation: { invitation: 'I', account: 'A', signInName: 'jo-kim-abcd1234', token, linkPath: `/invite#${token}`, expiresAtUnix: 1_800_259_200 },
        access: 'Draw · LON1',
        name: 'Jo Kim',
        origin: 'https://fathom.example',
        onDone: noop,
        onAnother: noop,
      }),
    );
    expect(out).toContain(`https://fathom.example/invite#${token}`);
    expect(out).toContain('jo-kim-abcd1234');
    expect(out).toContain('Fathom does not email this.');
    expect(out).toContain('You send it yourself');
    expect(out).toContain('will not be shown this link again');
    expect(out).toContain('The link works once');
    expect(out).toContain('Draw · LON1');
  });
});

describe('People', () => {
  const list = { waitingCount: 1, people: [person(), person({ account: 'P2', name: 'Ana Silva', state: 'invited', access: [], asked: { capability: 'read', scopeId: null, scopeLabel: 'Northwind' } })] };

  it('lists name, what they can do, and their state, with the Waiting box and Invite someone', () => {
    const out = html(
      createElement(PeopleList, {
        people: list,
        needsYou: { joined: [{ name: 'Jo Kim', asked: 'Draw · LON1' }], seconding: [{ granter: 'Sam', subject: 'Lee Wong', where: 'LON1' }] },
        onOpenPerson: noop,
        onInvite: noop,
        onOpenWaiting: noop,
      }),
    );
    expect(out).toContain('Invite someone');
    expect(out).toContain('Priya Rao');
    expect(out).toContain('priya@example.test');
    expect(out).toContain('Draw · LON1; Read · whole organisation');
    expect(out).toContain('Read · whole organisation (when they join)');
    expect(out).toContain('Active');
    expect(out).toContain('Invited');
    expect(out).toContain('data-testid="people-waiting-box"');
    expect(out).toContain('<strong>Jo Kim</strong> joined. Asked for Draw · LON1.');
    expect(out).toContain('asked to make <strong>Lee Wong</strong> a Steward of LON1');
    expect(out).toContain('See all (2)');
  });

  it('draws no Waiting box when nobody is waiting', () => {
    const out = html(createElement(PeopleList, { people: list, needsYou: { joined: [], seconding: [] }, onOpenPerson: noop, onInvite: noop, onOpenWaiting: noop }));
    expect(out).not.toContain('people-waiting-box');
  });

  const page = (p = person(), over = {}) =>
    html(createElement(PersonPage, { person: p, folders: [folder('S1', 'LON1')], busy: false, error: null, notice: null, onBack: noop, onRemove: noop, onGive: noop, onWithdraw: noop, onOpenWaiting: noop, ...over }));

  it('a person page lists access rows with Remove only where it can be done, and Give more access', () => {
    const out = page();
    expect(out).toContain('<strong>Draw · LON1</strong>');
    expect(out).toContain('Remove');
    expect(out).toContain('Give more access');
    expect(out).toContain('You do not steward this folder.');
  });

  it('an invited person has Withdraw, a waiting one links to Waiting for you', () => {
    const invited = person({ state: 'invited', access: [], asked: { capability: 'draw', scopeId: 'S1', scopeLabel: 'LON1' } });
    expect(page(invited)).toContain('Withdraw the invitation');
    expect(page(invited)).toContain('They get no access until they have joined and you have confirmed them');
    expect(page({ ...invited, state: 'waiting' })).toContain('Go to Waiting for you');
  });

  it('shows a steward row with its end date and no Remove for your own row', () => {
    const mine = person({ you: true, access: [access({ capability: 'steward', scopeId: null, label: 'Northwind', expiresAtUnix: 1_830_000_000, revokeTakesEffectInSeconds: 0 })] });
    const out = page(mine);
    expect(out).toContain('until ');
    expect(out).toContain('You cannot remove your own access here.');
  });
});

const checkedOf = (n: number, steward = false): CheckedProposal => ({
  organisation: 'ORG',
  granter: 'ME',
  items: Array.from({ length: n }, (_, i) => {
    const inv = invitation(i, steward ? { capabilityAsked: 'steward' } : {});
    return {
      row: { invitation: inv.id, account: inv.account, capability: steward ? 'steward' : 'draw', scopeId: 'S-LON1', keyCode: 'QDMPW1FAVF' },
      bytes: new Uint8Array(),
      item: {
        invitation: inv.id,
        subject: inv.account,
        subjectKeyFpr: '00',
        keyCode: 'QDMPW1FAVF',
        capability: steward ? 'steward' : 'draw',
        scopeId: 'S-LON1',
        effectiveFromUnix: 1,
        expiresAtUnix: steward ? 1_830_000_000 : 0,
        authEpoch: 11 + i,
        soleSteward: false,
        granterKeyFpr: '00',
        rootPubkeyFpr: '00',
        bytes: '',
      },
    };
  }),
});

describe('Waiting for you', () => {
  const rows = splitRows(applyEdits([invitation(1), invitation(2), invitation(3)], {})).batch;
  const table = html(
    createElement(WaitingTable, {
      rows,
      ticks: new Set(rows.map((r) => r.invitation.id)),
      nowMs: 1_800_010_000_000,
      folders: [folder('S-LON1', 'LON1')],
      organisationName: 'Northwind',
      editing: null,
      refusing: null,
      busy: false,
      onToggle: noop,
      onToggleAll: noop,
      onEditOpen: noop,
      onEditSave: noop,
      onRefuseAsk: noop,
      onRefuse: noop,
    }),
  );

  it('shows who invited, when they joined, the code, and labels name and email as typed', () => {
    expect(table).toContain('Name (typed by the steward)');
    expect(table).toContain('Key-check code');
    expect(table).toContain('QDMPW 1FAVF');
    expect(table).toContain('Key Maker');
    expect(table).toContain('p1@example.test');
    expect(table).toContain('Draw · LON1');
  });

  it('has every row ticked, with Change and Refuse on each', () => {
    expect((table.match(/checked=""/g) ?? []).length).toBe(rows.length + 1); // the header tick too
    expect((table.match(/>Change</g) ?? []).length).toBe(3);
    expect((table.match(/>Refuse</g) ?? []).length).toBe(3);
  });

  it('the screen has Confirm N people and the signing sentence, with a full list before signing', () => {
    const out = html(
      createElement(WaitingPanel, {
        waiting: { waitingCount: 3, invitations: [invitation(1), invitation(2), invitation(3)], seconding: [] },
        folders: [folder('S-LON1', 'LON1')],
        organisationName: 'Northwind',
        onPropose: vi.fn(),
        onSign: vi.fn(),
        onRefuse: vi.fn(),
        onApprove: vi.fn(),
        onChanged: noop,
        describeError: String,
      }),
    );
    expect(out).toContain('Confirm 3 people');
    expect(out).toContain('Refuse ticked');
    expect(out).toContain('Signed once, in your browser. Up to 500 at a time.');
    expect(out).toContain('You see the full list before you sign.');
    expect(out).toContain('Name and email are what the steward typed when inviting.');
    expect(out).toContain('someone else may have used their link');
  });

  it('shows every person in the review before signing, and what is signed', () => {
    const out = html(createElement(ReviewList, { checked: checkedOf(3), names: {}, labels: { }, busy: false, steward: null, onSign: noop, onBack: noop }));
    expect(out).toContain('You are about to sign 3 people');
    expect(out).toContain('Sign and confirm 3 people');
    expect(out).toContain('3 signatures, made together, in your browser');
    expect(out).toContain('each naming that person');
    expect((out.match(/QDMPW 1FAVF/g) ?? []).length).toBe(3);
  });

  it('warns that a long batch takes a while', () => {
    expect(html(createElement(ReviewList, { checked: checkedOf(60), names: {}, labels: {}, busy: false, steward: null, onSign: noop, onBack: noop }))).toContain('Keep this page open');
  });

  it('a steward request is reviewed alone, with the expiry, the second-steward need and a code tick that gates signing', () => {
    const out = html(
      createElement(ReviewList, { checked: checkedOf(1, true), names: {}, labels: {}, busy: false, steward: { acknowledged: false, onAcknowledge: noop }, onSign: noop, onBack: noop }),
    );
    expect(out).toContain('Check this Steward request');
    expect(out).toContain('ends ');
    expect(out).toContain('A second steward must agree');
    expect(out).toContain('I compared this code');
    expect(out).toMatch(/<button[^>]*disabled=""[^>]*>Sign and confirm 1 person/);
  });

  it('steward requests are listed one at a time with an end date field and a note, not in the batch', () => {
    const stewards = splitRows(applyEdits([invitation(1, { capabilityAsked: 'steward', scopeId: null, scopeLabel: 'Northwind' })], {})).stewards;
    const out = html(createElement(StewardCards, { rows: stewards, nowMs: 1_800_010_000_000, busy: false, days: 365, onDays: noop, onReview: noop, onRefuse: noop }));
    expect(out).toContain('Steward requests, one at a time');
    expect(out).toContain('Review as Steward');
    expect(out).toContain('asked to be a Steward of the whole organisation');
    expect(out).toContain('with an end date');
  });

  it('lists steward grants that need a second steward, each with Approve', () => {
    const out = html(
      createElement(SecondingList, {
        items: [{ grant: 'G1', scopeId: 'S1', scopeLabel: 'LON1', subject: 'L', subjectName: 'Lee Wong', keyCode: 'AAAAABBBBB', granter: 'S', granterName: 'Sam Ortiz', effectiveFromUnix: 1, expiresAtUnix: 1_830_000_000 }],
        busy: false,
        nowMs: 1_800_000_000_000,
        onApprove: noop,
      }),
    );
    expect(out).toContain('Needs a second steward');
    expect(out).toContain('Sam Ortiz asked to make <strong>Lee Wong</strong> a Steward of LON1');
    expect(out).toContain('AAAAA BBBBB');
    expect(out).toContain('>Approve<');
  });

  it('cannot-be-confirmed rows say why and offer only Refuse', () => {
    const out = html(
      createElement(WaitingPanel, {
        waiting: { waitingCount: 0, invitations: [invitation(1, { canConfirm: false, expired: true })], seconding: [] },
        folders: [],
        organisationName: 'Northwind',
        onPropose: vi.fn(),
        onSign: vi.fn(),
        onRefuse: vi.fn(),
        onApprove: vi.fn(),
        onChanged: noop,
        describeError: String,
      }),
    );
    expect(out).toContain('Cannot be confirmed');
    expect(out).toContain('joined more than 14 days ago');
    expect(out).not.toContain('Confirm 1');
  });
});
