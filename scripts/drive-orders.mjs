// Drives the REAL built client against the REAL server through Orders (ADR-0084 pieces 4 and 5):
// Ann, a Steward, opens Steward › Order types (the list, the board, the file with a problem, the
// questions), then the Work tab's orders: an order with a job for her team, which she picks up,
// ticks and finishes; an order waiting for a sign-off, which she gives; and the form that opens
// a new order. Takes screenshots for the Sign-offs card, light and dark, and at phone width.
//
//   node scripts/drive-orders.mjs
//
// Needs what drive-people.mjs needs: PostgreSQL on 127.0.0.1 with the `fathom_test`/`fathom_app`
// roles, a built client (`cd client && npm run build`), the fathom-server binary
// (`cargo build -p fathom-server --locked`) and Playwright's Chromium. The seed is
// drive-lib/seed_orders.rs, copied under crates/fathom-server/tests for the run and deleted.
//
// Screenshots: FATHOM_SHOTS (default /mnt/project-files/reviews/orders/).
// The server is killed BY PORT, never by name.

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
const SHOTS = (process.env.FATHOM_SHOTS ?? '/mnt/project-files/reviews/orders') + '/';
const WORK = process.env.FATHOM_DRIVE_DIR ?? join(process.env.TMPDIR ?? '/tmp', 'fathom-drive-orders');
mkdirSync(SHOTS, { recursive: true });
mkdirSync(WORK, { recursive: true });

const PORT = 18197;
const URL_ = `http://127.0.0.1:${PORT}`;
const DB_NAME = 'fathom_test';
const MIGRATE_URL = migrateUrl(DB_NAME);
const RUNTIME_URL = runtimeUrl(DB_NAME);
const MASTER_KEY = join(WORK, 'master.key');
const CHAIN_KEY = join(WORK, 'chain.key');
const SEED_OUT = join(WORK, 'seed.json');
const SEED_SRC = join(ROOT, 'scripts/drive-lib/seed_orders.rs');
const SEED_DST = join(ROOT, 'crates/fathom-server/tests/seed_orders.rs');
const CLASH_SRC = join(ROOT, 'scripts/drive-lib/clash_design.test.ts');
const CLASH_DST = join(ROOT, 'client/src/drive-clash-design.test.ts');
const CLASH_OUT = join(WORK, 'clash-design.tsv');
const SETUP_PASSWORD = 'amber-kestrel-harbour-0057';
const OPERATOR = 'operator@fathom.invalid';
const STEWARD_ADDRESS = 'ann.alder@northwind.example';
const STEWARD_PASSWORD = 'people-steward-passphrase-kept-for-this-proof-only';

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

function resetSchema() {
  sh('psql', [MIGRATE_URL, '-qc', 'DROP SCHEMA IF EXISTS vault CASCADE; DROP SCHEMA public CASCADE; CREATE SCHEMA public;']);
}

let serverProc = null;
let serverLog = '';

