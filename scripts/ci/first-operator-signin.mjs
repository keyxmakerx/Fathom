#!/usr/bin/env node
// The first operator gets in, over HTTP, with nothing but the setup password.
//
// What `.github/workflows/ci.yml`'s `compose` job proved before 2026-09-21:
// health answers, the client is served, a token file exists. What it did
// not: that anyone could use that token. This script is the missing check,
// speaking exactly the bytes the browser client speaks with Node's own
// WebCrypto and no dependency.
//
// **Rewritten 2026-09-21 for ADR-0055 decision 10.** The flow was: redeem the
// token as a browser KEY, then sign in by signing a challenge. It is now the
// credential the ADR puts there — a password and an authenticator app — because that is
// what the product does and a smoke test of a flow nobody uses is not a smoke
// test.
//
// **Extended 2026-09-22 for ADR-0056.** Three checks join it, and they are the
// three things the first-run flow asks the server before anybody is signed in:
// whether setup is still pending, whose setup the setup secret opens, and
// whether a verification code is needed. Every assertion that was here is
// still here.
//
// **Rewritten again 2026-09-24 for ADR-0057 decision 1.** There is no token
// file: `FATHOM_SETUP_PASSWORD` in `.env` opens the setup screen, checked and
// spent through the same two routes a recovery code always used. `compose`'s
// own job now asserts the FILE IS ABSENT instead of copying it out; this
// script carries the setup password across the wire the browser does — as
// what was typed, unmodified — rather than reading a file off the volume.
//
//   0. GET  /setup/state               → LP("pending") before, LP("done") after
//                                        (decision 1: one bit about the
//                                        deployment, no session, no signature)
//   0b. POST /enrolment/operator/setup/check  LP(setup_secret) → LP(address)
//                                        (ADR-0056 decision 1: the address is
//                                        named by the server, never typed;
//                                        ADR-0057 decision 1: the secret is
//                                        the setup password here, and is not
//                                        spent by asking)
//   1. POST /enrolment/operator/setup  LP(setup_secret) ‖ LP(credential)  → 200, empty
//                                      (resolution 4: NO session; the client
//                                      signs in immediately afterwards)
//   2. POST /session/challenge         LP("steward") ‖ LP(address) ‖ LP(session_pubkey)
//                                      → LP(nonce) ‖ LP(deployment_id)
//   3. POST /session                   nine fields: LP(kind) ‖ LP(session_pubkey)
//                                      ‖ LP(nonce) ‖ LP(evidence_sig) ‖ LP(credential)
//                                      ‖ LP(app_code)   [the WIRE field name,
//                                        which ADR-0056 decision 4 leaves
//                                        alone; what a person is shown is a
//                                        "verification code"]
//                                      ‖ LP(account_session_id) ‖ LP(account_session_sig)
//                                        [ADR-0057 decision 2: an operator
//                                        sign-in also proves a live account
//                                        session of the operator's own bound
//                                        account, by that session's own key
//                                        signing this same challenge digest;
//                                        empty on every steward sign-in]
//                                      ‖ LP(grace_token) [ADR-0057 decision 6:
//                                        empty on every sign-in except the
//                                        operator one this script drives,
//                                        carrying the token minted by the
//                                        endorsing account session's answer
//                                        below -- held on that session
//                                        object, never persisted]
//                                      → LP(session_id) ‖ LP(token) ‖ u64(expires)
//                                        ‖ LP(principal_id) ‖ LP(grace_token)
//                                        [ADR-0057 decision 6: empty except on
//                                        a steward sign-in whose second factor
//                                        was just proved]
//   4. POST /credentials/totp/enrol    signed, LP(current_credential) ‖ LP(code)
//                                      → LP(otpauth_uri) ‖ LP(secret_base32)
//                                      (ADR-0057 decision 3: both fields are
//                                      sent empty and unchecked here, because
//                                      this is a first enrolment and the
//                                      account holds no confirmed authenticator
//                                      yet; a re-enrolment over a confirmed one
//                                      needs the current password AND a
//                                      current code, ASVS 7.5.1)
//   5. compute a TOTP in Node          RFC 6238, HMAC-SHA-1 through WebCrypto
//   6. POST /credentials/totp/confirm  signed, LP(code) → ten LP(recovery code)
//   7. POST /credentials/key           signed, LP(public_key) → LP(key_id)
//   7b. POST /session with an EMPTY code once the authenticator is confirmed
//                                      → 401 "second factor needed" (decision
//                                        3: sign-in is two steps, step one
//                                        issues nothing, and step two re-posts
//                                        the SAME challenge -- the probe is a
//                                        rollback, so the nonce survives it and
//                                        a two-step sign-in costs one
//                                        challenge, not two. It does cost one
//                                        SOURCE unit, added 2026-09-22: three
//                                        for the pair, challenge, probe and
//                                        completion, against a per-source cap
//                                        raised to 45 so that fifteen sign-ins
//                                        a window is still fifteen)
//   8. the operator's own key sign-in, and a signed GET /admin/operators.
//
// **Step 8 needs a route stream (b) owns** — the one that registers an
// operator's key under `/admin`. Until it exists this script stops after step
// 7 and says so, loudly, with exit code 0: the account half is what this
// stream built and it is what this run proves. Set
// `FATHOM_REQUIRE_OPERATOR_KEY_ROUTE=1` to make its absence a failure once
// stream (b) has landed.
//
// Usage: node scripts/ci/first-operator-signin.mjs [setup-password] [address] [base-url]
// ADR-0057 decision 1: the setup password may come from FATHOM_SETUP_PASSWORD
// instead, and the address may come from FATHOM_OPERATOR_NOTICE_ADDRESS
// instead — both of which `.github/workflows/ci.yml` already sets, or now
// sets, so the CI line only ever needs the base URL. Any argument shaped like
// a URL is taken as the base URL wherever it falls; of what is left, the
// first is the setup password and the second is the address.
// Exit 0 when the first operator sets a password, enrols an authenticator app, signs in
// and registers a browser key; any other outcome is non-zero with the step
// that failed.

