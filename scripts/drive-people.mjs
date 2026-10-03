// Drives the REAL built client against the REAL server through People and
// access: a steward invites three people and a steward, each opens their own
// link in their own browser, the steward confirms the three in one signature,
// then approves the steward request. Takes screenshots for a UI review.
//
//   node scripts/drive-people.mjs
//
// Needs what drive-history-live.mjs needs: PostgreSQL on 127.0.0.1 with the
// `fathom_test`/`fathom_app` roles, a built client (`cd client && npm run
// build`), the fathom-server binary (`cargo build -p fathom-server --locked`)
// and Playwright's Chromium. The seed is drive-lib/seed_people.rs (Ann the
// steward, with a key made in her own browser), copied under
// crates/fathom-server/tests for the run and deleted. Everyone else joins
// through the real invitation flow.
//
// Screenshots: FATHOM_SHOTS (default /mnt/project-files/reviews/people-access/).
// The server is killed BY PORT, never by name.

import { execFileSync, spawn } from 'node:child_process';
import { copyFileSync, createWriteStream, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrateUrl, runtimeUrl } from './drive-lib/db.mjs';

const pw = await import(process.env.PW_PLAYWRIGHT || '/opt/node22/lib/node_modules/playwright/index.js');
const { chromium } = pw.default ?? pw;

const ROOT = process.env.FATHOM_ROOT || resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = process.env.PW_CHROMIUM || '/opt/pw-browsers/chromium';
const TARGET_DIR = process.env.CARGO_TARGET_DIR ?? resolve(ROOT, 'target');
const SERVER_BIN = process.env.FATHOM_SERVER_BIN ?? resolve(TARGET_DIR, 'debug', 'fathom-server');
const SHOTS = (process.env.FATHOM_SHOTS ?? '/mnt/project-files/reviews/people-access') + '/';
const WORK = process.env.FATHOM_DRIVE_DIR ?? join(process.env.TMPDIR ?? '/tmp', 'fathom-drive-people');
mkdirSync(SHOTS, { recursive: true });
mkdirSync(WORK, { recursive: true });

const PORT = 18192;
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

const fails = [];
function check(name, ok, detail) {
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (detail ? '  [' + detail + ']' : ''));
  if (!ok) fails.push(name);
}
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
  sh('psql', [MIGRATE_URL, '-qc', 'DROP SCHEMA public CASCADE; CREATE SCHEMA public;']);
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

/** Opens an invitation link in a fresh browser, as the invited person, and
 * returns what they saw. */
async function joinAs(browser, issued, shot, label) {
  const ctx = await browser.newContext({ viewport: VIEWPORT });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log(`[${label} pageerror] ${e}`));
  await page.goto(`${URL_}${issued.linkPath}`, { waitUntil: 'domcontentloaded' });
  await page.locator('#enrol-address').waitFor({ timeout: 15000 });
  if (shot) await page.screenshot({ path: `${SHOTS}${shot}-enrol.png` });
  await page.locator('#enrol-address').fill(issued.signInName);
  await page.getByRole('button', { name: 'Enrol this browser' }).click();
  await page.getByTestId('enrol-joined').waitFor({ timeout: 20000 });
  const code = ((await page.getByTestId('enrol-key-code').innerText()) ?? '').replace(/\s+/g, '');
  if (shot) await page.screenshot({ path: `${SHOTS}${shot}-code.png` });
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByTestId('awaiting-steward').waitFor({ timeout: 20000 });
  if (shot) await page.screenshot({ path: `${SHOTS}${shot}-waiting.png` });
  return { ctx, page, code };
}

async function invite(page, { name, email, capability, folder }) {
  await page.locator('.org-rail__item', { hasText: 'People' }).click();
  await page.getByRole('button', { name: 'Invite someone' }).click();
  const form = page.locator('.org-form');
  await form.locator('input.org-input').nth(0).fill(name);
  await form.locator('input.org-input').nth(1).fill(email);
  await form.getByRole('radio').nth(['read', 'draw', 'steward'].indexOf(capability)).check();
  if (folder) await form.locator('select').selectOption({ label: folder });
  return {
    async submit(shot) {
      if (shot) await page.screenshot({ path: `${SHOTS}${shot}.png` });
      await form.getByRole('button', { name: 'Make the link' }).click();
      const card = page.getByTestId('invite-link-card');
      await card.waitFor({ timeout: 20000 });
      const link = ((await page.getByTestId('invite-link').innerText()) ?? '').trim();
      const signInName = ((await page.getByTestId('invite-sign-in-name').innerText()) ?? '').trim();
      return { linkPath: new URL(link).pathname + new URL(link).hash, signInName, link };
    },
  };
}

