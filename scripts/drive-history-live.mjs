// Drives the REAL built client against the REAL server with TWO browsers on
// one design, to prove live co-editing (ADR-0063) end to end, and takes
// screenshots for a UI review.
//
//   node scripts/drive-history-live.mjs
//
// Needs: PostgreSQL on 127.0.0.1 with the `fathom_test`/`fathom_app` roles
// (no superuser: it uses the `fathom_test` database itself and resets its
// `public` schema before and after), a built client (`cd client && npm run
// build`), the `fathom-server` binary (`cargo build -p fathom-server
// --locked`) and Playwright's Chromium. The seed is a throwaway Rust test
// (`drive-lib/seed_live_coediting.rs`, the pattern `drive-first-design.mjs`
// uses) copied under crates/fathom-server/tests for the run and deleted.
//
// Accounts: Ann (steward, "A"), Bob (draw, "B"), Cy (read only).
// Screenshots: FATHOM_SHOTS (default /mnt/project-files/reviews/history-live/).
//
// The server is killed BY PORT, never by name.

import { execFileSync, spawn } from 'node:child_process';
import { copyFileSync, createWriteStream, mkdirSync, readFileSync, rmSync } from 'node:fs';
import net from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrateUrl, runtimeUrl } from './drive-lib/db.mjs';
import { barAction } from './drive-lib/bar.mjs';

const pw = await import(process.env.PW_PLAYWRIGHT || '/opt/node22/lib/node_modules/playwright/index.js');
const { chromium } = pw.default ?? pw;

const ROOT = process.env.FATHOM_ROOT || resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = process.env.PW_CHROMIUM || '/opt/pw-browsers/chromium';
const TARGET_DIR = process.env.CARGO_TARGET_DIR ?? resolve(ROOT, 'target');
const SERVER_BIN = process.env.FATHOM_SERVER_BIN ?? resolve(TARGET_DIR, 'debug', 'fathom-server');
const SHOTS = (process.env.FATHOM_SHOTS ?? '/mnt/project-files/reviews/history-live') + '/';
const WORK = process.env.FATHOM_DRIVE_DIR ?? join(process.env.TMPDIR ?? '/tmp', 'fathom-drive-history-live');
mkdirSync(SHOTS, { recursive: true });
mkdirSync(WORK, { recursive: true });

const PORT = 18190;
const URL_ = `http://127.0.0.1:${PORT}`;
// Bob's browser reaches the server through this proxy, so his network can be
// cut for real (sockets destroyed), which Playwright's offline mode does not do
// to a stream that is already open.
const PROXY_PORT = 18191;
const URL_B = `http://127.0.0.1:${PROXY_PORT}`;
const DB_NAME = 'fathom_test';
const MIGRATE_URL = migrateUrl(DB_NAME);
const RUNTIME_URL = runtimeUrl(DB_NAME);
const MASTER_KEY = join(WORK, 'master.key');
const CHAIN_KEY = join(WORK, 'chain.key');
const SEED_OUT = join(WORK, 'seed.json');
const SEED_SRC = join(ROOT, 'scripts/drive-lib/seed_live_coediting.rs');
const SEED_DST = join(ROOT, 'crates/fathom-server/tests/seed_live_coediting.rs');
const SETUP_PASSWORD = 'amber-kestrel-harbour-0057';
const OPERATOR = 'operator@fathom.invalid';
const PASSWORDS = {
  steward: 'live-edit-steward-passphrase-kept-for-this-proof-only',
  drawer: 'live-edit-drawer-passphrase-kept-for-this-proof-only',
  reader: 'live-edit-reader-passphrase-kept-for-this-proof-only',
};

const fails = [];
function check(name, ok, detail) {
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (detail ? '  [' + detail + ']' : ''));
  if (!ok) fails.push(name);
}
const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: 'utf8', ...opts });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForHttp(url, timeoutMs = 60000) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    try {
      return await fetch(url);
    } catch (e) {
      if (Date.now() > until) throw e;
      await sleep(300);
    }
  }
}

/** Polls `fn` until it returns truthy. */
async function until(fn, timeoutMs = 10000, what = '') {
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
  sh('psql', [MIGRATE_URL, '-qc', 'DROP SCHEMA public CASCADE; CREATE SCHEMA public;']);
}


function startProxy() {
  const sockets = new Set();
  let cut = false;
  const server = net.createServer((client) => {
    if (cut) return client.destroy();
    const upstream = net.connect(PORT, '127.0.0.1');
    for (const sock of [client, upstream]) {
      sockets.add(sock);
      sock.on('close', () => sockets.delete(sock));
      sock.on('error', () => sock.destroy());
    }
    client.pipe(upstream);
    upstream.pipe(client);
  });
  server.listen(PROXY_PORT, '127.0.0.1');
  return {
    sever() {
      cut = true;
      for (const sock of sockets) sock.destroy();
    },
    restore() {
      cut = false;
    },
    close() {
      server.close();
      for (const sock of sockets) sock.destroy();
    },
  };
}

