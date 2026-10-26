// Connecting an outside vault, end to end in the browser half: an account made the way Bitwarden
// makes one (`scripts/drive-lib/bitwarden-account.mjs`), opened with its master password, gives
// back exactly its organisation key, and nothing else is accepted.

import { describe, expect, it } from 'vitest';

import { makeAccount } from '../../../scripts/drive-lib/bitwarden-account.mjs';
import type { OutsidePrepared } from '../api/vault';
import { openForConnect } from './outside';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function prepared(token: Record<string, any>, sync: Record<string, any>): OutsidePrepared {
  return {
    url: 'https://vault.example.org',
    deviceId: '00000000-0000-4000-8000-000000000000',
    protectedUserKey: token.Key,
    protectedPrivateKey: token.PrivateKey,
    kdf: { type: token.Kdf, iterations: token.KdfIterations, memory: null, parallelism: null },
    salt: token.UserDecryptionOptions.MasterPasswordUnlock.Salt,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    organisations: sync.profile.organizations.map((o: any) => ({ id: o.id, name: o.name, role: o.type, status: o.status, protectedKey: o.key })),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    collections: sync.collections.map((c: any) => ({ id: c.id, organisationId: c.organizationId, protectedName: c.name })),
    checks: [],
  };
}

describe('opening an outside vault account in the browser', () => {
  const made = makeAccount({ email: 'Fathom@Lab.example', password: 'correct horse battery staple', iterations: 5000 });

  it('gives back the one collection’s organisation key', async () => {
    const { token, sync, orgKey } = await made;
    const opened = await openForConnect(prepared(token, sync), 'correct horse battery staple', '', '  fathom-7k2q ');
    expect(opened.collectionName).toBe('fathom-7k2q');
    expect(opened.collectionId).toBe(sync.collections[0].id);
    expect([...opened.orgKey]).toEqual([...orgKey]);
  });

  it('refuses the wrong master password before anything else', async () => {
    const { token, sync } = await made;
    await expect(openForConnect(prepared(token, sync), 'wrong horse', '', 'fathom-7k2q')).rejects.toThrow(/did not open/);
  });

  it('refuses a collection called something else', async () => {
    const { token, sync } = await made;
    await expect(openForConnect(prepared(token, sync), 'correct horse battery staple', '', 'switches')).rejects.toThrow(/not called “switches”/);
  });

  it('refuses an account that sees two collections', async () => {
    const two = await makeAccount({
      email: 'a@b.example',
      password: 'pw-pw-pw-pw',
      iterations: 5000,
      collections: [
        { name: 'one', logins: [] },
        { name: 'two', logins: [] },
      ],
    });
    await expect(openForConnect(prepared(two.token, two.sync), 'pw-pw-pw-pw', '', 'one')).rejects.toThrow(/exactly 1 collection; it sees 2/);
  });

  it('uses the typed e-mail only when the vault did not say', async () => {
    const { token, sync, orgKey } = await made;
    const p = { ...prepared(token, sync), salt: null };
    await expect(openForConnect(p, 'correct horse battery staple', '', 'fathom-7k2q')).rejects.toThrow(/e-mail/);
    const opened = await openForConnect(p, 'correct horse battery staple', ' fathom@lab.example ', 'fathom-7k2q');
    expect([...opened.orgKey]).toEqual([...orgKey]);
  });
});
