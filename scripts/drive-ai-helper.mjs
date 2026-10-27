// Drives the REAL built client against the REAL server and the REAL helper
// (ADR-0072 decision 3), with the connector OFF (no FATHOM_AI_PUBLIC_URL), as on
// a Fathom no AI vendor can reach: a Steward turns AI on in Steward › AI,
// downloads the helper Fathom serves, runs its pair line, pastes what it prints
// under "It uses a key" and presses Make key; the helper then answers `check`
// and, started as an MCP server over stdio the way an AI app starts it, lists
// and reads the design. Turned off, the key stops at its next request.
//
//   node scripts/drive-ai-helper.mjs
//
// Needs what drive-history-live.mjs needs: PostgreSQL on 127.0.0.1 with the
// `fathom_test`/`fathom_app` roles, a built client (`cd client && npm run
// build`), the fathom-server binary (`cargo build -p fathom-server --locked`)
// and Playwright's Chromium. The seed is drive-lib/seed_people.rs (Ann the
// steward, with a key made in her own browser), copied under
// crates/fathom-server/tests for the run and deleted. Everyone else joins
// through the real invitation flow.
//
// Screenshots: FATHOM_SHOTS (default /mnt/project-files/reviews/ai-helper/).
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
const SHOTS = (process.env.FATHOM_SHOTS ?? '/mnt/project-files/reviews/ai-helper') + '/';
const WORK = process.env.FATHOM_DRIVE_DIR ?? join(process.env.TMPDIR ?? '/tmp', 'fathom-drive-ai-helper');
mkdirSync(SHOTS, { recursive: true });
mkdirSync(WORK, { recursive: true });

