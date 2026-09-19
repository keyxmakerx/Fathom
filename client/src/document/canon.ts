// The canonical JSON byte contract, mirrored from `crates/fathom-canon/src/lib.rs`
// so a browser-written body is byte-identical to a Rust-written one: object
// keys sorted by UTF-8 byte order (not JS's UTF-16 code-unit order, which
// disagrees with byte order above the BMP), no insignificant whitespace, one
// line plus one trailing LF, integers only (the IR is float-free), RFC 8259's
// minimal escaping, non-ASCII emitted as raw UTF-8 and never `\u`-escaped.
//
// The parser accepts exactly the emitter's output set and nothing wider —
// `fathom-canon`'s own law, quantified over every implementor there and
// re-stated here: there is no lenient mode, no whitespace tolerance, no
// alternative escape spelling.

export type CanonValue =
  | null
  | boolean
  | number
  | string
  | CanonValue[]
  | { [key: string]: CanonValue };

export const MAX_DEPTH = 512;

export interface CanonParseError {
  offset: number;
  reason:
    | 'unexpected-byte'
    | 'utf8'
    | 'unsorted-key'
    | 'non-shortest-int'
    | 'int-out-of-range'
    | 'float-refused'
    | 'non-minimal-escape'
    | 'raw-control'
    | 'depth-exceeded'
    | 'trailing-bytes'
    | 'missing-final-newline';
}

export class CanonParseException extends Error {
  readonly detail: CanonParseError;
  constructor(detail: CanonParseError) {
    super(`canonical JSON: ${detail.reason} at byte ${detail.offset}`);
    this.name = 'CanonParseException';
    this.detail = detail;
  }
}

// ---------------------------------------------------------------------------
// Emit

const encoder = new TextEncoder();

/** UTF-8 byte-lexicographic order — Rust `str`'s own `Ord`, and therefore
 * `BTreeMap<String, _>`'s iteration order. JS's `<` over `string` compares
 * UTF-16 code units, which disagrees with byte order for characters outside
 * the BMP, so keys are compared as encoded bytes rather than trusted to it. */
function utf8Compare(a: string, b: string): number {
  const ab = encoder.encode(a);
  const bb = encoder.encode(b);
  const len = Math.min(ab.length, bb.length);
  for (let i = 0; i < len; i += 1) {
    if (ab[i] !== bb[i]) {
      return ab[i] - bb[i];
    }
  }
  return ab.length - bb.length;
}

function emitString(s: string, out: string[]): void {
  out.push('"');
  for (const c of s) {
    switch (c) {
      case '"':
        out.push('\\"');
        break;
      case '\\':
        out.push('\\\\');
        break;
      case '\n':
        out.push('\\n');
        break;
      case '\r':
        out.push('\\r');
        break;
      case '\t':
        out.push('\\t');
        break;
      case '':
        out.push('\\b');
        break;
      case '':
        out.push('\\f');
        break;
      default: {
        const code = c.codePointAt(0)!;
        if (code < 0x20) {
          out.push(`\\u${code.toString(16).padStart(4, '0')}`);
        } else {
          out.push(c);
        }
      }
    }
  }
  out.push('"');
}

