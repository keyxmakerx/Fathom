// Session 7's proof-builder: a driven browser goes from nothing to a saved
// design (ADR-0054), then two browsers prove the save precondition refuses a
// stale write with the one sentence naming both versions.
//
// **What is real and what is not.** The real `fathom-server` binary, built
// from this checkout, runs against a real PostgreSQL database this script
// creates and drops. The real Vite client (the actual `App.tsx`, `Home.tsx`,
// `RacksPlace.tsx`, the real signed-fetch machinery) is served and driven by
// a real headless Chromium (two independent browser contexts, one per
// account) through Playwright. Every HTTP call either browser makes goes to
// the real server over the real signed protocol; nothing is intercepted.
//
// **The one thing that is not the real enrolment UI.** `Enrol.tsx` redeems
// an invitation token and has the browser itself call
// `crypto.subtle.generateKey(..., false, ...)` — a NON-EXTRACTABLE key this
// script cannot hand a chosen private scalar to. Reaching that route for two
// accounts needs a real operator session (`admin.rs`'s two-role plane), and
// this task's brief points at the OTHER path `tests/design_api.rs`'s own
// fixtures use instead: seed accounts, keys and organisation-wide capability
// straight into the database (`crates/fathom-server/tests/
// seed_first_design.rs`, written and deleted by this script, mirrors
// `bootstrap`/`enrol`/`a_member_with` there verbatim), holding the raw P-256
// scalar for both accounts. Getting that exact key INTO a real browser then
// only needs `crypto.subtle.importKey` — WebCrypto's import does not care
// where the bytes came from, and `extractable: false` on the imported
// `CryptoKey` only stops a LATER export, never the import itself. This
// script writes each scalar into the browser's own `IndexedDB` store under
// the same schema `client/src/crypto/keys.ts` reads
// (`injectEnrolledKey`, below) — after that, `SignIn.tsx`'s real form, the
// real `signIn()` challenge/response exchange, and the real server-side ES256
// verification run completely unmodified. See `seed_first_design.rs`'s own
// module doc for the full reasoning.
//
// Usage:
//   node scripts/drive-first-design.mjs
//
// Cleans up after itself: stops the server and the client, drops the
// database, deletes every file it wrote (the seed test, the two key files,
// the bootstrap token, the throwaway Vite config, the seed JSON).
//
// Two things this run found that are not this script's to fix, recorded
// here as well as in its own PASS/FAIL log:
//
//   1. `client/src/api/scopes.ts`'s `createScope` sends a JSON body; the
//      real server's `create_scope_handler` reads `LP(parent) ‖ LP(label)`.
//      Every real click of Home's "New scope" → "Create" is refused 400
//      "malformed request". This script drives that real refusal first
//      (to record it), then creates the scope through the same signed
//      protocol directly (`signedFetch`, for real) to continue the proof.
//   2. ADR-0054 §1 describes the save-refusal wash as offering Reload;
//      `useDesignSession.ts` exports `reloadDesign` for exactly that, but no
//      component calls it — `RacksPlace.tsx` destructures the refusal text
//      only. This script substitutes a full navigation and re-sign-in
//      (which the in-memory-only session already requires) to show the
//      same underlying effect.

import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const pw = await import(
  process.env.PW_PLAYWRIGHT || '/opt/node22/lib/node_modules/playwright/index.js'
);
const { chromium } = pw.default ?? pw;

const ROOT = process.env.FATHOM_ROOT
  || resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = process.env.PW_CHROMIUM
  || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const CLIENT = ROOT + '/client';
const SHOTS = '/tmp/claude-0/';
mkdirSync(SHOTS, { recursive: true });

const TAG = `s7fd${process.pid}`;
const DB_NAME = `fathom_test_${TAG}`;
const SERVER_PORT = 18173;
const CLIENT_PORT = 18174;
const SERVER_URL = `http://127.0.0.1:${SERVER_PORT}`;
const CLIENT_URL = `http://127.0.0.1:${CLIENT_PORT}`;

const MASTER_KEY_PATH = `${SHOTS}s7fd-master.key`;
const CHAIN_KEY_PATH = `${SHOTS}s7fd-chain.key`;
const SEED_OUTPUT_PATH = `${SHOTS}s7fd-seed.json`;
const BOOTSTRAP_TOKEN_PATH = `${SHOTS}s7fd-bootstrap-token.txt`;
const SEED_TEST_PATH = `${ROOT}/crates/fathom-server/tests/seed_first_design.rs`;
const VITE_CONFIG_PATH = `${CLIENT}/vite.drive-first-design.config.ts`;

