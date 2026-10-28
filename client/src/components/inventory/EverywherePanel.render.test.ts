import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { parseEstate } from '../../api/estate';
import { utf8 } from '../../crypto/bytes';
import { coverageSentence, EverywhereTable } from './EverywherePanel';

// The bytes are the shape `estate_routes.rs`'s `answer` builds.
const answer = parseEstate(
  utf8(
    JSON.stringify({
      behind: 2,
      designs: 14,
      hits: [
        { addresses: ['10.20.0.1'], design: 'D1', designName: 'Leeds DC', device: '', element: 'n1', kind: 'device', model: 'EX4300-48T', name: 'core-sw-01', open: 'c1', place: 'A-01 U12', serial: 'PE3714AF0123' },
        { addresses: [], design: 'D2', designName: null, device: 'edge-rtr-02', element: 'p9', kind: 'optic', model: 'Juniper EX-SFP-10GE-LR', name: 'xe-0/2/0', open: 'p9', place: '', serial: 'ABC123' },
      ],
    }),
  ),
);

describe('Inventory › Every site', () => {
  it('reads the answer', () => {
    expect(answer.hits.map((h) => h.kind)).toEqual(['device', 'optic']);
    expect(answer.hits[0].open).toBe('c1');
    expect(answer.behind).toBe(2);
  });

  it('shows each thing with its design, and says which is this one', () => {
    const html = renderToStaticMarkup(createElement(EverywhereTable, { hits: answer.hits, currentDesign: 'D2' }));
    expect(html).toContain('core-sw-01');
    expect(html).toContain('Leeds DC');
    expect(html).toContain('This design');
    expect(html).toContain('10.20.0.1');
    expect(html).toContain('Optic');
  });

  it('says how many designs it looked in and how many are catching up', () => {
    expect(coverageSentence(answer)).toBe('Looked in 14 designs you can open. 2 of them are still being brought up to date, so a recent change may not show yet.');
  });
});
