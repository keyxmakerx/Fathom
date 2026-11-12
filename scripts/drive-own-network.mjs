// Sign-off r123, driven end to end in a real browser against the real server and built client:
// `node scripts/drive-own-network.mjs`. A fresh install to an empty design of one's own through Home's
// "Start your own network" card. Builds neither; kills the server by PORT, never by name.

import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync, existsSync, rmSync, copyFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { migrateUrl, runtimeUrl, superuserUrl } from './drive-lib/db.mjs';
import { applyDriveCpuThrottle } from './drive-lib/cpuThrottle.mjs';
import { base32Decode, totpCode } from './drive-lib/kit.mjs';

const ROOT = process.env.FATHOM_ROOT ?? fileURLToPath(new URL('..', import.meta.url));
// `CARGO_TARGET_DIR` is shared across worktrees in this project (NEXT.md
// ground rule 3), so the binary is not always under ./target.
const TARGET_DIR = process.env.CARGO_TARGET_DIR ?? join(ROOT, 'target');
const SERVER_BIN = process.env.FATHOM_SERVER_BIN ?? join(TARGET_DIR, 'debug', 'fathom-server');
const PORT = 18195;
const SERVER_URL = `http://127.0.0.1:${PORT}`;
const DB_NAME = 'fathom_place_ownnetwork';
const RUNTIME_URL = runtimeUrl(DB_NAME);
const MIGRATE_URL = migrateUrl(DB_NAME);
const CHROME = process.env.PW_CHROMIUM ?? '/opt/pw-browsers/chromium';
const PLAYWRIGHT = process.env.PW_PLAYWRIGHT ?? '/opt/node22/lib/node_modules/playwright/index.mjs';
const ADDRESS = 'owner@fathom.invalid';
// The length and shape ADR-0055 decision 10 requires, and the CI script's own.
const CREDENTIAL = 'harbour-lantern-copper-nine';
const SHOTS = `${process.env.FATHOM_SHOTS ?? join(tmpdir(), 'fathom-shots')}/`;
mkdirSync(SHOTS, { recursive: true });

const work = mkdtempSync(join(tmpdir(), 'fathom-ownnetwork-'));
const MASTER_KEY_PATH = join(work, 'master.key');
const CHAIN_KEY_PATH = join(work, 'chain.key');
// The setup password the server is started with (ADR-0057), typed on the
// Welcome screen; not on `common-passwords.txt`'s eight-character floor.
const SETUP_PASSWORD = 'amber-kestrel-harbour-4471';

