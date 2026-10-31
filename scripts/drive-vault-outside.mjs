// Drives the REAL built client against the REAL server through outside vaults (ADR-0071 part four,
// mockup r32-vault-external): Bob connects his own Vaultwarden — a stand-in over HTTPS under a
// private CA, which the server trusts through FATHOM_OUTSIDE_VAULT_CA — after one refused attempt
// (an owner role fails the checks); his browser opens the organisation key with his master
// password; he lists and pulls two logins, one with its own item key. Ann, the admin, sees his
// connection, removes one login (Bob cannot undo it), stops the connection with a failed check
// when the account is given a second collection, and disconnects it. Cy connects a Delinea Secret
// Server (the same stand-in answers its calls) after one refused attempt (the account sees two
// folders), lists the folder's secrets and pulls one. Cy then sets up a Passbolt from its
// invitation link, through the REAL Passbolt helper (helpers/passbolt, over its socket): the
// stand-in Passbolt does its own OpenPGP through the same helper, so every message both ways is
// real OpenPGP. The connection waits until a folder and the metadata key are shared, then binds,
// lists and pulls. Then the database is swept for the master password, the API key's secret, the
// Secret Server account's password, Fathom's Passbolt private key and the passwords, which must
// appear nowhere.
//
//   node scripts/drive-vault-outside.mjs
//
// Needs what scripts/drive-vault.mjs needs (PostgreSQL with the test roles, a built client, the
// fathom-server binary, Playwright's Chromium) and `openssl`. The seed is drive-lib/seed_vault.rs.
// Screenshots: FATHOM_SHOTS (default /mnt/project-files/reviews/vault-outside/).

import { execFileSync, spawn } from 'node:child_process';
import { connect as connectSocket } from 'node:net';
import { createServer } from 'node:https';
import { copyFileSync, createWriteStream, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrateUrl, runtimeUrl } from './drive-lib/db.mjs';
import { makeAccount } from './drive-lib/bitwarden-account.mjs';
import { check, fails } from './drive-lib/kit.mjs';

const pw = await import(process.env.PW_PLAYWRIGHT || '/opt/node22/lib/node_modules/playwright/index.js');
const { chromium } = pw.default ?? pw;

const ROOT = process.env.FATHOM_ROOT || resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = process.env.PW_CHROMIUM || '/opt/pw-browsers/chromium';
const TARGET_DIR = process.env.CARGO_TARGET_DIR ?? resolve(ROOT, 'target');
const SERVER_BIN = process.env.FATHOM_SERVER_BIN ?? resolve(TARGET_DIR, 'debug', 'fathom-server');
const HELPER_BIN = resolve(ROOT, 'helpers/passbolt/target/debug/fathom-passbolt-helper');
const SHOTS = (process.env.FATHOM_SHOTS ?? '/mnt/project-files/reviews/vault-outside') + '/';
const WORK = process.env.FATHOM_DRIVE_DIR ?? join(process.env.TMPDIR ?? '/tmp', 'fathom-drive-vault-outside');
mkdirSync(SHOTS, { recursive: true });
mkdirSync(WORK, { recursive: true });

const PORT = 18194;
const VW_PORT = 18443;
const VW_URL = `https://localhost:${VW_PORT}`;
const URL_ = `http://127.0.0.1:${PORT}`;
const DB_NAME = 'fathom_test';
const MIGRATE_URL = migrateUrl(DB_NAME);
const RUNTIME_URL = runtimeUrl(DB_NAME);
const MASTER_KEY = join(WORK, 'master.key');
const CHAIN_KEY = join(WORK, 'chain.key');
const SEED_OUT = join(WORK, 'seed.json');
const CA_PEM = join(WORK, 'ca.pem');
const SEED_SRC = join(ROOT, 'scripts/drive-lib/seed_vault.rs');
const SEED_DST = join(ROOT, 'crates/fathom-server/tests/seed_vault.rs');
const SETUP_PASSWORD = 'amber-kestrel-harbour-0057';
const HELPER_SOCKET = join(WORK, 'passbolt-helper.sock');
const OPERATOR = 'operator@fathom.invalid';
const VIEWPORT = { width: 1440, height: 900 };

const PEOPLE = {
  ann: { address: 'ann.alder@acme.example', password: 'vault-drive-ann-sign-in-passphrase', vault: 'ann keeps the copper lantern lit', tag: 'ANN' },
  bob: { address: 'bob.birch@acme.example', password: 'vault-drive-bob-sign-in-passphrase', vault: 'bob rides the slow river barge', tag: 'BOB' },
  cy: { address: 'cy.cedar@acme.example', password: 'vault-drive-cy-sign-in-passphrase', vault: 'cy counts the quiet winter stars', tag: 'CY' },
};
/** Typed into the vault; none of these may reach the database in the clear. */
const OUTSIDE = {
  email: 'bob@home.example',
  master: 'bob-outside-master-password-kestrel',
  clientId: 'user.0d6c1f2e-8b4a-4f6e-9c3d-7a1b2c3d4e5f',
  secret: 'Vw8kQ2mN5pR7tX1zL4sH9dF3gJ6bC0',
  collection: 'fathom-7k2q',
  logins: [
    { id: '11111111-1111-4111-8111-111111111111', name: 'core-sw1 admin', username: 'admin', password: 'Core-Sw1-Outside-4417!' },
    { id: '22222222-2222-4222-8222-222222222222', name: 'edge-fw1 admin', username: 'netops', password: 'Edge-Fw1-Own-Key-9083!', ownKey: true },
  ],
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

async function until(fn, timeoutMs = 10000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    let v;
    try { v = await fn(); } catch { v = false; }
    if (v) return v;
    if (Date.now() > end) return false;
    await sleep(150);
  }
}

