import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { MissingLinksChip, MissingLinksList } from './MissingLinksChip';
import { missingLinksOf } from './missingLinks';
import { NEEDS_A, NEEDS_B, UNKNOWN_A, missingLinksView } from './missingLinksFixture';

const noop = () => {};

describe('the bar button', () => {
  it('reads "Missing links · N", counting only Needs finishing', () => {
    const html = renderToStaticMarkup(createElement(MissingLinksChip, { found: missingLinksOf(missingLinksView()), onGo: noop }));
    expect(html).toContain('Missing links · 2');
    expect(html).toContain('aria-label="Missing links, 2"');
    expect(html).toContain('data-testid="missing-links-chip"');
  });

  it('is hidden when nothing needs finishing, even with unknown loose ends in the drawing', () => {
    const view = missingLinksView();
    const found = missingLinksOf({ ...view, cables: view.cables.map((c) => ({ ...c, needsFinishing: false })) });
    expect(found.unknown.length).toBeGreaterThan(0);
    expect(renderToStaticMarkup(createElement(MissingLinksChip, { found, onGo: noop }))).toBe('');
  });

  it('is hidden on a drawing with no cables', () => {
    const found = missingLinksOf({ ...missingLinksView(), cables: [] });
    expect(renderToStaticMarkup(createElement(MissingLinksChip, { found, onGo: noop }))).toBe('');
  });
});

describe('the list', () => {
  const html = renderToStaticMarkup(createElement(MissingLinksList, { found: missingLinksOf(missingLinksView()), onGo: noop }));

  it('has one row per Needs finishing cable, worded "device port → (no far end)", each with a Go', () => {
    const upper = html.slice(0, html.indexOf('data-testid="missing-links-unknown"'));
    expect(upper.match(/data-testid="missing-links-row"/g)).toHaveLength(2);
    expect(upper).toContain('sw-01 3 → (no far end)');
    expect(upper).toContain('sw-02 10 → (no far end)');
    expect(upper.match(/>Go</g)).toHaveLength(2);
    expect(upper).toContain(`data-cable-id="${NEEDS_A}"`);
    expect(upper).toContain(`data-cable-id="${NEEDS_B}"`);
    expect(upper).toContain('to patch panel');
  });

  it('says it was found by Fathom from the drawing, nothing typed', () => {
    expect(html).toContain('Found by Fathom from the drawing. Nothing here is typed.');
    expect(html).toContain('Missing links · 2');
  });

  it('folds the Unknown ones below, closed, with their own count, apart from the rows above', () => {
    const at = html.indexOf('data-testid="missing-links-unknown"');
    expect(at).toBeGreaterThan(html.indexOf('data-testid="missing-links-row"'));
    const folded = html.slice(at);
    expect(folded).toContain('<summary>Unknown (2)</summary>');
    expect(folded).toContain(`data-cable-id="${UNKNOWN_A}"`);
    expect(folded).not.toContain(`data-cable-id="${NEEDS_A}"`);
    expect(html.slice(html.lastIndexOf('<details'), at + 40)).not.toContain(' open');
    expect(folded).toContain('not counted');
  });

  it('leaves the Unknown section out when there are none', () => {
    const view = missingLinksView();
    const found = missingLinksOf({ ...view, cables: view.cables.filter((c) => c.needsFinishing === true) });
    expect(renderToStaticMarkup(createElement(MissingLinksList, { found, onGo: noop }))).not.toContain('Unknown (');
  });
});
