// Rust-made vectors (client/src/document/vectors/plain.vectors, written by
// crates/fathom-workspace/tests/client_plain_vectors.rs): readPlain must open
// what read_plain opens, writing it back at the current version byte for byte,
// and refuse what read_plain refuses, for the same reason.

import { describe, expect, it } from 'vitest';

import { PlainError, readPlain, SCHEMA_VERSION, writePlain } from './plain';

const files = import.meta.glob('./vectors/plain.vectors', {
  eager: true,
  query: '?raw',
  import: 'default',
}) as Record<string, string>;

const text = files['./vectors/plain.vectors'] ?? '';

interface Vector {
  name: string;
  input?: string;
  input_hex?: string;
  expect: { kind: string } & Record<string, unknown>;
}

const vectors: Vector[] = text
  .split('\n')
  .filter((l) => l !== '')
  .map((l) => JSON.parse(l) as Vector);

const enc = (s: string) => new TextEncoder().encode(s);
const fromHex = (h: string) => Uint8Array.from(h.match(/../g) ?? [], (x) => parseInt(x, 16));
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

function outcome(bytes: Uint8Array): Record<string, unknown> {
  try {
    readPlain(bytes);
    return { kind: 'opens' };
  } catch (e) {
    if (e instanceof PlainError) return { ...e.reason };
    throw e;
  }
}

describe('Rust-made plain-face vectors', () => {
  if (vectors.length === 0) {
    it.skip('no client/src/document/vectors/plain.vectors in this tree', () => {});
    return;
  }
  for (const v of vectors) {
    const bytes = v.input_hex !== undefined ? fromHex(v.input_hex) : enc(v.input ?? '');
    if (v.expect.kind === 'opens') {
      it(`${v.name}: opens and writes back at the current version`, () => {
        const declared = (v.input ?? '').split('\n')[2].slice('schema '.length);
        const current = (v.input ?? '').replace(
          `schema ${declared}\n`,
          `schema ${SCHEMA_VERSION}\n`,
        );
        expect(hex(writePlain(readPlain(bytes)))).toBe(hex(enc(current)));
      });
    } else {
      it(`${v.name}: refused as ${v.expect.kind}`, () => {
        expect(outcome(bytes)).toEqual(v.expect);
      });
    }
  }
});
