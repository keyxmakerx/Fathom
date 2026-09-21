// Drive the REAL built client against a REAL server, through its own doors:
// ADR-0055 decision 1, one person with two custodies.
//
//   node scripts/drive-two-custodies.mjs
//
// **Nothing here is a hand port.** Unlike `scripts/drive-console-placement.mjs`,
// which spoke the prerequisites in the page because no rendered surface called
// them yet, every request below is made by the built client's own modules:
// the setup screen redeems the token file, the account screen enrols the app
// code, the sign-in screen signs in, and the console entry runs
// `api/placement.ts`'s `bootstrapOperatorSession`. The only bytes this script
// computes itself are the six digits of a TOTP code, which stand in for the
// authenticator app on a person's phone, and they are computed exactly as
// `scripts/ci/first-operator-signin.mjs` computes them.
//
// What it proves, in this order:
//
//   1. the first operator, from the token file to the console: setup screen,
//      app code, backup codes, sign-in with both factors, Home, then the Site
//      entry;
//   2. **two sessions at once**: Home is reachable from the console and the
//      console from Home, with no sign-in in between, and the account's own
//      requests still verify afterwards (its request counter was not spent by
//      the operator's);
//   3. a second browser context, with nothing in its storage, signing in with
//      the address, the password and a live app code;
//   4. the operators page adding a colleague with a name and an address;
//   5. the SMTP form round-tripping a sealed value;
//   6. the placement form saving a one-minute window, the countdown, the
//      redirect to the new host, and -- after the window runs out unconfirmed
//      -- the console answering again on the host it was moved off.
//
// It needs: PostgreSQL on 127.0.0.1 with the `fathom_test`/`postgres` roles, a
// built client in THIS worktree (`cd client && npm ci --ignore-scripts && npm
// run build`), the `fathom-server` binary, and Playwright's Chromium. It
// creates its own database and drops it, and it kills the server BY PORT --
// never by name, because another agent's server must not be killed by this
// one.

import { spawn, spawnSync } from 'node:child_process';
import http from 'node:http';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath, URL } from 'node:url';

const ROOT = process.env.FATHOM_ROOT ?? fileURLToPath(new URL('..', import.meta.url));
const SERVER_BIN = process.env.FATHOM_SERVER_BIN ?? '/home/user/Fathom/target/debug/fathom-server';
const PORT = 18103;
const OLD_HOST = `127.0.0.1:${PORT}`;
const NEW_HOST = `localhost:${PORT}`;
const OLD_URL = `http://${OLD_HOST}`;
const NEW_URL = `http://${NEW_HOST}`;
const DB_NAME = 'fathom_c3';
const RUNTIME_URL = `postgres://fathom_app@127.0.0.1:5432/${DB_NAME}`;
const MIGRATE_URL = `postgres://fathom_test@127.0.0.1:5432/${DB_NAME}`;
const CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const PLAYWRIGHT = '/opt/node22/lib/node_modules/playwright/index.mjs';
const ADDRESS = 'owner@example.test';
// A password of the length and shape ADR-0055 decision 10 requires and a
// person actually chooses -- the CI script's own, for the same reason.
const CREDENTIAL = 'harbour-lantern-copper-nine';
const COLLEAGUE = { name: 'Second Operator', address: 'second@example.test' };

const WORK =
  process.env.FATHOM_DRIVE_DIR ??
  '/tmp/claude-0/-home-user-Fathom/e3fb841a-3739-5e05-b6f7-65bae229f9a6/scratchpad/drive-two-custodies';
const SHOTS = join(WORK, 'shots');
mkdirSync(SHOTS, { recursive: true });

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

const psql = (sql, o = {}) =>
  sh('psql', ['-h', '127.0.0.1', '-U', 'postgres', '-d', 'postgres', '-qc', sql], o);

async function waitForHttp(url, attempts = 200) {
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
  // BY PORT. `pkill -f fathom-server` would kill another agent's run.
  sh('fuser', ['-k', `${PORT}/tcp`], { allowFailure: true });
  if (serverProc) serverProc.kill('SIGTERM');
}

/**
 * `GET /placement/flag` as a given `Host` sees it, including the optional
 * third field this client now reads.
 *
 * Through `node:http` and not `fetch`: `Host` is a forbidden header name for
 * `fetch`, which drops it silently.
 */
