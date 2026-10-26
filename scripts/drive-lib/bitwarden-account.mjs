// A Vaultwarden account, made the way Bitwarden makes one, for the tests and the drive of
// outside vaults (ADR-0071 part four). Plain WebCrypto, so it runs in Node and in vitest alike.
//
// The construction follows the sources `client/src/vault/bitwarden.ts` cites (bitwarden/sdk-internal
// `crates/bitwarden-crypto`, read 2026-10-25): master key = PBKDF2-SHA256(password, e-mail trimmed
// and lower-cased); the stretched key is HKDF-Expand "enc" and "mac"; a type-2 value is
// "2.iv|ct|mac" with AES-256-CBC (PKCS#7) and MAC = HMAC-SHA256(mac, iv ‖ ct); a type-4 value is
// RSA-2048-OAEP-SHA1. The answers have the shape Vaultwarden's own `identity.rs` and `sync` give
// (dani-garcia/vaultwarden 0f44744, read 2026-10-26), as far as Fathom reads them.
//
// It is a stand-in: nothing here is used by the product.

const subtle = globalThis.crypto.subtle;
const enc = new TextEncoder();

export const b64 = (bytes) => Buffer.from(bytes).toString('base64');
const rand = (n) => globalThis.crypto.getRandomValues(new Uint8Array(n));
const cat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};

async function hmac(key, data) {
  const k = await subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await subtle.sign('HMAC', k, data));
}

/** "2.iv|ct|mac" under a 64-byte key (AES key, then HMAC key). */
export async function sealType2(plain, key64) {
  const bytes = typeof plain === 'string' ? enc.encode(plain) : plain;
  const iv = rand(16);
  const k = await subtle.importKey('raw', key64.slice(0, 32), 'AES-CBC', false, ['encrypt']);
  const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-CBC', iv }, k, bytes));
  const mac = await hmac(key64.slice(32), cat(iv, ct));
  return `2.${b64(iv)}|${b64(ct)}|${b64(mac)}`;
}

export async function masterKey(password, email, iterations) {
  const base = await subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode(email.trim().toLowerCase()), iterations }, base, 256);
  return new Uint8Array(bits);
}

async function stretch(master) {
  return cat(await hmac(master, cat(enc.encode('enc'), new Uint8Array([1]))), await hmac(master, cat(enc.encode('mac'), new Uint8Array([1]))));
}

/**
 * One account in one organisation, a member of `role` (2 is a plain User), seeing the
 * collections named, each holding the logins given. `personal` items sit in the account's own
 * vault. Returns the token and sync answers and the organisation key, for the test to compare.
 */
export async function makeAccount({
  email,
  password,
  iterations = 600000,
  role = 2,
  collections = [{ name: 'fathom-7k2q', logins: [] }],
  personal = [],
}) {
  const stretched = await stretch(await masterKey(password, email, iterations));
  const userKey = rand(64);
  const pair = await subtle.generateKey(
    { name: 'RSA-OAEP', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-1' },
    true,
    ['encrypt', 'decrypt'],
  );
  const der = new Uint8Array(await subtle.exportKey('pkcs8', pair.privateKey));
  const orgKey = rand(64);
  const orgId = globalThis.crypto.randomUUID();
  const protectedOrgKey = `4.${b64(new Uint8Array(await subtle.encrypt({ name: 'RSA-OAEP' }, pair.publicKey, orgKey)))}`;
  const ciphers = [];
  const cols = [];
  const login = async (l, organizationId, collectionIds, key) => {
    let fieldKey = key;
    let protectedKey = null;
    if (l.ownKey) {
      fieldKey = rand(64);
      protectedKey = await sealType2(fieldKey, key);
    }
    return {
      object: 'cipherDetails',
      id: l.id ?? globalThis.crypto.randomUUID(),
      type: 1,
      organizationId,
      collectionIds,
      key: protectedKey,
      name: await sealType2(l.name, fieldKey),
      deletedDate: l.deleted ? '2026-10-01T00:00:00.000000Z' : null,
      login: {
        username: l.username == null ? null : await sealType2(l.username, fieldKey),
        password: l.password == null ? null : await sealType2(l.password, fieldKey),
        uri: null,
        uris: [],
      },
      viewPassword: l.viewPassword ?? true,
      edit: true,
    };
  };
  for (const c of collections) {
    const id = c.id ?? globalThis.crypto.randomUUID();
    cols.push({ object: 'collectionDetails', id, organizationId: orgId, name: await sealType2(c.name, orgKey), readOnly: false, hidePasswords: false, manage: false });
    for (const l of c.logins) ciphers.push(await login(l, orgId, [id], orgKey));
  }
  for (const p of personal) ciphers.push(await login(p, null, [], userKey));
  const token = {
    access_token: `stand-in.${b64(rand(18))}`,
    expires_in: 3600,
    token_type: 'Bearer',
    Key: await sealType2(userKey, stretched),
    PrivateKey: await sealType2(der, userKey),
    Kdf: 0,
    KdfIterations: iterations,
    KdfMemory: null,
    KdfParallelism: null,
    ForcePasswordReset: false,
    scope: 'api',
    UserDecryptionOptions: {
      HasMasterPassword: true,
      MasterPasswordUnlock: { Kdf: { KdfType: 0, Iterations: iterations }, Salt: email },
      Object: 'userDecryptionOptions',
    },
  };
  const sync = {
    object: 'sync',
    profile: {
      object: 'profile',
      email,
      organizations: [{ object: 'profileOrganization', id: orgId, name: 'Home lab', key: protectedOrgKey, type: role, status: 2, enabled: true }],
    },
    collections: cols,
    ciphers,
    folders: [],
    sends: [],
    policies: [],
    domains: null,
  };
  return { token, sync, orgKey, orgId };
}