function isPlainObject(v: CanonValue): v is { [key: string]: CanonValue } {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function emit(v: CanonValue, out: string[]): void {
  if (v === null) {
    out.push('null');
    return;
  }
  if (typeof v === 'boolean') {
    out.push(v ? 'true' : 'false');
    return;
  }
  if (typeof v === 'number') {
    if (!Number.isInteger(v)) {
      throw new Error(`canonical JSON: ${v} is not an integer — the IR is float-free`);
    }
    out.push(v.toString());
    return;
  }
  if (typeof v === 'string') {
    emitString(v, out);
    return;
  }
  if (Array.isArray(v)) {
    out.push('[');
    for (let i = 0; i < v.length; i += 1) {
      if (i > 0) out.push(',');
      emit(v[i], out);
    }
    out.push(']');
    return;
  }
  if (isPlainObject(v)) {
    const keys = Object.keys(v).sort(utf8Compare);
    out.push('{');
    for (let i = 0; i < keys.length; i += 1) {
      if (i > 0) out.push(',');
      emitString(keys[i], out);
      out.push(':');
      emit(v[keys[i]], out);
    }
    out.push('}');
    return;
  }
  throw new Error('canonical JSON: value is none of null/bool/number/string/array/object');
}

/** Minified, sorted, one trailing newline — `Json::to_canonical_bytes`'s
 * exact contract. */
export function toCanonicalBytes(v: CanonValue): Uint8Array {
  const out: string[] = [];
  emit(v, out);
  out.push('\n');
  return encoder.encode(out.join(''));
}

// ---------------------------------------------------------------------------
// Parse

class Parser {
  readonly bytes: Uint8Array;
  at = 0;

  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
  }

  err(reason: CanonParseError['reason'], offset = this.at): CanonParseException {
    return new CanonParseException({ offset, reason });
  }

  peek(): number | undefined {
    return this.bytes[this.at];
  }

  literal(want: string): void {
    const bytes = encoder.encode(want);
    if (
      this.bytes.length < this.at + bytes.length ||
      !bytes.every((b, i) => this.bytes[this.at + i] === b)
    ) {
      throw this.err('unexpected-byte');
    }
    this.at += bytes.length;
  }

  value(depth: number): CanonValue {
    if (depth > MAX_DEPTH) {
      throw this.err('depth-exceeded');
    }
    const b = this.peek();
    if (b === undefined) {
      throw this.err('unexpected-byte');
    }
    switch (b) {
      case 0x6e: // 'n'
        this.literal('null');
        return null;
      case 0x74: // 't'
        this.literal('true');
        return true;
      case 0x66: // 'f'
        this.literal('false');
        return false;
      case 0x22: // '"'
        return this.string();
      case 0x5b: // '['
        return this.array(depth);
      case 0x7b: // '{'
        return this.object(depth);
      case 0x2d: // '-'
        return this.number();
      default:
        if (b >= 0x30 && b <= 0x39) {
          return this.number();
        }
        throw this.err('unexpected-byte');
    }
  }

  array(depth: number): CanonValue[] {
    this.at += 1; // '['
    const items: CanonValue[] = [];
    if (this.peek() === 0x5d) {
      this.at += 1;
      return items;
    }
    for (;;) {
      items.push(this.value(depth + 1));
      const b = this.peek();
      if (b === 0x2c) {
        this.at += 1;
      } else if (b === 0x5d) {
        this.at += 1;
        return items;
      } else {
        throw this.err('unexpected-byte');
      }
    }
  }

  object(depth: number): { [key: string]: CanonValue } {
    this.at += 1; // '{'
    const out: { [key: string]: CanonValue } = {};
    let previous: string | undefined;
    if (this.peek() === 0x7d) {
      this.at += 1;
      return out;
    }
    for (;;) {
      const keyAt = this.at;
      if (this.peek() !== 0x22) {
        throw this.err('unexpected-byte');
      }
      const key = this.string();
      if (previous !== undefined && utf8Compare(key, previous) <= 0) {
        throw this.err('unsorted-key', keyAt);
      }
      if (this.peek() !== 0x3a) {
        throw this.err('unexpected-byte');
      }
      this.at += 1;
      out[key] = this.value(depth + 1);
      previous = key;
      const b = this.peek();
      if (b === 0x2c) {
        this.at += 1;
      } else if (b === 0x7d) {
        this.at += 1;
        return out;
      } else {
        throw this.err('unexpected-byte');
      }
    }
  }

  string(): string {
    this.at += 1; // '"'
    const parts: string[] = [];
    for (;;) {
      const b = this.peek();
      if (b === undefined) {
        throw this.err('unexpected-byte');
      }
      if (b === 0x22) {
        this.at += 1;
        return parts.join('');
      }
      if (b === 0x5c) {
        const start = this.at;
        this.at += 1;
        const e = this.peek();
        switch (e) {
          case 0x22:
            parts.push('"');
            this.at += 1;
            break;
          case 0x5c:
            parts.push('\\');
            this.at += 1;
            break;
          case 0x6e:
            parts.push('\n');
            this.at += 1;
            break;
          case 0x72:
            parts.push('\r');
            this.at += 1;
            break;
          case 0x74:
            parts.push('\t');
            this.at += 1;
            break;
          case 0x62:
            parts.push('');
            this.at += 1;
            break;
          case 0x66:
            parts.push('');
            this.at += 1;
            break;
          case 0x75: {
            this.at += 1;
            const code = this.fourHex(start);
            if (code >= 0x20 || [0x08, 0x09, 0x0a, 0x0c, 0x0d].includes(code)) {
              throw this.err('non-minimal-escape', start);
            }
            parts.push(String.fromCharCode(code));
            break;
          }
          default:
            throw this.err('non-minimal-escape', start);
        }
        continue;
      }
      if (b < 0x20) {
        throw this.err('raw-control');
      }
      const width = utf8Width(b);
      if (width === undefined || this.at + width > this.bytes.length) {
        throw this.err('utf8');
      }
      const slice = this.bytes.subarray(this.at, this.at + width);
      const decoded = decodeUtf8Strict(slice);
      if (decoded === undefined) {
        throw this.err('utf8');
      }
      parts.push(decoded);
      this.at += width;
    }
  }

  fourHex(escapeAt: number): number {
    if (this.bytes.length < this.at + 4) {
      throw this.err('non-minimal-escape', escapeAt);
    }
    let v = 0;
    for (let i = 0; i < 4; i += 1) {
      const b = this.bytes[this.at + i];
      let d: number;
      if (b >= 0x30 && b <= 0x39) d = b - 0x30;
      else if (b >= 0x61 && b <= 0x66) d = b - 0x61 + 10;
      else throw this.err('non-minimal-escape', escapeAt);
      v = v * 16 + d;
    }
    this.at += 4;
    return v;
  }

  number(): CanonValue {
    const start = this.at;
    if (this.peek() === 0x2d) {
      this.at += 1;
    }
    const digitsAt = this.at;
    while (this.peek() !== undefined && this.peek()! >= 0x30 && this.peek()! <= 0x39) {
      this.at += 1;
    }
    if (this.at === digitsAt) {
      throw this.err('unexpected-byte', start);
    }
    const next = this.peek();
    if (next === 0x2e || next === 0x65 || next === 0x45) {
      throw this.err('float-refused', start);
    }
    const text = decoder.decode(this.bytes.subarray(start, this.at));
    const digits = this.bytes.subarray(digitsAt, this.at);
    if (digits.length > 1 && digits[0] === 0x30) {
      throw this.err('non-shortest-int', start);
    }
    if (text === '-0') {
      throw this.err('non-shortest-int', start);
    }
    const asBigInt = BigInt(text);
    if (asBigInt > 9223372036854775807n || asBigInt < -9223372036854775808n) {
      throw this.err('int-out-of-range', start);
    }
    const asNumber = Number(text);
    if (!Number.isSafeInteger(asNumber)) {
      throw this.err('int-out-of-range', start);
    }
    return asNumber;
  }
}

const decoder = new TextDecoder('utf-8', { fatal: true });

function utf8Width(b: number): number | undefined {
  if (b <= 0x7f) return 1;
  if (b >= 0xc2 && b <= 0xdf) return 2;
  if (b >= 0xe0 && b <= 0xef) return 3;
  if (b >= 0xf0 && b <= 0xf4) return 4;
  return undefined;
}

function decodeUtf8Strict(bytes: Uint8Array): string | undefined {
  try {
    return decoder.decode(bytes);
  } catch {
    return undefined;
  }
}

/** The exact inverse of `toCanonicalBytes`: accepts exactly the emitter's
 * output set. */
export function parseCanonical(bytes: Uint8Array): CanonValue {
  const p = new Parser(bytes);
  const value = p.value(0);
  if (p.peek() === 0x0a) {
    p.at += 1;
  } else {
    throw p.err('missing-final-newline');
  }
  if (p.at !== p.bytes.length) {
    throw p.err('trailing-bytes');
  }
  return value;
}
