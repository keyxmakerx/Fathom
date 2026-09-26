// Drives the REAL built client against a REAL server: ADR-0057 decision 8,
// "Signed-in browsers" (OWASP ASVS 5.0.0 7.5.2).
//
//   node scripts/drive-signed-in-browsers.mjs
//
// Two browser contexts sign in as the same person — the first through the
// first run (ADR-0056 decision 2), the second through the ordinary door
// (decision 3's two steps) — and every request either makes is the built
// client's code.

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { migrateUrl, runtimeUrl, superuserUrl } from './drive-lib/db.mjs';

const ROOT = process.env.FATHOM_ROOT ?? fileURLToPath(new URL('..', import.meta.url));
// `CARGO_TARGET_DIR` is set per worktree in this project, so the binary is
// not always under ./target -- and the binary this drive wants is the one
// built beside the client it is driving.
const TARGET_DIR = process.env.CARGO_TARGET_DIR ?? join(ROOT, 'target');
const SERVER_BIN = process.env.FATHOM_SERVER_BIN ?? join(TARGET_DIR, 'debug', 'fathom-server');
const PORT = 18108;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const DB_NAME = 'fathom_d8_browsers';
const RUNTIME_URL = runtimeUrl(DB_NAME);
const MIGRATE_URL = migrateUrl(DB_NAME);
const CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const PLAYWRIGHT = '/opt/node22/lib/node_modules/playwright/index.mjs';
// The setup password the server is started with (ADR-0057).
const SETUP_PASSWORD = 'amber-kestrel-harbour-0057';
const ADDRESS = 'owner@example.test';
const CREDENTIAL = 'harbour-lantern-copper-nine';

const WORK = process.env.FATHOM_DRIVE_DIR ?? join(tmpdir(), 'fathom-drive-signed-in-browsers');
const SHOTS = process.env.FATHOM_SHOTS ?? join(WORK, 'shots');
mkdirSync(WORK, { recursive: true });
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

const psql = (sql, o = {}) => sh('psql', ['-d', superuserUrl('postgres'), '-qc', sql], o);

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

function firstField(bytes) {
  const len = new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, true);
  return new TextDecoder().decode(bytes.slice(4, 4 + len));
}