let serverProc = null;
let serverLog = '';

async function signIn(page, address, password, url = URL_) {
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.locator('#signin-address').fill(address);
  await page.locator('#signin-password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.locator('.home, .drawing, .shell-bar').first().waitFor({ timeout: 20000 });
}

async function openTheRail(page) {
  const handle = page.getByRole('button', { name: 'Open the equipment list' });
  if ((await handle.count()) > 0) await handle.click();
}

async function dragPaletteItemOntoRack(page, itemIndex = 0, slot = 0) {
  const item = page.locator('.drawing-palette__item--model').nth(itemIndex);
  await item.waitFor({ state: 'visible', timeout: 15000 });
  const rack = page.locator('.drawing-rack__frame').first();
  await rack.waitFor({ state: 'visible', timeout: 15000 });
  const itemHandle = await item.elementHandle();
  const rackHandle = await rack.elementHandle();
  const box = await rack.boundingBox();
  const x = box.x + box.width / 2;
  const y = box.y + 30 + slot * 140;
  await page.evaluate(
    ([itemEl, rackEl, cx, cy]) => {
      const dt = new DataTransfer();
      itemEl.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }));
      rackEl.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: cx, clientY: cy }));
      rackEl.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: cx, clientY: cy }));
    },
    [itemHandle, rackHandle, x, y],
  );
}

// --- the editor panel's fields ---------------------------------------------

const panel = (page) => page.locator('.drawing-editor__panel');

/** The value span of a labelled field in the editor panel (not the title). */
const fieldValue = (page, label) =>
  panel(page).locator('.drawing-editor__field', { has: page.locator('.drawing-editor__field-label', { hasText: new RegExp('^' + label + '$') }) }).locator('.drawing-editor__field-value, span:not([data-testid="live-overwrite"] span)').first();

async function selectDevice(page) {
  await page.locator('.drawing-chassis').first().click();
  await panel(page).waitFor({ timeout: 10000 });
}

/** Two clicks make a field editable (selected, then editing); Enter commits. */
async function setField(page, locator, text) {
  await locator.click();
  if ((await page.locator('.drawing-editor__panel input.drawing-editor__field-value').count()) === 0) await locator.click();
  const input = page.locator('.drawing-editor__panel input.drawing-editor__field-value');
  await input.waitFor({ timeout: 5000 });
  await input.fill(text);
  await input.press('Enter');
}

const titleLocator = (page) => panel(page).locator('.drawing-editor__title span').first();
const titleText = async (page) => ((await panel(page).locator('.drawing-editor__title').first().innerText()) ?? '').trim();
const fieldText = async (page, label) => ((await fieldValue(page, label).innerText()) ?? '').trim();
const dotsOf = async (page) => (await page.locator('.shell-bar__people .shell-person').allInnerTexts()).map((t) => t.trim());
const chassisLabelsOnCanvas = async (page) => (await page.locator('.drawing-chassis').allInnerTexts()).join(' | ');

async function main() {
  console.log('==> resetting the fathom_test schema');
  resetSchema();
  rmSync(MASTER_KEY, { force: true });
  rmSync(CHAIN_KEY, { force: true });

  console.log('==> seeding: steward Ann, drawer Bob, reader Cy');
  copyFileSync(SEED_SRC, SEED_DST);
  const seedText = readFileSync(SEED_DST, 'utf8')
    .replace('@@STEWARD_PW@@', PASSWORDS.steward)
    .replace('@@DRAWER_PW@@', PASSWORDS.drawer)
    .replace('@@READER_PW@@', PASSWORDS.reader);
  (await import('node:fs')).writeFileSync(SEED_DST, seedText);
  const seedEnv = { ...process.env };
  delete seedEnv.DATABASE_URL;
  seedEnv.FATHOM_MIGRATE_DATABASE_URL = MIGRATE_URL;
  seedEnv.FATHOM_MASTER_KEY = `file://${MASTER_KEY}`;
  seedEnv.FATHOM_CHAIN_KEY = `file://${CHAIN_KEY}`;
  seedEnv.SEED_OUTPUT = SEED_OUT;
  sh('cargo', ['test', '-p', 'fathom-server', '--locked', '--test', 'seed_live_coediting', '--', '--nocapture'], {
    cwd: ROOT,
    env: seedEnv,
    stdio: 'inherit',
  });
  const seed = JSON.parse(readFileSync(SEED_OUT, 'utf8'));

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
      FATHOM_OPERATOR_NOTICE_ADDRESS: OPERATOR,
      FATHOM_SETUP_PASSWORD: SETUP_PASSWORD,
      FATHOM_BIND: `127.0.0.1:${PORT}`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const logStream = createWriteStream(join(WORK, 'server.log'));
  serverProc.stdout.on('data', (d) => { serverLog += d; logStream.write(d); });
  serverProc.stderr.on('data', (d) => { serverLog += d; logStream.write(d); });
  const health = await waitForHttp(`${URL_}/health`);
  check('the real fathom-server answers GET /health', health.status === 200);

  const firstRun = await new Promise((res) => {
    spawn('node', [`${ROOT}/scripts/ci/first-operator-signin.mjs`, SETUP_PASSWORD, OPERATOR, URL_], { stdio: 'inherit' }).on('exit', res);
  });
  check('the operator finished first run', firstRun === 0, `exit ${firstRun}`);
  if (firstRun !== 0) throw new Error('first run did not complete');

  const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
  try {
    await runProof(browser, seed);
  } finally {
    await browser.close();
  }
}

