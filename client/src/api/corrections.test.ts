import { afterEach, describe, expect, it, vi } from 'vitest';

import * as signed from './signedFetch';
import { decideCorrection, fetchCorrections, sendCorrection } from './corrections';

const reply = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value));
const one = {
  id: '01JCORRECTION000000000000AA', designId: 'd', cable: 'cable:1', kind: 'label', text: 'PP1', sender: 's', senderName: 'Ann',
  createdAt: 5, state: 'open', decidedBy: null, decidedAt: null, version: 1,
};

afterEach(() => vi.restoreAllMocks());

describe('the corrections API', () => {
  it('reads a list and refuses a malformed row', async () => {
    const spy = vi.spyOn(signed, 'signedFetch').mockResolvedValueOnce(reply([one]));
    const list = await fetchCorrections('o', 'd');
    expect(list[0]).toMatchObject({ kind: 'label', text: 'PP1', senderName: 'Ann', decidedBy: null });
    expect(spy).toHaveBeenCalledWith('GET', '/organisations/o/designs/d/corrections');
    vi.spyOn(signed, 'signedFetch').mockResolvedValueOnce(reply([{ ...one, kind: 'delete' }]));
    await expect(fetchCorrections('o', 'd')).rejects.toThrow(/malformed/);
  });

  it('sends canonical JSON, with no text for a traced stamp', async () => {
    const spy = vi.spyOn(signed, 'signedFetch').mockResolvedValue(reply(one));
    await sendCorrection('o', 'd', { cable: 'cable:1', kind: 'traced' });
    const body = new TextDecoder().decode(spy.mock.calls[0]![2] as Uint8Array);
    expect(body).toBe('{"cable":"cable:1","kind":"traced"}\n');
  });

  it('decides with the version it read', async () => {
    const spy = vi.spyOn(signed, 'signedFetch').mockResolvedValue(reply({ ...one, state: 'accepted', version: 2 }));
    const done = await decideCorrection('o', 'd', { id: one.id, version: 1 }, 'accept');
    expect(done.state).toBe('accepted');
    expect(spy.mock.calls[0]![1]).toBe(`/organisations/o/designs/d/corrections/${one.id}/accept`);
    expect(new TextDecoder().decode(spy.mock.calls[0]![2] as Uint8Array)).toBe('{"ifVersion":1}\n');
  });

  it('reopens an accepted correction with the version it read', async () => {
    const spy = vi.spyOn(signed, 'signedFetch').mockResolvedValue(reply({ ...one, state: 'open', version: 3 }));
    const back = await decideCorrection('o', 'd', { id: one.id, version: 2 }, 'reopen');
    expect(back.state).toBe('open');
    expect(spy.mock.calls[0]![1]).toBe(`/organisations/o/designs/d/corrections/${one.id}/reopen`);
    expect(new TextDecoder().decode(spy.mock.calls[0]![2] as Uint8Array)).toBe('{"ifVersion":2}\n');
  });
});
