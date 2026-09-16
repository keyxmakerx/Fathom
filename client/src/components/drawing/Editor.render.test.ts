import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import type { ClosetView, EditorActions } from './contract';
import { EditorFor } from './Editor';

// Render-to-string smoke tests only, per the Popover precedent
// (`components/shell/Popover.render.test.ts`): no DOM testing library is
// installed, so interaction (the click-to-select, click-to-edit state
// machine `Editor.tsx`'s `EditableValue` holds) is not exercised, only
// markup shape — the idle state's rendered value, placeholder and marks.

const NOOP_ACTIONS: EditorActions = { onEdit: () => {} };

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
          role: 'switch',
          managementAddress: '10.10.0.2',
          serial: 'SN-0042',
        },
      ],
    },
  ],
};

const BARE_VIEW: ClosetView = {
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
          hostname: '',
          model: 'EX4300-48P',
          vendor: 'juniper',
          positionU: 38,
          heightU: 1,
          face: 'front',
          ports: [],
          role: null,
          managementAddress: null,
          serial: null,
        },
      ],
    },
  ],
};

describe('EditorFor', () => {
  it('returns null for no selection', () => {
    expect(EditorFor(null, VIEW, NOOP_ACTIONS)).toBeNull();
  });

  it('returns null for a selection this view does not carry', () => {
    expect(EditorFor({ kind: 'rack', id: 'nope' }, VIEW, NOOP_ACTIONS)).toBeNull();
  });

  it('renders the rack fields', () => {
    const markup = renderToStaticMarkup(EditorFor({ kind: 'rack', id: 'rack-1' }, VIEW, NOOP_ACTIONS) as never);
    expect(markup).toContain('A-04');
    expect(markup).toContain('42U');
    expect(markup).toContain('1 of 42U');
  });

  it('renders the chassis fields, honest that cable state is absent', () => {
    const markup = renderToStaticMarkup(
      EditorFor({ kind: 'chassis', id: 'chassis-1' }, VIEW, NOOP_ACTIONS) as never,
    );
    expect(markup).toContain('core-01');
    expect(markup).toContain('EX4300-48P');
    expect(markup).toContain('U38');
    expect(markup).toContain('— of 1 cabled');
  });

  it('renders the editable role, management address and serial, each marked stored as typed', () => {
    const markup = renderToStaticMarkup(
      EditorFor({ kind: 'chassis', id: 'chassis-1' }, VIEW, NOOP_ACTIONS) as never,
    );
    expect(markup).toContain('switch');
    expect(markup).toContain('10.10.0.2');
    expect(markup).toContain('SN-0042');
    expect(markup).toContain('Stored as typed.');
    expect(markup).toContain(
      'Fathom does not redact what you type, only what you paste, so it is saved and exported exactly as written.',
    );
  });

  it('renders absence as absence — no invented values, no typed mark', () => {
    const markup = renderToStaticMarkup(
      EditorFor({ kind: 'chassis', id: 'chassis-1' }, BARE_VIEW, NOOP_ACTIONS) as never,
    );
    expect(markup).toContain('unnamed');
    expect(markup).not.toContain('Stored as typed.');
    // Absent fields fall back to the shared dash mark — present at least
    // once per absent field (role, mgmt address, serial), never a blank.
    expect((markup.match(/—/g) ?? []).length).toBeGreaterThanOrEqual(3);
  });

  it('renders the port fields', () => {
    const markup = renderToStaticMarkup(EditorFor({ kind: 'port', id: 'port-1' }, VIEW, NOOP_ACTIONS) as never);
    expect(markup).toContain('RJ45');
    expect(markup).toContain('core-01');
  });
});
