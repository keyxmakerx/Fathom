// Drives the REAL built client against the REAL server through Steward › IP plan (ADR-0083
// decision 7; sign-off alpha v2, 2026-11-14): a steward adds an aggregate, a site block in a
// folder, a LAN with an address and a DHCP range; asks the site block for its next free /24 and
// reserves it under a key, asks again with the same key and gets the same block back; a VRF that
// refuses the same network twice refuses it, with the store's sentence on screen; a VLAN group and
// an ASN range hand out their next free; a reservation is released; the NetBox files download in
// NetBox's columns; a reload reads it all back. Screenshots for the sign-off card, light, dark and
// phone width.
//
//   node scripts/drive-ip-plan.mjs
//
// Needs what drive-folder-place.mjs needs: PostgreSQL on 127.0.0.1 with the `fathom_test` and
// `fathom_app` roles, a built client (`cd client && npm run build`), the fathom-server binary
// (`cargo build -p fathom-server --locked`) and Playwright's Chromium. The seed is
// drive-lib/seed_people.rs (Ann the steward), copied under crates/fathom-server/tests for the run
// and deleted.
//
// Screenshots: FATHOM_SHOTS (default /mnt/project-files/briefs/ip-plan/).
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
const SHOTS = (process.env.FATHOM_SHOTS ?? '/mnt/project-files/briefs/ip-plan') + '/';
const WORK = process.env.FATHOM_DRIVE_DIR ?? join(process.env.TMPDIR ?? '/tmp', 'fathom-drive-ip-plan');
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
  const shot = (name, page = A) => page.screenshot({ path: `${SHOTS}${name}.png` });
  const plan = () => A.getByTestId('ip-plan');
  const panel = () => A.getByTestId('ip-plan-panel');
  const form = () => A.getByTestId('ip-plan-form');
  const field = (label) => form().getByLabel(label, { exact: false }).first();
  const pickFolder = async (sel, name) => {
    const label = (await form().locator(`${sel} option`, { hasText: name }).first().textContent()).trim();
    await form().locator(sel).selectOption({ label });
  };

  await signIn(A, seed.steward, STEWARD_PASSWORD);
  await A.getByRole('tab', { name: 'Steward' }).click();

  // A folder to put the site's block in.
  await A.locator('.org-rail__item', { hasText: 'Folders' }).click();
  await A.getByRole('button', { name: 'New site' }).first().click();
  await A.locator('#home-new-scope-label').fill('Northgate');
  await A.getByRole('button', { name: 'Create', exact: true }).click();
  await A.locator('.home-folders__row', { hasText: 'Northgate' }).waitFor({ timeout: 10000 });

  const rail = A.locator('.org-rail__item', { hasText: 'IP plan' });
  check('P0. IP plan is in the Steward rail without the Not finished mark', (await rail.count()) === 1 && (await rail.getByTestId('not-finished').count()) === 0, await rail.innerText());
  await rail.click();
  await plan().waitFor({ timeout: 10000 });
  await A.getByTestId('ip-plan-empty').waitFor({ timeout: 10000 });
  check('P1. an empty plan says where to start', /Start with an aggregate/.test(await plan().innerText()));
  await shot('ip1-empty');

  // The aggregate.
  await A.getByRole('button', { name: 'Add aggregate' }).click();
  await field('Prefix').fill('10.0.0.0/8');
  await field('Where it came from').fill('RFC 1918');
  await A.getByTestId('ip-plan-save').click();
  await panel().waitFor({ timeout: 10000 });
  check('P2. the aggregate is saved and opens in the panel, with its usable count', /Aggregate added/.test(await panel().innerText()) && /16777216 addresses/.test(await panel().innerText()), await panel().innerText());

  // A site block in Northgate.
  await A.getByRole('button', { name: 'Add prefix' }).click();
  await field('Prefix').fill('10.20.0.0/16');
  await form().locator('#ipplan-prefix-status').selectOption('container');
  await pickFolder('#ipplan-prefix-folder', 'Northgate');
  await field('Role').fill('Site');
  await A.getByTestId('ip-plan-save').click();
  await panel().getByText('Prefix added').waitFor({ timeout: 10000 });

  // A LAN, an address in it and a DHCP range.
  await A.getByRole('button', { name: 'Add prefix' }).click();
  await field('Prefix').fill('10.20.1.0/24');
  await field('Role').fill('Staff');
  await field('VLAN ID').fill('120');
  await pickFolder('#ipplan-prefix-folder', 'Northgate');
  await A.getByTestId('ip-plan-save').click();
  await panel().getByText('Prefix added').waitFor({ timeout: 10000 });
  await panel().getByRole('button', { name: 'Add an address in it' }).click();
  check('P3. an address added from a prefix starts with its length', (await field('Address with its length').inputValue()) === '/24');
  await field('Address with its length').fill('10.20.1.1/24');
  await form().locator('#ipplan-address-role').selectOption('vrrp');
  await field('Meant for').fill('core-sw1 vlan120');
  await field('DNS name').fill('gw.northgate.example.net');
  await A.getByTestId('ip-plan-save').click();
  await panel().getByText('Address added').waitFor({ timeout: 10000 });
  await A.getByRole('button', { name: 'Add range' }).click();
  await field('Range').fill('10.20.1.100-10.20.1.199');
  await field('Role').fill('DHCP');
  await form().getByLabel('Populated', { exact: false }).check();
  await A.getByTestId('ip-plan-save').click();
  await panel().getByText('Range added').waitFor({ timeout: 10000 });

  // Next free /24 in the site block, reserved under a key.
  const tree = A.getByTestId('ip-plan-tree');
  await tree.getByRole('button', { name: /^10\.20\.0\.0\/16/ }).click();
  await panel().getByTestId('ip-plan-length').selectOption('24');
  await panel().getByTestId('ip-plan-look').click();
  await panel().getByTestId('ip-plan-found').waitFor({ timeout: 10000 });
  const found = (await panel().getByTestId('ip-plan-found').innerText()).trim();
  check('N1. next free /24 in 10.20.0.0/16 skips the LAN and offers 10.20.0.0/24', /10\.20\.0\.0\/24/.test(found), found);
  await panel().getByTestId('ip-plan-key').fill('W-1042/lan');
  await panel().getByTestId('ip-plan-reason').fill('Second floor staff');
  await panel().getByLabel('Piece of work').fill('W-1042');
  await shot('ip2-next-free');
  await panel().getByTestId('ip-plan-take').click();
  await panel().getByText(/is yours until you release it/).waitFor({ timeout: 10000 });
  check('N2. the reservation is made, held by the work, ending in 30 days', /W-1042/.test(await panel().innerText()) && /reservation/i.test(await panel().innerText()) && /Ends\s+\d{4}-\d{2}-\d{2}/.test(await panel().innerText()), await panel().innerText());

  // The same key again gives the same block back.
  await tree.getByRole('button', { name: /^10\.20\.0\.0\/16/ }).click();
  await panel().getByTestId('ip-plan-length').selectOption('24');
  await panel().getByTestId('ip-plan-look').click();
  await panel().getByTestId('ip-plan-found').waitFor({ timeout: 10000 });
  const second = (await panel().getByTestId('ip-plan-found').innerText()).trim();
  check('N3. looking again offers the next /24, 10.20.2.0/24', /10\.20\.2\.0\/24/.test(second), second);
  await panel().getByTestId('ip-plan-key').fill('W-1042/lan');
  await panel().getByTestId('ip-plan-reason').fill('Asked twice');
  await panel().getByTestId('ip-plan-take').click();
  await panel().getByText(/answered before/).waitFor({ timeout: 10000 });
  check('N4. the same key gives the same block back, not a second one', /10\.20\.0\.0\/24, unchanged/.test(await panel().innerText()), await panel().innerText());
  check('N5. only one reservation is in the tree', (await tree.getByRole('button', { name: /Reserved for/ }).count()) === 1);
  await shot('ip3-tree');

  // A past end shows lapsed.
  await A.getByRole('button', { name: 'Add reservation' }).click();
  await field('What it holds').fill('10.20.1.9');
  await field('Reason').fill('Old printer');
  await form().locator('#ipplan-reservation-ends').fill('2026-11-01');
  await A.getByTestId('ip-plan-save').click();
  await panel().getByText('Reservation added').waitFor({ timeout: 10000 });
  check('N6. a reservation past its end is marked lapsed', /lapsed/.test(await panel().innerText()) && (await A.locator('.ipplan__row--lapsed').count()) === 1, await panel().innerText());

  // Release it.
  await panel().getByTestId('ip-plan-delete').click();
  await shot('ip4-release');
  await panel().getByTestId('ip-plan-delete-yes').click();
  await panel().waitFor({ state: 'detached', timeout: 10000 });
  await A.locator('.ipplan__row--lapsed').waitFor({ state: 'detached', timeout: 10000 }).catch(() => undefined);
  check('N7. released, it is gone from the tree', (await A.locator('.ipplan__row--lapsed').count()) === 0);

  // Edit: the LAN's role.
  await tree.getByRole('button', { name: /^10\.20\.1\.0\/24/ }).click();
  await panel().getByRole('button', { name: 'Edit' }).click();
  await field('Role').fill('Staff, floor 1');
  await A.getByTestId('ip-plan-save').click();
  await panel().getByText('Saved.').waitFor({ timeout: 10000 });
  await tree.getByText(/Staff, floor 1/).waitFor({ timeout: 10000 }).catch(() => undefined);
  check('E1. a change is saved and shown', /Staff, floor 1/.test(await tree.innerText()));
  await shot('ip5-block-panel');

  // A VRF that refuses the same network twice.
  await A.getByTestId('ip-plan-tab-vrfs').click();
  await A.getByRole('button', { name: 'Add route target' }).click();
  await field('Route target').fill('65000:100');
  await A.getByTestId('ip-plan-save').click();
  await panel().getByText('Route target added').waitFor({ timeout: 10000 });
  await A.getByRole('button', { name: 'Add VRF' }).click();
  await field('Name').fill('CUSTOMER-A');
  await field('Route distinguisher').fill('65000:1');
  await form().getByLabel('Refuse the same network twice').check();
  await form().getByLabel('65000:100').first().check();
  await A.getByTestId('ip-plan-save').click();
  await panel().getByText('VRF added').waitFor({ timeout: 10000 });
  await shot('ip6-vrfs');
  await A.getByTestId('ip-plan-tab-addresses').click();
  for (const attempt of [1, 2]) {
    await A.getByRole('button', { name: 'Add prefix' }).click();
    await field('Prefix').fill('192.0.2.0/24');
    await form().locator('#ipplan-prefix-vrf').selectOption({ label: 'CUSTOMER-A' });
    await A.getByTestId('ip-plan-save').click();
    if (attempt === 1) await panel().getByText('Prefix added').waitFor({ timeout: 10000 });
  }
  await A.getByTestId('ip-plan-form-error').waitFor({ timeout: 10000 });
  const refusal = await A.getByTestId('ip-plan-form-error').innerText();
  check('V1. the VRF refuses the same network twice, and the page shows the store’s own sentence', refusal.length > 10 && !/^refused$/i.test(refusal), refusal);
  await A.getByTestId('ip-plan-form-error').scrollIntoViewIfNeeded();
  await shot('ip7-refused');
  await form().getByRole('button', { name: 'Cancel' }).click();
  await A.getByTestId('ip-plan-vrf').selectOption({ label: 'CUSTOMER-A' });
  check('V2. the VRF picker shows the VRF’s own tree', /192\.0\.2\.0\/24/.test(await tree.innerText()) && !/10\.0\.0\.0\/8/.test(await tree.innerText()));
  await A.getByTestId('ip-plan-vrf').selectOption({ label: 'Global table' });

  // VLANs.
  await A.getByTestId('ip-plan-tab-vlans').click();
  await A.getByRole('button', { name: 'Add VLAN group' }).click();
  await field('Name').fill('Campus');
  await field('VLAN IDs').fill('100-199');
  await A.getByTestId('ip-plan-save').click();
  await panel().getByText('VLAN group added').waitFor({ timeout: 10000 });
  await panel().getByTestId('ip-plan-look').click();
  await panel().getByTestId('ip-plan-found').waitFor({ timeout: 10000 });
  check('L1. next free VLAN in 100-199 is 100', /100/.test(await panel().getByTestId('ip-plan-found').innerText()));
  await panel().getByTestId('ip-plan-key').fill('W-1042/vlan');
  await panel().getByLabel('Name').fill('Staff');
  await panel().getByTestId('ip-plan-take').click();
  await panel().getByText(/is yours/).waitFor({ timeout: 10000 });
  check('L2. the VLAN is taken and listed in its group', /100/.test(await plan().innerText()) && /Staff/.test(await plan().innerText()));
  await shot('ip8-vlans');

  // AS numbers.
  await A.getByTestId('ip-plan-tab-asns').click();
  await A.getByRole('button', { name: 'Add ASN range' }).click();
  await field('Name').fill('Private 4-byte');
  await field('First').fill('4200000000');
  await field('Last').fill('4200000999');
  await field('RIR').fill('RFC 6996');
  await A.getByTestId('ip-plan-save').click();
  await panel().getByText('ASN range added').waitFor({ timeout: 10000 });
  await panel().getByTestId('ip-plan-look').click();
  await panel().getByTestId('ip-plan-found').waitFor({ timeout: 10000 });
  await panel().getByTestId('ip-plan-key').fill('W-1042/asn');
  await panel().getByLabel('Meant for').fill('Northgate edge');
  await panel().getByTestId('ip-plan-take').click();
  await panel().getByText(/is yours/).waitFor({ timeout: 10000 });
  check('A1. the next free ASN is taken from the range', /4200000000/.test(await plan().innerText()) && /Northgate edge/.test(await plan().innerText()), await plan().innerText());
  await shot('ip9-asns');

  // NetBox files.
  await A.getByTestId('ip-plan-tab-addresses').click();
  await A.getByTestId('ip-plan-netbox').locator('summary').click();
  await shot('ip10-netbox');
  const [download] = await Promise.all([A.waitForEvent('download'), A.getByRole('button', { name: 'prefixes.csv' }).click()]);
  const csvText = readFileSync(await download.path(), 'utf8');
  check('X1. prefixes.csv has NetBox’s columns and the planned blocks', csvText.startsWith('prefix,vrf,vlan,status,role,is_pool,mark_utilized,description') && /10\.20\.1\.0\/24,,120,active/.test(csvText) && /192\.0\.2\.0\/24,CUSTOMER-A/.test(csvText) && /10\.20\.0\.0\/24,,,reserved/.test(csvText), csvText);
  await A.getByTestId('ip-plan-netbox').locator('summary').click();

  // A reload reads it back.
  await A.reload({ waitUntil: 'domcontentloaded' });
  await A.locator('.home, .drawing, .shell-bar').first().waitFor({ timeout: 20000 });
  await A.getByRole('tab', { name: 'Steward' }).click();
  await A.locator('.org-rail__item', { hasText: 'IP plan' }).click();
  await A.getByTestId('ip-plan-tree').waitFor({ timeout: 10000 });
  const after = await A.getByTestId('ip-plan-tree').innerText();
  check('R1. after a reload the tree is read back from the server', /10\.0\.0\.0\/8/.test(after) && /10\.20\.1\.1\/24/.test(after) && /Reserved for W-1042/.test(after) && /Northgate/.test(after), after);
  await A.getByTestId('ip-plan-tree').getByRole('button', { name: /^10\.20\.1\.0\/24/ }).click();
  await shot('ip11-light');

  // Dark and phone width.
  await A.emulateMedia({ colorScheme: 'dark' });
  await A.waitForTimeout(800);
  await shot('ip12-dark');
  await A.emulateMedia({ colorScheme: 'light' });
  await A.setViewportSize({ width: 390, height: 844 });
  await plan().scrollIntoViewIfNeeded();
  await A.waitForTimeout(300);
  await shot('ip13-phone');
  const overflow = await A.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check('M1. at phone width the page does not scroll sideways', overflow <= 1, `overflow ${overflow}px`);
  await A.setViewportSize(VIEWPORT);

  // The difference checks (decision 2): a plan for the sample home lab's space, then the sample's Checks.
  await A.getByRole('button', { name: 'Add aggregate' }).click();
  await field('Prefix').fill('192.168.0.0/16');
  await field('Where it came from').fill('RFC 1918');
  await A.getByTestId('ip-plan-save').click();
  await panel().getByText('Aggregate added').waitFor({ timeout: 10000 });
  await A.getByRole('button', { name: 'Add prefix' }).click();
  await field('Prefix').fill('192.168.30.0/25');
  await field('Role').fill('Cameras');
  await A.getByTestId('ip-plan-save').click();
  await panel().getByText('Prefix added').waitFor({ timeout: 10000 });
  for (const [address, meant] of [['192.168.10.1/24', 'router-1 LAN'], ['192.168.20.1/24', 'router-1 guest']]) {
    await A.getByRole('button', { name: 'Add address' }).click();
    await field('Address with its length').fill(address);
    await field('Meant for').fill(meant);
    await A.getByTestId('ip-plan-save').click();
    await panel().getByText('Address added').waitFor({ timeout: 10000 });
  }
  await A.getByRole('tab', { name: 'Designs' }).click();
  await A.getByRole('button', { name: 'Open sample' }).click();
  await A.locator('.drawing').waitFor({ timeout: 30000 });
  if ((await A.locator('[data-testid=checks-panel]').count()) === 0) await A.locator('[data-testid=dock-checks]').click();
  const checksPanel = A.locator('[data-testid=checks-panel]');
  await checksPanel.locator('[data-rule="ip-plan.not-drawn"]').waitFor({ timeout: 30000 });
  const ruleCount = (rule) => checksPanel.locator(`[data-rule="${rule}"]`).count();
  const panelText = await checksPanel.innerText();
  check('D1. three cameras drawn as /24 where the plan says /25 are each a different length', (await ruleCount('ip-plan.different-length')) === 3 && /192\.168\.30\.21\/24, but the plan says 192\.168\.30\.0\/25/.test(panelText), panelText);
  check('D2. the LAN nothing plans is one finding, under the aggregate', (await ruleCount('ip-plan.not-planned')) === 1 && /192\.168\.10\.0\/24 is drawn here but is not in the IP plan/.test(panelText), panelText);
  check('D3. the guest address planned for router-1 and not drawn on it is found', /192\.168\.20\.1\/24 is planned for router-1 but is not drawn on it/.test(panelText), panelText);
  check('D4. the planned router-1 LAN address matches, so it is not found', !/192\.168\.10\.1\/24/.test(panelText), panelText);
  await shot('ip14-checks');
  await checksPanel.locator('[data-rule="ip-plan.not-planned"]').getByRole('button', { name: 'Why?' }).click();
  await A.getByTestId('checks-why').waitFor({ timeout: 10000 });
  check('D5. Why? says where to add it', /Add 192\.168\.10\.0\/24 under 192\.168\.0\.0\/16 in Steward › IP plan/.test(await A.getByTestId('checks-why').innerText()), await A.getByTestId('checks-why').innerText());
  await shot('ip15-checks-why');
  await A.emulateMedia({ colorScheme: 'dark' });
  await A.waitForTimeout(800);
  await shot('ip16-checks-dark');
  await A.emulateMedia({ colorScheme: 'light' });

  check('F1. no page errors', errors.length === 0, errors.join(' | '));
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
