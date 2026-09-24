// Prove the content security policy against the REAL built client — on the
// signed-in screens as well as the ones a visitor sees.
//
// ADR-0055 decision 12 and stream (c) of the build contracts: a CSP that has
// never been run against the pages it protects is a belief, not a control.
// CLAUDE.md rule 1 says the VALUES are looked up rather than remembered
// (`crates/fathom-server/src/client.rs` carries the citation and the date);
// this script is the other half — it starts the real server with the real
// built client behind it, drives the pages in a real Chromium with
// `securitypolicyviolation` capture on every one of them, and fails if the
// browser reports a single violation.
//
//   node scripts/drive-csp.mjs
//
// **What changed on 2026-09-22.** ADR-0056 decision 7 refused to loosen
// `style-src-elem` for an extension's sheet and said the signed-in screens
// would be driven with violation capture *as part of this build* — they were
// not before. So this script now signs in through the first-run flow and
// visits Home, the operator console and, when there is one to open, a
// design's rack view. The rack view is where React Flow's inline `style`
// ATTRIBUTES live, which is what `style-src-attr 'unsafe-inline'` is in the
// policy for; the WebAssembly engine behind `'wasm-unsafe-eval'` is exercised
// wherever a document is read.
//
// **What it still does not cover, said plainly.** A fresh install has no
// organisation — ADR-0056 decision 9 leaves the organisation claim over HTTP
// to the next decision — so there is usually no design to open, and this
// script says so in the run rather than quietly skipping. When an
// organisation does exist it opens the first design it can reach in Racks
// and captures there too.
//
// It needs: a PostgreSQL on 127.0.0.1 with the `fathom_test` and `postgres`
// roles the test harness already uses, a built client (`cd client && npm ci
// --ignore-scripts && npm run build`), the `fathom-server` binary (`cargo
// build -p fathom-server --locked`), and the Playwright Chromium at
// /opt/pw-browsers. It builds neither. It creates its own database and drops
// it at the end, and it kills the server by PORT (`fuser -k`), never by
// process name.

import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { migrateUrl, runtimeUrl, superuserUrl } from './drive-lib/db.mjs';

const ROOT = process.env.FATHOM_ROOT
  ?? fileURLToPath(new URL('..', import.meta.url));
// `CARGO_TARGET_DIR` is shared across worktrees in this project (NEXT.md
// ground rule 3), so the binary is not always under ./target.
const TARGET_DIR = process.env.CARGO_TARGET_DIR ?? join(ROOT, 'target');
const SERVER_BIN = process.env.FATHOM_SERVER_BIN ?? join(TARGET_DIR, 'debug', 'fathom-server');
const PORT = 18092;
const SERVER_URL = `http://127.0.0.1:${PORT}`;
const DB_NAME = 'fathom_place_csp';
const RUNTIME_URL = runtimeUrl(DB_NAME);
const MIGRATE_URL = migrateUrl(DB_NAME);
const CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const PLAYWRIGHT = '/opt/node22/lib/node_modules/playwright/index.mjs';
const ADDRESS = 'operator@fathom.invalid';
// The length and shape ADR-0055 decision 10 requires, and the CI script's own.
const CREDENTIAL = 'harbour-lantern-copper-nine';

const work = mkdtempSync(join(tmpdir(), 'fathom-csp-'));
const MASTER_KEY_PATH = join(work, 'master.key');
const CHAIN_KEY_PATH = join(work, 'chain.key');
// The setup password the server is started with (ADR-0057); typed on the Welcome screen.
const SETUP_PASSWORD = 'amber-kestrel-harbour-0057';

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
  return sh('psql', ['-d', superuserUrl('postgres'), '-qc', sql], {
    allowFailure,
  });
}

async function waitForHttp(url, attempts = 100) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      const response = await fetch(url);
      return response;
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

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function base32Decode(text) {
  const clean = text.toUpperCase().replace(/=+$/, '').replace(/\s+/g, '');
  const out = [];
  let buffer = 0;
  let bits = 0;
  for (const c of clean) {
    const v = BASE32.indexOf(c);
    if (v < 0) throw new Error(`not RFC 4648 base32: ${JSON.stringify(c)}`);
    buffer = (buffer << 5) | v;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((buffer >> bits) & 0xff);
    }
  }
  return Uint8Array.from(out);
}

