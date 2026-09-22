// Drive the REAL built client's operator console against a REAL server:
// ADR-0055 client stream (b), over the screens ADR-0056 gave the first run
// and the door.
//
//   node scripts/drive-console-placement.mjs
//
// What it proves, in one browser, in this order:
//
//   0. `GET /setup/state` says `pending` on a fresh install, the client shows
//      the first-run flow and no door, and the flow walks from the token file
//      to Home: the token (checked, not spent), the password for the address
//      the server named, the authenticator app with its QR code and setup
//      key, the ten recovery codes behind the checkbox that gates Done, and
//      the sign-in with the new authenticator. Then `/setup/state` says
//      `done` (ADR-0056 decisions 1, 2, 4 and 5);
//   1. the Site entry opens the console on the FIRST press, and the notices
//      banner shows the one-operator fact off `GET /admin/notices`;
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
//      again on the host it was moved off, reached by a two-step sign-in at
//      the ordinary door (ADR-0056 decision 3), and the client works there.
//
// **There is no hand port left.** This script used to speak the
// prerequisites -- password, second factor, browser key, operator key -- in
// the page, because ADR-0055 landed the console before any rendered surface
// called them. ADR-0056's first-run flow is that surface, so step 0 is now
// the client's own screens end to end and the only bytes computed here are
// the six digits of a verification code, exactly as
// `scripts/ci/first-operator-signin.mjs` computes them.
//
// **The first-run and door half is addressed by ids, roles and structure; the
// console half is only partly.** The sign-in and first-run screens are reached
// through `#firstrun-*`, `#signin-*`, `[role=checkbox]` and their
// `data-testid`s, so the copy there -- which ADR-0056 decision 4 is still
// renaming -- can be improved without breaking this drive. The console's
// FIELDS have ids (`#smtp-*`, `#placement-*`), its countdown a `data-testid`,
// and its buttons and answers are reached through those and the classes around
// them; but the WORDING of the warning list, the test-send answer and the
// absence notice is still what this drive matches on, because the markup
// offers nothing else to hold. That is a gap in the console markup, not a
// choice made here; the client is not this drive's to change. 2026-09-22.
//
// It needs: PostgreSQL on 127.0.0.1 with the `fathom_test`/`postgres` roles,
// a built client (`cd client && npm ci --ignore-scripts && npm run build`),
// the `fathom-server` binary (`cargo build -p fathom-server`), and
// Playwright's Chromium. It builds neither. It creates its own database and
// drops it, and it kills the server by PORT.

import { spawn, spawnSync } from 'node:child_process';
import http from 'node:http';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath, URL } from 'node:url';

const ROOT = process.env.FATHOM_ROOT ?? fileURLToPath(new URL('..', import.meta.url));
// `CARGO_TARGET_DIR` is set per worktree in this project, so the binary is
// not always under ./target -- and the one this drive wants is the one built
// beside the client it is driving.
const TARGET_DIR = process.env.CARGO_TARGET_DIR ?? join(ROOT, 'target');
const SERVER_BIN = process.env.FATHOM_SERVER_BIN ?? join(TARGET_DIR, 'debug', 'fathom-server');
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

/** The first field of a length-prefixed answer, as text. */
function firstField(bytes) {
  const len = new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, true);
  return new TextDecoder().decode(bytes.slice(4, 4 + len));
}

/**
 * `GET /setup/state` — ADR-0056 decision 1's one bit about the deployment:
 * `pending` while the first operator has no stored password, `done`
 * afterwards, for ever. Asked from outside the browser, so the answer is the
 * server's own and not this page's memory of it.
 */
async function setupState(baseUrl) {
  const response = await fetch(`${baseUrl}/setup/state`);
  if (response.status !== 200) return `HTTP ${response.status}`;
  return firstField(new Uint8Array(await response.arrayBuffer()));
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

// --- the authenticator app, in Node (RFC 6238, as credentials.rs) ----------

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
  const key = await webcrypto.subtle.importKey('raw', secretBytes, { name: 'HMAC', hash: 'SHA-1' }, false, [
    'sign',
  ]);
  const counter = new Uint8Array(8);
  new DataView(counter.buffer).setBigUint64(0, BigInt(step), false);
  const tag = new Uint8Array(await webcrypto.subtle.sign('HMAC', key, counter));
  const offset = tag[tag.length - 1] & 0x0f;
  const binary =
    ((tag[offset] & 0x7f) << 24) | (tag[offset + 1] << 16) | (tag[offset + 2] << 8) | tag[offset + 3];
  return String(binary % 1000000).padStart(6, '0');
}
const currentStep = () => Math.floor(Date.now() / 1000 / 30);

