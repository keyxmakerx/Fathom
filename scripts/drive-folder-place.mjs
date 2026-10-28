// Drives the REAL built client against the REAL server through ADR-0074: a
// steward makes a site with its kind of place and Hub role, a building under it, then sets
// the building's kind and role from the folder row; a reload keeps all of it. Then a design
// in a closet, and the camera goes up from it to the building, the site and every site.
// Screenshots for the PR.
//
//   node scripts/drive-folder-place.mjs
//
// Needs what drive-people.mjs needs: PostgreSQL on 127.0.0.1 with the `fathom_test` and
// `fathom_app` roles, a built client (`cd client && npm run build`), the fathom-server
// binary (`cargo build -p fathom-server --locked`) and Playwright's Chromium. The seed is
// drive-lib/seed_people.rs (Ann the steward), copied under crates/fathom-server/tests for
// the run and deleted.
//
// Screenshots: FATHOM_SHOTS (default /mnt/project-files/reviews/folder-place/).
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
const SHOTS = (process.env.FATHOM_SHOTS ?? '/mnt/project-files/reviews/folder-place') + '/';
const WORK = process.env.FATHOM_DRIVE_DIR ?? join(process.env.TMPDIR ?? '/tmp', 'fathom-drive-folder-place');
mkdirSync(SHOTS, { recursive: true });
mkdirSync(WORK, { recursive: true });

