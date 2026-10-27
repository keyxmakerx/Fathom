// Drives the REAL built client against the REAL server through ADR-0072's
// connector: a Steward turns AI on in Organisation › AI, an AI app (played
// here by this script, as Claude Code would: PKCE, a loopback redirect) sends
// her browser to /oauth/authorize, she allows it on the "Connect an AI app"
// page, the script trades the code for tokens and uses /mcp's tools, and the
// idea it sends shows in the design's AI ideas tab. Then Admin › AI.
//
//   node scripts/drive-ai-connect.mjs
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
const SHOTS = (process.env.FATHOM_SHOTS ?? '/mnt/project-files/reviews/ai-connect') + '/';
const WORK = process.env.FATHOM_DRIVE_DIR ?? join(process.env.TMPDIR ?? '/tmp', 'fathom-drive-ai');
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
      FATHOM_AI_PUBLIC_URL: URL_,
      // Every request here comes from 127.0.0.1, not Anthropic's range; Claude Code is not held to it anyway.
      FATHOM_AI_CLAUDE_RANGES: 'off',
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
  const { createHash, randomBytes } = await import('node:crypto');
  const A = await ctxA.newPage();
  A.on('pageerror', (e) => console.log(`[A pageerror] ${e}`));
  A.on('console', (m) => { if (m.type() === 'error') console.log(`[A console.error] ${m.text()}`); });
  A.on('response', (r) => { if (r.status() === 404) console.log(`[A 404] ${r.request().method()} ${r.url()}`); });
  const shot = (name) => A.screenshot({ path: `${SHOTS}${name}.png` });

  await signIn(A, seed.steward, STEWARD_PASSWORD);

  // ---- Organisation › AI ----------------------------------------------------
  await A.getByRole('tab', { name: 'Organisation' }).click();
  await A.getByTestId('rail-ai').click();
  await A.getByTestId('ai-panel').waitFor({ timeout: 10000 });
  const url = (await A.getByTestId('ai-connector-url').innerText()).trim();
  check('O1. Organisation › AI shows the address to add in the AI app', url === `${URL_}/mcp`, url);
  await shot('o1-org-ai-off');
  await A.locator('.ai-info__i').first().click();
  await shot('o2-the-i-open');
  check('O2. the "i" opens a plain explanation in place', (await A.locator('.ai-info__body').count()) === 1);
  await A.locator('.ai-info__i').first().click();
  await A.locator('.ai-switch input').check();
  await A.getByRole('button', { name: '+ Person' }).click();
  await A.locator('select[aria-label="Add a person"]').selectOption({ index: 1 });
  await A.locator('.ai-tick', { hasText: 'Addresses, VLANs' }).first().locator('input').check();
  await A.locator('.ai-tick', { hasText: 'Claude Code' }).locator('input').check();
  await A.getByTestId('ai-policy-may-change').check();
  await shot('o3-org-ai-policy');
  await A.getByRole('button', { name: 'Save', exact: true }).click();
  await A.getByText('Saved. It is in the organisation’s history.').waitFor({ timeout: 10000 });
  check('O3. a Steward turns AI on, names a person, allows Claude Code and lets AI apps change designs', true);

  // A design to read: a new one, which a single design opens straight into from then on.
  await A.getByRole('tab', { name: 'Designs' }).click();
  await A.getByRole('button', { name: 'New design' }).first().click();
  await A.locator('.drawing').waitFor({ timeout: 15000 });
  await A.waitForTimeout(1500);

  // ---- The AI app starts a sign-in --------------------------------------------
  const CLIENT = 'https://claude.ai/oauth/claude-code-client-metadata';
  const BACK = 'http://localhost:53999/callback';
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash('sha256').update(verifier).digest());
  const q = new URLSearchParams({
    response_type: 'code', client_id: CLIENT, redirect_uri: BACK, code_challenge: challenge,
    code_challenge_method: 'S256', state: 'drive-state', resource: `${URL_}/mcp`,
  });
  let landed = null;
  await A.route('http://localhost:53999/**', (route) => {
    landed = route.request().url();
    return route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>back in the app</title><p>Signed in.</p>' });
  });
  await A.goto(`${URL_}/oauth/authorize?${q}`, { waitUntil: 'domcontentloaded' });
  await A.getByTestId('connect-ai-app').waitFor({ timeout: 20000 });
  await A.waitForTimeout(800);
  await shot('c1-connect-claude-code');
  const pageText = (await A.getByTestId('connect-ai-app').innerText()).replace(/\s+/g, ' ');
  check('C1. the page names the app and says nothing is shared until Allow', /Let Claude Code read your designs, as you/.test(pageText) && /Nothing is shared until you press Allow/.test(pageText));
  check('C1. it warns that Claude Code cannot be told apart from another program', /cannot tell it apart from another program/.test(pageText));
  await A.locator('.ai-connect__side .ai-tick', { hasText: 'Addresses, VLANs' }).locator('input').check();
  check('C1b. Allow waits for the AI account the app uses', await A.getByRole('button', { name: 'Allow', exact: true }).isDisabled());
  const changeTick = A.getByTestId('connect-may-change');
  check('C1c. with the organisation\'s tick on, Allow offers "May change designs", unticked', (await changeTick.count()) === 1 && !(await changeTick.isChecked()));
  await changeTick.check();
  const changeWords = (await A.locator('.ai-connect__side').innerText()).replace(/\s+/g, ' ');
  check('C1d. ticked, the plain words say it changes designs and name the risk', /Can change designs you can draw in/.test(changeWords) && /Text inside a design can steer an AI/.test(changeWords));
  await A.locator('#connect-ai-account').fill('Ann@Example.org');
  await A.getByRole('button', { name: 'Allow', exact: true }).click();
  for (let i = 0; i < 50 && landed === null; i++) await sleep(200);
  check('C2. Allow sends the browser back to the app with a code, the state and the issuer', landed !== null && /[?&]code=fac_/.test(landed) && /state=drive-state/.test(landed) && /iss=/.test(landed), landed ?? 'nothing');
  const code = new URL(landed).searchParams.get('code');

  // ---- The app trades the code and uses /mcp ----------------------------------------
  const unauth = await fetch(`${URL_}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"jsonrpc":"2.0","id":1,"method":"ping"}' });
  check('M0. /mcp without a token is 401 and names where to sign in', unauth.status === 401 && /resource_metadata=/.test(unauth.headers.get('www-authenticate') ?? ''));
  const tokenRes = await fetch(`${URL_}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: BACK, client_id: CLIENT, resource: `${URL_}/mcp` }),
  });
  const tokens = await tokenRes.json();
  check('M1. the code and verifier give an access and a refresh token', tokenRes.status === 200 && /^fat_/.test(tokens.access_token) && /^far_/.test(tokens.refresh_token));
  let id = 0;
  const rpc = async (method, params) => {
    const r = await fetch(`${URL_}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${tokens.access_token}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
    });
    const text = await r.text();
    return { status: r.status, body: text ? JSON.parse(text) : null };
  };
  const init = await rpc('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'drive', version: '1' } });
  check('M2. initialize answers the version and the tools capability', init.status === 200 && init.body.result.protocolVersion === '2025-11-25' && init.body.result.capabilities.tools != null);
  const listed = await rpc('tools/list', {});
  check('M3. six tools, change_design among them, since both ticks are on', listed.body.result.tools.length === 6 && listed.body.result.tools.some((t) => t.name === 'change_design'), listed.body.result.tools.map((t) => t.name).join(','));
  const who = await rpc('tools/call', { name: 'whoami', arguments: {} });
  check('M4. whoami says it reads layout and addresses, and may change designs', JSON.stringify(who.body.result.structuredContent.sees) === '["layout","addresses"]' && who.body.result.structuredContent.mayChange === true && who.body.result.structuredContent.readOnly === false);
  const designs = await rpc('tools/call', { name: 'list_designs', arguments: {} });
  const items = designs.body.result.structuredContent.items ?? [];
  check('M5. list_designs lists the design', items.length >= 1, JSON.stringify(items).slice(0, 200));
  const designId = items[0]?.id ?? items[0]?.design;
  const read = await rpc('tools/call', { name: 'read_design', arguments: { design: designId } });
  check('M6. read_design reads it', read.body.result && read.body.result.isError === false, JSON.stringify(read.body).slice(0, 300));
  const rec = await rpc('tools/call', {
    name: 'recommend',
    arguments: { design: designId, title: 'Add a second uplink to the core', why: 'One link is a single point of failure.', steps: [{ action: 'add', text: 'Add a second switch beside the first.' }, { action: 'connect', text: 'Connect the two switches with a second cable.' }] },
  });
  check('M7. recommend sends an idea', rec.body.result && rec.body.result.isError === false, JSON.stringify(rec.body).slice(0, 300));
  const leaky = await rpc('tools/call', {
    name: 'recommend',
    arguments: { design: designId, title: 'Set the admin password', steps: [{ action: 'change', text: 'set system root-authentication plain-text-password Hunter2!x' }] },
  });
  check('M8. an idea that carries a password is refused', leaky.body.result && leaky.body.result.isError === true, JSON.stringify(leaky.body).slice(0, 300));
  const version = read.body.result.structuredContent.version;
  const named = await rpc('tools/call', {
    name: 'change_design',
    arguments: { design: designId, version, summary: 'Rename a device that is not there', operations: [{ op: 'set', element: 'device:01ARZ3NDEKTSV4RRFFQ69G5FAV', field: 'hostname', value: 'core-1' }] },
  });
  check('M9. change_design refuses an element the reading did not give, by operation number', named.body.result?.isError === true && /operation 1 names nothing/.test(named.body.result.content[0].text), JSON.stringify(named.body).slice(0, 300));
  const stale = await rpc('tools/call', {
    name: 'change_design',
    arguments: { design: designId, version: version + 5, summary: 'From a reading that never was', operations: [{ op: 'set', element: 'device:01ARZ3NDEKTSV4RRFFQ69G5FAV', field: 'hostname', value: 'core-1' }] },
  });
  check('M10. change_design against a version that is not the design\'s is refused before anything else', stale.body.result?.isError === true && /read it again/.test(stale.body.result.content[0].text), JSON.stringify(stale.body).slice(0, 300));

  // ---- The idea in the design --------------------------------------------------------
  await A.unroute('http://localhost:53999/**');
  // Home opens the one design there is.
  await A.goto(URL_, { waitUntil: 'domcontentloaded' });
  await A.locator('.drawing').waitFor({ timeout: 20000 });
  const tab = A.getByRole('tab', { name: /AI ideas/ }).or(A.locator('[data-side-tab="ai-ideas"]')).or(A.getByText(/^AI ideas/)).first();
  await tab.waitFor({ timeout: 15000 });
  await tab.click();
  await A.getByTestId('ai-ideas').waitFor({ timeout: 10000 });
  await A.waitForTimeout(400);
  await shot('d1-ai-ideas-canvas');
  check('D1. the idea shows in the AI ideas tab on the canvas', (await A.getByTestId('ai-ideas').innerText()).includes('Add a second uplink to the core'));
  // Make it a plan: a draft plan with the idea's steps opens, and the idea is taken up.
  await A.getByTestId('ai-ideas').getByRole('button', { name: 'Make it a plan' }).click();
  const band = A.getByTestId('plans-band');
  await band.waitFor({ timeout: 20000 });
  await A.waitForTimeout(800);
  await shot('d2-ai-idea-plan');
  const planText = (await A.locator('body').innerText()).replace(/\s+/g, ' ');
  check('D2. Make it a plan opens a draft plan named after the idea, with its steps', planText.includes('Add a second uplink to the core') && planText.includes('Connect the two switches with a second cable.'));

  // ---- Organisation › AI lists it -------------------------------------------------------
  await A.locator('.shell-bar__brand').first().click();
  await A.locator('.home').first().waitFor({ timeout: 20000 });
  await A.getByRole('tab', { name: 'Organisation' }).click();
  await A.getByTestId('rail-ai').click();
  await A.locator('.ai-table__row', { hasText: 'Claude Code' }).first().click();
  await A.waitForTimeout(300);
  await shot('o4-org-ai-connection');
  check('O4. the connection is listed as Claude Code, on', /\bon\b/i.test(await A.locator('.ai-table__row', { hasText: 'Claude Code' }).innerText()));
  check('O4b. it shows the AI account the person gave, and their sign-in', (await A.getByTestId('ai-key-account').innerText()).includes('ann@example.org') && (await A.locator('.ai-facts').innerText()).includes('@'));
  check('O4c. its owner sees "May change designs", ticked, and can take it off', (await A.getByTestId('ai-key-may-change').count()) === 1 && (await A.getByTestId('ai-key-may-change').isChecked()));
  await A.getByRole('button', { name: 'Turn off', exact: true }).click();
  await A.getByRole('button', { name: 'Turn off now' }).click();
  await A.locator('.ai-table__row', { hasText: 'Claude Code' }).filter({ hasText: 'Off' }).waitFor({ timeout: 10000 });
  const after = await rpc('ping', {});
  check('O5. turned off, the token stops at the next request', after.status === 401, String(after.status));
  await shot('o5-org-ai-turned-off');
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
