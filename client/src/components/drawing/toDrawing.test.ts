import { describe, expect, it } from 'vitest';

import { FIRST_STOP, shiftToShow, stopSelectors } from './toDrawing';

describe('where G takes the keyboard (r159)', () => {
  it('goes to the first stop with nothing selected', () => {
    expect(stopSelectors(null)).toEqual([]);
    expect(FIRST_STOP).toBe('.react-flow__node[tabindex="0"]');
  });

  it('looks for a pressed port by its drawn button only', () => {
    expect(stopSelectors({ kind: 'port', id: 'port:1' })).toEqual(['button[data-port-id="port:1"]']);
  });

  it('looks for a cable by its line', () => {
    expect(stopSelectors({ kind: 'cable', id: 'cable:9' })).toEqual(['.react-flow__edge[data-id="cable:9"]']);
  });

  it('looks for a device on a wall or a shelf first, then a node on the Canvas, then a box in the Diagram look', () => {
    expect(stopSelectors({ kind: 'chassis', id: 'chassis:7' })).toEqual([
      '[data-device-chassis="chassis:7"]',
      '.react-flow__node[data-id$=":chassis:7"]',
      '.react-flow__node[data-id="chassis:7"]',
    ]);
  });

  it('quotes an id so a quote in it cannot end the selector', () => {
    expect(stopSelectors({ kind: 'cable', id: 'a"b' })).toEqual(['.react-flow__edge[data-id="a\\"b"]']);
  });
});

describe('a thing the keyboard walks onto is brought into view (r159)', () => {
  const pane = { left: 0, top: 0, right: 1000, bottom: 800 };
  it('leaves a thing that shows alone', () => {
    expect(shiftToShow({ left: 100, top: 100, right: 200, bottom: 150 }, pane)).toBeNull();
  });
  it('moves the drawing up for a thing below the pane, and left for one off the right', () => {
    expect(shiftToShow({ left: 100, top: 900, right: 200, bottom: 950 }, pane)).toEqual({ dx: 0, dy: -174 });
    expect(shiftToShow({ left: 990, top: 100, right: 1090, bottom: 150 }, pane)).toEqual({ dx: -114, dy: 0 });
  });
  it('moves it down and right for a thing above or to the left', () => {
    expect(shiftToShow({ left: -50, top: -20, right: 50, bottom: 20 }, pane)).toEqual({ dx: 74, dy: 44 });
  });
  it('shows a thing larger than the pane from its top left', () => {
    expect(shiftToShow({ left: 10, top: 300, right: 2000, bottom: 400 }, pane)).toEqual({ dx: 14, dy: 0 });
  });
});
