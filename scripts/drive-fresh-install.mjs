// ADR-0057 decision 5, driven end to end in a real browser against the real
// server and built client: `node scripts/drive-fresh-install.mjs`. Builds neither; kills the server by PORT, never by name.

import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync, existsSync, rmSync, copyFileSync, chmodSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { migrateUrl, runtimeUrl, superuserUrl } from './drive-lib/db.mjs';

const ROOT = process.env.FATHOM_ROOT ?? fileURLToPath(new URL('..', import.meta.url));
// `CARGO_TARGET_DIR` is shared across worktrees in this project (NEXT.md
// ground rule 3), so the binary is not always under ./target.
const TARGET_DIR = process.env.CARGO_TARGET_DIR ?? join(ROOT, 'target');
const SERVER_BIN = process.env.FATHOM_SERVER_BIN ?? join(TARGET_DIR, 'debug', 'fathom-server');
const PORT = 18193;
const SERVER_URL = `http://127.0.0.1:${PORT}`;
const DB_NAME = 'fathom_place_freshinstall';
const RUNTIME_URL = runtimeUrl(DB_NAME);
const MIGRATE_URL = migrateUrl(DB_NAME);
const CHROME = process.env.PW_CHROMIUM ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const PLAYWRIGHT = process.env.PW_PLAYWRIGHT ?? '/opt/node22/lib/node_modules/playwright/index.mjs';
const ADDRESS = 'owner@fathom.invalid';
// The length and shape ADR-0055 decision 10 requires, and the CI script's own.
const CREDENTIAL = 'harbour-lantern-copper-nine';
const SHOTS = `${process.env.FATHOM_SHOTS ?? join(tmpdir(), 'fathom-shots')}/`;
mkdirSync(SHOTS, { recursive: true });

const work = mkdtempSync(join(tmpdir(), 'fathom-freshinstall-'));
const MASTER_KEY_PATH = join(work, 'master.key');
const CHAIN_KEY_PATH = join(work, 'chain.key');
// The setup password the server is started with (ADR-0057), typed on the
// Welcome screen; not on `common-passwords.txt`'s eight-character floor.
const SETUP_PASSWORD = 'amber-kestrel-harbour-4471';

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

function psql(sql, { allowFailure = false } = {}) {
  return sh('psql', ['-d', superuserUrl('postgres'), '-qc', sql], { allowFailure });
}

async function waitForHttp(url, attempts = 100) {
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
  // By PORT, never by process name: another agent's `cargo` or `node` must
  // not be caught by this.
  sh('fuser', ['-k', `${PORT}/tcp`], { allowFailure: true });
  if (serverProc) serverProc.kill('SIGTERM');
}

// --- the authenticator app, in Node (RFC 6238, as credentials.rs) ----------
// Verbatim from `scripts/drive-csp.mjs`.

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

/** A code for a step this run has not spent yet: a code is accepted once. */
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

// ---------------------------------------------------------------------------
// `scripts/drive-first-design.mjs`'s own drag helper, unchanged.
// ---------------------------------------------------------------------------
async function dragPaletteItemOntoRack(page, itemIndex = 0, slot = 0) {
  const item = page.locator('.drawing-palette__item').nth(itemIndex);
  await item.waitFor({ state: 'visible', timeout: 15000 });
  const rack = page.locator('.drawing-rack__frame').first();
  await rack.waitFor({ state: 'visible', timeout: 15000 });
  const itemHandle = await item.elementHandle();
  const rackHandle = await rack.elementHandle();
  const rackBox = await rack.boundingBox();
  const dropX = rackBox.x + rackBox.width / 2;
  const dropY = rackBox.y + 30 + slot * 140;
  await page.evaluate(
    ([itemEl, rackEl, x, y]) => {
      const dt = new DataTransfer();
      itemEl.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }));
      rackEl.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: x, clientY: y }));
      rackEl.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: x, clientY: y }));
    },
    [itemHandle, rackHandle, dropX, dropY],
  );
}

