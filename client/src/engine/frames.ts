// The two request frames this slice builds: `OP_DICT` (`dictframe.rs`) and
// `OP_PASTE` (`shell.rs`'s `Shell::paste` doc comment, PREFIX = 25).
//
// The dictionary sources are read with `import.meta.glob(..., { query:
// '?raw' })` — Vite's own file-discovery primitive, the precedent
// `client/src/document/vectors.test.ts` already set for reading fixtures this
// way rather than `node:fs`, so the client stays inside the toolchain it
// already depends on. `corpus/dict/` and `schema/field-keys.yaml` sit outside
// `client/`, three levels up from this file — the same distance
// `client/src/document/model.ts` already crosses to reach
// `schema/generated/ir_types.ts`.
import { DICT_ROLE_FIELD_KEYS, DICT_ROLE_SOURCE } from './protocol.constants';

const dictFiles = import.meta.glob('../../../corpus/dict/**/*.yaml', {
  eager: true,
  query: '?raw',
  import: 'default',
}) as Record<string, string>;

const fieldKeysFiles = import.meta.glob('../../../schema/field-keys.yaml', {
  eager: true,
  query: '?raw',
  import: 'default',
}) as Record<string, string>;

/** `dictionary.rs`'s own `FIELD_KEYS_SOURCE` — the name the reference
 * encoder (`crates/fathom-artifact/src/dictionary.rs`) gives the registry in
 * the frame. The module keys on the role byte, never on this name, but the
 * reference encoder is the thing to match rather than invent a second
 * spelling of. */
const FIELD_KEYS_NAME = 'schema/field-keys.yaml';

function fieldKeysText(): string {
  const entries = Object.values(fieldKeysFiles);
  if (entries.length !== 1) {
    throw new Error(
      `expected import.meta.glob('../../../schema/field-keys.yaml') to match exactly one file, found ${entries.length}`,
    );
  }
  return entries[0];
}

/** `corpus/dict/<platform>/*.yaml`, sorted by file name — the same
 * enumeration `Dictionary::load` and `dictionary.rs`'s `sources_in` perform,
 * and it must stay the same one: `dictframe.rs` refuses a frame whose
 * sources are not sorted, because entry indices are positional and a
 * different order would hand the module a dictionary whose provenance names
 * the wrong entries. */
/** Every platform directory name under `corpus/dict/` the glob above actually
 * found a `.yaml` file in — read by `engine.test.ts`'s coverage test so
 * `engine.ts`'s `DICT_PLATFORMS` (what boots) cannot silently drift from what
 * is really on disk (what could be booted). */
export function allDictPlatforms(): string[] {
  const names = new Set<string>();
  for (const path of Object.keys(dictFiles)) {
    const m = /\/corpus\/dict\/([^/]+)\//.exec(path);
    if (m) names.add(m[1]);
  }
  return [...names].sort();
}

export function platformSources(platform: string): { name: string; source: string }[] {
  const marker = `/corpus/dict/${platform}/`;
  const matches = Object.entries(dictFiles)
    .filter(([path]) => path.includes(marker))
    .map(([path, source]) => ({ name: path.slice(path.lastIndexOf('/') + 1), source }));
  matches.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return matches;
}

function u32le(n: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, n, true);
  return out;
}

function concatBytes(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, c) => sum + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/** `dictframe::pack_dict`'s frame, byte for byte: `file_count` (u32), then
 * per file `role` (u8), `name_len`+name, `source_len`+source. One `Dictionary`
 * holds one platform (`dictframe.rs`), so this builds ONE platform's frame —
 * `engine.ts`'s boot sends one of these per platform directory, the same way
 * the retired page sent `FATHOM_DICT_B64` and `FATHOM_DICT_CSV_B64`
 * separately. */
export function packDict(platform: string): Uint8Array {
  const encoder = new TextEncoder();
  const sources = platformSources(platform);
  if (sources.length === 0) {
    throw new Error(`no dictionary .yaml files found under corpus/dict/${platform}/`);
  }

  const files: { role: number; name: string; source: string }[] = sources.map((s) => ({
    role: DICT_ROLE_SOURCE,
    name: s.name,
    source: s.source,
  }));
  files.push({ role: DICT_ROLE_FIELD_KEYS, name: FIELD_KEYS_NAME, source: fieldKeysText() });

  const parts: Uint8Array[] = [u32le(files.length)];
  for (const f of files) {
    const nameBytes = encoder.encode(f.name);
    const sourceBytes = encoder.encode(f.source);
    parts.push(new Uint8Array([f.role]));
    parts.push(u32le(nameBytes.length));
    parts.push(nameBytes);
    parts.push(u32le(sourceBytes.length));
    parts.push(sourceBytes);
  }
  return concatBytes(parts);
}

/** `OP_PASTE`'s frame (`shell.rs`'s `Shell::paste`): an 8-byte little-endian
 * clock, 16 bytes of entropy, one confirm byte, then the pasted text
 * verbatim and un-decoded. `nonce` must be 16 bytes from the host's CSPRNG
 * (`crypto.getRandomValues`) — the module has neither a clock nor entropy of
 * its own and must not acquire either (`wasmbin`'s empty import allowlist),
 * so both travel in the frame exactly once, per call, from here. */
export function pasteFrame(text: string, confirm: boolean, now: number | bigint, nonce: Uint8Array): Uint8Array {
  if (nonce.length !== 16) {
    throw new Error(`pasteFrame needs 16 bytes of entropy, got ${nonce.length}`);
  }
  const at = new Uint8Array(8);
  new DataView(at.buffer).setBigUint64(0, BigInt(now), true);
  const confirmByte = new Uint8Array([confirm ? 1 : 0]);
  const textBytes = new TextEncoder().encode(text);
  return concatBytes([at, nonce, confirmByte, textBytes]);
}
