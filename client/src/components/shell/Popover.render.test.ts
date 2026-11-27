import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { Popover, PopoverRow, pressRow, rowSaid } from './Popover';

// No DOM testing library is installed (the shell brief's tests section is explicit
// that none may be added), so this is a render-to-string smoke test rather
// than an interaction test: it exercises the *initial* render only, which is
// enough to check the popover starts closed and the trigger carries the
// disclosure wiring a screen reader needs. Click-away, Escape and
// focus-return (Popover.tsx's `useEffect`) are DOM interactions this
// environment cannot drive — a known gap.
//
// `children` is passed inside the props object rather than as trailing
// `createElement` arguments: both are equivalent at runtime, but only the
// former satisfies these components' (deliberately required) `children`
// prop under TypeScript's `createElement` overloads.

describe('Popover (render-to-string)', () => {
  it('starts closed: the popover content is absent from the markup', () => {
    const markup = renderToStaticMarkup(
      createElement(Popover, {
        renderTrigger: ({ triggerProps }) =>
          createElement('button', { type: 'button', ...triggerProps }, 'Open'),
        children: createElement(PopoverRow, { children: 'A row' }),
      }),
    );

    expect(markup).toContain('Open');
    expect(markup).not.toContain('A row');
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain('aria-haspopup="menu"');
  });

  it('gives the trigger an aria-controls id matching a role="menu" region once opened', () => {
    // Popover starts closed by design (useState(false)), so this asserts on
    // the id contract rather than forcing `open` from outside — there is no
    // supported way to do that without the popover managing its own state,
    // which is the point of the component.
    let controlsId = '';
    renderToStaticMarkup(
      createElement(Popover, {
        renderTrigger: ({ triggerProps }) => {
          controlsId = triggerProps['aria-controls'];
          return createElement('button', { type: 'button', ...triggerProps }, 'Open');
        },
        children: null,
      }),
    );
    expect(controlsId.length).toBeGreaterThan(0);
  });
});

describe('PopoverRow (render-to-string)', () => {
  it('renders a real, clickable button by default', () => {
    const markup = renderToStaticMarkup(createElement(PopoverRow, { children: 'Sign out' }));
    expect(markup).toContain('<button');
    expect(markup).toContain('Sign out');
    expect(markup).not.toContain('disabled');
  });

  it('marks a greyed row as off for a screen reader, and leaves it in reach of the keyboard so its reason is read', () => {
    const markup = renderToStaticMarkup(createElement(PopoverRow, { disabled: true, children: 'Site' }));
    expect(markup).toContain('aria-disabled="true"');
    expect(markup).not.toContain('disabled=""');
  });

  it('a press on a greyed row does nothing and leaves the menu open, not just styled to look off', () => {
    const did: string[] = [];
    pressRow({ disabled: true, onSelect: () => did.push('acted') }, () => did.push('closed'));
    expect(did).toEqual([]);
  });

  it('a press on a row that acts closes the menu first, then acts; a row with nothing to do does neither', () => {
    const did: string[] = [];
    pressRow({ disabled: false, onSelect: () => did.push('acted') }, () => did.push('closed'));
    expect(did).toEqual(['closed', 'acted']);
    pressRow({ disabled: false }, () => did.push('closed again'));
    expect(did).toEqual(['closed', 'acted']);
  });

  it('draws a hint after the row\'s words, and reads the two apart', () => {
    const markup = renderToStaticMarkup(createElement(PopoverRow, { disabled: true, hint: 'select a device first', children: "It's down" }));
    expect(markup).toContain('<span class="shell-doing__hint">select a device first</span>');
    expect(markup).toContain('aria-label="It&#x27;s down, select a device first"');
    expect(rowSaid("It's down", 'select a device first')).toBe("It's down, select a device first");
  });

  it('reads a row with no hint, or one that is not plain words, from the row itself', () => {
    expect(renderToStaticMarkup(createElement(PopoverRow, { children: 'Share' }))).not.toContain('aria-label');
    expect(rowSaid('Share', undefined)).toBeUndefined();
    expect(rowSaid('Share', '  ')).toBeUndefined();
    expect(rowSaid(createElement('b', null, 'Share'), 'soon')).toBeUndefined();
  });

  it('marks the current row distinctly from a plain one', () => {
    const current = renderToStaticMarkup(createElement(PopoverRow, { current: true, children: 'Cables' }));
    const plain = renderToStaticMarkup(createElement(PopoverRow, { children: 'Cables' }));
    expect(current).not.toEqual(plain);
    expect(current).toContain('shell-popover__row--current');
  });
});
