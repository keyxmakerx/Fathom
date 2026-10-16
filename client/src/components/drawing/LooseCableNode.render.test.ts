import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { NodeProps } from '@xyflow/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { FAR_END_UNKNOWN, LooseCableNode, NEEDS_FINISHING, looseCableNodeId, type LooseCableNodeData, type LooseCableNodeType } from './LooseCableNode';
import { BELL_ANGLES_DEG, BELL_CYCLE_S, CRAWL_PERIOD_S, MISSING_MARK_CLASS, MISSING_MARK_PX, stretchDashes } from './looseEnd';
import { cableLooseEnds } from './missingLinks';
import { NEEDS_A, UNKNOWN_A, missingLinksView } from './missingLinksFixture';

function render(over: Partial<LooseCableNodeData> & Pick<LooseCableNodeData, 'state'>): string {
  const cable = missingLinksView().cables.find((c) => c.id === (over.state === 'needs-finishing' ? NEEDS_A : UNKNOWN_A))!;
  const data: LooseCableNodeData = { cable, dir: 1, selected: false, onSelect: () => {}, ...over };
  return renderToStaticMarkup(createElement(LooseCableNode, { data } as unknown as NodeProps<LooseCableNodeType>));
}

afterEach(() => vi.unstubAllGlobals());

describe('Unknown: the line fades out and says nothing moves', () => {
  const html = render({ state: 'unknown' });

  it('draws one line with a linear opacity gradient over the last stretch', () => {
    expect(html).toContain('data-loose-state="unknown"');
    expect(html).toContain('<linearGradient');
    expect(html).toContain('stop-opacity="1"');
    expect(html).toContain('stop-opacity="0"');
    expect(html).toContain('stroke="url(#loose-fade-');
  });

  it('says "Far end unknown" on hover, draws no dashes, no circle and no ?', () => {
    expect(html).toContain(`<title>${FAR_END_UNKNOWN}</title>`);
    expect(FAR_END_UNKNOWN).toBe('Far end unknown');
    expect(html).not.toContain('loose-dashes');
    expect(html).not.toContain('<circle');
    expect(html).not.toContain(MISSING_MARK_CLASS);
    expect(html).not.toContain('--caution');
  });
});

describe('Needs finishing: slanted amber dashes, a circle and a swinging ?', () => {
  const html = render({ state: 'needs-finishing' });

  it('draws every dash of the stretch in the caution colour, inside a clip', () => {
    expect(html).toContain('data-loose-state="needs-finishing"');
    expect(html).toContain('data-testid="loose-dashes"');
    expect(html.match(/<polygon /g)).toHaveLength(stretchDashes(1).length);
    expect(html).toContain('fill="var(--caution)"');
    expect(html).toContain('<clipPath');
    expect(html).toContain('drawing-loose__dashes--down');
    expect(html).not.toContain('stop-opacity');
  });

  it('crawls the other way when the line runs up', () => {
    expect(render({ state: 'needs-finishing', dir: -1 })).toContain('drawing-loose__dashes--up');
  });

  it('puts a circle (r=12, caution wash, caution stroke) in the stretch, holding a bold ? at the one size', () => {
    expect(html).toContain('<circle');
    expect(html).toContain('r="12"');
    expect(html).toContain('fill="var(--caution-wash)"');
    expect(html).toContain('stroke="var(--caution)"');
    expect(html).toContain(`class="${MISSING_MARK_CLASS}"`);
    expect(html).toContain(`font-size="${MISSING_MARK_PX}"`);
    expect(html).toMatch(/<text[^>]*>\?<\/text>/);
  });

  it('swings the ? (its own group), not the circle', () => {
    const mark = html.slice(html.indexOf(`class="${MISSING_MARK_CLASS}"`));
    expect(mark).toContain('missing-mark__swing');
    expect(html.slice(html.indexOf('<circle'), html.indexOf(`class="${MISSING_MARK_CLASS}"`))).not.toContain('missing-mark__swing');
  });

  it('says Needs finishing on hover, and is not marked still', () => {
    expect(html).toContain(`<title>${NEEDS_FINISHING}</title>`);
    expect(html).not.toContain('drawing-loose--still');
  });
});

describe('reduced motion', () => {
  it('marks the node still when the person asked for less motion', () => {
    vi.stubGlobal('window', { matchMedia: () => ({ matches: true }) });
    expect(render({ state: 'needs-finishing' })).toContain('drawing-loose--still');
    expect(render({ state: 'unknown' })).toContain('drawing-loose--still');
  });

  const css = readFileSync(fileURLToPath(new URL('../../styles/missing-links.css', import.meta.url)), 'utf8');

  it('animates only when the node is not still, and stops both animations under prefers-reduced-motion', () => {
    expect(css).toMatch(/\.drawing-loose--needs:not\(\.drawing-loose--still\) \.missing-mark__swing\s*\{\s*animation:/);
    expect(css).toMatch(/\.drawing-loose--needs:not\(\.drawing-loose--still\) \.drawing-loose__dashes--down\s*\{\s*animation:/);
    const reduced = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'));
    expect(reduced).toContain('.missing-mark__swing');
    expect(reduced).toContain('.drawing-loose__dashes');
    expect(reduced).toMatch(/animation:\s*none/);
  });

  it('keeps the styles in step with the numbers: the bell, the cycle and the crawl', () => {
    expect(css).toContain(`--missing-mark-cycle: ${BELL_CYCLE_S}s`);
    expect(css).toContain(`--missing-crawl-time: ${CRAWL_PERIOD_S.toFixed(3)}s`);
    const bell = css.slice(css.indexOf('@keyframes missing-mark-bell'), css.indexOf('.drawing-loose--needs:not(.drawing-loose--still) .drawing-loose__dashes--down'));
    const angles = [...bell.matchAll(/rotate\((-?\d+)deg\)/g)].map((m) => Number(m[1]));
    // Rest, then the swing in order, then rest: the last 30% of the cycle holds all five swings.
    expect(angles).toEqual([0, ...BELL_ANGLES_DEG.slice(0, 5), 0]);
    expect(bell).toMatch(/0%, 70% \{ transform: rotate\(0deg\)/);
  });
});

describe('the node id', () => {
  it('is derived from the cable, so Go can find it', () => {
    expect(looseCableNodeId('cable-1')).toBe('loose:cable-1');
  });
});

describe('what the drawing draws', () => {
  it('has a node for each loose end the detection finds (and nothing for a whole cable)', () => {
    const ids = cableLooseEnds(missingLinksView()).map((e) => looseCableNodeId(e.id));
    expect(ids).toHaveLength(4);
  });
});