async function signIn(page, address, password) {
  await page.goto(URL_, { waitUntil: 'domcontentloaded' });
  await page.locator('#signin-address').fill(address);
  await page.locator('#signin-password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.locator('.home, .drawing, .shell-bar').first().waitFor({ timeout: 20000 });
}

async function main() {
  console.log('==> resetting the fathom_test schema');
  resetSchema();
  rmSync(MASTER_KEY, { force: true });
  rmSync(CHAIN_KEY, { force: true });

  const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
  try {
    // Ann's browser makes her key before the server exists: the page is a blank
    // stand-in on the server's own origin, so the key lands in the storage the
    // real page will read.
    const ctxA = await browser.newContext({ viewport: VIEWPORT });
    const pubkey = await makeBrowserKey(ctxA, STEWARD_ADDRESS);

    console.log('==> the clash design, built by the client\'s own commands');
    copyFileSync(CLASH_SRC, CLASH_DST);
    try {
      sh('npx', ['vitest', 'run', 'src/drive-clash-design.test.ts'], { cwd: join(ROOT, 'client'), env: { ...process.env, CLASH_OUT }, stdio: 'inherit' });
    } finally {
      rmSync(CLASH_DST, { force: true });
    }

    console.log('==> seeding: steward Ann, with the key her browser made');
    copyFileSync(SEED_SRC, SEED_DST);
    writeFileSync(SEED_DST, readFileSync(SEED_DST, 'utf8').replace('@@STEWARD_PW@@', STEWARD_PASSWORD));
    const seedEnv = { ...process.env };
    delete seedEnv.DATABASE_URL;
    seedEnv.FATHOM_MIGRATE_DATABASE_URL = MIGRATE_URL;
    seedEnv.FATHOM_MASTER_KEY = `file://${MASTER_KEY}`;
    seedEnv.FATHOM_CHAIN_KEY = `file://${CHAIN_KEY}`;
    seedEnv.SEED_OUTPUT = SEED_OUT;
    seedEnv.SEED_STEWARD_ADDRESS = STEWARD_ADDRESS;
    seedEnv.SEED_STEWARD_PUBKEY = pubkey;
    seedEnv.CLASH_DESIGN = CLASH_OUT;
    sh('cargo', ['test', '-p', 'fathom-server', '--locked', '--test', 'seed_orders', '--', '--nocapture'], {
      cwd: ROOT,
      env: seedEnv,
      stdio: 'inherit',
    });
    const seed = JSON.parse(readFileSync(SEED_OUT, 'utf8'));
    await startServer();
    await runProof(browser, ctxA, seed);
  } finally {
    await browser.close();
  }
}

/** A non-extractable P-256 key in the client's own key store, under `address`;
 * returns its public half as hex. */
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

}

const VIEWPORT = { width: 1440, height: 900 };

