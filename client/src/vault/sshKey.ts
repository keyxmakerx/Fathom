// SSH key logins (sign-off r117, finding 11). A key login is a vault login whose password is an
// OpenSSH private key's text, so a device is never handed a secret: the reader signs with the key
// and the device checks the signature against the public key installed on it (RFC 4252 §7).
//
// The file format is OpenSSH's own, `PROTOCOL.key` in its source (read 2026-11-12): the armour
// `-----BEGIN OPENSSH PRIVATE KEY-----`, then base64 of
//   "openssh-key-v1\0", string ciphername, string kdfname, string kdfoptions, uint32 count,
//   string publickey (count times), string private section;
// where the private section, unencrypted, is
//   uint32 checkint, uint32 checkint (equal), the key as the agent protocol writes it, string
//   comment, then padding bytes 1, 2, 3 … to a multiple of the block size (8 when the cipher is
//   "none").
// An Ed25519 key is written as string "ssh-ed25519", string public key (32 bytes), string private
// key (the 32-byte seed then the 32-byte public key) (RFC 8709 §4, PROTOCOL.key).
//
// The reader takes an unencrypted Ed25519 or ECDSA key and refuses RSA (r87, third tick), so the
// same is refused here before it is ever stored.

const ARMOUR_BEGIN = '-----BEGIN OPENSSH PRIVATE KEY-----';
const ARMOUR_END = '-----END OPENSSH PRIVATE KEY-----';
const MAGIC = 'openssh-key-v1\0';

/** The key types the reader logs in with. */
export const READER_KEY_TYPES = ['ssh-ed25519', 'ecdsa-sha2-nistp256', 'ecdsa-sha2-nistp384', 'ecdsa-sha2-nistp521'] as const;

/** Whether a secret is an OpenSSH private key (the server decides the same way). */
export function isSshKey(secret: string): boolean {
  return secret.trimStart().startsWith(ARMOUR_BEGIN);
}

export type ParsedKey = { ok: true; type: string; publicLine: string } | { ok: false; why: string };

function b64decode(text: string): Uint8Array | null {
  try {
    const bin = atob(text);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

function b64encode(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

class Reader {
  private at = 0;
  private readonly b: Uint8Array;
  constructor(b: Uint8Array) {
    this.b = b;
  }
  u32(): number {
    if (this.at + 4 > this.b.length) throw new Error('short');
    const v = ((this.b[this.at]! << 24) | (this.b[this.at + 1]! << 16) | (this.b[this.at + 2]! << 8) | this.b[this.at + 3]!) >>> 0;
    this.at += 4;
    return v;
  }
  bytes(): Uint8Array {
    const n = this.u32();
    if (this.at + n > this.b.length) throw new Error('short');
    const v = this.b.subarray(this.at, this.at + n);
    this.at += n;
    return v;
  }
  str(): string {
    return new TextDecoder().decode(this.bytes());
  }
  magic(): boolean {
    const m = new TextDecoder().decode(this.b.subarray(0, MAGIC.length));
    this.at = MAGIC.length;
    return m === MAGIC;
  }
}

/** Reads an OpenSSH private key far enough to say what it is and give its public key line. Only
 * the public half is read; the private section is left alone. */
export function parseOpenSshKey(text: string, comment = ''): ParsedKey {
  const t = text.trim();
  if (!t.startsWith(ARMOUR_BEGIN) || !t.endsWith(ARMOUR_END)) {
    return {
      ok: false,
      why: 'Paste the whole private key, from -----BEGIN OPENSSH PRIVATE KEY----- to the END line.',
    };
  }
  const body = t.slice(ARMOUR_BEGIN.length, t.length - ARMOUR_END.length).replace(/\s+/g, '');
  const bytes = b64decode(body);
  if (!bytes) return { ok: false, why: 'That key is damaged: its middle is not base64.' };
  try {
    const r = new Reader(bytes);
    if (!r.magic()) return { ok: false, why: 'That is not an OpenSSH private key.' };
    const cipher = r.str();
    r.str(); // kdf name
    r.bytes(); // kdf options
    if (r.u32() !== 1)
      return {
        ok: false,
        why: 'That file holds more than one key. Paste a file with one.',
      };
    const pub = r.bytes();
    const type = new Reader(pub).str();
    if (type === 'ssh-rsa' || type === 'ssh-dss') {
      return {
        ok: false,
        why: 'Fathom reads with an Ed25519 or ECDSA key and never an RSA or DSA one. Make an Ed25519 key here instead.',
      };
    }
    if (!(READER_KEY_TYPES as readonly string[]).includes(type)) {
      return {
        ok: false,
        why: `Fathom cannot read with a ${type} key. Use an Ed25519 or ECDSA key.`,
      };
    }
    if (cipher !== 'none') {
      return {
        ok: false,
        why: 'That key has a passphrase. Fathom needs one without, because it signs in on its own; the vault keeps it locked instead.',
      };
    }
    const line = `${type} ${b64encode(pub)}`;
    return {
      ok: true,
      type,
      publicLine: comment ? `${line} ${comment}` : line,
    };
  } catch {
    return { ok: false, why: 'That key is damaged or cut short.' };
  }
}

function u32(n: number): Uint8Array {
  return new Uint8Array([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
}

function sshString(v: Uint8Array | string): Uint8Array {
  const b = typeof v === 'string' ? new TextEncoder().encode(v) : v;
  return concat(u32(b.length), b);
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** Writes an unencrypted OpenSSH Ed25519 private key from its 32-byte seed and public key. */
export function openSshEd25519(seed: Uint8Array, publicKey: Uint8Array, comment: string, checkint: number): string {
  if (seed.length !== 32 || publicKey.length !== 32) throw new Error('an Ed25519 seed and public key are 32 bytes each');
  const pub = concat(sshString('ssh-ed25519'), sshString(publicKey));
  let priv = concat(u32(checkint), u32(checkint), sshString('ssh-ed25519'), sshString(publicKey), sshString(concat(seed, publicKey)), sshString(comment));
  const pad = (8 - (priv.length % 8)) % 8;
  priv = concat(
    priv,
    Uint8Array.from({ length: pad }, (_, i) => i + 1),
  );
  const blob = concat(new TextEncoder().encode(MAGIC), sshString('none'), sshString('none'), sshString(''), u32(1), sshString(pub), sshString(priv));
  const b64 = b64encode(blob);
  const lines = b64.match(/.{1,70}/g) ?? [];
  return `${ARMOUR_BEGIN}\n${lines.join('\n')}\n${ARMOUR_END}\n`;
}

/** Whether this browser can make an Ed25519 key (WebCrypto's Ed25519). */
export async function canMakeKeys(): Promise<boolean> {
  try {
    await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
    return true;
  } catch {
    return false;
  }
}

/** Makes a new Ed25519 key in this browser. Nothing leaves it until the login is saved, and then
 * only sealed, as every vault secret is. */
export async function makeEd25519Key(comment: string): Promise<{ privateKey: string; publicLine: string }> {
  const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey));
  const publicKey = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  // PKCS#8 for Ed25519 is a fixed 16-byte prefix and the 32-byte seed (RFC 8410 §7).
  const seed = pkcs8.slice(pkcs8.length - 32);
  const check = crypto.getRandomValues(new Uint32Array(1))[0]!;
  const privateKey = openSshEd25519(seed, publicKey, comment, check);
  seed.fill(0);
  pkcs8.fill(0);
  const parsed = parseOpenSshKey(privateKey, comment);
  if (!parsed.ok) throw new Error(parsed.why);
  return { privateKey, publicLine: parsed.publicLine };
}