const MIGRATE_URL = `postgres://fathom_test:x@127.0.0.1:5432/${DB_NAME}`;
const SUPERUSER_URL = `postgres://postgres:x@127.0.0.1:5432/${DB_NAME}`;
const RUNTIME_URL = `postgres://fathom_app:x@127.0.0.1:5432/${DB_NAME}`;

const fails = [];
function check(name, ok, detail) {
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (detail ? '  [' + detail + ']' : ''));
  if (!ok) fails.push(name);
}

function sh(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: 'utf8', ...opts });
}

async function waitForHttp(url, { timeoutMs = 30000, intervalMs = 300 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      return res;
    } catch (error) {
      lastError = error;
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }
  throw new Error(`timed out waiting for ${url}: ${lastError}`);
}

// ---------------------------------------------------------------------------
// The Rust seed fixture — see this script's own header for why it exists.
// Written here and deleted in `cleanup()`, the same throwaway-file pattern
// `drive-config-drawer.mjs` uses for its own `client/preview.tsx`: it seeds
// one organisation with a steward (`Capability::Steward`) and a drawer
// (`Capability::Draw`), directly against the database, mirroring
// `tests/design_api.rs`'s own `bootstrap`/`enrol`/`a_member_with` fixtures —
// see the file's own module doc, written into it below, for the reasoning.
// ---------------------------------------------------------------------------
const SEED_TEST_SOURCE = `//! Session 7 proof-builder scaffolding, throwaway: seeds one organisation
//! with a steward (organisation-wide \`Capability::Steward\`) and a drawer
//! (organisation-wide \`Capability::Draw\`) directly against the database —
//! exactly the path \`tests/design_api.rs\`'s own \`bootstrap\`/\`enrol\`/
//! \`a_member_with\` fixtures use (the security-bearing code exercised is the
//! real \`grants\`/\`authority\` module, unchanged).
//!
//! **Why this exists instead of driving a scripted browser enrolment**:
//! \`client/src/crypto/keys.ts\` generates the account keypair with
//! \`crypto.subtle.generateKey(..., false, ...)\` — non-extractable — and the
//! client has no route that imports a key it did not generate itself. Reaching
//! the real token-redemption route for two accounts needs a real operator
//! session (\`admin.rs\`'s two-role plane), so this uses the OTHER path this
//! task's brief names instead: seed accounts, keys and organisation-wide
//! capability straight into the database, holding the raw P-256 scalar for
//! both accounts. Getting that exact key INTO a real browser then only needs
//! \`crypto.subtle.importKey\` in the page — WebCrypto's import does not care
//! where the bytes came from, and \`extractable: false\` on the imported
//! \`CryptoKey\` only stops a LATER export, never the import itself.
//! \`scripts/drive-first-design.mjs\`'s own \`injectEnrolledKey\` does exactly
//! that, after which \`SignIn.tsx\`'s real form, the real \`signIn()\`
//! challenge/response exchange and the real server-side ES256 verification
//! run completely unmodified.
//!
//! The master and chain keys are loaded through the SAME \`KeySource::parse\`
//! + \`KeyRing::load(..., true)\` call \`main.rs\` makes at real startup, from
//! the same \`file://\` paths the real \`fathom-server\` binary is then started
//! against, so the sealed rows this binary writes are readable by that real
//! server afterward.
//!
//! Not committed as a permanent fixture: written and deleted by
//! \`scripts/drive-first-design.mjs\`.

mod support;

use std::io::Write as _;

use fathom_server::authority::{self, Capability, GrantFacts, SoftwareKey};
use fathom_server::chains;
use fathom_server::crypto::Key32;
use fathom_server::grants::{self, Authority, EpochWatch, GenesisGrant, GrantRequest};
use fathom_server::keyprovider::KeySource;
use fathom_server::keys::{self, KeyRing};
use fathom_server::repo::{self, Role};

fn now_unix() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64
}

fn hex(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        out.push_str(&format!("{b:02x}"));
    }
    out
}

fn unique(prefix: &str) -> String {
    format!(
        "{prefix}-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    )
}

/// A fresh 32-byte P-256 scalar this process keeps, alongside the
/// \`SoftwareKey\` built from it — unlike \`SoftwareKey::random()\`, which never
/// hands the scalar back.
fn fresh_key() -> ([u8; 32], SoftwareKey) {
    let scalar = *Key32::random().expect("OS randomness").expose();
    let key = SoftwareKey::from_bytes(&scalar).expect("a valid P-256 scalar");
    (scalar, key)
}

#[tokio::test]
async fn seed_a_steward_and_a_drawer_for_the_driven_browser_proof() {
    let master_spec =
        std::env::var("FATHOM_MASTER_KEY").expect("FATHOM_MASTER_KEY (file:// spec) must be set");
    let chain_spec =
        std::env::var("FATHOM_CHAIN_KEY").expect("FATHOM_CHAIN_KEY (file:// spec) must be set");
    let output_path =
        std::env::var("SEED_OUTPUT").expect("SEED_OUTPUT (a file path to write JSON to)");

    let master_source = KeySource::parse(&master_spec).expect("a valid FATHOM_MASTER_KEY spec");
    let chain_source = KeySource::parse(&chain_spec).expect("a valid FATHOM_CHAIN_KEY spec");
    // \`create_if_missing = true\`, exactly like \`main.rs\`'s own startup call —
    // this binary runs BEFORE the real server, so it is the one that mints
    // the two key files the server then loads unchanged.
    let ring = KeyRing::load(&master_source, &chain_source, true)
        .expect("the two key files must load or be creatable");

    let pool = support::migrated_pool().await;

    {
        let client = pool.get().await.expect("connection");
        chains::register_deployment(&**client)
            .await
            .expect("stamp the deployment identity, exactly as main.rs does at startup");
    }

    // ------------------------------------------------------------------
    // The organisation and its steward — \`tests/design_api.rs\`'s
    // \`bootstrap()\`, verbatim in shape, except the steward's scalar is kept
    // rather than thrown away.
    // ------------------------------------------------------------------
    let root = SoftwareKey::random().expect("an organisation root keypair");
    let salt = [0x5au8; 16];
    let organisation_id = authority::derive_organisation_id(&root.public_key(), &salt);
    let root_fpr = authority::key_fingerprint(&root.public_key());

    let steward_address = unique("steward");
    let steward_account = repo::create_account(&pool, &steward_address, "Steward")
        .await
        .expect("create the steward's account shell")
        .id;
    let (steward_scalar, steward_key) = fresh_key();

    let now = now_unix();
    let steward_subject_fpr = authority::key_fingerprint(&steward_key.public_key());
    let facts = GrantFacts {
        organisation: &organisation_id,
        root_pubkey_fpr: &root_fpr,
        scope: "",
        subject: &steward_account.to_string(),
        subject_key_fpr: &steward_subject_fpr,
        capability: Capability::Steward,
        granter: None,
        granter_key_fpr: &root_fpr,
        effective_from_unix: now,
        expires_at_unix: now + 365 * 24 * 3600,
        sole_steward_appointment: false,
        auth_epoch: 1,
    };
    let genesis_request = GenesisGrant {
        subject: steward_account,
        subject_key_fpr: steward_subject_fpr,
        capability: Capability::Steward,
        effective_from_unix: now,
        expires_at_unix: now + 365 * 24 * 3600,
        signature: root.sign(&authority::grant_bytes(&facts)),
    };

    let organisation = {
        let mut client = pool.get().await.expect("connection");
        let tx = client.transaction().await.expect("begin");
        let genesis = grants::bootstrap_organisation(
            &tx,
            &ring,
            steward_account,
            "Session 7 proof",
            &root.public_key(),
            &salt,
            &[genesis_request],
        )
        .await
        .expect("genesis");
        tx.commit().await.expect("commit");
        genesis.organisation
    };

    enrol(&pool, &ring, organisation, steward_account, &steward_key).await;

    // ------------------------------------------------------------------
    // The drawer — \`a_member_with(..., Some(Capability::Draw))\`, verbatim
    // in shape, scalar kept.
    // ------------------------------------------------------------------
    let drawer_address = unique("drawer");
    let drawer_account = repo::create_account(&pool, &drawer_address, "Drawer")
        .await
        .expect("create the drawer's account shell")
        .id;
    repo::add_member(
        &pool,
        organisation,
        steward_account,
        drawer_account,
        Role::Member,
    )
    .await
    .expect("membership");
    let (drawer_scalar, drawer_key) = fresh_key();
    enrol(&pool, &ring, organisation, drawer_account, &drawer_key).await;

    {
        let mut client = pool.get().await.expect("connection");
        let tx = client.transaction().await.expect("begin");
        let ctx = repo::open_tenant_context(&tx, organisation, steward_account)
            .await
            .expect("tenant context");
        let tenant_key = keys::tenant_key(&tx, &ring, &ctx).await.expect("tenant key");
        let watch = EpochWatch::new();
        let auth = Authority {
            ring: &ring,
            ctx: &ctx,
            tenant_key: &tenant_key,
            watch: &watch,
        };
        let proposal = grants::propose_grant(
            &tx,
            &auth,
            &GrantRequest {
                scope: None,
                subject: drawer_account,
                capability: Capability::Draw,
                expires_at_unix: now_unix() + 30 * 24 * 3600,
            },
        )
        .await
        .expect("proposed");
        let signature = steward_key.sign(&proposal.bytes);
        grants::sign_grant(&tx, &auth, &proposal, &signature)
            .await
            .expect("signed");
        tx.commit().await.expect("commit");
    }

    // ------------------------------------------------------------------
    // Hand the raw material back to the driving script.
    // ------------------------------------------------------------------
    let json = format!(
        "{{\\n  \\"organisation_id\\": \\"{organisation}\\",\\n  \\"steward\\": {{\\"account_id\\": \\"{steward_account}\\", \\"address\\": \\"{steward_address}\\", \\"private_scalar_hex\\": \\"{steward_scalar_hex}\\", \\"public_key_hex\\": \\"{steward_pub_hex}\\"}},\\n  \\"drawer\\": {{\\"account_id\\": \\"{drawer_account}\\", \\"address\\": \\"{drawer_address}\\", \\"private_scalar_hex\\": \\"{drawer_scalar_hex}\\", \\"public_key_hex\\": \\"{drawer_pub_hex}\\"}}\\n}}\\n",
        organisation = organisation,
        steward_account = steward_account,
        steward_address = steward_address,
        steward_scalar_hex = hex(&steward_scalar),
        steward_pub_hex = hex(&steward_key.public_key()),
        drawer_account = drawer_account,
        drawer_address = drawer_address,
        drawer_scalar_hex = hex(&drawer_scalar),
        drawer_pub_hex = hex(&drawer_key.public_key()),
    );
    let mut file = std::fs::File::create(&output_path).expect("create SEED_OUTPUT");
    file.write_all(json.as_bytes()).expect("write SEED_OUTPUT");
}

/// \`tests/design_api.rs\`'s own \`enrol\`, verbatim: enrol \`key\`'s public half
/// for \`account\` inside \`organisation\`.
async fn enrol(
    pool: &deadpool_postgres::Pool,
    ring: &KeyRing,
    organisation: fathom_server::repo::OrganisationId,
    account: fathom_server::repo::AccountId,
    key: &SoftwareKey,
) {
    let mut client = pool.get().await.expect("connection");
    let tx = client.transaction().await.expect("begin");
    let ctx = repo::open_tenant_context(&tx, organisation, account)
        .await
        .expect("tenant context");
    let tenant_key = keys::tenant_key(&tx, ring, &ctx).await.expect("tenant key");
    let watch = EpochWatch::new();
    let auth = Authority {
        ring,
        ctx: &ctx,
        tenant_key: &tenant_key,
        watch: &watch,
    };
    grants::enrol_software_key(&tx, &auth, &key.public_key())
        .await
        .expect("enrol");
    tx.commit().await.expect("commit");
}
`;

