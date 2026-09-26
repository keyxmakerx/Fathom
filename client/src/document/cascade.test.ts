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
