#!/usr/bin/env node
// The first operator gets in, over HTTP, with nothing but the token file.
//
// What `.github/workflows/ci.yml`'s `compose` job proved before 2026-09-21:
// health answers, the client is served, a token file exists. What it did
// not: that anyone could use that token. This script is the missing check,
// speaking exactly the bytes the browser client speaks with Node's own
// WebCrypto and no dependency.
//
// **Rewritten 2026-09-21 for ADR-0055 decision 10.** The flow was: redeem the
// token as a browser KEY, then sign in by signing a challenge. It is now the
// credential the ADR puts there — a password and an app code — because that is
// what the product does and a smoke test of a flow nobody uses is not a smoke
// test.
//
//   1. POST /enrolment/operator/setup  LP(token) ‖ LP(credential)  → 200, empty
//                                      (resolution 4: NO session; the client
//                                      signs in immediately afterwards)
//   2. POST /session/challenge         LP("steward") ‖ LP(address) ‖ LP(session_pubkey)
//                                      → LP(nonce) ‖ LP(deployment_id)
//   3. POST /session                   six fields: LP(kind) ‖ LP(session_pubkey)
//                                      ‖ LP(nonce) ‖ LP(evidence_sig) ‖ LP(credential)
//                                      ‖ LP(app_code)
//                                      → LP(session_id) ‖ LP(token) ‖ u64(expires)
//                                        ‖ LP(principal_id)
//   4. POST /credentials/totp/enrol    signed, empty → LP(otpauth_uri) ‖ LP(secret_base32)
//   5. compute a TOTP in Node          RFC 6238, HMAC-SHA-1 through WebCrypto
//   6. POST /credentials/totp/confirm  signed, LP(code) → ten LP(backup_code)
//   7. POST /credentials/key           signed, LP(public_key) → LP(key_id)
//   8. the operator's own key sign-in, and a signed GET /admin/operators.
//
// **Step 8 needs a route stream (b) owns** — the one that registers an
// operator's key under `/admin`. Until it exists this script stops after step
// 7 and says so, loudly, with exit code 0: the account half is what this
// stream built and it is what this run proves. Set
// `FATHOM_REQUIRE_OPERATOR_KEY_ROUTE=1` to make its absence a failure once
// stream (b) has landed.
//
// Usage: node scripts/ci/first-operator-signin.mjs <token-file> [address] [base-url]
// The address may come from FATHOM_OPERATOR_NOTICE_ADDRESS instead, which is
// what `.github/workflows/ci.yml` already sets — so the CI line is unchanged.
// Exit 0 when the first operator sets a password, enrols an app code, signs in
// and registers a browser key; any other outcome is non-zero with the step
// that failed.

import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';

const subtle = webcrypto.subtle;

// **The address is the identity now** (ADR-0055 decision 1), so this script
// needs one where it used to need only the operator id the enrolment answered
// with. It is taken from the argument list when one is given and otherwise
// from `FATHOM_OPERATOR_NOTICE_ADDRESS` — which is the address the first start
// creates the account for, is already in `compose.yaml` and in
// `.github/workflows/ci.yml`'s job environment, and is the one value that
// cannot be wrong. So the CI line does not have to change.
const [, , tokenFile, ...rest_argv] = process.argv;
const looksLikeUrl = (s) => /^https?:\/\//i.test(s ?? '');
const positionalUrl = rest_argv.find(looksLikeUrl);
const positionalAddress = rest_argv.find((a) => !looksLikeUrl(a));
const baseUrl = positionalUrl ?? 'http://localhost:8080';
const address = positionalAddress ?? process.env.FATHOM_OPERATOR_NOTICE_ADDRESS ?? '';
if (!tokenFile || !address) {
  console.error(
    'usage: first-operator-signin.mjs <token-file> [address] [base-url]\n' +
      'the address may instead come from FATHOM_OPERATOR_NOTICE_ADDRESS',
  );
  process.exit(2);
}

