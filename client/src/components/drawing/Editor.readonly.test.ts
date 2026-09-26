import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import type { ClosetView, EditorActions } from './contract';
import { EditorFor } from './Editor';

// ADR-0052 §5, this session's brief item 1: "the editor renders every value
// as text with no inputs and no actions when onEdit is absent." Render-to-
// string smoke tests, the same shape `Editor.render.test.ts` already uses
// (no DOM testing library is installed — its own file header) — this checks
// markup shape only: no `onEdit` means no `<input`, `<select`, `<button` (an
// action, never a navigation `SelectLink`) reaches the output, while the
// same values `Editor.render.test.ts` already checks for a writer still
// read.

const READER_ACTIONS: EditorActions = {}; // no `onEdit` at all — ADR-0052 §5's reader

const VIEW: ClosetView = {
  premisesId: 'closet-1',
  unplaced: [],
  cables: [],
  rows: [],
  surfaces: [],
  racks: [
    {
      id: 'rack-1',
      label: 'A-04',
      heightU: 42,
      unitNumbering: 'bottom-up',
      row: 'A',
      bay: 1,
      freeRuns: [{ fromU: 1, toU: 10 }],
      shelves: [
        { id: 'shelf-1', label: 'shelf-a01', positionU: 20, heightU: 2, occupants: [] },
      ],
      chassis: [
        {
          id: 'chassis-1',
          deviceId: 'device-1',
          hostname: 'core-01',
          model: '',
          vendor: '',
          positionU: 38,
          heightU: 1,
          face: 'front',
          ports: [
            {
              id: 'port-1',
              label: '0',
              connector: 'RJ45',
              row: 0,
              column: 0,
              role: null,
              face: 'front',
              uplink: false,
              cable: null,
              passThroughId: null,
            },
          ],
          role: 'switch',
          managementAddress: '10.10.0.2',
          serial: 'SN-0042',
          psuInlets: [
            {
              id: 'inlet-1',
              label: 'PSU0',
              connector: 'C14',
              row: 0,
              column: 0,
              role: null,
              face: 'rear',
              uplink: false,
              cable: null,
              passThroughId: null,
              slot: 'PSU0',
              hotSwap: true,
              fitted: false,
              supplyId: null,
              serial: null,
              model: null,
              position: { row: 'single', column: 0 },
            },
          ],
          singleFed: false,
          oneFitted: false,
          placement: { kind: 'rack', rackId: 'rack-1', positionU: 38, face: 'front' },
          sketch: true,
        },
      ],
    },
  ],
};

function assertNoEditMarkup(markup: string) {
  expect(markup).not.toContain('<input');
  expect(markup).not.toContain('<select');
  expect(markup).not.toContain('<button');
}

describe('EditorFor — ADR-0052 §5 reader rendering (no EditorActions.onEdit)', () => {
  it('a rack: row/bay show as text, no input reaches the markup', () => {
    const markup = renderToStaticMarkup(EditorFor({ kind: 'rack', id: 'rack-1' }, VIEW, READER_ACTIONS));
    assertNoEditMarkup(markup);
    expect(markup).toContain('A');
    expect(markup).toContain('1');
  });

  it('a shelf: no "+ add a shelf"-style control and no input for its label', () => {
    const markup = renderToStaticMarkup(EditorFor({ kind: 'shelf', id: 'shelf-1' }, VIEW, READER_ACTIONS));
    assertNoEditMarkup(markup);
    expect(markup).toContain('shelf-a01');
  });

  it('a chassis: hostname/role/mgmt/serial all render as plain text, no PLACED ON form, no add-a-port control, no fit action', () => {
    const markup = renderToStaticMarkup(EditorFor({ kind: 'chassis', id: 'chassis-1' }, VIEW, READER_ACTIONS));
    assertNoEditMarkup(markup);
    expect(markup).toContain('core-01');
    expect(markup).toContain('switch');
    expect(markup).toContain('10.10.0.2');
    expect(markup).toContain('SN-0042');
    // "+ add a port" / "+ add a shelf" / "fit" are all `<button>` text —
    // already excluded by `assertNoEditMarkup`'s `<button` check, but named
    // here so a future change to those controls' markup (e.g. a link
    // instead of a button) is still caught by an explicit assertion, not
    // only the generic one.
    expect(markup).not.toContain('+ add a port');
    expect(markup).not.toContain('+ add a shelf');
    expect(markup).not.toContain('a range');
    expect(markup).not.toContain('Duplicate');
  });

  it('a writer (onEdit present) still gets the interactive controls this reader does not', () => {
    const markup = renderToStaticMarkup(EditorFor({ kind: 'chassis', id: 'chassis-1' }, VIEW, { onEdit: () => {} }));
    expect(markup).toContain('<button');
    expect(markup).toContain('Duplicate');
  });
});
