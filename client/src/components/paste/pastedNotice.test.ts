import { describe, expect, it } from 'vitest';

import type { CaptureLine } from '../../document/capture';
import { countsOfCapture, pastedNotice } from './pastedNotice';

function line(o: Partial<CaptureLine> & Pick<CaptureLine, 'ordinal'>): CaptureLine {
  return { text: '', mark: 'kept', builtLabel: null, builtInterface: false, drops: [], ...o };
}

describe('pastedNotice', () => {
  it('names the device and counts, with the gate only when it destroyed something', () => {
    expect(pastedNotice({ hostname: 'sw-01', lines: 120, interfaces: 24, destroyed: 3 })).toBe(
      'Config pasted onto sw-01: 120 lines, 24 interfaces; 3 values destroyed at the gate.',
    );
    expect(pastedNotice({ lines: 1, interfaces: 1, destroyed: 0 })).toBe('Config pasted: 1 line, 1 interface.');
  });

  it('counts each interface once and every destroyed value', () => {
    const counts = countsOfCapture({
      id: 'c',
      platform: 'ios',
      lineCount: 4,
      lines: [
        line({ ordinal: 1, mark: 'built', builtLabel: 'Gi0/1', builtInterface: true }),
        line({ ordinal: 2, mark: 'built', builtLabel: 'Gi0/1', builtInterface: true }),
        line({ ordinal: 3, mark: 'built', builtLabel: 'trust' }),
        line({ ordinal: 4, mark: 'destroyed', drops: [{ start: 0, end: 1, label: 'psk' }, { start: 2, end: 3, label: 'hash' }] }),
      ],
    });
    expect(counts).toEqual({ lines: 4, interfaces: 1, destroyed: 2 });
  });
});
