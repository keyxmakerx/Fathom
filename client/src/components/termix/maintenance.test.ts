import { describe, expect, it } from 'vitest';

import { DEFAULT_MINUTES, hostStatus, setMaintenance, windowMinutes, windowReason, windowSummary } from './maintenance';

const KEY = 'tmx_' + 'a'.repeat(64);
const ORIGIN = 'https://t.example';

/** A Termix stand-in with Automations' answers, as `maintenance-routes.ts` gives them. */
function termix(hosts: Record<number, { owned: boolean; reasons: string[] | null }>) {
  const calls: { method: string; path: string; body: unknown }[] = [];
  const f = (async (url: string, init: RequestInit) => {
    const u = new URL(url);
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method: String(init.method), path: u.pathname + u.search, body });
    const id = Number(u.pathname.split('/').pop());
    const h = hosts[id];
    if (!h) return new Response('{}', { status: 404 });
    if (init.method === 'GET') return new Response(JSON.stringify({ active: h.reasons ? { reasons: h.reasons } : null, plans: [], owned: h.owned }), { status: 200 });
    if (!h.owned) return new Response('{}', { status: 403 });
    h.reasons = body.action === 'start' ? [body.reason] : null;
    return new Response(JSON.stringify({ owned: true }), { status: 200 });
  }) as unknown as typeof fetch;
  return { f, calls };
}

describe('the window', () => {
  it('lasts the plan’s window, within Termix’s 1 to 10080 minutes, and has the plan’s name as its reason', () => {
    expect(windowMinutes('2026-11-01T22:00:00Z', '2026-11-02T00:30:00Z')).toBe(150);
    expect(windowMinutes('2026-11-01T22:00:00Z', '2026-11-30T22:00:00Z')).toBe(10080);
    expect(windowMinutes('', '2026-11-02T00:30:00Z')).toBeNull();
    expect(windowMinutes('2026-11-02T00:30:00Z', '2026-11-01T22:00:00Z')).toBeNull();
    expect(windowReason('Upgrade EX2300 to 23.4R2')).toBe('Fathom: Upgrade EX2300 to 23.4R2');
    expect(windowReason('x'.repeat(300))).toHaveLength(200);
  });

  it('start sends everything Termix requires, and leaves a host already in maintenance alone', async () => {
    const { f, calls } = termix({ 1: { owned: true, reasons: null }, 2: { owned: true, reasons: ['someone else'] }, 3: { owned: false, reasons: null } });
    const r = await setMaintenance(ORIGIN, KEY, [1, 2, 3], { action: 'start', reason: 'Fathom: P' }, f);
    expect(r).toEqual({ done: 1, left: 1, notOwned: 1, failed: 0 });
    const posts = calls.filter((c) => c.method === 'POST');
    expect(posts).toEqual([
      { method: 'POST', path: '/plugin-api/automations/maintenance/1', body: { action: 'start', reason: 'Fathom: P', durationMinutes: DEFAULT_MINUTES, graceMinutes: 0, notifyOverdue: false } },
    ]);
    expect(windowSummary(r, 'start')).toBe(
      'Put 1 device into maintenance in Termix; 1 left as it was, already in maintenance; 1 is shared with you there, so only its owner can.',
    );
  });

  it('end clears only a window whose one reason is the plan’s', async () => {
    const { f, calls } = termix({ 1: { owned: true, reasons: ['Fathom: P'] }, 2: { owned: true, reasons: ['Fathom: P', 'disk swap'] }, 4: { owned: true, reasons: null } });
    const r = await setMaintenance(ORIGIN, KEY, [1, 2, 4], { action: 'end', reason: 'Fathom: P' }, f);
    expect(r).toEqual({ done: 1, left: 2, notOwned: 0, failed: 0 });
    expect(calls.filter((c) => c.method === 'POST').map((c) => c.path)).toEqual(['/plugin-api/automations/maintenance/1']);
  });

  it('a refused key stops the run and says so', async () => {
    const f = (async () => new Response('{}', { status: 401 })) as unknown as typeof fetch;
    await expect(setMaintenance(ORIGIN, KEY, [1], { action: 'start', reason: 'r' }, f)).rejects.toThrow(/refused the API key/);
  });
});

describe('up or down', () => {
  it('reads GET /host/status for the plan’s hosts only, and keeps Termix’s three words', async () => {
    const seen: string[] = [];
    const f = (async (url: string) => {
      seen.push(new URL(url).pathname + new URL(url).search);
      return new Response(JSON.stringify({ 4: { status: 'online', lastChecked: 'x' }, 7: { status: 'offline', lastChecked: 'x' }, 9: { status: 'odd' } }), { status: 200 });
    }) as unknown as typeof fetch;
    const got = await hostStatus(ORIGIN, KEY, [4, 7, 9], f);
    expect(seen).toEqual(['/host/status?hostIds=4,7,9']);
    expect([...got]).toEqual([
      [4, 'online'],
      [7, 'offline'],
    ]);
  });

  it('asks nothing for no hosts', async () => {
    const f = (async () => {
      throw new Error('asked');
    }) as unknown as typeof fetch;
    expect((await hostStatus(ORIGIN, KEY, [], f)).size).toBe(0);
  });
});