function resetSchema() {
  sh('psql', [MIGRATE_URL, '-qc', 'DROP SCHEMA IF EXISTS vault CASCADE; DROP SCHEMA public CASCADE; CREATE SCHEMA public;']);
}

let serverProc = null;
let vw = null;

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
      // Made on first start, as compose's db start would.
      FATHOM_VAULT_KEY: `file://${join(WORK, 'vault.key')}`,
      FATHOM_OPERATOR_NOTICE_ADDRESS: OPERATOR,
      FATHOM_SETUP_PASSWORD: SETUP_PASSWORD,
      FATHOM_BIND: `127.0.0.1:${PORT}`,
      // The stand-in's private CA, as an operator with a vault on a home network would set it.
      FATHOM_OUTSIDE_VAULT_CA: CA_PEM,
      // The optional Passbolt helper, as compose's `passbolt` profile would run it.
      FATHOM_PASSBOLT_HELPER: HELPER_SOCKET,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const logStream = createWriteStream(join(WORK, 'server.log'));
  serverProc.stdout.on('data', (d) => logStream.write(d));
  serverProc.stderr.on('data', (d) => logStream.write(d));
  const health = await waitForHttp(`${URL_}/health`);
  check('the real fathom-server answers GET /health', health.status === 200);
  const firstRun = await new Promise((res) => {
    spawn('node', [`${ROOT}/scripts/ci/first-operator-signin.mjs`, SETUP_PASSWORD, OPERATOR, URL_], { stdio: 'inherit' }).on('exit', res);
  });
  check('the operator finished first run', firstRun === 0, `exit ${firstRun}`);
  if (firstRun !== 0) throw new Error('first run did not complete');
}

