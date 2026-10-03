import { beforeEach, describe, expect, it, vi } from 'vitest';

import { concatBytes, lp, readLp, toHex, u64LE, utf8 } from '../crypto/bytes';

const signed: { method: string; path: string; body?: Uint8Array }[] = [];
let answers: Record<string, unknown> = {};

vi.mock('./signedFetch', () => ({
  signedFetch: async (method: string, path: string, body?: Uint8Array) => {
    signed.push({ method, path, body });
    const key = `${method} ${path.replace(/\/grants\/[A-Z0-9]+\/revoke/, '/grants/G/revoke')}`;
    return new TextEncoder().encode(JSON.stringify(answers[key] ?? {}));
  },
}));
vi.mock('../crypto/keys', async () => {
  const subtle = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
  return {
    getEnrolledKeyPair: async () => subtle,
    signMessage: async () => new Uint8Array(64),
  };
});
vi.mock('../state/sessionState', () => ({ getSession: () => ({ kind: 'steward', address: 'a@b.c', accountId: 'ME' }) }));

import { parseAccess, setShare, shareGrantBytes, type AccessPerson } from './share';

const fpr = (n: number) => new Uint8Array(32).fill(n);
const grantFor = (capability: 'read' | 'draw', subject = 'P1') =>
  toHex(shareGrantBytes({ organisation: 'O', rootPubkeyFpr: fpr(3), scope: 'S', subject, subjectKeyFpr: fpr(2), capability, granter: 'ME', granterKeyFpr: fpr(1), effectiveFromUnix: 100, authEpoch: 3 }));
const revokeFor = (grant: string, at: number) => toHex(concatBytes(lp(utf8('fathom/grant/revoke/v1')), lp(utf8('O')), lp(utf8(grant)), lp(fpr(9)), u64LE(at)));

const person = (direct: AccessPerson['direct']): AccessPerson => ({
  account: 'P1',
  email: 'p@x',
  name: 'P',
  you: false,
  standing: direct[0]?.capability ?? null,
  inherited: false,
  direct,
});

beforeEach(() => {
  signed.length = 0;
  answers = {
    'POST /organisations/O/scopes/S/grants/propose': proposal('read'),
    'GET /organisations/O/scopes/S/grants/G/revoke': { at: 500, bytes: revokeFor('G', 500) },
  };
});

function proposal(capability: 'read' | 'draw', bytes = grantFor(capability)) {
  return {
    subject: 'P1',
    capability,
    effective_from_unix: 100,
    auth_epoch: 3,
    granter_key_fpr: toHex(fpr(1)),
    subject_key_fpr: toHex(fpr(2)),
    root_pubkey_fpr: toHex(fpr(3)),
    bytes,
  };
}

describe('parseAccess', () => {
  it('reads people, their standing and their direct grants', () => {
    const bytes = utf8(
      JSON.stringify({
        people: [
          { account: 'A', email: 'a@x', name: 'A', you: true, capability: 'steward', inherited: false, direct: [] },
          { account: 'B', email: 'b@x', name: 'B', you: false, capability: 'read', inherited: false, direct: [{ grant: 'G1', capability: 'read' }] },
          { account: 'C', email: 'c@x', name: 'C', you: false, capability: null, inherited: false, direct: [] },
        ],
      }),
    );
    const people = parseAccess(bytes);
    expect(people.map((p) => p.standing)).toEqual(['steward', 'read', null]);
    expect(people[1].direct).toEqual([{ grant: 'G1', capability: 'read' }]);
  });

  it('refuses a body with no people list', () => {
    expect(() => parseAccess(utf8('{}'))).toThrow(/malformed/);
  });
});

describe('setShare', () => {
  it('proposes then signs, sending the proposal back with the signature', async () => {
    await setShare('O', 'S', person([]), 'read');
    expect(signed.map((s) => `${s.method} ${s.path}`)).toEqual([
      'POST /organisations/O/scopes/S/grants/propose',
      'POST /organisations/O/scopes/S/grants/sign',
    ]);
    // eight fields: seven from the proposal and the signature
    let rest = signed[1].body!;
    const fields: string[] = [];
    while (rest.length > 0) {
      const f = readLp(rest);
      fields.push(new TextDecoder().decode(f.value));
      rest = f.rest;
    }
    expect(fields.slice(0, 7)).toEqual(['P1', 'read', '100', '3', toHex(fpr(1)), toHex(fpr(2)), toHex(fpr(3))]);
    expect(fields[7]).toBe('00'.repeat(64));
  });

  it('revokes the grant that differs before adding the new one', async () => {
    await setShare('O', 'S', person([{ grant: 'G', capability: 'draw' }]), 'read');
    expect(signed.map((s) => s.method + ' ' + s.path.split('/scopes/S/')[1])).toEqual([
      'GET grants/G/revoke',
      'POST grants/G/revoke',
      'POST grants/propose',
      'POST grants/sign',
    ]);
    expect(readLp(signed[2].body!).value).toEqual(utf8('P1'));
    
  });

  it('does nothing when the choice is already what they have', async () => {
    await setShare('O', 'S', person([{ grant: 'G', capability: 'read' }]), 'read');
    expect(signed).toEqual([]);
  });

  it('"none" only revokes', async () => {
    await setShare('O', 'S', person([{ grant: 'G', capability: 'read' }]), 'none');
    expect(signed.map((s) => s.method)).toEqual(['GET', 'POST']);
  });
});

describe('what the key will sign', () => {
  it('refuses a proposal whose bytes are not the grant that was chosen', async () => {
    answers['POST /organisations/O/scopes/S/grants/propose'] = proposal('read', grantFor('draw'));
    await expect(setShare('O', 'S', person([]), 'read')).rejects.toThrow(/not the one you chose/);
    expect(signed.map((s) => s.path.split('/scopes/S/')[1])).toEqual(['grants/propose']);
  });

  it('refuses a proposal naming someone else', async () => {
    answers['POST /organisations/O/scopes/S/grants/propose'] = proposal('read', grantFor('read', 'SOMEONE_ELSE'));
    await expect(setShare('O', 'S', person([]), 'read')).rejects.toThrow(/not the one you chose/);
  });

  it('refuses revoke bytes that are not a revocation of this grant at this time', async () => {
    answers['GET /organisations/O/scopes/S/grants/G/revoke'] = { at: 500, bytes: revokeFor('OTHER', 500) };
    await expect(setShare('O', 'S', person([{ grant: 'G', capability: 'read' }]), 'none')).rejects.toThrow(/other than this revocation/);
    answers['GET /organisations/O/scopes/S/grants/G/revoke'] = { at: 500, bytes: revokeFor('G', 501) };
    await expect(setShare('O', 'S', person([{ grant: 'G', capability: 'read' }]), 'none')).rejects.toThrow(/other than this revocation/);
    expect(signed.filter((s) => s.method === 'POST')).toEqual([]);
  });
});