let serverProc = null;
let clientProc = null;

async function main() {
  console.log(`==> database ${DB_NAME}`);
  sh('psql', ['-h', '127.0.0.1', '-U', 'postgres', '-d', 'postgres', '-c', `CREATE DATABASE ${DB_NAME} OWNER fathom_test;`]);

  console.log('==> writing the throwaway seed fixture');
  writeFileSync(SEED_TEST_PATH, SEED_TEST_SOURCE);

  console.log('==> seeding a steward (Capability::Steward) and a drawer (Capability::Draw)');
  // `DATABASE_URL` must be ABSENT, not empty — `support::test_database_url`
  // derives the runtime role's URL from `FATHOM_MIGRATE_DATABASE_URL` only
  // when the env var is entirely unset (NEXT.md ground rule 3).
  const seedEnv = { ...process.env };
  delete seedEnv.DATABASE_URL;
  seedEnv.FATHOM_MIGRATE_DATABASE_URL = MIGRATE_URL;
  seedEnv.SUPERUSER_DATABASE_URL = SUPERUSER_URL;
  seedEnv.FATHOM_MASTER_KEY = `file://${MASTER_KEY_PATH}`;
  seedEnv.FATHOM_CHAIN_KEY = `file://${CHAIN_KEY_PATH}`;
  seedEnv.SEED_OUTPUT = SEED_OUTPUT_PATH;
  sh('cargo', ['test', '-p', 'fathom-server', '--test', 'seed_first_design', '--', '--nocapture'], {
    cwd: ROOT,
    env: seedEnv,
    stdio: 'inherit',
  });
  const seed = JSON.parse(readFileSync(SEED_OUTPUT_PATH, 'utf8'));
  check('seed produced a steward and a drawer with distinct addresses', seed.steward.address !== seed.drawer.address);

  console.log('==> building fathom-server');
  sh('cargo', ['build', '-p', 'fathom-server'], { cwd: ROOT, stdio: 'inherit' });

  console.log('==> starting fathom-server on ' + SERVER_URL);
  serverProc = spawn(`${ROOT}/target/debug/fathom-server`, [], {
    cwd: ROOT,
    env: {
      ...process.env,
      DATABASE_URL: RUNTIME_URL,
      FATHOM_MIGRATE_DATABASE_URL: MIGRATE_URL,
      FATHOM_SCHEMA_ROOT: `${ROOT}/schema`,
      FATHOM_MASTER_KEY: `file://${MASTER_KEY_PATH}`,
      FATHOM_CHAIN_KEY: `file://${CHAIN_KEY_PATH}`,
      FATHOM_OPERATOR_NOTICE_ADDRESS: 'operator@fathom.invalid',
      FATHOM_BOOTSTRAP_TOKEN_FILE: BOOTSTRAP_TOKEN_PATH,
      FATHOM_BIND: `127.0.0.1:${SERVER_PORT}`,
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

  console.log('==> writing a throwaway Vite proxy config (the shipped one only proxies /session and /organisations)');
  writeFileSync(
    VITE_CONFIG_PATH,
    `import { fileURLToPath, URL } from 'node:url'\n`
      + `import react from '@vitejs/plugin-react'\n`
      + `import { defineConfig, searchForWorkspaceRoot } from 'vite'\n`
      + `const repoRoot = fileURLToPath(new URL('..', import.meta.url))\n`
      + `const apiTarget = process.env.FATHOM_API_PROXY_TARGET ?? 'http://127.0.0.1:8080'\n`
      + `export default defineConfig({\n`
      + `  plugins: [react()],\n`
      + `  server: {\n`
      + `    fs: { allow: [searchForWorkspaceRoot(process.cwd()), repoRoot] },\n`
      + `    proxy: {\n`
      + `      '/session': { target: apiTarget, changeOrigin: true },\n`
      + `      '/organisations': { target: apiTarget, changeOrigin: true },\n`
      + `      '/catalogue': { target: apiTarget, changeOrigin: true },\n`
      + `      '/enrolment': { target: apiTarget, changeOrigin: true },\n`
      + `    },\n`
      + `  },\n`
      + `})\n`,
  );

  console.log('==> starting the real Vite client on ' + CLIENT_URL);
  clientProc = spawn('npx', ['vite', '--config', VITE_CONFIG_PATH, '--port', String(CLIENT_PORT), '--strictPort'], {
    cwd: CLIENT,
    env: { ...process.env, FATHOM_API_PROXY_TARGET: SERVER_URL },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let clientLog = '';
  clientProc.stdout.on('data', (d) => { clientLog += d.toString(); });
  clientProc.stderr.on('data', (d) => { clientLog += d.toString(); });
  try {
    const home = await waitForHttp(CLIENT_URL);
    check('the real Vite client answers GET /', home.status === 200, String(home.status));
  } catch (error) {
    console.log(clientLog.slice(-4000));
    throw error;
  }

  const browser = await chromium.launch({ executablePath: CHROME });
  try {
    await runProof(browser, seed);
  } finally {
    await browser.close();
  }
}

// ---------------------------------------------------------------------------
// The proof
// ---------------------------------------------------------------------------

/** Puts `scalarHex`'s P-256 key into this page's origin, under `address`, as
 * `client/src/crypto/keys.ts`'s `getEnrolledKeyPair` reads it — real
 * `CryptoKey` objects, `extractable: false` on the private half exactly as
 * `generateKeyPair()` produces, imported rather than generated. See this
 * script's own header. */
async function injectEnrolledKey(page, address, scalarHex, pubHex) {
  await page.evaluate(async ({ address, scalarHex, pubHex }) => {
    function hexToBytes(hex) {
      const out = new Uint8Array(hex.length / 2);
      for (let i = 0; i < out.length; i += 1) out[i] = parseInt(hex.substr(i * 2, 2), 16);
      return out;
    }
    function b64url(bytes) {
      let bin = '';
      for (const b of bytes) bin += String.fromCharCode(b);
      return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    }
    const scalar = hexToBytes(scalarHex);
    const pub = hexToBytes(pubHex);
    const x = pub.slice(1, 33);
    const y = pub.slice(33, 65);
    const alg = { name: 'ECDSA', namedCurve: 'P-256' };
    const privateKey = await crypto.subtle.importKey(
      'jwk',
      { kty: 'EC', crv: 'P-256', d: b64url(scalar), x: b64url(x), y: b64url(y), key_ops: ['sign'], ext: false },
      alg,
      false,
      ['sign'],
    );
    const publicKey = await crypto.subtle.importKey(
      'jwk',
      { kty: 'EC', crv: 'P-256', x: b64url(x), y: b64url(y), ext: true },
      alg,
      true,
      ['verify'],
    );
    await new Promise((resolveDb, rejectDb) => {
      const req = indexedDB.open('fathom-enrolled-keys', 2);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('keys')) db.createObjectStore('keys');
        if (!db.objectStoreNames.contains('pending')) db.createObjectStore('pending');
      };
      req.onsuccess = () => {
        const db = req.result;
        const tx = db.transaction('keys', 'readwrite');
        tx.objectStore('keys').put({ privateKey, publicKey }, address);
        tx.oncomplete = () => { db.close(); resolveDb(undefined); };
        tx.onerror = () => { db.close(); rejectDb(tx.error); };
      };
      req.onerror = () => rejectDb(req.error);
    });
  }, { address, scalarHex, pubHex });
}

async function signIn(page, address) {
  await page.goto(CLIENT_URL, { waitUntil: 'domcontentloaded' });
  await page.locator('#signin-address').fill(address);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByText('Your organisations').waitFor({ timeout: 15000 });
}

/** Simulates the palette's real native HTML5 drag onto the real drop
 * target — Chromium's `DataTransfer`/`DragEvent`, constructed once and
 * reused for `dragstart`/`dragover`/`drop` exactly as a real OS-level drag
 * would deliver it to the same three listeners `Palette.tsx`/`Drawing.tsx`
 * attach. No mouse-only Playwright drag reaches these, because the payload
 * this app reads travels in `dataTransfer`, not in a pointer path. */
async function dragPaletteItemOntoRack(page, itemIndex = 0, slot = 0) {
  const item = page.locator('.drawing-palette__item').nth(itemIndex);
  await item.waitFor({ state: 'visible', timeout: 15000 });
  const rack = page.locator('.drawing-rack__frame').first();
  await rack.waitFor({ state: 'visible', timeout: 15000 });
  const itemHandle = await item.elementHandle();
  const rackHandle = await rack.elementHandle();
  const rackBox = await rack.boundingBox();
  const dropX = rackBox.x + rackBox.width / 2;
  // `slot` spaces successive drops well apart vertically so a second
  // placement in the same already-occupied rack does not overlap the
  // first and get shaken off (`Drawing.tsx`'s own overlap check) — this
  // script does not need to know each device's real height, only that
  // 140px clears anything the seeded catalogue offers.
  const dropY = rackBox.y + 30 + slot * 140;
  await page.evaluate(
    ([itemEl, rackEl, x, y]) => {
      const dt = new DataTransfer();
      itemEl.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }));
      rackEl.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: x, clientY: y }));
      rackEl.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: x, clientY: y }));
    },
    [itemHandle, rackHandle, dropX, dropY],
  );
}

