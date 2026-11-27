import { describe, expect, it } from 'vitest';

import { SHORTCUTS } from '../shell/shortcuts';
import { enterOn, escapeClears, escapeOnWalkedNode, KEYS_SAID } from './nodeKey';

/** Something on the page with these classes, as React Flow writes a node or a cable. */
function thing(classes: string, id: string | null = 'chassis:c1') {
  const list = classes.split(' ');
  return { classList: { contains: (name: string) => list.includes(name) }, getAttribute: (name: string) => (name === 'data-id' ? id : null) };
}

function press(target: unknown, over: Partial<KeyboardEvent> = {}) {
  return { key: 'Enter', ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, repeat: false, defaultPrevented: false, target: target as EventTarget, ...over };
}

const NODE = 'react-flow__node react-flow__node-chassis nopan selectable draggable';
const EDGE = 'react-flow__edge react-flow__edge-cable nopan';

describe('Enter on what the keyboard is on in the drawing', () => {
  it('names the node it was pressed on', () => {
    expect(enterOn(press(thing(NODE)))).toEqual({ kind: 'node', id: 'chassis:c1' });
    expect(enterOn(press(thing('react-flow__node react-flow__node-surface', 'surface:s1')))).toEqual({ kind: 'node', id: 'surface:s1' });
  });

  it('names the cable it was pressed on', () => {
    expect(enterOn(press(thing(EDGE, 'cable-7')))).toEqual({ kind: 'edge', id: 'cable-7' });
  });

  it('with Shift it is still a press: Shift adds to what is picked', () => {
    expect(enterOn(press(thing(NODE), { shiftKey: true }))).toEqual({ kind: 'node', id: 'chassis:c1' });
  });

  it('is not taken from a button, a port or a field inside a node', () => {
    expect(enterOn(press(thing('drawing-surface__port')))).toBeNull();
    expect(enterOn(press(thing('drawing-shelf__compact-occupant')))).toBeNull();
    expect(enterOn(press(thing('drawing-name-edit__input')))).toBeNull();
    expect(enterOn(press({ tagName: 'BODY' }))).toBeNull();
    expect(enterOn(press(null))).toBeNull();
  });

  it('leaves Space alone: on the drawing it is held to pan', () => {
    expect(enterOn(press(thing(NODE), { key: ' ' }))).toBeNull();
  });

  it('is not a held key repeating, a key something has used, or one with Ctrl, Cmd or Alt', () => {
    expect(enterOn(press(thing(NODE), { repeat: true }))).toBeNull();
    expect(enterOn(press(thing(NODE), { defaultPrevented: true }))).toBeNull();
    expect(enterOn(press(thing(NODE), { ctrlKey: true }))).toBeNull();
    expect(enterOn(press(thing(NODE), { metaKey: true }))).toBeNull();
    expect(enterOn(press(thing(NODE), { altKey: true }))).toBeNull();
  });

  it('needs the id the canvas gave the thing', () => {
    expect(enterOn(press(thing(NODE, null)))).toBeNull();
    expect(enterOn(press(thing(NODE, '')))).toBeNull();
  });

  it('is in the shortcuts table, so the sheet lists it', () => {
    const row = SHORTCUTS.find((s) => s.id === 'select-focused');
    expect(row?.keys).toEqual(['Enter']);
    expect(row?.group).toBe('Selection');
    expect(row?.spec).toEqual({ key: 'Enter' });
  });
});

describe('Escape on a node the keyboard walked to', () => {
  const node = thing(NODE);

  it('names the node, so the ring can be put back on it', () => {
    expect(escapeOnWalkedNode({ key: 'Escape', target: node as unknown as EventTarget }, true)).toBe(node);
  });

  it('is nothing after a press with a pointer: there is no ring to keep', () => {
    expect(escapeOnWalkedNode({ key: 'Escape', target: node as unknown as EventTarget }, false)).toBeNull();
  });

  it('is nothing for another key, or for Escape on a cable, a port or the page', () => {
    expect(escapeOnWalkedNode({ key: 'Enter', target: node as unknown as EventTarget }, true)).toBeNull();
    expect(escapeOnWalkedNode({ key: 'Escape', target: thing(EDGE) as unknown as EventTarget }, true)).toBeNull();
    expect(escapeOnWalkedNode({ key: 'Escape', target: thing('drawing-surface__port') as unknown as EventTarget }, true)).toBeNull();
    expect(escapeOnWalkedNode({ key: 'Escape', target: null }, true)).toBeNull();
  });
});

describe('Escape in the Diagram look', () => {
  const esc = (held: Partial<Record<'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey' | 'defaultPrevented', boolean>> = {}, key = 'Escape') => ({ key, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, defaultPrevented: false, ...held });
  const clear = { above: false, peek: false, card: false, typing: false };

  it('clears the selection, as the shortcuts sheet says', () => {
    expect(escapeClears(esc(), clear)).toBe(true);
  });

  it('puts away one thing at a time: a menu or a dialog, a hover card and the card beside the selection go first', () => {
    expect(escapeClears(esc(), { ...clear, above: true })).toBe(false);
    expect(escapeClears(esc(), { ...clear, peek: true })).toBe(false);
    expect(escapeClears(esc(), { ...clear, card: true })).toBe(false);
  });

  it('leaves the key to someone typing, and to whatever has already used it', () => {
    expect(escapeClears(esc(), { ...clear, typing: true })).toBe(false);
    expect(escapeClears(esc({ defaultPrevented: true }), clear)).toBe(false);
  });

  it('is Escape alone: not another key, and not Escape with Ctrl, Cmd or Alt', () => {
    expect(escapeClears(esc({}, 'Enter'), clear)).toBe(false);
    expect(escapeClears(esc({ ctrlKey: true }), clear)).toBe(false);
    expect(escapeClears(esc({ metaKey: true }), clear)).toBe(false);
    expect(escapeClears(esc({ altKey: true }), clear)).toBe(false);
  });
});

describe('what is read out for a node or a cable the keyboard is on', () => {
  it('says Enter selects, and offers neither Space nor a move, a delete or an Escape that not every thing has', () => {
    for (const said of Object.values(KEYS_SAID)) {
      expect(said).toBe('Press Enter to select it.');
      expect(said).not.toMatch(/space|arrow|delete|remove|escape/i);
    }
  });

  it('replaces every sentence React Flow would say about a node or an edge', () => {
    expect(Object.keys(KEYS_SAID).sort()).toEqual(['edge.a11yDescription.default', 'node.a11yDescription.default', 'node.a11yDescription.keyboardDisabled']);
  });
});
