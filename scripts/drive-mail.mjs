// Drives Steward › Mail (ADR-0085, the alpha card's Mail) on the REAL built client against the
// REAL server: Ann the steward opens Mail with no mail settings applied, adds Jo with "Email them
// the link" ticked, sees the link card say the link is on its way, then watches the worker try it
// and Mail list it as not sent, with the reason. A last pass stubs the one route to show the page
// as it looks once an operator has set mail up (sent, waiting and failed rows), light and dark.
//
//   node scripts/drive-mail.mjs
//
// Needs what drive-people.mjs needs: PostgreSQL on 127.0.0.1 with the `fathom_test`/`fathom_app`
// roles, a built client (`cd client && npm run build`), the fathom-server binary (`cargo build -p
// fathom-server --locked`) and Playwright's Chromium. **It resets the fathom_test schema**, so do
// not run it beside the test suite. The seed is drive-lib/seed_people.rs (Ann, with a key made in
// her own browser), copied under crates/fathom-server/tests for the run and deleted.
//
// Screenshots: FATHOM_SHOTS (default /mnt/project-files/briefs/r141/). The server is killed BY
// PORT, never by name.

import { execFileSync, spawn } from 'node:child_process';
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
const SHOTS = (process.env.FATHOM_SHOTS ?? '/mnt/project-files/briefs/r141') + '/';
const WORK = process.env.FATHOM_DRIVE_DIR ?? join(process.env.TMPDIR ?? '/tmp', 'fathom-drive-mail');
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
const SEED_SRC = join(ROOT, 'scripts/drive-lib/seed_people.rs');
const SEED_DST = join(ROOT, 'crates/fathom-server/tests/seed_people.rs');
const SETUP_PASSWORD = 'amber-kestrel-harbour-0057';
const OPERATOR = 'operator@fathom.invalid';
const STEWARD_ADDRESS = 'ann.alder@northwind.example';
const STEWARD_PASSWORD = 'people-steward-passphrase-kept-for-this-proof-only';
const VIEWPORT = { width: 1280, height: 800 };

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

async function startServer() {
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
      FATHOM_OPERATOR_NOTICE_ADDRESS: OPERATOR,
      FATHOM_SETUP_PASSWORD: SETUP_PASSWORD,
      FATHOM_BIND: `127.0.0.1:${PORT}`,
      FATHOM_PUBLIC_URL: URL_,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const log = createWriteStream(join(WORK, 'server.log'));
  serverProc.stdout.pipe(log);
  serverProc.stderr.pipe(log);
  const health = await waitForHttp(`${URL_}/health`);
  check('the real fathom-server answers GET /health', health.status === 200);
  const firstRun = await new Promise((res) => {
    spawn('node', [`${ROOT}/scripts/ci/first-operator-signin.mjs`, SETUP_PASSWORD, OPERATOR, URL_], { stdio: 'inherit' }).on('exit', res);
  });
  check('the operator finished first run', firstRun === 0, `exit ${firstRun}`);
}

async function openMail(page) {
  await page.locator('.org-rail__item', { hasText: 'Mail' }).click();
  await page.getByTestId('steward-mail').waitFor({ timeout: 15000 });
}

const T = Math.floor(Date.now() / 1000);
const SET_UP = {
  set_up: true,
  links: true,
  from_address: 'fathom@northwind.example',
  problem: null,
  mail: [
    { id: 'mail_01', kind: 'invitation', state: 'queued', to: 'kit@northwind.example', what: 'Invitation for Kit Moss', attempts: 2, created_at_unix: T - 400, next_attempt_at_unix: T + 1500, finished_at_unix: null, last_reply: '451 4.7.1 Greylisted, please try again later' },
    { id: 'mail_02', kind: 'invitation', state: 'sent', to: 'jo@northwind.example', what: 'Invitation for Jo Kim', attempts: 1, created_at_unix: T - 3600, next_attempt_at_unix: null, finished_at_unix: T - 3596, last_reply: '250 2.0.0 Ok: queued as 4F2A1C0B7' },
    { id: 'mail_03', kind: 'invitation', state: 'failed', to: 'sam@nortwind.example', what: 'Invitation for Sam Lee', attempts: 1, created_at_unix: T - 86400, next_attempt_at_unix: null, finished_at_unix: T - 86398, last_reply: '550 5.1.1 <sam@nortwind.example>: Recipient address rejected: User unknown' },
  ],
};

