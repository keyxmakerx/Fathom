// Sign-off r160: a catalogued device lists its ports in its faceplate's order, never in the document's edge order
// (edges sort by id, and ids are random). The sample's desk switch drew its eight ports scrambled.
import { describe, expect, it } from 'vitest';

import type { CatalogueModel } from '../api/catalogue';
import { buildSample, modelKey, sample } from '../components/home/sampleNetwork';
import { CATALOGUE } from '../engine/testCatalogue';
import { connectorTokenOf } from './compat';
import type { PortView } from './view';
import { viewOfAll } from './view';

const models = new Map<string, CatalogueModel>(CATALOGUE.map((m) => [modelKey(m.vendor, m.model), m]));

/** Every device in a view with its ports, by name, wherever it is placed. */
function devicePorts(view: unknown): Map<string, PortView[]> {
  const out = new Map<string, PortView[]>();
  const walk = (o: unknown): void => {
    if (Array.isArray(o)) for (const x of o) walk(x);
    else if (o && typeof o === 'object') {
      const r = o as Record<string, unknown>;
      const name = (r.hostname ?? r.label) as string | undefined;
      if (Array.isArray(r.ports) && name) out.set(name, r.ports as PortView[]);
      for (const [k, x] of Object.entries(r)) if (k !== 'ports') walk(x);
    }
  };
  walk(view);
  return out;
}

const labels = (ports: readonly PortView[] | undefined): string[] => (ports ?? []).map((p) => p.label);

describe.each(['home-lab', 'practice-lab'])('the %s sample against the full catalogue', (name) => {
  const built = buildSample(sample(name), models);
  const ports = devicePorts(viewOfAll(built.doc, CATALOGUE));

  it('draws the desk switch ports 1 to 8 in order', () => {
    expect(labels(ports.get('switch-2'))).toEqual(['1', '2', '3', '4', '5', '6', '7', '8']);
  });

  it('lists every catalogued device ports in its catalogue faceplate order', () => {
    expect(built.catalogued.length).toBeGreaterThan(0);
    for (const hostname of built.catalogued) {
      const spec = sample(name).devices.find((d) => d.hostname === hostname)!;
      const model = models.get(modelKey(spec.catalogue!.vendor, spec.catalogue!.model))!;
      const order = model.faceplates.flatMap((f) => f.ports.map((p) => `${p.name ?? String(p.number)}|${connectorTokenOf(p.kind)}`));
      const keys = (ports.get(hostname) ?? []).map((p) => `${p.label}|${p.connector}`);
      const ranks = keys.filter((k) => order.includes(k)).map((k) => order.indexOf(k));
      expect(ranks, hostname).toEqual([...ranks].sort((a, b) => a - b));
    }
  });
});
