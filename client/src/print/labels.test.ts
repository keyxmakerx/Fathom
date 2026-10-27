import { describe, expect, it } from 'vitest';

import { viewOf } from '../document/view';
import { buildSample, samples } from '../components/home/sampleNetwork';
import { buildPlaceIndex } from '../components/inventory/placeIndex';
import { cableRows, deviceRows, portRows, rackRows } from '../components/inventory/kinds';
import { parseScannedText, scanHash } from '../components/phone/scan';
import { parseHash } from '../components/inventory/listState';
import { encodeQr } from '../qr';
import { addStore, storeById } from '../document/stock';
import { LABEL_PRESETS, labelItems, pagesOf, presetOf, storeLabel } from './labels';

const ORIGIN = 'https://fathom.example.org';
const DESIGN = '01JQZ0000000000000000000D1';

function built() {
  const { doc } = buildSample(samples().find((s) => (s.configs ?? []).length === 0)!, new Map());
  const view = viewOf(doc, []);
  const idx = buildPlaceIndex(doc, view);
  return { doc, view, idx };
}

describe('labelItems', () => {
  it('gives every rack, device, cable and port a label whose code opens its own page', () => {
    const { doc, view, idx } = built();
    const lists = {
      devices: deviceRows(doc, view, [], idx),
      racks: rackRows(doc, view, [], idx),
      cables: cableRows(doc, view, idx),
      ports: portRows(doc, view, idx),
    } as const;
    for (const [kind, rows] of Object.entries(lists) as [keyof typeof lists, (typeof lists)[keyof typeof lists]][]) {
      const items = labelItems(kind, rows, ORIGIN, DESIGN);
      expect(items.length, kind).toBe(rows.length * (kind === 'cables' ? 2 : 1));
      expect(new Set(items.map((i) => i.key)).size).toBe(items.length);
      for (const item of items) {
        const target = parseScannedText(item.link, ORIGIN);
        expect(target?.designId).toBe(DESIGN);
        expect(scanHash(doc, target!.nodeId), item.link).not.toBeNull();
        expect(item.title).not.toBe('');
      }
    }
  });

  it('prints both ends of a cable with the same label', () => {
    const { doc, view, idx } = built();
    const [a, b] = labelItems('cables', cableRows(doc, view, idx).slice(0, 1), ORIGIN, DESIGN);
    expect(a!.link).toBe(b!.link);
    expect(a!.detail).toContain('⇄');
  });

  it('keeps the code inside a 24 mm tape at a readable module size', () => {
    // A long origin and the longest node kind a label carries: the worst case.
    const link = `https://fathom.network-team.example.org/scan#${DESIGN}/physical-port:01JQZ0000000000000000000P1`;
    const qr = encodeQr(link);
    const tape = presetOf('tze-24');
    // 2 mm margins top and bottom, 4 modules of quiet zone each side.
    const moduleMm = (tape.heightMm - 4) / (qr.size + 8);
    expect(moduleMm).toBeGreaterThan(0.3);
  });
});

describe('pagesOf', () => {
  it('puts one label on a page for tape and thirty on an A4 sheet', () => {
    const items = Array.from({ length: 31 }, (_, i) => ({ key: String(i), title: 't', detail: '', link: ORIGIN }));
    expect(pagesOf(items, presetOf('tze-24')).length).toBe(31);
    expect(pagesOf(items, presetOf('a4')).map((p) => p.length)).toEqual([30, 1]);
  });

  it('every preset is a size the stylesheet names', () => {
    expect(LABEL_PRESETS.map((p) => p.id).sort()).toEqual(['a4', 'ql-29', 'ql-62', 'tze-12', 'tze-18', 'tze-24']);
  });
});

describe('storeLabel', () => {
  it('a bin label opens its store', () => {
    const made = addStore(built().doc, { name: 'Cage 3 bin A', place: 'Row C' });
    const item = storeLabel(storeById(made.doc, made.id)!, ORIGIN, DESIGN);
    expect(item).toMatchObject({ title: 'Cage 3 bin A', detail: 'Row C' });
    const target = parseScannedText(item.link, ORIGIN)!;
    expect(parseHash(scanHash(made.doc, target.nodeId)!)).toMatchObject({ kind: 'parts', open: made.id });
  });
});
