import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ActiveSession } from './sessionState';

// Node has no IndexedDB. This is the smallest stand-in for what tabSessions.ts
// uses: one database, one store with out-of-line keys, put/get/delete, a
// cursor, and transactions that complete on the next tick.
function fakeIndexedDb(): IDBFactory {
  const stores = new Map<string, Map<string, unknown>>();
  const later = (f: () => void) => setTimeout(f, 0);
  function request<T>(run: () => T) {
    const req: { result?: T; error: null; onsuccess: null | (() => void); onerror: null | (() => void) } = { error: null, onsuccess: null, onerror: null };
    later(() => {
      req.result = run();
      req.onsuccess?.();
    });
    return req;
  }
  const db = {
    objectStoreNames: { contains: (n: string) => stores.has(n) },
    createObjectStore: (n: string) => stores.set(n, new Map()),
    close: () => undefined,
    transaction: (name: string) => {
      const data = stores.get(name)!;
      let pending = 0;
      const tx: { oncomplete: null | (() => void); onerror: null | (() => void); error: null; objectStore: () => unknown } = {
        oncomplete: null,
        onerror: null,
        error: null,
        objectStore: () => store,
      };
      const track = <T>(run: () => T) => {
        pending += 1;
        return request(() => {
          const out = run();
          pending -= 1;
          later(() => pending === 0 && tx.oncomplete?.());
          return out;
        });
      };
      const store = {
        put: (v: unknown, k: string) => track(() => void data.set(k, structuredClone(v))),
        get: (k: string) => track(() => data.get(k)),
        delete: (k: string) => track(() => void data.delete(k)),
        openCursor: () => {
          const keys = [...data.keys()];
          let i = 0;
          const req: { result: unknown; onsuccess: null | (() => void); onerror: null } = { result: null, onsuccess: null, onerror: null };
          pending += 1;
          const step = () =>
            later(() => {
              if (i >= keys.length) {
                req.result = null;
                req.onsuccess?.();
                pending -= 1;
                later(() => pending === 0 && tx.oncomplete?.());
                return;
              }
              const key = keys[i];
              req.result = { value: data.get(key), delete: () => data.delete(key), continue: () => { i += 1; step(); } };
              req.onsuccess?.();
            });
          step();
          return req;
        },
      };
      // A transaction with no request still completes.
      later(() => pending === 0 && tx.oncomplete?.());
      return tx;
    },
  };
  return {
    open: () => {
      const req: { result: typeof db; onupgradeneeded: null | (() => void); onsuccess: null | (() => void); onerror: null } = {
        result: db,
        onupgradeneeded: null,
        onsuccess: null,
        onerror: null,
      };
      later(() => {
        if (stores.size === 0) req.onupgradeneeded?.();
        req.onsuccess?.();
      });
      return req;
    },
  } as unknown as IDBFactory;
}

function session(kind: 'steward' | 'operator', expiresAtUnix: number, sessionId = `${kind}-1`): ActiveSession {
  return {
    kind,
    sessionId,
    token: new Uint8Array([1, 2, 3]),
    sessionKeyPair: {} as CryptoKeyPair,
    expiresAtUnix,
    address: `${kind}@example.com`,
    accountId: '01JXACCOUNT000000000000001',
  };
}

async function load() {
  vi.resetModules();
  return import('./tabSessions');
}

afterEach(() => vi.unstubAllGlobals());

