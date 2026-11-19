import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { emptyDocument } from '../../document/model';
import { deriveNetworks } from '../../document/networks-derive';
import { viewOf } from '../../document/view';
import { NetworksPanel } from './NetworksPanel';

function panel(canDraw: boolean): string {
  const doc = emptyDocument();
  return renderToStaticMarkup(createElement(NetworksPanel, { doc, derived: deriveNetworks(doc), view: viewOf(doc, []), applyDocChange: () => {}, canDraw }));
}

describe('the Networks list in a design with no network', () => {
  it('says there are none yet, what a network is, and offers the way to add the first', () => {
    const html = panel(true);
    expect(html).toContain('No networks yet.');
    expect(html).toContain('A network is a VLAN, a subnet or a Docker network.');
    expect(html).toMatch(/<button[^>]*class="empty-state__action"[^>]*>Add network<\/button>/);
    // It is not the filter's doing, so it does not say so.
    expect(html).not.toContain('match this filter');
  });

  it('offers a reader no button they cannot press', () => {
    const html = panel(false);
    expect(html).toContain('No networks yet.');
    expect(html).not.toContain('empty-state__action');
  });
});
