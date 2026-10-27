import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { emptyDocument, type Document } from '../../document/model';
import { addStock, addStore, setStockLevel } from '../../document/stock';
import { StockPanel, StoreBinPage } from './StockPanel';

// Render-to-string smoke tests, as the other component tests here do: no DOM library is installed.

function stocked(): { doc: Document; storeId: string } {
  const store = addStore(emptyDocument(), { name: 'Comms cupboard', place: '2nd floor' });
  const added = addStock(store.doc, [
    { part: 'optic', model: 'SFP-10G-SR', serial: 'AVP1001', storeId: store.id, bin: 'bin 3' },
    { part: 'cable', name: 'Patch lead, Cat6, 2 m', count: 37, storeId: store.id },
    { part: 'card', model: 'LC-4QSFP28', state: 'on_order', due: '2026-11-04' },
  ]);
  return { doc: setStockLevel(added.doc, 'SFP-10G-SR', 3), storeId: store.id };
}

const panel = (doc: Document, canDraw: boolean) =>
  renderToStaticMarkup(createElement(StockPanel, { doc, canDraw, applyDocChange: () => undefined, redact: async (t: string) => t }));

describe('On hand', () => {
  it('lists what is on hand, says what is short, and lists the stores and levels', () => {
    const { doc } = stocked();
    const out = panel(doc, true);
    expect(out).toContain('SFP-10G-SR');
    expect(out).toContain('Patch lead, Cat6, 2 m');
    expect(out).not.toContain('LC-4QSFP28</span>');
    expect(out).toContain('Below the level you keep: SFP-10G-SR 1 of 3.');
    expect(out).toContain('Comms cupboard');
    expect(out).toContain('38 on hand');
    expect(out).toContain('+ Add to stock');
  });

  it('a reader gets no way to add', () => {
    const out = panel(stocked().doc, false);
    expect(out).not.toContain('+ Add to stock');
    expect(out).not.toContain('Add store');
  });

  it('says what to do when nothing is on hand', () => {
    expect(panel(emptyDocument(), true)).toContain('Nothing on hand yet.');
  });

  it("a store's page lists its bins, no bin first", () => {
    const { doc, storeId } = stocked();
    const out = renderToStaticMarkup(createElement(StoreBinPage, { doc, storeId, canDraw: false, onChange: () => undefined }));
    expect(out.indexOf('No bin')).toBeLessThan(out.indexOf('bin 3'));
    expect(out).toContain('2nd floor');
    expect(out).not.toContain('Change store');
  });
});
