// Rust-made vectors (client/src/document/vectors/change/<name>/): applying
// `change` to `before.plain` must give `after.plain` byte for byte, and the
// change must write back to the bytes Rust wrote.

import { describe, expect, it } from 'vitest';

import { applyChange, readChange, writeChange } from './change';
import { readPlain, writePlain } from './plain';

const files = import.meta.glob('./vectors/change/*/{before.plain,change,after.plain}', {
  eager: true,
  query: '?raw',
  import: 'default',
}) as Record<string, string>;

const names = [...new Set(Object.keys(files).map((p) => p.split('/')[3]))].sort();
const enc = (s: string) => new TextEncoder().encode(s);
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

describe('Rust-made change vectors', () => {
  if (names.length === 0) {
    it.skip('no vectors under client/src/document/vectors/change/ in this tree', () => {});
    return;
  }
  for (const name of names) {
    const get = (f: string) => files[`./vectors/change/${name}/${f}`];
    it(`${name}: applies byte for byte and writes back identically`, () => {
      const change = readChange(enc(get('change')));
      expect(hex(writeChange(change))).toBe(hex(enc(get('change'))));
      const after = applyChange(readPlain(enc(get('before.plain'))), change);
      expect(hex(writePlain(after))).toBe(hex(enc(get('after.plain'))));
    });
  }
});
