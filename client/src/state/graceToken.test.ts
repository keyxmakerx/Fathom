import { afterEach, describe, expect, it } from 'vitest';

import { clearGraceToken, graceTokenFor, setGraceToken } from './graceToken';

afterEach(() => clearGraceToken());

describe('graceToken', () => {
  it('gives the token back only for the session it was set for', () => {
    const token = new Uint8Array([1, 2, 3]);
    setGraceToken('session-a', token);
    expect(graceTokenFor('session-a')).toBe(token);
    expect(graceTokenFor('session-b')).toEqual(new Uint8Array(0));
  });

  it('is empty when nothing was ever set', () => {
    expect(graceTokenFor('session-a')).toEqual(new Uint8Array(0));
  });

  it('a later sign-in replaces the earlier token', () => {
    setGraceToken('session-a', new Uint8Array([1]));
    setGraceToken('session-b', new Uint8Array([2]));
    expect(graceTokenFor('session-a')).toEqual(new Uint8Array(0));
    expect(graceTokenFor('session-b')).toEqual(new Uint8Array([2]));
  });

  it('clearing forgets it, so a stale token is never offered after sign-out', () => {
    setGraceToken('session-a', new Uint8Array([1]));
    clearGraceToken();
    expect(graceTokenFor('session-a')).toEqual(new Uint8Array(0));
  });
});
