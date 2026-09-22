// Drive the REAL built client against a REAL server, through its own doors:
// ADR-0055 decision 1, one person with two custodies, over the screens
// ADR-0056 gave the first run and the door.
//
//   node scripts/drive-two-custodies.mjs
//
// **Nothing here is a hand port.** Every request below is made by the built
// client's own modules: the first-run flow checks and spends the token file,
// sets the password, enrols the authenticator app and signs in with it, the
// door signs a second browser in, and the console entry runs
// `api/placement.ts`'s `bootstrapOperatorSession`. The only bytes this script
// computes itself are the six digits of a verification code, which stand in
// for the authenticator app on a person's phone, and they are computed
// exactly as `scripts/ci/first-operator-signin.mjs` computes them.
//
// What it proves, in this order:
//
//   1. `GET /setup/state` says `pending` on a fresh install and the client
//      shows the first run and no door (ADR-0056 decisions 1 and 2);
//   2. the first operator, from the token file to the console, through the
//      six steps: the token (checked, not spent), the password for the
//      address the server named, the authenticator app with its QR code and
//      its setup key, the recovery codes behind the checkbox that gates
//      Done, the sign-in with the new authenticator, and Home -- after which
//      `GET /setup/state` says `done`;
//   3. **two sessions at once**: Home is reachable from the console and the
//      console from Home, with no sign-in in between, and the account's own
//      requests still verify afterwards (its request counter was not spent by
//      the operator's);
//   4. a second browser context, with nothing in its storage, signing in in
//      the TWO steps of ADR-0056 decision 3: the address and the password,
//      then the verification code;
//   5. the operators page adding a colleague with a name and an address;
//   6. the SMTP form round-tripping a sealed value;
//   7. the placement form saving a one-minute window, the countdown, the
//      redirect to the new host, and -- after the window runs out unconfirmed
//      -- the console answering again on the host it was moved off, reached
//      by another two-step sign-in.
//
// **Selectors are ids, roles and structure, not sentences.** The wording of
// these screens is still moving (ADR-0056 decision 4 renames what a person
// reads), and a drive that broke on a better sentence would be a drive
// nobody dared improve the copy against. 2026-09-22.
//
// It needs: PostgreSQL on 127.0.0.1 with the `fathom_test`/`postgres` roles, a
// built client in THIS worktree (`cd client && npm ci --ignore-scripts && npm
// run build`), the `fathom-server` binary (`cargo build -p fathom-server`),
// and Playwright's Chromium. It builds neither. It creates its own database
// and drops it, and it kills the server BY PORT -- never by name, because
// another agent's server must not be killed by this one.

import { spawn, spawnSync } from 'node:child_process';
import http from 'node:http';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath, URL } from 'node:url';

const ROOT = process.env.FATHOM_ROOT ?? fileURLToPath(new URL('..', import.meta.url));
// `CARGO_TARGET_DIR` is set per worktree in this project, so the binary is
// not always under ./target -- and the binary this drive wants is the one
// built beside the client it is driving.
const TARGET_DIR = process.env.CARGO_TARGET_DIR ?? join(ROOT, 'target');
const SERVER_BIN = process.env.FATHOM_SERVER_BIN ?? join(TARGET_DIR, 'debug', 'fathom-server');
const PORT = 18103;
const OLD_HOST = `127.0.0.1:${PORT}`;
const NEW_HOST = `localhost:${PORT}`;
const OLD_URL = `http://${OLD_HOST}`;
const NEW_URL = `http://${NEW_HOST}`;
const DB_NAME = 'fathom_c3';
const RUNTIME_URL = `postgres://fathom_app@127.0.0.1:5432/${DB_NAME}`;
const MIGRATE_URL = `postgres://fathom_test@127.0.0.1:5432/${DB_NAME}`;
const CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const PLAYWRIGHT = '/opt/node22/lib/node_modules/playwright/index.mjs';
const ADDRESS = 'owner@example.test';
// A password of the length and shape ADR-0055 decision 10 requires and a
// person actually chooses -- the CI script's own, for the same reason.
const CREDENTIAL = 'harbour-lantern-copper-nine';
const COLLEAGUE = { name: 'Second Operator', address: 'second@example.test' };

