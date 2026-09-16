import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import type { ClosetView } from './contract';
import { EditorFor } from './Editor';

// Render-to-string smoke tests only, per the Popover precedent
// (`components/shell/Popover.render.test.ts`): no DOM testing library is
// installed, so interaction (there is none here — `EditorFor` is a pure
// function of its two arguments) is not exercised, only markup shape.

const VIEW: ClosetView = {
  premisesId: 'closet-1',
  racks: [
    {
      id: 'rack-1',
      label: 'A-04',
      heightU: 42,
      unitNumbering: 'bottom-up',
      freeRuns: [{ fromU: 1, toU: 10 }],
      chassis: [
        {
          id: 'chassis-1',
          deviceId: 'device-1',
          hostname: 'core-01',
          model: 'EX4300-48P',
          vendor: 'juniper',
          positionU: 38,
          heightU: 1,
          face: 'front',
          ports: [{ id: 'port-1', label: '0', connector: 'RJ45', row: 0, column: 0, uplink: false }],
        },
      ],
    },
  ],
};

describe('EditorFor', () => {
  it('returns null for no selection', () => {
    expect(EditorFor(null, VIEW)).toBeNull();
  });

  it('returns null for a selection this view does not carry', () => {
    expect(EditorFor({ kind: 'rack', id: 'nope' }, VIEW)).toBeNull();
  });

  it('renders the rack fields', () => {
    const markup = renderToStaticMarkup(EditorFor({ kind: 'rack', id: 'rack-1' }, VIEW) as never);
    expect(markup).toContain('A-04');
    expect(markup).toContain('42U');
    expect(markup).toContain('1 of 42U');
  });

  it('renders the chassis fields, honest that cable state is absent', () => {
    const markup = renderToStaticMarkup(EditorFor({ kind: 'chassis', id: 'chassis-1' }, VIEW) as never);
    expect(markup).toContain('core-01');
    expect(markup).toContain('EX4300-48P');
    expect(markup).toContain('U38');
    expect(markup).toContain('— of 1 cabled');
  });

  it('renders the port fields', () => {
    const markup = renderToStaticMarkup(EditorFor({ kind: 'port', id: 'port-1' }, VIEW) as never);
    expect(markup).toContain('RJ45');
    expect(markup).toContain('core-01');
  });
});
