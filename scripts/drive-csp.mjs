// Prove the content security policy against the REAL built client.
//
// ADR-0055 decision 12 and stream (c) of the build contracts: a CSP that has
// never been run against the pages it protects is a belief, not a control.
// CLAUDE.md rule 1 says the VALUES are looked up rather than remembered
// (`crates/fathom-server/src/client.rs` carries the citation and the date);
// this script is the other half — it starts the real server with the real
// built client behind it, drives the pages an unauthenticated visitor sees
// with a real Chromium, and fails if the browser reports one CSP violation.
//
//   node scripts/drive-csp.mjs
//
// **What this does NOT cover, said plainly rather than left to be assumed.**
// The pages an unauthenticated visitor sees are the enrolment door, the
// sign-in form and the static port gallery, and those are what this drives.
// The rack view — React Flow, whose inline `style` ATTRIBUTES are why
// `style-src-attr 'unsafe-inline'` is in the policy — and the WebAssembly
// engine — why `'wasm-unsafe-eval'` is — are both behind a signed-in session,
// and neither is exercised here. Both allowances come from the specification
// rather than from a run (the citations are in `client.rs`), and the honest
// next step is for `scripts/drive-first-design.mjs`, which already signs in
// and draws, to serve from the BUILT client and assert the same thing.
//
// It needs: a PostgreSQL on 127.0.0.1 with the `fathom_test` and `postgres`
// roles the test harness already uses, a built client (`cd client && npm ci
// --ignore-scripts && npm run build`), and the Playwright Chromium at
// /opt/pw-browsers. It creates its own database and drops it at the end, and
// it kills the server by PORT (`fuser -k`), never by process name.

import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, URL } from 'node:url';

const ROOT = process.env.FATHOM_ROOT
  ?? fileURLToPath(new URL('..', import.meta.url));
// `CARGO_TARGET_DIR` is shared across worktrees in this project (NEXT.md
// ground rule 3), so the binary is not always under ./target.
const TARGET_DIR = process.env.CARGO_TARGET_DIR ?? join(ROOT, 'target');
const PORT = 18092;
const SERVER_URL = `http://127.0.0.1:${PORT}`;
const DB_NAME = 'fathom_place_csp';
const RUNTIME_URL = `postgres://fathom_app@127.0.0.1:5432/${DB_NAME}`;
const MIGRATE_URL = `postgres://fathom_test@127.0.0.1:5432/${DB_NAME}`;
const CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const PLAYWRIGHT = '/opt/node22/lib/node_modules/playwright/index.mjs';

const work = mkdtempSync(join(tmpdir(), 'fathom-csp-'));
const MASTER_KEY_PATH = join(work, 'master.key');
const CHAIN_KEY_PATH = join(work, 'chain.key');
const BOOTSTRAP_TOKEN_PATH = join(work, 'bootstrap.token');

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
  return sh('psql', ['-h', '127.0.0.1', '-U', 'postgres', '-d', 'postgres', '-qc', sql], {
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

async function main() {
  const dist = join(ROOT, 'client', 'dist', 'index.html');
  if (!existsSync(dist)) {
    throw new Error(
      `no built client at ${dist}. Run: cd client && npm ci --ignore-scripts && npm run build`,
    );
  }

  console.log(`==> database ${DB_NAME}`);
  psql(`DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE);`, { allowFailure: true });
  psql(`CREATE DATABASE ${DB_NAME} OWNER fathom_test;`);

  writeFileSync(MASTER_KEY_PATH, Buffer.alloc(32, 7), { mode: 0o600 });
  writeFileSync(CHAIN_KEY_PATH, Buffer.alloc(32, 11), { mode: 0o600 });

  console.log('==> building fathom-server');
  sh('cargo', ['build', '-p', 'fathom-server'], { cwd: ROOT, stdio: 'inherit' });

  console.log(`==> starting fathom-server on ${SERVER_URL} with the built client behind it`);
  const env = { ...process.env };
  delete env.DATABASE_URL;
  serverProc = spawn(join(TARGET_DIR, "debug", "fathom-server"), [], {
    cwd: ROOT,
    env: {
      ...env,
      DATABASE_URL: RUNTIME_URL,
      FATHOM_MIGRATE_DATABASE_URL: MIGRATE_URL,
      FATHOM_SCHEMA_ROOT: `${ROOT}/schema`,
      FATHOM_MASTER_KEY: `file://${MASTER_KEY_PATH}`,
      FATHOM_CHAIN_KEY: `file://${CHAIN_KEY_PATH}`,
      FATHOM_OPERATOR_NOTICE_ADDRESS: 'operator@fathom.invalid',
      FATHOM_BOOTSTRAP_TOKEN_FILE: BOOTSTRAP_TOKEN_PATH,
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

  async function visit(what, url, after) {
    await tab.goto(url, { waitUntil: 'networkidle' });
    if (after) await after();
    const seen = await tab.evaluate(() => window.__cspViolations || []);
    for (const v of seen) violations.push({ page: what, ...v });
    check(`${what}: no CSP violation`, seen.length === 0, JSON.stringify(seen));
  }

  // The enrolment door: a browser holding no key starts here (App.tsx).
  // **The page must actually render**, or "no violation" would be a claim
  // about a blank page: a script the policy refused would leave the root
  // empty, so the positive check is what makes the negative one mean
  // something.
  await visit('the enrolment page', `${SERVER_URL}/`, async () => {
    await tab.waitForSelector('button', { timeout: 10000 });
    const rendered = await tab.evaluate(
      () => (document.querySelector('#root')?.textContent ?? '').trim().length,
    );
    check('the enrolment page rendered (the client ran)', rendered > 20, `${rendered} characters`);
  });
  // ...and the sign-in page behind its own button.
  await visit('the sign-in page', `${SERVER_URL}/`, async () => {
    const link = tab.locator('text=Already enrolled in this browser? Sign in.');
    if (await link.count()) {
      await link.first().click();
      await tab.waitForTimeout(250);
    }
  });
  // The static port gallery: a second built page, and the one that is all CSS.
  await visit('the port gallery', `${SERVER_URL}/ports.html`);

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

if (existsSync(BOOTSTRAP_TOKEN_PATH)) rmSync(BOOTSTRAP_TOKEN_PATH, { force: true });
console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