import { webcrypto } from 'node:crypto';

const subtle = webcrypto.subtle;

// **The address is the identity** (ADR-0055 decision 1), and **the setup
// password replaces the token file** (ADR-0057 decision 1). Each is taken
// from the argument list when one is given and otherwise from its own
// environment variable — the address from `FATHOM_OPERATOR_NOTICE_ADDRESS`,
// the setup password from `FATHOM_SETUP_PASSWORD` — which
// `.github/workflows/ci.yml` sets in the job environment, so the CI line does
// not have to carry either as a literal argument.
const argv = process.argv.slice(2);
const looksLikeUrl = (s) => /^https?:\/\//i.test(s ?? '');
const baseUrl = argv.find(looksLikeUrl) ?? 'http://localhost:8080';
const nonUrlArgs = argv.filter((a) => !looksLikeUrl(a));
const setupPassword = nonUrlArgs[0] ?? process.env.FATHOM_SETUP_PASSWORD ?? '';
const address = nonUrlArgs[1] ?? process.env.FATHOM_OPERATOR_NOTICE_ADDRESS ?? '';
if (!setupPassword || !address) {
  console.error(
    'usage: first-operator-signin.mjs [setup-password] [address] [base-url]\n' +
      'the setup password may instead come from FATHOM_SETUP_PASSWORD, and the address from ' +
      'FATHOM_OPERATOR_NOTICE_ADDRESS',
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
async function get(path) {
  const r = await fetch(baseUrl + path, { method: 'GET' });
  const bytes = new Uint8Array(await r.arrayBuffer());
  return { status: r.status, bytes, text: dec.decode(bytes) };
}

/// ADR-0056 decision 1: one length-prefixed word about the deployment, asked
/// with no session and no signature at all.
async function setupState() {
  const r = await get('/setup/state');
  if (r.status !== 200) fail('setup-state', `status ${r.status}: ${r.text.trim()}`);
  const { value, rest } = readLp(r.bytes);
  if (rest.length !== 0) fail('setup-state', 'the answer must carry exactly one field');
  return dec.decode(value);
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

/// Step 2: a fresh session keypair and a challenge over its public half.
///
/// **Counted once per two-step sign-in, and the count is asserted below.**
/// ADR-0056 decision 3 as amended 2026-09-22: the second-factor probe is a
/// rollback, so the nonce this hands back is still good afterwards and step two
/// re-posts THIS challenge. A client that asked for a second one would be
/// spending a fourth unit of its own rate-limit budget — the pair already costs
/// three, one for this challenge, one for the probe and one for the
/// completion — on the way to every ordinary sign-in.
let challengesAsked = 0;
async function challengeFor(kind, principal) {
  const sessionKey = await keyPair();
  const sessionPub = await publicRaw(sessionKey);
  challengesAsked += 1;
  const ch = await post(
    '/session/challenge',
    concat(lp(utf8(kind)), lp(utf8(principal)), lp(sessionPub)),
  );
  if (ch.status !== 200) fail('challenge', `status ${ch.status}: ${ch.text.trim()}`);
  const { value: nonce, rest: afterNonce } = readLp(ch.bytes);
  const { value: deploymentId } = readLp(afterNonce);
  return { sessionKey, sessionPub, nonce, deploymentId };
}

/// Step 3: the eight-field sign-in body ADR-0055 decision 10 widened
/// `POST /session` to, and ADR-0057 decision 2 widened again with the two
/// fields at the end. Posted against a challenge already in hand. Returns the
/// raw answer; the caller decides what a non-200 means, because "not a session"
/// is the expected answer to step one.
///
/// **`accountSession`, ADR-0057 decision 2:** an operator-plane sign-in must
/// also carry proof of a live account session of the operator's own bound
/// account -- a signature by THAT session's own key over this same challenge
/// digest (`session_challenge` in `sessions.rs`, the very digest the evidence
/// signature above is over). The account session's id travels alongside it so
/// the server knows which row to check the signature against.
async function postSession(
  kind,
  ch,
  { credential = '', appCode = '', evidenceKey = null, accountSession = null } = {},
) {
  const challenge = await sha256(
    concat(
      lp(utf8('fathom/session/bind/v1')),
      lp(ch.sessionPub),
      lp(ch.nonce),
      lp(ch.deploymentId),
    ),
  );
  const evidence = evidenceKey ? await sign(evidenceKey, challenge) : EMPTY;
  const accountSessionId = accountSession ? utf8(accountSession.id) : EMPTY;
  const accountSessionSig = accountSession ? await sign(accountSession.key, challenge) : EMPTY;
  // ADR-0057 decision 6's grace token, ninth field: carries the token the
  // endorsing account session's sign-in answer just minted -- held on that
  // session object, never persisted, matching how the client keeps it in
  // memory only.
  const graceToken = accountSession?.graceToken ?? EMPTY;
  return post(
    '/session',
    concat(
      lp(utf8(kind)),
      lp(ch.sessionPub),
      lp(ch.nonce),
      lp(evidence),
      lp(utf8(credential)),
      lp(utf8(appCode)),
      lp(accountSessionId),
      lp(accountSessionSig),
      lp(graceToken),
    ),
  );
}

/// The five fields a session answer carries, with the keypair that will sign
/// this session's requests. The fifth, decision 6's grace token, is empty
/// except after a steward sign-in whose second factor was just proved --
/// the shape this script's operator sign-in (step 9) presents back to
/// satisfy the endorsement's freshness check.
function readSession(si, sessionKey) {
  const { value: sessionIdBytes, rest: afterSid } = readLp(si.bytes);
  const { value: sessionToken, rest: afterTok } = readLp(afterSid);
  const { value: principalBytes, rest: afterPrincipal } = readLp(afterTok.slice(8));
  const { value: graceToken } = readLp(afterPrincipal);
  counter = 0;
  return {
    id: dec.decode(sessionIdBytes),
    token: sessionToken,
    key: sessionKey,
    principal: dec.decode(principalBytes),
    graceToken,
  };
}

/// Steps 2 and 3 together, for the sign-ins that are one step: no second factor
/// is enrolled yet, or the factor is a key.
async function signIn(kind, principal, options = {}) {
  const ch = await challengeFor(kind, principal);
  const si = await postSession(kind, ch, options);
  if (si.status !== 200) fail('sign-in', `status ${si.status}: ${si.text.trim()}`);
  return readSession(si, ch.sessionKey);
}

// 0. Before anything: the deployment says setup is unfinished. This is what
// decides whether a visitor sees the setup flow or a sign-in page at all
// (ADR-0056 decisions 1 and 2), so a wrong answer here is a deployment nobody
// can walk into.
const stateBefore = await setupState();
if (stateBefore !== 'pending') {
  fail('setup-state', `before the setup secret is redeemed the state must be "pending", got ${JSON.stringify(stateBefore)}`);
}
console.log('setup state: pending, so the client shows the setup flow');

// ADR-0057 decision 1's one sentence for every refused setup secret.
const SETUP_SECRET_REFUSED =
  'Setup password is missing, invalid or expired. Setup stays open for 30 minutes after the server starts.\n';

// 0b. The setup password names its own address, so nobody types one that
// could then not match — the owner's ask, met by removing the field. Sent as
// what was typed, unmodified: the server compares it byte for byte against
// FATHOM_SETUP_PASSWORD in .env.
const setupSecret = utf8(setupPassword);
const checked = await post('/enrolment/operator/setup/check', lp(setupSecret));
if (checked.status !== 200) fail('setup-check', `status ${checked.status}: ${checked.text.trim()}`);
const namedAddress = dec.decode(readLp(checked.bytes).value);
if (namedAddress !== address) {
  fail('setup-check', `the server names ${JSON.stringify(namedAddress)} for this setup secret, not ${JSON.stringify(address)}`);
}
console.log(`setup check: the setup password opens ${namedAddress}, and is not spent by asking`);

// A wrong setup secret gets one sentence, whatever is wrong with it.
const refusedCheck = await post('/enrolment/operator/setup/check', lp(utf8('not-the-right-setup-password-at-all')));
if (refusedCheck.status !== 401 || refusedCheck.text !== SETUP_SECRET_REFUSED) {
  fail('setup-check', `a wrong setup secret must get 401 ${JSON.stringify(SETUP_SECRET_REFUSED)}, got ${refusedCheck.status}: ${JSON.stringify(refusedCheck.text)}`);
}
console.log('setup check: a wrong setup secret is refused in one sentence');

// 1. The setup secret: set a password. No session comes back (resolution 4).
const setup = await post(
  '/enrolment/operator/setup',
  concat(lp(setupSecret), lp(utf8(CREDENTIAL))),
);
if (setup.status !== 200) fail('setup', `status ${setup.status}: ${setup.text.trim()}`);
if (setup.bytes.length !== 0) {
  fail('setup', `the setup route must return no session and no body, got ${setup.bytes.length} byte(s)`);
}
console.log('setup: the first operator set a password');

// A spent setup secret is spent. The smoke test asserts it here rather than
// leaving it to the suite, because a setup password that still works after
// setup is a standing credential nobody meant to leave open.
const again = await post('/enrolment/operator/setup', concat(lp(setupSecret), lp(utf8(CREDENTIAL))));
if (again.status !== 401) {
  fail('setup', `a spent setup secret must be refused with 401, got ${again.status}: ${again.text.trim()}`);
}
console.log('setup: the setup secret is spent (401 on a second use)');

// And the spent secret is refused by the check route in exactly the same
// words as a wrong one.
const checkedAgain = await post('/enrolment/operator/setup/check', lp(setupSecret));
if (checkedAgain.status !== 401 || checkedAgain.text !== SETUP_SECRET_REFUSED) {
  fail('setup-check', `a spent setup secret must get 401 ${JSON.stringify(SETUP_SECRET_REFUSED)}, got ${checkedAgain.status}: ${JSON.stringify(checkedAgain.text)}`);
}
console.log('setup check: a spent setup secret gets the same refusal, byte for byte');

// The deployment's own bit has moved, and for ever.
const stateAfter = await setupState();
if (stateAfter !== 'done') {
  fail('setup-state', `once the credential is set the state must be "done", got ${JSON.stringify(stateAfter)}`);
}
console.log('setup state: done, so the client shows the sign-in page from here on');

// 2 and 3. Sign in with the address and the password. No authenticator yet, so this
// is the `A0` setup session decision 10 describes: good for `/credentials/*`
// and nothing else.
const session = await signIn('steward', address, { credential: CREDENTIAL });
console.log(`signed in: session ${session.id} for ${session.principal}`);

// 4. Enrol the authenticator app. A first enrolment, with no confirmed
// authenticator on the account yet, needs neither the current password nor a
// code (ADR-0057 decision 3): both fields travel empty.
const enrol = await signedPost(
  session,
  '/credentials/totp/enrol',
  concat(lp(EMPTY), lp(EMPTY)),
);
if (enrol.status !== 200) fail('totp-enrol', `status ${enrol.status}: ${enrol.text.trim()}`);
const { value: uriBytes, rest: afterUri } = readLp(enrol.bytes);
const { value: secretBytes } = readLp(afterUri);
const otpauth = dec.decode(uriBytes);
if (!otpauth.startsWith('otpauth://totp/')) fail('totp-enrol', `not an otpauth URI: ${otpauth}`);
for (const required of ['algorithm=SHA1', 'digits=6', 'period=30']) {
  if (!otpauth.includes(required)) fail('totp-enrol', `the URI omits ${required}: ${otpauth}`);
}
const secret = base32Decode(dec.decode(secretBytes));
console.log(`authenticator: a ${secret.length}-byte setup key and an otpauth URI`);

// 5 and 6. Compute a code and confirm with it.
const code = await totpCode(secret, currentStep());
const confirm = await signedPost(session, '/credentials/totp/confirm', lp(utf8(code)));
if (confirm.status !== 200) fail('totp-confirm', `status ${confirm.status}: ${confirm.text.trim()}`);
let rest = confirm.bytes;
const recoveryCodes = [];
while (rest.length > 0) {
  const read = readLp(rest);
  recoveryCodes.push(dec.decode(read.value));
  rest = read.rest;
}
if (recoveryCodes.length !== 10) fail('totp-confirm', `expected ten recovery codes, got ${recoveryCodes.length}`);
console.log('authenticator: confirmed with a real six-digit verification code; ten recovery codes issued');

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

// The whole point of the authenticator: the session is no longer setup-only,
// and a sign-in now needs the password AND a code. **A recovery code, not
// another verification code**: the confirm above spent this 30-second step, and
// a code is accepted once per step (ADR-0055 decision 10, the replay rule), so
// a second verification code inside the same step is refused on purpose. The
// recovery code proves the lost phone path at the same time, and its single use
// is asserted right after.
// **The two steps are one challenge** (ADR-0056 decision 3 as amended
// 2026-09-22). Step one sends the address and the credential with an empty
// code; the server answers "second factor needed", issues nothing, and ROLLS
// BACK -- so the nonce is untouched and step two re-posts the very same
// challenge with the code in it. This is the request the browser makes on the
// way to every ordinary sign-in, and if it cost a second challenge every
// correct sign-in would pay for it. The probe does cost one unit of the source
// budget, which is what stops a password holder repeating it for nothing; what
// this script asserts is the shape, and `tests/sessions.rs` asserts the
// arithmetic against the buckets themselves.
const askedBefore = challengesAsked;
const twoStep = await challengeFor('steward', address);
const probe = await postSession('steward', twoStep, { credential: CREDENTIAL });
if (probe.status !== 401 || probe.text !== 'second factor needed\n') {
  fail('second-factor', `an empty code on an account with an authenticator must be 401 "second factor needed", got ${probe.status}: ${JSON.stringify(probe.text)}`);
}
console.log('two steps: the password alone is answered "second factor needed", and no session is issued');

const withCodeAnswer = await postSession('steward', twoStep, {
  credential: CREDENTIAL,
  appCode: recoveryCodes[0],
});
if (withCodeAnswer.status !== 200) {
  fail('second-factor', `step two re-posted the SAME challenge and was refused with ${withCodeAnswer.status}: ${JSON.stringify(withCodeAnswer.text)}. The probe must leave the nonce unconsumed, or every two-step sign-in costs a second challenge`);
}
const withCode = readSession(withCodeAnswer, twoStep.sessionKey);
if (challengesAsked !== askedBefore + 1) {
  fail('second-factor', `a two-step sign-in asked for ${challengesAsked - askedBefore} challenges; it must ask for one`);
}
console.log(`two factors: signed in as ${withCode.principal} on the same challenge, with a password and a recovery code`);

// The nonce IS spent now -- the rolled-back probe is the one step that does not
// burn it -- and so is the recovery code. Two claims, one request each.
const thirdPost = await postSession('steward', twoStep, {
  credential: CREDENTIAL,
  appCode: recoveryCodes[0],
});
if (thirdPost.status === 200) fail('second-factor', 'a challenge that had already opened a session opened a second one');
console.log(`two steps: the challenge is spent once it issues a session (${thirdPost.status})`);

{
  const ch = await challengeFor('steward', address);
  const again = await postSession('steward', ch, {
    credential: CREDENTIAL,
    appCode: recoveryCodes[0],
  });
  if (again.status === 200) fail('recovery-code', 'a spent recovery code signed in a second time');
  console.log(`recovery code: spent, a second use is refused (${again.status})`);
}

// 8. The operator key. From the account session -- the person, with their
// password and their code behind them -- on the console host: this build
// confines nothing, so every host is the console host. The answer names the
// operator the custody is bound to, which is the id the operator signs in as.
const opKey = await signedPost(
  withCode,
  '/admin/operators/self/key',
  lp(await publicRaw(browserKey)),
);
if (opKey.status !== 200) fail('operator-key', `status ${opKey.status}: ${opKey.text.trim()}`);
const { value: opKeyIdBytes, rest: afterOpKeyId } = readLp(opKey.bytes);
const { value: operatorIdBytes } = readLp(afterOpKeyId);
const operatorId = dec.decode(operatorIdBytes);
console.log(`operator key: ${dec.decode(opKeyIdBytes)} registered for operator ${operatorId}`);

// 9. The operator sign-in: the operator custody is still a key sign-in
// (resolution 8), with the browser's key as the evidence and no password --
// but ADR-0057 decision 2 now also asks Site for the account: this sign-in
// must carry a signature by `withCode`, the live account session above, over
// this same challenge. `withCode` proved its second factor moments ago (the
// two-step sign-in just above) and carries the grace token that answer
// minted, so it holds what decision 6 requires -- no verification code is
// asked for a second time.
const op = await signIn('operator', operatorId, {
  evidenceKey: browserKey,
  accountSession: withCode,
});
if (op.principal !== operatorId) {
  fail('operator-sign-in', `the session names ${op.principal}, not ${operatorId}`);
}
console.log(`operator: signed in as ${operatorId} with the browser key, endorsed by the account session`);

// And the operator key ALONE, with no account session at all, is refused --
// Site needs the account (ADR-0057 decision 2), so the key by itself is not
// enough even though it verifies.
// The status AND the body, not merely "not 200": a 500 or a 404 would also pass that.
const bareChallenge = await challengeFor('operator', operatorId);
const bareOp = await postSession('operator', bareChallenge, { evidenceKey: browserKey });
if (bareOp.status !== 401 || bareOp.text !== 'sign-in refused\n') {
  fail(
    'operator-sign-in',
    `an operator key alone, with no account session at all, must get 401 "sign-in refused", got ${bareOp.status}: ${JSON.stringify(bareOp.text)}`,
  );
}
console.log(`operator: the key alone, with no account session, is refused (${bareOp.status} "${bareOp.text.trim()}")`);

// 10. One signed read of the register, which must name this operator and
// the notice address the first start bound the custody to.
const registerPath = '/admin/operators';
const registerHeaders = await signedHeaders(op, 'GET', registerPath, EMPTY);
const list = await fetch(baseUrl + registerPath, { method: 'GET', headers: registerHeaders });
const listText = await list.text();
if (list.status !== 200) fail('register', `status ${list.status}: ${listText.trim()}`);
const row = listText.split('\n').find((line) => line.startsWith(`${operatorId} `));
if (!row) fail('register', `the register does not name ${operatorId}:\n${listText}`);
if (!row.includes(address)) fail('register', `the register's row does not carry ${address}: ${row}`);
console.log(`the register names the operator and their address: ${row}`);
console.log(
  'OK: the deployment said setup was pending, the setup password named its own address, the first ' +
    'operator set a password, enrolled an authenticator app, was asked for a verification ' +
    'code before any second sign-in, signed in with both factors, registered a browser key, ' +
    'registered it as their operator key, signed in as the operator and read the register ' +
    'over HTTP',
);
