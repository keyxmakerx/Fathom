import { describe, expect, it } from 'vitest';

import { CHECK_FOLDER, fetchCheck } from './fetchCheck';

const KEY = 'tmx_' + 'b'.repeat(64);
const ORIGIN = 'https://t.example';

function termix(opts: { tamper?: boolean; execStatus?: number } = {}) {
  const calls: string[] = [];
  const bodies: unknown[] = [];
  let content = '';
  const f = (async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname;
    calls.push(`${init.method} ${path}`);
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    bodies.push(body);
    if (path.endsWith('/folders')) return new Response('{}', { status: 409 });
    if (path === '/plugin-api/snippets' && init.method === 'POST') {
      content = body.content;
      return new Response(JSON.stringify({ id: 41, ...body }), { status: 201 });
    }
    if (path === '/plugin-api/snippets/41' && init.method === 'GET') return new Response(JSON.stringify({ id: 41, content: opts.tamper ? 'reload' : content }), { status: 200 });
    if (path === '/plugin-api/snippets/execute') {
      const s = opts.execStatus ?? 200;
      return new Response(JSON.stringify(s === 200 ? { success: true, output: 'Junos: 23.4R2-S3.9\n' } : { error: 'Authentication failed for admin@192.0.2.1', code: 'SSH_AUTH_FAILED' }), { status: s });
    }
    if (init.method === 'DELETE') return new Response('{"success":true}', { status: 200 });
    return new Response('{}', { status: 404 });
  }) as unknown as typeof fetch;
  return { f, calls, bodies };
}

describe('Fetch from Termix', () => {
  it('makes a snippet of exactly the command, reads it back, runs it on that host, and deletes it', async () => {
    const t = termix();
    const got = await fetchCheck(ORIGIN, KEY, 'junos-ex', 7, 'show version', t.f);
    expect(got).toEqual({ output: 'Junos: 23.4R2-S3.9\n', failed: false });
    expect(t.calls).toEqual([
      'POST /plugin-api/snippets/folders',
      'POST /plugin-api/snippets',
      'GET /plugin-api/snippets/41',
      'POST /plugin-api/snippets/execute',
      'DELETE /plugin-api/snippets/41',
    ]);
    expect(t.bodies[1]).toMatchObject({ content: 'show version', folder: CHECK_FOLDER, hostFilter: [7] });
    expect(t.bodies[3]).toEqual({ snippetId: 41, hostId: 7 });
  });

  it('refuses a command off the read-only list before anything is sent', async () => {
    const t = termix();
    await expect(fetchCheck(ORIGIN, KEY, 'ios-xe', 7, 'show running-config | redirect flash:x', t.f)).rejects.toThrow(/not a display filter/);
    await expect(fetchCheck(ORIGIN, KEY, 'ios-xe', 7, 'reload', t.f)).rejects.toThrow(/not on the read-only list/);
    expect(t.calls).toEqual([]);
  });

  it('does not run a snippet that changed after Fathom made it, and still deletes it', async () => {
    const t = termix({ tamper: true });
    await expect(fetchCheck(ORIGIN, KEY, 'junos-ex', 7, 'show version', t.f)).rejects.toThrow(/changed before it ran/);
    expect(t.calls).not.toContain('POST /plugin-api/snippets/execute');
    expect(t.calls[t.calls.length - 1]).toBe('DELETE /plugin-api/snippets/41');
  });

  it('says Termix’s own words when the device refused it, and still deletes the snippet', async () => {
    const t = termix({ execStatus: 422 });
    await expect(fetchCheck(ORIGIN, KEY, 'junos-ex', 7, 'show version', t.f)).rejects.toThrow('Authentication failed for admin@192.0.2.1');
    expect(t.calls[t.calls.length - 1]).toBe('DELETE /plugin-api/snippets/41');
  });
});
