import { describe, expect, it } from 'vitest';

import { ensureRackToPlaceInto } from '../components/racks/emptyDesign';
import { rackHeightBlocker } from '../components/drawing/Editor';
import { createSketchDevice, movePlacement } from './commands';
import { FieldValueError, setRackHeight } from './edit';
import { emptyDocument, findNode, isNodeOfKind, type Document } from './model';

/** A design with one 42U rack and one sketch device mounted at `positionU`. */
function rackWithDeviceAt(positionU: number): { doc: Document; rackId: string } {
  const { doc: withRack, rackId } = ensureRackToPlaceInto(emptyDocument(), null);
  const withDevice = createSketchDevice(withRack, { hostname: 'core-01' });
  const chassis = withDevice.nodes.find((n) => isNodeOfKind(n.id, 'Chassis'));
  if (!chassis) throw new Error('no chassis made');
  const doc = movePlacement(withDevice, chassis.id, { kind: 'rack', rackId, positionU, face: 'front' });
  return { doc, rackId };
}

function heightOf(doc: Document, rackId: string): unknown {
  return findNode(doc, rackId)?.fields['Rack.height_u']?.value;
}

describe('setRackHeight', () => {
  it('changes a rack to one of the common sizes, and to a custom one', () => {
    const { doc, rackId } = rackWithDeviceAt(10);
    expect(heightOf(doc, rackId)).toBe(42);
    expect(heightOf(setRackHeight(doc, rackId, 24), rackId)).toBe(24);
    expect(heightOf(setRackHeight(doc, rackId, 18), rackId)).toBe(18);
  });

  it('refuses a height below anything mounted in the rack', () => {
    const { doc, rackId } = rackWithDeviceAt(40);
    expect(() => setRackHeight(doc, rackId, 24)).toThrow(FieldValueError);
    expect(() => setRackHeight(doc, rackId, 24)).toThrow('U40');
    expect(heightOf(setRackHeight(doc, rackId, 40), rackId)).toBe(40);
  });

  it('refuses a height that is not a whole number from 1 to 255', () => {
    const { doc, rackId } = rackWithDeviceAt(1);
    for (const bad of [0, -3, 2.5, 256, Number.NaN]) {
      expect(() => setRackHeight(doc, rackId, bad)).toThrow(FieldValueError);
    }
  });

  it('leaves the document it was given unchanged', () => {
    const { doc, rackId } = rackWithDeviceAt(1);
    setRackHeight(doc, rackId, 12);
    expect(heightOf(doc, rackId)).toBe(42);
  });
});

describe('rackHeightBlocker', () => {
  const rack = {
    chassis: [
      { hostname: 'core-01', model: 'EX4300-48P', positionU: 40, heightU: 1 },
      { hostname: '', model: 'R740', positionU: 30, heightU: 2 },
    ],
    shelves: [{ label: 'Shelf A', positionU: 20, heightU: 2 }],
  } as unknown as Parameters<typeof rackHeightBlocker>[0];

  it('names the highest thing in the way', () => {
    expect(rackHeightBlocker(rack, 24)).toBe("It can't go below 40U, because core-01 reaches U40.");
  });

  it('falls back to the model when a device has no hostname', () => {
    const lower = { ...rack, chassis: [rack.chassis[1]] } as typeof rack;
    expect(rackHeightBlocker(lower, 12)).toBe("It can't go below 31U, because R740 reaches U31.");
  });

  it('allows any height that clears everything', () => {
    expect(rackHeightBlocker(rack, 40)).toBeNull();
    expect(rackHeightBlocker(rack, 42)).toBeNull();
  });
});
