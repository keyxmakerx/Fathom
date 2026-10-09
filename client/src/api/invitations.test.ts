import { beforeEach, describe, expect, it, vi } from 'vitest';

import { fromHex, readLp, toHex, utf8 } from '../crypto/bytes';

const sent: { method: string; path: string; body?: Uint8Array }[] = [];
let answers: Record<string, unknown> = {};

vi.mock('./signedFetch', () => ({
  signedFetch: async (method: string, path: string, body?: Uint8Array) => {
    sent.push({ method, path, body });
    return new TextEncoder().encode(JSON.stringify(answers[`${method} ${path}`] ?? {}));
  },
}));
vi.mock('../crypto/keys', async () => {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
  return {
    getEnrolledKeyPair: async () => pair,
    exportPublicKeyRaw: async (key: CryptoKey) => new Uint8Array(await crypto.subtle.exportKey('raw', key)),
    signMessage: async () => new Uint8Array(64).fill(7),
  };
});
vi.mock('../state/sessionState', () => ({ getSession: () => ({ kind: 'steward', address: 'a@b.c', accountId: 'ME' }) }));

import { ApiRefusal } from './errors';
import { grantBytes, keyCode, type GrantFacts } from './grantBytes';
import {
  BATCH_CAP,
  buildConfirmBody,
  buildIssueBody,
  buildProposeBody,
  checkProposal,
  DAY_SECONDS,
  describeError,
  orderedRows,
  parseInvitation,
  parseIssued,
  parseWaiting,
  proposeConfirm,
  signAndConfirm,
  type ConfirmRow,
  type Proposal,
  type ProposedItem,
} from './invitations';
import { ownKeyFingerprint } from './share';

const NOW = 1_800_000_000;
const fill = (n: number) => new Uint8Array(32).fill(n);
const subjectFpr = (i: number) => fill(0x20 + i);
const ULID = (i: number) => `01JQZ00000000000000000A${String(i).padStart(3, '0')}`;

const row = (i: number, over: Partial<ConfirmRow> = {}): ConfirmRow => ({
  invitation: ULID(i),
  account: `ACC${i}`,
  capability: 'draw',
  scopeId: 'SCOPE1',
  keyCode: keyCode(subjectFpr(i)),
  ...over,
});

/** What an honest server proposes for these rows. */
async function honest(rows: ConfirmRow[], head = 10): Promise<{ proposal: Proposal; granterFpr: Uint8Array }> {
  const granterFpr = await ownKeyFingerprint();
  const items = rows.map((r, i): ProposedItem => {
    const n = Number(r.invitation.slice(-3));
    const steward = r.capability === 'steward';
    const facts: GrantFacts = {
      organisation: 'ORG',
      rootPubkeyFpr: fill(9),
      scope: r.scopeId ?? '',
      subject: r.account,
      subjectKeyFpr: subjectFpr(n),
      capability: r.capability,
      granter: 'ME',
      granterKeyFpr: granterFpr,
      effectiveFromUnix: NOW,
      expiresAtUnix: steward ? NOW + 100 * DAY_SECONDS : 0,
      soleSteward: false,
      authEpoch: head + 1 + i,
    };
    return {
      invitation: r.invitation,
      subject: r.account,
      subjectKeyFpr: toHex(subjectFpr(n)),
      keyCode: keyCode(subjectFpr(n)),
      capability: r.capability,
      scopeId: r.scopeId,
      effectiveFromUnix: NOW,
      expiresAtUnix: facts.expiresAtUnix,
      authEpoch: facts.authEpoch,
      soleSteward: false,
      granterKeyFpr: toHex(granterFpr),
      rootPubkeyFpr: toHex(fill(9)),
      bytes: toHex(grantBytes(facts)),
    };
  });
  return { proposal: { headEpoch: head, items }, granterFpr };
}

const check = (rows: ConfirmRow[], proposal: Proposal, granterFpr: Uint8Array, wanted: number | null = null) =>
  checkProposal('ORG', 'ME', granterFpr, rows, proposal, NOW, wanted);

beforeEach(() => {
  sent.length = 0;
  answers = {};
});