async function signIn(page, who) {
  await page.goto(URL_, { waitUntil: 'domcontentloaded' });
  await page.locator('#signin-address').fill(who.address);
  await page.locator('#signin-password').fill(who.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.locator('.home, .drawing, .shell-bar').first().waitFor({ timeout: 20000 });
}

/** A member who is not an admin keeps their own vault under Home › Passwords. */
async function openMyPasswords(page) {
  await page.getByRole('tab', { name: 'Passwords' }).click();
  await page.getByTestId('vault-passwords').waitFor({ timeout: 15000 });
}

async function openAdminPasswords(page) {
  await page.getByRole('tab', { name: 'Steward' }).click();
  await page.getByTestId('rail-passwords').click();
  await page.locator('[data-testid="vault-admin"], [data-testid="vault-passwords"]').first().waitFor({ timeout: 15000 });
}

/** The whole setup: kit first, then the passphrase. Answers the kit's code as shown. */
async function setUpVault(page, who, shot) {
  await page.getByTestId('vault-setup-open').first().click();
  await page.getByTestId('vault-setup').waitFor();
  if (shot) await page.screenshot({ path: `${SHOTS}${shot}-1-intro.png` });
  await page.getByTestId('vault-setup-next').click();
  await page.getByTestId('vault-kit-sheet').waitFor();
  const code = (await page.getByTestId('vault-code').innerText()).replace(/\s+/g, '-');
  if (shot) await page.screenshot({ path: `${SHOTS}${shot}-2-kit.png` });
  check(`${who.tag}: Continue waits for "I have saved my Emergency Kit"`, await page.getByTestId('vault-setup-next').isDisabled());
  await page.getByTestId('vault-kit-saved').check();
  await page.getByTestId('vault-setup-next').click();
  await page.getByTestId('vault-new-passphrase').fill(who.vault);
  await page.getByTestId('vault-new-passphrase-again').fill(who.vault);
  if (shot) await page.screenshot({ path: `${SHOTS}${shot}-3-passphrase.png` });
  await page.getByTestId('vault-setup-finish').click();
  await page.getByTestId('vault-setup-done').waitFor({ timeout: 30000 });
  await page.getByTestId('vault-setup-done').click();
  return code;
}

/** A private CA and a certificate for `localhost` under it, made fresh for each run. */
function makeCerts() {
  const o = (args) => sh('openssl', args, { cwd: WORK, stdio: ['ignore', 'pipe', 'pipe'] });
  o(['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-days', '2', '-subj', '/CN=Fathom drive CA', '-keyout', 'ca.key', '-out', 'ca.pem', '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign']);
  o(['req', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-subj', '/CN=localhost', '-keyout', 'vw.key', '-out', 'vw.csr']);
  writeFileSync(join(WORK, 'vw.ext'), 'subjectAltName=DNS:localhost\nextendedKeyUsage=serverAuth\nbasicConstraints=CA:FALSE\n');
  o(['x509', '-req', '-in', 'vw.csr', '-CA', 'ca.pem', '-CAkey', 'ca.key', '-CAcreateserial', '-days', '2', '-extfile', 'vw.ext', '-out', 'vw.pem']);
}

/**
 * A stand-in Vaultwarden: the two calls Fathom makes, answered with an account sealed exactly as
 * Bitwarden clients seal one (`drive-lib/bitwarden-account.mjs`). `vw.state` changes the account
 * between rounds; `vw.asked` records what Fathom sent.
 */
/** The Secret Server account Cy connects; its password may not reach the database either. */
const DELINEA = {
  user: 'fathom-reader',
  password: 'Dl-Account-Pass-6621!',
  folder: 'Fathom Network',
  secrets: [
    { id: 31, name: 'core-rtr1 enable' },
    { id: 32, name: 'dist-sw2 admin' },
  ],
};

/** Secret Server's four calls, in the shapes `vault_outside/delinea.rs` cites. */
function delinea(vw, req, body, send) {
  const dl = vw.dl;
  if (req.method === 'POST' && req.url === '/oauth2/token') {
    const form = new URLSearchParams(body);
    if (form.get('grant_type') !== 'password' || form.get('username') !== DELINEA.user || form.get('password') !== DELINEA.password) return send(400, { error: 'invalid_grant' });
    return send(200, { access_token: 'dl-token', token_type: 'bearer', expires_in: 1199 });
  }
  if (!req.url.startsWith('/api/v1/')) return false;
  if (req.headers.authorization !== 'Bearer dl-token') return send(401, {});
  const folders = [{ id: 7, folderName: DELINEA.folder, parentFolderId: -1 }];
  if (dl.extraFolder) folders.push({ id: 8, folderName: 'Everything', parentFolderId: -1 });
  if (req.url === '/api/v1/folders?take=500') return send(200, { records: folders, total: folders.length });
  if (req.url === '/api/v1/secrets?take=500') {
    const records = DELINEA.secrets.map((x) => ({ id: x.id, name: x.name, folderId: 7 }));
    return send(200, { records, total: records.length });
  }
  return send(404, {});
}

// ---- Passbolt ---------------------------------------------------------------------------

let helperProc = null;

/** One request to the real helper, over its socket: four bytes of length, then the JSON. */
function pgp(req) {
  return new Promise((res, rej) => {
    const s = connectSocket(HELPER_SOCKET);
    const b = Buffer.from(JSON.stringify(req));
    const h = Buffer.alloc(4);
    h.writeUInt32BE(b.length);
    let buf = Buffer.alloc(0);
    s.on('connect', () => s.write(Buffer.concat([h, b])));
    s.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      if (buf.length >= 4 && buf.length >= 4 + buf.readUInt32BE(0)) {
        s.end();
        const a = JSON.parse(buf.subarray(4, 4 + buf.readUInt32BE(0)).toString('utf8'));
        if (a.ok) res(a);
        else rej(new Error(`helper: ${a.error}`));
      }
    });
    s.on('error', rej);
  });
}

async function startHelper() {
  console.log('==> building and starting the Passbolt helper');
  sh('cargo', ['build', '--locked', '--manifest-path', join(ROOT, 'helpers/passbolt/Cargo.toml')], { stdio: 'inherit' });
  rmSync(HELPER_SOCKET, { force: true });
  helperProc = spawn(HELPER_BIN, [], { env: { FATHOM_PASSBOLT_SOCKET: HELPER_SOCKET }, stdio: ['ignore', 'inherit', 'inherit'] });
  check('the Passbolt helper answers on its socket', !!(await until(async () => (await pgp({ op: 'ping' })).ok, 10000)));
}

/** The Passbolt Cy sets up: one invited user, one folder, two items (one Passbolt 5, one 4). */
const PASSBOLT = {
  user: '3f2c6a1e-5b4d-4e8f-9a71-0c2d3e4f5a6b',
  token: '4a3d7b2f-6c5e-4f90-8b82-1d3e4f5a6b7c',
  folderId: '5b4e8c3a-7d6f-4a01-9c93-2e4f5a6b7c8d',
  folder: 'Fathom Passbolt',
  keyId: '6c5f9d4b-8e70-4b12-8da4-3f5a6b7c8d9e',
  items: [
    { id: '7d60ae5c-9f81-4c23-9eb5-4a6b7c8d9eaf', name: 'core-fw9 admin', username: 'fwadmin', password: 'Pb-Core-Fw9-Secret-3302!', v5: true },
    { id: '8e71bf6d-a092-4d34-afc6-5b7c8d9eafb0', name: 'oob-console', username: 'console', password: 'Pb-Oob-Console-7781!', v5: false },
  ],
};

async function makePassbolt() {
  const pb = { asked: [], shared: false, keyGiven: false, userKey: null };
  pb.server = await pgp({ op: 'make_key', uid: 'Passbolt stand-in server' });
  pb.meta = await pgp({ op: 'make_key', uid: 'Passbolt stand-in metadata key' });
  const sealMeta = async (o) => (await pgp({ op: 'seal_for', secret: pb.server.secret, to: pb.meta.public, plain: JSON.stringify(o) })).data;
  pb.folderMeta = await sealMeta({ object_type: 'PASSBOLT_FOLDER_METADATA', name: PASSBOLT.folder });
  for (const it of PASSBOLT.items) {
    if (it.v5) it.metadata = await sealMeta({ object_type: 'PASSBOLT_RESOURCE_METADATA', resource_type_id: '00000000-0000-4000-8000-000000000000', name: it.name, username: it.username, uris: [] });
  }
  return pb;
}

/** Passbolt's calls, in the shapes `vault_outside/passbolt.rs` cites; OpenPGP through the helper. */
async function passbolt(vw, req, body, send) {
  const pb = vw.pb;
  if (!pb) return false;
  const ok = (b) => send(200, { header: { status: 'success' }, body: b });
  const err = (status, b = null) => send(status, { header: { status: 'error', message: 'refused' }, body: b });
  const url = req.url;
  const toUser = async (o) => (await pgp({ op: 'seal_for', secret: pb.server.secret, to: pb.userKey, plain: typeof o === 'string' ? o : JSON.stringify(o) })).data;
  if (req.method === 'GET' && url === '/auth/verify.json') return ok({ fingerprint: pb.server.fingerprint.toUpperCase(), keydata: pb.server.public });
  if (req.method === 'POST' && url === `/setup/complete/${PASSBOLT.user}.json`) {
    const b = JSON.parse(body || '{}');
    if (pb.userKey || b.authentication_token?.token !== PASSBOLT.token || typeof b.gpgkey?.armored_key !== 'string') return err(400);
    pb.userKey = b.gpgkey.armored_key;
    pb.userFp = (await pgp({ op: 'key_info', key: pb.userKey })).fingerprint;
    return ok(null);
  }
  if (req.method === 'POST' && url === '/auth/jwt/login.json') {
    const b = JSON.parse(body || '{}');
    if (!pb.userKey || b.user_id !== PASSBOLT.user) return err(404);
    let c;
    try {
      c = JSON.parse((await pgp({ op: 'open', secret: pb.server.secret, data: b.challenge, signer: pb.userKey })).plain);
    } catch {
      return err(400);
    }
    pb.lastDomain = c.domain;
    if (c.version !== '1.0.0' || c.domain.replace(/\/$/, '') !== VW_URL) return err(400);
    return ok({ challenge: await toUser({ version: '1.0.0', domain: `${VW_URL}/`, access_token: 'pb-token', refresh_token: 'pb-refresh', verify_token: c.verify_token }) });
  }
  const known = ['/users/me.json', '/folders.json', '/resources.json', '/metadata/keys.json?contain%5Bmetadata_private_keys%5D=1'];
  if (!known.includes(url) && !url.startsWith('/secrets/resource/')) return false;
  if (req.headers.authorization !== 'Bearer pb-token') return err(401);
  if (url === '/users/me.json') return ok({ id: PASSBOLT.user, role: { name: 'user' }, gpgkey: { fingerprint: pb.userFp.toUpperCase() } });
  if (url.startsWith('/metadata/keys.json')) {
    const shares = pb.keyGiven
      ? [{ user_id: PASSBOLT.user, data: await toUser({ object_type: 'PASSBOLT_METADATA_PRIVATE_KEY', domain: VW_URL, fingerprint: pb.meta.fingerprint, armored_key: pb.meta.secret, passphrase: '' }) }]
      : [];
    return ok([{ id: PASSBOLT.keyId, fingerprint: pb.meta.fingerprint, armored_key: pb.meta.public, deleted: null, expired: null, metadata_private_keys: shares }]);
  }
  if (url === '/folders.json') {
    return ok(pb.shared ? [{ id: PASSBOLT.folderId, name: null, metadata: pb.folderMeta, metadata_key_id: PASSBOLT.keyId, metadata_key_type: 'shared_key', folder_parent_id: null, personal: false }] : []);
  }
  if (url === '/resources.json') {
    if (!pb.shared) return ok([]);
    return ok(
      PASSBOLT.items.map((it) =>
        it.v5
          ? { id: it.id, name: null, metadata: it.metadata, metadata_key_id: PASSBOLT.keyId, metadata_key_type: 'shared_key', folder_parent_id: PASSBOLT.folderId, personal: false }
          : { id: it.id, name: it.name, username: it.username, metadata: null, folder_parent_id: PASSBOLT.folderId, personal: false },
      ),
    );
  }
  const it = PASSBOLT.items.find((x) => url === `/secrets/resource/${x.id}.json`);
  if (!it || !pb.shared) return err(404);
  return ok({ id: '9f82c07e-b1a3-4e45-b0d7-6c8d9eafb0c1', resource_id: it.id, user_id: PASSBOLT.user, data: await toUser(it.v5 ? { object_type: 'PASSBOLT_SECRET_DATA', password: it.password, description: '' } : it.password) });
}

async function startStandIn() {
  const vw = { asked: [], extraCollection: false, role: 2, dl: { extraFolder: false } };
  const build = async () => {
    const collections = [{ id: 'col-fathom', name: OUTSIDE.collection, logins: OUTSIDE.logins }];
    if (vw.extraCollection) collections.push({ id: 'col-all', name: 'everything', logins: [] });
    return makeAccount({ email: OUTSIDE.email, password: OUTSIDE.master, iterations: 600000, role: vw.role, collections });
  };
  vw.account = await build();
  vw.rebuild = async () => {
    // The same organisation key and items, a different shape: rebuild, then keep the first keys.
    const next = await build();
    vw.sync = next.sync;
  };
  const server = createServer({ key: readFileSync(join(WORK, 'vw.key')), cert: readFileSync(join(WORK, 'vw.pem')) }, (req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', async () => {
      vw.asked.push({ method: req.method, path: req.url, body, auth: req.headers.authorization ?? null });
      const send = (status, obj) => {
        res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(obj));
        return true;
      };
      if (delinea(vw, req, body, send) !== false) return;
      try {
        if ((await passbolt(vw, req, body, send)) !== false) return;
      } catch (e) {
        console.log(`[passbolt stand-in] ${e}`);
        return send(500, {});
      }
      if (req.method === 'POST' && req.url === '/identity/connect/token') {
        const form = new URLSearchParams(body);
        if (form.get('client_id') !== OUTSIDE.clientId || form.get('client_secret') !== OUTSIDE.secret) return send(400, { error: 'invalid_client' });
        return send(200, vw.account.token);
      }
      if (req.method === 'GET' && req.url === '/api/sync?excludeDomains=true') {
        if (req.headers.authorization !== `Bearer ${vw.account.token.access_token}`) return send(401, {});
        return send(200, vw.sync ?? vw.account.sync);
      }
      send(404, {});
    });
  });
  await new Promise((r) => server.listen(VW_PORT, '127.0.0.1', r));
  vw.close = () => server.close();
  return vw;
}

