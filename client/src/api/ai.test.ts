import { describe, expect, it } from 'vitest';

import { parseKey, parseOverview, parsePolicy, safeRedirect } from './ai';

describe('AI access responses', () => {
  it('reads which apps may connect, with Claude alone when the server says nothing', () => {
    expect(parsePolicy({ apps: ['claude', 'claude-code', 'nonsense'] }).apps).toEqual(['claude', 'claude-code']);
    expect(parsePolicy({}).apps).toEqual(['claude']);
  });

  it('tells a connector from a helper key, and an unknown app from a known one', () => {
    const base = { id: 'K', version: 1, state: 'on' };
    expect(parseKey({ ...base, kind: 'connector', app: 'claude' })).toMatchObject({ kind: 'connector', app: 'claude' });
    expect(parseKey({ ...base, kind: 'helper', app: 'helper' })).toMatchObject({ kind: 'helper', app: 'helper' });
    expect(parseKey({ ...base, app: 'something-new' })).toMatchObject({ kind: 'helper', app: 'helper' });
  });

  it('carries the connector address, or null when it is off', () => {
    expect(parseOverview({ connector: 'https://fathom.example/mcp' }).connector).toBe('https://fathom.example/mcp');
    expect(parseOverview({ connector: null }).connector).toBeNull();
  });
});

describe('where a sign-in may send the browser', () => {
  it('is https anywhere, or http on this computer only', () => {
    expect(safeRedirect('https://claude.ai/api/mcp/auth_callback?code=x')).toBe(true);
    expect(safeRedirect('http://localhost:53682/callback?code=x')).toBe(true);
    expect(safeRedirect('http://127.0.0.1:9/cb')).toBe(true);
    expect(safeRedirect('http://evil.example/cb')).toBe(false);
    expect(safeRedirect('javascript:alert(1)')).toBe(false);
    expect(safeRedirect('not a url')).toBe(false);
  });
});