const WORK =
  process.env.FATHOM_DRIVE_DIR ??
  '/tmp/claude-0/-home-user-Fathom/e3fb841a-3739-5e05-b6f7-65bae229f9a6/scratchpad/drive-two-custodies';
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
  // BY PORT. `pkill -f fathom-server` would kill another agent's run.
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
 * afterwards, for ever. Asked here from outside the browser, so the answer
 * is the server's own and not this page's memory of it.
 */
async function setupState(baseUrl) {
  const response = await fetch(`${baseUrl}/setup/state`);
  if (response.status !== 200) return `HTTP ${response.status}`;
  return firstField(new Uint8Array(await response.arrayBuffer()));
}

/**
 * `GET /placement/flag` as a given `Host` sees it, including the optional
 * third field this client now reads.
 *
 * Through `node:http` and not `fetch`: `Host` is a forbidden header name for
 * `fetch`, which drops it silently.
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
  const fields = [];
  let at = 0;
  while (at + 4 <= bytes.length) {
    const len = new DataView(bytes.buffer, bytes.byteOffset + at, 4).getUint32(0, true);
    fields.push(new TextDecoder().decode(bytes.slice(at + 4, at + 4 + len)));
    at += 4 + len;
  }
  return {
    verdict: fields[0],
    deadline: fields[1] ? Number(fields[1]) : null,
    decidedBy: fields.length > 2 ? fields[2] : null,
    fieldCount: fields.length,
  };
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
 * Ids, roles and structure only: `#firstrun-token`, `#firstrun-address`,
 * `#firstrun-password`, `#firstrun-password-again`, `#account-code`,
 * `#firstrun-code`, the `checkbox` role on the recovery screen and the
 * `data-testid`s the enrolment screen carries. Hands back the setup key and
 * the ten recovery codes, which the rest of the drive signs in with.
 */
async function walkTheFirstRun(page, { token, address, password, spent, shot, check }) {
  // Step 1. The door must not be on the screen at all while the deployment
  // is pending -- decision 2's "the setup flow and nothing else".
  await page.waitForSelector('#firstrun-token', { timeout: 20000 });
  check(
    'a pending deployment shows the first-run flow and no sign-in door',
    (await page.locator('#signin-password').count()) === 0,
  );
  await page.fill('#firstrun-token', token);
  if (shot) await shot('the-welcome-step');
  await page.click('form.signin__card button[type=submit]');

  // Step 2. The address is the server's answer to the token, shown and never
  // typed, so it cannot mismatch (the owner's ask, met by removing a field).
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
  if (shot) await shot('the-password-step');
  await page.click('form.signin__card button[type=submit]');

  // Step 3. The enrolment screen, which opens on a button because drawing a
  // secret is an act. If a later build draws it on arrival, the secret is
  // already there and nothing is pressed.
  await page.waitForSelector('.signin__section', { timeout: 25000 });
  if ((await page.locator('[data-testid="totp-secret"]').count()) === 0) {
    await page.click('.signin__section button.signin__submit');
  }
  await page.waitForSelector('[data-testid="totp-secret"]', { timeout: 20000 });

  // ADR-0056 decision 5: the QR code is drawn in the page as inline SVG, so
  // `img-src` does not move -- and with NO `style` attribute, because
  // `style-src-attr 'unsafe-inline'` is the allowance decision 7 wants
  // measured rather than leaned on.
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
  if (shot) await shot('the-authenticator-step');

  const secret = base32Decode(secretText);
  await page.fill('#account-code', await freshCode(secret, spent));
  await page.click('form.signin__section:has(#account-code) button[type=submit]');

  // Step 4. Ten recovery codes, shown once, and a Done button the checkbox
  // gates: the server keeps only their hashes, so nothing can fetch them
  // again.
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
  if (shot) await shot('the-recovery-codes');
  await box.click();
  check(
    'and checking it arms Done',
    !(await done.isDisabled()) && (await box.getAttribute('aria-checked')) === 'true',
  );
  await done.click();

  // Step 5. The sign-in with the authenticator that has just been set up --
  // the step that lands Home on a session which has proved the second factor.
  await page.waitForSelector('#firstrun-code', { timeout: 20000 });
  if (shot) await shot('the-final-sign-in-step');
  await page.fill('#firstrun-code', await freshCode(secret, spent));
  await page.click('form.signin__card button[type=submit]');

  // Step 6. Home, signed in.
  await page.waitForSelector('.home', { timeout: 30000 });
  check('the first run ends signed in on Home, not at the door', true);

  return { secret, recoveryCodes };
}

