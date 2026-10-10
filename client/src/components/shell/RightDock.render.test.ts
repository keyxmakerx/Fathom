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
  it('folded: only the labelled strip, with the buttons the entry points use', () => {
    const markup = render({});
    expect(markup).toContain('aria-label="Open the trail"');
    expect(markup).toContain('aria-label="Open the history"');
    expect(markup).not.toContain('Open the details');
    expect(markup).not.toContain('trail rows');
    expect(markup).toContain('aria-expanded="false"');
  });

  it('open on the trail: the trail beside the strip, with a resize handle', () => {
    const markup = render({ shown: 'trail' });
    expect(markup).toContain('<aside class="shell-trail" aria-label="Trail">trail rows</aside>');
    expect(markup).toContain('aria-label="Close the trail"');
    expect(markup).toContain('role="separator"');
    expect(markup).toContain('aria-valuenow="420"');
  });

  it('offers Details only while something is selected', () => {
    expect(render({ details: 'fields' })).toContain('Open the details');
  });

  it('marks History when a past save is still showing behind another tab', () => {
    expect(render({ shown: 'trail', historyLive: true })).toContain('dock-tab--marked');
  });

  it('draws nothing where there is nothing to open', () => {
    expect(render({ trail: null, canOpenHistory: false })).toBe('');
  });
});
