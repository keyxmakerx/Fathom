import { describe, expect, it } from 'vitest';

import { canonicalUlid, decodeUlid, encodeUlid, isCanonicalUlid, newUlid, UlidError } from './ulid';

describe('encode / decode', () => {
  it('round trips the ulid-spec known vector', () => {
    // The same value `crates/fathom-id/src/lib.rs`'s own test pins.
    const s = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
    expect(encodeUlid(decodeUlid(s))).toBe(s);
  });

  it('zero and max', () => {
    expect(encodeUlid(0n)).toBe('00000000000000000000000000');
    expect(encodeUlid((1n << 128n) - 1n)).toBe('7ZZZZZZZZZZZZZZZZZZZZZZZZZ');
    expect(decodeUlid('7ZZZZZZZZZZZZZZZZZZZZZZZZZ')).toBe((1n << 128n) - 1n);
  });

  it('decodes Crockford aliases (I/L -> 1, O -> 0), case-insensitively', () => {
    expect(decodeUlid('0O000000000000000000000000')).toBe(0n);
    expect(decodeUlid('0L000000000000000000000000')).toBe(1n << 120n);
    expect(decodeUlid('0i000000000000000000000000')).toBe(1n << 120n);
  });

  it('refuses the wrong length', () => {
    expect(() => decodeUlid('short')).toThrow(UlidError);
  });

  it('refuses a first character above 7 as overflow', () => {
    expect(() => decodeUlid('80000000000000000000000000')).toThrow(UlidError);
  });

  it('refuses a character outside the alphabet', () => {
    expect(() => decodeUlid('0U000000000000000000000000')).toThrow(UlidError);
  });
});

describe('canonicalUlid', () => {
  it('accepts the canonical spelling', () => {
    expect(isCanonicalUlid('01ARZ3NDEKTSV4RRFFQ69G5FAV')).toBe(true);
  });

  it('refuses a second spelling of the same value', () => {
    expect(isCanonicalUlid('0iARZ3NDEKTSV4RRFFQ69G5FAV')).toBe(false);
    expect(() => canonicalUlid('0iARZ3NDEKTSV4RRFFQ69G5FAV')).toThrow(UlidError);
  });
});

describe('newUlid', () => {
  it('produces a canonical, lexicographically increasing id for increasing timestamps', () => {
    const a = newUlid(1_700_000_000_000);
    const b = newUlid(1_700_000_000_001);
    expect(isCanonicalUlid(a)).toBe(true);
    expect(isCanonicalUlid(b)).toBe(true);
    expect(a < b).toBe(true);
  });

  it('refuses a timestamp outside 48 bits', () => {
    expect(() => newUlid(2 ** 49)).toThrow();
  });
});
