// Rust-made vectors (client/src/document/vectors/canon.vectors, written by
// crates/fathom-canon/tests/client_vectors.rs): canon.ts must give the same
// verdict as fathom-canon on every input, down to the refusal reason and byte
// offset, and every accepted input must re-emit itself.

import { describe, expect, it } from 'vitest';

import { CanonParseException, parseCanonical, toCanonicalBytes } from './canon';

const files = import.meta.glob('./vectors/canon.vectors', {
  eager: true,
  query: '?raw',
  import: 'default',
}) as Record<string, string>;

const text = files['./vectors/canon.vectors'] ?? '';

interface Vector {
  name: string;
  verdict: 'accept' | 'accept-wide' | 'refuse';
  reason: string;
  offset: number;
  bytes: Uint8Array;
}

const fromHex = (h: string) => {
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
};
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

const vectors: Vector[] = text
  .split('\n')
  .filter((l) => l !== '')
  .map((l) => {
    const [name, verdict, reason, offset, h = ''] = l.split(' ');
    return {
      name,
      verdict: verdict as Vector['verdict'],
      reason,
      offset: offset === '-' ? -1 : Number(offset),
      bytes: fromHex(h),
    };
  });

function refusal(bytes: Uint8Array): { reason: string; offset: number } | null {
  try {
    parseCanonical(bytes);
    return null;
  } catch (e) {
    if (e instanceof CanonParseException) return e.detail;
    throw e;
  }
}

describe('Rust-made canonical JSON vectors', () => {
  if (vectors.length === 0) {
    it.skip('no client/src/document/vectors/canon.vectors in this tree', () => {});
    return;
  }
  for (const v of vectors) {
    if (v.verdict === 'accept') {
      it(`${v.name}: accepted and re-emitted byte for byte`, () => {
        expect(hex(toCanonicalBytes(parseCanonical(v.bytes)))).toBe(hex(v.bytes));
      });
    } else {
      // `accept-wide`: fathom-canon accepts an i64 that a JavaScript number
      // cannot hold exactly, so canon.ts refuses it rather than round it.
      it(`${v.name}: refused as ${v.reason} at byte ${v.offset}`, () => {
        expect(refusal(v.bytes)).toEqual({ reason: v.reason, offset: v.offset });
      });
    }
  }
});
