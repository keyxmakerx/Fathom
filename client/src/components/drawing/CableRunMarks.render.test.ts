import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import type { CableRunView } from '../../document/cableRuns';
import { CableRunActionsContext, CableRunMarks } from './CableRunMarks';

const runs: CableRunView[] = [
  { id: 'run-l', hostId: 'r1', form: 'lacing_bar', side: 'left', label: null, ties: [{ id: 'tie-1', at: 250, cableIds: ['c1', 'c2'] }] },
  { id: 'run-t', hostId: 'r1', form: 'tray', side: 'top', label: 'Top tray', ties: [] },
];
const box = { x: 0, y: 0, width: 300, headerPx: 16, frameHeight: 400 };

describe('cable runs on a rack', () => {
  it('draws each run beside the frame, with its ties', () => {
    const html = renderToStaticMarkup(createElement(CableRunMarks, { runs, box }));
    expect(html).toContain('drawing-run--lacing_bar');
    expect(html).toContain('drawing-run--tray');
    expect(html).toContain('title="Lacing bar, left"');
    expect(html).toContain('title="Top tray"');
    expect(html).toContain('aria-label="Cable tie holding 2 cables"');
    // A quarter of the way down a 400px bar.
    expect(html).toMatch(/data-tie-id="tie-1"[^>]*top:98\.5px/);
  });
  it('lets a tie move only for someone who may edit', () => {
    expect(renderToStaticMarkup(createElement(CableRunMarks, { runs, box }))).not.toContain('drawing-run__tie--movable');
    const actions = { moveTie: () => {}, removeTie: () => {} };
    const html = renderToStaticMarkup(createElement(CableRunActionsContext.Provider, { value: actions }, createElement(CableRunMarks, { runs, box })));
    expect(html).toContain('drawing-run__tie--movable');
  });
  it('draws nothing for a rack with no runs', () => {
    expect(renderToStaticMarkup(createElement(CableRunMarks, { runs: [], box }))).toBe('');
  });
});
