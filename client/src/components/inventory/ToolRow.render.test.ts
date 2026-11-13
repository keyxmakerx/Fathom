import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { ToolRow } from './ToolRow';

const noop = () => {};
const render = (over: Partial<Parameters<typeof ToolRow>[0]> = {}) =>
  renderToStaticMarkup(createElement(ToolRow, { lens: 'cables', onLensChange: noop, find: createElement('div', { className: 'find-stand-in' }, 'Find'), ...over }));

describe('Inventory\'s tool row (r116)', () => {
  it('holds the lens (Cables, Routing, Power, Owner) beside Find', () => {
    const html = render();
    for (const word of ['Cables', 'Routing', 'Power', 'Owner']) expect(html).toContain(`>${word}<`);
    expect(html.indexOf('find-stand-in')).toBeLessThan(html.indexOf('>Cables<'));
  });

  it('has no Back until there is a page to go back from, and then it says just "Back"', () => {
    expect(render()).not.toContain('Back');
    const html = render({ back: { word: 'Devices', onBack: noop } });
    expect(html).toContain('</span> Back</button>');
    expect(html).toContain('title="Back to Devices"');
    expect(html.indexOf('data-testid="inv-back"')).toBeLessThan(html.indexOf('find-stand-in'));
  });

  it('on the Sheet (no Find) the lens is still here', () => {
    const html = render({ find: undefined });
    expect(html).toContain('>Routing<');
    expect(html).not.toContain('find-stand-in');
  });
});
