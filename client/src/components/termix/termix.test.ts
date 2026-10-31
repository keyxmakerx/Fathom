import { describe, expect, it } from 'vitest';

import { addHost, bareAddress, folderFor, isHostAddress, sendHosts, sendSummary, isTermixKey, listHosts, matchHost, newHostBody, readKey, sameHostName, saveKey, forgetKey, terminalUrl, TermixError } from './termix';

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

  it('sends Termix only an IP address or a host name', () => {
    for (const ok of ['10.0.0.1', '10.0.0.1/24', '[fd00::1]', 'fe80::1', '2001:db8:0:0:0:0:0:1', '::ffff:10.0.0.1', 'switch1.lan', 'core-sw1', 'SW1.Example.COM'])
      expect(isHostAddress(ok), ok).toBe(true);
    for (const bad of ['', '  ', '999.1.1.1', 'a b', 'host;rm -rf', '-sw1', 'sw1-', 'evil.example/path', 'user@host', 'host:22', '1::2::3', '<img src=x>', 'javascript:alert(1)', 'a'.repeat(254)])
      expect(isHostAddress(bad), bad).toBe(false);
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

  it('asks before opening a host whose own name is not the device (sign-off r61)', () => {
    const host = { id: 4, name: 'Core-SW1 ', ip: '10.0.0.1', port: 22 };
    expect(sameHostName(host, 'core-sw1')).toBe(true);
    expect(sameHostName(host, 'payroll-db')).toBe(false);
    expect(sameHostName({ ...host, name: '10.0.0.1' }, 'core-sw1')).toBe(false);
    expect(sameHostName(host, '  ')).toBe(false);
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

describe('sending many devices', () => {
  it('files a design under Fathom, without letting its name add a level', () => {
    expect(folderFor('HQ network')).toBe('Fathom / HQ network');
    expect(folderFor('A/B')).toBe('Fathom / A - B');
    expect(folderFor('  ')).toBe('Fathom');
  });

  it('adds only what Termix lacks, once per address, into the design folder', async () => {
    const posted: Record<string, unknown>[] = [];
    let id = 100;
    const f = (async (_url: string, init: RequestInit) => {
      if (init.method === 'GET') return new Response(JSON.stringify([{ id: 1, name: 'old', ip: '10.0.0.1', port: 22 }]), { status: 200 });
      const body = JSON.parse(init.body as string) as Record<string, unknown>;
      posted.push(body);
      if (body.ip === '10.0.0.4') return new Response('{}', { status: 500 });
      return new Response(JSON.stringify({ ...body, id: ++id }), { status: 200 });
    }) as unknown as typeof fetch;
    const steps: number[] = [];
    const r = await sendHosts(
      ORIGIN,
      KEY,
      [
        { name: 'core', address: '10.0.0.1' },
        { name: 'a', address: '10.0.0.2/24' },
        { name: 'a-twin', address: '10.0.0.2' },
        { name: 'none', address: '' },
        { name: 'bad', address: '10.0.0.4' },
        { name: 'typed', address: 'evil.example/path' },
      ],
      'Fathom / HQ',
      f,
      (done) => steps.push(done),
    );
    expect(r).toEqual({ added: 1, already: 1, repeated: 1, failed: ['bad: Termix answered 500.', 'typed: not an IP address or host name'] });
    expect(posted.map((b) => b.ip)).toEqual(['10.0.0.2', '10.0.0.4']);
    expect(posted[0]!.folder).toBe('Fathom / HQ');
    expect(steps).toEqual([1, 2, 3, 4, 5]);
    expect(sendSummary(r)).toBe(
      'Added 1 to Termix; 1 was already there; 1 shared an address with another device; 2 not added (bad: Termix answered 500.; typed: not an IP address or host name).',
    );
  });

  it('stops when the key is refused', async () => {
    await expect(sendHosts(ORIGIN, KEY, [{ name: 'a', address: '10.0.0.2' }], 'Fathom', answering(401, {}))).rejects.toThrow(/refused the API key/);
  });
});
