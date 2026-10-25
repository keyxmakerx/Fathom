import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { RightDock, type RightDockProps } from './RightDock';
import { InSideSlot, nextActive, SideSlots, type SideTab } from './sideSlot';

const noop = () => {};
const tab = (id: string, open: boolean, count?: number): SideTab => ({ id, label: id === 'checks' ? 'Checks' : 'Plan', count, open, onOpen: noop, onClose: noop });
const dock = (over: Partial<RightDockProps>) =>
  renderToStaticMarkup(
    createElement(RightDock, {
      shown: null,
      details: 'DETAIL-BODY',
      history: null,
      trail: null,
      canOpenHistory: false,
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

describe('side tabs (r30-panels)', () => {
  it('a tab that opens takes the panel; one that closes gives it up', () => {
    expect(nextActive(null, {}, [tab('checks', true)])).toBe('checks');
    expect(nextActive('checks', { checks: true }, [tab('checks', true), tab('plan', true)])).toBe('plan');
    expect(nextActive('plan', { checks: true, plan: true }, [tab('checks', true), tab('plan', false)])).toBeNull();
    expect(nextActive(null, { checks: true }, [tab('checks', true)])).toBeNull();
  });

  it('draws each side tab on the strip with its count, and the active one in the panel instead of the details', () => {
    const out = dock({ shown: 'details', side: [tab('checks', true, 3), tab('plan', false)], active: 'checks' });
    expect(out).toContain('data-testid="dock-checks"');
    expect(out).toContain('Checks 3');
    expect(out).toContain('data-testid="dock-plan"');
    expect(out).toContain('data-side="checks"');
    expect(out).not.toContain('DETAIL-BODY');
  });

  it('outside a shell with side tabs, what goes in a slot draws where it is', () => {
    expect(renderToStaticMarkup(createElement(InSideSlot, { id: 'checks', children: 'checks here' }))).toBe('checks here');
    const inShell = createElement(SideSlots.Provider, { value: { checks: null } }, createElement(InSideSlot, { id: 'checks', children: 'checks here' }));
    expect(renderToStaticMarkup(inShell)).toBe('');
  });
});
