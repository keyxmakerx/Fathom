import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { CableRunAsk, RackSizeAsk } from './AskCard';
import { MenuItems } from './ContextMenu';
import { menuItemsFor, type MenuActions } from './contextMenuItems';

const noop = () => {};

describe('the question "Add a rack…" asks after the click (r116)', () => {
  it('offers 42U, 24U, 12U and Custom, under one title', () => {
    const markup = renderToStaticMarkup(createElement(RackSizeAsk, { x: 0, y: 0, onPick: noop, onClose: noop }));
    expect(markup).toContain('How tall is the rack?');
    const rows = [...markup.matchAll(/aria-label="([^"]+)"/g)].map((m) => m[1]);
    expect(rows).toEqual(['42U', '24U', '12U', 'Custom…']);
  });
});

describe('the question "Add a cable run…" asks after the click (r116)', () => {
  it('lists a row for each free side, and removal of a run already there', () => {
    const run = { id: 'run1', hostId: 'r1', form: 'lacing_bar' as const, side: 'left' as const, label: null, ties: [] };
    const actions: MenuActions = { onSelect: noop, onAddCableRun: vi.fn(), onRemoveCableRun: vi.fn(), cableRunsOn: () => [run] };
    const markup = renderToStaticMarkup(createElement(CableRunAsk, { x: 0, y: 0, hostId: 'r1', actions, onClose: noop }));
    expect(markup).toContain('Add a lacing bar on the right');
    expect(markup).toContain('Add a cable tray on top');
    expect(markup).toContain('Remove the left lacing bar');
    expect(markup).not.toContain('Add a lacing bar on the left');
  });
});

describe('a menu draws its groups as rules, not headings (r116)', () => {
  it('puts a rule between the device menu\'s groups and none before the removal, which draws its own', () => {
    const actions: MenuActions = {
      onSelect: noop,
      onOpen: noop,
      onTraceFrom: noop,
      onItsDown: noop,
      onPlanChange: noop,
      onDuplicateDevice: noop,
      onRemoveDevice: noop,
    };
    const markup = renderToStaticMarkup(createElement(MenuItems, { items: menuItemsFor({ kind: 'chassis', id: 'c1' }, actions) }));
    expect((markup.match(/drawing-context-menu__rule/g) ?? []).length).toBe(2);
    expect(markup).not.toContain('drawing-context-menu__group');
    expect(markup).toContain('drawing-context-menu__item--danger');
  });
});
