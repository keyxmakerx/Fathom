import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { ADD_EQUIPMENT_LABEL, EMPTY_HINT, EQUIPMENT_SIDE, JOT_HINT } from '../racks/emptyHints';
import { EmptyHint } from './EmptyHint';

describe('the empty design', () => {
  it('has an Add equipment button that the canvas can wire up', () => {
    const out = renderToStaticMarkup(createElement(EmptyHint, { hint: EMPTY_HINT, onAddEquipment: () => {} }));
    expect(out).toContain('data-testid="add-equipment"');
    expect(out).toContain(`>${ADD_EQUIPMENT_LABEL}<`);
    expect(out).toContain('role="note"');
  });

  it('shows no button where nothing can open Equipment', () => {
    expect(renderToStaticMarkup(createElement(EmptyHint, { hint: EMPTY_HINT }))).not.toContain('add-equipment');
  });
});

describe('the hints name the side Equipment is really on', () => {
  it('says right, because the dock puts the Equipment tab on the right edge', () => {
    expect(EQUIPMENT_SIDE).toBe('right');
    expect(EMPTY_HINT).toContain('Equipment tab on the right edge');
    expect(JOT_HINT).toContain('Equipment tab on the right edge');
    expect(EMPTY_HINT).not.toMatch(/left/i);
    expect(JOT_HINT).not.toMatch(/left/i);
  });
});