async function runProof(browser, ctxA, seed) {
  const A = await ctxA.newPage();
  A.on('pageerror', (e) => console.log(`[A pageerror] ${e}`));
  A.on('console', (m) => { if (m.type() === 'error') console.log(`[A console.error] ${m.text()}`); });
  const shotA = (name) => A.screenshot({ path: `${SHOTS}${name}.png` });

  // ---- Ann makes two folders ------------------------------------------------
  await signIn(A, seed.steward, STEWARD_PASSWORD);
  await A.getByRole('tab', { name: 'Organisation' }).click();
  await A.locator('.org-rail__item', { hasText: 'Folders' }).click();
  for (const folder of ['LON1', 'MAN1']) {
    await A.getByRole('button', { name: 'New site' }).click();
    await A.locator('#home-new-scope-label').fill(folder);
    await A.getByRole('button', { name: 'Create', exact: true }).click();
    await A.getByText(folder, { exact: true }).first().waitFor({ timeout: 10000 });
  }
  await A.locator('.org-rail__item', { hasText: 'People' }).click();
  await A.getByText('Ann Alder').waitFor({ timeout: 10000 });
  check('P0. People lists the existing members with what they can do', (await A.locator('.org-table tbody tr').count()) >= 1);
  await shotA('p1-people-before');

  // ---- invite: the form, then the one-time link ----------------------------------
  const inviteJo = await invite(A, { name: 'Jo Kim', email: 'jo@northwind.example', capability: 'draw', folder: 'LON1' });
  const jo = await inviteJo.submit('i1-invite-form');
  await shotA('i2-link-card');
  check('I1. the link card shows the link and a sign-in name with no @', /\/invite#inv_[0-9a-f]{64}$/.test(jo.link) && !jo.signInName.includes('@'), jo.signInName);
  const cardText = (await A.getByTestId('invite-link-card').innerText()).replace(/\s+/g, ' ');
  check('I1. it says Fathom does not email it and that it works once', /Fathom does not email this/.test(cardText) && /works once/.test(cardText));
  await A.getByRole('button', { name: 'Invite someone else' }).click();

  const mk = async (spec) => {
    const form = await invite(A, spec);
    const issued = await form.submit(null);
    await A.getByRole('button', { name: 'Done' }).click();
    return issued;
  };
  const ana = await mk({ name: 'Ana Silva', email: 'ana@northwind.example', capability: 'read', folder: 'MAN1' });
  const sam = await mk({ name: 'Sam Okafor', email: '', capability: 'draw', folder: 'LON1' });
  const lee = await mk({ name: 'Lee Wong', email: 'lee@northwind.example', capability: 'steward', folder: 'LON1' });

  await A.locator('.org-rail__item', { hasText: 'People' }).click();
  await A.getByText('Lee Wong').waitFor({ timeout: 10000 });
  await shotA('p2-people-invited');
  const rowsText = (await A.locator('.org-table').innerText()).replace(/\s+/g, ' ');
  check('P1. invited people show as Invited with what they were asked for', /Jo Kim.*Draw · LON1 \(when they join\).*Invited/.test(rowsText), rowsText.slice(0, 200));
  check('P1. Waiting for you is empty before anyone joins', (await A.locator('[data-testid=rail-waiting]').innerText()).trim() === 'Waiting for you');

  // ---- they join, in their own browsers ----------------------------------------
  const joined = {};
  joined.jo = await joinAs(browser, jo, 'j1-jo', 'Jo');
  joined.ana = await joinAs(browser, ana, null, 'Ana');
  joined.sam = await joinAs(browser, sam, null, 'Sam');
  joined.lee = await joinAs(browser, lee, null, 'Lee');
  check('J1. each person is shown a 10-character key-check code', Object.values(joined).every((j) => /^[0-9A-Z]{10}$/.test(j.code)), JSON.stringify(Object.fromEntries(Object.entries(joined).map(([k, v]) => [k, v.code]))));
  const waitingText = (await joined.jo.page.getByTestId('awaiting-steward').innerText()).replace(/\s+/g, ' ');
  check('J1. after joining, the person is told a steward has to confirm them', /waiting for a steward to confirm you/i.test(waitingText));

  // an old link is dead
  const reuse = await browser.newContext({ viewport: VIEWPORT });
  const rp = await reuse.newPage();
  await rp.goto(`${URL_}${jo.linkPath}`, { waitUntil: 'domcontentloaded' });
  await rp.locator('#enrol-address').fill(jo.signInName);
  await rp.getByRole('button', { name: 'Enrol this browser' }).click();
  await rp.locator('.enrol__refusal').waitFor({ timeout: 15000 });
  const refusal = (await rp.locator('.enrol__refusal').innerText()).replace(/\s+/g, ' ');
  await rp.screenshot({ path: `${SHOTS}j2-used-link.png` });
  check('J2. a used link is refused and says to tell the person who sent it', /tell the person who sent it/.test(refusal), refusal);
  await reuse.close();

  // ---- Waiting for you -----------------------------------------------------------
  await A.reload({ waitUntil: 'domcontentloaded' });
  await A.getByRole('tab', { name: 'Organisation' }).click();
  await A.getByTestId('people-waiting-box').waitFor({ timeout: 15000 });
  await shotA('w1-people-with-waiting-box');
  const railText = (await A.locator('[data-testid=rail-waiting]').innerText()).trim();
  check('W1. the rail counts the people waiting', /Waiting for you \(4\)/.test(railText), railText);
  await A.locator('[data-testid=rail-waiting]').click();
  await A.getByTestId('waiting-table').waitFor({ timeout: 10000 });
  await shotA('w2-waiting');
  const tableText = (await A.getByTestId('waiting-table').innerText()).replace(/\s+/g, ' ');
  const codes = Object.values(joined).map((j) => j.code);
  const spaced = (c) => `${c.slice(0, 5)} ${c.slice(5)}`;
  check('W2. each waiting row shows the code the person read out', ['jo', 'ana', 'sam'].every((k) => tableText.includes(spaced(joined[k].code))), tableText.slice(0, 300));
  check('W2. every batch row is ticked and the button says Confirm 3 people', (await A.getByTestId('waiting-table').locator('tbody input:checked').count()) === 3 && (await A.getByRole('button', { name: 'Confirm 3 people' }).count()) === 1);
  check('W2. the steward request is not in the batch', (await A.getByTestId('steward-requests').innerText()).includes('Lee Wong') && !tableText.includes('Lee Wong'));

  // Change one row: Ana asked for Read on MAN1; give her Read on LON1 instead.
  const anaRow = A.locator('tr', { hasText: 'Ana Silva' });
  await anaRow.getByRole('button', { name: 'Change' }).click();
  await anaRow.locator('select').nth(1).selectOption({ label: 'LON1' });
  await anaRow.getByRole('button', { name: 'Use this' }).click();
  check('W3. Change shows what it was changed from', /changed from Read · MAN1/.test((await anaRow.innerText()).replace(/\s+/g, ' ')));

  await A.getByRole('button', { name: 'Confirm 3 people' }).click();
  await A.getByTestId('waiting-review').waitFor({ timeout: 20000 }).catch(async (e) => {
    console.log('     page said: ' + (await A.locator('.org-page').innerText()).replace(/\s+/g, ' ').slice(0, 600));
    await shotA('debug-no-review');
    throw e;
  });
  await shotA('w3-review-before-signing');
  const reviewText = (await A.getByTestId('waiting-review').innerText()).replace(/\s+/g, ' ');
  check('W4. the full list is shown before signing, with the changed access', /Jo Kim/.test(reviewText) && /Ana Silva · Read · LON1/.test(reviewText) && /Sam Okafor/.test(reviewText), reviewText.slice(0, 300));
  await A.getByRole('button', { name: /Sign and confirm 3 people/ }).click();
  await A.getByText('Confirmed 3 people.').waitFor({ timeout: 120000 });
  await shotA('w4-confirmed');
  check('W5. three people confirmed with one signature action', true);

  // the steward request, one at a time
  await A.getByTestId('steward-requests').waitFor({ timeout: 10000 });
  await A.getByRole('button', { name: 'Review as Steward' }).click();
  await A.getByTestId('waiting-review').waitFor({ timeout: 20000 });
  await shotA('s1-steward-review');
  const stewardText = (await A.getByTestId('waiting-review').innerText()).replace(/\s+/g, ' ');
  check('S1. a steward request states the 24 hour wait (sole steward) and the end date', /24 hours/.test(stewardText) && /ends /.test(stewardText), stewardText.slice(0, 400));
  const signButton = A.getByRole('button', { name: /Sign and confirm 1 person/ });
  check('S1. signing waits for the code tick', await signButton.isDisabled());
  await A.getByRole('checkbox').check();
  await signButton.click();
  await A.getByText(/Confirmed 1 person/).waitFor({ timeout: 60000 });
  await shotA('s2-steward-confirmed');

  // ---- People afterwards, and the people who can now see the organisation ----------
  await A.locator('.org-rail__item', { hasText: 'People' }).click();
  await A.getByText('Jo Kim').first().waitFor({ timeout: 10000 });
  await shotA('p3-people-after');
  const after = (await A.locator('.org-table').innerText()).replace(/\s+/g, ' ');
  check('P2. the confirmed people are Active with their access', /Jo Kim.*Draw · LON1.*Active/.test(after) && /Sam Okafor.*Draw · LON1.*Active/.test(after), after.slice(0, 300));

  await joined.jo.page.reload({ waitUntil: 'domcontentloaded' });
  await joined.jo.page.locator('.home__org-row').first().waitFor({ timeout: 20000 });
  check('J3. Jo now sees the organisation after the steward confirmed them', (await joined.jo.page.locator('.home__org-row').count()) >= 1);
  await joined.jo.page.screenshot({ path: `${SHOTS}j3-jo-in.png` });

  // a person page, and removing a draw grant
  await A.getByRole('button', { name: 'Sam Okafor' }).click();
  await A.getByRole('button', { name: 'Remove' }).first().waitFor({ timeout: 10000 });
  await shotA('r1-person-page');
  await A.getByRole('button', { name: 'Remove' }).first().click();
  await shotA('r2-remove-confirm');
  await A.getByRole('button', { name: 'Sign and remove' }).click();
  await A.getByText(/Removed and signed/).waitFor({ timeout: 20000 });
  check('R1. removing a draw grant is signed and at once', true);

  // removing a steward says the 24 hour rule; Lee's appointment is waiting out its own 24 hours
  await A.locator('.org-rail__item', { hasText: 'People' }).click();
  await A.getByRole('button', { name: 'Lee Wong' }).click();
  const leePage = (await A.locator('.org-page').innerText()).replace(/\s+/g, ' ');
  console.log('     Lee page: ' + leePage.slice(0, 300));
  await shotA('r3-steward-person-page');
  const leeRemove = A.getByRole('button', { name: 'Remove' });
  if ((await leeRemove.count()) > 0) {
    await leeRemove.first().click();
    const words = (await A.locator('.org-page').innerText()).replace(/\s+/g, ' ');
    check('R2. removing a steward says the 24 hour rule in words', /24 hours after you sign/.test(words), words.slice(0, 300));
    await shotA('r4-steward-remove-words');
  } else {
    check('R2. removing a steward says the 24 hour rule in words', false, 'no Remove on the steward row: ' + leePage.slice(0, 200));
  }

  // ---- a member who is not a steward: Jo, confirmed with Draw --------------------
  const joTabs = await joined.jo.page.getByRole('tab').allInnerTexts();
  check('N1. a drawer sees no Organisation tab, so no People, Waiting or emails', !joTabs.some((t) => /organisation/i.test(t)), JSON.stringify(joTabs));
  const joHtml = await joined.jo.page.content();
  check('N1. no contact email is anywhere on a non-steward\'s page', !/@northwind\.example/.test(joHtml));

  for (const j of Object.values(joined)) await j.ctx.close();
  await ctxA.close();
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