async function main() {
  console.log('==> resetting the fathom_test schemas');
  resetSchema();
  rmSync(MASTER_KEY, { force: true });
  rmSync(CHAIN_KEY, { force: true });

  const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
  try {
    const ctx = {};
    const keys = {};
    for (const k of Object.keys(PEOPLE)) {
      ctx[k] = await browser.newContext({ viewport: VIEWPORT });
      keys[k] = await makeBrowserKey(ctx[k], PEOPLE[k].address);
    }
    console.log('==> seeding: Ann (admin), Bob and Cy (members), each with the key their browser made');
    copyFileSync(SEED_SRC, SEED_DST);
    writeFileSync(
      SEED_DST,
      readFileSync(SEED_DST, 'utf8')
        .replace('@@STEWARD_PW@@', PEOPLE.ann.password)
        .replace('@@BOB_PW@@', PEOPLE.bob.password)
        .replace('@@CY_PW@@', PEOPLE.cy.password),
    );
    const seedEnv = { ...process.env };
    delete seedEnv.DATABASE_URL;
    Object.assign(seedEnv, {
      FATHOM_MIGRATE_DATABASE_URL: MIGRATE_URL,
      FATHOM_MASTER_KEY: `file://${MASTER_KEY}`,
      FATHOM_CHAIN_KEY: `file://${CHAIN_KEY}`,
      SEED_OUTPUT: SEED_OUT,
      SEED_STEWARD_ADDRESS: PEOPLE.ann.address,
      SEED_STEWARD_PUBKEY: keys.ann,
      SEED_BOB_ADDRESS: PEOPLE.bob.address,
      SEED_BOB_PUBKEY: keys.bob,
      SEED_CY_ADDRESS: PEOPLE.cy.address,
      SEED_CY_PUBKEY: keys.cy,
    });
    try {
      sh('cargo', ['test', '-p', 'fathom-server', '--locked', '--test', 'seed_vault', '--', '--nocapture'], { cwd: ROOT, env: seedEnv, stdio: 'inherit' });
    } finally {
      rmSync(SEED_DST, { force: true });
    }
    makeCerts();
    await startHelper();
    vw = await startStandIn();
    vw.pb = await makePassbolt();
    await startServer();
    await runProof(ctx);
  } finally {
    await browser.close();
    if (serverProc) serverProc.kill();
    if (vw) vw.close();
    if (helperProc) helperProc.kill();
    try { sh('fuser', ['-k', `${PORT}/tcp`]); } catch {}
    resetSchema();
  }
}

