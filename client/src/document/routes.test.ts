import { describe, expect, it } from 'vitest';

import { NOW, estate } from './firmwareFixture';
import { begin, finish, addNode, addEdge } from './freeform';
import { identifier, token } from './model';
import { readPlain, writePlain } from './plain';
import { RouteRefusal, addRoute, cleanDestination, listRoutes, removeRoute } from './routes';
import { undo } from './undo';

const by = { actor: '01ARZ3NDEKTSV4RRFFQ69G5FAV' };

describe('routes by hand', () => {
  it('gives a device with no routing table a default route in a new "default" one, as one undo step', () => {
    const { doc, ids } = estate();
    const made = addRoute(doc, { deviceId: ids.sw1, destination: 'default', via: '10.0.10.1' }, { ...by, now: NOW + 100 });
    expect(listRoutes(made.doc)).toEqual([
      expect.objectContaining({ id: made.id, hostname: 'sw1', instance: 'default', destination: '0.0.0.0/0', via: 'via 10.0.10.1', pasted: false }),
    ]);
    expect(made.doc.batches.at(-1)!.label).toBe('add default route');
    const back = undo(made.doc, made.doc.batches.at(-1)!.id, { ...by, now: NOW + 200 });
    expect(listRoutes(back)).toEqual([]);
    // It survives the wire.
    expect(listRoutes(readPlain(writePlain(made.doc)))).toEqual(listRoutes(made.doc));
  });

  it('puts a second route in the same table, and reads discard', () => {
    const { doc, ids } = estate();
    const one = addRoute(doc, { deviceId: ids.fw1, destination: '', via: '203.0.113.1' }, { ...by, now: NOW + 100 });
    const two = addRoute(one.doc, { deviceId: ids.fw1, destination: '198.51.100.0/24', via: 'discard' }, { ...by, now: NOW + 101 });
    const routes = listRoutes(two.doc);
    expect(routes.map((r) => [r.destination, r.via])).toEqual([
      ['0.0.0.0/0', 'via 203.0.113.1'],
      ['198.51.100.0/24', 'discard'],
    ]);
    expect(new Set(routes.map((r) => r.instanceId)).size).toBe(1);
  });

  it('refuses host bits, a bad next hop and the same route twice, in plain words', () => {
    const { doc, ids } = estate();
    expect(() => cleanDestination('10.2.0.1/16')).toThrow(/not a network/);
    expect(() => addRoute(doc, { deviceId: ids.sw1, destination: 'default', via: 'gateway' }, by)).toThrow(RouteRefusal);
    expect(() => addRoute(doc, { deviceId: ids.sw1, destination: 'default', via: '' }, by)).toThrow(/Say where the route goes/);
    const one = addRoute(doc, { deviceId: ids.sw1, destination: 'default', via: '10.0.10.1' }, { ...by, now: NOW + 100 });
    expect(() => addRoute(one.doc, { deviceId: ids.sw1, destination: '0.0.0.0/0', via: '10.0.10.1' }, by)).toThrow(/already has that default route/);
  });

  it('asks which table when a device has more than one', () => {
    const { doc, ids } = estate();
    const b = begin(doc, { ...by, now: NOW + 50 });
    const tables: string[] = [];
    for (const name of ['default', 'cust-a']) {
      const ri = addNode(b, 'RoutingInstance', { 'RoutingInstance.name': identifier(name), 'RoutingInstance.isolation': token('routing_table_only') });
      addEdge(b, 'HasRoutingInstance', ids.fw1, ri);
      tables.push(ri);
    }
    const two = finish(b, 'two tables');
    expect(() => addRoute(two, { deviceId: ids.fw1, destination: 'default', via: '192.0.2.1' }, by)).toThrow(/more than one routing table \(cust-a, default\)/);
    const made = addRoute(two, { deviceId: ids.fw1, destination: 'default', via: '192.0.2.1', instanceId: tables[1] }, { ...by, now: NOW + 100 });
    expect(listRoutes(made.doc)[0].instance).toBe('cust-a');
  });

  it('removes a route entered by hand', () => {
    const { doc, ids } = estate();
    const made = addRoute(doc, { deviceId: ids.sw1, destination: 'default', via: '10.0.10.1' }, { ...by, now: NOW + 100 });
    const gone = removeRoute(made.doc, made.id, { ...by, now: NOW + 101 });
    expect(listRoutes(gone)).toEqual([]);
  });
});