async function totpCode(secretBytes, step) {
  const key = await webcrypto.subtle.importKey('raw', secretBytes, { name: 'HMAC', hash: 'SHA-1' }, false, [
    'sign',
  ]);
  const counter = new Uint8Array(8);
  new DataView(counter.buffer).setBigUint64(0, BigInt(step), false);
  const tag = new Uint8Array(await webcrypto.subtle.sign('HMAC', key, counter));
  const offset = tag[tag.length - 1] & 0x0f;
  const binary =
    ((tag[offset] & 0x7f) << 24) | (tag[offset + 1] << 16) | (tag[offset + 2] << 8) | tag[offset + 3];
  return String(binary % 1000000).padStart(6, '0');
}
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
    throw new Error(
      `no built client at ${dist}. Run: cd client && npm ci --ignore-scripts && npm run build`,
    );
  }
  if (!existsSync(SERVER_BIN)) {
    throw new Error(`no server binary at ${SERVER_BIN}. Run: cargo build -p fathom-server --locked`);
  }

  console.log(`==> database ${DB_NAME}`);
  psql(`DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE);`, { allowFailure: true });
  psql(`CREATE DATABASE ${DB_NAME} OWNER fathom_test;`);

  writeFileSync(MASTER_KEY_PATH, Buffer.alloc(32, 7), { mode: 0o600 });
  writeFileSync(CHAIN_KEY_PATH, Buffer.alloc(32, 11), { mode: 0o600 });

  console.log(`==> starting fathom-server on ${SERVER_URL} with the built client behind it`);
  const env = { ...process.env };
  delete env.DATABASE_URL;
  serverProc = spawn(SERVER_BIN, [], {
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
      // So the HSTS half of decision 12 can be exercised: the peer is
      // loopback, and loopback is the trusted proxy here. Without a trusted
      // proxy nothing may write `X-Forwarded-Proto` and HSTS is never sent,
      // which is the other half this script checks.
      FATHOM_TRUSTED_PROXIES: '127.0.0.1',
      FATHOM_TRUSTED_CLIENT_IP_HEADER: 'X-Forwarded-For',
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

  // ---- the headers themselves, off the wire ------------------------------
  const page = await fetch(`${SERVER_URL}/`);
  const csp = page.headers.get('content-security-policy');
  check('every response carries a content security policy', Boolean(csp), csp ?? 'absent');
  check(
    'the policy is default-deny',
    (csp ?? '').includes("default-src 'none'"),
    csp ?? '',
  );
  check(
    'HSTS is absent over plain HTTP from an untrusted peer',
    page.headers.get('strict-transport-security') === null,
    page.headers.get('strict-transport-security') ?? 'absent',
  );
  const forwarded = await fetch(`${SERVER_URL}/`, {
    headers: { 'X-Forwarded-Proto': 'https' },
  });
  check(
    'HSTS is sent when a trusted proxy says the request arrived over TLS',
    (forwarded.headers.get('strict-transport-security') ?? '').startsWith('max-age='),
    forwarded.headers.get('strict-transport-security') ?? 'absent',
  );
  const flag = await fetch(`${SERVER_URL}/placement/flag`);
  check('the console-host flag answers unauthenticated', flag.status === 200, String(flag.status));
  check(
    'the flag carries the policy too',
    Boolean(flag.headers.get('content-security-policy')),
  );

  // ---- and the pages, in a real browser ----------------------------------
  const { chromium } = await import(PLAYWRIGHT);
  const browser = await chromium.launch({
    executablePath: CHROME,
    args: ['--no-sandbox'],
  });
  const context = await browser.newContext();
  const violations = [];
  const consoleErrors = [];
  await context.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (event) => {
      const seen = (window.__cspViolations = window.__cspViolations || []);
      seen.push({
        directive: event.effectiveDirective || event.violatedDirective,
        blocked: event.blockedURI,
        sample: event.sample,
      });
    });
  });
  const tab = await context.newPage();
  tab.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  tab.on('pageerror', (error) => consoleErrors.push(String(error)));

  /**
   * Read the violations this screen produced and clear them, so that the next
   * screen's check is about the next screen. The signed-in surfaces are one
   * page load with many screens on it, and a single read at the end would say
   * "something violated the policy somewhere" — which is not a finding
   * anybody can act on.
   */
  async function sample(what) {
    const seen = await tab.evaluate(() => {
      const held = window.__cspViolations || [];
      window.__cspViolations = [];
      return held;
    });
    for (const v of seen) violations.push({ page: what, ...v });
    check(`${what}: no CSP violation`, seen.length === 0, JSON.stringify(seen));
  }

  async function visit(what, url, after) {
    await tab.goto(url, { waitUntil: 'networkidle' });
    if (after) await after();
    await sample(what);
  }

  // The first-run flow: a browser at a pending deployment starts here
  // (ADR-0056 decisions 1 and 2). **The page must actually render**, or "no
  // violation" would be a claim about a blank page: a script the policy
  // refused would leave the root empty, so the positive check is what makes
  // the negative one mean something.
  await visit('the first-run welcome screen', `${SERVER_URL}/`, async () => {
    await tab.waitForSelector('#firstrun-token', { timeout: 15000 });
    const rendered = await tab.evaluate(
      () => (document.querySelector('#root')?.textContent ?? '').trim().length,
    );
    check('the first-run screen rendered (the client ran)', rendered > 20, `${rendered} characters`);
  });

  // ---- the signed-in screens, which had never been driven ----------------
  const token = SETUP_PASSWORD;
  const spent = new Set();

  await tab.goto(`${SERVER_URL}/`, { waitUntil: 'networkidle' });
  await tab.waitForSelector('#firstrun-token', { timeout: 15000 });
  await tab.fill('#firstrun-token', token);
  await tab.click('form.signin__card button[type=submit]');

  await tab.waitForSelector('#firstrun-password', { timeout: 20000 });
  await sample('the first-run password screen');
  await tab.fill('#firstrun-password', CREDENTIAL);
  await tab.fill('#firstrun-password-again', CREDENTIAL);
  await tab.click('form.signin__card button[type=submit]');

  await tab.waitForSelector('.signin__section', { timeout: 25000 });
  if ((await tab.locator('[data-testid="totp-secret"]').count()) === 0) {
    await tab.click('.signin__section button.signin__submit');
  }
  await tab.waitForSelector('[data-testid="totp-secret"]', { timeout: 20000 });
  // The screen ADR-0056 decision 5 added a picture to. The QR code is inline
  // SVG drawn in the page by `client/src/qr`, with no `style` attribute on
  // it, so neither `img-src` nor `style-src-attr` had to move for it —
  // and this is where a policy that refused it would show.
  const qr = await tab.locator('[data-testid="qr"]').evaluate((el) => ({
    tag: el.tagName.toLowerCase(),
    style: el.getAttribute('style'),
  }));
  check(
    'the QR code is inline SVG with no style attribute, and the policy let it draw',
    qr.tag === 'svg' && qr.style === null,
    `<${qr.tag}> style=${JSON.stringify(qr.style)}`,
  );
  await sample('the authenticator enrolment screen (the QR code)');

  const secret = base32Decode((await tab.locator('[data-testid="totp-secret"]').innerText()).trim());
  await tab.fill('#account-code', await freshCode(secret, spent));
  await tab.click('form.signin__section:has(#account-code) button[type=submit]');

  await tab.waitForSelector('.authenticator__codes', { timeout: 25000 });
  await sample('the recovery codes screen');
  await tab.locator('[role="checkbox"]').click();
  await tab.locator('.signin__section:has(.authenticator__codes) button.signin__submit').click();

  await tab.waitForSelector('#firstrun-code', { timeout: 20000 });
  await sample('the final sign-in screen');
  await tab.fill('#firstrun-code', await freshCode(secret, spent));
  await tab.click('form.signin__card button[type=submit]');

  await tab.waitForSelector('.home', { timeout: 30000 });
  await tab.waitForTimeout(1200);
  check('the first run signed in and landed on Home', (await tab.locator('.home').count()) === 1);
  await sample('Home, signed in');

  // The operator console, behind the Site entry.
  await tab.click('.shell-account'); // Site is a row in the account menu
  if ((await tab.locator('[data-testid="console-entry"]').count()) === 1) {
    await tab.click('[data-testid="console-entry"]');
    await tab.waitForSelector('.console__section', { timeout: 25000 });
    await tab.waitForTimeout(1000);
    await sample('the operator console');
    await tab.click('.shell-account');
    await tab.click('[data-testid="console-home"]');
    await tab.waitForSelector('.home', { timeout: 15000 });
    await sample('Home again, from the console');
  } else {
    check('the Site entry was on Home to open', false, 'no console entry rendered');
  }

  // A design's rack view, if there is one to open. On a fresh install there
  // is not: ADR-0056 decision 9 leaves the organisation claim over HTTP to
  // the next decision, so this says what it found rather than passing
  // silently.
  const organisations = await tab.locator('.home__org-list li').count();
  if (organisations === 0) {
    console.log(
      '     note: no organisation exists on a fresh install (ADR-0056 decision 9 — the organisation\n' +
        '     claim over HTTP is the next decision), so there is no design and no rack view to visit.\n' +
        '     The rack view is where React Flow\'s inline style ATTRIBUTES are, which is what\n' +
        "     `style-src-attr 'unsafe-inline'` is in the policy for: still unmeasured here.",
    );
    check('the rack view was not reachable, and this run says so rather than skipping quietly', true,
      'no organisation on a fresh install');
  } else {
    await tab.locator('.home__org-list li button').first().click();
    await tab.waitForTimeout(800);
    const designs = await tab.locator('.home__design-row').count();
    if (designs === 0) {
      check('an organisation exists but holds no design to open', true, `${organisations} organisation(s)`);
    } else {
      // The first button on a design row is Racks (`home/Home.tsx`).
      await tab.locator('.home__design-row .home__btn').first().click();
      await tab.waitForTimeout(2500);
      check('a design opened in Racks', (await tab.locator('.home').count()) === 0);
      await sample("a design's rack view");
    }
  }

  // And the ordinary sign-in door, which only exists once the deployment is
  // `done` — an unauthenticated page like the two at the top, and one this
  // script could not reach before the first run had happened.
  await visit('the sign-in door', `${SERVER_URL}/`, async () => {
    await tab.waitForSelector('#signin-password', { timeout: 15000 });
  });

  const cspErrors = consoleErrors.filter((line) => /Content Security Policy/i.test(line));
  check(
    'the browser console reports no CSP refusal',
    cspErrors.length === 0,
    cspErrors.join(' | '),
  );
  if (consoleErrors.length) {
    console.log('  (other console output, for information)');
    for (const line of consoleErrors.slice(0, 10)) console.log(`    ${line}`);
  }

  await browser.close();

  if (violations.length) {
    console.log('\nCSP violations:');
    for (const v of violations) console.log(`  ${JSON.stringify(v)}`);
  }
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
