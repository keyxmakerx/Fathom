// Drives the REAL built client against a REAL server: a click on every model
// in the Equipment list adds it, even once the racks are full.
//
//   node scripts/drive-add-equipment.mjs            # the sample home lab
//   FRESH=1 node scripts/drive-add-equipment.mjs    # a new, empty design
//
// The sample's rack is 12U; on main (2026-10-11) a click filled it and every
// later click did nothing at all, no box and no message, which reads as
// "I can't add equipment any more". This walks the first run, opens the
// design, clicks each catalogue model in turn and checks the canvas gained a
// node every time.

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
const PORT = 18137;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const DB_NAME = 'fathom_add_equipment';
const RUNTIME_URL = runtimeUrl(DB_NAME);
const MIGRATE_URL = migrateUrl(DB_NAME);
const CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const PLAYWRIGHT = '/opt/node22/lib/node_modules/playwright/index.mjs';
// The setup password the server is started with (ADR-0057).
const SETUP_PASSWORD = 'amber-kestrel-harbour-0057';
const ADDRESS = 'owner@example.test';
const CREDENTIAL = 'harbour-lantern-copper-nine';

const WORK = process.env.FATHOM_DRIVE_DIR ?? join(tmpdir(), 'fathom-drive-add-equipment');
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

  // ---- 1. the first run, ending signed in on Home ----------------------------
  const pageA = await openContext('A');
  let inFlight = 0;
  let peak = 0;
  const refused = [];
  const signed = (request) => request.headers()['fathom-signature'] !== undefined;
  pageA.on('request', (request) => {
    if (!signed(request)) return;
    inFlight += 1;
    peak = Math.max(peak, inFlight);
  });
  const settle = (request) => {
    if (signed(request)) inFlight -= 1;
  };
  pageA.on('requestfinished', settle);
  pageA.on('requestfailed', settle);
  pageA.on('response', (response) => {
    if (response.status() === 401) refused.push(`${response.request().method()} ${new URL(response.url()).pathname}`);
  });
  const spent = new Set();
  await pageA.goto(`${BASE_URL}/`, { waitUntil: 'networkidle' });
  const { secret } = await walkTheFirstRun(pageA, {
    token: SETUP_PASSWORD,
    address: ADDRESS,
    password: CREDENTIAL,
    spent,
  });
  check('the first run ends signed in on Home', true);


  // ---- 2. an organisation (drive-fresh-install.mjs's steps) ----------------
  const tab = pageA;
  await tab.waitForSelector('[data-testid="console-entry"]', { timeout: 10000 });
  await tab.click('[data-testid="console-entry"]');
  await tab.waitForSelector('.console__section', { timeout: 25000 });
  await tab.fill('#console-org-name', 'Owner Networks');
  await tab.getByRole('button', { name: 'Create the shell and its claim' }).click();
  await tab.waitForSelector('li.console__minted-row', { timeout: 15000 });
  await tab.getByRole('button', { name: 'Claim it now' }).click();
  await tab.waitForSelector('#claim-token', { timeout: 15000 });
  await tab.getByRole('button', { name: 'Claim', exact: true }).click();
  await tab.waitForSelector('[data-testid="recovery-key"]', { timeout: 20000 });
  await tab.locator('[role="checkbox"]').click();
  await tab.getByRole('button', { name: 'Continue' }).click();
  await tab.waitForSelector('.home', { timeout: 20000 });
  await tab.waitForTimeout(1000);
  check('an organisation exists and the person is still signed in', (await tab.locator('#signin-password').count()) === 0);

  // ---- 3. open a design: every catalogue model is fetched ------------------
  peak = 0;
  refused.length = 0;
  await tab.getByRole('tab', { name: 'Designs' }).click();
  await tab.waitForTimeout(800);
  if (process.env.FRESH) await tab.getByRole('button', { name: 'New design' }).first().click(); else await tab.getByRole('button', { name: 'Open sample' }).click();
  await pageA.waitForSelector('.react-flow__pane, #signin-password', { timeout: 30000 }).catch(() => {});
  // Long enough for every model fetch to land and for a 401 to have cleared
  // the session if one was coming.
  await pageA.waitForTimeout(8000);
  await shot(pageA, 'after-opening-a-design');
  const atTheDoor = (await pageA.locator('#signin-password').count()) > 0;
  check('opening a design leaves the person signed in', !atTheDoor);
  check('the canvas is on screen', (await pageA.locator('.react-flow__pane').count()) > 0);
  check('no signed request was refused with a 401', refused.length === 0, refused.slice(0, 5).join(', '));
  check(`no more than 32 signed requests were ever in flight at once`, peak <= 32, `peak ${peak}`);
  console.log(`     peak signed requests in flight: ${peak}`);


  // ---- 3b. the equipment list ----
  const dockEq = await pageA.locator('[data-testid="dock-equipment"]').count();
  check('the Equipment tab is there', dockEq > 0, `count ${dockEq}`);
  if (dockEq > 0) {
    // Equipment opens by itself on an empty design (ADR-0066 §3): open it only if it is not already open.
    if ((await pageA.locator('[data-testid="dock-equipment"]').getAttribute('aria-expanded')) !== 'true') await pageA.locator('[data-testid="dock-equipment"]').click();
    await pageA.waitForTimeout(1500);
    await shot(pageA, 'equipment-open');
    const items = await pageA.locator('.drawing-palette__item').allTextContents();
    const models = await pageA.locator('.drawing-palette__item--model').count();
    console.log(`     palette rows ${items.length}, model rows ${models}: ${items.slice(0, 12).join(' | ')}`);
    check('the Equipment list offers catalogue models', models > 0, `models ${models}`);

    const nodesBefore = await pageA.locator('.react-flow__node').count();
    const rows = pageA.locator('.drawing-palette__item--model');
    const n = await rows.count();
    const stuck = [];
    for (let i = 0; i < n; i++) {
      const label = (await rows.nth(i).innerText()).replace(/\s+/g, ' ');
      const before = await pageA.locator('.react-flow__node').count();
      await rows.nth(i).click();
      await pageA.waitForTimeout(400);
      const after = await pageA.locator('.react-flow__node').count();
      if (after <= before) stuck.push(label);
    }
    console.log(`     nodes ${nodesBefore} -> ${await pageA.locator('.react-flow__node').count()}`);
    await shot(pageA, 'after-clicking-every-model');
    check('clicking each catalogue model adds it', stuck.length === 0, `${stuck.length} did not: ${stuck.slice(0, 10).join(' / ')}`);
  }
  const loadErr = await pageA.locator('text=/malformed|could not|failed/i').allTextContents();
  console.log('     error-ish text: ' + loadErr.join(' | '));

  // ---- 4. a reload restores the session and opens the design again ---------
  refused.length = 0;
  // Not 'networkidle': the live feed is a request that stays open.
  await pageA.reload({ waitUntil: 'load' });
  await pageA.waitForTimeout(6000);
  check('after a reload the person is still signed in', (await pageA.locator('#signin-password').count()) === 0);
  check('and no signed request was refused with a 401', refused.length === 0, refused.slice(0, 5).join(', '));

  check('no uncaught exception', errors.length === 0, errors.join(' | '));
  if (failures > 0) console.log(serverLog.split('\n').filter((l) => /not authenticated|nonce|counter/i.test(l)).slice(-10).join('\n'));

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