async function openTheRail(page) {
  const handle = page.getByRole('button', { name: 'Open the rail' });
  if ((await handle.count()) > 0) await handle.click();
}

async function main() {
  const dist = join(ROOT, 'client', 'dist', 'index.html');
  if (!existsSync(dist)) {
    throw new Error(`no built client at ${dist}. Run: cd client && npm ci --ignore-scripts && npm run build`);
  }
  if (!existsSync(SERVER_BIN)) {
    throw new Error(`no server binary at ${SERVER_BIN}. Run: cargo build -p fathom-server`);
  }

  // `TARGET_DIR` is shared; a concurrent build elsewhere could overwrite
  // this binary mid-run. Copied once, to a path only this run touches.
  const commit = sh('git', ['rev-parse', 'HEAD'], { cwd: ROOT }).stdout.trim();
  const dirty = sh('git', ['status', '--porcelain'], { cwd: ROOT }).stdout.trim().length > 0;
  console.log(`==> server binary is from commit ${commit}${dirty ? ' (plus uncommitted changes)' : ''}`);
  const privateServerBin = join(work, 'fathom-server');
  copyFileSync(SERVER_BIN, privateServerBin);
  chmodSync(privateServerBin, 0o755);

  console.log(`==> database ${DB_NAME}`);
  psql(`DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE);`, { allowFailure: true });
  psql(`CREATE DATABASE ${DB_NAME} OWNER fathom_test;`);

  writeFileSync(MASTER_KEY_PATH, Buffer.alloc(32, 13), { mode: 0o600 });
  writeFileSync(CHAIN_KEY_PATH, Buffer.alloc(32, 17), { mode: 0o600 });

  console.log(`==> starting fathom-server on ${SERVER_URL} with the built client behind it`);
  const env = { ...process.env };
  delete env.DATABASE_URL;
  serverProc = spawn(privateServerBin, [], {
    cwd: ROOT,
    env: {
      ...env,
      DATABASE_URL: RUNTIME_URL,
      FATHOM_MIGRATE_DATABASE_URL: MIGRATE_URL,
      FATHOM_SCHEMA_ROOT: `${ROOT}/schema`,
      FATHOM_MASTER_KEY: `file://${MASTER_KEY_PATH}`,
      FATHOM_CHAIN_KEY: `file://${CHAIN_KEY_PATH}`,
      FATHOM_OPERATOR_NOTICE_ADDRESS: ADDRESS,
      FATHOM_SETUP_PASSWORD: SETUP_PASSWORD,
      FATHOM_CLIENT_ROOT: `${ROOT}/client/dist`,
      FATHOM_BIND: `127.0.0.1:${PORT}`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverLog = '';
  serverProc.stdout.on('data', (d) => { serverLog += d.toString(); });
  serverProc.stderr.on('data', (d) => { serverLog += d.toString(); });

  try {
    const health = await waitForHttp(`${SERVER_URL}/health`);
    check('the real fathom-server answers GET /health', health.status === 200, String(health.status));
  } catch (error) {
    console.log(serverLog.slice(-4000));
    throw error;
  }

  const { chromium } = await import(PLAYWRIGHT);
  const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const tab = await context.newPage();
  tab.on('console', (m) => { if (m.type() === 'error') console.log('[console error] ' + m.text()); });
  tab.on('pageerror', (e) => console.log('[pageerror] ' + e));

  try {
    await runDrive(tab);
  } catch (error) {
    console.log(serverLog.slice(-6000));
    throw error;
  } finally {
    await browser.close();
  }
}

async function runDrive(tab) {
  await tab.bringToFront();

  // -------------------------------------------------------------------
  // 1. First run with the setup password: Welcome screen, password,
  //    authenticator app, recovery codes.
  // -------------------------------------------------------------------
  await tab.goto(`${SERVER_URL}/`, { waitUntil: 'networkidle' });
  await tab.waitForSelector('#firstrun-token', { timeout: 15000 });
  const rendered = await tab.evaluate(() => (document.querySelector('#root')?.textContent ?? '').trim().length);
  check('1. first run: the Welcome screen rendered', rendered > 20, `${rendered} characters`);
  await tab.fill('#firstrun-token', SETUP_PASSWORD);
  await tab.click('form.signin__card button[type=submit]');

  await tab.waitForSelector('#firstrun-password', { timeout: 20000 });
  await tab.fill('#firstrun-password', CREDENTIAL);
  await tab.fill('#firstrun-password-again', CREDENTIAL);
  await tab.click('form.signin__card button[type=submit]');
  check('1. first run: the setup password opened the password screen', true);

  await tab.waitForSelector('.signin__section', { timeout: 25000 });
  if ((await tab.locator('[data-testid="totp-secret"]').count()) === 0) {
    await tab.click('.signin__section button.signin__submit');
  }
  await tab.waitForSelector('[data-testid="totp-secret"]', { timeout: 20000 });
  const spent = new Set();
  const secret = base32Decode((await tab.locator('[data-testid="totp-secret"]').innerText()).trim());
  await tab.fill('#account-code', await freshCode(secret, spent));
  await tab.click('form.signin__section:has(#account-code) button[type=submit]');

  await tab.waitForSelector('.authenticator__codes', { timeout: 25000 });
  await tab.locator('[role="checkbox"]').click();
  await tab.locator('.signin__section:has(.authenticator__codes) button.signin__submit').click();
  check('1. first run: the authenticator app is set up and its recovery codes saved', true);

  // -------------------------------------------------------------------
  // 2. Sign in — the flow's own final step, a verification code.
  // -------------------------------------------------------------------
  await tab.waitForSelector('#firstrun-code', { timeout: 20000 });
  await tab.fill('#firstrun-code', await freshCode(secret, spent));
  await tab.click('form.signin__card button[type=submit]');

  await tab.waitForSelector('.home', { timeout: 30000 });
  await tab.waitForTimeout(1000);
  check('2. sign in: the first run landed signed in, on Home', (await tab.locator('.home').count()) === 1);
  check(
    '2. sign in: a fresh account belongs to no organisations yet',
    (await tab.getByText('You belong to no organisations yet.').count()) === 1,
  );
  check(
    '2. sign in: Home offers "Claim an organisation" for a pasted token',
    (await tab.getByRole('button', { name: 'Claim an organisation' }).count()) === 1,
  );

  // -------------------------------------------------------------------
  // 3. Site: create an organisation.
  // -------------------------------------------------------------------
  await tab.click('.shell-account'); // Site is a row in the account menu
  await tab.waitForSelector('[data-testid="console-entry"]', { timeout: 10000 });
  await tab.click('[data-testid="console-entry"]');
  await tab.waitForSelector('.console__section', { timeout: 25000 });
  check('3. Site: the operator console opened', (await tab.locator('.console__title').count()) === 1);

  const orgName = 'Owner Networks';
  await tab.fill('#console-org-name', orgName);
  await tab.getByRole('button', { name: 'Create the shell and its claim' }).click();
  await tab.waitForSelector('li.console__minted-row', { timeout: 15000 });
  check(
    '3. Site: the new organisation shell and its claim are listed',
    (await tab.getByText(`Claim for the organisation shell "${orgName}"`).count()) === 1,
  );
  const claimNow = tab.getByRole('button', { name: 'Claim it now' });
  check('3. Site: "Claim it now" is offered beside the freshly minted claim', (await claimNow.count()) === 1);

  // -------------------------------------------------------------------
  // 4. Claim it — the token and notice address arrive pre-filled. "Claim"
  //    here only generates the key and opens step 5; nothing is sent yet.
  // -------------------------------------------------------------------
  await claimNow.click();
  await tab.waitForSelector('#claim-token', { timeout: 15000 });
  const tokenValue = await tab.locator('#claim-token').inputValue();
  const noticeValue = await tab.locator('#claim-notice-address').inputValue();
  check('4. claim it: the token field is pre-filled', tokenValue.length > 0, tokenValue);
  check('4. claim it: the notice address field is pre-filled', noticeValue.length > 0, noticeValue);
  check(
    '4. claim it: both fields are disabled — nothing to type or paste',
    (await tab.locator('#claim-token').isDisabled()) && (await tab.locator('#claim-notice-address').isDisabled()),
  );
  await tab.getByRole('button', { name: 'Claim', exact: true }).click();

  // -------------------------------------------------------------------
  // 5. The recovery key screen — shown once, before the claim is sent.
  //    Screenshot taken here.
  // -------------------------------------------------------------------
  await tab.waitForSelector('[data-testid="recovery-key"]', { timeout: 20000 });
  const recoveryKeyText = (await tab.locator('[data-testid="recovery-key"]').innerText()).trim();
  // Grouped base32, 14 groups of 4. The check's own detail reports the
  // shape only, never the key itself.
  check(
    '5. recovery key: a key is shown, in the expected grouped format',
    /^([A-Z2-7]{4}-){13}[A-Z2-7]{4}$/.test(recoveryKeyText),
    `${recoveryKeyText.length} characters, ${recoveryKeyText.split('-').length} groups`,
  );
  const continueBtn = tab.getByRole('button', { name: 'Continue' });
  check('5. recovery key: Continue starts disabled, before the box is ticked', await continueBtn.isDisabled());
  await tab.screenshot({ path: `${SHOTS}fresh-install-recovery-key.png` });
  check('5. recovery key: screenshot taken (fresh-install-recovery-key.png)', true);

  await tab.locator('[role="checkbox"]').click();
  check('5. recovery key: Continue is enabled once the box is ticked', await continueBtn.isEnabled());
  // Only now, after the key is confirmed saved, does the claim actually go
  // over the wire -- the server sees the request for the first time here.
  await continueBtn.click();

  // -------------------------------------------------------------------
  // 6. Home shows the organisation.
  // -------------------------------------------------------------------
  await tab.waitForSelector('.home', { timeout: 20000 });
  await tab.waitForTimeout(500);
  check(
    '6. Home shows the organisation, and the key is gone from this screen',
    (await tab.getByText(orgName).count()) >= 1 && (await tab.locator('[data-testid="recovery-key"]').count()) === 0,
  );

  // -------------------------------------------------------------------
  // 7. New site.
  // -------------------------------------------------------------------
  const siteName = 'Weekend HQ';
  await tab.getByRole('button', { name: 'New site' }).click();
  await tab.locator('#home-new-scope-label').fill(siteName);
  await tab.getByRole('button', { name: 'Create', exact: true }).click();
  await tab.getByText(siteName).waitFor({ timeout: 10000 });
  check('7. New site: the new site appears on Home', (await tab.getByText(siteName).count()) >= 1);

  // -------------------------------------------------------------------
  // 8. New design.
  // -------------------------------------------------------------------
  await tab.getByRole('button', { name: 'New design' }).first().click();
  await tab.locator('.drawing').waitFor({ timeout: 15000 });
  check('8. New design: the drawing surface opened', (await tab.locator('.drawing').count()) === 1);

  // -------------------------------------------------------------------
  // 9. Place one device.
  // -------------------------------------------------------------------
  await openTheRail(tab);
  await dragPaletteItemOntoRack(tab, 0, 0);
  await tab.locator('.drawing-chassis').first().waitFor({ timeout: 15000 });
  await tab.waitForTimeout(1200); // the SaveQueue's own debounce plus one round trip
  const refusalCount = await tab.locator('.racks-place__refusal').count();
  check('9. place one device: it placed and saved with no refusal', refusalCount === 0, `refusal divs: ${refusalCount}`);
}

try {
  await main();
} catch (error) {
  failures += 1;
  console.error(error);
} finally {
  stopServer();
  psql(`DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE);`, { allowFailure: true });
  rmSync(work, { recursive: true, force: true });
}

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