let failures = 0;
function check(what, ok, detail = '') {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${detail ? ' — ' + detail : ''}`);
  if (!ok) failures += 1;
}

function sh(cmd, args, options = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', ...options });
  if (r.status !== 0 && !options.allowFailure) {
    throw new Error(`${cmd} ${args.join(' ')} failed:\n${r.stdout ?? ''}${r.stderr ?? ''}`);
  }
  return r;
}

function psql(sql, { allowFailure = false } = {}) {
  return sh('psql', ['-d', superuserUrl('postgres'), '-qc', sql], { allowFailure });
}

async function waitForHttp(url, attempts = 100) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await fetch(url);
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw new Error(`${url} never answered`);
}

let serverProc = null;
function stopServer() {
  // By PORT, never by process name: another agent's `cargo` or `node` must
  // not be caught by this.
  sh('fuser', ['-k', `${PORT}/tcp`], { allowFailure: true });
  if (serverProc) serverProc.kill('SIGTERM');
}

// --- the authenticator app, in Node (RFC 6238, as credentials.rs) ----------
// Verbatim from `scripts/drive-csp.mjs`.

const currentStep = () => Math.floor(Date.now() / 1000 / 30);

/** A code for a step this run has not spent yet: a code is accepted once. */
async function freshCode(secret, spentSteps) {
  for (;;) {
    const step = currentStep();
    if (!spentSteps.has(step)) {
      spentSteps.add(step);
      return totpCode(secret, step);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
}

async function main() {
  const dist = join(ROOT, 'client', 'dist', 'index.html');
  if (!existsSync(dist)) {
    throw new Error(`no built client at ${dist}. Run: cd client && npm ci --ignore-scripts && npm run build`);
  }
  if (!existsSync(SERVER_BIN)) {
    throw new Error(`no server binary at ${SERVER_BIN}. Run: cargo build -p fathom-server`);
  }

  // `TARGET_DIR` is shared; a concurrent build elsewhere could overwrite
  // this binary mid-run. Copied once, to a path only this run touches.
  const commit = sh('git', ['rev-parse', 'HEAD'], { cwd: ROOT }).stdout.trim();
  const dirty = sh('git', ['status', '--porcelain'], { cwd: ROOT }).stdout.trim().length > 0;
  console.log(`==> server binary is from commit ${commit}${dirty ? ' (plus uncommitted changes)' : ''}`);
  const privateServerBin = join(work, 'fathom-server');
  copyFileSync(SERVER_BIN, privateServerBin);
  chmodSync(privateServerBin, 0o755);

  console.log(`==> database ${DB_NAME}`);
  psql(`DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE);`, { allowFailure: true });
  psql(`CREATE DATABASE ${DB_NAME} OWNER fathom_test;`);

  writeFileSync(MASTER_KEY_PATH, Buffer.alloc(32, 13), { mode: 0o600 });
  writeFileSync(CHAIN_KEY_PATH, Buffer.alloc(32, 17), { mode: 0o600 });

  console.log(`==> starting fathom-server on ${SERVER_URL} with the built client behind it`);
  const env = { ...process.env };
  delete env.DATABASE_URL;
  serverProc = spawn(privateServerBin, [], {
    cwd: ROOT,
    env: {
      ...env,
      DATABASE_URL: RUNTIME_URL,
      FATHOM_MIGRATE_DATABASE_URL: MIGRATE_URL,
      FATHOM_SCHEMA_ROOT: `${ROOT}/schema`,
      FATHOM_MASTER_KEY: `file://${MASTER_KEY_PATH}`,
      FATHOM_CHAIN_KEY: `file://${CHAIN_KEY_PATH}`,
      FATHOM_OPERATOR_NOTICE_ADDRESS: ADDRESS,
      FATHOM_SETUP_PASSWORD: SETUP_PASSWORD,
      FATHOM_CLIENT_ROOT: `${ROOT}/client/dist`,
      FATHOM_BIND: `127.0.0.1:${PORT}`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverLog = '';
  serverProc.stdout.on('data', (d) => { serverLog += d.toString(); });
  serverProc.stderr.on('data', (d) => { serverLog += d.toString(); });

  try {
    const health = await waitForHttp(`${SERVER_URL}/health`);
    check('the real fathom-server answers GET /health', health.status === 200, String(health.status));
  } catch (error) {
    console.log(serverLog.slice(-4000));
    throw error;
  }

  const { chromium } = await import(PLAYWRIGHT);
  const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const tab = await context.newPage();
  await applyDriveCpuThrottle(tab);
  tab.on('console', (m) => { if (m.type() === 'error') console.log('[console error] ' + m.text()); });
  tab.on('pageerror', (e) => console.log('[pageerror] ' + e));

  try {
    await runDrive(tab);
  } catch (error) {
    console.log(serverLog.slice(-6000));
    throw error;
  } finally {
    await browser.close();
  }
}

