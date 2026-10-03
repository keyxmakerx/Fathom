import { beforeEach, describe, expect, it, vi } from 'vitest';

import { readLp, toHex, utf8 } from '../crypto/bytes';

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
    signMessage: async () => new Uint8Array(64).fill(3),
  };
});
vi.mock('../state/sessionState', () => ({ getSession: () => ({ kind: 'steward', address: 'a@b.c', accountId: 'ME' }) }));

import { grantBytes, keyCode, secondBytes } from './grantBytes';
import type { SecondingItem } from './invitations';
import { parsePeople, removeAccess, secondSteward, type AccessRow } from './people';

const fill = (n: number) => new Uint8Array(32).fill(n);

const accessRow = {
  scope_id: 'S1',
  label: 'LON1',
  capability: 'draw',
  grant: 'G1',
  inherited: false,
  steward: false,
  genesis: false,
  revocable: true,
  effective_from_unix: 10,
  expires_at_unix: null,
  revoke_takes_effect_in_seconds: 0,
  revoking_at_unix: null,
};

beforeEach(() => {
  sent.length = 0;
  answers = {};
});

describe('parsePeople', () => {
  const people = {
    waiting_count: 1,
    people: [
      { account: 'A', name: 'Priya Rao', email: 'p@x.example', you: false, state: 'active', invitation: null, asked: null, expired: false, access: [accessRow, { ...accessRow, scope_id: null, label: 'Northwind', capability: 'steward', grant: 'G2', steward: true, revoke_takes_effect_in_seconds: 86400, expires_at_unix: 99, awaiting_second: true }] },
      { account: 'B', name: 'Jo Kim', email: null, you: false, state: 'waiting', invitation: 'I1', asked: { capability: 'draw', scope_id: 'S1', scope_label: 'LON1' }, expired: false, access: [] },
    ],
  };

  it('reads state, access rows and what an invited person asked for', () => {
    const parsed = parsePeople(utf8(JSON.stringify(people)));
    expect(parsed.waitingCount).toBe(1);
    expect(parsed.people[0].access[1]).toMatchObject({ scopeId: null, capability: 'steward', revokeTakesEffectInSeconds: 86400, expiresAtUnix: 99, awaitingSecond: true });
    expect(parsed.people[0].access[0].awaitingSecond).toBe(false);
    expect(parsed.people[1]).toMatchObject({ state: 'waiting', email: null, asked: { capability: 'draw', scopeLabel: 'LON1' } });
  });

  it('refuses a state or capability it does not know', () => {
    const bad = { ...people, people: [{ ...people.people[0], state: 'suspended' }] };
    expect(() => parsePeople(utf8(JSON.stringify(bad)))).toThrow(/state/);
    expect(() => parsePeople(utf8('{"waiting_count":0}'))).toThrow(/malformed/);
  });
});

describe('removeAccess', () => {
  const row = (over: Partial<AccessRow>): AccessRow => ({
    scopeId: 'S1',
    label: 'LON1',
    capability: 'draw',
    grant: 'G1',
    inherited: false,
    genesis: false,
    revocable: true,
    effectiveFromUnix: 1,
    expiresAtUnix: null,
    revokeTakesEffectInSeconds: 0,
    revokingAtUnix: null,
    awaitingSecond: false,
    suspended: false,
    ...over,
  });

  it('says so, and sends nothing, for access given to the whole organisation', async () => {
    await expect(removeAccess('ORG', row({ scopeId: null }))).rejects.toThrow(/whole organisation/);
    expect(sent).toHaveLength(0);
  });
});

describe('secondSteward', () => {
  const item: SecondingItem = {
    grant: 'G9',
    scopeId: null,
    scopeLabel: 'Northwind',
    subject: 'LEE',
    subjectName: 'Lee Wong',
    keyCode: keyCode(fill(0x31)),
    granter: 'SAM',
    granterName: 'Sam Ortiz',
    effectiveFromUnix: 1_760_000_000,
    expiresAtUnix: 1_790_000_000,
  };

  async function view(over: Record<string, unknown> = {}, factsOver: { authEpoch?: number } = {}) {
    const facts = {
      organisation: 'ORG',
      rootPubkeyFpr: fill(9),
      scope: '',
      subject: 'LEE',
      subjectKeyFpr: fill(0x31),
      capability: 'steward' as const,
      granter: 'SAM',
      granterKeyFpr: fill(0x32),
      effectiveFromUnix: item.effectiveFromUnix,
      expiresAtUnix: item.expiresAtUnix,
      soleSteward: false,
      authEpoch: factsOver.authEpoch ?? 5,
    };
    const bytes = grantBytes(facts);
    return {
      grant: 'G9',
      organisation: 'ORG',
      scope_id: null,
      scope_label: 'Northwind',
      subject: 'LEE',
      subject_name: 'Lee Wong',
      subject_key_fpr: toHex(fill(0x31)),
      key_code: item.keyCode,
      capability: 'steward',
      granter: 'SAM',
      granter_key_fpr: toHex(fill(0x32)),
      root_pubkey_fpr: toHex(fill(9)),
      effective_from_unix: item.effectiveFromUnix,
      expires_at_unix: item.expiresAtUnix,
      auth_epoch: facts.authEpoch,
      sole_steward_appointment: false,
      grant_bytes: toHex(bytes),
      second_bytes: toHex(await secondBytes(bytes, fill(0x32))),
      ...over,
    };
  }

  it('rebuilds both byte strings, then signs and posts the second signature', async () => {
    answers['GET /organisations/ORG/grants/G9/second'] = await view();
    await secondSteward('ORG', item);
    const post = sent[sent.length - 1];
    expect(post.method).toBe('POST');
    expect(post.path).toBe('/organisations/ORG/grants/G9/second');
    expect(new TextDecoder().decode(readLp(post.body!).value)).toBe(toHex(new Uint8Array(64).fill(3)));
  });

  it('uses the folder path for a folder grant', async () => {
    answers['GET /organisations/ORG/scopes/S1/grants/G9/second'] = await view({ scope_id: 'S1' });
    await expect(secondSteward('ORG', { ...item, scopeId: 'S1' })).rejects.toThrow(/grant bytes that differ/);
    expect(sent[0].path).toBe('/organisations/ORG/scopes/S1/grants/G9/second');
  });

  it('refuses a different person, key, expiry, or bytes, and signs nothing', async () => {
    for (const over of [
      { subject: 'MALLORY' },
      { key_code: 'AAAAAAAAAA' },
      { subject_key_fpr: toHex(fill(0x77)) },
      { expires_at_unix: item.expiresAtUnix + 1 },
      { capability: 'draw' },
      { granter: 'ME' },
      { second_bytes: toHex(fill(1)) },
      { grant_bytes: toHex(fill(1)) },
    ]) {
      sent.length = 0;
      answers['GET /organisations/ORG/grants/G9/second'] = await view(over);
      await expect(secondSteward('ORG', item)).rejects.toThrow(/nothing was signed/);
      expect(sent.every((s) => s.method === 'GET')).toBe(true);
    }
  });
});