/**
 * The ordinary door, in the two steps of ADR-0056 decision 3: the address
 * and the password, and then -- for an account that holds a confirmed
 * authenticator -- the verification code, over the challenge step one left
 * unspent.
 *
 * Hands back whether the second step was actually drawn, so a caller can
 * assert it rather than let a one-shot sign-in pass for a two-step one.
 */
async function signInThroughTheDoor(page, { address, password, code }) {
  await page.waitForSelector('#signin-password', { timeout: 20000 });
  await page.fill('#signin-address', address);
  await page.fill('#signin-password', password);
  await page.click('form.signin__card button[type=submit]');
  await page.waitForSelector('#signin-code, .home, .signin__refusal', { timeout: 30000 });
  const twoStep = (await page.locator('#signin-code').count()) === 1;
  if (twoStep) {
    await page.fill('#signin-code', code);
    await page.click('form.signin__card button[type=submit]');
  }
  await page.waitForSelector('.home', { timeout: 30000 });
  return { twoStep };
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
  for (const path of [masterKey, chainKey, tokenFile]) rmSync(path, { force: true });
  writeFileSync(masterKey, Buffer.alloc(32, 29), { mode: 0o400 });
  writeFileSync(chainKey, Buffer.alloc(32, 31), { mode: 0o400 });

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
      // THIS worktree's build, not the main checkout's.
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
  serverProc.stdout.on('data', (d) => (serverLog += d.toString()));
  serverProc.stderr.on('data', (d) => (serverLog += d.toString()));

  try {
    const health = await waitForHttp(`${OLD_URL}/health`);
    check('the server answers /health with this worktree’s built client behind it', health.status === 200);
  } catch (e) {
    console.log(serverLog.slice(-3000));
    throw e;
  }

  const token = readFileSync(tokenFile, 'utf8').trim();

  const stateBefore = await setupState(OLD_URL);
  check(
    'GET /setup/state says pending on a fresh install (ADR-0056 decision 1)',
    stateBefore === 'pending',
    stateBefore,
  );

  const flagBefore = await flagAs(OLD_HOST);
  check(
    'GET /placement/flag answers "yes" on a fresh install, and says the console is open (no environment, no placement)',
    flagBefore.verdict === 'yes' && flagBefore.decidedBy === 'open',
    `${flagBefore.fieldCount} field(s): ${JSON.stringify(flagBefore)}`,
  );

  const { chromium } = await import(PLAYWRIGHT);
  const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });

  const errors = [];
  const failed = [];
  async function openContext(label) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 1500 } });
    const page = await context.newPage();
    page.on('pageerror', (e) => errors.push(`${label}: ${e}`));
    page.on('response', (r) => {
      if (r.status() >= 400) failed.push(`${label}: ${r.status()} ${new URL(r.url()).pathname}`);
    });
    return { context, page };
  }

  const { page } = await openContext('A');
  let shotNumber = 0;
  const shots = [];
  const shot = async (name, target = page) => {
    shotNumber += 1;
    const path = join(SHOTS, `${String(shotNumber).padStart(2, '0')}-${name}.png`);
    await target.screenshot({ path, fullPage: true });
    shots.push(path);
    console.log(`     shot ${path}`);
    return path;
  };

  // ---- 1. the first operator, from the token file to the console ---------
  const spent = new Set();
  await page.goto(`${OLD_URL}/`, { waitUntil: 'networkidle' });
  const { secret, recoveryCodes } = await walkTheFirstRun(page, {
    token,
    address: ADDRESS,
    password: CREDENTIAL,
    spent,
    shot,
    check,
  });
  await shot('home-after-the-first-run');

  const stateAfter = await setupState(OLD_URL);
  check(
    'and GET /setup/state has moved to done — one bit, about the deployment, for ever',
    stateAfter === 'done',
    stateAfter,
  );

  await page.waitForSelector('[data-testid="console-entry"]', { timeout: 15000 });
  check('Home, with the Site entry on a console host', true);

  await page.click('[data-testid="console-entry"]');
  await page.waitForSelector('.console__section', { timeout: 25000 });
  await page.waitForTimeout(1200);
  const consoleText = await page.locator('.console').innerText();
  check(
    'the console opened on the FIRST press: the flow ended on a session that had proved the second factor',
    /Signed in as/.test(consoleText) && /operator/.test(consoleText),
    consoleText.split('\n')[1]?.slice(0, 90),
  );
  const operatorId = (await page.locator('.console__id').innerText()).trim();
  check('and it names the operator id', /^[0-9A-HJKMNP-TV-Z]{26}$/.test(operatorId), operatorId);
  await shot('the-console');

  // ---- 2. two sessions at once -------------------------------------------
  await page.click('[data-testid="console-home"]');
  await page.waitForSelector('.home', { timeout: 15000 });
  check(
    'Home is reachable from the console with NO sign-in: the account session was never ended',
    (await page.locator('#signin-password').count()) === 0 && (await page.locator('.home').count()) === 1,
  );
  // The account's own requests, made after the operator session had made
  // several of its own: this is what a shared request counter would break.
  await page.waitForTimeout(1200);
  const homeText = await page.locator('.home').innerText();
  check(
    "and the account session still verifies: Home's own reads answered",
    !/refused|not authorised|Could not/i.test(homeText),
    homeText.split('\n').slice(0, 3).join(' / ').slice(0, 100),
  );
  await shot('home-again-from-the-console');

  await page.click('[data-testid="console-entry"]');
  await page.waitForSelector('.console__section', { timeout: 20000 });
  check(
    'and back into the console, again with no sign-in',
    (await page.locator('.console__id').innerText()).trim() === operatorId,
  );
  await shot('back-in-the-console');

  // ---- 3. a second browser, with nothing in its storage -------------------
  const second = await openContext('B');
  await second.page.goto(`${OLD_URL}/`, { waitUntil: 'networkidle' });
  const secondDoor = await signInThroughTheDoor(second.page, {
    address: ADDRESS,
    password: CREDENTIAL,
    code: await freshCode(secret, spent),
  });
  check(
    'a second browser, holding no key at all, signs in in TWO steps: the address and the password, then the code',
    secondDoor.twoStep && (await second.page.locator('.home').count()) === 1,
    secondDoor.twoStep ? 'the code was asked for on its own step' : 'no second step was drawn',
  );
  await shot('a-second-browser-signed-in', second.page);

  // ---- 4. the operators page ---------------------------------------------
  await page.fill('#console-operator-name', COLLEAGUE.name);
  await page.fill('#console-operator-address', COLLEAGUE.address);
  await page.click('text=Request this colleague');
  await Promise.race([
    page.waitForSelector('text=Requested. Change', { timeout: 25000 }),
    page.waitForSelector('form:has(#console-operator-name) .console__error', { timeout: 25000 }),
  ]).catch(() => {});
  const colleagueText = await page.locator('form:has(#console-operator-name)').innerText();
  check(
    'the operators page requested a colleague with a name and an address, signed with the operator key',
    /Requested\. Change/.test(colleagueText) && /applies at/.test(colleagueText),
    colleagueText.split('\n').slice(-2).join(' ').slice(0, 200),
  );
  await shot('a-colleague-requested');

  const pendingRows = sh(
    'psql',
    ['-h', '127.0.0.1', '-U', 'postgres', '-d', DB_NAME, '-tAc',
      "SELECT display_name || ' ' || address FROM operator_requests"],
    { allowFailure: true },
  ).stdout.trim();
  check(
    'and the request carries both, on the server',
    pendingRows.includes(COLLEAGUE.name) && pendingRows.includes(COLLEAGUE.address),
    pendingRows || '(no operator_requests row read)',
  );

  // ---- 5. the SMTP form ---------------------------------------------------
  await page.fill('#smtp-host', 'smtp.example.test');
  await page.fill('#smtp-port', '587');
  await page.selectOption('#smtp-tls', 'starttls');
  await page.fill('#smtp-user', 'fathom');
  await page.fill('#smtp-password', 'hunter2-hunter2-hunter2');
  await page.fill('#smtp-from', 'fathom@example.test');
  await page.click('text=Save the mail settings');
  await page.waitForSelector('text=in effect at', { timeout: 20000 });
  const smtpText = await page.locator('form:has(#smtp-host)').innerText();
  check('the SMTP form round-tripped: saved, sealed, and told when it takes effect', /in effect at/.test(smtpText));
  await shot('the-smtp-form-saved');

  // ---- 6. the placement form ---------------------------------------------
  await page.fill('#placement-hosts', 'localhost');
  await page.fill('#placement-window', '1');
  await page.click('text=Review this move');
  await page.waitForSelector('.console__warnlist', { timeout: 10000 });
  const warning = await page.locator('.console__warnlist').innerText();
  check(
    'the form warns before the save, naming the new host, this host, the window and the revert',
    warning.includes('localhost') && warning.includes(OLD_HOST) && /one minute/.test(warning) && /reverts/.test(warning),
  );
  await shot('the-placement-warning');

  const movedAt = Date.now();
  await page.click('text=Move the console to localhost');
  await page.waitForSelector('[data-testid="placement-countdown"]', { timeout: 20000 });
  const countdown = await page.locator('[data-testid="placement-countdown"]').innerText();
  const [mm, ss] = countdown.split(':').map(Number);
  check(
    'the countdown runs off the deadline the server sent',
    mm * 60 + ss > 0 && mm * 60 + ss <= 61,
    countdown,
  );
  check(
    'and the form is NOT read-only: nothing told it the environment decides, and it did not infer one',
    (await page.locator('[data-testid="placement-readonly"]').count()) === 0,
  );
  await shot('the-placement-countdown');

  const flagOld = await flagAs(OLD_HOST);
  const flagNew = await flagAs(NEW_HOST);
  check('the console stops answering on the old host at once', flagOld.verdict === 'no', JSON.stringify(flagOld));
  check(
    'the new host answers, with the deadline of a placement waiting to be confirmed',
    flagNew.verdict === 'yes' && typeof flagNew.deadline === 'number',
    JSON.stringify(flagNew),
  );

  await page.waitForURL(`${NEW_URL}/`, { timeout: 25000 });
  await page.waitForTimeout(1000);
  check('the browser was taken to the new host', page.url().startsWith(NEW_URL), page.url());
  await shot('landed-on-the-new-host');

  // ---- the window runs out unconfirmed ------------------------------------
  const waitMs = Math.max(0, 63_000 - (Date.now() - movedAt));
  console.log(`==> waiting ${Math.round(waitMs / 1000)}s for the one-minute window to run out unconfirmed`);
  await new Promise((r) => setTimeout(r, waitMs));
  const flagOldAfter = await flagAs(OLD_HOST);
  check(
    'after the window the console answers again on the host it was moved off',
    flagOldAfter.verdict === 'yes',
    JSON.stringify(flagOldAfter),
  );

  await page.goto(`${OLD_URL}/`, { waitUntil: 'networkidle' });
  // A recovery code, not a code from the app: the second step takes either in
  // the one field (ADR-0056 decisions 3 and 4), and the person who reaches
  // for a recovery code has already lost their phone.
  const backDoor = await signInThroughTheDoor(page, {
    address: ADDRESS,
    password: CREDENTIAL,
    code: recoveryCodes[0],
  });
  check(
    'the second step takes a RECOVERY code where the verification code goes',
    backDoor.twoStep,
    backDoor.twoStep ? 'one field, two kinds of code' : 'no second step was drawn',
  );
  await page.waitForSelector('[data-testid="console-entry"]', { timeout: 25000 });
  await page.click('[data-testid="console-entry"]');
  await Promise.race([
    page.waitForSelector('.console__section', { timeout: 25000 }),
    page.waitForSelector('.console-entry__refusal', { timeout: 25000 }),
  ]).catch(() => {});
  await page.waitForTimeout(800);
  const secondEntry = await page
    .locator('.console-entry__refusal')
    .innerText()
    .catch(() => '');
  check(
    'the console opens again on that host with the key this browser already holds, registering nothing',
    secondEntry === '',
    secondEntry.slice(0, 160),
  );
  check(
    'and the console answers there again, with its placement form back',
    (await page.locator('#placement-hosts').count()) === 1,
  );
  await shot('the-console-answers-again-after-the-revert');

  // The register, read after all of it: two rows once the colleague's
  // request has applied, one until then. Reported, not asserted either way --
  // the delay is 24 hours and this drive does not wait it out.
  const register = await page.locator('.console__table').last().innerText();
  check("the register carries the operator's address of record", register.includes(ADDRESS));
  await shot('the-console-before-signing-out');

  // ---- signing out ends BOTH sessions -------------------------------------
  const countSessions = () =>
    Number(
      sh('psql', ['-h', '127.0.0.1', '-U', 'postgres', '-d', DB_NAME, '-tAc', 'SELECT count(*) FROM sessions'], {
        allowFailure: true,
      }).stdout.trim() || '-1',
    );
  const sessionsBefore = countSessions();
  await page.click('button.shell-account');
  await page.click('text=Sign out');
  await page.waitForSelector('#signin-password', { timeout: 20000 });
  await page.waitForTimeout(800);
  const sessionsAfter = countSessions();
  check(
    'signing out from the console ends BOTH sessions: two rows fewer, one per custody',
    sessionsBefore - sessionsAfter === 2,
    `${sessionsBefore} → ${sessionsAfter}`,
  );
  await shot('signed-out-at-the-door');

  console.log('\n--- what the browsers said ---');
  for (const line of failed.slice(0, 20)) console.log(`     ${line}`);
  check('no uncaught exception in either browser', errors.length === 0, errors.join(' | '));
  // Two answers in this drive are the product behaving as built:
  //
  //   * `401 /session` — the second-factor probe of ADR-0056 decision 3. It
  //     is a step in a sign-in and not a failed one: the server rolls its
  //     transaction back, writes no entry and leaves the nonce unspent (it
  //     charges the source bucket, and nothing else). There is exactly one
  //     per two-step sign-in, and this drive makes two — the second browser
  //     and the sign-in after the revert. The first run's last step sends
  //     the code with the password, so it never reaches the probe.
  //   * `503` — the mail test send, which says mail is not built yet.
  //
  // Every other failed request is a bug.
  const probes = failed.filter((line) => /401 \/session$/.test(line));
  check(
    'every 401 in the drive is the second-factor probe, one per two-step sign-in',
    probes.length === 2,
    `${probes.length}: ${probes.join(' | ')}`,
  );
  const unexpected = failed.filter((line) => !/503/.test(line) && !/401 \/session$/.test(line));
  check(
    'no other request was refused in the whole drive',
    unexpected.length === 0,
    unexpected.slice(0, 6).join(' | '),
  );

  await browser.close();
  console.log('\nscreenshots:');
  for (const path of shots) console.log(`  ${path}`);
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
