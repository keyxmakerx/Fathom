// Proves Termix beside Fathom (ADR-0078) against a REAL Termix, before anything in ADR-0080 leans
// on it (ADR-0080 decision 1). The real built client, the real server started with
// FATHOM_TERMIX_URL, a real Chromium, and a Termix 26.10.6 started from its published image. The
// tests in client/src/components/termix/ use Termix's request and reply shapes read from its code;
// this is the first run against Termix itself.
//
// What it does, as a person would:
//   T1. Termix's admin makes a user and an API key (drive-lib/termix.mjs), and adds one host by
//       hand, router-1 at 192.0.2.1, and one called "lab-gateway" at 192.0.2.2.
//   T2. Ann opens the sample home lab, gives router-1 its management address, presses Open in
//       Termix, pastes the key, and a new tab opens Termix's terminal for that host.
//   T3. pi-1 at 192.0.2.5, which Termix does not have: "Add it to Termix", and Termix then has a
//       host named pi-1 there, in the folder Fathom, tagged fathom, with no password or user name.
//   T4. switch-1 at 192.0.2.2, where Termix's host has another name: Fathom asks before opening.
//   T5. Inventory › Devices: tick every row, Send N to Termix. Termix gains the ones it lacked, in
//       the folder `Fathom / <design>`, and the summary counts what was already there.
//   T6. The key is revoked in Termix; the next Open says Termix refused it and asks for a new one.
//   Throughout: the key goes only to Termix's origin, every request to Termix is made with no
//   cookies, and no content-security-policy violation is reported.
//
//   TERMIX_URL=http://127.0.0.1:8080 node scripts/drive-termix.mjs
//
// Needs what drive-ai-connect.mjs needs (PostgreSQL on 127.0.0.1 with the `fathom_test` role, a
// built client, the fathom-server binary, Playwright's Chromium) and a Termix at TERMIX_URL that
// has no users yet. CI's `termix` job starts one (`.github/workflows/ci.yml`).
// Screenshots: FATHOM_SHOTS (default /mnt/project-files/reviews/termix/).

import { execFileSync, spawn } from 'node:child_process';
import { copyFileSync, createWriteStream, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrateUrl, runtimeUrl } from './drive-lib/db.mjs';
import { check, fails } from './drive-lib/kit.mjs';
import { addHost, hosts, makeApiKey, revokeApiKey, termixAdmin, waitForTermix } from './drive-lib/termix.mjs';

const pw = await import(process.env.PW_PLAYWRIGHT || '/opt/node22/lib/node_modules/playwright/index.js');
const { chromium } = pw.default ?? pw;

const ROOT = process.env.FATHOM_ROOT || resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = process.env.PW_CHROMIUM || '/opt/pw-browsers/chromium';
const TARGET_DIR = process.env.CARGO_TARGET_DIR ?? resolve(ROOT, 'target');
const SERVER_BIN = process.env.FATHOM_SERVER_BIN ?? resolve(TARGET_DIR, 'debug', 'fathom-server');
const SHOTS = (process.env.FATHOM_SHOTS ?? '/mnt/project-files/reviews/termix') + '/';
const WORK = process.env.FATHOM_DRIVE_DIR ?? join(process.env.TMPDIR ?? '/tmp', 'fathom-drive-termix');
mkdirSync(SHOTS, { recursive: true });
mkdirSync(WORK, { recursive: true });

const TERMIX = (process.env.TERMIX_URL ?? 'http://127.0.0.1:8080').replace(/\/$/, '');
const TERMIX_ORIGIN = new URL(TERMIX).origin;
const TERMIX_ADMIN = { username: 'fathom-ci-admin', password: 'termix-ci-admin-passphrase-kestrel' };

const PORT = 18195;
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
const STEWARD_PASSWORD = 'termix-steward-passphrase-kept-for-this-proof-only';
const VIEWPORT = { width: 1440, height: 900 };

/** Addresses from TEST-NET-1 (RFC 5737): nothing answers there, and nothing here connects. */
const ADDR = {
  'router-1': '192.0.2.1',
  'switch-1': '192.0.2.2',
  'pi-1': '192.0.2.5',
  'nas-1': '192.0.2.10',
  'server-1': '192.0.2.11',
  'ap-1': '192.0.2.12',
};

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

async function until(fn, timeoutMs = 15000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    let v;
    try { v = await fn(); } catch { v = false; }
    if (v) return v;
    if (Date.now() > end) return false;
    await sleep(200);
  }
}

function resetSchema() {
  sh('psql', [MIGRATE_URL, '-qc', 'DROP SCHEMA IF EXISTS vault CASCADE; DROP SCHEMA public CASCADE; CREATE SCHEMA public;']);
}

