import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import type { EstateHit } from '../../api/estate';
import type { TraceHop, TraceResult } from '../../engine/engine';
import { elsewhereHits, unreachedAddress } from './traceElsewhere';
import { TracePanel } from './TracePanel';
import type { TraceController } from './useTraceController';

const hop = (n: number, kind: TraceHop['kind']): TraceHop => ({ n, kind, title: 'edge-fw', detail: [], nodes: [], why: '', source: '', scope: '', policies: [], unplaced: [], unplacedWhy: '' });
const result = (to: string, kinds: TraceHop['kind'][]): TraceResult => ({ from: 'device:A', to, flow: '', stopped: kinds.includes('end') ? '' : 'the path leaves the design', hops: kinds.map((k, i) => hop(i + 1, k)) });

const hit = (over: Partial<EstateHit>): EstateHit => ({
  design: 'd-branch',
  designName: 'Branch',
  element: 'device:N',
  open: 'chassis:N',
  kind: 'device',
  name: 'nas-01',
  model: 'RS822+',
  serial: '',
  device: '',
  place: '',
  addresses: ['10.8.0.5'],
  ports: [],
  ...over,
});

describe('an address held in another site', () => {
  it('is asked only for an address the walk did not reach', () => {
    expect(unreachedAddress(result('10.8.0.5', ['start', 'device', 'stop']))).toBe('10.8.0.5');
    expect(unreachedAddress(result('10.8.0.5', ['start', 'end']))).toBeNull();
    expect(unreachedAddress(result('device:B', ['start', 'stop']))).toBeNull();
    expect(unreachedAddress(null)).toBeNull();
  });

  it('keeps devices in other designs that hold exactly that address', () => {
    const hits = [
      hit({}),
      hit({ design: 'd-here', name: 'here-box' }),
      hit({ name: 'near-miss', addresses: ['10.8.0.50'] }),
      hit({ kind: 'spare', name: 'a spare' }),
      hit({ design: 'd-dc', designName: null, name: 'core' }),
    ];
    expect(elsewhereHits(hits, 'd-here', '10.8.0.5').map((h) => `${h.site}/${h.device}`)).toEqual(['another site/core', 'Branch/nas-01']);
  });

  it('is said in the panel with a way to open it there', () => {
    const r = result('10.8.0.5', ['start', 'device', 'stop']);
    const controller = { from: { deviceId: 'device:A', label: 'edge-fw' }, result: r, query: '10.8.0.5', target: null, flowText: '', error: '', suggestions: [] } as unknown as TraceController;
    const html = renderToStaticMarkup(
      createElement(TracePanel, { controller, elsewhere: { address: '10.8.0.5', hits: elsewhereHits([hit({})], 'd-here', '10.8.0.5'), behind: 0 } }),
    );
    expect(html).toContain('10.8.0.5 is on nas-01 in Branch');
    expect(html).toContain('Open it there');
  });
});