/** A code for a step this run has not spent yet. `credentials::verify_totp`
 * accepts a code once, so the drive waits for the clock rather than sending
 * one it knows is spent. */
async function freshCode(secret, spentSteps) {
  for (;;) {
    const step = currentStep();
    if (!spentSteps.has(step)) {
      spentSteps.add(step);
      return totpCode(secret, step);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
}

// --- the two screens every part of this drive goes through -----------------

/**
 * The first run, through the client's own steps (ADR-0056 decision 2).
 *
 * Ids, roles and structure only. Hands back the setup key and the ten
 * recovery codes, which the rest of the drive signs in with.
 */
async function walkTheFirstRun(page, { token, address, password, spent, shot }) {
  await page.waitForSelector('#firstrun-token', { timeout: 20000 });
  check(
    'a pending deployment shows the first-run flow and no sign-in door',
    (await page.locator('#signin-password').count()) === 0,
  );
  await page.fill('#firstrun-token', token);
  await page.click('form.signin__card button[type=submit]');

  await page.waitForSelector('#firstrun-password', { timeout: 20000 });
  const shown = await page.inputValue('#firstrun-address');
  const readOnly = await page.locator('#firstrun-address').evaluate((el) => el.readOnly);
  check(
    'the token step spends nothing and the password step SHOWS the address it belongs to',
    shown === address && readOnly,
    `${shown}${readOnly ? ', read-only' : ', EDITABLE'}`,
  );
  await page.fill('#firstrun-password', password);
  await page.fill('#firstrun-password-again', password);
  await page.click('form.signin__card button[type=submit]');

  // The enrolment screen opens on a button, because drawing a secret is an
  // act. If a later build draws it on arrival, nothing is pressed.
  await page.waitForSelector('.signin__section', { timeout: 25000 });
  if ((await page.locator('[data-testid="totp-secret"]').count()) === 0) {
    await page.click('.signin__section button.signin__submit');
  }
  await page.waitForSelector('[data-testid="totp-secret"]', { timeout: 20000 });

  // ADR-0056 decision 5: inline SVG in the page, so `img-src` does not move
  // — and no `style` attribute on it, because `style-src-attr 'unsafe-inline'`
  // is the allowance decision 7 wants measured rather than leaned on.
  const qr = await page.locator('[data-testid="qr"]').evaluate((el) => ({
    tag: el.tagName.toLowerCase(),
    style: el.getAttribute('style'),
    modules: el.querySelector('.qr__modules')?.getAttribute('d')?.length ?? 0,
  }));
  check(
    'the authenticator screen draws a real QR code as inline SVG, with no style attribute on it',
    qr.tag === 'svg' && qr.style === null && qr.modules > 200,
    `<${qr.tag}> style=${JSON.stringify(qr.style)}, ${qr.modules} characters of path`,
  );

  const secretText = (await page.locator('[data-testid="totp-secret"]').innerText()).trim();
  // `textContent`, not `innerText`: the otpauth link sits in a closed
  // `<details>`, and a closed element renders no text.
  const otpauth = ((await page.locator('[data-testid="totp-uri"]').textContent()) ?? '').trim();
  check(
    'and shows the setup key beside it, with the otpauth URI for whoever wants it',
    /^[A-Z2-7]{16,}$/.test(secretText) && otpauth.startsWith('otpauth://totp/'),
    `${secretText.slice(0, 8)}…`,
  );
  if (shot) await shot('01-the-authenticator-step');

  const secret = base32Decode(secretText);
  await page.fill('#account-code', await freshCode(secret, spent));
  await page.click('form.signin__section:has(#account-code) button[type=submit]');

  await page.waitForSelector('.authenticator__codes', { timeout: 25000 });
  const recoveryCodes = await page.locator('.authenticator__code').allInnerTexts();
  check('ten recovery codes, shown once', recoveryCodes.length === 10, `${recoveryCodes.length}`);
  const done = page.locator('.signin__section:has(.authenticator__codes) button.signin__submit');
  const gated = await done.isDisabled();
  const box = page.locator('[role="checkbox"]');
  check(
    'the recovery codes gate Done: unchecked, it is disabled, and the checkbox says so',
    gated && (await box.getAttribute('aria-checked')) === 'false',
    gated ? 'disabled until the box is checked' : 'Done was live with the box unchecked',
  );
  if (shot) await shot('02-the-recovery-codes');
  await box.click();
  check(
    'and checking it arms Done',
    !(await done.isDisabled()) && (await box.getAttribute('aria-checked')) === 'true',
  );
  await done.click();

  await page.waitForSelector('#firstrun-code', { timeout: 20000 });
  await page.fill('#firstrun-code', await freshCode(secret, spent));
  await page.click('form.signin__card button[type=submit]');

  await page.waitForSelector('.home', { timeout: 30000 });
  check('the first run ends signed in on Home, not at the door', true);

  return { secret, recoveryCodes };
}

/** Wait for something this script can only learn from an event. */
async function waitUntil(predicate, timeoutMs = 10000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return predicate();
}

/**
 * The ordinary door, in the two steps of ADR-0056 decision 3.
 *
 * **The two steps are asserted against the SERVER's answers, not against the
 * markup alone** (2026-09-22). Looking for `#signin-code` only after step one
 * was submitted could not fail: the one-page door this replaced carried that
 * id on the same form as the password, so a client that had not moved at all
 * would have passed. So this watches `POST /session` for the whole sign-in and
 * asserts, in order: no code field on the password screen; exactly one
 * `POST /session` in step one, answered 401 with the server's
 * "second factor needed"; the code field drawn only then; and exactly one more
 * `POST /session`, answered 200, which is the session.
 */
async function signInThroughTheDoor(page, { address, password, code, label }) {
  const answers = [];
  const watch = (response) => {
    if (response.request().method() !== 'POST') return;
    if (new URL(response.url()).pathname !== '/session') return;
    // The body is read lazily: if some later build streams it away, an
    // unreadable body must not break the drive.
    answers.push({ status: response.status(), body: response.text().catch(() => null) });
  };
  page.on('response', watch);
  try {
    await page.waitForSelector('#signin-password', { timeout: 20000 });
    const codeFieldBefore = await page.locator('#signin-code').count();
    await page.fill('#signin-address', address);
    await page.fill('#signin-password', password);
    await page.click('form.signin__card button[type=submit]');
    await page.waitForSelector('#signin-code, .home, .signin__refusal', { timeout: 30000 });
    await waitUntil(() => answers.length >= 1);
    const codeFieldAfter = await page.locator('#signin-code').count();
    const probeBody = answers.length === 0 ? '' : ((await answers[0].body) ?? '').trim();

    check(
      `${label}: step one is the address and the password alone — the code field is not on that screen`,
      codeFieldBefore === 0,
      codeFieldBefore === 0 ? 'no #signin-code before step one was sent' : 'the password screen already carried #signin-code',
    );
    check(
      `${label}: the password alone is answered "second factor needed" — one POST /session, 401 — and the code field appears only then`,
      answers.length === 1 &&
        answers[0].status === 401 &&
        codeFieldAfter === 1 &&
        // The body, when the browser still holds it: the server's own typed
        // sentence, so this cannot pass on some other 401.
        (probeBody === '' || probeBody === 'second factor needed'),
      `${answers.length} POST /session [${answers.map((a) => a.status).join(', ')}], ` +
        `${codeFieldAfter} code field(s), body ${JSON.stringify(probeBody.slice(0, 40))}`,
    );

    const twoStep = codeFieldBefore === 0 && codeFieldAfter === 1 && answers.length === 1 && answers[0].status === 401;
    if (codeFieldAfter === 1) {
      await page.fill('#signin-code', code);
      await page.click('form.signin__card button[type=submit]');
    }
    await page.waitForSelector('.home', { timeout: 30000 });
    await waitUntil(() => answers.length >= 2);
    const completion = answers[answers.length - 1];
    check(
      `${label}: step two re-posts the same challenge and THAT request is the one that issues a session (200)`,
      answers.length === 2 && completion.status === 200,
      answers.map((a) => a.status).join(' then '),
    );
    return { twoStep, statuses: answers.map((a) => a.status) };
  } finally {
    page.off('response', watch);
  }
}

/**
 * Sign in as the operator with the key this browser already holds.
 *
 * The door lists the identities a browser has a key for, and pressing an
 * operator's signs in on the spot (it is a key sign-in and carries no
 * password). The row is found by the operator ID it shows, not by the word
 * beside it: the id is what this drive already knows, and the word is copy.
 */
async function signInAsTheOperator(page, operatorId) {
  await page.waitForSelector('.signin__identity', { timeout: 20000 });
  const row = page.locator('.signin__identity', {
    has: page.locator('.signin__identity-id', { hasText: operatorId }),
  });
  await row.first().click();
}

// ---------------------------------------------------------------------------

async function main() {
  if (!existsSync(join(ROOT, 'client', 'dist', 'index.html'))) {
    throw new Error('no built client. Run: cd client && npm ci --ignore-scripts && npm run build');
  }
  if (!existsSync(SERVER_BIN)) {
    throw new Error(`no server binary at ${SERVER_BIN}. Run: cargo build -p fathom-server --locked`);
  }

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

  const token = readFileSync(tokenFile, 'utf8').trim();

  const { chromium } = await import(PLAYWRIGHT);
  const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
  const context = await browser.newContext({ viewport: { width: 1280, height: 1400 } });
  const page = await context.newPage();
  const consoleErrors = [];
  const pageErrors = [];
  // Every refused response, as a record and not as a console sentence: the
  // gate at the end names an allowed SET by method, path and status. Filtering
  // console lines by the status in them hid every 401 from every route, which
  // is what this replaces (2026-09-22).
  const failed = [];
  page.on('pageerror', (e) => pageErrors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text());
  });
  page.on('response', (r) => {
    if (r.status() < 400) return;
    failed.push({ method: r.request().method(), status: r.status(), pathname: new URL(r.url()).pathname });
  });
  const shot = async (name) => {
    const path = join(SHOTS, `${name}.png`);
    await page.screenshot({ path, fullPage: true });
    console.log(`     shot ${path}`);
    return path;
  };

  // ---- step 0: the first run, through the client's own screens ------------
  const stateBefore = await setupState(OLD_URL);
  check(
    'GET /setup/state says pending on a fresh install (ADR-0056 decision 1)',
    stateBefore === 'pending',
    stateBefore,
  );

  const spent = new Set();
  await page.goto(`${OLD_URL}/`, { waitUntil: 'networkidle' });
  const { recoveryCodes } = await walkTheFirstRun(page, {
    token,
    address: ADDRESS,
    password: CREDENTIAL,
    spent,
    shot,
  });
  await shot('03-home-after-the-first-run');

  const stateAfter = await setupState(OLD_URL);
  check(
    'and GET /setup/state has moved to done — one bit, about the deployment, for ever',
    stateAfter === 'done',
    stateAfter,
  );

  // ---- step 1: the Site entry, and the console ----------------------------
  await page.waitForSelector('[data-testid="console-entry"]', { timeout: 15000 });
  await page.click('[data-testid="console-entry"]');
  await page.waitForSelector('.console__section', { timeout: 25000 });
  await page.waitForTimeout(800);
  check(
    'the console opened on the FIRST press: the first run ended on a session that had proved the second factor',
    (await page.locator('.console-entry__refusal').count()) === 0,
  );
  const operatorId = (await page.locator('.console__id').innerText()).trim();
  check('and the console names the operator id', /^[0-9A-HJKMNP-TV-Z]{26}$/.test(operatorId), operatorId);
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
  await shot('04-console-notices-and-register');

  // ---- step 2: the SMTP form ----------------------------------------------
  await page.fill('#smtp-host', 'smtp.example.test');
  await page.fill('#smtp-port', '587');
  await page.selectOption('#smtp-tls', 'starttls');
  await page.fill('#smtp-user', 'fathom');
  await page.fill('#smtp-password', 'hunter2-hunter2-hunter2');
  await page.fill('#smtp-from', 'fathom@example.test');
  const smtpForm = page.locator('form:has(#smtp-host)');
  await smtpForm.locator('button[type=submit]').click();
  // The saved change, by structure: the form draws the change id in a `<code>`
  // once the server has sealed it.
  await smtpForm.locator('.console__muted code').first().waitFor({ timeout: 15000 });
  const smtpChange = (await smtpForm.locator('.console__muted code').first().innerText()).trim();
  check(
    'the SMTP form saved a sealed value and was told when it takes effect',
    smtpChange.length > 0,
    `change ${smtpChange}`,
  );
  await shot('05-smtp-saved');
  // The test-send button is the form's only non-submit button, and it is only
  // there once a change has been saved.
  await smtpForm.locator('button[type=button]').click();
  // Here the SENTENCE is the assertion: the point of this check is that the
  // board repeats the SERVER's words rather than inventing cheerful ones, so
  // there is nothing else to match on.
  await page.waitForSelector('text=mail sending is not built yet', { timeout: 15000 });
  const testText = await smtpForm.innerText();
  check(
    "the test send shows the server's own 503 sentence",
    testText.includes('mail sending is not built yet'),
  );
  await shot('06-smtp-test-send-503');

  // ---- step 3: the placement warning, save, countdown and redirect --------
  await page.fill('#placement-hosts', 'localhost');
  await page.fill('#placement-window', '1');
  await page.locator('form:has(#placement-hosts) button[type=submit]').click();
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
  await shot('07-placement-warning');

  // The confirm button of the warning block, by structure: the two buttons
  // there are the move and the way back, and the quiet one is the way back.
  await page
    .locator('.console__form:has(.console__warnlist) .console__row button:not(.console__btn--quiet)')
    .click();
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
  await shot('08-placement-countdown');

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
  await shot('09-landed-on-the-new-host');

  // ---- step 4: decision 9's absence on a host the console does not answer --
  // The operator sign-in itself is not gated by `admin_exposure` (the build
  // contracts' open issue 8), so this is reachable: the client signs in with
  // the operator key this browser filed when the console entry was pressed,
  // and then offers nothing, because `useConsoleHost()` said no.
  await page.goto(`${OLD_URL}/`, { waitUntil: 'networkidle' });
  await signInAsTheOperator(page, operatorId);
  await page.waitForSelector('.console__absent', { timeout: 15000 });
  const absent = await page.locator('.console').innerText();
  check(
    'an operator session on a non-console host renders no operator control at all',
    (await page.locator('.console form').count()) === 0 &&
      (await page.locator('.console button').count()) === 0,
    `${await page.locator('.console form').count()} forms, ${await page.locator('.console button').count()} buttons`,
  );
  check('and it says where the console went', /does not answer on/.test(absent));
  await shot('10-operator-controls-absent-off-host');

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

  // Back in at the ordinary door, which is now two steps: a recovery code
  // goes in the same field the verification code does (ADR-0056 decisions 3
  // and 4), and the person who reaches for one has lost their phone.
  await page.goto(`${OLD_URL}/`, { waitUntil: 'networkidle' });
  const backDoor = await signInThroughTheDoor(page, {
    address: ADDRESS,
    password: CREDENTIAL,
    code: recoveryCodes[0],
    label: 'the sign-in after the revert',
  });
  check(
    'a later sign-in is the two-step door, and its second step takes a RECOVERY code',
    backDoor.twoStep,
    `one field, two kinds of code — POST /session: ${backDoor.statuses.join(' then ')}`,
  );
  await page.waitForSelector('[data-testid="console-entry"]', { timeout: 20000 });
  await page.click('[data-testid="console-entry"]');
  await page.waitForSelector('.console__section', { timeout: 20000 });
  await page.waitForTimeout(500);
  check(
    'and the real console renders there again',
    (await page.locator('#placement-hosts').count()) === 1,
  );
  await shot('11-console-answers-again-after-the-revert');

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
    console.log('  browser console output (errors), for information only:');
    for (const line of consoleErrors.slice(0, 10)) console.log(`    ${line}`);
  }
  check('no uncaught exception in the browser', pageErrors.length === 0, pageErrors.join(' | '));
  // **The allowed set of refused responses, named exactly**, by method, path
  // and status. Two answers here are the product behaving as built:
  //
  //   * `POST /admin/settings/{change}/test-send` → 503, the mail test send
  //     saying mail is not built yet. Once, because it is pressed once.
  //   * `POST /session` → 401, ADR-0056 decision 3's second-factor probe: a
  //     step in a two-step sign-in and not a failed one (the server rolls
  //     back, writes no entry and leaves the nonce unspent; it charges the
  //     source bucket and nothing else). Exactly one per two-step sign-in,
  //     and this drive makes TWO_STEP_SIGN_INS of them. The first run's last
  //     step sends the code with the password, so it never reaches the probe,
  //     and the operator's key sign-in carries its evidence at once.
  //
  // Anything else -- a 404 from a console request made where the console does
  // not answer, say -- is this client asking for something it was told not to,
  // and it fails the drive whatever status it wears.
  const TWO_STEP_SIGN_INS = 1;
  const say = (f) => `${f.method} ${f.pathname} → ${f.status}`;
  const isProbe = (f) => f.method === 'POST' && f.pathname === '/session' && f.status === 401;
  const isTestSend = (f) =>
    f.method === 'POST' && f.status === 503 && /^\/admin\/settings\/[^/]+\/test-send$/.test(f.pathname);
  const probes = failed.filter(isProbe);
  const testSends = failed.filter(isTestSend);
  const unexpected = failed.filter((f) => !isProbe(f) && !isTestSend(f));
  check(
    'the mail test send is refused 503 exactly once, on the route the form posts to',
    testSends.length === 1,
    `${testSends.length}: ${testSends.map(say).join(' | ')}`,
  );
  check(
    'every 401 in the drive is the second-factor probe on POST /session, one per two-step sign-in',
    probes.length === TWO_STEP_SIGN_INS,
    `${probes.length} of an expected ${TWO_STEP_SIGN_INS}: ${probes.map(say).join(' | ')}`,
  );
  check(
    'and no other request in the whole drive was refused',
    unexpected.length === 0,
    unexpected.slice(0, 8).map(say).join(' | '),
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