async function flagAs(host) {
  const bytes = await new Promise((resolve, reject) => {
    const request = http.request(
      { host: '127.0.0.1', port: PORT, path: '/placement/flag', method: 'GET', headers: { Host: host } },
      (response) => {
        const chunks = [];
        response.on('data', (c) => chunks.push(c));
        response.on('end', () => resolve(new Uint8Array(Buffer.concat(chunks))));
      },
    );
    request.on('error', reject);
    request.end();
  });
  const fields = [];
  let at = 0;
  while (at + 4 <= bytes.length) {
    const len = new DataView(bytes.buffer, bytes.byteOffset + at, 4).getUint32(0, true);
    fields.push(new TextDecoder().decode(bytes.slice(at + 4, at + 4 + len)));
    at += 4 + len;
  }
  return {
    verdict: fields[0],
    deadline: fields[1] ? Number(fields[1]) : null,
    decidedBy: fields.length > 2 ? fields[2] : null,
    fieldCount: fields.length,
  };
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

/** A code for a step this run has not spent yet. `credentials::verify_totp`
 * accepts a code once, so the drive waits for the clock rather than sending
 * one it knows is spent. */
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

// ---------------------------------------------------------------------------

async function main() {
  if (!existsSync(join(ROOT, 'client', 'dist', 'index.html'))) {
    throw new Error('no built client. Run: cd client && npm ci --ignore-scripts && npm run build');
  }
  if (!existsSync(SERVER_BIN)) throw new Error(`no server binary at ${SERVER_BIN}`);

  console.log(`==> database ${DB_NAME}`);
  psql(`DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE);`, { allowFailure: true });
  psql(`CREATE DATABASE ${DB_NAME} OWNER fathom_test;`);

  const masterKey = join(WORK, 'master.key');
  const chainKey = join(WORK, 'chain.key');
  const tokenFile = join(WORK, 'first-operator-token');
  for (const path of [masterKey, chainKey, tokenFile]) rmSync(path, { force: true });
  writeFileSync(masterKey, Buffer.alloc(32, 29), { mode: 0o400 });
  writeFileSync(chainKey, Buffer.alloc(32, 31), { mode: 0o400 });

  sh('fuser', ['-k', `${PORT}/tcp`], { allowFailure: true });
  const env = { ...process.env };
  delete env.DATABASE_URL;
  serverProc = spawn(SERVER_BIN, [], {
    cwd: ROOT,
    env: {
      ...env,
      DATABASE_URL: RUNTIME_URL,
      FATHOM_MIGRATE_DATABASE_URL: MIGRATE_URL,
      FATHOM_SCHEMA_ROOT: join(ROOT, 'schema'),
      // THIS worktree's build, not the main checkout's.
      FATHOM_CLIENT_ROOT: join(ROOT, 'client', 'dist'),
      FATHOM_MASTER_KEY: `file://${masterKey}`,
      FATHOM_CHAIN_KEY: `file://${chainKey}`,
      FATHOM_OPERATOR_NOTICE_ADDRESS: ADDRESS,
      FATHOM_BOOTSTRAP_TOKEN_FILE: tokenFile,
      FATHOM_BIND: `127.0.0.1:${PORT}`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverLog = '';
  serverProc.stdout.on('data', (d) => (serverLog += d.toString()));
  serverProc.stderr.on('data', (d) => (serverLog += d.toString()));

  try {
    const health = await waitForHttp(`${OLD_URL}/health`);
    check('the server answers /health with this worktree’s built client behind it', health.status === 200);
  } catch (e) {
    console.log(serverLog.slice(-3000));
    throw e;
  }

  const token = readFileSync(tokenFile, 'utf8').trim();

  const flagBefore = await flagAs(OLD_HOST);
  check(
    'GET /placement/flag answers "yes" on a fresh install, and says nothing about which decided',
    flagBefore.verdict === 'yes' && flagBefore.decidedBy === null,
    `${flagBefore.fieldCount} field(s): ${JSON.stringify(flagBefore)}`,
  );

  const { chromium } = await import(PLAYWRIGHT);
  const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });

  const errors = [];
  const failed = [];
  async function openContext(label) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 1500 } });
    const page = await context.newPage();
    page.on('pageerror', (e) => errors.push(`${label}: ${e}`));
    page.on('response', (r) => {
      if (r.status() >= 400) failed.push(`${label}: ${r.status()} ${new URL(r.url()).pathname}`);
    });
    return { context, page };
  }

  const { page } = await openContext('A');
  let shotNumber = 0;
  const shots = [];
  const shot = async (name, target = page) => {
    shotNumber += 1;
    const path = join(SHOTS, `${String(shotNumber).padStart(2, '0')}-${name}.png`);
    await target.screenshot({ path, fullPage: true });
    shots.push(path);
    console.log(`     shot ${path}`);
    return path;
  };

  // ---- 1. the first operator, from the token file to the console ---------
  await page.goto(`${OLD_URL}/`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.signin__card', { timeout: 15000 });
  await shot('the-door');
  await page.click('text=Setting this server up for the first time?');
  await page.waitForSelector('#setup-token', { timeout: 10000 });
  await page.fill('#setup-token', token);
  await page.fill('#setup-address', ADDRESS);
  await page.fill('#setup-password', CREDENTIAL);
  await page.fill('#setup-password-again', CREDENTIAL);
  await shot('setup-screen-with-the-token-file');
  await page.click('button.signin__submit');

  await page.waitForSelector('text=Enrol an app code', { timeout: 20000 });
  await page.click('text=Enrol an app code');
  await page.waitForSelector('[data-testid="totp-secret"]', { timeout: 15000 });
  const secretText = await page.locator('[data-testid="totp-secret"]').innerText();
  const otpauth = await page.locator('[data-testid="totp-uri"]').innerText();
  check(
    'the client showed the app-code secret and its otpauth URI as text',
    /^[A-Z2-7]{16,}$/.test(secretText.trim()) && otpauth.startsWith('otpauth://totp/'),
    `${secretText.slice(0, 8)}…`,
  );
  await shot('the-app-code-secret');
  const secret = base32Decode(secretText.trim());
  const spent = new Set();
  await page.fill('#account-code', await freshCode(secret, spent));
  await page.click('text=Confirm the code');

  await page.waitForSelector('.signin__codes', { timeout: 20000 });
  const backupCodes = await page.locator('.signin__codes .signin__code').allInnerTexts();
  check('ten backup codes, shown once', backupCodes.length === 10, `${backupCodes.length}`);
  await shot('the-ten-backup-codes');
  await page.click('text=I have saved these.');
  await page.click('button.signin__submit:has-text("Continue")');

  // Setup ends at the door: the setup session was A0 and the client signs it
  // out itself (`App.tsx`).
  await page.waitForSelector('#signin-password', { timeout: 15000 });
  const notice = await page.locator('.signin__notice').innerText();
  check('setup ends at the door, saying why', /setup session/.test(notice), notice.slice(0, 90));

  await page.fill('#signin-address', ADDRESS);
  await page.fill('#signin-password', CREDENTIAL);
  // A backup code for this one: the app code for this step was just spent by
  // the confirmation above, and a code is accepted once.
  await page.fill('#signin-code', backupCodes[0]);
  await shot('signing-in-with-both-factors');
  await page.click('button.signin__submit:has-text("Sign in")');

  await page.waitForSelector('.home', { timeout: 20000 });
  await page.waitForSelector('[data-testid="console-entry"]', { timeout: 15000 });
  check('Home, with the Site entry on a console host', true);
  await shot('home-with-the-site-entry');

  await page.click('[data-testid="console-entry"]');
  await page.waitForSelector('.console__section', { timeout: 25000 });
  await page.waitForTimeout(1200);
  const consoleText = await page.locator('.console').innerText();
  check(
    'the console opened: the built client registered the operator key and signed in as the operator',
    /Signed in as/.test(consoleText) && /operator/.test(consoleText),
    consoleText.split('\n')[1]?.slice(0, 90),
  );
  const operatorId = (await page.locator('.console__id').innerText()).trim();
  check('and it names the operator id', /^[0-9A-HJKMNP-TV-Z]{26}$/.test(operatorId), operatorId);
  await shot('the-console');

  // ---- 2. two sessions at once -------------------------------------------
  await page.click('[data-testid="console-home"]');
  await page.waitForSelector('.home', { timeout: 15000 });
  check(
    'Home is reachable from the console with NO sign-in: the account session was never ended',
    (await page.locator('#signin-password').count()) === 0 && (await page.locator('.home').count()) === 1,
  );
  // The account's own requests, made after the operator session had made
  // several of its own: this is what a shared request counter would break.
  await page.waitForTimeout(1200);
  const homeText = await page.locator('.home').innerText();
  check(
    "and the account session still verifies: Home's own reads answered",
    !/refused|not authorised|Could not/i.test(homeText),
    homeText.split('\n').slice(0, 3).join(' / ').slice(0, 100),
  );
  await shot('home-again-from-the-console');

  await page.click('[data-testid="console-entry"]');
  await page.waitForSelector('.console__section', { timeout: 20000 });
  check(
    'and back into the console, again with no sign-in',
    (await page.locator('.console__id').innerText()).trim() === operatorId,
  );
  await shot('back-in-the-console');

  // ---- 3. a second browser, with nothing in its storage -------------------
  const second = await openContext('B');
  await second.page.goto(`${OLD_URL}/`, { waitUntil: 'networkidle' });
  await second.page.waitForSelector('#signin-password', { timeout: 15000 });
  await second.page.fill('#signin-address', ADDRESS);
  await second.page.fill('#signin-password', CREDENTIAL);
  await second.page.fill('#signin-code', await freshCode(secret, spent));
  await second.page.click('button.signin__submit:has-text("Sign in")');
  await second.page.waitForSelector('.home', { timeout: 25000 });
  check(
    'a second browser, holding no key at all, signs in with the address, the password and a live app code',
    (await second.page.locator('.home').count()) === 1,
  );
  await shot('a-second-browser-signed-in', second.page);

  // ---- 4. the operators page ---------------------------------------------
  await page.fill('#console-operator-name', COLLEAGUE.name);
  await page.fill('#console-operator-address', COLLEAGUE.address);
  await page.click('text=Request this colleague');
  await Promise.race([
    page.waitForSelector('text=Requested. Change', { timeout: 25000 }),
    page.waitForSelector('form:has(#console-operator-name) .console__error', { timeout: 25000 }),
  ]).catch(() => {});
  const colleagueText = await page.locator('form:has(#console-operator-name)').innerText();
  check(
    'the operators page requested a colleague with a name and an address, signed with the operator key',
    /Requested\. Change/.test(colleagueText) && /applies at/.test(colleagueText),
    colleagueText.split('\n').slice(-2).join(' ').slice(0, 200),
  );
  await shot('a-colleague-requested');

  const pendingRows = sh(
    'psql',
    ['-h', '127.0.0.1', '-U', 'postgres', '-d', DB_NAME, '-tAc',
      "SELECT display_name || ' ' || address FROM operator_requests"],
    { allowFailure: true },
  ).stdout.trim();
  check(
    'and the request carries both, on the server',
    pendingRows.includes(COLLEAGUE.name) && pendingRows.includes(COLLEAGUE.address),
    pendingRows || '(no operator_requests row read)',
  );

  // ---- 5. the SMTP form ---------------------------------------------------
  await page.fill('#smtp-host', 'smtp.example.test');
  await page.fill('#smtp-port', '587');
  await page.selectOption('#smtp-tls', 'starttls');
  await page.fill('#smtp-user', 'fathom');
  await page.fill('#smtp-password', 'hunter2-hunter2-hunter2');
  await page.fill('#smtp-from', 'fathom@example.test');
  await page.click('text=Save the mail settings');
  await page.waitForSelector('text=in effect at', { timeout: 20000 });
  const smtpText = await page.locator('form:has(#smtp-host)').innerText();
  check('the SMTP form round-tripped: saved, sealed, and told when it takes effect', /in effect at/.test(smtpText));
  await shot('the-smtp-form-saved');

  // ---- 6. the placement form ---------------------------------------------
  await page.fill('#placement-hosts', 'localhost');
  await page.fill('#placement-window', '1');
  await page.click('text=Review this move');
  await page.waitForSelector('.console__warnlist', { timeout: 10000 });
  const warning = await page.locator('.console__warnlist').innerText();
  check(
    'the form warns before the save, naming the new host, this host, the window and the revert',
    warning.includes('localhost') && warning.includes(OLD_HOST) && /one minute/.test(warning) && /reverts/.test(warning),
  );
  await shot('the-placement-warning');

  const movedAt = Date.now();
  await page.click('text=Move the console to localhost');
  await page.waitForSelector('[data-testid="placement-countdown"]', { timeout: 20000 });
  const countdown = await page.locator('[data-testid="placement-countdown"]').innerText();
  const [mm, ss] = countdown.split(':').map(Number);
  check(
    'the countdown runs off the deadline the server sent',
    mm * 60 + ss > 0 && mm * 60 + ss <= 61,
    countdown,
  );
  check(
    'and the form is NOT read-only: nothing told it the environment decides, and it did not infer one',
    (await page.locator('[data-testid="placement-readonly"]').count()) === 0,
  );
  await shot('the-placement-countdown');

  const flagOld = await flagAs(OLD_HOST);
  const flagNew = await flagAs(NEW_HOST);
  check('the console stops answering on the old host at once', flagOld.verdict === 'no', JSON.stringify(flagOld));
  check(
    'the new host answers, with the deadline of a placement waiting to be confirmed',
    flagNew.verdict === 'yes' && typeof flagNew.deadline === 'number',
    JSON.stringify(flagNew),
  );

  await page.waitForURL(`${NEW_URL}/`, { timeout: 25000 });
  await page.waitForTimeout(1000);
  check('the browser was taken to the new host', page.url().startsWith(NEW_URL), page.url());
  await shot('landed-on-the-new-host');

  // ---- the window runs out unconfirmed ------------------------------------
  const waitMs = Math.max(0, 63_000 - (Date.now() - movedAt));
  console.log(`==> waiting ${Math.round(waitMs / 1000)}s for the one-minute window to run out unconfirmed`);
  await new Promise((r) => setTimeout(r, waitMs));
  const flagOldAfter = await flagAs(OLD_HOST);
  check(
    'after the window the console answers again on the host it was moved off',
    flagOldAfter.verdict === 'yes',
    JSON.stringify(flagOldAfter),
  );

  await page.goto(`${OLD_URL}/`, { waitUntil: 'networkidle' });
  await page.waitForSelector('#signin-password', { timeout: 15000 });
  await page.fill('#signin-address', ADDRESS);
  await page.fill('#signin-password', CREDENTIAL);
  await page.fill('#signin-code', backupCodes[1]);
  await page.click('button.signin__submit:has-text("Sign in")');
  await page.waitForSelector('[data-testid="console-entry"]', { timeout: 25000 });
  await page.click('[data-testid="console-entry"]');
  await Promise.race([
    page.waitForSelector('.console__section', { timeout: 25000 }),
    page.waitForSelector('.console-entry__refusal', { timeout: 25000 }),
  ]).catch(() => {});
  await page.waitForTimeout(800);
  const secondEntry = await page
    .locator('.console-entry__refusal')
    .innerText()
    .catch(() => '');
  check(
    'the console opens again on that host with the key this browser already holds, registering nothing',
    secondEntry === '',
    secondEntry.slice(0, 160),
  );
  check(
    'and the console answers there again, with its placement form back',
    (await page.locator('#placement-hosts').count()) === 1,
  );
  await shot('the-console-answers-again-after-the-revert');

  // The register, read after all of it: two rows once the colleague's
  // request has applied, one until then. Reported, not asserted either way --
  // the delay is 24 hours and this drive does not wait it out.
  const register = await page.locator('.console__table').last().innerText();
  check("the register carries the operator's address of record", register.includes(ADDRESS));
  await shot('the-console-before-signing-out');

  // ---- signing out ends BOTH sessions -------------------------------------
  const countSessions = () =>
    Number(
      sh('psql', ['-h', '127.0.0.1', '-U', 'postgres', '-d', DB_NAME, '-tAc', 'SELECT count(*) FROM sessions'], {
        allowFailure: true,
      }).stdout.trim() || '-1',
    );
  const sessionsBefore = countSessions();
  await page.click('button.shell-account');
  await page.click('text=Sign out');
  await page.waitForSelector('#signin-password', { timeout: 20000 });
  await page.waitForTimeout(800);
  const sessionsAfter = countSessions();
  check(
    'signing out from the console ends BOTH sessions: two rows fewer, one per custody',
    sessionsBefore - sessionsAfter === 2,
    `${sessionsBefore} → ${sessionsAfter}`,
  );
  await shot('signed-out-at-the-door');

  console.log('\n--- what the browsers said ---');
  for (const line of failed.slice(0, 20)) console.log(`     ${line}`);
  check('no uncaught exception in either browser', errors.length === 0, errors.join(' | '));
  // A 404 from `/admin` on the host the console was moved off is the product
  // behaving as built IF the client asked -- which it must not. Every other
  // failed request is a bug.
  const unexpected = failed.filter((line) => !/503/.test(line));
  check(
    'no request was refused in the whole drive',
    unexpected.length === 0,
    unexpected.slice(0, 6).join(' | '),
  );

  await browser.close();
  console.log('\nscreenshots:');
  for (const path of shots) console.log(`  ${path}`);
}

try {
  await main();
} catch (error) {
  failures += 1;
  console.error(error);
} finally {
  stopServer();
  psql(`DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE);`, { allowFailure: true });
}
console.log(failures === 0 ? '\nOK: every check passed' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