describe('issue', () => {
  it('sends name, email, capability and scope, and no account', () => {
    let rest = buildIssueBody({ name: 'Jo Kim', email: '', capability: 'draw', scopeId: null });
    const fields: string[] = [];
    while (rest.length) {
      const f = readLp(rest);
      fields.push(new TextDecoder().decode(f.value));
      rest = f.rest;
    }
    expect(fields).toEqual(['Jo Kim', '', 'draw', '']);
  });

  it('reads the one-time answer and refuses a token of the wrong shape', () => {
    const token = `inv_${'a'.repeat(64)}`;
    const good = {
      invitation: 'I1',
      account: 'A1',
      sign_in_name: 'jo-kim-abcd1234',
      token,
      link_path: `/invite#${token}`,
      expires_at_unix: 5,
    };
    expect(parseIssued(utf8(JSON.stringify(good)))).toMatchObject({ signInName: 'jo-kim-abcd1234', token, linkPath: `/invite#${token}` });
    expect(() => parseIssued(utf8(JSON.stringify({ ...good, token: 'inv_short' })))).toThrow(/bad token/);
  });
});

describe('the Waiting list', () => {
  const invitation = {
    id: 'I1',
    account: 'A1',
    state: 'joined',
    display_name: 'Jo Kim',
    contact_email: 'jo@x.example',
    sign_in_name: 'jo-kim-abcd1234',
    capability_asked: 'draw',
    scope_id: 'S1',
    scope_label: 'LON1',
    key_code: 'QDMPW1FAVF',
    issued_by: 'ME',
    issued_by_name: 'Key Maker',
    issued_at_unix: 1,
    joined_at_unix: 2,
    window_ends_at_unix: 3,
    expired: false,
    unverifiable: false,
    can_confirm: true,
  };

  it('reads an invitation, with nulls for what is not there yet', () => {
    expect(parseInvitation(invitation, 0)).toMatchObject({ displayName: 'Jo Kim', keyCode: 'QDMPW1FAVF', canConfirm: true, joinedAtUnix: 2 });
    const asked = parseInvitation({ ...invitation, state: 'asked', key_code: null, joined_at_unix: null, contact_email: null, can_confirm: false }, 1);
    expect(asked).toMatchObject({ keyCode: null, joinedAtUnix: null, contactEmail: null, canConfirm: false });
  });

  it('refuses an unknown capability or state', () => {
    expect(() => parseInvitation({ ...invitation, capability_asked: 'owner' }, 0)).toThrow(/capability_asked/);
    expect(() => parseInvitation({ ...invitation, state: 'confirmed' }, 0)).toThrow(/state/);
  });

  it('reads the count, the rows and the stewards waiting for a second', () => {
    const waiting = parseWaiting(
      utf8(
        JSON.stringify({
          waiting_count: 1,
          invitations: [invitation],
          seconding: [
            {
              grant: 'G1',
              scope_id: null,
              scope_label: 'Northwind',
              subject: 'S',
              subject_name: 'Lee',
              key_code: 'AAAAAAAAAA',
              granter: 'X',
              granter_name: 'Sam',
              effective_from_unix: 1,
              expires_at_unix: 2,
            },
          ],
        }),
      ),
    );
    expect(waiting.waitingCount).toBe(1);
    expect(waiting.seconding[0]).toMatchObject({ subjectName: 'Lee', scopeId: null, granterName: 'Sam' });
    expect(() => parseWaiting(utf8('{}'))).toThrow(/malformed/);
  });
});

describe('the rows to confirm', () => {
  it('are sent in ascending order, between one and the cap', () => {
    expect(orderedRows([row(3), row(1), row(2)]).map((r) => r.invitation)).toEqual([ULID(1), ULID(2), ULID(3)]);
    expect(() => orderedRows([])).toThrow(/at least one/);
    expect(() => orderedRows(Array.from({ length: BATCH_CAP + 1 }, (_, i) => row(i)))).toThrow(/at most 500/);
    expect(() => orderedRows([row(1), row(1)])).toThrow(/twice/);
  });

  it('keep a steward request out of any batch', () => {
    expect(() => orderedRows([row(1, { capability: 'steward' }), row(2)])).toThrow(/on its own/);
    expect(orderedRows([row(1, { capability: 'steward' })])).toHaveLength(1);
  });

  it('frame the propose body, with the expiry only on one steward request', () => {
    const two = buildProposeBody([row(1), row(2)], null);
    const count = readLp(two);
    expect(new TextDecoder().decode(count.value)).toBe('2');
    const one = buildProposeBody([row(1, { capability: 'steward', scopeId: null })], 123);
    const fields: string[] = [];
    let rest = one;
    while (rest.length) {
      const f = readLp(rest);
      fields.push(new TextDecoder().decode(f.value));
      rest = f.rest;
    }
    expect(fields).toEqual(['1', ULID(1), 'steward', '', '123']);
  });
});