const PORT = 18194;
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
    sh('cargo', ['test', '-p', 'fathom-server', '--locked', '--test', 'seed_people', '--', '--nocapture'], {
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
  const errors = [];
  A.on('pageerror', (e) => errors.push(String(e)));
  const shot = (name) => A.screenshot({ path: `${SHOTS}${name}.png` });

  await signIn(A, seed.steward, STEWARD_PASSWORD);
  await A.getByRole('tab', { name: 'Steward' }).click();
  await A.locator('.org-rail__item', { hasText: 'Folders' }).click();

  // A site, made with its kind of place and role in one go.
  await A.getByRole('button', { name: 'New site' }).first().click();
  await A.locator('#home-new-scope-label').fill('Northgate');
  await A.locator('#home-new-scope-form').selectOption({ label: 'Central office' });
  await A.locator('#home-new-scope-role').selectOption({ label: 'Hub' });
  await shot('f1-new-site-form');
  await A.getByRole('button', { name: 'Create', exact: true }).click();
  const siteRow = A.locator('.home-folders__row', { hasText: 'Northgate' });
  await siteRow.waitFor({ timeout: 10000 });
  check('F1. the new site shows its kind and a Hub mark', (await siteRow.innerText()).includes('Central office') && (await siteRow.locator('.home-folders__role--hub').count()) === 1);

  // A building under it, made bare, then given its kind and role from its row.
  await siteRow.getByRole('button', { name: 'New building' }).click();
  await A.locator('#home-new-scope-label').fill('Block A');
  await A.getByRole('button', { name: 'Create', exact: true }).click();
  const buildingRow = A.locator('.home-folders__row', { hasText: 'Block A' });
  await buildingRow.waitFor({ timeout: 10000 });
  await buildingRow.getByRole('button', { name: 'Kind and role' }).click();
  await buildingRow.locator('select').nth(0).selectOption({ label: 'Datacenter' });
  await buildingRow.locator('select').nth(1).selectOption({ label: 'Branch' });
  await shot('f2-building-place-editor');
  await buildingRow.getByRole('button', { name: 'Save' }).click();
  await buildingRow.locator('.home-folders__role').waitFor({ timeout: 10000 });
  check('F2. the building row now says Datacenter and Branch', /Datacenter/.test(await buildingRow.innerText()) && /Branch/i.test(await buildingRow.innerText()));

  // A closet takes a kind of room and offers no role.
  await buildingRow.getByRole('button', { name: 'New closet' }).click();
  await A.locator('#home-new-scope-label').fill('IDF-2');
  check('F3. a new closet asks for a kind of room and no role', (await A.locator('#home-new-scope-role').count()) === 0 && (await A.locator('#home-new-scope-form option', { hasText: 'UPS room' }).count()) === 1);
  await A.locator('#home-new-scope-form').selectOption({ label: 'UPS room' });
  await A.getByRole('button', { name: 'Create', exact: true }).click();
  await A.locator('.home-folders__row', { hasText: 'IDF-2' }).waitFor({ timeout: 10000 });
  await shot('f3-folders');

  // A reload reads every word back from the server.
  await A.reload({ waitUntil: 'domcontentloaded' });
  await A.locator('.home, .drawing, .shell-bar').first().waitFor({ timeout: 20000 });
  await A.getByRole('tab', { name: 'Steward' }).click();
  await A.locator('.org-rail__item', { hasText: 'Folders' }).click();
  await A.locator('.home-folders__row', { hasText: 'IDF-2' }).waitFor({ timeout: 10000 });
  const all = (await A.locator('.home-folders').innerText()).replace(/\s+/g, ' ');
  check('F4. after a reload the kinds and roles are still there', /Central office/.test(all) && /Datacenter/.test(all) && /Branch/i.test(all) && /UPS room/.test(all) && (await A.locator('.home-folders__role--hub').count()) === 1, all);
  await shot('f4-after-reload');

  // ---- ADR-0074, the stops above the closet --------------------------------------
  // A design in IDF-2, then the camera goes up from its closet.
  await A.getByRole('tab', { name: 'Designs' }).click();
  const startRow = A.locator('.home__scope-heading', { hasText: 'IDF-2' }).first();
  await startRow.getByRole('button', { name: 'New design' }).click();
  await A.locator('.shell__drawing').waitFor({ timeout: 20000 });
  await A.getByTestId('shell-pill').waitFor({ timeout: 20000 });
  await A.locator('.shell-pill__value').click();
  // The folders arrive with the design's other data; the upper stops join the list when they do.
  await A.locator('.shell-pill__stop', { hasText: 'Every site' }).waitFor({ timeout: 10000 });
  const stopLabels = (await A.locator('.shell-pill__stop').allInnerTexts()).map((t) => t.trim().toLowerCase());
  check('Z1. the zoom stops start at Every site, Site and Building, then the closet', stopLabels.slice(0, 4).join('|') === 'every site|site|building|closet', stopLabels.join('|'));
  await A.locator('.shell-pill__stop', { hasText: 'Building' }).click();
  const map = A.getByTestId('places-map');
  await map.waitFor({ timeout: 10000 });
  const buildingText = (await map.innerText()).replace(/\s+/g, ' ');
  check('Z2. the building stop shows its closet, marked as where you are, with its design', /IDF-2/.test(buildingText) && /You are here/i.test(buildingText) && /1 design/.test(buildingText), buildingText);
  await shot('z1-building-stop');

  // ---- ADR-0051 / ADR-0074 decision 4: the building's floor plan ------------------
  const planBox = map.getByTestId('building-plan');
  await planBox.waitFor({ timeout: 10000 });
  check('R1. the building stop has a floor plan area offering a picture and a room', /No floor plan yet/.test(await planBox.innerText()) && (await planBox.getByRole('button', { name: 'Draw a room' }).count()) === 1);
  // A picture of a plan: any PNG will do, so a screenshot of the page stands in for a scan.
  const picture = await A.screenshot({ clip: { x: 0, y: 0, width: 800, height: 500 } });
  await planBox.getByTestId('building-plan-picture').setInputFiles({ name: 'block-a-ground.png', mimeType: 'image/png', buffer: picture });
  await planBox.getByText(/Click two points on the picture/).waitFor({ timeout: 30000 });
  const floor = planBox.locator('svg.building-plan__floor');
  const fb = await floor.boundingBox();
  // The picture fills the floor's width; two points 60% of it apart are said to be 20 m.
  await A.mouse.click(fb.x + fb.width * 0.2, fb.y + fb.height * 0.5);
  await A.mouse.click(fb.x + fb.width * 0.8, fb.y + fb.height * 0.5);
  await planBox.getByTestId('building-plan-distance').fill('20 m');
  await planBox.getByRole('button', { name: 'Save the scale' }).click();
  await planBox.getByRole('button', { name: 'Draw a room' }).waitFor({ timeout: 20000 });
  check('R2. the picture went in beneath the plan and is scaled', (await floor.locator('image.building-plan__picture').count()) === 1 && (await planBox.getByRole('button', { name: 'Draw a room' }).isEnabled()));
  await shot('r1-plan-picture');

  // A room traced corner by corner, closed on its first corner, and named as the closet.
  await planBox.getByRole('button', { name: 'Draw a room' }).click();
  const corner = (fx, fy) => A.mouse.click(fb.x + fb.width * fx, fb.y + fb.height * fy);
  await corner(0.3, 0.3);
  await corner(0.55, 0.31); // a little off square: snapped
  await corner(0.55, 0.6);
  await corner(0.3, 0.6);
  await corner(0.3, 0.3);
  await planBox.getByTestId('building-plan-room-name').fill('IDF-2');
  await planBox.getByRole('button', { name: 'Save the room' }).click();
  const panel = planBox.getByTestId('building-plan-panel');
  await panel.waitFor({ timeout: 20000 });
  const panelText = await panel.innerText();
  check('R3. the room is saved, square, and opens the closet of the same name', (await floor.getByTestId('building-plan-room').count()) === 1 && /4 corners/.test(panelText) && /Open the closet IDF-2/.test(panelText), panelText);
  await shot('r2-room-traced');

  // Away and back: the plan is read again from the server.
  await map.locator('.places-map__crumb', { hasText: 'Northgate' }).click();
  await A.locator('[data-stop="site"]').waitFor({ timeout: 5000 });
  await map.locator('.places-box', { hasText: 'Block A' }).click();
  await A.locator('[data-stop="building"]').waitFor({ timeout: 5000 });
  await planBox.getByTestId('building-plan-room').first().waitFor({ timeout: 20000 });
  await floor.locator('image.building-plan__picture').waitFor({ state: 'attached', timeout: 20000 }).catch(() => undefined);
  await shot('r3-plan-reopened');
  check('R4. reopened, the building keeps its room and its picture', /IDF-2/.test(await floor.textContent()) && (await floor.locator('image.building-plan__picture').count()) === 1);

  await map.locator('.places-map__crumb', { hasText: 'Northgate' }).click();
  await A.locator('[data-stop="site"]').waitFor({ timeout: 5000 });
  const siteText = (await map.innerText()).replace(/\s+/g, ' ');
  check('Z3. the site stop shows Block A with its closet and kind, and the site is a hub', /Block A/.test(siteText) && /1 closet/.test(siteText) && /Datacenter/.test(siteText) && (await map.locator('.places-map__role--hub').count()) === 1, siteText);
  await shot('z2-site-stop');

  // Zooming out goes up one more stop.
  await A.getByRole('button', { name: 'Zoom out' }).click();
  await A.locator('[data-stop="estate"]').waitFor({ timeout: 5000 });
  check('Z4. zooming out from the site reaches every site, the hub drawn with a double border', (await map.locator('.places-box--hub').count()) === 1);
  await shot('z3-estate-stop');

  // Going in: a site box opens its site, a building its building, the closet you are in goes back down.
  await map.locator('.places-box', { hasText: 'Northgate' }).click();
  await map.locator('.places-box', { hasText: 'Block A' }).click();
  await A.locator('[data-stop="building"]').waitFor({ timeout: 5000 });
  await map.locator('.places-box', { hasText: 'IDF-2' }).click();
  check('Z5. the closet you are in takes you back down to the canvas', (await A.getByTestId('places-map').count()) === 0);

  // ---- ADR-0074 "How": an existing design moved into another folder -------------
  // Still in the design: its organisation, first in the path, goes Home.
  await A.locator('.shell-bar__path-label--link[title="Home"]').first().click();
  await A.locator('.home').waitFor({ timeout: 20000 });
  await A.getByRole('tab', { name: 'Designs' }).click();
  const idfGroup = A.locator('.home__scope-group', { has: A.locator('.home__scope-name', { hasText: 'IDF-2' }) });
  const row = idfGroup.locator('.home__design-row').first();
  await row.getByRole('button', { name: 'Move' }).click();
  await row.locator('select').selectOption({ label: 'Block A (Building)' });
  await shot('m1-move-design');
  await row.locator('.home__design-move').getByRole('button', { name: 'Move' }).click();
  const blockGroup = A.locator('.home__scope-group', { has: A.locator('.home__scope-name', { hasText: 'Block A' }) });
  await blockGroup.locator('.home__design-row').nth(1).waitFor({ timeout: 10000 });
  check('M1. a steward moves the design from its closet into the building (beside its floor plan)', (await blockGroup.locator('.home__design-row').count()) === 2 && (await idfGroup.locator('.home__design-row').count()) === 0);
  await shot('m2-moved');

  // ---- ADR-0074 §8: a NetBox rack export becomes sites, buildings and rack designs ----
  await A.getByRole('tab', { name: 'Steward' }).click();
  await A.locator('.org-rail__item', { hasText: 'Folders' }).click();
  await A.getByRole('button', { name: 'Import from NetBox' }).click();
  const csv = ['name,site,location,status,u_height', 'A01,LON1,Hall 1,active,48', 'A02,LON1,Hall 1,active,42', 'B01,Northgate,Block A,active,42'].join('\n');
  await A.getByTestId('estate-import-file').setInputFiles({ name: 'netbox-racks.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
  const importer = A.getByTestId('estate-import');
  const make = importer.getByRole('button', { name: /^Make / });
  await make.waitFor({ timeout: 30000 });
  const planText = await importer.innerText();
  check('N1. the plan matches Northgate and Block A, skips Block A (it has a design) and offers LON1 new', /LON1[\s\S]*new/i.test(planText) && /Block A[\s\S]*already there/i.test(planText) && /skipped/i.test(planText) && /Make 1 site, 1 building and 1 design/i.test(await make.innerText()), planText);
  await shot('n1-netbox-plan');
  await make.click();
  await importer.locator('.estate-import__done').waitFor({ timeout: 30000 });
  await A.reload();
  await A.getByRole('tab', { name: 'Designs' }).click();
  const hallGroup = A.locator('.home__scope-group', { has: A.locator('.home__scope-name', { hasText: 'Hall 1' }) });
  await hallGroup.locator('.home__design-row').first().waitFor({ timeout: 10000 });
  check('N2. after a reload Hall 1 holds the new "Hall 1 racks" design', /Hall 1 racks/.test(await hallGroup.innerText()));
  await shot('n2-imported');
  check('F5. no page errors', errors.length === 0, errors.join(' | '));
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