async function setupState(baseUrl) {
  const response = await fetch(`${baseUrl}/setup/state`);
  if (response.status !== 200) return `HTTP ${response.status}`;
  return firstField(new Uint8Array(await response.arrayBuffer()));
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

/** A code for a step this run has not spent yet. */
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

/** `predicate` may be sync or async — every caller here needs the latter, so
 * this awaits it rather than testing a `Promise` object's truthiness. */
async function waitUntil(predicate, timeoutMs = 10000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (await predicate()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return await predicate();
}

// --- the two doors this drive walks through --------------------------------

/**
 * The first run, repeated from `drive-two-custodies.mjs` rather than shared
 * (a helper module would be a second implementation of the screens' contract
 * to keep in step with). Hands back the confirmed secret to sign in with.
 */
async function walkTheFirstRun(page, { token, address, password, spent }) {
  await page.waitForSelector('#firstrun-token', { timeout: 20000 });
  await page.fill('#firstrun-token', token);
  await page.click('form.signin__card button[type=submit]');

  await page.waitForSelector('#firstrun-password', { timeout: 20000 });
  await page.fill('#firstrun-password', password);
  await page.fill('#firstrun-password-again', password);
  await page.click('form.signin__card button[type=submit]');

  await page.waitForSelector('.signin__section', { timeout: 25000 });
  if ((await page.locator('[data-testid="totp-secret"]').count()) === 0) {
    await page.click('.signin__section button.signin__submit');
  }
  await page.waitForSelector('[data-testid="totp-secret"]', { timeout: 20000 });
  const secretText = (await page.locator('[data-testid="totp-secret"]').innerText()).trim();
  const secret = base32Decode(secretText);
  await page.fill('#account-code', await freshCode(secret, spent));
  await page.click('form.signin__section:has(#account-code) button[type=submit]');

  await page.waitForSelector('.authenticator__codes', { timeout: 25000 });
  const box = page.locator('[role="checkbox"]');
  await box.click();
  await page.click('.signin__section:has(.authenticator__codes) button.signin__submit');

  await page.waitForSelector('#firstrun-code', { timeout: 20000 });
  await page.fill('#firstrun-code', await freshCode(secret, spent));
  await page.click('form.signin__card button[type=submit]');

  await page.waitForSelector('.home', { timeout: 30000 });
  return { secret };
}

/**
 * The ordinary door, decision 3's two steps: address and password, then the
 * code for a confirmed authenticator. Repeated from
 * `drive-two-custodies.mjs` for the same reason `walkTheFirstRun` above is.
 */
async function signInThroughTheDoor(page, { address, password, code }) {
  await page.waitForSelector('#signin-password', { timeout: 20000 });
  await page.fill('#signin-address', address);
  await page.fill('#signin-password', password);
  await page.click('form.signin__card button[type=submit]');
  await page.waitForSelector('#signin-code, .home, .signin__refusal', { timeout: 30000 });
  if ((await page.locator('#signin-code').count()) === 1) {
    await page.fill('#signin-code', code);
    await page.click('form.signin__card button[type=submit]');
  }
  await page.waitForSelector('.home', { timeout: 30000 });
}

/** Opens the account menu and the credential screen, where "Signed-in
 * browsers" lives. */
async function openAccountScreen(page) {
  await page.click('[aria-label="Account menu"]');
  await page.click('text=Password and authenticator');
  await page.waitForSelector('.account__sessions, .signin__heading:has-text("Signed-in browsers")', {
    timeout: 20000,
  });
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
  for (const path of [masterKey, chainKey]) rmSync(path, { force: true });
  writeFileSync(masterKey, Buffer.alloc(32, 41), { mode: 0o400 });
  writeFileSync(chainKey, Buffer.alloc(32, 43), { mode: 0o400 });

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
      FATHOM_SETUP_PASSWORD: SETUP_PASSWORD,
      FATHOM_BIND: `127.0.0.1:${PORT}`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverLog = '';
  serverProc.stdout.on('data', (d) => (serverLog += d.toString()));
  serverProc.stderr.on('data', (d) => (serverLog += d.toString()));

  try {
    const health = await waitForHttp(`${BASE_URL}/health`);
    check('the server answers /health with this worktree’s built client behind it', health.status === 200);
  } catch (e) {
    console.log(serverLog.slice(-3000));
    throw e;
  }

  const stateBefore = await setupState(BASE_URL);
  check('GET /setup/state says pending on a fresh install', stateBefore === 'pending', stateBefore);

  const { chromium } = await import(PLAYWRIGHT);
  const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });

  const errors = [];
  async function openContext(label) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 1200 } });
    const page = await context.newPage();
    page.on('pageerror', (e) => errors.push(`${label}: ${e}`));
    return page;
  }

  let shotNumber = 0;
  const shots = [];
  const shot = async (page, name) => {
    shotNumber += 1;
    const path = join(SHOTS, `${String(shotNumber).padStart(2, '0')}-${name}.png`);
    await page.screenshot({ path, fullPage: true });
    shots.push(path);
    console.log(`     shot ${path}`);
  };

  // ---- 1. browser A: the first run, ending signed in on Home -------------
  const pageA = await openContext('A');
  const spent = new Set();
  await pageA.goto(`${BASE_URL}/`, { waitUntil: 'networkidle' });
  const { secret } = await walkTheFirstRun(pageA, {
    token: SETUP_PASSWORD,
    address: ADDRESS,
    password: CREDENTIAL,
    spent,
  });
  check('browser A: the first run ends signed in on Home', true);

  // ---- 2. browser B: the ordinary door, same person, same phone ----------
  const pageB = await openContext('B');
  await pageB.goto(`${BASE_URL}/`, { waitUntil: 'networkidle' });
  await signInThroughTheDoor(pageB, {
    address: ADDRESS,
    password: CREDENTIAL,
    code: await freshCode(secret, spent),
  });
  check('browser B: the ordinary door, two steps, ends signed in on Home too', true);

  // ---- 3. browser A: both browsers are listed -----------------------------
  await openAccountScreen(pageA);
  // The list is fetched once, on mount, and browser B signed in after
  // browser A last loaded this screen — so this waits for the second row
  // rather than trusting the first answer.
  await waitUntil(async () => (await pageA.locator('.account__session').count()) === 2, 15000);
  const rows = pageA.locator('.account__session');
  const rowCount = await rows.count();
  check('the "Signed-in browsers" section lists two rows, one per browser', rowCount === 2, `${rowCount}`);
  const thisBrowserCount = await pageA.locator('.account__session-tag:has-text("This browser")').count();
  const signOutCount = await pageA.locator('.account__session button:has-text("Sign out")').count();
  check(
    'exactly one row is marked "This browser" and exactly one offers "Sign out"',
    thisBrowserCount === 1 && signOutCount === 1,
    `This browser: ${thisBrowserCount}, Sign out: ${signOutCount}`,
  );
  // Both browsers here are the same real Chromium on this Linux host, so the
  // exact derived label is known, not merely non-empty — proving the
  // in-house matcher ran on the real header Chromium sent.
  const browserLabels = await rows.locator('.account__session-browser').allInnerTexts();
  check(
    'each row names the browser derived from its real User-Agent — "Chrome on Linux"',
    browserLabels.every((label) => label.trim() === 'Chrome on Linux'),
    browserLabels.join(' | '),
  );
  await shot(pageA, 'two-signed-in-browsers');

  // ---- 4. browser A ends browser B's session, with a code -----------------
  await pageA.click('.account__session button:has-text("Sign out")');
  await pageA.waitForSelector('#signed-in-browsers-code', { timeout: 10000 });
  check('ending the other browser asks for a verification code inline', true);
  await pageA.fill('#signed-in-browsers-code', await freshCode(secret, spent));
  await pageA.click('form:has(#signed-in-browsers-code) button.signin__submit');
  await waitUntil(async () => (await pageA.locator('.account__session').count()) === 1, 15000);
  const afterCount = await pageA.locator('.account__session').count();
  check('once ended, only browser A\'s row remains', afterCount === 1, `${afterCount}`);
  await shot(pageA, 'one-browser-remains');

  // ---- 5. browser B's next authenticated action lands it at the door -----
  await pageB.click('[aria-label="Account menu"]');
  await pageB.click('text=Password and authenticator');
  await pageB.waitForSelector('#signin-password', { timeout: 20000 });
  const notice = ((await pageB.locator('.signin__notice').textContent()) ?? '').trim();
  check(
    'browser B lands at the sign-in door with a plain line saying it was signed out',
    notice.toLowerCase().includes('signed out'),
    JSON.stringify(notice),
  );
  await shot(pageB, 'browser-b-at-the-door');

  check('no uncaught exception in either browser', errors.length === 0, errors.join(' | '));

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