async function main() {
  sh('psql', [MIGRATE_URL, '-qc', 'DROP SCHEMA IF EXISTS vault CASCADE; DROP SCHEMA public CASCADE; CREATE SCHEMA public;']);
  rmSync(MASTER_KEY, { force: true });
  rmSync(CHAIN_KEY, { force: true });
  const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
  try {
    const ctx = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 2 });
    const pubkey = await makeBrowserKey(ctx, STEWARD_ADDRESS);
    copyFileSync(SEED_SRC, SEED_DST);
    writeFileSync(SEED_DST, readFileSync(SEED_DST, 'utf8').replace('@@STEWARD_PW@@', STEWARD_PASSWORD));
    const env = { ...process.env, FATHOM_MIGRATE_DATABASE_URL: MIGRATE_URL, FATHOM_MASTER_KEY: `file://${MASTER_KEY}`, FATHOM_CHAIN_KEY: `file://${CHAIN_KEY}`, SEED_OUTPUT: SEED_OUT, SEED_STEWARD_ADDRESS: STEWARD_ADDRESS, SEED_STEWARD_PUBKEY: pubkey };
    delete env.DATABASE_URL;
    try {
      sh('cargo', ['test', '-p', 'fathom-server', '--locked', '--test', 'seed_people', '--', '--nocapture'], { cwd: ROOT, env, stdio: 'inherit' });
    } finally {
      rmSync(SEED_DST, { force: true });
    }
    const seed = JSON.parse(readFileSync(SEED_OUT, 'utf8'));
    await startServer();

    const A = await ctx.newPage();
    A.on('pageerror', (e) => console.log(`[pageerror] ${e}`));
    await A.goto(URL_, { waitUntil: 'domcontentloaded' });
    await A.locator('#signin-address').fill(seed.steward);
    await A.locator('#signin-password').fill(STEWARD_PASSWORD);
    await A.getByRole('button', { name: 'Sign in' }).click();
    await A.locator('.home, .drawing, .shell-bar').first().waitFor({ timeout: 20000 });
    await A.getByRole('tab', { name: 'Steward' }).click();

    // 1. Mail, before an operator has set it up.
    await openMail(A);
    check('M1. Mail is in the Steward list under Work, with no Not finished mark', (await A.locator('.org-rail__item', { hasText: 'Mail' }).innerText()).trim() === 'Mail');
    check('M1. it says nothing is mailed until mail is set up', await A.getByTestId('steward-mail-not-set-up').isVisible());
    await A.screenshot({ path: `${SHOTS}r141-mail-not-set-up.png` });

    // 2. Add Jo with the link mailed.
    await A.locator('.org-rail__item', { hasText: 'People' }).click();
    await A.getByRole('button', { name: 'Add someone' }).first().click();
    const form = A.locator('.org-form');
    await form.locator('input.org-input').nth(0).fill('Jo Kim');
    await form.locator('input.org-input').nth(1).fill('jo@northwind.example');
    await A.getByTestId('invite-mail-tick').locator('input').check();
    await A.screenshot({ path: `${SHOTS}r141-add-someone-tick.png` });
    await form.getByRole('button', { name: 'Add' }).click();
    await A.getByTestId('invite-link-card').waitFor({ timeout: 20000 });
    const card = (await A.getByTestId('invite-mailed').innerText()).replace(/\s+/g, ' ');
    check('M2. the link card says the link is on its way and the sign-in name is the Steward’s to give', /on its way by mail/.test(card) && /sign-in name yourself/.test(card), card);
    await A.screenshot({ path: `${SHOTS}r141-link-card-mailed.png` });
    await A.getByRole('button', { name: 'Done' }).click();

    // 3. The worker tries it within a tick; with no settings it fails and says why.
    await openMail(A);
    let failed = false;
    for (let i = 0; i < 20 && !failed; i++) {
      await A.getByTestId('steward-mail-refresh').click();
      await sleep(1500);
      failed = (await A.locator('[data-testid="steward-mail-list"] tr[data-state="failed"]').count()) > 0;
    }
    const row = failed ? (await A.locator('[data-testid="steward-mail-list"] tbody tr').first().innerText()).replace(/\s+/g, ' ') : '';
    check('M3. the real worker tried Jo’s mail and Mail lists it as not sent, with the reason', failed && /Invitation for Jo Kim/.test(row) && /not set up/.test(row), row);
    // The app scrolls inside its own pane, so a full-page shot stops at the fold: make the window tall instead.
    const wide = A.viewportSize();
    await A.setViewportSize({ width: wide.width, height: 1150 });
    await sleep(300);
    await A.screenshot({ path: `${SHOTS}r141-mail-not-sent.png` });

    // 4. As it looks once mail is set up (the one route stubbed), light and dark, and at phone width.
    await A.route('**/organisations/*/mail', (route) =>
      route.request().method() === 'GET' ? route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(SET_UP) }) : route.continue(),
    );
    await A.getByTestId('steward-mail-refresh').click();
    await A.getByTestId('steward-mail-ready').waitFor({ timeout: 10000 });
    check('M4. once set up, it names the from address and lists sent, waiting and failed mail', (await A.locator('[data-testid="steward-mail-list"] tbody tr').count()) === 3);
    await A.screenshot({ path: `${SHOTS}r141-mail-set-up.png` });
    await A.emulateMedia({ colorScheme: 'dark' });
    await A.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
    await sleep(300);
    await A.screenshot({ path: `${SHOTS}r141-mail-set-up-dark.png` });
    await A.evaluate(() => document.documentElement.removeAttribute('data-theme'));
    await A.emulateMedia({ colorScheme: 'light' });
    await A.setViewportSize({ width: 390, height: 2200 });
    await sleep(400);
    await A.screenshot({ path: `${SHOTS}r141-mail-phone.png` });
  } finally {
    await browser.close();
    if (serverProc) serverProc.kill();
    try { sh('fuser', ['-k', `${PORT}/tcp`]); } catch {}
  }
  if (fails.length > 0) process.exit(1);
}

await main();
