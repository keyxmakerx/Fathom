import { beforeEach, describe, expect, it, vi } from 'vitest';

const calls: string[] = [];
const fail: { at: string | null } = { at: null };

vi.mock('../../api/console', () => ({
  createOrganisationShell: vi.fn(async (name: string) => {
    calls.push(`shell:${name}`);
    if (fail.at === 'shell') throw new Error('refused');
    return { token: new Uint8Array([1]), noticeAddress: 'ops@example.com', shellId: 's1' };
  }),
}));
vi.mock('../../api/claim', () => ({
  formatRecoveryKey: vi.fn(async () => 'AAAA-BBBB'),
  randomIdSalt: vi.fn(() => new Uint8Array(16)),
  redeemOrganisationClaim: vi.fn(async (token: Uint8Array) => {
    calls.push(`claim:${token[0]}`);
    if (fail.at === 'claim') throw new Error('lost');
    return 'org-1';
  }),
}));
vi.mock('../../api/scopes', () => ({
  createScope: vi.fn(async (org: string, parent: string | null, label: string) => {
    calls.push(`site:${org}:${parent}:${label}`);
    if (fail.at === 'site') throw new Error('refused');
    return { scopeId: 'scope-1', label };
  }),
}));
vi.mock('../../api/designs', () => ({
  createDesign: vi.fn(async (org: string, scope: string) => {
    calls.push(`design:${org}:${scope}`);
    if (fail.at === 'design') throw new Error('refused');
    return { designId: 'design-1', name: null };
  }),
}));
vi.mock('../../crypto/keys', () => ({
  generateExtractableKeyPair: vi.fn(async () => ({ publicKey: {}, privateKey: {} })),
  exportPublicKeyRaw: vi.fn(async () => new Uint8Array(32)),
  exportPrivateScalar: vi.fn(async () => new Uint8Array(32)),
  getEnrolledKeyPair: vi.fn(async () => ({ publicKey: {}, privateKey: {} })),
}));

import {
  describeOwnNetworkFailure,
  makeOwnNetwork,
  OwnNetworkFailure,
  ownNetworkName,
  prepareOwnNetwork,
  type OwnNetworkProgress,
} from './ownNetwork';

beforeEach(() => {
  calls.length = 0;
  fail.at = null;
});

describe('ownNetworkName', () => {
  it('trims, and refuses an empty or overlong name', () => {
    expect(ownNetworkName('  Home network ')).toBe('Home network');
    expect(ownNetworkName('   ')).toBeNull();
    expect(ownNetworkName('x'.repeat(81))).toBeNull();
  });
});

describe('makeOwnNetwork (sign-off r123)', () => {
  it('does the hand steps in order: shell, claim, a site named after it, an empty design in that site', async () => {
    const prepared = await prepareOwnNetwork();
    expect(calls).toEqual([]); // preparing the key sends nothing
    const made = await makeOwnNetwork('Home network', prepared, 'me@example.com', 'acct-1');
    expect(calls).toEqual(['shell:Home network', 'claim:1', 'site:org-1:null:Home network', 'design:org-1:scope-1']);
    expect(made.organisationId).toBe('org-1');
    expect(made.design.designId).toBe('design-1');
  });

  it('a retry after a lost claim answer reuses the same claim and makes no second organisation', async () => {
    const prepared = await prepareOwnNetwork();
    fail.at = 'claim';
    let progress: OwnNetworkProgress = {};
    await makeOwnNetwork('Lab', prepared, 'me@example.com', 'acct-1').catch((e: unknown) => {
      expect(e).toBeInstanceOf(OwnNetworkFailure);
      progress = (e as OwnNetworkFailure).progress;
    });
    fail.at = null;
    calls.length = 0;
    await makeOwnNetwork('Lab', prepared, 'me@example.com', 'acct-1', progress);
    expect(calls.filter((c) => c.startsWith('shell:'))).toEqual([]);
    expect(calls[0]).toBe('claim:1');
  });

  it('a retry after the organisation exists goes straight to what is missing', async () => {
    const prepared = await prepareOwnNetwork();
    fail.at = 'design';
    let failure: unknown = null;
    await makeOwnNetwork('Lab', prepared, 'me@example.com', 'acct-1').catch((e: unknown) => (failure = e));
    expect(describeOwnNetworkFailure(failure, null)).toContain('Your organisation is made, but its first design could not be.');
    fail.at = null;
    calls.length = 0;
    await makeOwnNetwork('Lab', prepared, 'me@example.com', 'acct-1', (failure as OwnNetworkFailure).progress);
    expect(calls).toEqual(['design:org-1:scope-1']);
  });

  it('a refused shell says nothing was changed', async () => {
    const prepared = await prepareOwnNetwork();
    fail.at = 'shell';
    let failure: unknown = null;
    await makeOwnNetwork('Lab', prepared, 'me@example.com', 'acct-1').catch((e: unknown) => (failure = e));
    expect(describeOwnNetworkFailure(failure, 'Refused.')).toBe('Your network could not be made. Nothing was changed on the server. Refused.');
  });
});
