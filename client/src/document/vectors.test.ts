// Cross-language proof, ADR-0049 §3: a Rust test writes small graphs with
// `write_plain` into fixtures under this tree, and this reader/writer must
// reproduce them byte for byte. `client/src/document/vectors/*.plain` did
// not exist when this file was written (see this session's report); the
// glob below is written to find zero files gracefully — a documented,
// visible skip, not a false green — and to exercise every vector it does
// find without needing another edit once the lead's merge lands them.
//
// Read via `import.meta.glob` (Vite's own file-discovery primitive, not
// `node:fs`) with `query: '?raw'`: the plain face's header lines and
// canonical JSON body are both valid UTF-8 text, so a raw string import is
// lossless, and this stays inside the toolchain the rest of the client
// already depends on rather than adding a Node-only code path.

import { describe, expect, it } from 'vitest';

import { readPlain, writePlain } from './plain';

const vectorModules = import.meta.glob('./vectors/*.plain', {
  eager: true,
  query: '?raw',
  import: 'default',
}) as Record<string, string>;

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

const vectors = Object.entries(vectorModules).sort(([a], [b]) => a.localeCompare(b));

describe('Rust-made vectors (client/src/document/vectors/*.plain)', () => {
  if (vectors.length === 0) {
    it.skip('no vectors present yet — the other builder has not landed client/src/document/vectors/ in this worktree; run again after merging', () => {});
    return;
  }

  for (const [path, text] of vectors) {
    it(`${path}: reads and re-writes byte-identical`, () => {
      const bytes = new TextEncoder().encode(text);
      const doc = readPlain(bytes);
      const rewritten = writePlain(doc);
      if (toHex(rewritten) !== toHex(bytes)) {
        throw new Error(`${path}: byte mismatch\n got: ${toHex(rewritten)}\nwant: ${toHex(bytes)}`);
      }
      expect(rewritten).toEqual(bytes);
    });
  }
});
