import { describe, expect, it } from 'vitest';

import { addHost, bareAddress, isTermixKey, listHosts, matchHost, newHostBody, readKey, saveKey, forgetKey, terminalUrl, TermixError } from './termix';

const KEY = 'tmx_' + 'a1'.repeat(32);
const ORIGIN = 'https://termix.example.lan';

function memory(): Storage {
  const m = new Map<string, string>();
  return {
    get length() {
      return m.size;
    },
    clear: () => m.clear(),
    getItem: (k) => m.get(k) ?? null,
    key: (i) => [...m.keys()][i] ?? null,
    removeItem: (k) => void m.delete(k),
    setItem: (k, v) => void m.set(k, v),
  };
}

function answering(status: number, body: unknown, seen: { url?: string; init?: RequestInit }[] = []): typeof fetch {
  return (async (url: string, init: RequestInit) => {
    seen.push({ url, init });
    return new Response(JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
}

describe('the Termix key', () => {
  it('is tmx_ and 64 hex characters, as Termix makes it', () => {
    expect(isTermixKey(KEY)).toBe(true);
    expect(isTermixKey(` ${KEY}\n`)).toBe(true);
    expect(isTermixKey('tmx_short')).toBe(false);
    expect(isTermixKey(KEY.replace('tmx_', 'tmy_'))).toBe(false);
  });

  it('is kept, read back and forgotten in the store it is given', () => {
    const s = memory();
    expect(readKey(s)).toBeNull();
    saveKey(` ${KEY} `, s);
    expect(readKey(s)).toBe(KEY);
    forgetKey(s);
    expect(readKey(s)).toBeNull();
  });

  it('is not read back when the store holds something else', () => {
    const s = memory();
    s.setItem('fathom.termix.key', 'not a key');
    expect(readKey(s)).toBeNull();
  });
});

describe('addresses and links', () => {
  it('drops a prefix length and IPv6 brackets', () => {
    expect(bareAddress(' 10.0.0.1/24 ')).toBe('10.0.0.1');
    expect(bareAddress('[fd00::1]')).toBe('fd00::1');
    expect(bareAddress('switch1.lan')).toBe('switch1.lan');
  });

  it('opens the full-screen terminal for one host', () => {
    expect(terminalUrl(ORIGIN, 7)).toBe('https://termix.example.lan/?view=terminal&hostId=7');
  });

  it('prefers the host on port 22 at the same address', () => {
    const hosts = [
      { id: 1, name: 'a', ip: '10.0.0.9', port: 22 },
      { id: 2, name: 'b', ip: '10.0.0.1', port: 2222 },
      { id: 3, name: 'c', ip: '10.0.0.1', port: 22 },
    ];
    expect(matchHost(hosts, '10.0.0.1/24')?.id).toBe(3);
    expect(matchHost(hosts.slice(0, 2), '10.0.0.1')?.id).toBe(2);
    expect(matchHost(hosts, '10.0.0.2')).toBeNull();
  });

  it('adds a host with no password and no user name', () => {
    const body = newHostBody('core-sw1', '10.0.0.1/24');
    expect(body).toEqual({ connectionType: 'ssh', name: 'core-sw1', ip: '10.0.0.1', port: 22, folder: 'Fathom', tags: ['fathom'], notes: 'Added from Fathom.' });
    for (const k of ['password', 'key', 'keyPassword', 'username', 'credentialId', 'sudoPassword']) expect(body).not.toHaveProperty(k);
    expect(newHostBody(' ', '10.0.0.1').name).toBe('10.0.0.1');
  });
});

describe('talking to Termix', () => {
  it('lists hosts with the key as a bearer token and no cookies', async () => {
    const seen: { url?: string; init?: RequestInit }[] = [];
    const hosts = await listHosts(ORIGIN, KEY, answering(200, [{ id: 4, name: 'r1', ip: '10.0.0.4', port: 22 }, { name: 'no id' }], seen));
    expect(hosts).toEqual([{ id: 4, name: 'r1', ip: '10.0.0.4', port: 22 }]);
    expect(seen[0]!.url).toBe('https://termix.example.lan/host/db/host');
    expect(seen[0]!.init!.credentials).toBe('omit');
    expect((seen[0]!.init!.headers as Record<string, string>).Authorization).toBe(`Bearer ${KEY}`);
  });

  it('adds a host and reads back its id', async () => {
    const seen: { url?: string; init?: RequestInit }[] = [];
    const made = await addHost(ORIGIN, KEY, 'r1', '10.0.0.4', answering(200, { id: 12, name: 'r1', ip: '10.0.0.4', port: 22 }, seen));
    expect(made.id).toBe(12);
    expect(seen[0]!.init!.method).toBe('POST');
    expect(JSON.parse(seen[0]!.init!.body as string)).toEqual(newHostBody('r1', '10.0.0.4'));
  });

  it('says in words when the key is refused', async () => {
    await expect(listHosts(ORIGIN, KEY, answering(401, { error: 'Invalid API key' }))).rejects.toThrow(/refused the API key/);
  });

  it('says in words when Termix cannot be reached', async () => {
    const down = (async () => {
      throw new TypeError('Failed to fetch');
    }) as unknown as typeof fetch;
    await expect(listHosts(ORIGIN, KEY, down)).rejects.toBeInstanceOf(TermixError);
  });
});
