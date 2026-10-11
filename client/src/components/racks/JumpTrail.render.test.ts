import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { ColourKey } from '../drawing/ColourKey';
import { buildKey } from '../drawing/colourKey';
import { JumpTrail } from './JumpTrail';
import { EMPTY_TRAIL, back, visit, type Spot } from './jumpBack';

const spot = (id: string | null, stop: Spot['stop'] = 'rack'): Spot => ({ look: 'rack', selection: id ? { kind: 'rack', id } : null, jotId: null, stop });
const noop = () => {};

describe('JumpTrail', () => {
  it('shows nothing until there is somewhere to go back to', () => {
    const one = visit(EMPTY_TRAIL, spot(null), 'HQ', null, 0);
    expect(renderToStaticMarkup(createElement(JumpTrail, { trail: one, backLabel: null, onBack: noop, onForward: noop }))).toBe('');
  });

  it('names where Back goes, and shows no chips and no Forward until there is one', () => {
    let t = visit(EMPTY_TRAIL, spot(null), 'HQ', null, 0);
    t = visit(t, spot('r1'), 'R1', null, 10_000);
    t = visit(t, spot('r1', 'faceplate'), 'R1 · FACEPLATE', null, 20_000);
    const html = renderToStaticMarkup(createElement(JumpTrail, { trail: t, backLabel: 'R1', onBack: noop, onForward: noop }));
    expect(html).toContain('Back to R1');
    expect(html).not.toContain('>HQ<');
    expect(html).not.toContain('data-testid="jump-forward"');
  });

  it('shows Forward after going back, and hides Back at the start', () => {
    let t = visit(EMPTY_TRAIL, spot(null), 'HQ', null, 0);
    t = visit(t, spot('r1'), 'R1', null, 10_000);
    t = back(t)!.trail;
    const html = renderToStaticMarkup(createElement(JumpTrail, { trail: t, backLabel: null, onBack: noop, onForward: noop }));
    expect(html).toContain('aria-label="Forward to R1"');
    expect(html).not.toContain('data-testid="jump-back"');
  });
});

describe('ColourKey', () => {
  it('lists each colour with its words and a swatch', () => {
    const rows = buildKey(
      [
        { id: 'a', sheath: 'blue' },
        { id: 'b', sheath: 'blue' },
        { id: 'c', sheath: 'white' },
      ],
      [{ kind: 'vlan', name: 'Staff VLAN 20', cableIds: new Set(['a', 'b']) }],
    );
    const html = renderToStaticMarkup(createElement(ColourKey, { rows, onHighlight: noop }));
    expect(html).toContain('Blue · Staff VLAN 20');
    expect(html).toContain('White · 1 cable');
    expect(html).toContain('colour-key__swatch--outlined');
    expect(html).toContain('aria-pressed="false"');
  });

  it('draws nothing for a design with no cables', () => {
    expect(renderToStaticMarkup(createElement(ColourKey, { rows: [], onHighlight: noop }))).toBe('');
  });
});
