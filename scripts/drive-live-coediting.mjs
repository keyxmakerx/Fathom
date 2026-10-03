// Drives the REAL built client against the REAL server with TWO browsers on
// one design, to prove live co-editing (ADR-0063) end to end, and takes
// screenshots for a UI review.
//
//   node scripts/drive-live-coediting.mjs
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
// Screenshots: FATHOM_SHOTS (default /mnt/project-files/reviews/live-coediting/).
//
// The server is killed BY PORT, never by name.

import { execFileSync, spawn } from 'node:child_process';
import { copyFileSync, createWriteStream, mkdirSync, readFileSync, rmSync } from 'node:fs';
import net from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrateUrl, runtimeUrl } from './drive-lib/db.mjs';

const pw = await import(process.env.PW_PLAYWRIGHT || '/opt/node22/lib/node_modules/playwright/index.js');
const { chromium } = pw.default ?? pw;

const ROOT = process.env.FATHOM_ROOT || resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = process.env.PW_CHROMIUM || '/opt/pw-browsers/chromium';
const TARGET_DIR = process.env.CARGO_TARGET_DIR ?? resolve(ROOT, 'target');
const SERVER_BIN = process.env.FATHOM_SERVER_BIN ?? resolve(TARGET_DIR, 'debug', 'fathom-server');
const SHOTS = (process.env.FATHOM_SHOTS ?? '/mnt/project-files/reviews/live-coediting') + '/';
const WORK = process.env.FATHOM_DRIVE_DIR ?? join(process.env.TMPDIR ?? '/tmp', 'fathom-drive-live-coediting');
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

  // ---- 1. presence dots ----------------------------------------------------
  const bothDots = await until(async () => {
    const a = await dotsOf(A);
    const b = await dotsOf(B);
    return a.length === 1 && b.length === 1 ? { a, b } : false;
  }, 15000);
  check('1. each sees exactly one dot, for the other person', !!bothDots, JSON.stringify(bothDots || { a: await dotsOf(A), b: await dotsOf(B) }));
  if (bothDots) {
    check('1. Ann sees Bob\'s initials (BB) and Bob sees Ann\'s (AA)', bothDots.a[0] === 'BB' && bothDots.b[0] === 'AA', JSON.stringify(bothDots));
  }
  await shotBoth('01-both-in-canvas-presence-dots');

  // ---- 2. A renames a device; B sees it without reload ---------------------
  await A.bringToFront();
  await selectDevice(A);
  await B.bringToFront();
  await selectDevice(B);
  await A.bringToFront();
  await setField(A, titleLocator(A), 'core-sw-01');
  const bSeesRename = await until(async () => (await chassisLabelsOnCanvas(B)).includes('core-sw-01') || (await titleText(B)).includes('core-sw-01'), 10000);
  check('2. Ann renames the device; Bob sees "core-sw-01" with no reload', !!bSeesRename, `B title: ${await titleText(B)} | canvas: ${await chassisLabelsOnCanvas(B)}`);
  await shotBoth('02-rename-reaches-other-screen');

  // ---- 3. different fields of the same device at about the same time -----
  await A.bringToFront();
  const aMgmt = fieldValue(A, 'Mgmt address');
  const bSerial = fieldValue(B, 'Serial');
  // Both edit now: open the editors on both, commit back-to-back.
  const openEditor = async (page, loc) => {
    await loc.click();
    if ((await page.locator('.drawing-editor__panel input.drawing-editor__field-value').count()) === 0) await loc.click();
    await page.locator('.drawing-editor__panel input.drawing-editor__field-value').waitFor({ timeout: 5000 });
  };
  await openEditor(A, aMgmt);
  await A.locator('.drawing-editor__panel input.drawing-editor__field-value').fill('10.20.30.40');
  await B.bringToFront();
  await openEditor(B, bSerial);
  await B.locator('.drawing-editor__panel input.drawing-editor__field-value').fill('SN-LIVE-0042');
  await Promise.all([
    A.locator('.drawing-editor__panel input.drawing-editor__field-value').press('Enter'),
    B.locator('.drawing-editor__panel input.drawing-editor__field-value').press('Enter'),
  ]);
  const both3 = await until(async () => {
    const r = [await fieldText(A, 'Mgmt address'), await fieldText(A, 'Serial'), await fieldText(B, 'Mgmt address'), await fieldText(B, 'Serial')];
    return r[0] === '10.20.30.40' && r[1] === 'SN-LIVE-0042' && r[2] === '10.20.30.40' && r[3] === 'SN-LIVE-0042' ? r : false;
  }, 12000);
  check('3. Mgmt address and Serial, edited at the same moment, both land on both screens', !!both3,
    JSON.stringify([await fieldText(A, 'Mgmt address'), await fieldText(A, 'Serial'), await fieldText(B, 'Mgmt address'), await fieldText(B, 'Serial')]));
  check('3. neither screen shows a "just after you" notice or a dropped-change note', (await A.locator('[data-testid="live-overwrite"], [data-testid="live-note"]').count()) === 0 && (await B.locator('[data-testid="live-overwrite"], [data-testid="live-note"]').count()) === 0);
  await shotBoth('03-different-fields-both-land');

  // ---- 4. same field: A sets, then B sets; A gets the notice -------------
  await A.bringToFront();
  await setField(A, fieldValue(A, 'Serial'), 'SN-ANN-1');
  await until(async () => (await fieldText(B, 'Serial')) === 'SN-ANN-1', 10000);
  await B.bringToFront();
  await setField(B, fieldValue(B, 'Serial'), 'SN-BOB-2');
  const notice = A.locator('[data-testid="live-overwrite"]');
  const gotNotice = await until(async () => (await notice.count()) === 1, 10000);
  const noticeText = gotNotice ? ((await notice.innerText()) ?? '').replace(/\s+/g, ' ') : '(no notice)';
  check('4. Ann sees "<Bob> changed the serial on core-sw-01 just after you", "yours -> theirs", Keep Bob\'s / Put mine back',
    !!gotNotice && /Bob\w* ?\w* changed the serial on core-sw-01 just after you/.test(noticeText) && /yours SN-ANN-1 → .*SN-BOB-2/.test(noticeText) && /Keep /.test(noticeText) && /Put mine back/.test(noticeText), noticeText);
  if (gotNotice) {
    const where = await notice.evaluate((el) => ({
      inEditor: !!el.closest('.drawing-editor__panel'),
      inInspector: !!el.closest('aside, .shell-editor, [class*="editor"]'),
      top: el.getBoundingClientRect().top,
    }));
    const serialTop = await fieldValue(A, 'Serial').evaluate((el) => el.getBoundingClientRect().top);
    const vh = await A.evaluate(() => window.innerHeight);
    check('4. the notice sits in the inspector, under the Serial field, visible without scrolling', where.inInspector && where.top > serialTop && where.top < vh - 40, JSON.stringify({ ...where, serialTop, viewportHeight: vh }));
  }
  check('4. Ann\'s Serial now shows Bob\'s value before choosing', (await fieldText(A, 'Serial')) === 'SN-BOB-2', await fieldText(A, 'Serial'));
  await A.bringToFront();
  await shotA('04a-ann-notice-under-the-field');
  if (gotNotice) {
    await notice.scrollIntoViewIfNeeded();
    await shotA('04a-ann-notice-scrolled-into-view');
    await A.locator('.shell-editor').evaluate((el) => { el.scrollTop = 0; });
  }
  await shotB('04a-bob-after-overwriting');
  if (gotNotice) {
    await A.getByRole('button', { name: 'Put mine back' }).click();
    const back = await until(async () => (await fieldText(A, 'Serial')) === 'SN-ANN-1' && (await fieldText(B, 'Serial')) === 'SN-ANN-1', 12000);
    check('4. after Put mine back both screens show Ann\'s value (SN-ANN-1)', !!back, `A=${await fieldText(A, 'Serial')} B=${await fieldText(B, 'Serial')}`);
    check('4. the notice goes away after the choice', (await A.locator('[data-testid="live-overwrite"]').count()) === 0);
    await shotBoth('04b-after-put-mine-back');
  }

  // ---- 5. B moves to Inventory: A's dot for B disappears -----------------
  await B.bringToFront();
  await B.locator('.shell-bar__tab', { hasText: 'Inventory' }).click();
  await B.locator('.shell-bar__tab--on', { hasText: 'Inventory' }).waitFor({ timeout: 10000 });
  const gone = await until(async () => (await dotsOf(A)).length === 0, 12000);
  check('5. Bob moves to Inventory; Ann\'s dot for Bob disappears', !!gone, JSON.stringify(await dotsOf(A)));
  check('5. Bob sees no dot for Ann in Inventory', (await dotsOf(B)).length === 0, JSON.stringify(await dotsOf(B)));
  await shotBoth('05-bob-in-inventory-no-dots');
  // And back: the view is Canvas or Inventory, so the dots return on their own.
  await B.locator('.shell-bar__tab', { hasText: 'Canvas' }).click();
  await B.locator('.drawing-chassis').first().waitFor({ timeout: 10000 });
  const back5 = await until(async () => (await dotsOf(A)).length === 1 && (await dotsOf(B)).length === 1, 12000);
  console.log('     presence posts so far: ' + JSON.stringify(views));
  check('5. Bob returns to Canvas (selecting nothing); the dots return', !!back5, `A sees ${JSON.stringify(await dotsOf(A))}, B sees ${JSON.stringify(await dotsOf(B))}`);
  await selectDevice(B);

  // Bob's earlier Serial was replaced by Ann's Put mine back: he gets the
  // notice too. Keep theirs clears it and leaves Ann's value.
  await B.bringToFront();
  const bNotice = (await B.locator('[data-testid="live-overwrite"]').count()) === 1;
  check('5. Bob, whose serial Ann put back, is shown the notice too', bNotice);
  if (bNotice) {
    console.log('     Bob\'s notice: ' + ((await B.locator('[data-testid="live-overwrite"]').innerText()) ?? '').replace(/\s+/g, ' '));
    await shotB('05b-bob-notice-after-put-mine-back');
    await B.locator('[data-testid="live-overwrite"]').getByRole('button', { name: /^Keep/ }).click();
    check('5. Keep (theirs) clears the notice and leaves Ann\'s serial', (await B.locator('[data-testid="live-overwrite"]').count()) === 0 && (await fieldText(B, 'Serial')) === 'SN-ANN-1');
  }

  // ---- 6. B loses the network, edits, gets it back -------------------------
  await B.bringToFront();
  proxy.sever();
  const t0 = Date.now();
  const sawDown = await until(async () => (await B.locator('[data-testid="live-down"]').count()) === 1, 30000);
  check('6. network cut: Bob sees the reconnecting line', !!sawDown, sawDown ? `after ${Math.round((Date.now() - t0) / 1000)} s` : 'never appeared in 30 s');
  await setField(B, fieldValue(B, 'Mgmt address'), '192.0.2.77');
  check('6. network cut: Bob\'s edit is kept on his own screen', (await fieldText(B, 'Mgmt address')) === '192.0.2.77', await fieldText(B, 'Mgmt address'));
  await B.waitForTimeout(1500);
  check('6. network cut: Ann has not got the edit yet', (await fieldText(A, 'Mgmt address')) !== '192.0.2.77');
  check('6. network cut: the reconnecting line is still up after the edit', (await B.locator('[data-testid="live-down"]').count()) === 1);
  await shotB('06a-bob-network-cut-reconnecting-line');
  await shotA('06a-ann-while-bob-is-cut');
  proxy.restore();
  const arrived = await until(async () => (await fieldText(A, 'Mgmt address')) === '192.0.2.77', 60000);
  check('6. network back: Bob\'s edit reaches Ann', !!arrived, `A mgmt=${await fieldText(A, 'Mgmt address')}`);
  const lineGone = await until(async () => (await B.locator('[data-testid="live-down"]').count()) === 0, 30000);
  check('6. the reconnecting line goes away', !!lineGone);
  await shotBoth('06b-after-reconnect');

  // 6x. Playwright's "offline" mode, for the record: it fails new requests
  // but leaves the open stream flowing. Informational, not a pass/fail.
  await ctxB.setOffline(true);
  await setField(B, fieldValue(B, 'Serial'), 'SN-OFFLINE-9');
  await B.waitForTimeout(20000);
  const downWhileOffline = (await B.locator('[data-testid="live-down"]').count()) === 1;
  const annGot = (await fieldText(A, 'Serial')) === 'SN-OFFLINE-9';
  console.log(`     6x: browser-offline emulation, 20 s after an edit: failed-send line shown=${downWhileOffline}, reached Ann=${annGot}`);
  check('6x. with the stream still open but sends failing, Bob is shown the line (failed-send indicator)', downWhileOffline);
  await shotB('06x-bob-playwright-offline-20s-after-edit');
  await ctxB.setOffline(false);
  const arrivedX = await until(async () => (await fieldText(A, 'Serial')) === 'SN-OFFLINE-9', 60000);
  console.log(`     6x: after going back online the edit reached Ann=${!!arrivedX}`);

  // ---- 8. the selection dot on the canvas ----------------------------------
  await A.bringToFront();
  const chassisBox = async (page, i) => page.locator('.drawing-chassis').nth(i).boundingBox();
  const peerBox = async (page) => (await page.locator('.drawing-peer').count()) > 0 ? page.locator('.drawing-peer').first().boundingBox() : null;
  const inside = (pb, cb) => pb && cb && pb.x >= cb.x - 2 && pb.x + pb.width <= cb.x + cb.width + 2 && pb.y >= cb.y - 2 && pb.y + pb.height <= cb.y + cb.height + 2;
  const nearTopRight = (pb, cb) => pb && cb && Math.abs((pb.x + pb.width) - (cb.x + cb.width)) < 12 && Math.abs(pb.y - cb.y) < 12;
  await B.bringToFront();
  await B.locator('.drawing-chassis').nth(1).click();
  await B.locator('.drawing-peer').count();
  const dot2 = await until(async () => {
    const pb = await peerBox(A);
    return pb && nearTopRight(pb, await chassisBox(A, 1)) ? pb : false;
  }, 10000);
  check('8. Bob selects the second device; Ann sees his initials dot at its top-right', !!dot2, JSON.stringify({ peer: await peerBox(A), device2: await chassisBox(A, 1), count: await A.locator('.drawing-peer').count(), text: await A.locator('.drawing-peer').allInnerTexts() }));
  check('8. the dot reads "BB" and is labelled with his name', ((await A.locator('.drawing-peer').first().innerText()) ?? '').trim() === 'BB' && /Bob/.test((await A.locator('.drawing-peer').first().getAttribute('aria-label')) ?? ''), (await A.locator('.drawing-peer').first().getAttribute('aria-label')) ?? '');
  await shotA('08a-ann-sees-bobs-selection-dot-device-2');
  await B.locator('.drawing-chassis').nth(0).click();
  const dot1 = await until(async () => {
    const pb = await peerBox(A);
    return pb && nearTopRight(pb, await chassisBox(A, 0)) && !nearTopRight(pb, await chassisBox(A, 1)) ? pb : false;
  }, 10000);
  check('8. Bob selects the first device; the dot moves to it', !!dot1, JSON.stringify({ peer: await peerBox(A), device1: await chassisBox(A, 0) }));
  check('8. Ann sees exactly one selection dot for Bob', (await A.locator('.drawing-peer').count()) === 1, String(await A.locator('.drawing-peer').count()));
  await shotA('08b-ann-sees-dot-moved-to-device-1');
  const annDotOnB = await until(async () => (await B.locator('.drawing-peer').count()) === 1, 8000);
  check('8. and Bob sees Ann\'s dot on the device Ann has selected', !!annDotOnB);
  await shotB('08c-bob-sees-anns-selection-dot');

  // ---- 9. two fields overwritten at once: one merged notice ----------------
  await A.bringToFront();
  await setField(A, fieldValue(A, 'Mgmt address'), '10.0.0.1');
  await setField(A, fieldValue(A, 'Serial'), 'SN-A-9');
  await until(async () => (await fieldText(B, 'Mgmt address')) === '10.0.0.1' && (await fieldText(B, 'Serial')) === 'SN-A-9', 10000);
  await B.bringToFront();
  await setField(B, fieldValue(B, 'Mgmt address'), '10.0.0.2');
  await setField(B, fieldValue(B, 'Serial'), 'SN-B-9');
  const merged9 = await until(async () => (await A.locator('[data-testid="live-overwrite"]').count()) >= 1 && (await fieldText(A, 'Serial')) === 'SN-B-9' && (await fieldText(A, 'Mgmt address')) === '10.0.0.2', 10000);
  const n9 = await A.locator('[data-testid="live-overwrite"]').count();
  const text9 = n9 > 0 ? ((await A.locator('[data-testid="live-overwrite"]').first().innerText()) ?? '').replace(/\s+/g, ' ') : '(none)';
  check('9. two fields overwritten by Bob show ONE notice naming both', !!merged9 && n9 === 1 && /address/.test(text9) && /serial/.test(text9), `notices=${n9}: ${text9}`);
  check('9. the merged notice carries a "yours -> theirs" line for each field and one Keep button', (text9.match(/yours /g) ?? []).length === 2 && (text9.match(/Keep /g) ?? []).length === 1, text9);
  await shotA('09a-ann-one-notice-for-two-fields');
  await A.locator('[data-testid="live-overwrite"]').first().scrollIntoViewIfNeeded().catch(() => {});
  await shotA('09a-ann-one-notice-for-two-fields-scrolled-into-view');
  await shotB('09a-bob-after-overwriting-two-fields');
  const putBacks = A.locator('[data-testid="live-overwrite"]').locator('button', { hasText: 'Put mine back' });
  if ((await putBacks.count()) >= 1) {
    await putBacks.first().click();
    await A.waitForTimeout(2000);
    const after = [await fieldText(A, 'Mgmt address'), await fieldText(A, 'Serial'), await fieldText(B, 'Mgmt address'), await fieldText(B, 'Serial')];
    const left = await A.locator('[data-testid="live-overwrite"]').count();
    console.log(`     9: after one Put mine back: A/B mgmt+serial = ${JSON.stringify(after)}, notices left on A=${left}`);
    check('9. Put mine back on one field restores just that field on both screens', after[0] === after[2] && after[1] === after[3] && (after[0] === '10.0.0.1') !== (after[1] === 'SN-A-9'), JSON.stringify(after));
    await shotA('09b-ann-after-putting-one-back');
    if (left > 0) await A.locator('[data-testid="live-overwrite"]').getByRole('button', { name: /^Keep/ }).click();
    check('9. Keep clears what is left', (await A.locator('[data-testid="live-overwrite"]').count()) === 0);
    for (const t of [500, 2000, 4000]) { await A.waitForTimeout(t); console.log(`     9: +${t}ms after Keep, notices on A: ` + JSON.stringify(await A.locator('[data-testid="live-overwrite"]').allInnerTexts())); }
  }
  await B.locator('[data-testid="live-overwrite"]').getByRole('button', { name: /^Keep/ }).click({ timeout: 3000 }).catch(() => {});

  // ---- 10. the notice follows the element, not the open panel --------------
  // Ann writes Serial on device 1, then looks at device 2; Bob overwrites
  // device 1's Serial. Ann's notice must not appear under device 2's fields.
  console.log(`     10: before: notices on A=${await A.locator('[data-testid="live-overwrite"]').count()}, on B=${await B.locator('[data-testid="live-overwrite"]').count()}`);
  await A.bringToFront();
  await A.locator('.drawing-chassis').nth(0).click();
  await setField(A, fieldValue(A, 'Serial'), 'SN-ANN-DEV1');
  await until(async () => (await fieldText(B, 'Serial')) === 'SN-ANN-DEV1', 10000);
  await A.locator('.drawing-chassis').nth(1).click();
  const aPanelTitle = await A.locator('.drawing-editor__panel .drawing-editor__title').first().innerText();
  await B.bringToFront();
  await setField(B, fieldValue(B, 'Serial'), 'SN-BOB-DEV1');
  await B.waitForTimeout(2500);
  console.log('     10: notice text(s) on A: ' + JSON.stringify(await A.locator('[data-testid="live-overwrite"]').allInnerTexts()));
  const n10 = await until(async () => (await A.locator('[data-testid="live-overwrite"]').count()) === 1, 10000);
  const place10 = n10 ? await A.locator('[data-testid="live-overwrite"]').evaluate((el) => ({
    inPanel: !!el.closest('.drawing-editor__panel'),
    inCorner: !!el.closest('.shell__notices-corner'),
    inInspector: !!el.closest('.shell-editor'),
    text: el.innerText.replace(/\s+/g, ' '),
  })) : null;
  check('10. Ann has device 2 open, Bob overwrote device 1: the notice is in the canvas corner, not under device 2\'s fields',
    !!n10 && place10.inCorner && !place10.inPanel, JSON.stringify({ panelShows: aPanelTitle.trim(), ...place10 }));
  check('10. the notice names device 1', !!n10 && /core-sw-01/.test(place10.text), place10?.text);
  await shotA('10-ann-other-device-open-notice-in-canvas-corner');
  // Opening the overwritten device brings it under the field.
  await A.locator('.drawing-chassis').nth(0).click();
  const moved = await until(async () => A.locator('[data-testid="live-overwrite"]').evaluate((el) => !!el.closest('.drawing-editor__panel')).catch(() => false), 8000);
  console.log(`     10: after Ann opens device 1 the notice is under its field: ${!!moved}`);
  await shotA('10b-ann-opens-device-1-notice-under-field');
  await A.locator('[data-testid="live-overwrite"]').getByRole('button', { name: /^Keep/ }).click().catch(() => {});
  await B.locator('[data-testid="live-overwrite"]').getByRole('button', { name: /^Keep/ }).click({ timeout: 2000 }).catch(() => {});

  // ---- 7. the read-only holder -------------------------------------------
  const ctxC = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const C = await ctxC.newPage();
  C.on('pageerror', (e) => console.log(`[C pageerror] ${e}`));
  await C.bringToFront();
  await signIn(C, seed.reader, PASSWORDS.reader);
  await C.locator('.drawing-chassis').first().waitFor({ timeout: 20000 });
  await selectDevice(C);
  const cDots = await until(async () => (await dotsOf(C)).length === 2, 15000);
  check('7. Cy (read only) sees both Ann and Bob as dots', !!cDots, JSON.stringify(await dotsOf(C)));
  const cInline = await titleLocator(C).evaluate((el) => getComputedStyle(el).cursor).catch(() => '');
  await titleLocator(C).click().catch(() => {});
  await titleLocator(C).click().catch(() => {});
  const cInputs = await C.locator('.drawing-editor__panel input.drawing-editor__field-value').count();
  check('7. Cy cannot open an editor on the device name', cInputs === 0, `inputs=${cInputs}`);
  const cPalette = await C.locator('.drawing-palette__item--model').count();
  const drop = await C.keyboard.press('Delete').then(() => 'pressed Delete');
  await C.waitForTimeout(1000);
  check('7. Cy pressing Delete changes nothing for Ann or Bob', (await A.locator('.drawing-chassis').count()) >= 1 && (await B.locator('.drawing-chassis').count()) >= 1);
  await C.screenshot({ path: `${SHOTS}07-reader-cannot-edit.png` });
  console.log(`     (reader: palette items=${cPalette}, title cursor=${cInline}, ${drop})`);
  // Ann's own change still reaches Cy live.
  await A.bringToFront();
  await setField(A, titleLocator(A), 'core-sw-01-renamed');
  const cSees = await until(async () => (await titleText(C)).includes('core-sw-01-renamed') || (await chassisLabelsOnCanvas(C)).includes('core-sw-01-renamed'), 10000);
  check('7. Ann\'s rename reaches Cy live', !!cSees);
  await ctxC.close();

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