async function runProof(browser, ctxA, seed) {
  const A = await ctxA.newPage();
  A.on('pageerror', (e) => console.log(`[A pageerror] ${e}`));
  A.on('console', (m) => { if (m.type() === 'error') console.log(`[A console.error] ${m.text()}`); });
  const shot = (name, page = A) => page.screenshot({ path: `${SHOTS}${name}.png`, fullPage: true });

  await signIn(A, seed.steward, STEWARD_PASSWORD);
  // With one design, sign-in lands in it; the brand goes Home.
  await A.getByText('Untitled design').first().waitFor({ timeout: 30000 });
  await A.getByRole('button', { name: 'Northwind Networks' }).first().click();
  await A.getByRole('tab', { name: 'Steward' }).waitFor({ timeout: 15000 });

  // ---- Steward › Order types ------------------------------------------------------
  await A.getByRole('tab', { name: 'Steward' }).click();
  await A.getByTestId('rail-order-types').click();
  await A.getByTestId('order-types-list').waitFor({ timeout: 15000 });
  const railText = await A.getByTestId('rail-order-types').innerText();
  check('O1. the rail lists Order types without the Not finished mark', !/not finished/i.test(railText), railText);
  check('O1. the list shows the three saved types', (await A.locator('[data-testid=order-types-list] tbody tr').count()) === 3);
  check('O1. three starters and a blank one are offered', (await A.locator('.order-types__starter').count()) === 5);
  await shot('o1-order-types');

  await A.getByRole('button', { name: 'Dedicated Internet Access' }).first().click();
  await A.getByTestId('order-board').waitFor({ timeout: 15000 });
  await A.getByText('Checks out').waitFor({ timeout: 15000 });
  check('O2. the board draws DIA’s four stages', (await A.locator('.order-board__stage').count()) === 4);
  check('O2. every slug is matched to a team', (await A.locator('.order-type__unmatched').count()) === 0);
  await shot('o2-board');

  await A.getByRole('tab', { name: /^File/ }).click();
  const area = A.locator('.order-file__text');
  const text = await area.inputValue();
  await area.fill(text.replace('kind: choice', 'kind: chioce'));
  await A.getByTestId('order-file-problems').waitFor({ timeout: 15000 });
  const problems = await A.getByTestId('order-file-problems').innerText();
  check('O3. a typo comes back as a problem on its line', /Line \d+/.test(problems) && /chioce/.test(problems), problems);
  check('O3. Save is off while the file has a problem', await A.getByTestId('order-type-save').isDisabled());
  await shot('o3-file-problem');
  await area.fill(text);
  await A.getByText('Checks out').waitFor({ timeout: 15000 });
  await A.getByRole('tab', { name: /^Asks for/ }).click();
  await A.getByTestId('order-type-fields').waitFor();
  await shot('o4-fields');

  // A new type from a starter: its teams are matched, and saving makes version 1.
  await A.getByTestId('order-type-editor').getByRole('button', { name: 'Order types' }).click();
  await A.getByTestId('starter-service-removal').click();
  await A.getByText('Checks out').waitFor({ timeout: 15000 });
  await A.getByTestId('order-type-save').click();
  await A.getByText(/Saved as version 1/).waitFor({ timeout: 15000 });
  check('O5. a starter saves as version 1', true);
  await A.getByTestId('order-type-editor').getByRole('button', { name: 'Order types' }).click();
  await A.locator('[data-testid=order-types-list] tbody tr').nth(3).waitFor({ timeout: 15000 }).catch(() => undefined);
  check('O5. the list now has four types', (await A.locator('[data-testid=order-types-list] tbody tr').count()) === 4);
  await shot('o5-order-types-after');

  // ---- r142: building a type by dragging the board -----------------------------------
  await A.getByTestId('starter-dia').click();
  await A.getByText('Checks out').waitFor({ timeout: 15000 });
  const stageJobs = async (stage) => A.getByTestId(`board-stage-${stage}`).locator('.order-board__job-name').allInnerTexts();
  // A drag the check refuses: the port job after the hand-off would leave Configure waiting on a later stage.
  await A.getByTestId('board-job-port').dragTo(A.getByTestId('board-job-handoff'), { targetPosition: { x: 40, y: 50 } });
  await A.getByTestId('order-type-status').getByText(/problem/).waitFor({ timeout: 15000 }).catch(() => undefined);
  const loop = await A.getByTestId('order-type-status').innerText();
  check('D0. a drag that makes a loop is caught by the check, and the board keeps the last good drawing', /problem/.test(loop) && (await A.getByText('The file has problems now').count()) === 1, loop);
  await shot('d0-drag-makes-loop');
  await A.getByTestId('board-undo').click();
  await A.getByTestId('order-type-status').getByText('Checks out').waitFor({ timeout: 15000 });
  check('D0. Undo the last change puts the file back', true);
  await A.getByTestId('board-job-addresses').dragTo(A.getByTestId('board-job-check'), { targetPosition: { x: 40, y: 50 } });
  await A.waitForFunction(() => document.querySelector('[data-testid=board-stage-order]')?.textContent?.includes('Reserve the WAN block'), null, { timeout: 15000 }).catch(() => undefined);
  await A.getByTestId('order-type-status').getByText('Checks out').waitFor({ timeout: 15000 }).catch(() => undefined);
  check('D1. a job dragged into Order Management lands there and the file still checks out', (await stageJobs('order')).includes('Reserve the WAN block') && /Checks out/.test(await A.getByTestId('order-type-status').innerText()), JSON.stringify(await stageJobs('order')));
  await A.getByTestId('board-add-job-provision').click();
  await A.waitForFunction(() => document.querySelector('[data-testid=board-stage-provision]')?.textContent?.includes('New job'), null, { timeout: 15000 }).catch(() => undefined);
  check('D2. + Job adds a job to the stage', (await stageJobs('provision')).includes('New job'));
  await A.getByTestId('board-stage-head-install').dragTo(A.getByTestId('board-stage-head-provision'), { targetPosition: { x: 5, y: 5 } });
  await A.waitForFunction(() => [...document.querySelectorAll('.order-board__stage-head')].map((h) => h.textContent).join('|').includes('3 · Installation'), null, { timeout: 15000 }).catch(() => undefined);
  const heads = await A.locator('.order-board__stage-head').allInnerTexts();
  check('D3. a stage dragged before Provisioning moves with its jobs', heads.some((h) => /3 · Installation/i.test(h)), JSON.stringify(heads));
  await shot('d1-board-dragged');
  await A.getByTestId('board-job-handoff').dragTo(A.getByTestId('board-job-configure'));
  await A.getByTestId('board-note').waitFor({ timeout: 5000 }).catch(() => undefined);
  check('D4. moving the only job out of a stage is refused, saying why', /only job in Installation/.test(await A.getByTestId('board-note').innerText().catch(() => '')));
  await shot('d2-board-refused');
  await A.getByRole('tab', { name: /^File/ }).click();
  const moved = await A.locator('.order-file__text').inputValue();
  check('D5. the file was rewritten to match, its comment kept', /- id: install[\s\S]*- id: provision/.test(moved) && moved.includes('# the port stays held for this order until it closes') && moved.includes('{ id: job-1, name: New job, team: provisioning }'));
  await shot('d3-file-rewritten');
  await A.getByTestId('order-type-editor').getByRole('button', { name: 'Order types' }).click();

  // ---- The Work tab -----------------------------------------------------------------
  await A.getByRole('tab', { name: 'Work' }).last().click();
  await A.getByTestId('orders-section').waitFor({ timeout: 15000 });
  await A.locator('[data-testid=order-row]').nth(2).waitFor({ timeout: 15000 });
  await A.waitForTimeout(1500);
  const rows = await A.getByTestId('orders-section').innerText();
  check('W1. the Work tab lists the three open orders with where each is', /Design/.test(rows) && /W-\d+ · DIA/.test(rows), rows.slice(0, 300));
  check('W1. it says which one has a job for Ann', /Pick the edge port/.test(rows));
  await shot('w1-work-orders');

  await A.getByRole('button', { name: /Riverside Council/ }).click();
  await A.getByTestId('order-page').waitFor({ timeout: 15000 });
  await A.getByTestId('job-port').waitFor();
  await shot('w2-order-for-you');
  const port = A.getByTestId('job-port');
  await port.getByRole('button', { name: 'Pick it up' }).click();
  await port.getByText(/picked up by Ann Alder/).waitFor({ timeout: 15000 });
  await port.getByRole('checkbox').first().click();
  await port.getByText(/picked up by Ann Alder · 1 of 1 steps/).waitFor({ timeout: 15000 });
  await shot('w3-picked-and-ticked');
  await port.getByRole('button', { name: 'Done' }).click();
  await port.getByText(/^Done by Ann Alder/).waitFor({ timeout: 15000 });
  check('W2. Ann picks up, ticks and finishes her team’s job', true);
  await A.getByRole('button', { name: /All work/ }).click();

  await A.getByRole('button', { name: /Harbour Clinic/ }).click();
  await A.getByTestId('signoff-design').waitFor({ timeout: 15000 });
  await shot('w4-waiting-for-signoff');
  await A.getByRole('button', { name: 'Sign off Design' }).click();
  await A.getByTestId('signoff-design').waitFor({ state: 'detached', timeout: 15000 });
  await A.getByText(/Signed off by Ann Alder/).waitFor({ timeout: 15000 });
  check('W3. Ann signs Design off; Provisioning starts', /Configure the edge router/.test(await A.getByTestId('order-page').innerText()));
  await A.getByRole('button', { name: 'Show the history' , exact: false }).click();
  await shot('w5-signed-off-history');
  await A.getByRole('button', { name: /All work/ }).click();

  await A.getByRole('button', { name: /Riverside depot build/ }).click();
  await A.getByTestId('order-track').waitFor({ timeout: 15000 });
  await shot('w6-two-lanes');
  await A.getByRole('button', { name: /All work/ }).click();

  await A.getByTestId('orders-open').click();
  await A.getByLabel('Order type').selectOption({ label: 'Dedicated Internet Access (DIA)' });
  await A.locator('#open-customer').waitFor({ timeout: 15000 });
  await A.locator('#open-customer').fill('Quayside Library');
  await A.locator('#open-contact_name').fill('Ola Berg');
  await A.locator('#open-site').fill('Quayside');
  await A.locator('#open-bandwidth').selectOption('1G');
  await shot('w7-open-form');
  await A.getByTestId('order-open-submit').click();
  await A.getByTestId('order-page').waitFor({ timeout: 15000 });
  check('W4. opening an order lands on its page with a W- number', /W-\d+ · DIA/.test(await A.getByTestId('order-page').innerText()));
  await shot('w8-opened');
  await A.getByRole('button', { name: /All work/ }).click();

  // ---- r142: the overdue clock ---------------------------------------------------------
  await A.getByRole('button', { name: /Quay Street Dental/ }).click();
  await A.getByTestId('order-page').waitFor({ timeout: 15000 });
  await A.getByTestId('job-cause').waitFor({ timeout: 15000 });
  if ((await A.getByTestId('overdue-cause').count()) === 0) await A.getByTestId('job-cause').locator('.order-job__head').click();
  await A.getByTestId('overdue-cause').waitFor({ timeout: 15000 });
  const late = await A.getByTestId('job-cause').innerText();
  check('C1. the clock showed the late job to the lead and handed it to IP design', /shown to the lead/i.test(late) && /handed on from/i.test(late) && /IP design/.test(late), late);
  check('C1. both rules are ticked as done by Fathom', ((await A.getByTestId('overdue-cause').innerText()).match(/done by Fathom/g) ?? []).length === 2, await A.getByTestId('overdue-cause').innerText());
  await A.getByRole('button', { name: 'Show the history', exact: false }).click().catch(() => undefined);
  await shot('c1-overdue-carried-out');
  await A.getByRole('button', { name: /All work/ }).click();

  // ---- r142: a held port in the work-clash check -----------------------------------------
  await A.getByRole('tab', { name: 'Designs' }).click();
  await A.getByText(/Harbour/).first().click().catch(() => undefined);
  await A.locator('.drawing').waitFor({ timeout: 20000 }).catch(() => undefined);
  const designUrl = A.url();
  await A.getByRole('tab', { name: 'Diagram' }).first().click().catch(() => undefined);
  await A.waitForTimeout(3000);
  await A.getByText('edge-rt1', { exact: true }).first().click({ timeout: 15000 });
  await A.waitForTimeout(1500);
  await A.getByRole('button', { name: /^Details$/i }).first().click().catch(() => A.getByText('Details', { exact: true }).first().click());
  await A.waitForTimeout(1500);
  await A.getByRole('button', { name: /Move the uplinks on edge-rt1/ }).first().click({ timeout: 15000 });
  await A.getByTestId('plans-clashes').waitFor({ timeout: 20000 });
  const clashText = await A.getByTestId('plans-clashes').innerText();
  check('H1. the plan lists Harbour Clinic\'s order as other work on the same port', /Order W-\d+ · DIA Dedicated Internet Access: Pick the edge port/.test(clashText) && /same port edge-rt1 Et49/.test(clashText), `${designUrl} | ${clashText}`);
  check('H1. an order offers no note: it is not in the design', (await A.getByTestId('plans-clash-offer').count()) === 0);
  await shot('h1-held-port-clash');

  // ---- Dark and phone ---------------------------------------------------------------
  const storage = await ctxA.storageState();
  for (const [name, opts] of [
    ['dark', { viewport: VIEWPORT, colorScheme: 'dark' }],
    ['phone', { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true }],
  ]) {
    const ctx = await browser.newContext({ ...opts, storageState: storage });
    const P = await ctx.newPage();
    P.on('pageerror', (e) => console.log(`[${name} pageerror] ${e}`));
    await signIn(P, seed.steward, STEWARD_PASSWORD).catch(() => undefined);
    await P.getByRole('button', { name: 'Northwind Networks' }).first().click({ timeout: 20000 }).catch(() => undefined);
    await P.getByRole('tab', { name: 'Work' }).last().click().catch(async () => {
      await P.locator('select').first().selectOption({ label: 'Work' }).catch(() => undefined);
    });
    await P.getByTestId('orders-section').waitFor({ timeout: 15000 }).catch(() => undefined);
    await P.waitForTimeout(1500);
    await shot(`${name}-work-orders`, P);
    const riverside = P.getByRole('button', { name: /Riverside Council/ });
    if (await riverside.count()) {
      await riverside.click();
      await P.getByTestId('order-page').waitFor({ timeout: 15000 });
      await shot(`${name}-order`, P);
    }
    if (name === 'dark') {
      await P.getByRole('tab', { name: 'Steward' }).click();
      await P.getByTestId('rail-order-types').click();
      await P.getByRole('button', { name: 'New site build' }).first().click();
      await P.getByTestId('order-board').waitFor({ timeout: 15000 });
      await shot('dark-board-two-lanes', P);
    }
    await ctx.close();
  }
}

async function cleanup() {
  console.log('==> cleaning up');
  if (serverProc) { try { serverProc.kill('SIGTERM'); } catch {} }
  try { sh('fuser', ['-k', `${PORT}/tcp`]); } catch {}
  rmSync(SEED_DST, { force: true });
  rmSync(CLASH_DST, { force: true });
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
