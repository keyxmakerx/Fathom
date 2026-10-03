import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import type { AccessPerson } from '../api/share';
import { AccessTable, choiceFor } from './SharePanel';

const base: AccessPerson = { account: 'A', email: 'a@x', name: 'Sam R.', you: false, standing: null, inherited: false, direct: [] };

describe('choiceFor', () => {
  it('lets the panel set View, Draw or nothing for an ordinary member', () => {
    expect(choiceFor(base)).toBe('none');
    expect(choiceFor({ ...base, standing: 'read' })).toBe('read');
    expect(choiceFor({ ...base, standing: 'draw' })).toBe('draw');
  });

  it('never offers a choice for you, a steward, or a standing from above', () => {
    expect(choiceFor({ ...base, you: true, standing: 'steward' })).toBeNull();
    expect(choiceFor({ ...base, standing: 'steward' })).toBeNull();
    expect(choiceFor({ ...base, standing: 'draw', inherited: true })).toBeNull();
  });
});

describe('AccessTable', () => {
  it('draws one row per person, a select only where the panel can set it', () => {
    const html = renderToStaticMarkup(
      createElement(AccessTable, {
        busy: null,
        onChoose: () => {},
        people: [
          { ...base, name: 'KM', you: true, standing: 'steward' },
          { ...base, account: 'B', name: 'Sam R.', standing: 'read' },
          { ...base, account: 'C', name: 'Pat', standing: 'draw', inherited: true },
        ],
      }),
    );
    expect(html).toContain('KM · you');
    expect(html).toContain('Steward');
    expect(html).toContain('Draw · inherited');
    expect(html.match(/<select/g)).toHaveLength(1);
    expect(html).toContain('<option value="read" selected="">View</option>');
  });
});
