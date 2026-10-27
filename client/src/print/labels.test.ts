import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { viewOf } from '../document/view';
import { buildSample, samples } from '../components/home/sampleNetwork';
import { buildPlaceIndex } from '../components/inventory/placeIndex';
import { cableRows, deviceRows, portRows, rackRows } from '../components/inventory/kinds';
import { parseScannedText, scanHash } from '../components/phone/scan';
import { parseHash } from '../components/inventory/listState';
import { encodeQr } from '../qr';
import { addStore, storeById } from '../document/stock';
import { CABLE_THICKNESS, LABEL_PRESETS, aroundMm, labelItems, pageNameOf, pagesOf, presetOf, presetsFor, storeLabel, wrapColumns } from './labels';


// Read as text: Vitest hands a stylesheet import back empty.
const labelsCss = readFileSync(fileURLToPath(new URL('./labels.css', import.meta.url)), 'utf8');

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

  it('every preset, at every cable thickness, is a page the stylesheet names at the same size', () => {
    for (const p of LABEL_PRESETS) {
      for (const t of CABLE_THICKNESS) {
        const sized = presetOf(p.id, t.id);
        const w = sized.sheet?.widthMm ?? sized.widthMm;
        const h = sized.sheet?.heightMm ?? sized.heightMm;
        const name = pageNameOf(p.id, t.id);
        expect(labelsCss, name).toContain(`@page ${name} { size: ${w}mm ${h}mm; margin: 0; }`);
        expect(labelsCss, name).toContain(`.labels-page--${name.replace(/^label-/, '')} { page: ${name}; }`);
      }
    }
  });
});

describe('cable wraps and flags', () => {
  it('are offered only when printing cables', () => {
    expect(presetsFor(false).some((p) => p.shape !== 'flat')).toBe(false);
    expect(presetsFor(true).map((p) => p.id)).toEqual(expect.arrayContaining(['wrap-24', 'flag-24', 'tze-36']));
    expect(presetsFor(false).map((p) => p.id)).toContain('tze-36');
  });

  it('go once round the cable, with a little over for a wrap and a face each end for a flag', () => {
    // Cat6 is about 6 mm across: 19 mm round.
    expect(aroundMm('cat6')).toBe(19);
    expect(presetOf('wrap-24', 'cat6').widthMm).toBeGreaterThan(aroundMm('cat6'));
    expect(presetOf('flag-24', 'cat6a').widthMm).toBeGreaterThan(presetOf('flag-24', 'cat6').widthMm);
    for (const t of CABLE_THICKNESS) {
      const wrap = presetOf('wrap-24', t.id);
      // The name shows at least twice round the cable, in columns wide enough to read.
      expect(wrapColumns(wrap)).toBeGreaterThanOrEqual(2);
      expect(wrap.widthMm / wrapColumns(wrap)).toBeGreaterThanOrEqual(7);
    }
  });

  it('a flat label is the same at any thickness', () => {
    expect(presetOf('tze-24', 'slim')).toEqual(presetOf('tze-24', 'cat6a'));
    expect(pageNameOf('tze-24', 'slim')).toBe('label-tze-24');
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
