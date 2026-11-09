import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../api/cableViews', () => ({
  fetchCableView: vi.fn(),
  putCableView: vi.fn(),
}));

import { fetchCableView, putCableView } from '../../api/cableViews';
import { cableGroupsStorageKey, type StoredCableGroupsState } from './cableGroups';
import { loadCableView, peekCableView, resetCableViewStoreForTests, storeCableView } from './cableViewStore';

const fetchMock = vi.mocked(fetchCableView);
const putMock = vi.mocked(putCableView);

const store = new Map<string, string>();
const fakeStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
};

const fibre: StoredCableGroupsState = { groups: [{ ref: { kind: 'type', type: 'fibre' }, on: true }], none: false, hiddenCableIds: [] };
const hidden: StoredCableGroupsState = { groups: [], none: false, hiddenCableIds: ['cable:1'] };

beforeEach(() => {
  vi.stubGlobal('localStorage', fakeStorage);
  store.clear();
  fetchMock.mockReset();
  putMock.mockReset();
  resetCableViewStoreForTests();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('the Cables list on the server', () => {
  it("the server's list wins, and the browser copy is cleared", async () => {
    store.set(cableGroupsStorageKey('d1'), JSON.stringify(hidden));
    fetchMock.mockResolvedValueOnce(fibre);
    expect(await loadCableView('o1', 'd1')).toEqual({ state: fibre, server: true });
    expect(store.has(cableGroupsStorageKey('d1'))).toBe(false);
    expect(putMock).not.toHaveBeenCalled();
    expect(peekCableView('o1', 'd1')).toEqual(fibre);
  });

  it("with nothing on the server, the browser's list is sent up once and cleared", async () => {
    store.set(cableGroupsStorageKey('d1'), JSON.stringify(hidden));
    fetchMock.mockResolvedValueOnce(null);
    putMock.mockResolvedValueOnce(undefined);
    expect(await loadCableView('o1', 'd1')).toEqual({ state: hidden, server: true });
    expect(putMock).toHaveBeenCalledWith('o1', 'd1', hidden);
    expect(store.has(cableGroupsStorageKey('d1'))).toBe(false);
  });

  it('a browser copy the server refused stays, and saves go on in the browser', async () => {
    store.set(cableGroupsStorageKey('d1'), JSON.stringify(hidden));
    fetchMock.mockResolvedValueOnce(null);
    putMock.mockRejectedValueOnce(new Error('offline'));
    expect(await loadCableView('o1', 'd1')).toEqual({ state: hidden, server: false });
    expect(store.has(cableGroupsStorageKey('d1'))).toBe(true);
  });

  it('nothing anywhere reads as null, ready for the default', async () => {
    fetchMock.mockResolvedValueOnce(null);
    expect(await loadCableView('o1', 'd1')).toEqual({ state: null, server: true });
  });

  it('a server that cannot be reached falls back to the browser', async () => {
    store.set(cableGroupsStorageKey('d1'), JSON.stringify(hidden));
    fetchMock.mockRejectedValueOnce(new Error('offline'));
    expect(await loadCableView('o1', 'd1')).toEqual({ state: hidden, server: false });
  });

  it('a damaged answer from the server is not drawn', async () => {
    fetchMock.mockResolvedValueOnce({ groups: 'nope' });
    expect(await loadCableView('o1', 'd1')).toEqual({ state: null, server: true });
  });

  it('saves wait for the last click and send only the latest list', () => {
    vi.useFakeTimers();
    putMock.mockResolvedValue(undefined);
    storeCableView('o1', 'd1', hidden, true);
    storeCableView('o1', 'd1', fibre, true);
    expect(putMock).not.toHaveBeenCalled();
    expect(peekCableView('o1', 'd1')).toEqual(fibre);
    vi.advanceTimersByTime(700);
    expect(putMock).toHaveBeenCalledTimes(1);
    expect(putMock).toHaveBeenCalledWith('o1', 'd1', fibre);
    expect(store.size).toBe(0);
  });

  it('with no organisation, the list is kept in the browser as before', () => {
    storeCableView(null, 'd1', fibre, false);
    expect(putMock).not.toHaveBeenCalled();
    expect(JSON.parse(store.get(cableGroupsStorageKey('d1')) ?? 'null')).toEqual(fibre);
    expect(peekCableView(null, 'd1')).toEqual(fibre);
  });
});
