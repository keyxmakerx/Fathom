import { describe, expect, it } from 'vitest';

import { CanonParseException, parseCanonical, toCanonicalBytes } from './canon';

function text(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

describe('toCanonicalBytes', () => {
  it('sorts object keys and minifies', () => {
    const bytes = toCanonicalBytes({ b: 2, a: [true, null] });
    expect(text(bytes)).toBe('{"a":[true,null],"b":2}\n');
  });

  it('escapes RFC 8259 minimally and leaves non-ASCII raw', () => {
    const bytes = toCanonicalBytes('a"b\\c\nd\u0001e — \u2713');
    expect(text(bytes)).toBe('"a\\"b\\\\c\\nd\\u0001e — \u2713"\n');
  });

  it('refuses a non-integer number — the IR is float-free', () => {
    expect(() => toCanonicalBytes(1.5)).toThrow(/integer/);
  });
});

describe('parseCanonical', () => {
  it('is the exact inverse of toCanonicalBytes for a representative tree', () => {
    const value = { z: 1, a: ['x', 'y'], m: { nested: true, n: null } };
    const bytes = toCanonicalBytes(value);
    expect(parseCanonical(bytes)).toEqual(value);
    expect(toCanonicalBytes(parseCanonical(bytes))).toEqual(bytes);
  });

  it('refuses whitespace', () => {
    expect(() => parseCanonical(new TextEncoder().encode('{ }\n'))).toThrow(CanonParseException);
  });

  it('refuses an unsorted key', () => {
    expect(() => parseCanonical(new TextEncoder().encode('{"b":1,"a":2}\n'))).toThrow(CanonParseException);
  });

  it('refuses a duplicate key (caught by the same unsorted-key rule)', () => {
    expect(() => parseCanonical(new TextEncoder().encode('{"a":1,"a":2}\n'))).toThrow(CanonParseException);
  });

  it('refuses a leading zero', () => {
    expect(() => parseCanonical(new TextEncoder().encode('01\n'))).toThrow(CanonParseException);
  });

  it('refuses -0', () => {
    expect(() => parseCanonical(new TextEncoder().encode('-0\n'))).toThrow(CanonParseException);
  });

  it('refuses a float', () => {
    expect(() => parseCanonical(new TextEncoder().encode('1.5\n'))).toThrow(CanonParseException);
  });

  it('refuses a non-minimal escape — \\u0041 for "A"', () => {
    expect(() => parseCanonical(new TextEncoder().encode('"\\u0041"\n'))).toThrow(CanonParseException);
  });

  it('refuses a raw control character in a string', () => {
    const bytes = new Uint8Array([0x22, 0x01, 0x22, 0x0a]);
    expect(() => parseCanonical(bytes)).toThrow(CanonParseException);
  });

  it('refuses a missing final newline', () => {
    expect(() => parseCanonical(new TextEncoder().encode('1'))).toThrow(CanonParseException);
  });

  it('refuses trailing bytes after the final newline', () => {
    expect(() => parseCanonical(new TextEncoder().encode('1\nx'))).toThrow(CanonParseException);
  });

  it('refuses nesting past MAX_DEPTH', () => {
    const deep = '['.repeat(600) + ']'.repeat(600) + '\n';
    expect(() => parseCanonical(new TextEncoder().encode(deep))).toThrow(CanonParseException);
  });
});