describe('tabSessions with IndexedDB', () => {
  beforeEach(() => vi.stubGlobal('indexedDB', fakeIndexedDb()));

  it('saves, reads back and clears this tab\'s account session', async () => {
    const t = await load();
    await t.saveAccountSession('tab-1', session('steward', 2_000_000_000));
    const back = await t.loadAccountSession('tab-1');
    expect(back?.sessionId).toBe('steward-1');
    expect(back?.plane).toBe('account');
    expect(back?.token).toEqual(new Uint8Array([1, 2, 3]));
    expect(await t.loadAccountSession('tab-2')).toBeNull();
    await t.clearAccountSession('tab-1');
    expect(await t.loadAccountSession('tab-1')).toBeNull();
  });

  it('never stores an operator session', async () => {
    const t = await load();
    await expect(t.saveAccountSession('tab-1', session('operator', 2_000_000_000))).rejects.toThrow(/never persisted/);
    expect(await t.loadAccountSession('tab-1')).toBeNull();
  });

  it('touch moves lastUsedUnix forward and leaves a missing record missing', async () => {
    const t = await load();
    vi.spyOn(Date, 'now').mockReturnValue(1_000_000_000_000);
    await t.saveAccountSession('tab-1', session('steward', 2_000_000_000));
    vi.spyOn(Date, 'now').mockReturnValue(1_000_000_060_000);
    await t.touchAccountSession('tab-1');
    expect((await t.loadAccountSession('tab-1'))?.lastUsedUnix).toBe(1_000_000_060);
    await t.touchAccountSession('tab-9');
    expect(await t.loadAccountSession('tab-9')).toBeNull();
    vi.restoreAllMocks();
  });

  it('the sweep deletes records at or past their expiry and keeps the rest', async () => {
    const t = await load();
    await t.saveAccountSession('old', session('steward', 100, 'old'));
    await t.saveAccountSession('edge', session('steward', 200, 'edge'));
    await t.saveAccountSession('live', session('steward', 300, 'live'));
    await t.sweepStaleTabSessions(200);
    expect(await t.loadAccountSession('old')).toBeNull();
    expect(await t.loadAccountSession('edge')).toBeNull();
    expect((await t.loadAccountSession('live'))?.sessionId).toBe('live');
  });
});

describe('tabSessions without storage', () => {
  it('reads nothing and never throws when IndexedDB is missing', async () => {
    vi.stubGlobal('indexedDB', undefined);
    const t = await load();
    await expect(t.saveAccountSession('tab-1', session('steward', 2_000_000_000))).resolves.toBeUndefined();
    expect(await t.loadAccountSession('tab-1')).toBeNull();
    await expect(t.clearAccountSession('tab-1')).resolves.toBeUndefined();
    await expect(t.touchAccountSession('tab-1')).resolves.toBeUndefined();
    await expect(t.sweepStaleTabSessions()).resolves.toBeUndefined();
  });
});

describe('the tab id and its claim', () => {
  it('keeps one id for the page when there is no sessionStorage', async () => {
    const t = await load();
    expect(t.thisTabId()).toMatch(/^[0-9a-f]{32}$/);
    expect(t.thisTabId()).toBe(t.thisTabId());
  });

  it('reads the id back from sessionStorage, as a reload does', async () => {
    const m = new Map<string, string>([['fathom-tab-id', 'a'.repeat(32)]]);
    vi.stubGlobal('sessionStorage', { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) });
    const t = await load();
    expect(t.thisTabId()).toBe('a'.repeat(32));
  });

  it('a copy whose id is already locked mints a fresh id; claiming twice asks once', async () => {
    const m = new Map<string, string>([['fathom-tab-id', 'b'.repeat(32)]]);
    vi.stubGlobal('sessionStorage', { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) });
    const request = vi.fn((_name: string, _opts: unknown, cb: (lock: unknown) => Promise<void>) => cb(null));
    vi.stubGlobal('navigator', { locks: { request } });
    const t = await load();
    const first = await t.claimThisTab();
    expect(first.isCopy).toBe(true);
    expect(first.tabId).not.toBe('b'.repeat(32));
    expect(m.get('fathom-tab-id')).toBe(first.tabId);
    expect(await t.claimThisTab()).toBe(first);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('the first holder keeps its id', async () => {
    const m = new Map<string, string>([['fathom-tab-id', 'c'.repeat(32)]]);
    vi.stubGlobal('sessionStorage', { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) });
    vi.stubGlobal('navigator', { locks: { request: (_n: string, _o: unknown, cb: (lock: unknown) => Promise<void>) => { void cb({}); return Promise.resolve(); } } });
    const t = await load();
    expect(await t.claimThisTab()).toEqual({ tabId: 'c'.repeat(32), isCopy: false });
  });
});
