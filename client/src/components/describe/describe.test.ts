import { describe, expect, it } from 'vitest';

import { addFreeBoxFromTemplateDoc } from '../racks/freeActions';
import { emptyDocument } from '../../document/model';
import { viewOf } from '../../document/view';
import { deviceChassis } from '../jot/jotLayout';
import { STARTING_ROWS, describeProblem, describedPorts, describedSummary, portsByFace, portsSummary, type DescribeRow } from './describe';

describe('describe a device', () => {
  it('numbers copper and cages on from each other, as a switch silkscreen does', () => {
    const ports = describedPorts([
      { kind: 'copper', count: 8, face: 'front' },
      { kind: 'sfp', count: 2, face: 'front' },
    ]);
    expect(ports.map((p) => p.label)).toEqual(['1', '2', '3', '4', '5', '6', '7', '8', '9', '10']);
    expect(ports.slice(0, 8).every((p) => p.connector === 'rj45')).toBe(true);
    expect(ports.slice(8).every((p) => p.connector === 'sfp')).toBe(true);
  });

  it('puts ports on any face: the NUC with ports on both sides and on top', () => {
    const rows: DescribeRow[] = [
      { kind: 'copper', count: 1, face: 'rear' },
      { kind: 'copper', count: 1, face: 'left' },
      { kind: 'copper', count: 1, face: 'right' },
      { kind: 'copper', count: 2, face: 'top' },
      { kind: 'power', count: 1, face: 'rear' },
    ];
    const ports = describedPorts(rows);
    expect(portsByFace(ports).map((f) => [f.face, f.ports.length])).toEqual([
      ['rear', 2],
      ['left', 1],
      ['right', 1],
      ['top', 2],
    ]);
    expect(ports.find((p) => p.connector === 'c14')).toEqual({ label: 'PSU', connector: 'c14', face: 'rear', service: 'power' });
    expect(describedSummary(rows)).toBe('1 Copper on the rear, 1 Copper on the left side, 1 Copper on the right side, 2 Copper on top, 1 Power on the rear');
    expect(portsSummary(ports)).toBe('6 ports · rear, left side, right side, top');
  });

  it('names console ports and inlets, numbering them only when there are several', () => {
    const ports = describedPorts([
      { kind: 'console', count: 1, face: 'front' },
      { kind: 'power', count: 2, face: 'rear' },
    ]);
    expect(ports.map((p) => p.label)).toEqual(['console', 'PSU 1', 'PSU 2']);
    expect(ports[0]!.service).toBe('console');
  });

  it('ignores empty and nonsense counts, and says what is missing', () => {
    expect(describedPorts([{ kind: 'copper', count: -3, face: 'front' }])).toEqual([]);
    expect(describedPorts([{ kind: 'copper', count: Number.NaN, face: 'front' }])).toEqual([]);
    expect(describedPorts([{ kind: 'copper', count: 2.7, face: 'front' }])).toHaveLength(2);
    expect(describeProblem('', STARTING_ROWS)).toBe('Give it a name.');
    expect(describeProblem('Box', [{ kind: 'copper', count: 0, face: 'front' }])).toBe('Add at least one port.');
    expect(describeProblem('Box', STARTING_ROWS)).toBeNull();
    const many = Array.from({ length: 5 }, () => ({ kind: 'copper' as const, count: 64, face: 'front' as const }));
    expect(describeProblem('Box', many)).toMatch(/up to 256/);
  });

  it('adds the device with every port on its face, in one undo step', () => {
    const doc = emptyDocument();
    const ports = describedPorts([
      { kind: 'copper', count: 2, face: 'left' },
      { kind: 'copper', count: 1, face: 'top' },
      { kind: 'sfp_plus', count: 1, face: 'front' },
    ]);
    const made = addFreeBoxFromTemplateDoc(doc, { role: null, ports }, 0, 0, undefined);
    expect(made.doc.batches.length).toBe(doc.batches.length + 1);
    const device = deviceChassis(viewOf(made.doc, []), made.chassisId)!;
    expect(device.ports.map((p) => [p.label, p.face]).sort()).toEqual([
      ['1', 'left'],
      ['2', 'left'],
      ['3', 'top'],
      ['4', 'front'],
    ]);
  });
});

describe('naming a described device', () => {
  it('names it from the description, numbered', async () => {
    const { nameStem } = await import('./describe');
    expect(nameStem('NUC 13 Pro')).toBe('nuc-13-pro');
    expect(nameStem('  USW Lite 8 PoE!! ')).toBe('usw-lite-8-poe');
    expect(nameStem('---')).toBe('device');
    const first = addFreeBoxFromTemplateDoc(emptyDocument(), { role: null, ports: [], nameStem: 'nuc-13' }, 0, 0, undefined);
    const second = addFreeBoxFromTemplateDoc(first.doc, { role: null, ports: [], nameStem: 'nuc-13' }, 200, 0, undefined);
    const view = viewOf(second.doc, []);
    expect([deviceChassis(view, first.chassisId)!.hostname, deviceChassis(view, second.chassisId)!.hostname]).toEqual(['nuc-13-1', 'nuc-13-2']);
  });
});

describe('the opened device names its faces', () => {
  it('captions each face under its ports, and nothing for a front-only box', async () => {
    const { faceCaptions, jotPlates } = await import('../jot/jotLayout');
    const ports = describedPorts([
      { kind: 'copper', count: 1, face: 'left' },
      { kind: 'copper', count: 2, face: 'top' },
    ]);
    const made = addFreeBoxFromTemplateDoc(emptyDocument(), { role: null, ports }, 0, 0, undefined);
    const plate = jotPlates(viewOf(made.doc, []), made.chassisId, { x: 0, y: 0 })![0]!;
    const captions = faceCaptions(plate);
    expect(captions.map((c) => c.face)).toEqual(['left', 'top']);
    expect(captions[0]!.x + captions[0]!.w).toBeLessThanOrEqual(captions[1]!.x);

    const front = addFreeBoxFromTemplateDoc(emptyDocument(), { role: null, ports: describedPorts([{ kind: 'copper', count: 4, face: 'front' }]) }, 0, 0, undefined);
    expect(faceCaptions(jotPlates(viewOf(front.doc, []), front.chassisId, { x: 0, y: 0 })![0]!)).toEqual([]);
  });
});