let serverProc = null;
let serverLog = '';
/** The signed-in page, for a screenshot when the run throws. */
let lastPage = null;

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
  console.log('==> starting fathom-server on ' + URL_ + ' with FATHOM_TERMIX_URL=' + TERMIX);
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
      FATHOM_TERMIX_URL: TERMIX,
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

async function signIn(page, address, password) {
  await page.goto(URL_, { waitUntil: 'domcontentloaded' });
  await page.locator('#signin-address').fill(address);
  await page.locator('#signin-password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.locator('.home, .drawing, .shell-bar').first().waitFor({ timeout: 20000 });
}

async function editTextField(panel, labelText, value) {
  const field = panel.locator('.drawing-editor__field-label', { hasText: labelText }).first().locator('xpath=..');
  const idle = field.locator('span').first();
  await idle.click();
  await idle.click();
  const input = field.locator('input');
  await input.fill(value);
  await input.press('Enter');
}

/** Inventory › Devices, the list. A device's page replaces the list, so Back returns to it. */
async function openList(page) {
  await page.locator('.shell-bar__tab', { hasText: 'Inventory' }).click();
  for (let i = 0; i < 3 && !(await until(() => page.locator('.inv-table__row').count(), 4000)); i++) await page.goBack();
  await page.waitForSelector('.inv-table__row', { timeout: 15000 });
}

/** The device's page, its Management fold open. */
async function openDevice(page, name) {
  await openList(page);
  await page.locator('.inv-table__row', { hasText: name }).first().locator('[role=gridcell]').nth(1).click();
  const fold = page.locator('[data-testid="management-fold"]');
  await fold.waitFor({ timeout: 10000 });
  if (!(await fold.evaluate((d) => d.open).catch(() => false))) await fold.locator('> summary').click();
  return fold;
}

async function giveAddress(page, name) {
  const panel = await openDevice(page, name);
  await editTextField(panel, 'Mgmt address', ADDR[name]);
  await until(async () => (await panel.innerText()).includes(ADDR[name]));
  return panel;
}

async function main() {
  console.log(`==> waiting for Termix at ${TERMIX}`);
  check('T0. Termix answers /health', await waitForTermix(TERMIX), TERMIX);

  console.log('==> resetting the fathom_test schema');
  resetSchema();
  rmSync(MASTER_KEY, { force: true });
  rmSync(CHAIN_KEY, { force: true });

  const browser = await chromium.launch({ executablePath: CHROME || undefined, args: ['--no-sandbox'] });
  try {
    const ctx = await browser.newContext({ viewport: VIEWPORT });
    const pubkey = await makeBrowserKey(ctx, STEWARD_ADDRESS);

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
    sh('cargo', ['test', '-p', 'fathom-server', '--locked', '--test', 'seed_people', '--', '--nocapture'], { cwd: ROOT, env: seedEnv, stdio: 'inherit' });
    const seed = JSON.parse(readFileSync(SEED_OUT, 'utf8'));
    await startServer();
    try {
      await runProof(ctx, seed);
    } catch (e) {
      await lastPage?.screenshot({ path: `${SHOTS}failed.png` }).catch(() => undefined);
      throw e;
    }
  } finally {
    await browser.close();
  }
}

async function runProof(ctx, seed) {
  // ---- T1. Termix's admin -------------------------------------------------------------------
  const admin = await termixAdmin(TERMIX, TERMIX_ADMIN.username, TERMIX_ADMIN.password);
  check('T1a. Termix made its first user an admin and signed it in', admin.isAdmin, admin.userId);
  const key = await makeApiKey(TERMIX, admin, admin.userId, 'Fathom CI');
  check('T1b. Termix gave an API key of the shape Fathom accepts (tmx_ and 64 hex)', /^tmx_[0-9a-f]{64}$/.test(key.token));
  const router = await addHost(TERMIX, key.token, { name: 'router-1', ip: ADDR['router-1'] });
  await addHost(TERMIX, key.token, { name: 'lab-gateway', ip: ADDR['switch-1'] });
  check('T1c. the key adds hosts through POST /host/db/host, answered with an id', Number.isInteger(Number(router?.id)), JSON.stringify(router).slice(0, 200));
  const before = await hosts(TERMIX, key.token);
  check('T1d. GET /host/db/host lists them with id, name, ip and port', Array.isArray(before) && before.length === 2 && before.every((h) => 'id' in h && 'name' in h && 'ip' in h && 'port' in h), JSON.stringify(before).slice(0, 300));

  // ---- Fathom, signed in, every request to Termix watched ------------------------------------
  const page = await ctx.newPage();
  lastPage = page;
  const violations = [];
  const toTermix = [];
  const keyElsewhere = [];
  page.on('pageerror', (e) => console.log(`[pageerror] ${e}`));
  page.on('console', (m) => { if (m.type() === 'error') console.log(`[console.error] ${m.text()}`); });
  ctx.on('request', (r) => {
    const auth = r.headers().authorization ?? '';
    const origin = new URL(r.url()).origin;
    if (origin === TERMIX_ORIGIN && r.resourceType() === 'fetch') toTermix.push({ method: r.method(), url: r.url(), body: r.postData(), cookie: r.headers().cookie ?? '' });
    if (auth.includes('tmx_') && origin !== TERMIX_ORIGIN) keyElsewhere.push(r.url());
    if (r.postData()?.includes('tmx_') && origin !== TERMIX_ORIGIN) keyElsewhere.push(r.url());
  });
  await page.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (e) => {
      window.__cspViolations = window.__cspViolations ?? [];
      window.__cspViolations.push(`${e.violatedDirective} ${e.blockedURI}`);
    });
  });
  const shot = (name) => page.screenshot({ path: `${SHOTS}${name}.png` });

  await signIn(page, seed.steward, STEWARD_PASSWORD);
  const access = await page.evaluate(async () => {
    const r = await fetch('/session/whoami').catch(() => null);
    return r ? r.status : null;
  });
  void access;
  const csp = await (await fetch(`${URL_}/`)).headers.get('content-security-policy');
  check('T2a. the server adds Termix to connect-src and nothing else', /connect-src[^;]*\s/.test(csp ?? '') && (csp ?? '').includes(TERMIX_ORIGIN) && !/frame-src[^;]*127\.0\.0\.1:8080/.test(csp ?? ''), csp ?? 'no CSP');

  await page.getByRole('tab', { name: 'Designs' }).click();
  await page.getByRole('button', { name: 'Open sample' }).click();
  await page.locator('.drawing').waitFor({ timeout: 15000 });
  await page.waitForTimeout(1000);

  // ---- T2. Open in Termix, a host Termix has -----------------------------------------------
  let panel = await giveAddress(page, 'router-1');
  const actions = panel.getByTestId('termix-actions');
  await actions.waitFor({ timeout: 10000 });
  check('T2b. the Management fold shows Open in Termix under the address', (await actions.getByRole('button', { name: 'Open in Termix' }).count()) === 1);
  await actions.getByRole('button', { name: 'Open in Termix' }).click();
  await actions.getByLabel('Termix API key').fill(key.token);
  await shot('t2-paste-key');
  const [tab] = await Promise.all([ctx.waitForEvent('page', { timeout: 15000 }), actions.getByRole('button', { name: 'Open', exact: true }).click()]);
  await until(() => tab.url().startsWith(TERMIX_ORIGIN), 15000);
  const opened = new URL(tab.url());
  check('T2c. a new tab opens Termix’s terminal for router-1’s host', opened.origin === TERMIX_ORIGIN && opened.searchParams.get('view') === 'terminal' && opened.searchParams.get('hostId') === String(router.id), tab.url());
  await tab.waitForLoadState('domcontentloaded').catch(() => undefined);
  await tab.waitForTimeout(2500);
  await tab.screenshot({ path: `${SHOTS}t2-termix-tab.png` });
  const tabTitle = await tab.title().catch(() => '');
  check('T2d. the tab is Termix’s own page', /termix/i.test(tabTitle + (await tab.content().catch(() => ''))), tabTitle);
  check('T2e. the tab cannot reach back into Fathom (no opener)', await tab.evaluate(() => window.opener === null).catch(() => false));
  await tab.close();
  check('T2f. Fathom says which host it opened', /Opened Termix’s host “router-1”/.test(await actions.innerText()), await actions.innerText());
  check('T2g. the key is kept in this tab’s session storage only', await page.evaluate((k) => sessionStorage.getItem('fathom.termix.key') === k && !Object.values(localStorage).some((v) => String(v).includes('tmx_')), key.token));

  // ---- T3. Add it to Termix ------------------------------------------------------------------
  panel = await giveAddress(page, 'pi-1');
  const piActions = panel.getByTestId('termix-actions');
  await piActions.getByRole('button', { name: 'Open in Termix' }).click();
  await piActions.getByRole('button', { name: 'Add it to Termix' }).waitFor({ timeout: 15000 });
  check('T3a. a device Termix lacks gets "Termix has no host at …" and Add it to Termix', /Termix has no host at 192\.0\.2\.5/.test(await piActions.innerText()));
  await shot('t3-missing');
  const [piTab] = await Promise.all([ctx.waitForEvent('page', { timeout: 15000 }), piActions.getByRole('button', { name: 'Add it to Termix' }).click()]);
  await until(() => piTab.url().startsWith(TERMIX_ORIGIN), 15000);
  const piHost = (await hosts(TERMIX, key.token)).find((h) => h.ip === ADDR['pi-1']);
  check('T3b. Termix now has a host named pi-1 at 192.0.2.5 on port 22', piHost?.name === 'pi-1' && Number(piHost?.port) === 22, JSON.stringify(piHost ?? null).slice(0, 300));
  check('T3c. in the folder Fathom, tagged fathom', piHost?.folder === 'Fathom' && JSON.stringify(piHost?.tags ?? '').includes('fathom'), `${piHost?.folder} ${JSON.stringify(piHost?.tags)}`);
  check('T3d. the tab opened that new host', new URL(piTab.url()).searchParams.get('hostId') === String(piHost?.id), piTab.url());
  await piTab.close();
  const posts = toTermix.filter((r) => r.method === 'POST');
  const sentBody = posts.map((r) => JSON.parse(r.body ?? '{}'));
  check(
    'T3e. what Fathom sent carries no password, key, user name or credential',
    sentBody.length >= 1 && sentBody.every((b) => !['password', 'key', 'username', 'credentialId', 'keyPassword', 'authType'].some((f) => f in b && b[f] !== '' && b[f] !== null)),
    JSON.stringify(sentBody),
  );

  // ---- T4. Same address, another name: asked first (sign-off r61) ---------------------------
  panel = await giveAddress(page, 'switch-1');
  const swActions = panel.getByTestId('termix-actions');
  await swActions.getByRole('button', { name: 'Open in Termix' }).click();
  await swActions.getByRole('alert').waitFor({ timeout: 15000 });
  check('T4. a host with another name at that address is shown and asked about', /called “lab-gateway”, not “switch-1”/.test(await swActions.innerText()), await swActions.innerText());
  await shot('t4-other-name');
  await swActions.getByRole('button', { name: 'Cancel' }).click();

  // ---- T5. Send N to Termix ------------------------------------------------------------------
  for (const name of ['nas-1', 'server-1', 'ap-1']) await giveAddress(page, name);
  await openList(page);
  await page.getByLabel('Select all rows').check();
  const send = page.getByTestId('termix-send');
  await send.waitFor({ timeout: 10000 });
  const label = await send.getByRole('button').first().innerText();
  check('T5a. Inventory offers Send 6 to Termix for the six devices with an address', /Send 6 to Termix/i.test(label), label);
  await send.getByRole('button').first().click();
  await send.getByRole('status').waitFor({ timeout: 30000 });
  const said = await send.getByRole('status').innerText();
  check('T5b. it adds the three Termix lacked and counts the three already there', /Added 3 to Termix; 3 were already there\./.test(said), said);
  await shot('t5-sent');
  const after = await hosts(TERMIX, key.token);
  const sent = after.filter((h) => ['nas-1', 'server-1', 'ap-1'].includes(h.name));
  check('T5c. Termix has nas-1, server-1 and ap-1, each once, at their addresses', sent.length === 3 && sent.every((h) => h.ip === ADDR[h.name]), JSON.stringify(sent.map((h) => [h.name, h.ip])));
  check('T5d. in the folder Fathom / <design>', sent.every((h) => typeof h.folder === 'string' && h.folder.startsWith('Fathom / ')), JSON.stringify(sent.map((h) => h.folder)));
  check('T5e. nothing Termix already had was added again', after.length === 6, String(after.length));

  // ---- T6. A revoked key ---------------------------------------------------------------------
  await revokeApiKey(TERMIX, admin, key.id);
  panel = await openDevice(page, 'router-1');
  const again = panel.getByTestId('termix-actions');
  await again.getByRole('button', { name: 'Open in Termix' }).click();
  await again.getByRole('alert').waitFor({ timeout: 15000 });
  check('T6a. a revoked key: Termix refused it, and Fathom says so', /Termix refused the API key/.test(await again.innerText()), await again.innerText());
  check('T6b. and forgets it, asking for a new one', (await again.getByLabel('Termix API key').count()) === 1 && (await page.evaluate(() => sessionStorage.getItem('fathom.termix.key'))) === null);
  await shot('t6-refused');

  // ---- Throughout ----------------------------------------------------------------------------
  check('T7a. the key went to Termix’s origin and nowhere else', keyElsewhere.length === 0, keyElsewhere.join(' '));
  check('T7b. every request to Termix carried no cookie', toTermix.length > 0 && toTermix.every((r) => r.cookie === ''), `${toTermix.length} requests`);
  violations.push(...((await page.evaluate(() => window.__cspViolations ?? [])) ?? []));
  check('T7c. no content-security-policy violation', violations.length === 0, violations.join(' | '));
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
} finally {
  if (fails.length > 0) console.log(serverLog.slice(-3000));
  await cleanup();
}
console.log(fails.length === 0 ? '\nALL PASS' : `\nFAIL: ${fails.length} check(s) failed`);
for (const f of fails) console.log('  - ' + f);
process.exit(fails.length === 0 ? 0 : 1);