// **A real password**, of the length and shape ADR-0055 decision 10 requires
// and a person actually chooses: four words, twenty-eight characters, well
// past the fifteen-character floor and not on the bundled common list. A smoke
// test that used `aaaaaaaaaaaaaaa` would pass while proving the policy accepts
// nothing anybody would type.
const CREDENTIAL = 'harbour-lantern-copper-nine';

// --- bytes, as `client/src/crypto/bytes.ts` spells them ---------------------

const enc = new TextEncoder();
const dec = new TextDecoder();
const utf8 = (s) => enc.encode(s);
function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
function u32le(n) {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n, true);
  return b;
}
function u64le(n) {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, BigInt(n), true);
  return b;
}
const lp = (b) => concat(u32le(b.length), b);
const EMPTY = new Uint8Array(0);
function readLp(bytes) {
  if (bytes.length < 4) throw new Error('short LP field');
  const len = new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, true);
  if (bytes.length < 4 + len) throw new Error('truncated LP field');
  return { value: bytes.slice(4, 4 + len), rest: bytes.slice(4 + len) };
}
const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
function fromHex(s) {
  // `main.rs`'s `write_bootstrap_token`: `op_` and 64 hex digits. The prefix
  // names the door; the bytes are what the wire carries.
  const clean = s.trim().replace(/^op[_-]/i, '');
  if (!/^[0-9a-fA-F]{64}$/.test(clean)) throw new Error(`token file is not op_ and 64 hex digits: ${JSON.stringify(s.trim().slice(0, 8))}…`);
  return Uint8Array.from(clean.match(/../g), (h) => parseInt(h, 16));
}

// --- P-256, low-S, as `client/src/crypto/keys.ts` and `p256.ts` -------------

const N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
function lowS(sig) {
  const s = BigInt('0x' + hex(sig.slice(32)));
  if (s <= N >> 1n) return sig;
  const t = (N - s).toString(16).padStart(64, '0');
  return concat(sig.slice(0, 32), fromHexAny(t));
}
const fromHexAny = (s) => Uint8Array.from(s.match(/../g), (h) => parseInt(h, 16));
async function keyPair() {
  return subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
}
async function publicRaw(key) {
  return new Uint8Array(await subtle.exportKey('raw', key.publicKey));
}
async function sign(key, message) {
  return lowS(new Uint8Array(await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key.privateKey, message)));
}
async function sha256(b) {
  return new Uint8Array(await subtle.digest('SHA-256', b));
}

// --- RFC 6238, the same way `src/credentials.rs` computes it ----------------
//
// HMAC-SHA-1 through WebCrypto, which Node's `crypto.webcrypto` offers for
// exactly this kind of legacy interoperability. The server's own record —
// `deps/decisions/sha1.md` — carries why SHA-1 is sound as the HMAC inside a
// one-time code and broken for the thing it is famously broken for.

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function base32Decode(text) {
  const clean = text.toUpperCase().replace(/=+$/, '').replace(/\s+/g, '');
  const out = [];
  let buffer = 0;
  let bits = 0;
  for (const c of clean) {
    const v = BASE32.indexOf(c);
    if (v < 0) throw new Error(`not RFC 4648 base32: ${JSON.stringify(c)}`);
    buffer = (buffer << 5) | v;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((buffer >> bits) & 0xff);
    }
  }
  return Uint8Array.from(out);
}

async function totpCode(secretBytes, step) {
  const key = await subtle.importKey(
    'raw',
    secretBytes,
    { name: 'HMAC', hash: 'SHA-1' },
    false,
    ['sign'],
  );
  const counter = new Uint8Array(8);
  new DataView(counter.buffer).setBigUint64(0, BigInt(step), false); // big-endian, RFC 4226
  const tag = new Uint8Array(await subtle.sign('HMAC', key, counter));
  const offset = tag[tag.length - 1] & 0x0f;
  const binary =
    ((tag[offset] & 0x7f) << 24) |
    (tag[offset + 1] << 16) |
    (tag[offset + 2] << 8) |
    tag[offset + 3];
  return String(binary % 1000000).padStart(6, '0');
}
const currentStep = () => Math.floor(Date.now() / 1000 / 30);

// --- the steps ---------------------------------------------------------------

