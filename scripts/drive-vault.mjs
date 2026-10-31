// Drives the REAL built client against the REAL server through the password vault (ADR-0071, round
// 32 mockups): three people, each in their own browser with the signing key that browser made, set
// up their vaults; the admin makes the recovery sheet; logins are stored from a device's Logins tab,
// shared, revealed, locked and unlocked; a login only Bob holds is opened by the admin with the
// sheet; the admin lets Fathom use a login (the consent screen, waiting for a second admin while
// it is shared, stopping, then on at once once only they hold it); and the database is swept for
// every password and name typed, which must appear nowhere. Between, breach checks: an admin sets
// the policy at two levels, an unlock checks what is due against a stand-in breach list, and a
// critical login refuses a breached password.
//
//   node scripts/drive-vault.mjs
//
// Needs: PostgreSQL on 127.0.0.1 with the `fathom_test`/`fathom_app` roles (it resets the
// `fathom_test` database's `public` and `vault` schemas before and after), a built client
// (`bash scripts/build-wasm.sh && cd client && npm run build`), the fathom-server binary
// (`cargo build -p fathom-server --locked`) and Playwright's Chromium. The seed is
// drive-lib/seed_vault.rs, copied under crates/fathom-server/tests for the run and deleted.
//
// Accounts: Ann (admin), Bob and Cy (members). Screenshots: FATHOM_SHOTS (default
// /mnt/project-files/reviews/vault/). The server is killed BY PORT, never by name.

import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, createWriteStream, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrateUrl, runtimeUrl } from './drive-lib/db.mjs';
import { check, fails } from './drive-lib/kit.mjs';

const pw = await import(process.env.PW_PLAYWRIGHT || '/opt/node22/lib/node_modules/playwright/index.js');
const { chromium } = pw.default ?? pw;

const ROOT = process.env.FATHOM_ROOT || resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = process.env.PW_CHROMIUM || '/opt/pw-browsers/chromium';
const TARGET_DIR = process.env.CARGO_TARGET_DIR ?? resolve(ROOT, 'target');
const SERVER_BIN = process.env.FATHOM_SERVER_BIN ?? resolve(TARGET_DIR, 'debug', 'fathom-server');
const SHOTS = (process.env.FATHOM_SHOTS ?? '/mnt/project-files/reviews/vault') + '/';
const WORK = process.env.FATHOM_DRIVE_DIR ?? join(process.env.TMPDIR ?? '/tmp', 'fathom-drive-vault');
mkdirSync(SHOTS, { recursive: true });
mkdirSync(WORK, { recursive: true });

const PORT = 18193;
const URL_ = `http://127.0.0.1:${PORT}`;
const DB_NAME = 'fathom_test';
const MIGRATE_URL = migrateUrl(DB_NAME);
const RUNTIME_URL = runtimeUrl(DB_NAME);
const MASTER_KEY = join(WORK, 'master.key');
const CHAIN_KEY = join(WORK, 'chain.key');
const SEED_OUT = join(WORK, 'seed.json');
const SEED_SRC = join(ROOT, 'scripts/drive-lib/seed_vault.rs');
const SEED_DST = join(ROOT, 'crates/fathom-server/tests/seed_vault.rs');
const SETUP_PASSWORD = 'amber-kestrel-harbour-0057';
const OPERATOR = 'operator@fathom.invalid';
const VIEWPORT = { width: 1440, height: 900 };

const PEOPLE = {
  ann: { address: 'ann.alder@acme.example', password: 'vault-drive-ann-sign-in-passphrase', vault: 'ann keeps the copper lantern lit', tag: 'ANN' },
  bob: { address: 'bob.birch@acme.example', password: 'vault-drive-bob-sign-in-passphrase', vault: 'bob rides the slow river barge', tag: 'BOB' },
  cy: { address: 'cy.cedar@acme.example', password: 'vault-drive-cy-sign-in-passphrase', vault: 'cy counts the quiet winter stars', tag: 'CY' },
};
/** Typed into the vault; none of these may reach the database in the clear. */
const hibpAsked = [];
const TYPED = { bobOwn: 'Ups-Only-Bob-7731!', bobOwnName: 'ups-mgmt', note: 'console on port 9, ask facilities' };
const BREACHED_SHA1 = createHash('sha1').update(TYPED.bobOwn).digest('hex').toUpperCase();

const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: 'utf8', ...opts });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForHttp(url, timeoutMs = 60000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    try {
      return await fetch(url);
    } catch (e) {
      if (Date.now() > end) throw e;
      await sleep(300);
    }
  }
}

async function until(fn, timeoutMs = 10000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    let v;
    try { v = await fn(); } catch { v = false; }
    if (v) return v;
    if (Date.now() > end) return false;
    await sleep(150);
  }
}