async function runProof(ctx) {
  const page = {};
  for (const k of ['ann', 'bob', 'cy']) {
    page[k] = await ctx[k].newPage();
    page[k].on('pageerror', (e) => console.log(`[${k} pageerror] ${e}`));
    page[k].on('console', (m) => { if (m.type() === 'error') console.log(`[${k} console.error] ${m.text()}`); });
    page[k].on('dialog', (d) => d.accept());
  }
  const { ann: A, bob: B, cy: C } = page;
  const shot = (p, name) => p.screenshot({ path: `${SHOTS}${name}.png`, fullPage: true });
  const conn = (p) => p.getByTestId('outside-connection').first();
  const stateOf = async (p) => (await conn(p).getAttribute('data-state')) ?? '';

  // ---- 1. Bob sets up his vault, then opens the connect dialog --------------------------
  await signIn(B, PEOPLE.bob);
  await openMyPasswords(B);
  await setUpVault(B, PEOPLE.bob, null);
  await B.getByTestId('outside-vaults').waitFor({ timeout: 15000 });
  const fill = async () => {
    await B.getByTestId('outside-connect-open').click();
    await B.getByTestId('outside-url').fill(VW_URL);
    await B.getByTestId('outside-client-id').fill(OUTSIDE.clientId);
    await B.getByTestId('outside-client-secret').fill(OUTSIDE.secret);
    await B.getByTestId('outside-master').fill(OUTSIDE.master);
    await B.getByTestId('outside-collection').fill(OUTSIDE.collection);
  };

  // ---- 2. an owner's account is refused, and the list says why ---------------------------
  vw.role = 0;
  vw.account = await makeAccount({ email: OUTSIDE.email, password: OUTSIDE.master, iterations: 600000, role: 0, collections: [{ id: 'col-fathom', name: OUTSIDE.collection, logins: OUTSIDE.logins }] });
  await fill();
  await shot(B, '01-connect-dialog');
  await B.getByTestId('outside-connect-go').click();
  const refused = await until(async () => /Fathom will not connect/.test(await B.getByRole('alert').first().innerText()), 30000);
  check('2. an account that owns its organisation is refused before anything is stored', !!refused);
  check('2. the checks list marks the role line failed', (await B.getByTestId('outside-checks').innerText()).includes('✕'));
  await shot(B, '02-refused-owner-role');
  check('2. nothing was connected', (await B.getByTestId('outside-connection').count()) === 0);
  await B.keyboard.press('Escape');
  await B.reload();
  await openMyPasswords(B);

  // ---- 3. a plain User account connects --------------------------------------------------
  vw.role = 2;
  vw.account = await makeAccount({ email: OUTSIDE.email, password: OUTSIDE.master, iterations: 600000, role: 2, collections: [{ id: 'col-fathom', name: OUTSIDE.collection, logins: OUTSIDE.logins }] });
  vw.sync = null;
  await fill();
  await B.getByTestId('outside-connect-go').click();
  check('3. Bob\'s vault connects', !!(await until(() => conn(B).isVisible(), 60000)));
  check('3. it is on', (await stateOf(B)) === 'on', await stateOf(B));
  const signIns = vw.asked.filter((a) => a.path === '/identity/connect/token');
  check('3. Fathom signed in with the personal API key, as a server device', signIns.length >= 2 && signIns.every((a) => new URLSearchParams(a.body).get('device_type') === '22' && new URLSearchParams(a.body).get('grant_type') === 'client_credentials'));
  check('3. the master password never left the browser', vw.asked.every((a) => !a.body.includes(OUTSIDE.master)));
  await shot(B, '03-connected');

  // ---- 4. list and pull both logins -------------------------------------------------------
  await conn(B).getByTestId('outside-check').click();
  await until(async () => (await B.getByTestId('outside-login').count()) === 2, 30000);
  check('4. Check now lists the collection\'s two logins by name', (await B.getByTestId('outside-logins').innerText()).includes('edge-fw1 admin'));
  for (let i = 0; i < 2; i++) {
    await B.getByTestId('outside-pull').first().click();
    await until(async () => (await B.getByTestId('outside-item').count()) === i + 1, 30000);
  }
  check('4. both are in Fathom, one with its own item key', (await B.getByTestId('outside-item').count()) === 2);
  await shot(B, '04-pulled');

  // ---- 5. Ann, the admin, sees it and removes one; Bob cannot undo that -------------------
  await signIn(A, PEOPLE.ann);
  await openAdminPasswords(A);
  await A.getByTestId('outside-connection').first().waitFor({ timeout: 15000 });
  check('5. the admin sees Bob\'s connection', (await conn(A).innerText()).includes(OUTSIDE.collection));
  await conn(A).getByTestId('outside-item').first().getByTestId('outside-remove').click();
  check('5. the admin removed a login', !!(await until(async () => (await A.locator('[data-testid="outside-item"][data-state="removed"]').count()) === 1, 15000)));
  await shot(A, '05-admin-removed');
  await B.reload();
  await openMyPasswords(B);
  await B.locator('[data-testid="outside-item"][data-state="removed"]').first().waitFor({ timeout: 15000 });
  const removed = B.locator('[data-testid="outside-item"][data-state="removed"]').first();
  check('5. Bob sees it removed, and by whom', (await removed.innerText()).includes('Ann'), await removed.innerText());
  check('5. Bob has no Restore for an admin\'s removal', (await removed.getByTestId('outside-restore').count()) === 0);
  await shot(B, '06-owner-sees-removal');

  // ---- 6. a second collection: the admin's check stops it --------------------------------
  vw.extraCollection = true;
  await vw.rebuild();
  await A.reload();
  await openAdminPasswords(A);
  await conn(A).getByTestId('outside-check').click();
  check('6. a failed check stops the connection', !!(await until(async () => (await stateOf(A)) === 'stopped', 30000)));
  await shot(A, '07-stopped');
  vw.extraCollection = false;
  vw.sync = null;
  await conn(A).getByTestId('outside-check').click();
  check('6. a passing check resumes it', !!(await until(async () => (await stateOf(A)) === 'on', 30000)));

  // ---- 7. the admin disconnects ---------------------------------------------------------
  await conn(A).getByTestId('outside-disconnect').click();
  check('7. the admin disconnected it', !!(await until(async () => (await stateOf(A)) === 'disconnected', 15000)));
  await shot(A, '08-disconnected');

  // ---- 8. Cy connects a Delinea Secret Server, limited to one folder ----------------------
  await signIn(C, PEOPLE.cy);
  await openMyPasswords(C);
  await setUpVault(C, PEOPLE.cy, null);
  await C.getByTestId('outside-vaults').waitFor({ timeout: 15000 });
  const fillDl = async () => {
    await C.getByTestId('outside-connect-open').click();
    await C.getByTestId('outside-provider-delinea').click();
    await C.getByTestId('outside-url').fill(VW_URL);
    await C.getByTestId('outside-dl-user').fill(DELINEA.user);
    await C.getByTestId('outside-dl-password').fill(DELINEA.password);
    await C.getByTestId('outside-collection').fill(DELINEA.folder);
  };
  vw.dl.extraFolder = true;
  await fillDl();
  check('8. the dialog asks Secret Server for an account, not an API key or a master password', (await C.getByTestId('outside-master').count()) === 0 && (await C.getByTestId('outside-client-id').count()) === 0);
  await shot(C, '09-delinea-dialog');
  await C.getByTestId('outside-connect-go').click();
  const dlRefused = await until(async () => /sees 2/.test(await C.getByRole('alert').first().innerText()), 30000);
  check('8. an account that sees two folders is refused, and the reason says so', !!dlRefused);
  await shot(C, '10-delinea-refused-two-folders');
  check('8. nothing was connected', (await C.getByTestId('outside-connection').count()) === 0);
  await C.keyboard.press('Escape');
  await C.reload();
  await openMyPasswords(C);
  vw.dl.extraFolder = false;
  await fillDl();
  await C.getByTestId('outside-connect-go').click();
  check('8. Cy\'s Secret Server connects', !!(await until(() => conn(C).isVisible(), 60000)));
  check('8. its card names the provider and the folder', (await conn(C).innerText()).includes(`Secret Server · ${DELINEA.folder}`), await conn(C).innerText());
  await conn(C).getByTestId('outside-check').click();
  await until(async () => (await C.getByTestId('outside-login').count()) === 2, 30000);
  check('8. Check now lists the folder\'s two secrets by name', (await C.getByTestId('outside-logins').innerText()).includes('dist-sw2 admin'));
  await C.getByTestId('outside-pull').first().click();
  check('8. a secret is pulled into Fathom', !!(await until(async () => (await C.getByTestId('outside-item').count()) === 1, 30000)));
  await shot(C, '11-delinea-connected-pulled');
  const dlSignIns = vw.asked.filter((a) => a.path === '/oauth2/token');
  check('8. Fathom signed in to Secret Server with the password grant on every round', dlSignIns.length >= 4 && dlSignIns.every((a) => new URLSearchParams(a.body).get('grant_type') === 'password'));
  check('8. Fathom never asked Secret Server for a password while connecting, checking or pulling', vw.asked.every((a) => !/^\/api\/v1\/secrets\/\d/.test(a.path)));
  await A.reload();
  await openAdminPasswords(A);
  check('8. the admin sees Cy\'s Secret Server beside Bob\'s Vaultwarden', !!(await until(async () => (await A.getByTestId('outside-connection').count()) === 2, 15000)));

  // ---- 9. Cy sets up a Passbolt from its invitation; it waits, then binds ------------------
  const pb = vw.pb;
  await C.reload();
  await openMyPasswords(C);
  await C.getByTestId('outside-connect-open').click();
  check('9. Passbolt is offered, because this server\'s helper answers', (await C.getByTestId('outside-provider-passbolt').getAttribute('aria-disabled')) !== 'true');
  await C.getByTestId('outside-provider-passbolt').click();
  check('9. the dialog asks for the invitation link, not a password or an API key', (await C.getByTestId('outside-pb-invite').count()) === 1 && (await C.getByTestId('outside-dl-password').count()) === 0 && (await C.getByTestId('outside-master').count()) === 0);
  await C.getByTestId('outside-pb-invite').fill(`${VW_URL}/setup/start/${PASSBOLT.user}/${PASSBOLT.token}`);
  await C.getByTestId('outside-collection').fill(PASSBOLT.folder);
  await C.getByTestId('outside-connect-go').click();
  await C.getByTestId('outside-pb-fingerprint').waitFor({ timeout: 20000 });
  const shown = (await C.getByTestId('outside-pb-fingerprint').innerText()).replace(/\s+/g, '').toLowerCase();
  check('9. the dialog shows the Passbolt server key\'s fingerprint, as the helper reads it', shown.includes(pb.server.fingerprint), pb.server.fingerprint);
  check('9. reading the invitation did not use it', pb.userKey == null);
  check('9. setting up waits for the person to confirm the fingerprint', await C.getByTestId('outside-connect-go').isDisabled());
  await shot(C, '12-passbolt-fingerprint');
  await C.getByTestId('outside-pb-confirm').check();
  await C.getByTestId('outside-connect-go').click();
  const pbConn = C.locator('[data-testid="outside-connection"]', { hasText: 'Passbolt' });
  check('9. the account is set up and the connection waits', !!(await until(async () => (await pbConn.getAttribute('data-state')) === 'waiting', 60000)));
  check('9. Passbolt was given a public key, and only that', /BEGIN PGP PUBLIC KEY BLOCK/.test(pb.userKey ?? '') && !vw.asked.some((a) => a.body.includes('PRIVATE KEY')));
  const fathomKey = await pgp({ op: 'key_info', key: pb.userKey });
  check('9. Fathom\'s Passbolt key is Curve25519 throughout', fathomKey.curve25519 === true);
  await pbConn.getByTestId('outside-check').click();
  check('9. with nothing shared, Check now keeps it waiting and says why', !!(await until(async () => /sees none yet/.test(await pbConn.innerText()), 30000)));
  check('9. Fathom signed in with a challenge for this address', pb.lastDomain === VW_URL, pb.lastDomain);
  await shot(C, '13-passbolt-waiting');
  pb.shared = true;
  await pbConn.getByTestId('outside-check').click();
  check('9. with the folder shared but not its metadata key, it still waits', !!(await until(async () => /metadata key/.test(await pbConn.innerText()), 30000)));
  pb.keyGiven = true;
  await pbConn.getByTestId('outside-check').click();
  check('9. once both are shared, the first passing check binds it', !!(await until(async () => (await pbConn.getAttribute('data-state')) === 'on', 30000)));
  await pbConn.getByTestId('outside-check').click();
  await until(async () => (await pbConn.getByTestId('outside-login').count()) === 2, 30000);
  const pbLogins = await pbConn.getByTestId('outside-logins').innerText();
  check('9. Check now lists both items by name, the Passbolt 5 one opened with the metadata key', pbLogins.includes('core-fw9 admin') && pbLogins.includes('oob-console'));
  await pbConn.getByTestId('outside-pull').first().click();
  check('9. an item is pulled into Fathom', !!(await until(async () => (await pbConn.getByTestId('outside-item').count()) === 1, 30000)));
  check('9. Fathom never asked Passbolt for a secret while setting up, checking or pulling', vw.asked.every((a) => !a.path.startsWith('/secrets/resource/')));
  await shot(C, '14-passbolt-bound-pulled');
  const squeezed = await C.getByTestId('vault-passwords').evaluate((el) => ({ shown: el.clientHeight, needs: el.scrollHeight }));
  check('9. the Passwords tab shows its whole list, not a box that scrolls', squeezed.needs <= squeezed.shown + 1 && squeezed.shown > 200, JSON.stringify(squeezed));

  // ---- 10. the sweep --------------------------------------------------------------------
  const dump = sh('sudo', ['-n', '-u', 'postgres', 'pg_dump', '--data-only', '--schema=public', '--schema=vault', '-d', DB_NAME], { maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
  const hexOf = (s) => Buffer.from(s, 'utf8').toString('hex');
  for (const [what, value] of [['the master password', OUTSIDE.master], ['the API key\'s secret', OUTSIDE.secret], ['a pulled password', OUTSIDE.logins[0].password], ['the own-key password', OUTSIDE.logins[1].password], ['a login\'s name', 'core-sw1 admin'], ['the Secret Server account\'s password', DELINEA.password], ['a pulled secret\'s name', DELINEA.secrets[0].name], ['a Passbolt password', PASSBOLT.items[0].password], ['a Passbolt item\'s name', PASSBOLT.items[0].name], ['a PGP private key', 'PRIVATE KEY BLOCK']]) {
    check(`10. ${what} is nowhere in the database, as text or as hex`, !dump.includes(value) && !dump.toLowerCase().includes(hexOf(value)));
  }
  check('10. the sweep can see the outside tables (positive control: the chain names an outside act)', dump.includes('vault_outside_changed'));
  const rows = sh('sudo', ['-n', '-u', 'postgres', 'psql', '-At', '-d', DB_NAME, '-c', "SELECT state || ':' || octet_length(secret_ct) FROM vault.outside_connections WHERE provider = 'vaultwarden'"], { stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  check('10. the disconnected row keeps its history and no sealed secret', rows === 'disconnected:0', rows);
  const pbRow = sh('sudo', ['-n', '-u', 'postgres', 'psql', '-At', '-d', DB_NAME, '-c', "SELECT state || ':' || (collection_id IS NOT NULL) FROM vault.outside_connections WHERE provider = 'passbolt'"], { stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  check('10. the Passbolt row is on and bound to its folder', pbRow === 'on:true', pbRow);

  console.log(fails.length === 0 ? '\nALL PASS' : `\n${fails.length} FAILED:\n  ${fails.join('\n  ')}`);
  process.exitCode = fails.length === 0 ? 0 : 1;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
