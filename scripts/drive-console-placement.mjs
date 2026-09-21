// Drive the REAL built client's operator console against a REAL server:
// ADR-0055 client stream (b).
//
//   node scripts/drive-console-placement.mjs
//
// What it proves, in one browser, in this order:
//
//   1. the notices banner shows the one-operator fact off `GET /admin/notices`;
//   2. the SMTP form round-trips a value through `POST /admin/settings`
//      (sealed, with an assertion signed by the operator's enrolled key) and
//      the test-send shows the server's 503 sentence in the server's words;
//   3. the placement form warns BEFORE the save, naming the new host, the
//      window and what happens if nobody signs in there; saves with a
//      one-minute window; shows the countdown; and redirects the browser to
//      the new host;
//   4. decision 9's absence: an operator session on a host the console does
//      not answer on renders NO operator control at all;
//   5. the revert: after the window runs out unconfirmed, the console answers
//      again on the host it was moved off, and the client works there.
//
// **What it does not prove, said plainly.** The prerequisites -- the first
// operator's password, the app code, this browser's key and the operator key
// -- are spoken in the page by a hand port of `scripts/ci/first-operator-
// signin.mjs`, not by the client's own modules, because no rendered surface
// calls them until ADR-0055 client stream (a) lands its sign-in and setup
// screens. `client/src/api/placement.ts`'s `bootstrapOperatorSession` sends
// exactly the two requests step 0 below sends, in that order, and its bytes
// are held by `client/src/api/placement.test.ts`; the function itself does
// not run in this drive. Nothing else here is a port: every screen, every
// form and every request in steps 1 to 5 is the built client's own code.
//
// It needs: PostgreSQL on 127.0.0.1 with the `fathom_test`/`postgres` roles,
// a built client (`cd client && npm ci --ignore-scripts && npm run build`),
// the merged `fathom-server` binary, and Playwright's Chromium. It creates
// its own database and drops it, and it kills the server by PORT.

import { spawn, spawnSync } from 'node:child_process';
import http from 'node:http';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, URL } from 'node:url';

const ROOT = process.env.FATHOM_ROOT ?? fileURLToPath(new URL('..', import.meta.url));
const SERVER_BIN = process.env.FATHOM_SERVER_BIN ?? '/home/user/Fathom/target/debug/fathom-server';
const PORT = 18102;
const OLD_HOST = `127.0.0.1:${PORT}`;
const NEW_HOST = `localhost:${PORT}`;
const OLD_URL = `http://${OLD_HOST}`;
const NEW_URL = `http://${NEW_HOST}`;
const DB_NAME = 'fathom_c2';
const RUNTIME_URL = `postgres://fathom_app@127.0.0.1:5432/${DB_NAME}`;
const MIGRATE_URL = `postgres://fathom_test@127.0.0.1:5432/${DB_NAME}`;
const CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const PLAYWRIGHT = '/opt/node22/lib/node_modules/playwright/index.mjs';
const ADDRESS = 'owner@example.test';
// A password of the length and shape ADR-0055 decision 10 requires and a
// person actually chooses -- the CI script's own, for the same reason.
const CREDENTIAL = 'harbour-lantern-copper-nine';

const WORK = process.env.FATHOM_DRIVE_DIR ?? '/tmp/claude-0/-home-user-Fathom/e3fb841a-3739-5e05-b6f7-65bae229f9a6/scratchpad/drive-console';
const SHOTS = join(WORK, 'shots');
mkdirSync(SHOTS, { recursive: true });