async function post(path, body, headers = {}) {
  const r = await fetch(baseUrl + path, { method: 'POST', body, headers });
  const bytes = new Uint8Array(await r.arrayBuffer());
  return { status: r.status, bytes, text: dec.decode(bytes) };
}
function fail(step, detail) {
  console.error(`FAIL ${step}: ${detail}`);
  process.exit(1);
}

/// One signed request's headers, as `client/src/api/signedFetch.ts` builds
/// them: a nonce from `POST /session/nonce`, then a signature over the method,
/// the path, the body digest, the nonce, the time and the counter.
let counter = 0;
async function signedHeaders(session, method, path, body) {
  const nonceRes = await post('/session/nonce', undefined, {
    'fathom-session': session.id,
    'fathom-session-token': hex(session.token),
  });
  if (nonceRes.status !== 200) fail('nonce', `status ${nonceRes.status}: ${nonceRes.text.trim()}`);
  const { value: reqNonce } = readLp(nonceRes.bytes);
  const unixMs = Date.now();
  counter += 1;
  const message = concat(
    lp(utf8('fathom/session/req/v1')),
    lp(utf8(session.id)),
    lp(utf8(method)),
    lp(utf8(path)),
    lp(await sha256(body ?? EMPTY)),
    lp(reqNonce),
    u64le(unixMs),
    u64le(counter),
  );
  return {
    'fathom-session': session.id,
    'fathom-session-token': hex(session.token),
    'fathom-nonce': hex(reqNonce),
    'fathom-timestamp': String(unixMs),
    'fathom-counter': String(counter),
    'fathom-signature': hex(await sign(session.key, message)),
  };
}

async function signedPost(session, path, body) {
  const headers = await signedHeaders(session, 'POST', path, body);
  return post(path, body ?? EMPTY, headers);
}

/// Steps 2 and 3: a fresh session keypair, a challenge over its public half,
/// and the six-field sign-in body ADR-0055 decision 10 widened `POST /session`
/// to.
async function signIn(kind, principal, { credential = '', appCode = '', evidenceKey = null } = {}) {
  const sessionKey = await keyPair();
  const sessionPub = await publicRaw(sessionKey);
  const ch = await post(
    '/session/challenge',
    concat(lp(utf8(kind)), lp(utf8(principal)), lp(sessionPub)),
  );
  if (ch.status !== 200) fail('challenge', `status ${ch.status}: ${ch.text.trim()}`);
  const { value: nonce, rest: afterNonce } = readLp(ch.bytes);
  const { value: deploymentId } = readLp(afterNonce);

  let evidence = EMPTY;
  if (evidenceKey) {
    const challenge = await sha256(
      concat(lp(utf8('fathom/session/bind/v1')), lp(sessionPub), lp(nonce), lp(deploymentId)),
    );
    evidence = await sign(evidenceKey, challenge);
  }

  const si = await post(
    '/session',
    concat(
      lp(utf8(kind)),
      lp(sessionPub),
      lp(nonce),
      lp(evidence),
      lp(utf8(credential)),
      lp(utf8(appCode)),
    ),
  );
  if (si.status !== 200) fail('sign-in', `status ${si.status}: ${si.text.trim()}`);
  const { value: sessionIdBytes, rest: afterSid } = readLp(si.bytes);
  const { value: sessionToken, rest: afterTok } = readLp(afterSid);
  const { value: principalBytes } = readLp(afterTok.slice(8));
  counter = 0;
  return {
    id: dec.decode(sessionIdBytes),
    token: sessionToken,
    key: sessionKey,
    principal: dec.decode(principalBytes),
  };
}

// 1. The setup token: set a password. No session comes back (resolution 4).
const token = fromHex(readFileSync(tokenFile, 'utf8'));
const setup = await post(
  '/enrolment/operator/setup',
  concat(lp(token), lp(utf8(CREDENTIAL))),
);
if (setup.status !== 200) fail('setup', `status ${setup.status}: ${setup.text.trim()}`);
if (setup.bytes.length !== 0) {
  fail('setup', `the setup route must return no session and no body, got ${setup.bytes.length} byte(s)`);
}
console.log('setup: the first operator set a password');