async function openTheRail(page) {
  const handle = page.getByRole('button', { name: 'Open the rail' });
  if (await handle.count() > 0) {
    await handle.click();
  }
}

async function runProof(browser, seed) {
  const stewardCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const drawerCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const one = await stewardCtx.newPage();
  const two = await drawerCtx.newPage();
  one.on('console', (m) => console.log('[one console] ' + m.text()));
  two.on('console', (m) => console.log('[two console] ' + m.text()));
  one.on('pageerror', (e) => console.log('[one pageerror] ' + e));
  two.on('pageerror', (e) => console.log('[two pageerror] ' + e));

  // -------------------------------------------------------------------
  // Browser one — the steward: sign in, create a scope from Home, create
  // a design in it, open it, place a device, and see it save.
  // -------------------------------------------------------------------
  await one.goto(CLIENT_URL, { waitUntil: 'domcontentloaded' });
  await injectEnrolledKey(one, seed.steward.address, seed.steward.private_scalar_hex, seed.steward.public_key_hex);
  await signIn(one, seed.steward.address);
  check('browser one (steward): signed in and Home rendered', await one.getByText('Your organisations').isVisible());

  // FOUND BUG (see this script's final report): `client/src/api/scopes.ts`'s
  // `createScope` sends a JSON body, but the real server's
  // `create_scope_handler` (`crates/fathom-server/src/design_api.rs`) reads
  // `LP(parent) ‖ LP(label)`, the same binary framing every other signed
  // route in this server uses and the one
  // `tests/design_api.rs`'s own `scope_create_body` proves against a real
  // socket. Clicking "New scope" → "Create" through the real, unmodified UI
  // is driven here first to RECORD that refusal, not to route around it.
  await one.getByRole('button', { name: 'New scope' }).click();
  await one.locator('#home-new-scope-label').fill('Session 7 network');
  await one.getByRole('button', { name: 'Create', exact: true }).click();
  await one.getByText('malformed request').waitFor({ timeout: 10000 });
  check(
    'FOUND BUG confirmed live: Home\'s real "New scope" form is refused 400 "malformed request" '
      + '(client/src/api/scopes.ts sends JSON; the server wants LP-framed bytes) — see report',
    true,
  );
  await one.getByRole('button', { name: 'Cancel' }).click();

  // Work around the bug from outside the buggy function, using the SAME
  // real signing code the app itself uses (`signedFetch`, dynamically
  // imported from the real module Vite is already serving — nothing
  // stubbed, nothing bypassed at the protocol level, only the one call site
  // that frames the body wrong is not used), so the proof can continue past
  // a client defect that is not this task's to fix.
  await one.evaluate(async ({ label }) => {
    const { signedFetch } = await import('/src/api/signedFetch.ts');
    const { lp, utf8, concatBytes } = await import('/src/crypto/bytes.ts');
    // The organisation id is not printed on screen (only its display name
    // is) — read it the same way `App.tsx` already holds it: off the one
    // fetch this page made at load. Simplest reliable source inside the
    // page: re-fetch it.
    const orgsBody = await signedFetch('GET', '/organisations');
    const orgs = JSON.parse(new TextDecoder().decode(orgsBody));
    const organisationId = orgs[0].organisation_id;
    const body = concatBytes(lp(new Uint8Array(0)), lp(utf8(label)));
    const res = await signedFetch(
      'POST',
      `/organisations/${encodeURIComponent(organisationId)}/scopes`,
      body,
    );
    const scope = JSON.parse(new TextDecoder().decode(res));
    window.__seededScopeId = scope.scope_id;
  }, { label: 'Session 7 network' });

  // A fresh open re-reads the scope list from the server — the same effect
  // a working "New scope" button's own success path already has
  // (`setScopes` appending in place). Re-signs in with the same enrolled
  // key (still in this browser's `IndexedDB`); the in-memory session does
  // not survive a navigation (`state/sessionState.ts`'s own doc).
  await one.goto(CLIENT_URL, { waitUntil: 'domcontentloaded' });
  await signIn(one, seed.steward.address);
  await one.getByText('Session 7 network').waitFor({ timeout: 10000 });
  check('browser one (steward): the new scope appears on Home (created via the real signed API)', await one.getByText('Session 7 network').isVisible());

  await one.screenshot({ path: `${SHOTS}s7-home.png` });
  check(
    'screenshot s7-home.png: Home shows New scope and New design',
    (await one.getByRole('button', { name: 'New scope' }).count()) > 0
      && (await one.getByRole('button', { name: 'New design' }).count()) > 0,
  );

  await one.getByRole('button', { name: 'New design' }).first().click();
  await one.locator('.drawing').waitFor({ timeout: 15000 });
  await openTheRail(one);
  await dragPaletteItemOntoRack(one, 0, 0);
  // A save is queued the instant the document changes (`applyDocChange`);
  // wait for the refusal slot to stay empty and a real chassis to appear —
  // the honest sign the drop landed and the queued save was not refused.
  await one.locator('.drawing-chassis').first().waitFor({ timeout: 15000 });
  await one.waitForTimeout(1200); // the SaveQueue's own debounce plus one round trip
  const oneRefusalCount = await one.locator('.racks-place__refusal').count();
  check('browser one (steward): placing a device saves with no refusal', oneRefusalCount === 0, `refusal divs: ${oneRefusalCount}`);
  const trailRowsAfterFirstSave = await one.locator('.racks-trail__rows').first().locator('> *').count();
  check('browser one (steward): the Trail carries at least one entry after the first save', trailRowsAfterFirstSave >= 1);

  await one.screenshot({ path: `${SHOTS}s7-first-save.png` });
  check('screenshot s7-first-save.png: taken after the first save landed', true);

  const designUrl = one.url();

  // -------------------------------------------------------------------
  // Browser two — the drawer: sign in, open the same design.
  // -------------------------------------------------------------------
  await two.goto(CLIENT_URL, { waitUntil: 'domcontentloaded' });
  await injectEnrolledKey(two, seed.drawer.address, seed.drawer.private_scalar_hex, seed.drawer.public_key_hex);
  await signIn(two, seed.drawer.address);
  check('browser two (drawer): signed in', await two.evaluate(() => document.body.innerText.length > 0));
  // ADR-0046 §3's direct entry fires here: one organisation, one design.
  await two.locator('.drawing-chassis').first().waitFor({ timeout: 15000 });
  check(
    'browser two (drawer): opened the same design (sees browser one\'s placed device)',
    (await two.locator('.drawing-chassis').count()) >= 1,
  );

  // -------------------------------------------------------------------
  // Browser one saves another change.
  // -------------------------------------------------------------------
  await openTheRail(one);
  await dragPaletteItemOntoRack(one, 0, 1);
  await one.waitForFunction(
    () => document.querySelectorAll('.drawing-chassis').length >= 2,
    { timeout: 15000 },
  );
  await one.waitForTimeout(1200);
  check(
    'browser one (steward): a second save lands (two devices now placed)',
    (await one.locator('.drawing-chassis').count()) >= 2,
  );

  // -------------------------------------------------------------------
  // Browser two makes a change against its now-stale base and is refused.
  // -------------------------------------------------------------------
  const twoDevicesBeforeRefusal = await two.locator('.drawing-chassis').count();
  await openTheRail(two);
  await dragPaletteItemOntoRack(two, 1, 1);
  await two.locator('.racks-place__refusal').waitFor({ timeout: 15000 });
  const refusalText = (await two.locator('.racks-place__refusal').first().innerText()).trim();
  console.log('refusal text: ' + JSON.stringify(refusalText));
  check(
    'browser two (drawer): the save is refused, naming both versions in one sentence',
    /version \d+.*version \d+/s.test(refusalText) && /reload/i.test(refusalText),
    refusalText,
  );
  const twoDevicesAfterRefusal = await two.locator('.drawing-chassis').count();
  check(
    "browser two (drawer): the drawer's own change is still on screen after the refusal",
    twoDevicesAfterRefusal === twoDevicesBeforeRefusal + 1,
    `before=${twoDevicesBeforeRefusal} after=${twoDevicesAfterRefusal}`,
  );

  await two.screenshot({ path: `${SHOTS}s7-stale.png` });
  check('screenshot s7-stale.png: the refusal wash in browser two', true);

  // ADR-0054 §1 promises a Reload action inside this wash; there is none —
  // see this script's final report. Substitute: a fresh open (what a person
  // clicking a working Reload would get) re-signs in with the same
  // enrolled key and re-opens the same design, and should show BOTH of
  // browser one's devices with no refusal.
  const noReloadButton = (await two.getByRole('button', { name: /reload/i }).count()) === 0;
  check('ADR-0054 gap found: no Reload control exists in the refusal wash (see report)', noReloadButton);

  await two.goto(designUrl, { waitUntil: 'domcontentloaded' });
  await signIn(two, seed.drawer.address);
  await two.locator('.drawing-chassis').first().waitFor({ timeout: 15000 });
  await two.waitForFunction(() => document.querySelectorAll('.drawing-chassis').length >= 2, { timeout: 15000 });
  check(
    "substitute Reload (fresh sign-in and re-open): shows browser one's two devices, no refusal",
    (await two.locator('.drawing-chassis').count()) >= 2 && (await two.locator('.racks-place__refusal').count()) === 0,
  );

  await stewardCtx.close();
  await drawerCtx.close();
}