const PORT = 18196;
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
  } catch (e) {
    console.log('FAIL  the drive threw: ' + (e && e.stack ? e.stack : e));
    fails.push('threw');
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

const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function runProof(browser, ctxA, seed) {
  const A = await ctxA.newPage();
  A.on('pageerror', (e) => console.log(`[A pageerror] ${e}`));
  A.on('console', (m) => { if (m.type() === 'error') console.log(`[A console.error] ${m.text()}`); });
  const shot = (name) => A.getByTestId('ai-how').screenshot({ path: `${SHOTS}${name}.png` });
  const HOME = join(WORK, 'home');
  rmSync(HOME, { recursive: true, force: true });
  mkdirSync(HOME, { recursive: true });
  const helperEnv = { ...process.env, HOME };
  delete helperEnv.FATHOM_AI_KEY;

  await signIn(A, seed.steward, STEWARD_PASSWORD);
  const openAi = async () => {
    await A.getByRole('tab', { name: 'Steward' }).click();
    await A.getByTestId('rail-ai').click();
    await A.getByTestId('ai-panel').waitFor({ timeout: 10000 });
  };
  await openAi();
  const keyWay = A.getByRole('radio', { name: /It uses a key/ });
  check('K1. with the connector off, Connect an AI app opens on "It uses a key"', (await keyWay.getAttribute('aria-checked')) === 'true');
  await A.getByRole('radio', { name: /It signs in/ }).click();
  check('K1. "It signs in" says the address is not set and a key still works', /An app on your computer can still connect with a key/.test(await A.getByTestId('ai-how').innerText()));
  await keyWay.click();
  check('K2. before AI is on there is no Make key, and it says why', (await A.getByRole('button', { name: 'Make key' }).count()) === 0 && (await A.getByTestId('ai-how-blocked').count()) === 1);
  await shot('k2-off');

  check('R1. the AI page says AI is off here and opens AI rules', /AI is off here/.test(await A.getByTestId('ai-rules-line').innerText()));
  await A.getByTestId('ai-open-rules').click();
  await A.getByTestId('ai-rules').waitFor({ timeout: 10000 });
  await A.locator('.ai-switch input').check();
  await A.getByRole('button', { name: '+ Person' }).click();
  await A.locator('select[aria-label="Add a person"]').selectOption({ index: 1 });
  await A.locator('.ai-policy .ai-tick', { hasText: 'Addresses, VLANs' }).first().locator('input').check();
  await A.getByRole('button', { name: 'Save', exact: true }).click();
  await A.getByText('Saved. It is in the organisation’s history.').waitFor({ timeout: 10000 });
  await A.setViewportSize({ width: VIEWPORT.width, height: 1400 });
  await A.screenshot({ path: `${SHOTS}r2-ai-rules.png` });
  await A.setViewportSize(VIEWPORT);

  await A.getByRole('tab', { name: 'Designs' }).click();
  await A.getByRole('button', { name: 'New design' }).first().click();
  await A.locator('.drawing').waitFor({ timeout: 15000 });
  await A.waitForTimeout(1500);
  await A.locator('.shell-bar__brand').first().click();
  await A.locator('.home').first().waitFor({ timeout: 20000 });
  await openAi();
  await A.getByRole('radio', { name: /It uses a key/ }).click();
  await A.getByRole('button', { name: 'Make key' }).waitFor({ timeout: 10000 });

  // The download link is Fathom's own copy of the helper.
  const href = await A.getByRole('link', { name: 'Download the Fathom AI helper' }).getAttribute('href');
  const served = await fetch(new URL(href, URL_));
  const HELPER = join(WORK, 'fathom-ai.mjs');
  writeFileSync(HELPER, Buffer.from(await served.arrayBuffer()));
  check('K3. the download link serves the helper', served.status === 200 && readFileSync(HELPER, 'utf8').includes('fathom-ai'));

  const pairLine = (await A.getByTestId('ai-helper-pair').innerText()).trim();
  check('K4. the pair line names this Fathom', pairLine === `node fathom-ai.mjs pair ${URL_}`, pairLine);
  const printed = sh('node', [HELPER, 'pair', URL_], { env: helperEnv });
  const pub = (printed.match(/\b04[0-9a-f]{128}\b/) ?? [])[0];
  const keyId = (printed.match(/key id will be ([0-9A-Z]{26})/) ?? [])[1];
  check('K4. the helper made a key and printed its public half and id', !!pub && !!keyId, printed.slice(0, 200));

  await A.getByLabel('The helper’s public key').fill('not a key');
  check('K5. a wrong paste is named and Make key stays off', (await A.getByRole('button', { name: 'Make key' }).isDisabled()) && /130 characters/.test(await A.getByTestId('ai-helper').innerText()));
  await A.getByLabel('The helper’s public key').fill(pub);
  await A.locator('#ai-helper-label').fill('Helper on the drive laptop');
  check('K5b. Make key waits for the AI account the app uses', await A.getByRole('button', { name: 'Make key' }).isDisabled());
  await A.locator('#ai-helper-account').fill('ann@example.org');
  await A.getByTestId('ai-helper').locator('.ai-tick', { hasText: 'Addresses, VLANs' }).locator('input').check();
  await shot('k5-filled');
  await A.getByRole('button', { name: 'Make key' }).click();
  await A.getByTestId('ai-helper-made').waitFor({ timeout: 10000 });
  const madeText = await A.getByTestId('ai-helper-made').innerText();
  check('K6. Make key shows the same key id the helper printed', madeText.includes(keyId), madeText);
  await A.getByLabel('Where you saved the helper').fill('/home/ann/fathom-ai.mjs');
  check('K7. the app settings carry the path given', (await A.getByTestId('ai-helper-claude-code').innerText()).includes('claude mcp add fathom -- node /home/ann/fathom-ai.mjs'));
  await shot('k6-made');
  check('K8. it is listed as the Fathom AI helper, on', /Fathom AI helper/.test(await A.locator('.ai-table__row', { hasText: 'Helper on the drive laptop' }).innerText()));
  check('R2. the AI page says what the rules allow', /^AI is on\./.test(await A.getByTestId('ai-rules-line').innerText()));
  await A.getByRole('radio', { name: /It signs in/ }).click();
  await A.mouse.move(0, 0);
  await A.waitForTimeout(300);
  await A.screenshot({ path: `${SHOTS}r3-ai-page.png` });
  await A.getByRole('radio', { name: /It uses a key/ }).click();

  // The helper, as an AI app runs it.
  const checked = sh('node', [HELPER, 'check'], { env: helperEnv });
  check('K9. `check` answers what the key may do', /"addresses"/.test(checked), checked.slice(0, 300));
  const mcp = spawn('node', [HELPER], { env: helperEnv, stdio: ['pipe', 'pipe', 'inherit'] });
  const waiting = new Map();
  let buf = '';
  mcp.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      const msg = JSON.parse(line);
      waiting.get(msg.id)?.(msg);
    }
  });
  let n = 0;
  const rpc = (method, params) => new Promise((res) => { const id = ++n; waiting.set(id, res); mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });
  const init = await rpc('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'drive', version: '1' } });
  check('K10. the helper answers initialize over stdio', !!init.result);
  mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  const tools = await rpc('tools/list', {});
  check('K10. five tools', tools.result?.tools?.length === 5, (tools.result?.tools ?? []).map((t) => t.name).join(','));
  const listed = await rpc('tools/call', { name: 'fathom_list_designs', arguments: {} });
  const listedText = JSON.stringify(listed.result ?? listed.error);
  check('K11. it lists the design', listed.result && !listed.result.isError && listedText.includes('folder'), listedText.slice(0, 300));
  mcp.kill();

  await A.locator('.ai-table__row', { hasText: 'Helper on the drive laptop' }).click();
  await A.getByRole('button', { name: 'Turn off', exact: true }).click();
  await A.getByRole('button', { name: 'Turn off now' }).click();
  await A.locator('.ai-table__row', { hasText: 'Helper on the drive laptop' }).filter({ hasText: 'Off' }).waitFor({ timeout: 10000 });
  let stopped = false;
  try { sh('node', [HELPER, 'check'], { env: helperEnv, stdio: 'pipe' }); } catch { stopped = true; }
  check('K12. turned off, the key stops at its next request', stopped);
  await shot('k12-off');
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
