// The raw three-function ABI (`lib.rs`'s `fathom_alloc` / `fathom_call` /
// `fathom_free`), spoken from TypeScript with zero external packages
// (docs/OPEN-QUESTIONS.md A3: "the browser side stays at zero outside
// packages"). No imports are offered to `WebAssembly.instantiate` — the
// module's own import section is empty and stays empty (`wasmbin`'s
// allowlist) — which is ADR-0052 §1's "the browser fetches it and
// instantiates it with no imports".
//
// ONE CODE PATH, TWO LOADERS. `loadWasm` takes a `ByteLoader` and does not
// care where the bytes came from: `fetchLoader` for the browser,
// `fileLoader` for vitest's node environment, which has no dev server to
// fetch `/engine/fathom_wasm.wasm` from. Nothing downstream of the loader
// differs between the two.

export interface WasmExports {
  memory: WebAssembly.Memory;
  fathom_alloc(len: number): number;
  fathom_free(ptr: number, len: number): void;
  /** Packed as `(reply_ptr << 32) | reply_len`; `0n` means "no reply"
   * (`lib.rs`'s own doc comment on `fathom_call`). */
  fathom_call(op: number, reqPtr: number, reqLen: number): bigint;
}

export type ByteLoader = () => Promise<Uint8Array>;

/** The browser loader: fetch the file the artefact ships as (ADR-0052 §1). */
export function fetchLoader(url: string): ByteLoader {
  return async () => {
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`fathom-wasm: GET ${url} failed: ${res.status} ${res.statusText}`);
    }
    return new Uint8Array(await res.arrayBuffer());
  };
}

/** The test loader: read the built module straight off disk. Never used by
 * the browser bundle's own entry points — only by tests running under
 * vitest's `environment: 'node'` (`vitest.config.ts`), which has no dev
 * server to fetch from. */
export function fileLoader(path: string): ByteLoader {
  return async () => {
    const { readFile } = await import('node:fs/promises');
    const buf = await readFile(path);
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  };
}

export interface EngineWasm {
  /** One call, one reply (41 §3.7). Writes `req` into the module's scratch
   * via `fathom_alloc`, calls `fathom_call`, COPIES the reply out of the
   * module's arena before returning — that arena "lives ... valid until the
   * next `fathom_call`" (`lib.rs`), so a caller that kept a view into it
   * instead of a copy would see it change or go stale under the next call —
   * and releases the scratch with `fathom_free`. Empty reply (`0n`) decodes
   * to a zero-length array. */
  call(op: number, req: Uint8Array): Uint8Array;
}

/** Instantiate with no imports and return the raw-ABI caller. */
export async function loadWasm(loadBytes: ByteLoader): Promise<EngineWasm> {
  const bytes = await loadBytes();
  // `WebAssembly.instantiate` is overloaded on `BufferSource | Module`; a
  // `Uint8Array` view passed directly resolves to the wrong overload here, so
  // the exact byte range is copied out to a plain `ArrayBuffer` first — this
  // also makes the call correct regardless of whether `bytes` happens to be a
  // view into a larger, shared buffer (a Node `Buffer` sometimes is).
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const { instance } = await WebAssembly.instantiate(buffer, {});
  const exports = instance.exports as unknown as WasmExports;

  return {
    call(op: number, req: Uint8Array): Uint8Array {
      const ptr = exports.fathom_alloc(req.length);
      if (req.length > 0) {
        new Uint8Array(exports.memory.buffer, ptr, req.length).set(req);
      }
      const packed = exports.fathom_call(op, ptr, req.length);
      let reply: Uint8Array;
      if (packed === 0n) {
        reply = new Uint8Array(0);
      } else {
        const replyPtr = Number(packed >> 32n);
        const replyLen = Number(packed & 0xffffffffn);
        // The copy IS the contract: the next `fathom_call` — including the
        // `fathom_free` two lines down reusing the arena's neighbour, the
        // scratch buffer — invalidates this view of module memory.
        reply = new Uint8Array(exports.memory.buffer, replyPtr, replyLen).slice();
      }
      exports.fathom_free(ptr, req.length);
      return reply;
    },
  };
}
