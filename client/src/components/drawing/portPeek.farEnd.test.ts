// Sign-off r160: a port's card names a device on a wall, desk or ceiling of the same room. It said "Leaves this
// room" for every far end not in a rack, so switch-1's ports to the cameras, the hall AP and switch-2 all said it.
import { describe, expect, it } from 'vitest';

import type { CatalogueModel } from '../../api/catalogue';
import { buildSample, modelKey, sample } from '../home/sampleNetwork';
import { CATALOGUE } from '../../engine/testCatalogue';
import { viewOf } from '../../document/view';
import { portPeek } from './portPeek';

const models = new Map<string, CatalogueModel>(CATALOGUE.map((m) => [modelKey(m.vendor, m.model), m]));
const spec = sample('home-lab');
const built = buildSample(spec, models);
const view = viewOf(built.doc, CATALOGUE);
const switch1 = view.racks.flatMap((r) => r.chassis).find((c) => c.hostname === 'switch-1')!;

/** The sample's own cables from switch-1, "switch-1:7" to "camera-1:eth0", by switch-1's port label. */
const farOf = new Map(
  spec.cables.flatMap((c) => {
    const [a, b] = [c.a, c.b];
    if (b == null) return [];
    if (a.startsWith('switch-1:')) return [[a.slice('switch-1:'.length), b] as const];
    if (b.startsWith('switch-1:')) return [[b.slice('switch-1:'.length), a] as const];
    return [];
  }),
);

describe('the To row of a port on switch-1 in the sample', () => {
  const toOf = (label: string): string => {
    const port = switch1.ports.find((p) => p.label === label && p.cable != null)!;
    return portPeek(built.doc, view, port.id)!.rows.find((r) => r.key === 'To')!.value;
  };

  it('names the device on a wall, desk or ceiling that the cable reaches', () => {
    const offRack = [...farOf].filter(([, far]) => /^(camera-|ap-|switch-2)/.test(far));
    expect(offRack.length).toBeGreaterThanOrEqual(4);
    for (const [label, far] of offRack) {
      const [host, farPort] = far.split(':');
      expect(toOf(label), `port ${label}`).toBe(`${host} · ${farPort}`);
    }
  });

  it('marks such a cable as staying in the room', () => {
    for (const p of switch1.ports) {
      if (p.cable == null || p.cable.farPortId == null) continue;
      expect(p.cable.outsideCloset, `port ${p.label}`).toBe(false);
    }
  });
});

describe('a cable that truly leaves the room', () => {
  it('still says where it goes, and still counts as outside', () => {
    const router = view.racks.flatMap((r) => r.chassis).find((c) => c.hostname === 'router-1')!;
    const wan = router.ports.find((p) => p.label === '9' && p.cable != null)!;
    expect(wan.cable!.outsideCloset).toBe(true);
    expect(portPeek(built.doc, view, wan.id)!.rows.find((r) => r.key === 'To')!.value).toBe('ISP modem');
  });
});