async function runProof(browser, seed) {
  const proxy = startProxy();
  const ctxA = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const ctxB = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const A = await ctxA.newPage();
  const B = await ctxB.newPage();
  for (const [n, p] of [['A', A], ['B', B]]) {
    p.on('pageerror', (e) => console.log(`[${n} pageerror] ${e}`));
    p.on('console', (m) => { if (m.type() === 'error') console.log(`[${n} console.error] ${m.text()}`); });
  }
  // What each browser tells the server about the view it is in.
  const views = { A: [], B: [] };
  for (const [n, p] of [['A', A], ['B', B]]) {
    p.on('request', (r) => {
      if (r.method() === 'POST' && /\/presence$/.test(r.url())) views[n].push(String(r.postDataBuffer()?.toString('latin1') ?? '').replace(/[^\x20-\x7e]/g, ''));
    });
  }
  const shotA = (name) => A.screenshot({ path: `${SHOTS}${name}.png` });
  const shotB = (name) => B.screenshot({ path: `${SHOTS}${name}.png` });
  /** Both screens side by side in one image: two PNGs only, so the review
   * sees each screen at full size; a pair is always taken together. */
  const shotBoth = async (name) => {
    await Promise.all([A.screenshot({ path: `${SHOTS}${name}-A.png` }), B.screenshot({ path: `${SHOTS}${name}-B.png` })]);
  };

  // ---- setup: Ann makes a site and a design with two devices ---------------
  await A.bringToFront();
  await signIn(A, seed.steward, PASSWORDS.steward);
  await A.getByRole('tab', { name: 'Organisation' }).click();
  await A.getByRole('button', { name: 'New site' }).click();
  await A.locator('#home-new-scope-label').fill('Live edit site');
  await A.getByRole('button', { name: 'Create', exact: true }).click();
  await A.getByText('Live edit site').waitFor({ timeout: 10000 });
  await A.getByRole('tab', { name: 'Designs' }).click();
  await A.getByRole('button', { name: 'New design' }).first().click();
  await A.locator('.drawing').waitFor({ timeout: 15000 });
  await openTheRail(A);
  await dragPaletteItemOntoRack(A, 0, 0);
  await A.locator('.drawing-chassis').first().waitFor({ timeout: 15000 });
  await A.waitForTimeout(1500);
  await dragPaletteItemOntoRack(A, 1, 1);
  await until(async () => (await A.locator('.drawing-chassis').count()) >= 2, 15000);
  await A.waitForTimeout(1500);
  check('setup: Ann placed two devices in the design', (await A.locator('.drawing-chassis').count()) >= 2, String(await A.locator('.drawing-chassis').count()));
  check('setup: Ann sees no refusal', (await A.locator('.racks-place__refusal').count()) === 0);

  // Bob signs in and lands on the same design (the only one).
  await B.bringToFront();
  await signIn(B, seed.drawer, PASSWORDS.drawer, URL_B);
  await B.locator('.drawing-chassis').first().waitFor({ timeout: 20000 });
  check('setup: Bob opens the same design and sees both devices', (await until(async () => (await B.locator('.drawing-chassis').count()) >= 2, 10000)) === true);

  // ---- history under live editing -----------------------------------------
  const rows = (page) => page.locator('.history__row');
  const labels = async (page) => (await chassisLabelsOnCanvas(page)).replace(/\s+/g, ' ');
  await A.bringToFront();
  await selectDevice(A);
  await setField(A, titleLocator(A), 'core-sw-01');
  await until(async () => (await labels(B)).includes('core-sw-01'), 10000);
  await A.waitForTimeout(2500);

  await barAction(A, 'history');
  await A.getByTestId('history-panel').waitFor({ timeout: 10000 });
  await rows(A).first().waitFor({ timeout: 15000 });
  const before = await rows(A).count();
  const verify = ((await A.getByTestId('history-verify').innerText()) ?? '').trim();
  check('H1. the panel lists the saves and the server check reads in words', before >= 2 && /Checked|Broken|old key/.test(verify), `${before} rows; ${verify}`);
  await shotA('h1-panel-open');

  // Bob edits while Ann's panel is open: a new row appears without reopening.
  await B.bringToFront();
  await selectDevice(B);
  await setField(B, titleLocator(B), 'bob-was-here');
  await until(async () => (await labels(A)).includes('bob-was-here'), 10000);
  const grew = await until(async () => (await rows(A).count()) > before, 15000);
  check('H2. a live change from Bob adds a row to Ann\'s open list', !!grew, `${before} -> ${await rows(A).count()}`);
  await until(async () => !((await rows(A).first().innerText()) ?? '').includes('…'), 15000);
  const newest = ((await rows(A).first().innerText()) ?? '').replace(/\s+/g, ' ');
  console.log('     newest row: ' + newest);
  check('H2. the newest row reads as an edit, not a raw id', /renamed|edited|core-sw-01|bob-was-here/.test(newest) && !/[0-9A-Z]{26}/.test(newest), newest);
  await shotA('h2-new-row-arrived');

  // Ann looks at the save before Bob's change: read-only, then Restore.
  await rows(A).nth(1).click();
  await A.locator('.history__btn', { hasText: 'Back to now' }).waitFor({ timeout: 10000 });
  const pastOk = await until(async () => (await labels(A)).includes('core-sw-01') && !(await labels(A)).includes('bob-was-here'), 10000);
  check('H3. picking the save before Bob\'s change shows the old name on the canvas', !!pastOk, await labels(A));
  await shotA('h3-past-save');
  await A.locator('.history__btn', { hasText: 'Restore this version' }).click();
  await A.getByRole('alertdialog').getByRole('button', { name: 'Restore', exact: true }).click();

  const aBack = await until(async () => (await labels(A)).includes('core-sw-01') && !(await labels(A)).includes('bob-was-here'), 10000);
  const bBack = await until(async () => (await labels(B)).includes('core-sw-01') && !(await labels(B)).includes('bob-was-here'), 15000);
  check('H4. Ann restores during the live session; her canvas shows the old name', !!aBack, await labels(A));
  check('H4. Bob sees the restore arrive live as an ordinary change', !!bBack, await labels(B));
  await shotBoth('h4-after-restore');

  // It is a real save on the server: it survives a reload, and the list grew by one, both kept.
  await A.reload({ waitUntil: 'domcontentloaded' });
  await A.locator('.drawing-chassis').first().waitFor({ timeout: 20000 });
  check('H5. after a reload the restored name is still there', (await labels(A)).includes('core-sw-01') && !(await labels(A)).includes('bob-was-here'), await labels(A));
  await barAction(A, 'history');
  await rows(A).first().waitFor({ timeout: 15000 });
  const after = await rows(A).count();
  await until(async () => !((await rows(A).first().innerText()) ?? '').includes('…'), 15000);
  console.log('     rows: ' + JSON.stringify((await rows(A).allInnerTexts()).map((t) => t.replace(/\s+/g, ' '))));
  const top = ((await rows(A).first().innerText()) ?? '').replace(/\s+/g, ' ');
  check('H5. the restore is a new row on top and the older rows are all still listed', after > before + 1 && /Restored/.test(top), `${after} rows; top: ${top}`);
  check('H5. the server check still passes', /Checked/.test((await A.getByTestId('history-verify').innerText()) ?? ''), await A.getByTestId('history-verify').innerText());
  await shotA('h5-after-reload');

  await ctxA.close();
  await ctxB.close();
  proxy.close();
}

async function cleanup() {
  console.log('==> cleaning up');
  if (serverProc) { try { serverProc.kill('SIGTERM'); } catch {} }
  try { sh('fuser', ['-k', `${PORT}/tcp`]); } catch {}
  rmSync(SEED_DST, { force: true });
  try { resetSchema(); } catch (e) { console.log('could not reset the schema: ' + e); }
}

try {
  await main();
} catch (error) {
  console.error(error);
  check('the run completed without throwing', false, String(error));
  console.log(serverLog.slice(-3000));
} finally {
  await cleanup();
}
console.log(fails.length === 0 ? '\nALL PASS' : `\nFAIL: ${fails.length} check(s) failed`);
for (const f of fails) console.log('  - ' + f);
process.exit(fails.length === 0 ? 0 : 1);
