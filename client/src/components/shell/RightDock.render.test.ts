import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { RightDock, type RightDockProps } from './RightDock';

const noop = () => {};
function render(over: Partial<RightDockProps>): string {
  return renderToStaticMarkup(
    createElement(RightDock, {
      shown: null,
      details: null,
      history: null,
      trail: 'trail rows',
      canOpenHistory: true,
      historyLive: false,
      editorProps: {},
      width: 420,
      max: 700,
      onChoose: noop,
      onFold: noop,
      onResize: noop,
      onReset: noop,
      onDragging: noop,
      ...over,
    }),
  );
}

describe('RightDock', () => {
  it('folded: only the labelled strip; the Trail is no tab of its own, History is', () => {
    const markup = render({});
    expect(markup).not.toContain('Open the trail');
    expect(markup).not.toContain('dock-trail');
    expect(markup).toContain('aria-label="Open the history"');
    expect(markup).not.toContain('Open the details');
    expect(markup).not.toContain('trail rows');
    expect(markup).toContain('aria-expanded="false"');
  });

  it('open on the trail: History is the open tab, with Saves and Trail inside it, and a resize handle', () => {
    const markup = render({ shown: 'trail' });
    expect(markup).toContain('<aside class="shell-trail" aria-label="Trail">trail rows</aside>');
    expect(markup).toContain('aria-label="Close the history"');
    expect(markup).toContain('data-testid="history-tab-saves"');
    expect(markup).toMatch(/aria-selected="true" data-testid="history-tab-trail"/);
    expect(markup).toContain('role="separator"');
    expect(markup).toContain('aria-valuenow="420"');
  });

  it('open on the saves: the same two tabs, Saves selected', () => {
    const markup = render({ shown: 'history', history: 'saves list' });
    expect(markup).toContain('<aside class="shell-editor" aria-label="History">saves list</aside>');
    expect(markup).toMatch(/aria-selected="true" data-testid="history-tab-saves"/);
    expect(markup).toContain('data-testid="history-tab-trail"');
  });

  it('every panel has the same head: its name and one fold arrow, with no cross and no word "Fold"', () => {
    const heads = [
      render({ shown: 'history', history: 'saves' }),
      render({ shown: 'trail' }),
      render({ shown: 'details', details: 'fields' }),
      render({ shown: 'equipment', equipment: 'items' }),
    ];
    for (const markup of heads) {
      expect(markup).toContain('<header class="panel-head" data-testid="dock-head">');
      expect((markup.match(/data-testid="panel-fold"/g) ?? []).length).toBe(1);
      expect(markup).not.toContain('>Fold<');
      expect(markup).not.toContain('×');
    }
    expect(heads[2]).toContain('<h2 class="panel-head__name">Details</h2>');
    expect(heads[3]).toContain('<h2 class="panel-head__name">Equipment</h2>');
    expect(heads[1]).toContain('<h2 class="panel-head__name">History</h2>');
  });

  it('has Equipment as a tab beside the rest, with the entry point the drives use', () => {
    const folded = render({ equipment: 'items' });
    expect(folded).toContain('aria-label="Open the equipment list"');
    expect(folded).toContain('data-testid="dock-equipment"');
    expect(folded).not.toContain('items');
    const open = render({ shown: 'equipment', equipment: 'items' });
    expect(open).toContain('<nav class="shell-rail" aria-label="Equipment">items</nav>');
    expect(open).toContain('aria-label="Close the equipment list"');
    expect(open).toContain('aria-valuenow="420"');
    expect(open.indexOf('dock-equipment')).toBeLessThan(open.indexOf('dock-history'));
  });

  it('offers Details only while something is selected', () => {
    expect(render({ details: 'fields' })).toContain('Open the details');
  });

  it('marks History when a past save is still showing behind another tab', () => {
    expect(render({ shown: 'details', details: 'fields', historyLive: true })).toContain('dock-tab--marked');
  });

  it('puts the strip in order: Equipment, Details, History, then the side tabs (Checks, Docs)', () => {
    const markup = render({
      equipment: 'items',
      details: 'fields',
      side: [
        { id: 'checks', label: 'Checks', open: false, onOpen: noop, onClose: noop },
        { id: 'docs', label: 'Docs', open: false, onOpen: noop, onClose: noop },
      ],
    });
    const order = ['dock-equipment', 'dock-details', 'dock-history', 'dock-checks', 'dock-docs'].map((id) => markup.indexOf(id));
    expect(order.every((at) => at >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('draws nothing where there is nothing to open', () => {
    expect(render({ trail: null, canOpenHistory: false })).toBe('');
  });
});
