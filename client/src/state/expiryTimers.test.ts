import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ActiveSession } from './sessionState';

// The module keeps its `installed` flag for the life of the module, so each
// test loads a fresh copy after faking the clock.
async function install(): Promise<void> {
  vi.resetModules();
  const mod = await import('./expiryTimers');
  mod.installExpiryTimers();
}

const NOW_MS = 1_790_000_000_000;

function session(kind: 'steward' | 'operator', expiresAtUnix: number, sessionId = `${kind}-1`): ActiveSession {
  return {
    kind,
    sessionId,
    token: new Uint8Array(32),
    sessionKeyPair: {} as CryptoKeyPair,
    expiresAtUnix,
    address: `${kind}@example.com`,
    accountId: '01JXACCOUNT000000000000001',
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW_MS);
});

afterEach(async () => {
  const state = await import('./sessionState');
  state.setSession(null);
  vi.useRealTimers();
});

describe('expiryTimers', () => {
  it('clears the account session the moment it expires, and its grace token', async () => {
    await install();
    const state = await import('./sessionState');
    const grace = await import('./graceToken');
    state.setSession(session('steward', NOW_MS / 1000 + 60));
    grace.setGraceToken('steward-1', new Uint8Array([7]));
    vi.advanceTimersByTime(59_000);
    expect(state.getSessionOn(state.ACCOUNT_PLANE)).not.toBeNull();
    vi.advanceTimersByTime(1_000);
    expect(state.getSessionOn(state.ACCOUNT_PLANE)).toBeNull();
    expect(grace.graceTokenFor('steward-1')).toEqual(new Uint8Array(0));
  });

  it('clears a session already past its expiry on the next tick', async () => {
    await install();
    const state = await import('./sessionState');
    state.setSession(session('steward', NOW_MS / 1000 - 5));
    expect(state.getSessionOn(state.ACCOUNT_PLANE)).not.toBeNull();
    vi.advanceTimersByTime(0);
    expect(state.getSessionOn(state.ACCOUNT_PLANE)).toBeNull();
  });

  it('ends one plane without touching the other', async () => {
    await install();
    const state = await import('./sessionState');
    state.setSession(session('steward', NOW_MS / 1000 + 600));
    state.setSession(session('operator', NOW_MS / 1000 + 30));
    vi.advanceTimersByTime(30_000);
    expect(state.getSessionOn(state.OPERATOR_PLANE)).toBeNull();
    expect(state.getSessionOn(state.ACCOUNT_PLANE)).not.toBeNull();
  });

  it('follows a replacement session rather than the old expiry', async () => {
    await install();
    const state = await import('./sessionState');
    state.setSession(session('steward', NOW_MS / 1000 + 10, 'first'));
    state.setSession(session('steward', NOW_MS / 1000 + 120, 'second'));
    vi.advanceTimersByTime(10_000);
    expect(state.getSessionOn(state.ACCOUNT_PLANE)?.sessionId).toBe('second');
    vi.advanceTimersByTime(110_000);
    expect(state.getSessionOn(state.ACCOUNT_PLANE)).toBeNull();
  });

  it('a sign-out cancels the timer, and installing twice does not double it', async () => {
    vi.resetModules();
    const mod = await import('./expiryTimers');
    mod.installExpiryTimers();
    mod.installExpiryTimers();
    const state = await import('./sessionState');
    state.setSession(session('steward', NOW_MS / 1000 + 10));
    expect(vi.getTimerCount()).toBe(1);
    state.setSession(null);
    expect(vi.getTimerCount()).toBe(0);
  });
});
