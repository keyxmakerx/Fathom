// The reader half of `protocol.rs` (WO-08 §4.4, WO-07 §4.4/§3.4): decodes
// `KIND_ERROR` (0) and `KIND_FACE_ROW` (5) only — this build never sends
// `OP_QUERY`, so `KIND_FINDER_ROW` (3) is named in `protocol.constants.ts`
// for the table's sake and refused here like any other unknown kind.
//
// Every offset below is copied from `protocol.rs`'s own `decode_reply`
// (crates/fathom-wasm/src/protocol.rs), which is that crate's own reference
// decoder and the thing this file must never quietly disagree with. Little-
// endian throughout (`DataView` with `littleEndian = true`), same as the
// retired page's reader.
import {
  ERROR_STRIDE,
  FACE_ROW_STRIDE,
  FACE_SLOTS,
  HEADER_LEN,
  KIND_ERROR,
  KIND_FACE_ROW,
  REPLY_MAGIC,
  REPLY_VERSION,
  faceName,
} from './protocol.constants';

export interface ErrorView {
  code: number;
  detail: string;
}

/** One decoded face record. `strings` always carries all eight slots,
 * whether or not `slotCount` declares every one of them meaningful — the
 * same convention `protocol.rs`'s own `FaceRowView` uses. */
export interface FaceRow {
  role: number;
  /** The role's name from `protocol.constants.ts`'s `FACES` table, or
   * `undefined` for a role this build does not know (a newer server). */
  roleName: string | undefined;
  slotCount: number;
  strings: string[];
}

export type ReplyView =
  | { kind: 'empty' }
  | { kind: 'error'; error: ErrorView }
  | { kind: 'faces'; rows: FaceRow[] };

const DECODER = new TextDecoder('utf-8', { fatal: true });

function u16At(view: DataView, offset: number): number {
  return view.getUint16(offset, true);
}

function u32At(view: DataView, offset: number): number {
  return view.getUint32(offset, true);
}

/** Decode the `(offset, length)` pair at `offset` into the blob's bytes,
 * exactly as `protocol.rs`'s `string_at` does, including its bounds check —
 * a string ref that runs past the blob is a protocol fault, not something to
 * clamp and carry on from. */
function stringAt(blob: Uint8Array, view: DataView, offset: number): string {
  const strOffset = u32At(view, offset);
  const strLen = u32At(view, offset + 4);
  if (strLen === 0) {
    return '';
  }
  const end = strOffset + strLen;
  if (end > blob.length) {
    throw new Error(`string ref at offset ${offset} runs past the blob`);
  }
  return DECODER.decode(blob.subarray(strOffset, end));
}

/** Refuses a bad magic, version, kind, stride, count, or out-of-blob string
 * ref by throwing, with a message naming the offset — the same contract
 * `protocol.rs`'s `decode_reply` documents: "never a guess and never an
 * uncaught exception" one layer down, and a typed refusal here. Empty input
 * decodes to `{ kind: 'empty' }`. */
export function decodeReply(bytes: Uint8Array): ReplyView {
  if (bytes.length === 0) {
    return { kind: 'empty' };
  }
  if (bytes.length < HEADER_LEN) {
    throw new Error(`reply is ${bytes.length} bytes: shorter than the ${HEADER_LEN}-byte header at offset 0`);
  }
  if (bytes[0] !== REPLY_MAGIC[0] || bytes[1] !== REPLY_MAGIC[1] || bytes[2] !== REPLY_MAGIC[2] || bytes[3] !== REPLY_MAGIC[3]) {
    throw new Error('bad magic at offset 0');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = u16At(view, 4);
  if (version !== REPLY_VERSION) {
    throw new Error(`unknown version ${version} at offset 4`);
  }
  const kind = u16At(view, 6);
  const count = u32At(view, 8);
  const stride = u32At(view, 12);

  let expectedStride: number;
  if (kind === KIND_ERROR) {
    expectedStride = ERROR_STRIDE;
  } else if (kind === KIND_FACE_ROW) {
    expectedStride = FACE_ROW_STRIDE;
  } else {
    throw new Error(`unknown record_kind ${kind} at offset 6 (this client decodes kinds 0 and 5 only)`);
  }
  if (stride !== expectedStride) {
    throw new Error(`record_stride ${stride} at offset 12 is not ${expectedStride} for record_kind ${kind}`);
  }

  const recordsLen = count * stride;
  const blobLenOffset = HEADER_LEN + recordsLen;
  if (bytes.length < blobLenOffset + 4) {
    throw new Error(`record_count ${count} at offset 8 runs past the reply`);
  }
  const blobLen = u32At(view, blobLenOffset);
  const blobOffset = blobLenOffset + 4;
  if (bytes.length !== blobOffset + blobLen) {
    throw new Error(`strings_len ${blobLen} at offset ${blobLenOffset} does not match the reply length`);
  }
  const blob = bytes.subarray(blobOffset);

  if (kind === KIND_ERROR) {
    if (count !== 1) {
      throw new Error(`record_count ${count} at offset 8: an error reply carries exactly one record`);
    }
    const base = HEADER_LEN;
    return {
      kind: 'error',
      error: { code: u16At(view, base), detail: stringAt(blob, view, base + 20) },
    };
  }

  const rows: FaceRow[] = [];
  for (let i = 0; i < count; i++) {
    const base = HEADER_LEN + i * stride;
    const strings: string[] = [];
    for (let s = 0; s < FACE_SLOTS; s++) {
      strings.push(stringAt(blob, view, base + 8 + s * 8));
    }
    const role = bytes[base];
    rows.push({ role, roleName: faceName(role), slotCount: u32At(view, base + 4), strings });
  }
  return { kind: 'faces', rows };
}
