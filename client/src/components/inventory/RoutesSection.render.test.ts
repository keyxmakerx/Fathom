import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { estate } from '../../document/firmwareFixture';
import { emptyDocument, type Document } from '../../document/model';
import { addRoute } from '../../document/routes';
import { RoutesSection } from './RoutesSection';

// Render-to-string smoke tests, as the other component tests here do: no DOM library is installed.

const section = (doc: Document, canDraw: boolean, filter = '') =>
  renderToStaticMarkup(createElement(RoutesSection, { doc, canDraw, applyDocChange: () => undefined, filter }));

describe('Routes', () => {
  it('lists a default route as "default", with Remove for someone who can draw', () => {
    const { doc, ids } = estate();
    const made = addRoute(doc, { deviceId: ids.sw1, destination: 'default', via: '10.0.10.1' }).doc;
    const out = section(made, true);
    expect(out).toContain('1 route');
    expect(out).toContain('sw1');
    expect(out).toContain('>default<');
    expect(out).toContain('via 10.0.10.1');
    expect(out).toContain('by hand');
    expect(out).toContain('Remove');
    expect(out).toContain('Add route');
  });

  it('a reader gets no way to add or remove', () => {
    const { doc, ids } = estate();
    const out = section(addRoute(doc, { deviceId: ids.sw1, destination: 'default', via: '10.0.10.1' }).doc, false);
    expect(out).not.toContain('Add route');
    expect(out).not.toContain('Remove');
  });

  it('says when there are none, and when the filter hides them', () => {
    expect(section(emptyDocument(), true)).toContain('No routes yet.');
    const { doc, ids } = estate();
    const made = addRoute(doc, { deviceId: ids.sw1, destination: 'default', via: '10.0.10.1' }).doc;
    expect(section(made, true, 'fw1')).toContain('No routes match this filter.');
  });
});
