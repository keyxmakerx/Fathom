// ADR-0080 decision 3: a vault login goes to Termix by reference, never by value.
import { describe, expect, it } from 'vitest';

import type { OutsideConnection, OutsideItem } from '../../api/vault';
import { bitwardenReference, isOurReference, referenceFor } from './loginRef';
import { listAddOns, newHostBody, sendHosts, sendSummary } from './termix';

const ID = '11111111-1111-4111-8111-111111111111';
const REF = `bw://${ID}/password`;

function item(over: Partial<OutsideItem> = {}): OutsideItem {
  return { id: 'i1', cipherId: ID, name: 'core-sw1 admin', kind: 'login', usedOn: [{ design: 'D', element: 'Device:a' }], state: 'on', removedBy: null, removedByName: null, reads: 0, lastRead: null, ...over };
}
function conn(over: Partial<OutsideConnection> = {}, items: OutsideItem[] = [item()]): OutsideConnection {
  return { id: 'c1', owner: 'me', ownerName: 'Me', provider: 'vaultwarden', url: 'https://vw.example', collectionName: 'fathom', state: 'on', stoppedReason: null, checkedAt: null, createdAt: 0, items, ...over };
}

describe('the reference', () => {
  it('is bw://<item id>/password, the form Secret Sources reads', () => {
    expect(bitwardenReference(ID)).toBe(REF);
    expect(bitwardenReference(ID.toUpperCase())).toBe(REF);
  });

  it('is never made from anything but an item id', () => {
    for (const bad of ['', 'core-sw1 admin', `${ID}/../x`, `${ID} `.repeat(2), 'bw://x/password']) expect(bitwardenReference(bad)).toBeNull();
    expect(isOurReference(REF)).toBe(true);
    expect(isOurReference('hunter2')).toBe(false);
    expect(isOurReference(`bw://${ID}/username`)).toBe(false);
  });
});

describe('which login a device has', () => {
  it('the one Vaultwarden login marked on this device', () => {
    expect(referenceFor([conn()], 'D', 'Device:a')).toEqual({ reference: REF, name: 'core-sw1 admin' });
  });

  it('none from Secret Server or Passbolt, which Secret Sources has no scheme for', () => {
    expect(referenceFor([conn({ provider: 'delinea' })], 'D', 'Device:a')).toBeNull();
    expect(referenceFor([conn({ provider: 'passbolt' })], 'D', 'Device:a')).toBeNull();
  });

  it('none from a stopped connection, a removed item, another device or another design', () => {
    expect(referenceFor([conn({ state: 'stopped' })], 'D', 'Device:a')).toBeNull();
    expect(referenceFor([conn({}, [item({ state: 'removed' })])], 'D', 'Device:a')).toBeNull();
    expect(referenceFor([conn()], 'D', 'Device:b')).toBeNull();
    expect(referenceFor([conn()], 'E', 'Device:a')).toBeNull();
  });

  it('none when two are marked: that would be a guess', () => {
    const two = [item(), item({ id: 'i2', cipherId: '22222222-2222-4222-8222-222222222222', name: 'other' })];
    expect(referenceFor([conn({}, two)], 'D', 'Device:a')).toBeNull();
  });
});

describe('a host added with a reference', () => {
  it('carries authType password and the reference, and still no user name', () => {
    const body = newHostBody('core-sw1', '10.0.0.1', 'Fathom', REF);
    expect(body.authType).toBe('password');
    expect(body.password).toBe(REF);
    expect(body).not.toHaveProperty('username');
  });

  it('anything else in the reference slot is dropped, and the host goes in with authType none', () => {
    const body = newHostBody('core-sw1', '10.0.0.1', 'Fathom', 'Plain-Text-Password-1!');
    expect(body.authType).toBe('none');
    expect(body).not.toHaveProperty('password');
  });

  it('Send N counts the ones sent with a reference', async () => {
    let id = 0;
    const posted: Record<string, unknown>[] = [];
    const f = (async (_u: string, init: RequestInit) => {
      if (init.method === 'GET') return new Response('[]', { status: 200 });
      const body = JSON.parse(init.body as string) as Record<string, unknown>;
      posted.push(body);
      return new Response(JSON.stringify({ ...body, id: ++id }), { status: 200 });
    }) as unknown as typeof fetch;
    const r = await sendHosts('https://t.example', 'tmx_' + 'a'.repeat(64), [{ name: 'a', address: '10.0.0.1', reference: REF }, { name: 'b', address: '10.0.0.2' }], 'Fathom', f);
    expect(r.byReference).toBe(1);
    expect(posted.map((b) => b.authType)).toEqual(['password', 'none']);
    expect(sendSummary(r)).toBe('Added 2 to Termix (1 with its vault login by reference).');
  });
});

describe('Termix’s add-ons', () => {
  it('counts an add-on when it is enabled and active', async () => {
    const f = (async () =>
      new Response(
        JSON.stringify([
          { id: 'secret-sources', enabled: true, state: 'active' },
          { id: 'snippets', enabled: true, state: 'safe-mode' },
          { id: 'automations', enabled: false, state: 'disabled' },
          { id: 'serial', enabled: true },
        ]),
        { status: 200 },
      )) as unknown as typeof fetch;
    expect([...(await listAddOns('https://t.example', 'k', f))].sort()).toEqual(['secret-sources', 'serial']);
  });
});
