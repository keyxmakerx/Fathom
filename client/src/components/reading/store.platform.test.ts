import { afterEach, describe, expect, it, vi } from 'vitest';

import type { EditorChange } from '../drawing';
import { setDeviceField } from '../../document/edit';
import { emptyDocument } from '../../document/model';
import { addBox, eth, tick } from '../troubleshoot/fixtures';

vi.mock('../../api/deviceRead', async (orig) => ({
  ...(await orig<typeof import('../../api/deviceRead')>()),
  readDevice: vi.fn(async () => ({ outcome: 'read', id: 'c1' })),
  fetchReadingPanel: vi.fn(async () => ({ readings: [], configs: [], macArp: null, macArpChanges: null, dismissed: [] })),
}));

const { readDevice } = await import('../../api/deviceRead');
const { chooseSshPlatform, resetReadingStore, runRead, seedReading } = await import('./store');

afterEach(() => {
  resetReadingStore();
  vi.mocked(readDevice).mockClear();
});

describe('a platform chosen for a hand-drawn device (sign-off r108, question 1)', () => {
  const drawn = () => {
    const { doc, box } = addBox(emptyDocument(), 'srx-lab', eth(8));
    return { doc: setDeviceField(doc, box.device, 'management_address', '10.20.0.21', tick()), device: box.device };
  };

  it('is kept in the design as an ordinary change once a read with it succeeds', async () => {
    const { doc, device } = drawn();
    const edits: EditorChange[] = [];
    const place = { organisation: 'o', design: 'd', doc, canDraw: true, onEdit: (c: EditorChange) => void edits.push(c) };
    seedReading('d', device, {});
    chooseSshPlatform(place, device, 'junos-srx');
    await runRead(place, device, 'config', 'L1', null);
    expect(vi.mocked(readDevice).mock.calls[0]![2]).toMatchObject({ kind: 'config', platform: 'junos-srx' });
    expect(edits).toEqual([{ kind: 'device', id: device, field: 'platform', value: 'junos-srx' }]);
  });

  it('is not written when the read fails, or for a device that already says its platform', async () => {
    const { doc, device } = drawn();
    const edits: EditorChange[] = [];
    const place = { organisation: 'o', design: 'd', doc, canDraw: true, onEdit: (c: EditorChange) => void edits.push(c) };
    vi.mocked(readDevice).mockResolvedValueOnce({ outcome: 'failed', code: 'login_refused', message: 'x', identity: null, previous: null });
    seedReading('d', device, {});
    chooseSshPlatform(place, device, 'junos-srx');
    await runRead(place, device, 'config', 'L1', null);
    expect(edits).toEqual([]);

    const named = setDeviceField(doc, device, 'platform', 'eos', tick());
    await runRead({ ...place, doc: named }, device, 'config', 'L1', null);
    expect(edits).toEqual([]);
  });
});
