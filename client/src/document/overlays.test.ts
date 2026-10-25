import { describe, expect, it } from 'vitest';

import { cascadeRemoval } from './cascade';
import { NOW, estate } from './firmwareFixture';
import { begin, finish, tombstone } from './freeform';
import { readPlain, writePlain } from './plain';
import {
  OverlayRefusal,
  addOverlay,
  cleanRoutes,
  listOverlays,
  overlaysOf,
  removeMember,
  removeOverlay,
  setMember,
  setOverlay,
} from './overlays';
import { undo } from './undo';

const by = { actor: '01ARZ3NDEKTSV4RRFFQ69G5FAV' };

function tailnet() {
  const { doc, ids } = estate();
  const made = addOverlay(
    doc,
    {
      name: 'Home tailnet',
      provider: 'tailscale',
      range: '100.64.0.0/10',
      members: [
        { deviceId: ids.sw1, address: '100.71.4.2', routes: '10.0.10.0/24' },
        { deviceId: ids.sw2, address: '100.71.4.9', exitNode: true },
        { deviceId: ids.fw1, address: '100.71.4.20' },
      ],
    },
    { ...by, now: NOW + 100 },
  );
  return { ...made, ids, base: doc };
}

describe('VPNs', () => {
  it('makes a VPN with its members as one undo step', () => {
    const { doc, id, ids, base } = tailnet();
    const [vpn] = listOverlays(doc);
    expect(vpn.id).toBe(id);
    expect(vpn.name).toBe('Home tailnet');
    expect(vpn.provider).toBe('tailscale');
    expect(vpn.range).toBe('100.64.0.0/10');
    expect(vpn.members.map((m) => [m.hostname, m.address, m.exitNode, m.routes])).toEqual([
      ['fw1', '100.71.4.20', false, []],
      ['sw1', '100.71.4.2', false, ['10.0.10.0/24']],
      ['sw2', '100.71.4.9', true, []],
    ]);
    expect(vpn.members.every((m) => m.chassisIds.length === 1)).toBe(true);
    expect(overlaysOf(doc, ids.sw2).map((o) => o.member.exitNode)).toEqual([true]);
    expect(doc.batches.length).toBe(base.batches.length + 1);
    const back = undo(doc, doc.batches.at(-1)!.id, { ...by, now: NOW + 200 });
    expect(listOverlays(back)).toEqual([]);
  });

  it('survives the plain face round trip', () => {
    const { doc } = tailnet();
    const again = readPlain(writePlain(doc));
    expect(listOverlays(again)).toEqual(listOverlays(doc));
  });

  it('edits the VPN and a member, and clears what is emptied', () => {
    const { doc, id, ids } = tailnet();
    let next = setOverlay(doc, id, { name: '  Home   mesh ', range: '', note: 'nas is the way out' }, { ...by, now: NOW + 300 });
    next = setMember(next, id, ids.sw1, { address: '', routes: '10.0.10.0/24, 192.168.1.0/24\n10.0.10.0/24', exitNode: true }, { ...by, now: NOW + 301 });
    next = setMember(next, id, ids.sw3, { address: '100.71.4.30' }, { ...by, now: NOW + 302 });
    const [vpn] = listOverlays(next);
    expect(vpn.name).toBe('Home mesh');
    expect(vpn.range).toBeNull();
    expect(vpn.note).toBe('nas is the way out');
    const sw1 = vpn.members.find((m) => m.deviceId === ids.sw1)!;
    expect([sw1.address, sw1.exitNode, sw1.routes]).toEqual([null, true, ['10.0.10.0/24', '192.168.1.0/24']]);
    expect(vpn.members.map((m) => m.hostname)).toEqual(['fw1', 'sw1', 'sw2', 'sw3']);
  });

  it('refuses what is not an address, a range or a route, so nothing else is stored', () => {
    const { doc, id, ids } = tailnet();
    expect(() => setOverlay(doc, id, { range: '100.64.0.1/10' })).toThrow(OverlayRefusal);
    expect(() => setMember(doc, id, ids.sw1, { address: 'fd7a:115c:a1e0::1' })).toThrow(OverlayRefusal);
    // A WireGuard key pasted into the routes box is refused here, before the server's own check.
    expect(() => cleanRoutes('10.0.10.0/24\n2WF+k/FE9kbKAlAY1+B/UTfUyDHuo2ufDyiYu17aQ+U=')).toThrow(OverlayRefusal);
    expect(() => addOverlay(doc, { name: '   ', provider: 'netbird' })).toThrow(OverlayRefusal);
  });

  it('takes a member off, removes a VPN, and drops a removed device from it', () => {
    const { doc, id, ids } = tailnet();
    const off = removeMember(doc, id, ids.fw1, { ...by, now: NOW + 400 });
    expect(listOverlays(off)[0].members.map((m) => m.hostname)).toEqual(['sw1', 'sw2']);

    const { nodeIds, edgeIds } = cascadeRemoval(doc, ids.sw2);
    const b = begin(doc, { ...by, now: NOW + 401 });
    tombstone(b, nodeIds, edgeIds);
    const gone = finish(b, 'remove device');
    expect(listOverlays(gone)[0].members.map((m) => m.hostname)).toEqual(['fw1', 'sw1']);

    const none = removeOverlay(doc, id, { ...by, now: NOW + 402 });
    expect(listOverlays(none)).toEqual([]);
    expect(overlaysOf(none, ids.sw1)).toEqual([]);
  });
});