async function runDrive(tab) {
  await tab.bringToFront();

  // -------------------------------------------------------------------
  // 1. First run with the setup password: Welcome screen, password,
  //    authenticator app, recovery codes.
  // -------------------------------------------------------------------
  await tab.goto(`${SERVER_URL}/`, { waitUntil: 'networkidle' });
  await tab.waitForSelector('#firstrun-token', { timeout: 15000 });
  const rendered = await tab.evaluate(() => (document.querySelector('#root')?.textContent ?? '').trim().length);
  check('1. first run: the Welcome screen rendered', rendered > 20, `${rendered} characters`);
  await tab.fill('#firstrun-token', SETUP_PASSWORD);
  await tab.click('form.signin__card button[type=submit]');

  await tab.waitForSelector('#firstrun-password', { timeout: 20000 });
  await tab.fill('#firstrun-password', CREDENTIAL);
  await tab.fill('#firstrun-password-again', CREDENTIAL);
  await tab.click('form.signin__card button[type=submit]');
  check('1. first run: the setup password opened the password screen', true);

  await tab.waitForSelector('.signin__section', { timeout: 25000 });
  if ((await tab.locator('[data-testid="totp-secret"]').count()) === 0) {
    await tab.click('.signin__section button.signin__submit');
  }
  await tab.waitForSelector('[data-testid="totp-secret"]', { timeout: 20000 });
  const spent = new Set();
  const secret = base32Decode((await tab.locator('[data-testid="totp-secret"]').innerText()).trim());
  await tab.fill('#account-code', await freshCode(secret, spent));
  await tab.click('form.signin__section:has(#account-code) button[type=submit]');

  await tab.waitForSelector('.authenticator__codes', { timeout: 25000 });
  await tab.locator('[role="checkbox"]').click();
  await tab.locator('.signin__section:has(.authenticator__codes) button.signin__submit').click();
  check('1. first run: the authenticator app is set up and its recovery codes saved', true);

  // -------------------------------------------------------------------
  // 2. Sign in — the flow's own final step, a verification code.
  // -------------------------------------------------------------------
  await tab.waitForSelector('#firstrun-code', { timeout: 20000 });
  await tab.fill('#firstrun-code', await freshCode(secret, spent));
  await tab.click('form.signin__card button[type=submit]');

  await tab.waitForSelector('.home', { timeout: 30000 });
  await tab.waitForTimeout(1000);
  check('2. sign in: the first run landed signed in, on Home', (await tab.locator('.home').count()) === 1);
  // The person who ran the first start runs the server, so Home offers them a
  // practice space (ADR-0069) and says having no organisation is fine, rather
  // than pushing them to claim one.
  check(
    '2. sign in: a fresh account belongs to no organisations yet, and Home says that is fine',
    (await tab.getByText("None. That's fine", { exact: false }).count()) === 1,
  );
  check(
    '2. sign in: Home does not push the person who runs the server to claim an organisation',
    (await tab.getByRole('button', { name: 'Claim an organisation' }).count()) === 0,
  );

  await tab.screenshot({ path: `${SHOTS}own-network-1-home.png` });

  // -------------------------------------------------------------------
  // 3. The card: beside the practice lab, the name filled in.
  // -------------------------------------------------------------------
  const card = tab.locator('[data-testid="own-network"]');
  check('3. Home offers "Start your own network" beside the practice lab', (await card.count()) === 1);
  check('3. the practice lab is still offered', (await tab.getByRole('button', { name: 'Open practice lab' }).count()) === 1);
  check('3. the name is filled in', (await tab.locator('#own-network-name').inputValue()) === 'Home network');
  const orgName = 'Weekend Lab';
  await tab.fill('#own-network-name', orgName);
  await card.getByRole('button', { name: 'Start drawing' }).click();

  // -------------------------------------------------------------------
  // 4. The recovery key, in the card; nothing made until it is saved.
  // -------------------------------------------------------------------
  await tab.waitForSelector('[data-testid="own-network-recovery-key"]', { timeout: 20000 });
  const keyText = (await tab.locator('[data-testid="own-network-recovery-key"]').innerText()).trim();
  check(
    '4. the recovery key shows in the card, in the grouped format',
    /^([A-Z2-7]{4}-){13}[A-Z2-7]{4}$/.test(keyText),
    `${keyText.split('-').length} groups`,
  );
  const go = card.getByRole('button', { name: 'Start drawing' });
  check('4. Start drawing waits until the key is saved', await go.isDisabled());
  await tab.screenshot({ path: `${SHOTS}own-network-2-key.png` });
  await card.locator('[role="checkbox"]').click();
  await go.click();

  // Admin may want the verification code first; the prompt shows in the card.
  const codeField = tab.locator('[data-testid="own-network"] #console-verification-code');
  await Promise.race([
    tab.locator('.drawing').waitFor({ timeout: 30000 }),
    codeField.waitFor({ timeout: 30000 }),
  ]);
  if ((await tab.locator('.drawing').count()) === 0) {
    check('4. Admin asked for the verification code, in the card', (await codeField.count()) === 1);
    await codeField.fill(await freshCode(secret, spent));
    await codeField.press('Enter');
    await tab.waitForTimeout(1500);
    await tab.locator('[data-testid="own-network"]').getByRole('button', { name: 'Start drawing' }).click();
  }

  // -------------------------------------------------------------------
  // 5. Lands on an empty design in the new organisation.
  // -------------------------------------------------------------------
  await tab.locator('.drawing').waitFor({ timeout: 30000 });
  await tab.waitForTimeout(1500);
  check('5. an empty design of their own opened', (await tab.locator('.drawing').count()) === 1);
  check('5. the bar names the new organisation', (await tab.getByText(orgName, { exact: true }).count()) >= 1);
  await tab.screenshot({ path: `${SHOTS}own-network-3-design.png` });

  // -------------------------------------------------------------------
  // 6. Back on Home: listed as theirs, one design, the card gone.
  // -------------------------------------------------------------------
  await tab.getByText(orgName, { exact: true }).first().click();
  await tab.waitForSelector('.home', { timeout: 20000 });
  await tab.waitForTimeout(1500);
  check('6. Home lists it under Your organisations', (await tab.locator('.home__org-list').getByText(orgName).count()) === 1);
  check('6. the card is gone once they belong to an organisation', (await tab.locator('[data-testid="own-network"]').count()) === 0);
  check('6. it holds one design', (await tab.getByText('Untitled design').count()) >= 1);
  await tab.screenshot({ path: `${SHOTS}own-network-4-home-after.png` });
}

try {
  await main();
} catch (error) {
  failures += 1;
  console.error(error);
} finally {
  stopServer();
  psql(`DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE);`, { allowFailure: true });
  rmSync(work, { recursive: true, force: true });
}

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