describe('checking a proposal against the rows', () => {
  it('accepts exactly what was ticked, and returns the bytes built here', async () => {
    const rows = [row(1), row(2), row(3, { scopeId: null })];
    const { proposal, granterFpr } = await honest(rows);
    const checked = check(rows, proposal, granterFpr);
    expect(checked.items.map((c) => toHex(c.bytes))).toEqual(proposal.items.map((i) => i.bytes));
  });

  it('refuses an extra, a missing or a swapped item', async () => {
    const rows = [row(1), row(2)];
    const { proposal, granterFpr } = await honest(rows);
    const extra = await honest([...rows, row(3)]);
    expect(() => check(rows, extra.proposal, granterFpr)).toThrow(/different number/);
    expect(() => check(rows, { ...proposal, items: proposal.items.slice(0, 1) }, granterFpr)).toThrow(/different number/);
    expect(() => check(rows, { ...proposal, items: [proposal.items[1], proposal.items[0]] }, granterFpr)).toThrow(/different person or order/);
    const swapped = { ...proposal, items: [{ ...proposal.items[0], invitation: ULID(9) }, proposal.items[1]] };
    expect(() => check(rows, swapped, granterFpr)).toThrow(/different person or order/);
  });

  it('refuses a different person, access, folder or key', async () => {
    const rows = [row(1)];
    const { proposal, granterFpr } = await honest(rows);
    const item = proposal.items[0];
    const with_ = (over: Partial<ProposedItem>): Proposal => ({ ...proposal, items: [{ ...item, ...over }] });
    expect(() => check(rows, with_({ subject: 'EVIL' }), granterFpr)).toThrow(/different account/);
    expect(() => check(rows, with_({ capability: 'read' }), granterFpr)).toThrow(/different access/);
    expect(() => check(rows, with_({ scopeId: 'OTHER' }), granterFpr)).toThrow(/different folder/);
    // A different subject key: its code no longer matches the one on the row.
    expect(() => check(rows, with_({ subjectKeyFpr: toHex(fill(0xee)) }), granterFpr)).toThrow(/different key/);
    expect(() => check(rows, with_({ keyCode: 'AAAAAAAAAA' }), granterFpr)).toThrow(/different key/);
  });

  it('refuses epochs that are not consecutive from the head', async () => {
    const rows = [row(1), row(2)];
    const { proposal, granterFpr } = await honest(rows);
    const skipped = { ...proposal, items: [proposal.items[0], { ...proposal.items[1], authEpoch: proposal.items[1].authEpoch + 1 }] };
    expect(() => check(rows, skipped, granterFpr)).toThrow(/consecutive/);
    expect(() => check(rows, { ...proposal, headEpoch: proposal.headEpoch + 1 }, granterFpr)).toThrow(/consecutive/);
  });

  it('refuses grant bytes that are not the ones built here', async () => {
    const rows = [row(1)];
    const { proposal, granterFpr } = await honest(rows);
    const bytes = fromHex(proposal.items[0].bytes);
    bytes[bytes.length - 1] ^= 1;
    expect(() => check(rows, { ...proposal, items: [{ ...proposal.items[0], bytes: toHex(bytes) }] }, granterFpr)).toThrow(/grant bytes/);
  });

  it('refuses a granter key that is not this browser’s and a second organisation root', async () => {
    const rows = [row(1), row(2)];
    const { proposal, granterFpr } = await honest(rows);
    expect(() => check(rows, proposal, fill(1))).toThrow(/not this browser/);
    const two = { ...proposal, items: [proposal.items[0], { ...proposal.items[1], rootPubkeyFpr: toHex(fill(5)) }] };
    expect(() => check(rows, two, granterFpr)).toThrow(/more than one organisation root/);
  });

  it('holds a steward request to an expiry between a day and a year, and read or draw to none', async () => {
    const rows = [row(1, { capability: 'steward' })];
    const { proposal, granterFpr } = await honest(rows);
    expect(check(rows, proposal, granterFpr).items).toHaveLength(1);
    const expiring = (expiresAtUnix: number): Proposal => ({ ...proposal, items: [{ ...proposal.items[0], expiresAtUnix }] });
    expect(() => check(rows, expiring(NOW + 3600), granterFpr)).toThrow(/expiry/);
    expect(() => check(rows, expiring(NOW + 400 * DAY_SECONDS), granterFpr)).toThrow(/expiry/);
    expect(() => check(rows, proposal, granterFpr, NOW + 50 * DAY_SECONDS)).toThrow(/different expiry/);
    const draw = [row(1)];
    const d = await honest(draw);
    expect(() => check(draw, { ...d.proposal, items: [{ ...d.proposal.items[0], expiresAtUnix: NOW + 5 * DAY_SECONDS }] }, d.granterFpr)).toThrow(
      /expiry on a read or draw/,
    );
  });
});

