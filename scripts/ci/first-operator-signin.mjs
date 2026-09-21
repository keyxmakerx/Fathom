#!/usr/bin/env node
// The first operator gets in, over HTTP, with nothing but the token file.
//
// What `.github/workflows/ci.yml`'s `compose` job proved before 2026-09-21:
// health answers, the client is served, a token file exists. What it did
// not: that anyone could use that token. This script is the missing check,
// speaking exactly the bytes the browser client speaks
// (`client/src/api/enrolment.ts`, `auth.ts`, `signedFetch.ts`,
// `crypto/session.ts`) with Node's own WebCrypto and no dependency:
//
//   1. POST /enrolment/operator   LP(token) ‖ LP(public_key)
//                                 → LP(key_id) ‖ LP(operator_id)
//   2. POST /session/challenge    LP("operator") ‖ LP(operator_id) ‖ LP(session_pubkey)
//                                 → LP(nonce) ‖ LP(deployment_id)
//   3. POST /session              LP("operator") ‖ LP(session_pubkey) ‖ LP(nonce) ‖ LP(sig)
//                                 → LP(session_id) ‖ LP(token) ‖ u64(expires) ‖ LP(principal_id)
//   4. GET  /admin/operators      signed with the session key (nonce from
//                                 POST /session/nonce), and the answer must
//                                 name the operator just enrolled.
//
// Usage: node scripts/ci/first-operator-signin.mjs <token-file> [base-url]
// Exit 0 when the enrolled operator signs in and reads the register; any
// other outcome is non-zero with the step that failed.

import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';

const subtle = webcrypto.subtle;
const [, , tokenFile, baseUrl = 'http://localhost:8080'] = process.argv;
if (!tokenFile) {
  console.error('usage: first-operator-signin.mjs <token-file> [base-url]');
  process.exit(2);
}

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
function readLp(bytes) {
  if (bytes.length < 4) throw new Error('short LP field');
  const len = new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, true);
  if (bytes.length < 4 + len) throw new Error('truncated LP field');
  return { value: bytes.slice(4, 4 + len), rest: bytes.slice(4 + len) };
}
const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
function fromHex(s) {
  const clean = s.replace(/[^0-9a-fA-F]/g, '');
  if (clean.length !== 64) throw new Error(`token file holds ${clean.length} hex digits, not 64`);
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

// --- the four steps -----------------------------------------------------------

async function post(path, body, headers = {}) {
  const r = await fetch(baseUrl + path, { method: 'POST', body, headers });
  const bytes = new Uint8Array(await r.arrayBuffer());
  return { status: r.status, bytes, text: dec.decode(bytes) };
}
function fail(step, detail) {
  console.error(`FAIL ${step}: ${detail}`);
  process.exit(1);
}

const token = fromHex(readFileSync(tokenFile, 'utf8'));

// 1. Enrol.
const operatorKey = await keyPair();
const enrol = await post('/enrolment/operator', concat(lp(token), lp(await publicRaw(operatorKey))));
if (enrol.status !== 200) fail('enrol', `status ${enrol.status}: ${enrol.text.trim()}`);
const { value: keyId, rest: afterKey } = readLp(enrol.bytes);
const { value: opIdBytes, rest: afterOp } = readLp(afterKey);
if (afterOp.length !== 0) fail('enrol', `${afterOp.length} trailing byte(s) after LP(operator_id)`);
const operatorId = dec.decode(opIdBytes);
if (!/^[0-9A-Z]{26}$/.test(operatorId)) fail('enrol', `operator id ${JSON.stringify(operatorId)} is not a ulid`);
console.log(`enrolled key ${dec.decode(keyId)} for operator ${operatorId}`);

// 2. Challenge.
const sessionKey = await keyPair();
const sessionPub = await publicRaw(sessionKey);
const ch = await post('/session/challenge', concat(lp(utf8('operator')), lp(utf8(operatorId)), lp(sessionPub)));
if (ch.status !== 200) fail('challenge', `status ${ch.status}: ${ch.text.trim()}`);
const { value: nonce, rest: afterNonce } = readLp(ch.bytes);
const { value: deploymentId } = readLp(afterNonce);

// 3. Sign in: the challenge is SHA-256 over LP(tag) ‖ LP(pubkey) ‖ LP(nonce) ‖
//    LP(deployment), signed by the enrolled key (`crypto/session.ts`).
const challenge = await sha256(
  concat(lp(utf8('fathom/session/bind/v1')), lp(sessionPub), lp(nonce), lp(deploymentId)),
);
const evidence = await sign(operatorKey, challenge);
const si = await post('/session', concat(lp(utf8('operator')), lp(sessionPub), lp(nonce), lp(evidence)));
if (si.status !== 200) fail('sign-in', `status ${si.status}: ${si.text.trim()}`);
const { value: sessionIdBytes, rest: afterSid } = readLp(si.bytes);
const { value: sessionToken, rest: afterTok } = readLp(afterSid);
const { value: principalBytes } = readLp(afterTok.slice(8));
const sessionId = dec.decode(sessionIdBytes);
if (dec.decode(principalBytes) !== operatorId) {
  fail('sign-in', `the session names ${dec.decode(principalBytes)}, not ${operatorId}`);
}
console.log(`signed in: session ${sessionId}`);

// 4. One signed request (`signedFetch.ts`): a nonce, then the request bytes.
const nonceRes = await post('/session/nonce', undefined, {
  'fathom-session': sessionId,
  'fathom-session-token': hex(sessionToken),
});
if (nonceRes.status !== 200) fail('nonce', `status ${nonceRes.status}: ${nonceRes.text.trim()}`);
const { value: reqNonce } = readLp(nonceRes.bytes);
const unixMs = Date.now();
const counter = 1;
const path = '/admin/operators';
const message = concat(
  lp(utf8('fathom/session/req/v1')),
  lp(utf8(sessionId)),
  lp(utf8('GET')),
  lp(utf8(path)),
  lp(await sha256(new Uint8Array(0))),
  lp(reqNonce),
  u64le(unixMs),
  u64le(counter),
);
const signature = await sign(sessionKey, message);
const list = await fetch(baseUrl + path, {
  method: 'GET',
  headers: {
    'fathom-session': sessionId,
    'fathom-session-token': hex(sessionToken),
    'fathom-nonce': hex(reqNonce),
    'fathom-timestamp': String(unixMs),
    'fathom-counter': String(counter),
    'fathom-signature': hex(signature),
  },
});
const listText = await list.text();
if (list.status !== 200) fail('register', `status ${list.status}: ${listText.trim()}`);
const row = listText.split('\n').find((line) => line.startsWith(`${operatorId} `));
if (!row) fail('register', `the register does not name ${operatorId}:\n${listText}`);
console.log(`the register names the operator: ${row}`);
console.log('OK: the first operator enrolled, signed in and read the operator register over HTTP');