let failures = 0;
function check(what, ok, detail = '') {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${detail ? ' — ' + detail : ''}`);
  if (!ok) failures += 1;
}

function sh(cmd, args, options = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', ...options });
  if (r.status !== 0 && !options.allowFailure) {
    throw new Error(`${cmd} ${args.join(' ')} failed:\n${r.stdout ?? ''}${r.stderr ?? ''}`);
  }
  return r;
}

const psql = (sql, o = {}) =>
  sh('psql', ['-h', '127.0.0.1', '-U', 'postgres', '-d', 'postgres', '-qc', sql], o);

async function waitForHttp(url, attempts = 200) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await fetch(url);
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw new Error(`${url} never answered`);
}

let serverProc = null;
function stopServer() {
  sh('fuser', ['-k', `${PORT}/tcp`], { allowFailure: true });
  if (serverProc) serverProc.kill('SIGTERM');
}

/**
 * `GET /placement/flag` as a given `Host` sees it.
 *
 * Through `node:http` and not `fetch`: `Host` is a forbidden header name for
 * `fetch`, which drops it silently — a drive that asked about the new host
 * and was answered about the old one would have proved nothing.
 */
async function flagAs(host) {
  const bytes = await new Promise((resolve, reject) => {
    const request = http.request(
      { host: '127.0.0.1', port: PORT, path: '/placement/flag', method: 'GET', headers: { Host: host } },
      (response) => {
        const chunks = [];
        response.on('data', (c) => chunks.push(c));
        response.on('end', () => resolve(new Uint8Array(Buffer.concat(chunks))));
      },
    );
    request.on('error', reject);
    request.end();
  });
  const len = new DataView(bytes.buffer).getUint32(0, true);
  const verdict = new TextDecoder().decode(bytes.slice(4, 4 + len));
  let deadline = null;
  if (bytes.length > 4 + len) {
    const rest = bytes.slice(4 + len);
    const l2 = new DataView(rest.buffer, rest.byteOffset, 4).getUint32(0, true);
    const text = new TextDecoder().decode(rest.slice(4, 4 + l2));
    deadline = text.length ? Number(text) : null;
  }
  return { verdict, deadline };
}

// ---------------------------------------------------------------------------
// The prerequisites, spoken in the page (see the header for why)
// ---------------------------------------------------------------------------

const PREREQUISITES = async ({ token, address, credential }) => {
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const utf8 = (s) => enc.encode(s);
  const concat = (...parts) => {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const p of parts) {
      out.set(p, at);
      at += p.length;
    }
    return out;
  };
  const u32le = (n) => {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, n, true);
    return b;
  };
  const u64le = (n) => {
    const b = new Uint8Array(8);
    new DataView(b.buffer).setBigUint64(0, BigInt(n), true);
    return b;
  };
  const lp = (b) => concat(u32le(b.length), b);
  const EMPTY = new Uint8Array(0);
  const readLp = (bytes) => {
    const len = new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, true);
    return { value: bytes.slice(4, 4 + len), rest: bytes.slice(4 + len) };
  };
  const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  const fromHex = (s) => Uint8Array.from(s.match(/../g), (h) => parseInt(h, 16));
  const N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
  const lowS = (sig) => {
    const s = BigInt('0x' + hex(sig.slice(32)));
    if (s <= N >> 1n) return sig;
    return concat(sig.slice(0, 32), fromHex((N - s).toString(16).padStart(64, '0')));
  };
  const keyPair = () =>
    crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
  const publicRaw = async (k) => new Uint8Array(await crypto.subtle.exportKey('raw', k.publicKey));
  const sign = async (k, m) =>
    lowS(new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, k.privateKey, m)));
  const sha256 = async (b) => new Uint8Array(await crypto.subtle.digest('SHA-256', b));
  const post = async (path, body, headers = {}) => {
    const r = await fetch(path, { method: 'POST', body, headers });
    const bytes = new Uint8Array(await r.arrayBuffer());
    return { status: r.status, bytes, text: dec.decode(bytes) };
  };

  const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const base32Decode = (text) => {
    const clean = text.toUpperCase().replace(/=+$/, '').replace(/\s+/g, '');
    const out = [];
    let buffer = 0;
    let bits = 0;
    for (const c of clean) {
      buffer = (buffer << 5) | BASE32.indexOf(c);
      bits += 5;
      if (bits >= 8) {
        bits -= 8;
        out.push((buffer >> bits) & 0xff);
      }
    }
    return Uint8Array.from(out);
  };
  const totpCode = async (secret, step) => {
    const key = await crypto.subtle.importKey('raw', secret, { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
    const counter = new Uint8Array(8);
    new DataView(counter.buffer).setBigUint64(0, BigInt(step), false);
    const tag = new Uint8Array(await crypto.subtle.sign('HMAC', key, counter));
    const offset = tag[tag.length - 1] & 0x0f;
    const binary =
      ((tag[offset] & 0x7f) << 24) | (tag[offset + 1] << 16) | (tag[offset + 2] << 8) | tag[offset + 3];
    return String(binary % 1000000).padStart(6, '0');
  };

  let counter = 0;
  const signedPost = async (session, path, body) => {
    const nonceRes = await post('/session/nonce', undefined, {
      'fathom-session': session.id,
      'fathom-session-token': hex(session.token),
    });
    const { value: reqNonce } = readLp(nonceRes.bytes);
    const unixMs = Date.now();
    counter += 1;
    const message = concat(
      lp(utf8('fathom/session/req/v1')),
      lp(utf8(session.id)),
      lp(utf8('POST')),
      lp(utf8(path)),
      lp(await sha256(body ?? EMPTY)),
      lp(reqNonce),
      u64le(unixMs),
      u64le(counter),
    );
    return post(path, body ?? EMPTY, {
      'fathom-session': session.id,
      'fathom-session-token': hex(session.token),
      'fathom-nonce': hex(reqNonce),
      'fathom-timestamp': String(unixMs),
      'fathom-counter': String(counter),
      'fathom-signature': hex(await sign(session.key, message)),
    });
  };

  const signIn = async (kind, principal, { credential: cred = '', appCode = '', evidenceKey = null } = {}) => {
    const sessionKey = await keyPair();
    const sessionPub = await publicRaw(sessionKey);
    const ch = await post('/session/challenge', concat(lp(utf8(kind)), lp(utf8(principal)), lp(sessionPub)));
    if (ch.status !== 200) throw new Error(`challenge ${ch.status}: ${ch.text}`);
    const { value: nonce, rest: afterNonce } = readLp(ch.bytes);
    const { value: deploymentId } = readLp(afterNonce);
    let evidence = EMPTY;
    if (evidenceKey) {
      const bound = await sha256(
        concat(lp(utf8('fathom/session/bind/v1')), lp(sessionPub), lp(nonce), lp(deploymentId)),
      );
      evidence = await sign(evidenceKey, bound);
    }
    const si = await post(
      '/session',
      concat(lp(utf8(kind)), lp(sessionPub), lp(nonce), lp(evidence), lp(utf8(cred)), lp(utf8(appCode))),
    );
    if (si.status !== 200) throw new Error(`sign-in ${si.status}: ${si.text}`);
    const { value: idBytes, rest: afterSid } = readLp(si.bytes);
    const { value: tokenBytes } = readLp(afterSid);
    counter = 0;
    return { id: dec.decode(idBytes), token: tokenBytes, key: sessionKey };
  };

  // 1. The setup token sets the first operator's password. No session back.
  const setup = await post('/enrolment/operator/setup', concat(lp(fromHex(token)), lp(utf8(credential))));
  if (setup.status !== 200) throw new Error(`setup ${setup.status}: ${setup.text}`);

  // 2. Sign in with the address and the password: the setup-only session.
  const session = await signIn('steward', address, { credential });

  // 3. Enrol and confirm the app code; keep the backup codes.
  const enrol = await signedPost(session, '/credentials/totp/enrol', EMPTY);
  if (enrol.status !== 200) throw new Error(`totp enrol ${enrol.status}: ${enrol.text}`);
  const { value: uriBytes, rest: afterUri } = readLp(enrol.bytes);
  const { value: secretBytes } = readLp(afterUri);
  const secret = base32Decode(dec.decode(secretBytes));
  const code = await totpCode(secret, Math.floor(Date.now() / 1000 / 30));
  const confirm = await signedPost(session, '/credentials/totp/confirm', lp(utf8(code)));
  if (confirm.status !== 200) throw new Error(`totp confirm ${confirm.status}: ${confirm.text}`);
  const backupCodes = [];
  let rest = confirm.bytes;
  while (rest.length > 0) {
    const read = readLp(rest);
    backupCodes.push(dec.decode(read.value));
    rest = read.rest;
  }

  // 4. This browser's key, generated HERE and non-extractable, exactly as
  //    `client/src/crypto/keys.ts` generates one.
  const browserKey = await keyPair();
  const registered = await signedPost(session, '/credentials/key', lp(await publicRaw(browserKey)));
  if (registered.status !== 200) throw new Error(`key ${registered.status}: ${registered.text}`);

  // 5. Sign in again with the password and a backup code (the app code for
  //    this step is spent), giving the full account session.
  const account = await signIn('steward', address, { credential, appCode: backupCodes[0] });

  // 6. `bootstrapOperatorSession` step 1: register the same key as this
  //    account's OPERATOR key. The answer names the operator.
  const opKey = await signedPost(account, '/admin/operators/self/key', lp(await publicRaw(browserKey)));
  if (opKey.status !== 200) throw new Error(`operator key ${opKey.status}: ${opKey.text}`);
  const { value: keyIdBytes, rest: afterKeyId } = readLp(opKey.bytes);
  const { value: operatorIdBytes } = readLp(afterKeyId);
  const operatorId = dec.decode(operatorIdBytes);

  // 7. File that keypair where `crypto/keys.ts` looks for it, under the slot
  //    `api/constants.ts`'s `keySlot('operator', id)` makes. From here on the
  //    built client signs in and signs every operator act with it itself.
  await new Promise((resolve, reject) => {
    const request = indexedDB.open('fathom-enrolled-keys', 2);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('keys')) db.createObjectStore('keys');
      if (!db.objectStoreNames.contains('pending')) db.createObjectStore('pending');
    };
    request.onsuccess = () => {
      const db = request.result;
      const tx = db.transaction('keys', 'readwrite');
      tx.objectStore('keys').put(browserKey, `operator:${operatorId}`);
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => reject(tx.error);
    };
    request.onerror = () => reject(request.error);
  });

  return { operatorId, keyId: dec.decode(keyIdBytes), backupCodes: backupCodes.length };
};

// ---------------------------------------------------------------------------

async function main() {
  if (!existsSync(join(ROOT, 'client', 'dist', 'index.html'))) {
    throw new Error('no built client. Run: cd client && npm ci --ignore-scripts && npm run build');
  }
  if (!existsSync(SERVER_BIN)) throw new Error(`no server binary at ${SERVER_BIN}`);

  console.log(`==> database ${DB_NAME}`);
  psql(`DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE);`, { allowFailure: true });
  psql(`CREATE DATABASE ${DB_NAME} OWNER fathom_test;`);

  const masterKey = join(WORK, 'master.key');
  const chainKey = join(WORK, 'chain.key');
  const tokenFile = join(WORK, 'first-operator-token');
  // A previous run's files, gone before this one starts: the server refuses
  // to start rather than overwrite a bootstrap token file that already
  // exists, which is the right refusal and a stale file here would look
  // like a failure of this drive.
  for (const path of [masterKey, chainKey, tokenFile]) rmSync(path, { force: true });
  writeFileSync(masterKey, Buffer.alloc(32, 19), { mode: 0o400 });
  writeFileSync(chainKey, Buffer.alloc(32, 23), { mode: 0o400 });

  sh('fuser', ['-k', `${PORT}/tcp`], { allowFailure: true });
  const env = { ...process.env };
  delete env.DATABASE_URL;
  serverProc = spawn(SERVER_BIN, [], {
    cwd: ROOT,
    env: {
      ...env,
      DATABASE_URL: RUNTIME_URL,
      FATHOM_MIGRATE_DATABASE_URL: MIGRATE_URL,
      FATHOM_SCHEMA_ROOT: join(ROOT, 'schema'),
      FATHOM_CLIENT_ROOT: join(ROOT, 'client', 'dist'),
      FATHOM_MASTER_KEY: `file://${masterKey}`,
      FATHOM_CHAIN_KEY: `file://${chainKey}`,
      FATHOM_OPERATOR_NOTICE_ADDRESS: ADDRESS,
      FATHOM_BOOTSTRAP_TOKEN_FILE: tokenFile,
      FATHOM_BIND: `127.0.0.1:${PORT}`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverLog = '';
  serverProc.stdout.on('data', (d) => {
    serverLog += d.toString();
  });
  serverProc.stderr.on('data', (d) => {
    serverLog += d.toString();
  });

  try {
    const health = await waitForHttp(`${OLD_URL}/health`);
    check('the merged server answers /health with the built client behind it', health.status === 200);
  } catch (e) {
    console.log(serverLog.slice(-3000));
    throw e;
  }

  const token = readFileSync(tokenFile, 'utf8').trim().replace(/^op[_-]/i, '');

  const { chromium } = await import(PLAYWRIGHT);
  const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
  const context = await browser.newContext({ viewport: { width: 1280, height: 1400 } });
  const page = await context.newPage();
  const consoleErrors = [];
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text());
  });
  const shot = async (name) => {
    const path = join(SHOTS, `${name}.png`);
    await page.screenshot({ path, fullPage: true });
    console.log(`     shot ${path}`);
    return path;
  };

  // ---- step 0: the prerequisites, in the page -----------------------------
  await page.goto(`${OLD_URL}/`, { waitUntil: 'networkidle' });
  const bootstrap = await page.evaluate(PREREQUISITES, { token, address: ADDRESS, credential: CREDENTIAL });
  check(
    'the first operator has a password, an app code, ten backup codes and an operator key',
    /^[0-9A-Z]{26}$/.test(bootstrap.operatorId) && bootstrap.backupCodes === 10,
    `${bootstrap.operatorId}, ${bootstrap.backupCodes} backup codes`,
  );

  // ---- step 1: the built client signs the operator in ---------------------
  await page.goto(`${OLD_URL}/`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.signin__identity', { timeout: 10000 });
  await shot('01-signin-lists-the-operator');
  await page.click('.signin__identity');
  await page.waitForSelector('.console', { timeout: 15000 });
  await page.waitForTimeout(800);
  const bannerText = await page.locator('.console-banner').innerText().catch(() => '');
  check(
    'the notices banner shows the one-operator fact from GET /admin/notices',
    /independent/.test(bannerText) && /recover-operator/.test(bannerText),
    bannerText.slice(0, 120).replace(/\n/g, ' '),
  );
  const registerText = await page.locator('.console__table').last().innerText().catch(() => '');
  check(
    "the register carries the operator's address of record",
    registerText.includes(ADDRESS),
    registerText.slice(0, 160).replace(/\n/g, ' '),
  );
  await shot('02-console-notices-and-register');

  // ---- step 2: the SMTP form ----------------------------------------------
  await page.fill('#smtp-host', 'smtp.example.test');
  await page.fill('#smtp-port', '587');
  await page.selectOption('#smtp-tls', 'starttls');
  await page.fill('#smtp-user', 'fathom');
  await page.fill('#smtp-password', 'hunter2-hunter2-hunter2');
  await page.fill('#smtp-from', 'fathom@example.test');
  await page.click('text=Save the mail settings');
  await page.waitForSelector('text=in effect at', { timeout: 15000 });
  const savedText = await page.locator('form:has(#smtp-host)').innerText();
  check('the SMTP form saved a sealed value and was told when it takes effect', /in effect at/.test(savedText));
  await shot('03-smtp-saved');
  await page.click('text=Send a test to my own address');
  await page.waitForSelector("text=mail sending is not built yet", { timeout: 15000 });
  const testText = await page.locator('form:has(#smtp-host)').innerText();
  check(
    "the test send shows the server's own 503 sentence",
    testText.includes('mail sending is not built yet'),
  );
  await shot('04-smtp-test-send-503');

  // ---- step 3: the placement warning, save, countdown and redirect --------
  await page.fill('#placement-hosts', 'localhost');
  await page.fill('#placement-window', '1');
  await page.click('text=Review this move');
  await page.waitForSelector('.console__warnlist', { timeout: 10000 });
  const warning = await page.locator('.console__warnlist').innerText();
  check('the warning names the new host', warning.includes('localhost'));
  check('the warning names this host, which stops answering', warning.includes(OLD_HOST));
  check('the warning names the window', /one minute/.test(warning));
  check('the warning says what happens if nobody signs in there', /reverts/.test(warning));
  check(
    'the warning says what an empty source list is stored as',
    warning.includes('0.0.0.0/0,::/0'),
  );
  await shot('05-placement-warning');

  await page.click('text=Move the console to localhost');
  await page.waitForSelector('[data-testid="placement-countdown"]', { timeout: 15000 });
  const countdown = await page.locator('[data-testid="placement-countdown"]').innerText();
  // A one-minute window, read off the server's own `confirm_by`. One second
  // over is the clock this page started its tick on, not a longer window:
  // the deadline is a whole second and the browser reads it from a
  // millisecond clock, so 1:01 is the honest display of 60.4 seconds left.
  const [mm, ss] = countdown.split(':').map(Number);
  check(
    'the countdown is running off the deadline the server sent',
    mm * 60 + ss > 0 && mm * 60 + ss <= 61,
    countdown,
  );
  await shot('06-placement-countdown');

  const movedAt = Date.now();
  const flagOld = await flagAs(OLD_HOST);
  const flagNew = await flagAs(NEW_HOST);
  check('the console stops answering on the old host at once', flagOld.verdict === 'no', JSON.stringify(flagOld));
  check(
    'the new host answers, with the deadline of a placement waiting to be confirmed',
    flagNew.verdict === 'yes' && typeof flagNew.deadline === 'number',
    JSON.stringify(flagNew),
  );

  await page.waitForURL(`${NEW_URL}/`, { timeout: 20000 });
  await page.waitForTimeout(1000);
  check('the browser was taken to the new host', page.url().startsWith(NEW_URL), page.url());
  await shot('07-landed-on-the-new-host');

  // ---- step 4: decision 9's absence on a host the console does not answer --
  // The operator sign-in itself is not gated by `admin_exposure` (the build
  // contracts' open issue 8), so this is reachable: the client signs in and
  // then offers nothing, because `useConsoleHost()` said no.
  await page.goto(`${OLD_URL}/`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.signin__identity', { timeout: 10000 });
  await page.click('.signin__identity');
  await page.waitForSelector('.console__absent', { timeout: 15000 });
  const absent = await page.locator('.console').innerText();
  check(
    'an operator session on a non-console host renders no operator control at all',
    (await page.locator('.console form').count()) === 0 &&
      (await page.locator('.console button').count()) === 0,
    `${await page.locator('.console form').count()} forms, ${await page.locator('.console button').count()} buttons`,
  );
  check('and it says where the console went', /does not answer on/.test(absent));
  await shot('08-operator-controls-absent-off-host');

  // ---- step 5: the revert --------------------------------------------------
  const waitMs = Math.max(0, 62_000 - (Date.now() - movedAt));
  console.log(`==> waiting ${Math.round(waitMs / 1000)}s for the one-minute window to run out unconfirmed`);
  await new Promise((r) => setTimeout(r, waitMs));
  const flagNewAfter = await flagAs(NEW_HOST);
  const flagOldAfter = await flagAs(OLD_HOST);
  check(
    'after the window the new host no longer carries a pending deadline',
    flagNewAfter.deadline === null,
    JSON.stringify(flagNewAfter),
  );
  check(
    'the console answers again on the host it was moved off',
    flagOldAfter.verdict === 'yes',
    JSON.stringify(flagOldAfter),
  );

  await page.goto(`${OLD_URL}/`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.signin__identity', { timeout: 10000 });
  await page.click('.signin__identity');
  await page.waitForSelector('.console__section', { timeout: 15000 });
  await page.waitForTimeout(500);
  check(
    'and the real console renders there again',
    (await page.locator('#placement-hosts').count()) === 1,
  );
  await shot('09-console-answers-again-after-the-revert');

  // The revert is a sealed record, not only a clock: the sweep writes it on
  // the next console request, which the sign-in above just made.
  await page.waitForTimeout(500);
  const reverted = sh(
    'psql',
    [
      '-h', '127.0.0.1', '-U', 'postgres', '-d', DB_NAME, '-tAc',
      "SELECT revert_reason FROM console_placements ORDER BY requested_at DESC LIMIT 1",
    ],
    { allowFailure: true },
  ).stdout.trim();
  check('the revert is recorded on the row', reverted === 'window_expired', reverted || '(empty)');

  const entries = sh(
    'psql',
    [
      '-h', '127.0.0.1', '-U', 'postgres', '-d', DB_NAME, '-tAc',
      "SELECT entry_type FROM chain_entries WHERE entry_type LIKE 'console_placement%' ORDER BY seq",
    ],
    { allowFailure: true },
  ).stdout.trim().split('\n').filter(Boolean);
  check(
    'and sealed on the site trail as requested, then reverted',
    entries[0] === 'console_placement_requested' &&
      entries.slice(1).every((e) => e === 'console_placement_reverted') &&
      entries.length >= 2,
    entries.join(','),
  );
  // Reported rather than smoothed over: `PlacementStore::revert_all` selects
  // the expired rows with no `FOR UPDATE`, and the console's first page makes
  // three `/admin` requests at once, each of which runs the sweep through
  // `confirm_on_the_new_host`. Two of them can select the same row and both
  // append `console_placement_reverted`, so ONE revert can be sealed twice.
  // Harmless to the gate (the row is reverted either way) and wrong on the
  // trail. Stream (c)'s to fix; named here because this drive is what found
  // it.
  if (entries.filter((e) => e === 'console_placement_reverted').length > 1) {
    console.log(
      `     note: one revert was sealed ${entries.length - 1} times — placement.rs::revert_all has no FOR UPDATE ` +
        'and the sweep runs on every console request',
    );
  }

  if (consoleErrors.length) {
    console.log('  browser console output (errors):');
    for (const line of consoleErrors.slice(0, 10)) console.log(`    ${line}`);
  }
  check('no uncaught exception in the browser', pageErrors.length === 0, pageErrors.join(' | '));
  // The one expected resource error is the test-send's 503, which is the
  // product behaving as built. Anything else -- a 404 from a console request
  // made where the console does not answer, say -- is this client asking for
  // something it was told not to.
  const unexpected = consoleErrors.filter((line) => !/503/.test(line));
  check(
    'the only failed request in the whole drive is the test-send 503',
    unexpected.length === 0,
    unexpected.join(' | '),
  );

  await browser.close();
}

try {
  await main();
} catch (error) {
  failures += 1;
  console.error(error);
} finally {
  stopServer();
  psql(`DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE);`, { allowFailure: true });
}
console.log(failures === 0 ? '\nOK: every check passed' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
