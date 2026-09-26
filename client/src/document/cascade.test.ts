import { describe, expect, it } from 'vitest';

import { cascadeRemoval } from './cascade';
import { emptyDocument, formatEdgeId, formatNodeId, type Document, type GraphEdge } from './model';
import { newUlid } from './ulid';

const NOW = 1_700_000_000_000;

describe('cascadeRemoval — performance', () => {
  it('a device holding 5,000 config nodes cascades well under a generous 2 s bound, even inside a 125,000-edge design', () => {
    const edges: GraphEdge[] = [];

    const deviceId = formatNodeId('Device', newUlid(NOW));
    const chassisId = formatNodeId('Chassis', newUlid(NOW));
    edges.push({ id: formatEdgeId('HasChassis', newUlid(NOW)), from: deviceId, to: chassisId, prov: newUlid(NOW), fields: {} });
    for (let i = 0; i < 5_000; i += 1) {
      const portId = formatNodeId('PhysicalPort', newUlid(NOW));
      edges.push({ id: formatEdgeId('HasPort', newUlid(NOW)), from: chassisId, to: portId, prov: newUlid(NOW), fields: {} });
    }

    // Padding to ~125,000 edges that never touch the target device: a
    // per-node full-edge rescan is quadratic here; an index built once isn't.
    while (edges.length < 125_000) {
      const a = formatNodeId('Device', newUlid(NOW));
      const b = formatNodeId('Chassis', newUlid(NOW));
      edges.push({ id: formatEdgeId('HasChassis', newUlid(NOW)), from: a, to: b, prov: newUlid(NOW), fields: {} });
    }

    const doc: Document = { ...emptyDocument(), edges };

    const start = performance.now();
    const result = cascadeRemoval(doc, deviceId);
    const elapsed = performance.now() - start;

    // eslint-disable-next-line no-console
    console.log(`cascadeRemoval: a 5,000-node device inside a ${edges.length}-edge design in ${elapsed.toFixed(1)} ms`);

    expect(result.nodeIds.size).toBe(5_002); // device + chassis + 5,000 ports
    expect(result.edgeIds.size).toBe(5_001); // HasChassis + 5,000 HasPort
    expect(elapsed).toBeLessThan(2_000);
  });
});

describe('cascadeRemoval — cables', () => {
  it('takes a cable terminating on a reached port with it, both Terminates edges, leaving the far port and its own device untouched', () => {
    const deviceA = formatNodeId('Device', newUlid(NOW));
    const chassisA = formatNodeId('Chassis', newUlid(NOW));
    const portA = formatNodeId('PhysicalPort', newUlid(NOW));
    const deviceB = formatNodeId('Device', newUlid(NOW));
    const chassisB = formatNodeId('Chassis', newUlid(NOW));
    const portB = formatNodeId('PhysicalPort', newUlid(NOW));
    const cableId = formatNodeId('Cable', newUlid(NOW));
    const termA = formatEdgeId('Terminates', newUlid(NOW));
    const termB = formatEdgeId('Terminates', newUlid(NOW));

    const edges: GraphEdge[] = [
      { id: formatEdgeId('HasChassis', newUlid(NOW)), from: deviceA, to: chassisA, prov: newUlid(NOW), fields: {} },
      { id: formatEdgeId('HasPort', newUlid(NOW)), from: chassisA, to: portA, prov: newUlid(NOW), fields: {} },
      { id: formatEdgeId('HasChassis', newUlid(NOW)), from: deviceB, to: chassisB, prov: newUlid(NOW), fields: {} },
      { id: formatEdgeId('HasPort', newUlid(NOW)), from: chassisB, to: portB, prov: newUlid(NOW), fields: {} },
      { id: termA, from: cableId, to: portA, prov: newUlid(NOW), fields: {} },
      { id: termB, from: cableId, to: portB, prov: newUlid(NOW), fields: {} },
    ];
    const doc: Document = { ...emptyDocument(), edges };

    const result = cascadeRemoval(doc, deviceA);

    expect(result.nodeIds.has(cableId)).toBe(true);
    expect(result.edgeIds.has(termA)).toBe(true);
    expect(result.edgeIds.has(termB)).toBe(true);
    // The far device, its chassis and its port are not reached at all.
    expect(result.nodeIds.has(deviceB)).toBe(false);
    expect(result.nodeIds.has(chassisB)).toBe(false);
    expect(result.nodeIds.has(portB)).toBe(false);
  });

  it('leaves an already-tombstoned cable alone', () => {
    const deviceA = formatNodeId('Device', newUlid(NOW));
    const chassisA = formatNodeId('Chassis', newUlid(NOW));
    const portA = formatNodeId('PhysicalPort', newUlid(NOW));
    const cableId = formatNodeId('Cable', newUlid(NOW));
    const termA = formatEdgeId('Terminates', newUlid(NOW));

    const edges: GraphEdge[] = [
      { id: formatEdgeId('HasChassis', newUlid(NOW)), from: deviceA, to: chassisA, prov: newUlid(NOW), fields: {} },
      { id: formatEdgeId('HasPort', newUlid(NOW)), from: chassisA, to: portA, prov: newUlid(NOW), fields: {} },
      { id: termA, from: cableId, to: portA, prov: newUlid(NOW), fields: {}, absentSince: NOW },
    ];
    const doc: Document = { ...emptyDocument(), edges };

    const result = cascadeRemoval(doc, deviceA);

    expect(result.nodeIds.has(cableId)).toBe(false);
    expect(result.edgeIds.has(termA)).toBe(false);
  });
});