function resetSchema() {
  sh('psql', [MIGRATE_URL, '-qc', 'DROP SCHEMA IF EXISTS vault CASCADE; DROP SCHEMA public CASCADE; CREATE SCHEMA public;']);
}

let serverProc = null;

async function makeBrowserKey(ctx, address) {
  await ctx.route('**/*', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>blank</title>' }));
  const page = await ctx.newPage();
  await page.goto(URL_);
  const hex = await page.evaluate(async (slot) => {
    const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
    await new Promise((resolve, reject) => {
      const open = indexedDB.open('fathom-enrolled-keys', 2);
      open.onupgradeneeded = () => {
        for (const store of ['keys', 'pending']) if (!open.result.objectStoreNames.contains(store)) open.result.createObjectStore(store);
      };
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const tx = open.result.transaction('keys', 'readwrite');
        tx.objectStore('keys').put(pair, slot);
        tx.oncomplete = () => { open.result.close(); resolve(); };
        tx.onerror = () => reject(tx.error);
      };
    });
    const raw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
    return Array.from(raw, (b) => b.toString(16).padStart(2, '0')).join('');
  }, address);
  await page.close();
  await ctx.unroute('**/*');
  return hex;
}

/** Give this browser a key the server never saw, in place of its own: what a browser holds
 * after the server's data is set up again. Signing in still works, by password. */
async function swapForUnknownKey(page, address) {
  await page.evaluate(async (slot) => {
    const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
    await new Promise((resolve, reject) => {
      const open = indexedDB.open('fathom-enrolled-keys', 2);
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const tx = open.result.transaction('keys', 'readwrite');
        tx.objectStore('keys').put(pair, slot);
        tx.oncomplete = () => { open.result.close(); resolve(); };
        tx.onerror = () => reject(tx.error);
      };
    });
  }, address);
}

