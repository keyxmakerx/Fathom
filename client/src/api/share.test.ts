import { beforeEach, describe, expect, it, vi } from 'vitest';

import { readLp, utf8 } from '../crypto/bytes';

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
vi.mock('../state/sessionState', () => ({ getSession: () => ({ kind: 'steward', address: 'a@b.c' }) }));

import { parseAccess, setShare, type AccessPerson } from './share';

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
    'POST /organisations/O/scopes/S/grants/propose': {
      subject: 'P1',
      capability: 'read',
      effective_from_unix: 100,
      auth_epoch: 3,
      granter_key_fpr: 'aa',
      subject_key_fpr: 'bb',
      root_pubkey_fpr: 'cc',
      bytes: '00ff',
    },
    'GET /organisations/O/scopes/S/grants/G/revoke': { at: 500, bytes: '0102' },
  };
});

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
    expect(fields.slice(0, 7)).toEqual(['P1', 'read', '100', '3', 'aa', 'bb', 'cc']);
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
