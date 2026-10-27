import { describe, expect, it } from 'vitest';
import { addStore, listStores } from '../../document/stock';

import { viewOf } from '../../document/view';
import { buildSample, samples } from '../home/sampleNetwork';
import { buildPlaceIndex } from '../inventory/placeIndex';
import { cableRows, deviceRows, portRows, rackRows } from '../inventory/kinds';
import { parseHash } from '../inventory/listState';
import { parseScanFragment, parseScannedText, scanFromLocation, scanHash, scanLink } from './scan';

const DESIGN = '01JQZ0000000000000000000D1';
const CABLE = 'cable:01JQZ0000000000000000000C1';

describe('scan links', () => {
  it('round-trips a design and a node through the fragment', () => {
    const link = scanLink('https://fathom.example/', { designId: DESIGN, nodeId: CABLE });
    expect(link).toBe(`https://fathom.example/scan#${DESIGN}/${CABLE}`);
    expect(scanFromLocation(new URL(link))).toEqual({ designId: DESIGN, nodeId: CABLE });
  });

  it('refuses a bad design id, a bad node id, or the wrong path', () => {
    expect(parseScanFragment(`#../x/${CABLE}`)).toBeNull();
    expect(parseScanFragment(`#${DESIGN}/cable:nope`)).toBeNull();
    expect(parseScanFragment(`#${DESIGN}/not-a-kind:01JQZ0000000000000000000C1`)).toBeNull();
    expect(parseScanFragment(`#${DESIGN}`)).toBeNull();
    expect(scanFromLocation({ pathname: '/', hash: `#${DESIGN}/${CABLE}` })).toBeNull();
  });

  it('follows only labels for this server', () => {
    const origin = 'https://fathom.example';
    expect(parseScannedText(`  ${origin}/scan#${DESIGN}/${CABLE}\n`, origin)).toEqual({ designId: DESIGN, nodeId: CABLE });
    expect(parseScannedText(`https://evil.example/scan#${DESIGN}/${CABLE}`, origin)).toBeNull();
    expect(parseScannedText('FNS2011A1BC', origin)).toBeNull();
  });
});

describe('scanHash', () => {
  it('opens the same row key the Inventory list carries, for every label kind in every sample', () => {
    let checked = 0;
    for (const spec of samples().filter((s) => (s.configs ?? []).length === 0)) {
      const { doc } = buildSample(spec, new Map());
      const view = viewOf(doc, []);
      const idx = buildPlaceIndex(doc, view);
      const lists: Record<string, Set<string>> = {
        devices: new Set(deviceRows(doc, view, [], idx).map((r) => r.key)),
        racks: new Set(rackRows(doc, view, [], idx).map((r) => r.key)),
        cables: new Set(cableRows(doc, view, idx).map((r) => r.key)),
        ports: new Set(portRows(doc, view, idx).map((r) => r.key)),
        // A store's page is opened by the store's own id (Parts › On hand).
        parts: new Set(listStores(doc).map((s) => s.id)),
      };
      for (const node of doc.nodes) {
        if (node.absentSince !== undefined) continue;
        const hash = scanHash(doc, node.id);
        if (hash == null) continue;
        const ls = parseHash(hash);
        expect(ls).not.toBeNull();
        // A device can be a row that is only listed once it is placed; the rest must all be there.
        if (ls!.kind === 'devices' && !lists.devices!.has(ls!.open)) continue;
        expect(lists[ls!.kind]!.has(ls!.open), `${spec.id}: ${ls!.open}`).toBe(true);
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(20);
  });

  it('opens a store at its bin page', () => {
    const { doc } = buildSample(samples().find((s) => (s.configs ?? []).length === 0)!, new Map());
    const made = addStore(doc, { name: 'Cage 3 bin A' });
    const ls = parseHash(scanHash(made.doc, made.id)!);
    expect(ls).toMatchObject({ kind: 'parts', open: made.id });
  });

  it('is null for a node that is gone or has no page', () => {
    const { doc } = buildSample(samples().find((s) => (s.configs ?? []).length === 0)!, new Map());
    expect(scanHash(doc, CABLE)).toBeNull();
    const site = doc.nodes.find((n) => n.id.startsWith('premises:'));
    if (site) expect(scanHash(doc, site.id)).toBeNull();
  });
});
