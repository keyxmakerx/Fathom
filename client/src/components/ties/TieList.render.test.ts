import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import type { TiePlan } from '../../document/portTies';
import { TieList } from './TieList';

const noop = () => undefined;
const render = (plan: TiePlan) => renderToStaticMarkup(createElement(TieList, { plan, onTie: noop, onAddPorts: noop, onSkip: noop }));

describe('the tie list', () => {
  it('ticks suggested pairs and puts the rest under Not tied with a picker', () => {
    const html = render({
      deviceId: 'device:1',
      rows: [
        { interfaceId: 'i0', name: 'ge-0/0/0', suggested: 'p0' },
        { interfaceId: 'i9', name: 'ge-0/0/9', suggested: null },
      ],
      ports: [{ id: 'p0', label: 'port 0' }, { id: 'p1', label: 'port 1' }],
      canAddPorts: false,
    });
    expect(html).toContain('Tie 2 interfaces to ports');
    expect(html).toMatch(/<input type="checkbox" checked=""\/> <span class="ties__name">ge-0\/0\/0<\/span> ⇄ port 0/);
    expect(html).toContain('Not tied');
    expect(html).toContain('aria-label="Port for ge-0/0/9"');
    // The suggested port is not offered twice.
    expect(html).not.toMatch(/<option value="p0">/);
    expect(html).toContain('Tie 1 interface');
    expect(html).toContain('Not now');
  });

  it('offers ports from the config on a drawn device with none', () => {
    const html = render({ deviceId: 'device:1', rows: [{ interfaceId: 'i0', name: 'eth0', suggested: null }], ports: [], canAddPorts: true });
    expect(html).toContain('Add 1 port from this config');
    expect(html).not.toContain('<select');
  });
});
