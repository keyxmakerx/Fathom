import { describe, expect, it } from 'vitest';

import type { CatalogueModel } from '../../api/catalogue';
import { createRack, placeChassis, UnknownReferenceError } from '../../document/commands';
import { setDeviceField } from '../../document/edit';
import { edgesIn, emptyDocument, formatNodeId, type Document } from '../../document/model';
import { newUlid } from '../../document/ulid';
import { refusalFor } from './RacksPlace';

// `refusalFor` is `handleEdit`'s pure part (file header): no `Document`
// mutation, no React, nothing but "does this error name a field the editor
// should show a caution beside." Exercised here against the two refusals
// the brief names — a malformed management address, a role outside the
// enum — raised by the real `document/edit.ts` path rather than hand-built
// `FieldValueError`s, so a drift in that module's message shape would show
// up here too.

const NOW = 1_700_000_000_000;

const MODEL_1U: CatalogueModel = {
  vendor: 'juniper',
  model: 'EX4300-48P',
  rackUnits: 1,
  reviewedBy: 'reviewer',
  source: { cite: 'cite', readOn: '2026-09-14' },
  psuSlots: [
    { name: 'PSU0', hotSwap: true, face: 'rear', position: { row: 'single', column: 0 } },
    { name: 'PSU1', hotSwap: true, face: 'rear', position: { row: 'single', column: 1 } },
  ],
  faceplates: [
    { face: 'front', portCount: 1, ports: [{ kind: 'RJ45', number: 0, uplink: false, row: 'single', column: 0, groupGapBefore: false }] },
  ],
};

function docWithDevice(): { doc: Document; deviceId: string } {
  const premisesId = formatNodeId('Premises', newUlid(NOW));
  const doc: Document = {
    ...emptyDocument(),
    nodes: [
      {
        id: premisesId,
        existence: newUlid(NOW),
        fields: { 'Premises.label': { presence: 'set', prov: newUlid(NOW), value: 'Riverside CO' } },
      },
    ],
  };
  const withRack = createRack(doc, premisesId, { label: 'R1', heightU: 42, unitNumbering: 'ascending', now: NOW });
  const rackId = withRack.nodes.find((n) => n.id !== premisesId)!.id;
  const placed = placeChassis(withRack, rackId, MODEL_1U, 12, 'front', { now: NOW });
  const mounted = edgesIn(placed, rackId, 'MountedIn')[0];
  const chassisId = mounted.from;
  const hasChassis = edgesIn(placed, chassisId, 'HasChassis')[0];
  return { doc: placed, deviceId: hasChassis.from };
}

function caught(fn: () => unknown): unknown {
  try {
    fn();
    throw new Error('expected the call above to throw');
  } catch (e) {
    return e;
  }
}

describe('refusalFor', () => {
  it('names a malformed management address beside the field', () => {
    const { doc, deviceId } = docWithDevice();
    const e = caught(() => setDeviceField(doc, deviceId, 'management_address', '10.10.0.999', { now: NOW }));
    expect(refusalFor(e)).toEqual({
      refused: 'Device.management_address: "10.10.0.999" is not a valid IPv4 or IPv6 address',
    });
  });

  it('names a role outside the enum beside the field', () => {
    const { doc, deviceId } = docWithDevice();
    const e = caught(() => setDeviceField(doc, deviceId, 'role', 'router-ish', { now: NOW }));
    expect(refusalFor(e)).toEqual({
      refused: 'Device.role: "router-ish" is not one of: firewall, router, switch, load_balancer, server, access_point, other',
    });
  });

  it('drops a stale-reference error silently — no field to show it beside', () => {
    expect(refusalFor(new UnknownReferenceError('device:01ARZ3NDEKTSV4RRFFQ69G5FAV', 'Device'))).toBeUndefined();
  });

  it('drops anything that is not an Error at all', () => {
    expect(refusalFor('not an error')).toBeUndefined();
    expect(refusalFor(undefined)).toBeUndefined();
  });
});