async function startServer() {
  console.log('==> starting fathom-server on ' + URL_);
  try { sh('fuser', ['-k', `${PORT}/tcp`]); } catch {}
  serverProc = spawn(SERVER_BIN, [], {
    cwd: ROOT,
    env: {
      ...process.env,
      DATABASE_URL: RUNTIME_URL,
      FATHOM_MIGRATE_DATABASE_URL: MIGRATE_URL,
      FATHOM_SCHEMA_ROOT: `${ROOT}/schema`,
      FATHOM_CLIENT_ROOT: `${ROOT}/client/dist`,
      FATHOM_MASTER_KEY: `file://${MASTER_KEY}`,
      FATHOM_CHAIN_KEY: `file://${CHAIN_KEY}`,
      // Made on first start, as compose's db start would.
      FATHOM_VAULT_KEY: `file://${join(WORK, 'vault.key')}`,
      FATHOM_OPERATOR_NOTICE_ADDRESS: OPERATOR,
      FATHOM_SETUP_PASSWORD: SETUP_PASSWORD,
      FATHOM_BIND: `127.0.0.1:${PORT}`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const logStream = createWriteStream(join(WORK, 'server.log'));
  serverProc.stdout.on('data', (d) => logStream.write(d));
  serverProc.stderr.on('data', (d) => logStream.write(d));
  const health = await waitForHttp(`${URL_}/health`);
  check('the real fathom-server answers GET /health', health.status === 200);
  const firstRun = await new Promise((res) => {
    spawn('node', [`${ROOT}/scripts/ci/first-operator-signin.mjs`, SETUP_PASSWORD, OPERATOR, URL_], { stdio: 'inherit' }).on('exit', res);
  });
  check('the operator finished first run', firstRun === 0, `exit ${firstRun}`);
  if (firstRun !== 0) throw new Error('first run did not complete');
}

async function signIn(page, who) {
  await page.goto(URL_, { waitUntil: 'domcontentloaded' });
  await page.locator('#signin-address').fill(who.address);
  await page.locator('#signin-password').fill(who.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.locator('.home, .drawing, .shell-bar').first().waitFor({ timeout: 20000 });
}

/** A member who is not an admin keeps their own vault under Home › Passwords. */
async function openMyPasswords(page) {
  await page.getByRole('tab', { name: 'Passwords' }).click();
  await page.getByTestId('vault-passwords').waitFor({ timeout: 15000 });
}

async function openAdminPasswords(page) {
  await page.getByRole('tab', { name: 'Steward' }).click();
  await page.getByTestId('rail-passwords').click();
  await page.locator('[data-testid="vault-admin"], [data-testid="vault-passwords"]').first().waitFor({ timeout: 15000 });
}

/** The whole setup: kit first, then the passphrase. Answers the kit's code as shown. */
async function setUpVault(page, who, shot) {
  await page.getByTestId('vault-setup-open').first().click();
  await page.getByTestId('vault-setup').waitFor();
  if (shot) await page.screenshot({ path: `${SHOTS}${shot}-1-intro.png` });
  await page.getByTestId('vault-setup-next').click();
  await page.getByTestId('vault-kit-sheet').waitFor();
  const code = (await page.getByTestId('vault-code').innerText()).replace(/\s+/g, '-');
  if (shot) await page.screenshot({ path: `${SHOTS}${shot}-2-kit.png` });
  check(`${who.tag}: Continue waits for "I have saved my Emergency Kit"`, await page.getByTestId('vault-setup-next').isDisabled());
  await page.getByTestId('vault-kit-saved').check();
  await page.getByTestId('vault-setup-next').click();
  await page.getByTestId('vault-new-passphrase').fill(who.vault);
  await page.getByTestId('vault-new-passphrase-again').fill(who.vault);
  if (shot) await page.screenshot({ path: `${SHOTS}${shot}-3-passphrase.png` });
  await page.getByTestId('vault-setup-finish').click();
  if (who.unknownKey) {
    await page.getByTestId('vault-stale-key').waitFor({ timeout: 30000 });
    check(`${who.tag}: a key the server does not know is explained, not answered with "no signing key"`, !(await page.getByTestId('vault-setup').innerText()).includes('no signing key'));
    if (shot) await page.screenshot({ path: `${SHOTS}${shot}-4-unknown-key.png` });
    await page.getByTestId('vault-new-key-here').click();
  }
  await page.getByTestId('vault-setup-done').waitFor({ timeout: 30000 });
  await page.getByTestId('vault-setup-done').click();
  return code;
}

async function main() {
  console.log('==> resetting the fathom_test schemas');
  resetSchema();
  rmSync(MASTER_KEY, { force: true });
  rmSync(CHAIN_KEY, { force: true });

  const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
  try {
    const ctx = {};
    const keys = {};
    for (const k of Object.keys(PEOPLE)) {
      ctx[k] = await browser.newContext({ viewport: VIEWPORT });
      keys[k] = await makeBrowserKey(ctx[k], PEOPLE[k].address);
    }
    console.log('==> seeding: Ann (admin), Bob and Cy (members), each with the key their browser made');
    copyFileSync(SEED_SRC, SEED_DST);
    writeFileSync(
      SEED_DST,
      readFileSync(SEED_DST, 'utf8')
        .replace('@@STEWARD_PW@@', PEOPLE.ann.password)
        .replace('@@BOB_PW@@', PEOPLE.bob.password)
        .replace('@@CY_PW@@', PEOPLE.cy.password),
    );
    const seedEnv = { ...process.env };
    delete seedEnv.DATABASE_URL;
    Object.assign(seedEnv, {
      FATHOM_MIGRATE_DATABASE_URL: MIGRATE_URL,
      FATHOM_MASTER_KEY: `file://${MASTER_KEY}`,
      FATHOM_CHAIN_KEY: `file://${CHAIN_KEY}`,
      SEED_OUTPUT: SEED_OUT,
      SEED_STEWARD_ADDRESS: PEOPLE.ann.address,
      SEED_STEWARD_PUBKEY: keys.ann,
      SEED_BOB_ADDRESS: PEOPLE.bob.address,
      SEED_BOB_PUBKEY: keys.bob,
      SEED_CY_ADDRESS: PEOPLE.cy.address,
      SEED_CY_PUBKEY: keys.cy,
    });
    try {
      sh('cargo', ['test', '-p', 'fathom-server', '--locked', '--test', 'seed_vault', '--', '--nocapture'], { cwd: ROOT, env: seedEnv, stdio: 'inherit' });
    } finally {
      rmSync(SEED_DST, { force: true });
    }
    await startServer();
    await runProof(ctx);
  } finally {
    await browser.close();
    if (serverProc) serverProc.kill();
    try { sh('fuser', ['-k', `${PORT}/tcp`]); } catch {}
    resetSchema();
  }
}

async function runProof(ctx) {
  const page = {};
  for (const k of Object.keys(PEOPLE)) {
    page[k] = await ctx[k].newPage();
    page[k].on('pageerror', (e) => console.log(`[${k} pageerror] ${e}`));
    page[k].on('response', (r) => { if (r.status() === 404) console.log(`[${k} 404] ${r.request().method()} ${new URL(r.url()).pathname}`); });
    page[k].on('console', (m) => { if (m.type() === 'error') console.log(`[${k} console.error] ${m.text()}`); });
    await ctx[k].grantPermissions(['clipboard-read', 'clipboard-write'], { origin: URL_ });
    // The breach list, answered here: this machine cannot reach it, and a drive must not depend
    // on a third party. It lists Bob's password as breached and pads like the real one.
    await ctx[k].route('https://api.pwnedpasswords.com/range/*', (route) => {
      const req = route.request();
      const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'add-padding' };
      if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
      const prefix = new URL(req.url()).pathname.split('/').pop();
      hibpAsked.push({ prefix, padding: req.headers()['add-padding'] });
      const lines = ['0018A45C4D1DEF81644B54AB7F969B88D65:0'];
      if (prefix === BREACHED_SHA1.slice(0, 5)) lines.push(`${BREACHED_SHA1.slice(5)}:4242`);
      return route.fulfill({ status: 200, headers: { ...cors, 'content-type': 'text/plain' }, body: lines.join('\r\n') });
    });
  }
  const { ann: A, bob: B, cy: C } = page;
  const shot = (p, name) => p.screenshot({ path: `${SHOTS}${name}.png` });

  // ---- 1. everyone sets up a vault; Ann's screens are the record --------------------------
  await signIn(A, PEOPLE.ann);
  check('1. Ann (admin) has her own Passwords tab on Home, beside Organisation', await until(() => A.getByRole('tab', { name: 'Passwords' }).isVisible(), 10000));
  await openAdminPasswords(A);
  check('1. Ann (admin) sees "Set up your vault" before anything else', await A.getByTestId('vault-strip-setup').isVisible());
  await shot(A, '01-admin-before-setup');
  const annKit = await setUpVault(A, PEOPLE.ann, '02-setup');
  check('1. the Emergency Kit shows a 26-character vault key in five groups', /^[0-9A-Z]{5}(-[0-9A-Z]{5}){3}-[0-9A-Z]{6}$/.test(annKit), annKit);
  check('1. after setup the avatar wears the lock badge', await until(() => A.getByTestId('vault-badge').isVisible(), 5000));

  for (const k of ['bob', 'cy']) {
    await signIn(page[k], PEOPLE[k]);
    await openMyPasswords(page[k]);
    // Cy's browser holds a key the server never saw, as after the server's data is set up again.
    if (k === 'cy') await swapForUnknownKey(page[k], PEOPLE[k].address);
    await setUpVault(page[k], k === 'cy' ? { ...PEOPLE[k], unknownKey: true } : PEOPLE[k], k === 'cy' ? '02c-cy-setup' : null);
    check(`1. ${PEOPLE[k].tag} set up a vault in their own browser`, await until(() => page[k].getByTestId('vault-badge').isVisible(), 5000));
  }

  // ---- 2. the recovery sheet ------------------------------------------------------------
  await A.reload();
  await openAdminPasswords(A);
  await A.getByTestId('vault-make-sheet').click();
  await A.getByTestId('vault-sheet-made').waitFor({ timeout: 15000 });
  const sheet = (await A.locator('[data-testid="vault-sheet-made"] [data-testid="vault-code"]').innerText()).replace(/\s+/g, '-');
  check('2. the recovery sheet shows a 52-character code in 13 groups', /^[0-9A-Z]{4}(-[0-9A-Z]{4}){12}$/.test(sheet), sheet);
  await shot(A, '03-recovery-sheet');
  await A.getByTestId('vault-sheet-done').click();
  check('2. the admin page names the sheet with its fingerprint', /Fingerprint [0-9A-Z]{6}-/.test(await A.getByTestId('vault-recovery-card').innerText()));

  // ---- 3. Ann makes a design with a device and stores its login from the Logins tab -------
  // New design makes the organisation's first site itself.
  await A.getByRole('tab', { name: 'Designs' }).click();
  await A.getByRole('button', { name: 'New design' }).first().click();
  await A.locator('.drawing').waitFor({ timeout: 20000 });
  const rail = A.getByRole('button', { name: 'Open the equipment list' });
  if ((await rail.count()) > 0) await rail.click();
  const item = A.locator('.drawing-palette__item--model').first();
  await item.waitFor({ state: 'visible', timeout: 15000 });
  const rack = A.locator('.drawing-rack__frame').first();
  await rack.waitFor({ state: 'visible', timeout: 15000 });
  const box = await rack.boundingBox();
  await A.evaluate(([itemEl, rackEl, cx, cy]) => {
    const dt = new DataTransfer();
    itemEl.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }));
    rackEl.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: cx, clientY: cy }));
    rackEl.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: cx, clientY: cy }));
  }, [await item.elementHandle(), await rack.elementHandle(), box.x + box.width / 2, box.y + 30]);
  await A.locator('.drawing-chassis').first().waitFor({ timeout: 15000 });
  await A.waitForTimeout(1200);
  await A.locator('.drawing-chassis').first().click();
  // Equipment and Details share the dock; a device placed from an open Equipment list keeps the list.
  if (!(await A.locator('.drawing-editor__panel').isVisible())) await A.getByTestId('dock-details').click();
  await A.locator('.drawing-editor__panel').waitFor({ timeout: 10000 });
  await A.getByRole('tab', { name: /^Logins/ }).click();
  await A.getByTestId('vault-logins-tab').waitFor();
  await A.getByTestId('vault-add').click();
  // The page reloaded since setup, so the vault is locked: Add asks to unlock first.
  await A.getByTestId('vault-unlock').waitFor({ timeout: 10000 });
  await shot(A, '04-unlock');
  await A.getByTestId('vault-passphrase').fill('not the passphrase at all');
  await A.getByTestId('vault-unlock-go').click();
  check('3. a wrong passphrase is refused in words', await until(async () => /does not open it/.test(await A.getByTestId('vault-unlock').innerText()), 15000));
  await A.getByTestId('vault-passphrase').fill(PEOPLE.ann.vault);
  await A.getByTestId('vault-unlock-go').click();
  await A.getByTestId('vault-login-dialog').waitFor({ timeout: 15000 });
  await A.getByTestId('vault-name').fill('admin');
  await A.getByTestId('vault-username').fill('admin');
  await A.getByTestId('vault-generate').click();
  const generated = await A.getByTestId('vault-password').inputValue();
  check('3. Generate one makes a 20-character password', generated.length === 20, generated.length);
  await A.getByLabel('Bob Birch').check();
  await shot(A, '05-add-login');
  await A.getByTestId('vault-save').click();
  await A.getByTestId('vault-card').first().waitFor({ timeout: 15000 });
  await A.getByTestId('vault-show').first().click();
  const shown = await until(async () => (await A.getByTestId('vault-plain').first().innerText()).includes(generated) && (await A.getByTestId('vault-plain').first().innerText()), 10000);
  check('3. Show opens the stored password in Ann’s browser, exactly as generated', !!shown);
  check('3. the card says who holds it', /You, Bob Birch, recovery sheet/.test(await A.getByTestId('vault-card').first().innerText()), await A.getByTestId('vault-card').first().innerText());
  check('3. the tab reads "Logins 1"', /Logins\s*1/i.test(await A.getByRole('tab', { name: /^Logins/ }).innerText()));
  await shot(A, '06-logins-tab');
  // The avatar menu: how long is left, and Lock now.
  await A.getByRole('button', { name: 'Account menu' }).click();
  check('3. the avatar menu says the vault is unlocked and when it locks', /Vault unlocked[\s\S]*Locks itself in 1[45] minutes/.test(await A.getByTestId('vault-menu').innerText()), await A.getByTestId('vault-menu').innerText());
  await shot(A, '07-avatar-menu');
  await A.getByTestId('vault-lock-now').click();
  check('3. Lock now takes the badge away', await until(async () => (await A.getByTestId('vault-badge').count()) === 0, 5000));
  check('3. locked, the password is masked again', (await A.getByTestId('vault-plain').count()) === 0);

  // ---- 4. Inventory › Passwords lists it --------------------------------------------------
  await A.getByRole('tab', { name: 'Inventory' }).click().catch(() => undefined);
  const side = A.locator('.inv-side, .inventory-place').getByText('Passwords', { exact: true }).first();
  if (await side.count()) {
    await side.click();
    await A.getByTestId('vault-passwords').waitFor({ timeout: 10000 });
    check('4. Inventory › Passwords lists the login and the device it is used on', /admin[\s\S]*Only people/.test(await A.getByTestId('vault-passwords').innerText()));
    await shot(A, '08-inventory-passwords');
  } else {
    check('4. Inventory has a Passwords section', false, 'no Passwords entry found');
  }

  // ---- 5. Bob reads what was shared with him; Cy sees nothing ------------------------------
  await B.reload();
  await openMyPasswords(B);
  await B.getByTestId('vault-unlock-open').click();
  await B.getByTestId('vault-passphrase').fill(PEOPLE.bob.vault);
  await B.getByTestId('vault-unlock-go').click();
  await until(() => B.getByTestId('vault-badge').isVisible(), 15000);
  await B.getByTestId('vault-row').first().click();
  await B.getByTestId('vault-show').first().click();
  check('5. Bob opens the login Ann shared with him, in his own browser', !!(await until(async () => (await B.getByTestId('vault-plain').first().innerText()).includes(generated), 10000)));
  await shot(B, '09-bob-reads-shared');

  // Bob stores one only he holds (with the sheet, which every login gets).
  await B.getByTestId('vault-add').click();
  await B.getByTestId('vault-name').fill(TYPED.bobOwnName);
  await B.getByTestId('vault-password').fill(TYPED.bobOwn);
  await B.locator('[data-testid="vault-login-dialog"] textarea').fill(TYPED.note);
  check('5. with the recovery sheet there is no "dies with my vault" warning', (await B.getByTestId('vault-alone').count()) === 0);
  await B.getByTestId('vault-save').click();
  check('5. Bob stores a login of his own', !!(await until(async () => (await B.getByTestId('vault-row').count()) === 2, 15000)), await B.getByTestId('vault-passwords').innerText());
  await shot(B, '09b-bob-own');

  await C.reload();
  await openMyPasswords(C);
  check('5. Cy, who holds nothing, sees no passwords at all', /No passwords are shared with you yet/.test(await C.getByTestId('vault-passwords').innerText()));
  await shot(C, '10-cy-sees-nothing');

  // ---- 6. the admin sees both, reads only one, and opens Bob's with the sheet ---------------
  // A reload reopens the only design; the brand goes Home.
  await A.locator('.shell-bar__brand').click();
  await A.locator('.home').waitFor({ timeout: 20000 });
  await openAdminPasswords(A);
  await until(async () => (await A.getByTestId('vault-admin').innerText()).includes(TYPED.bobOwnName), 10000);
  const adminText = await A.getByTestId('vault-admin').innerText();
  check('6. the admin list shows Bob’s login by name, marked "Can’t read"', adminText.includes(TYPED.bobOwnName) && /Can’t read/.test(adminText), adminText.slice(0, 400));
  await shot(A, '11-admin-list');
  await A.getByTestId('vault-row').filter({ hasText: TYPED.bobOwnName }).click();
  check('6. its detail says it is not shared with the admin', /not shared with you/.test(await A.getByTestId('vault-detail').innerText()));
  await A.getByTestId('vault-recover-open').click();
  await A.getByTestId('vault-recovery-code').fill(sheet.toLowerCase().replace(/-/g, ' '));
  await shot(A, '12-recover');
  await A.getByTestId('vault-recover-go').click();
  check('6. the sheet opens it and shares it to the admin', await until(async () => /Shared again from the recovery sheet/.test(await A.getByTestId('vault-admin').innerText()), 20000));
  check('6. the use is listed for every admin to see', !!(await until(async () => /Opened by Ann Alder/.test(await A.getByTestId('vault-recovery-card').innerText()), 10000)), await A.getByTestId('vault-recovery-card').innerText());
  await A.getByTestId('vault-row').filter({ hasText: TYPED.bobOwnName }).click();
  await A.getByTestId('vault-unlock-open').first().click().catch(() => undefined);
  if (await A.getByTestId('vault-unlock').count()) {
    await A.getByTestId('vault-passphrase').fill(PEOPLE.ann.vault);
    await A.getByTestId('vault-unlock-go').click();
    await until(() => A.getByTestId('vault-badge').isVisible(), 15000);
  }
  await A.getByTestId('vault-row').filter({ hasText: TYPED.bobOwnName }).click();
  await A.getByTestId('vault-detail').getByTestId('vault-show').click();
  check('6. after recovery the admin reads it', !!(await until(async () => (await A.getByTestId('vault-plain').first().innerText()).includes(TYPED.bobOwn), 10000)));
  await shot(A, '13-admin-after-recovery');

  // ---- 7. a new browser needs the kit once -------------------------------------------------
  await A.evaluate(() => {
    for (const k of Object.keys(localStorage)) if (k.startsWith('fathom.vault.kit.')) localStorage.removeItem(k);
  });
  await A.reload();
  await A.locator('.drawing').waitFor({ timeout: 20000 }); // a reload reopens the only design
  await A.locator('.shell-bar__brand').click();
  await A.locator('.home').waitFor({ timeout: 20000 });
  await openAdminPasswords(A);
  await A.getByTestId('vault-unlock-open').click();
  check('7. without the kit in this browser, unlock asks for the vault key', await A.getByTestId('vault-kit').isVisible());
  await A.getByTestId('vault-kit').fill(annKit.toLowerCase());
  await A.getByTestId('vault-passphrase').fill(PEOPLE.ann.vault);
  await A.getByTestId('vault-unlock-go').click();
  check('7. kit plus passphrase unlocks', await until(() => A.getByTestId('vault-badge').isVisible(), 15000));

  // ---- 8. Ann lets Fathom use a login (Mode B, part two) ------------------------------------
  const adminRow = () => A.getByTestId('vault-row').filter({ has: A.getByRole('button', { name: 'admin', exact: true }) });
  // A row opens and closes its detail; open it only when it is not already.
  const openAdmin = async () => {
    if ((await A.getByTestId('vault-detail').count()) === 0) await adminRow().click();
    await A.getByTestId('vault-detail').waitFor({ timeout: 10000 });
  };
  await openAdmin();
  await A.getByTestId('vault-detail').getByTestId('vault-fathom-on').click();
  await A.getByTestId('vault-fathom-consent').waitFor({ timeout: 10000 });
  const consentText = await A.getByTestId('vault-fathom-consent').innerText();
  check('8. the consent screen says the design’s sentence word for word', consentText.includes("After this change, Fathom's server can read this credential") && consentText.includes('It cannot be undone for the period it is in force.'));
  check('8. and what it protects, and what it does not', consentText.includes('Protects a stolen database or backup, not a compromised server.'));
  check('8. it says Bob holds it too, so another admin signs', /Bob Birch holds it too, so another admin signs/.test(consentText), consentText.slice(0, 600));
  check('8. nothing is signed until the tick', await A.getByTestId('vault-fathom-on-go').isDisabled());
  await shot(A, '14-fathom-consent');
  await A.getByTestId('vault-fathom-read').check();
  await A.getByTestId('vault-fathom-on-go').click();
  check('8. shared with Bob, it waits for another admin', !!(await until(async () => /Waiting for an admin/.test(await A.getByTestId('vault-admin').innerText()), 20000)));
  await openAdmin();
  check('8. the card says who asked and that a second admin signs', /You asked today; another admin signs/.test(await A.getByTestId('vault-detail').innerText()), await A.getByTestId('vault-detail').innerText());
  check('8. the one who asked is not offered the second signature', (await A.getByTestId('vault-fathom-countersign-open').count()) === 0);
  await shot(A, '15-fathom-waiting');

  await B.reload();
  await openMyPasswords(B);
  await B.getByTestId('vault-row').filter({ has: B.getByRole('button', { name: 'admin', exact: true }) }).click();
  const bobSees = await B.getByTestId('vault-detail').innerText();
  check('8. Bob sees it waiting, and as no admin is offered no signature', /Waiting for an admin/i.test(bobSees) && (await B.getByTestId('vault-fathom-countersign-open').count()) === 0, bobSees);

  // Stop, take Bob off, and ask again: now only Ann (and the sheet) hold it, so it is on at once.
  await A.getByTestId('vault-detail').getByTestId('vault-fathom-off-open').click();
  const offText = await A.getByTestId('vault-fathom-off').innerText();
  check('8. stopping says what it cannot undo', offText.replace(/\s+/g, ' ').includes('Anyone holding a backup from while Fathom could use it, with the server’s vault.key file from that time, can still read it. To revoke that, change the password on the device.'));
  await shot(A, '16-fathom-off');
  if (!/To revoke that/.test(offText)) console.log(offText);
  await A.getByTestId('vault-fathom-off-go').click();
  check('8. stopped, it is "Only people" again', !!(await until(async () => /Fathom no longer uses admin/.test(await A.getByTestId('vault-admin').innerText()), 15000)));
  await openAdmin();
  await A.getByTestId('vault-detail').locator('.vault-holder').filter({ hasText: 'Bob Birch' }).getByRole('button', { name: 'Remove' }).click();
  await until(async () => (await A.getByTestId('vault-detail').locator('.vault-holder').count()) === 0, 10000);
  await A.getByTestId('vault-detail').getByTestId('vault-fathom-on').click();
  await A.getByTestId('vault-fathom-read').check();
  await A.getByTestId('vault-fathom-on-go').click();
  check('8. held by Ann alone, Fathom can use it at once', !!(await until(async () => /Fathom can use admin now/.test(await A.getByTestId('vault-admin').innerText()), 20000)));
  await openAdmin();
  await until(async () => /Fathom can use it/i.test(await A.getByTestId('vault-detail').innerText()), 10000);
  const onText = await A.getByTestId('vault-detail').innerText();
  check('8. the card wears "Fathom can use it" and says it has not been used yet', /Fathom can use it/i.test(onText) && /Fathom has not used it yet/.test(onText), onText);
  check('8. the table says how Fathom keeps it', /Fathom can use it/i.test(await adminRow().innerText()));
  await shot(A, '17-fathom-on');

  // ---- 9. breach checks: the policy, a check at unlock, and a critical login ---------------
  const policy = A.getByTestId('vault-breach-policy');
  await policy.waitFor({ timeout: 10000 });
  await shot(A, '18-breach-policy-off');
  await A.getByTestId('vault-policy-org').getByLabel('Check').check();
  await A.getByTestId('vault-policy-snmp').getByLabel('SNMP policy').selectOption('own');
  await A.getByTestId('vault-policy-snmp-level').getByLabel('When one is found').selectOption('refuse');
  await A.getByTestId('vault-policy-save').click();
  check('9. an admin saves the policy at two levels', !!(await until(async () => /breach-check policy is saved/.test(await A.getByTestId('vault-admin').innerText()), 10000)));
  check('9. and it comes back as saved', (await A.getByTestId('vault-policy-org').getByLabel('Check').isChecked()) && (await A.getByTestId('vault-policy-snmp-level').getByLabel('When one is found').inputValue()) === 'refuse');
  check('9. with checks on and nothing checked, the list says "Not checked yet"', !!(await until(async () => /Not checked yet/.test(await A.getByTestId('vault-admin').innerText()), 10000)));
  await shot(A, '19-breach-policy-on');
  // Lock and unlock: the due checks run for the logins Ann holds.
  await A.getByRole('button', { name: 'Account menu' }).click();
  await A.getByTestId('vault-lock-now').click();
  await A.keyboard.press('Escape');
  await A.getByTestId('vault-unlock-open').click();
  await A.getByTestId('vault-passphrase').fill(PEOPLE.ann.vault);
  await A.getByTestId('vault-unlock-go').click();
  check('9. unlocking checks what is due and names what was found', !!(await until(async () => new RegExp(`Found in a breach: ${TYPED.bobOwnName}`).test(await A.getByTestId('vault-admin').innerText()), 20000)), (await A.getByTestId('vault-admin').innerText()).slice(0, 300));
  const bobRow = A.getByTestId('vault-row').filter({ hasText: TYPED.bobOwnName });
  check('9. the list marks the breached one', !!(await until(async () => /Found in a breach/.test(await bobRow.innerText()), 10000)));
  check('9. and the other as not found', /Not found · today/.test(await adminRow().innerText()), await adminRow().innerText());
  check('9. only five-character prefixes were sent, each with padding', hibpAsked.length > 0 && hibpAsked.every((a) => /^[0-9A-F]{5}$/.test(a.prefix) && a.padding === 'true'), JSON.stringify(hibpAsked));
  await shot(A, '20-breach-found');
  // Critical: Ann marks the admin login critical, then tries to change it to the breached password.
  await openAdmin();
  await A.getByTestId('vault-detail').getByTestId('vault-critical-toggle').click();
  check('9. the card wears "Critical"', !!(await until(async () => (await A.getByTestId('vault-detail').getByTestId('vault-critical-tag').count()) === 1, 10000)));
  await A.getByTestId('vault-detail').getByTestId('vault-change').click();
  await A.getByTestId('vault-login-dialog').waitFor({ timeout: 10000 });
  await A.getByTestId('vault-password').fill(TYPED.bobOwn);
  await A.getByTestId('vault-save').click();
  check('9. a breached password is refused on a critical login, in words', !!(await until(async () => /marked critical/.test(await A.getByTestId('vault-login-dialog').innerText()), 15000)));
  await shot(A, '21-breach-refused');
  await A.getByTestId('vault-generate').click();
  await A.getByTestId('vault-save').click();
  check('9. a generated one saves', !!(await until(async () => (await A.getByTestId('vault-login-dialog').count()) === 0, 15000)));

  // ---- 10. nothing typed reached the database in the clear ----------------------------------
  const dump = sh('sudo', ['-n', '-u', 'postgres', 'pg_dump', '--data-only', '--schema=public', '--schema=vault', '-d', DB_NAME], { maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
  // As the superuser: the application role is held back by row-level security, and a sweep that
  // could not read every row would prove nothing.
  const hexOf = (s) => Buffer.from(s, 'utf8').toString('hex');
  for (const [what, value] of [['the generated password', generated], ['Bob’s password', TYPED.bobOwn], ['the sealed note', TYPED.note], ['a login name', TYPED.bobOwnName], ['a vault passphrase', PEOPLE.ann.vault], ['the recovery code', sheet.replace(/-/g, '')]]) {
    check(`10. ${what} is nowhere in the database, as text or as hex`, !dump.includes(value) && !dump.toLowerCase().includes(hexOf(value)));
  }
  check('10. the sweep can see the vault (positive control: the chain names a vault act)', dump.includes('vault_shared') || dump.includes('vault_entry_created'));
  const copies = sh('sudo', ['-n', '-u', 'postgres', 'psql', '-At', '-d', DB_NAME, '-c', "SELECT state || ':' || octet_length(copy_ct) FROM vault.fathom_copies"], { stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  check('10. and Fathom’s copy is there, sealed, so the sweep covered it (positive control)', /^on:\d{2,}$/.test(copies), copies);

  console.log(fails.length === 0 ? '\nALL PASS' : `\n${fails.length} FAILED:\n  ${fails.join('\n  ')}`);
  process.exitCode = fails.length === 0 ? 0 : 1;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
