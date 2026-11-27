import { describe, expect, it } from 'vitest';

import type { ClosetView } from './contract';
import { SAID_AS, cableSays, cablesSay, deviceSays, lineSays, looseDeviceSays, rackSays, rowSays, saidList, shelfSays, surfaceSays, wayOutSays } from './thingSays';

const port = (id: string, label: string) => ({ id, label, connector: 'rj45', face: 'front', cable: null });
const inlet = (id: string, slot: string) => ({ ...port(id, ''), slot, hotSwap: false, fitted: true, supplyId: null, serial: null });
const chassis = (id: string, hostname: string, role: string | null, positionU: number, heightU: number, ports: unknown[], psuInlets: unknown[] = []) => ({ id, hostname, model: 'M1', role, positionU, heightU, ports, psuInlets });
const fixture = (id: string, label: string, ports: unknown[] = [], fixtures: unknown[] = []) => ({ id, kind: 'chassis', label, model: null, ports, psuInlets: [], fixtures });

const SHELF = { id: 's1', label: '', positionU: 6, heightU: 1, occupants: [{ id: 'o1', label: 'nas-1', model: null, ports: [port('o1p1', 'eth0')] }, { id: 'o2', label: 'server-1', model: null, ports: [] }, { id: 'o3', label: 'pi-1', model: null, ports: [] }] };
const RACK = {
  id: 'r1',
  label: 'Rack 1',
  heightU: 12,
  chassis: [chassis('c1', 'router-1', 'router', 10, 1, [port('c1p1', '1')]), chassis('c2', 'switch-1', 'switch', 8, 1, [port('c2p2', '2'), port('c2p9', 'Port 9')], [inlet('c2i1', 'PSU1')]), chassis('c3', '', 'other', 3, 2, [port('c3p1', '')])],
  shelves: [SHELF],
};
const WALL = { id: 'w1', label: 'Outside wall', form: 'wall', fixtures: [fixture('f1', 'camera-1'), fixture('b1', 'Board', [], [fixture('f2', 'camera-2')])] };
const DESK = { id: 'w2', label: ' ', form: 'desk', fixtures: [fixture('c9', 'switch-2', [port('c9p1', '1')])] };

const VIEW = { racks: [RACK], surfaces: [WALL, DESK], unplaced: [], cables: [] } as unknown as ClosetView;

const end = (chassisId: string, portId: string) => ({ chassisId, portId, rackId: null });

describe('saidList', () => {
  it('reads one, two and three names in full, and counts what is past three', () => {
    expect(saidList([])).toBe('');
    expect(saidList(['a'])).toBe('a');
    expect(saidList(['a', 'b'])).toBe('a and b');
    expect(saidList(['a', 'b', 'c'])).toBe('a, b and c');
    expect(saidList(['a', 'b', 'c', 'd', 'e'])).toBe('a, b, c and 2 more');
  });

  it('leaves out a name that is only spaces', () => {
    expect(saidList(['a', '  ', 'b'])).toBe('a and b');
  });
});

describe('what a thing in a rack says', () => {
  it('names a device, what it is and the unit it is in', () => {
    expect(deviceSays(RACK.chassis[0]!, 'Rack 1')).toBe('router-1, router, Rack 1 U10');
  });

  it('says both units of a device two units high, and says nothing for the role "other"', () => {
    expect(deviceSays(RACK.chassis[2]!, 'Rack 1')).toBe('unnamed, Rack 1 U3 to U4');
  });

  it('reads a role of two words as two words', () => {
    expect(deviceSays({ hostname: 'ap-1', role: 'access_point', positionU: 1, heightU: 1 }, '')).toBe('ap-1, access point, Rack U1');
  });

  it('names a rack, its height and the units in use, shelves counted', () => {
    expect(rackSays(RACK)).toBe('Rack 1, 12U, 5U used');
    expect(rackSays({ label: '', heightU: 42, chassis: [], shelves: undefined })).toBe('Rack, 42U, 0U used');
  });

  it('names a shelf by where it is and what is on it', () => {
    expect(shelfSays(SHELF, 'Rack 1')).toBe('Shelf, Rack 1 U6, holds nas-1, server-1 and pi-1');
    expect(shelfSays({ label: 'Top shelf', positionU: 2, heightU: 2, occupants: [] }, 'Rack 1')).toBe('Top shelf, Rack 1 U2 to U3, nothing on it');
  });

  it('names a row and the side it is seen from', () => {
    expect(rowSays('Row A', 'front')).toBe('Row A, seen from the front');
    expect(rowSays(null, 'rear')).toBe('Row, seen from the rear');
  });
});