describe('confirming', () => {
  it('proposes, checks, signs every grant and sends one request with consecutive epochs', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW * 1000);
    try {
      const rows = [row(2), row(1)];
      const sorted = [row(1), row(2)];
      const { proposal } = await honest(sorted);
      answers['POST /organisations/ORG/invitations/confirm/propose'] = {
        head_epoch: proposal.headEpoch,
        items: proposal.items.map((i) => ({
          invitation: i.invitation,
          subject: i.subject,
          subject_key_fpr: i.subjectKeyFpr,
          key_code: i.keyCode,
          capability: i.capability,
          scope_id: i.scopeId,
          effective_from_unix: i.effectiveFromUnix,
          expires_at_unix: i.expiresAtUnix,
          auth_epoch: i.authEpoch,
          sole_steward_appointment: i.soleSteward,
          granter_key_fpr: i.granterKeyFpr,
          root_pubkey_fpr: i.rootPubkeyFpr,
          bytes: i.bytes,
        })),
      };
      answers['POST /organisations/ORG/invitations/confirm'] = {
        batch_id: 'B1',
        confirmed: proposal.items.map((i) => ({
          invitation: i.invitation,
          account: i.subject,
          grant: `G${i.authEpoch}`,
          capability: i.capability,
          scope_id: i.scopeId,
          effective_from_unix: NOW,
          needs_second: false,
        })),
      };
      const checked = await proposeConfirm('ORG', rows);
      expect(checked.items.map((c) => c.row.invitation)).toEqual([ULID(1), ULID(2)]);
      const result = await signAndConfirm(checked);
      expect(result.confirmed.map((c) => c.grant)).toEqual(['G11', 'G12']);

      const body = sent[sent.length - 1].body!;
      let rest = body;
      const n = readLp(rest);
      rest = n.rest;
      expect(new TextDecoder().decode(n.value)).toBe('2');
      const epochs: string[] = [];
      for (let i = 0; i < 2; i += 1) {
        const f: string[] = [];
        for (let k = 0; k < 10; k += 1) {
          const field = readLp(rest);
          f.push(new TextDecoder().decode(field.value));
          rest = field.rest;
        }
        epochs.push(f[4]);
        expect(f[9]).toBe(toHex(new Uint8Array(64).fill(7)));
      }
      expect(epochs).toEqual(['11', '12']);
      expect(rest.length).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('signs nothing when the proposal does not match', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW * 1000);
    try {
      const rows = [row(1)];
      const { proposal } = await honest(rows);
      answers['POST /organisations/ORG/invitations/confirm/propose'] = {
        head_epoch: proposal.headEpoch,
        items: [{ ...proposal.items[0], subject: 'EVIL', subject_key_fpr: proposal.items[0].subjectKeyFpr, key_code: proposal.items[0].keyCode, scope_id: 'SCOPE1', effective_from_unix: NOW, expires_at_unix: 0, auth_epoch: 11, sole_steward_appointment: false, granter_key_fpr: proposal.items[0].granterKeyFpr, root_pubkey_fpr: proposal.items[0].rootPubkeyFpr }],
      };
      await expect(proposeConfirm('ORG', rows)).rejects.toThrow(/nothing was signed/);
      expect(sent.some((s) => s.path.endsWith('/confirm'))).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('never puts the subject in the confirm body', async () => {
    const rows = [row(1)];
    const { proposal } = await honest(rows);
    const body = buildConfirmBody([{ item: proposal.items[0], signature: new Uint8Array(64) }]);
    expect(new TextDecoder().decode(body)).not.toContain('ACC1');
  });
});

describe('words for refusals', () => {
  it('turns a batch refusal into what it means and says nothing was signed', () => {
    const stale = new ApiRefusal(409, JSON.stringify({ error: 'batch_refused', index: 2, reason: 'stale' }), null);
    expect(describeError(stale)).toMatch(/confirm again/);
    expect(describeError(new ApiRefusal(409, JSON.stringify({ error: 'batch_refused', index: 0, reason: 'key_changed' }), null))).toMatch(/keys changed/);
  });

  it('says plainly that a non-steward was refused, and names the invitation caps', () => {
    expect(describeError(new ApiRefusal(403, 'not authorised', null))).toMatch(/Only a steward/);
    expect(describeError(new ApiRefusal(429, 'too many open invitations', null))).toMatch(/too many open/);
    expect(describeError(new ApiRefusal(429, 'slow down', 3600))).toMatch(/60 minutes/);
    expect(describeError(new ApiRefusal(404, 'no such invitation', null))).toBe('no such invitation');
  });
});
