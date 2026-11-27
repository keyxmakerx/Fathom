import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { createElement, isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { SaveBanner } from './SaveBanner';

const WORDS = 'Showing the design just after Today 14:02 · what changed is outlined';

const css = readFileSync(fileURLToPath(new URL('./history.css', import.meta.url)), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

/** What a selector's own rule declares: the first rule that names it alone. */
function ruleOf(selector: string): string {
  const at = css.search(new RegExp(`(^|\\n)${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\{`));
  return at < 0 ? '' : (css.slice(at).split('{')[1]?.split('}')[0] ?? '');
}

type Props = { children?: ReactNode; onClick?: () => void };

/** Every element the banner draws, outermost first. */
function elements(node: ReactNode): ReactElement<Props>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement<Props>(node)) return [];
  return [node, ...elements(node.props.children)];
}

describe('the banner over a save on show', () => {
  const markup = renderToStaticMarkup(createElement(SaveBanner, { words: WORDS, onBack: () => {} }));

  it('says which save is on show, as a status', () => {
    expect(markup).toContain(`<span class="history-banner__words" role="status">${WORDS}</span>`);
  });

  it('has its own Back to now, beside the words and not read out with them', () => {
    const status = markup.indexOf('role="status"');
    const statusEnd = markup.indexOf('</span>', status);
    const button = markup.indexOf('<button');
    expect(status).toBeGreaterThan(0);
    expect(button).toBeGreaterThan(statusEnd);
    expect(markup.slice(button)).toMatch(/^<button type="button"[^>]*>Back to now<\/button>/);
    // One status, and it is not the banner itself: the button's words are no part of what is said.
    expect(markup.match(/role="status"/g)).toHaveLength(1);
    expect(markup).toMatch(/^<div class="history-banner" data-testid="history-banner">/);
  });

  it('its button leaves the save', () => {
    let left = 0;
    const drawn = elements(SaveBanner({ words: WORDS, onBack: () => (left += 1) }));
    const buttons = drawn.filter((el) => el.type === 'button');
    expect(buttons).toHaveLength(1);
    buttons[0]!.props.onClick?.();
    expect(left).toBe(1);
  });

  it('lets a press on its words through to the drawing, and takes one on its button', () => {
    expect(ruleOf('.history-banner')).toMatch(/pointer-events:\s*none/);
    expect(ruleOf('.history-banner__words')).not.toMatch(/pointer-events/);
    expect(ruleOf('.history-banner__back')).toMatch(/pointer-events:\s*auto/);
  });

  it('keeps the button whole where the words go over two lines', () => {
    expect(ruleOf('.history-banner')).toMatch(/flex-wrap:\s*wrap/);
    expect(ruleOf('.history-banner__back')).toMatch(/flex:\s*none/);
    expect(ruleOf('.history-banner__back')).toMatch(/white-space:\s*nowrap/);
  });
});