// A spent setup token is spent. The smoke test asserts it here rather than
// leaving it to the suite, because a token file that still works after setup
// is a token file sitting on a volume being a standing credential.
const again = await post('/enrolment/operator/setup', concat(lp(token), lp(utf8(CREDENTIAL))));
if (again.status === 200) fail('setup', 'the setup token was accepted a second time');
console.log(`setup: the token is spent (${again.status} on a second use)`);

// 2 and 3. Sign in with the address and the password. No app code yet, so this
// is the `A0` setup session decision 10 describes: good for `/credentials/*`
// and nothing else.
const session = await signIn('steward', address, { credential: CREDENTIAL });
console.log(`signed in: session ${session.id} for ${session.principal}`);

// 4. Enrol the app code.
const enrol = await signedPost(session, '/credentials/totp/enrol', EMPTY);
if (enrol.status !== 200) fail('totp-enrol', `status ${enrol.status}: ${enrol.text.trim()}`);
const { value: uriBytes, rest: afterUri } = readLp(enrol.bytes);
const { value: secretBytes } = readLp(afterUri);
const otpauth = dec.decode(uriBytes);
if (!otpauth.startsWith('otpauth://totp/')) fail('totp-enrol', `not an otpauth URI: ${otpauth}`);
for (const required of ['algorithm=SHA1', 'digits=6', 'period=30']) {
  if (!otpauth.includes(required)) fail('totp-enrol', `the URI omits ${required}: ${otpauth}`);
}
const secret = base32Decode(dec.decode(secretBytes));
console.log(`app code: a ${secret.length}-byte secret and an otpauth URI`);

// 5 and 6. Compute a code and confirm with it.
const code = await totpCode(secret, currentStep());
const confirm = await signedPost(session, '/credentials/totp/confirm', lp(utf8(code)));
if (confirm.status !== 200) fail('totp-confirm', `status ${confirm.status}: ${confirm.text.trim()}`);
let rest = confirm.bytes;
const backupCodes = [];
while (rest.length > 0) {
  const read = readLp(rest);
  backupCodes.push(dec.decode(read.value));
  rest = read.rest;
}
if (backupCodes.length !== 10) fail('totp-confirm', `expected ten backup codes, got ${backupCodes.length}`);
console.log(`app code: confirmed with a real six-digit code; ten backup codes issued`);

// 7. Register this browser's long-term key.
const browserKey = await keyPair();
const registered = await signedPost(
  session,
  '/credentials/key',
  lp(await publicRaw(browserKey)),
);
if (registered.status !== 200) fail('key', `status ${registered.status}: ${registered.text.trim()}`);
const { value: keyIdBytes } = readLp(registered.bytes);
console.log(`key: registered ${dec.decode(keyIdBytes)} for this browser`);

// The whole point of the app code: the session is no longer setup-only, and a
// sign-in now needs the password AND a code.
const withCode = await signIn('steward', address, {
  credential: CREDENTIAL,
  appCode: await totpCode(secret, currentStep()),
});
console.log(`two factors: signed in again as ${withCode.principal} with a password and a code`);

// 8. The operator half. Stream (b) of the ADR-0055 build contracts owns the
// route that registers an operator's key under `/admin`; without it there is
// no operator key to sign in with, and so no operator session to read the
// register from. **Not guessed at**: probing for a route by a name this stream
// invented would pass or fail on the guess rather than on the product.
const required = process.env.FATHOM_REQUIRE_OPERATOR_KEY_ROUTE === '1';
const missing =
  'the route that registers an operator key under /admin is not in this build ' +
  '(ADR-0055 build contracts, stream (b)), so the operator sign-in and the signed ' +
  'GET /admin/operators are NOT exercised by this run. Set ' +
  'FATHOM_REQUIRE_OPERATOR_KEY_ROUTE=1 once stream (b) has landed, and finish step 8.';
if (required) fail('operator-key', missing);
console.log(`SKIPPED: ${missing}`);
console.log(
  'OK: the first operator set a password, enrolled an app code, signed in with both ' +
    'factors and registered a browser key',
);
