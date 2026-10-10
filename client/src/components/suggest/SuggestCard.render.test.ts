import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { addSketchPort, createSketchDevice } from '../../document/commands';
import { emptyDocument, parseNodeId, type Document } from '../../document/model';
import { suggestMarks } from '../drawing/suggestGhosts';
import { SUGGEST_LINE, SuggestCard } from './SuggestCard';

const OPTS = { now: 1_700_000_000_000, actor: 'test' };

function box(doc: Document, hostname: string, labels: string[]): { doc: Document; chassisId: string } {
  const had = new Set(doc.nodes.map((n) => n.id));
  let d = createSketchDevice(doc, { ...OPTS, hostname });
  const chassisId = d.nodes.find((n) => !had.has(n.id) && parseNodeId(n.id).kind === 'Chassis')!.id;
  for (const label of labels) d = addSketchPort(d, chassisId, { label, connector: 'rj45', face: 'front' }, OPTS);
  return { doc: d, chassisId };
}

const LIST = `Local Interface    Chassis Id          Port info     System Name
ge-0/0/1           00:00:5e:00:53:01   ether2        router-1
ge-0/0/9           00:00:5e:00:53:04   eth0          ap-office
`;

const noop = () => undefined;

describe('the suggestions card', () => {
  const sw = box(emptyDocument(), 'switch-1', ['ge-0/0/1', 'ge-0/0/9']);
  const router = box(sw.doc, 'router-1', ['ether2']);
  const doc = box(router.doc, 'ap-office', ['1']).doc;

  it('opens on the one-line explanation and how to get the list', () => {
    const html = renderToStaticMarkup(createElement(SuggestCard, { doc, deviceId: sw.chassisId, onApply: noop, onClose: noop }));
    expect(html).toContain(SUGGEST_LINE.replace("'", '&#x27;'));
    expect(html).toContain('<code>show lldp neighbors</code>');
    expect(html).toContain('<code>lldpcli show neighbors</code>');
    expect(html).toMatch(/<option value="device:[^"]+" selected="">switch-1<\/option>/);
  });

  it('ticks what it can name and says why the rest is left', () => {
    const html = renderToStaticMarkup(createElement(SuggestCard, { doc, deviceId: sw.chassisId, text: LIST, onApply: noop, onClose: noop }));
    expect(html).toContain('Suggested cables · 2');
    expect(html).toMatch(/<input type="checkbox" checked=""\/><span class="suggest-card__end">switch-1 <span class="suggest-card__port">ge-0\/0\/1<\/span>/);
    expect(html).toContain('<input type="checkbox" disabled=""/>');
    expect(html).toContain('ap-office <span class="suggest-card__port">?</span>');
    expect(html).toContain('ap-office has no port called eth0 drawn, so it is left for you.');
    expect(html).toContain('Add 1 cable');
    expect(html).toContain('Skip');
  });

  it('asks for the switch when none was chosen', () => {
    const html = renderToStaticMarkup(createElement(SuggestCard, { doc, deviceId: null, text: LIST, onApply: noop, onClose: noop }));
    expect(html).toContain('Choose the switch this list was read on');
  });
});

describe('the dashed lines', () => {
  it('are plan add-cable marks with no word, so no tag is drawn', () => {
    expect(suggestMarks([{ key: 'a|b', ends: ['port:a', 'port:b'] }])).toEqual([{ stepId: 'suggest:a|b', ordinal: 0, kind: 'add-cable', keys: [], ends: ['port:a', 'port:b'], word: '' }]);
  });
});