async function cleanup() {
  console.log('==> cleaning up');
  if (clientProc) {
    try { process.kill(clientProc.pid); } catch {}
  }
  if (serverProc) {
    try { process.kill(serverProc.pid); } catch {}
  }
  try { sh('fuser', ['-k', `${CLIENT_PORT}/tcp`]); } catch {}
  try { sh('fuser', ['-k', `${SERVER_PORT}/tcp`]); } catch {}
  try {
    sh('psql', ['-h', '127.0.0.1', '-U', 'postgres', '-d', 'postgres', '-c', `DROP DATABASE IF EXISTS ${DB_NAME};`]);
  } catch (error) {
    console.log('could not drop the database: ' + error);
  }
  for (const p of [SEED_TEST_PATH, VITE_CONFIG_PATH, MASTER_KEY_PATH, CHAIN_KEY_PATH, SEED_OUTPUT_PATH, BOOTSTRAP_TOKEN_PATH]) {
    try { rmSync(p, { force: true }); } catch {}
  }
}

try {
  await main();
} catch (error) {
  console.error(error);
  check('the run completed without throwing', false, String(error));
} finally {
  await cleanup();
}

console.log('');
console.log(fails.length === 0 ? 'ALL PASS' : `FAIL: ${fails.length} assertion(s) failed`);
for (const f of fails) console.log('  - ' + f);
process.exit(fails.length === 0 ? 0 : 1);
