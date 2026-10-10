import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { createSketchDevice } from '../../document/commands';
import { emptyDocument, parseNodeId } from '../../document/model';
import { setDeviceField } from '../../document/edit';
import { viewOf } from '../../document/view';
import { MultiDevicePanel } from './MultiDevicePanel';

function setup() {
  let doc = createSketchDevice(emptyDocument(), { now: 1, actor: 'A' });
  doc = createSketchDevice(doc, { now: 2, actor: 'A' });
  const devices = doc.nodes.filter((n) => parseNodeId(n.id).kind === 'Device').map((n) => n.id);
  doc = setDeviceField(doc, devices[0]!, 'role', 'switch', { actor: 'A', now: 3 });
  doc = setDeviceField(doc, devices[1]!, 'role', 'server', { actor: 'A', now: 4 });
  const view = viewOf(doc, []);
  const ids = view.unplaced.map((c) => c.id);
  return { doc, view, ids };
}

const html = (canDraw: boolean) => {
  const { doc, view, ids } = setup();
  return renderToStaticMarkup(createElement(MultiDevicePanel, { ids, view, doc, apply: () => {}, canDraw, onClear: () => {} }));
};

describe('MultiDevicePanel', () => {
  it('says how many are selected and shows Mixed where they differ', () => {
    const out = html(true);
    expect(out).toContain('2 devices selected');
    expect(out).toContain('Mixed');
  });

  it('offers no move to a reader', () => {
    expect(html(true)).toContain('Move all into');
    expect(html(false)).not.toContain('Move all into');
  });

  it('has no owner field, because the schema has none on a device', () => {
    expect(html(true).toLowerCase()).not.toContain('owner');
  });
});