describe('what a thing outside a rack says', () => {
  it('names a wall and what is fixed to it, the things on its boards included', () => {
    expect(surfaceSays(WALL as never)).toBe('Outside wall, holds camera-1, Board and camera-2');
  });

  it('calls a wall with no name by its kind, and says when nothing is on it', () => {
    expect(surfaceSays({ label: ' ', form: 'desk', fixtures: [] })).toBe('desk, nothing on it');
  });

  it('names a device by the place it has', () => {
    expect(looseDeviceSays('nas', 'server', 'not in a rack')).toBe('nas, server, not in a rack');
    expect(looseDeviceSays(' ', null, '')).toBe('unnamed');
  });

  it('names where cables leave the room for, and how many of each kind', () => {
    expect(wayOutSays('ISP modem', '1 copper · 2 fibre')).toBe('ISP modem, 1 copper, 2 fibre');
    expect(wayOutSays('', '1 copper')).toBe('Outside this room, 1 copper');
  });

  it('names a line by its words and the two boxes it joins', () => {
    expect(lineSays('uplink', 'nas', 'switch')).toBe('uplink, nas to switch');
    expect(lineSays(null, '', 'switch')).toBe('unnamed to switch');
  });
});

describe('what a cable says', () => {
  it('names its two ends by device and port, and never by an id', () => {
    const said = cableSays(VIEW, { label: null, ends: [end('c1', 'c1p1'), end('c2', 'c2p2')] });
    expect(said).toBe('router-1 port 1 to switch-1 port 2');
    expect(said).not.toMatch(/Edge from|c1p1|c2p2/);
  });

  it('leads with its own words when it has them', () => {
    expect(cableSays(VIEW, { label: ' Office run ', ends: [end('c2', 'c2p2'), end('c9', 'c9p1')] })).toBe('Office run, switch-1 port 2 to switch-2 port 1');
  });

  it('reaches a port on a shelf and on a wall', () => {
    expect(cableSays(VIEW, { label: null, ends: [end('o1', 'o1p1'), end('c9', 'c9p1')] })).toBe('nas-1 port eth0 to switch-2 port 1');
  });

  it('says a power inlet by its slot, and does not say "port" twice', () => {
    expect(cableSays(VIEW, { label: null, ends: [end('c2', 'c2p9'), end('c2', 'c2i1')] })).toBe('switch-1 Port 9 to switch-1 PSU1');
  });

  it('names a device with no name by its model, and a port with no label by its device alone', () => {
    expect(cableSays(VIEW, { label: null, ends: [end('c3', 'c3p1'), end('c1', 'c1p1')] })).toBe('M1 to router-1 port 1');
  });

  it('says an end that is outside this room, with the name it was given', () => {
    expect(cableSays(VIEW, { label: null, ends: [end('c1', 'c1p1'), { outside: true, label: 'ISP modem' }] })).toBe('router-1 port 1 to ISP modem, outside this room');
    expect(cableSays(VIEW, { label: null, ends: [end('c1', 'c1p1'), { outside: true, label: '' }] })).toBe('router-1 port 1 to outside this room');
  });

  it('starts on the end that is in this room, whichever end the cable holds first', () => {
    expect(cableSays(VIEW, { label: null, ends: [{ outside: true, label: 'ISP modem' }, end('c1', 'c1p1')] })).toBe('router-1 port 1 to ISP modem, outside this room');
  });

  it('says so when an end is not connected', () => {
    expect(cableSays(VIEW, { label: null, ends: [end('c1', 'c1p1')] })).toBe('router-1 port 1, other end not connected');
    expect(cableSays(VIEW, { label: 'spare', ends: [] })).toBe('spare, not connected');
  });

  it('names a band of several by how many it stands for and the two devices', () => {
    expect(cablesSay(VIEW, 2, 'c1', 'c2')).toBe('2 cables, router-1 to switch-1');
    expect(cablesSay(VIEW, 3, 'c1', 'gone')).toBe('3 cables, router-1 to unnamed');
  });
});

describe('SAID_AS', () => {
  it('gives every kind its own word in place of "node" and "edge"', () => {
    for (const said of Object.values(SAID_AS)) {
      expect(said['aria-roledescription']).not.toMatch(/node|edge/);
      expect(said['aria-roledescription'].trim()).not.toBe('');
    }
  });

  it('takes "Press Enter to select it." off the things Enter does not select, and off no other', () => {
    const unsaid = Object.entries(SAID_AS)
      .filter(([, said]) => 'aria-describedby' in said)
      .map(([kind]) => kind)
      .sort();
    expect(unsaid).toEqual(['cables', 'row', 'wayOut']);
    for (const kind of ['cables', 'row', 'wayOut'] as const) expect(SAID_AS[kind]['aria-describedby']).toBeUndefined();
  });
});
