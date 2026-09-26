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
// `bootstrap`/`enrol`/`a_member_with` there verbatim).
//
// **Since ADR-0056, sign-in is a password (and, only for an account with a
// confirmed authenticator, a verification code too) — the smaller of the two
// changes this task's brief offers.** Rather than reach for the browser's
// non-extractable key machinery at all, the seed now also sets a real
// password on each account directly against the `accounts` table, the same
// shape `crates/fathom-server/tests/credentials.rs`'s own
// `set_password_directly` fixture uses ("the way `/enrolment/operator/setup`
// and `/credentials/reset/redeem` do — used only to bootstrap a fixture into
// the state a test is actually about"): `credentials::hash_password` plus
// `credentials::seal_for_write`, the two calls `0025`'s own constraint
// trigger requires together in one statement. Neither account ever confirms
// an authenticator, so `sessions.rs`'s branch 2 ("`password_hash IS NOT
// NULL`... otherwise A0, which is a full session for a steward with no app
// code") is what a real sign-in reaches with the password alone — the real,
// unmodified `SignIn.tsx` form, typed into, exactly as a person would.
//
// Usage:
//   node scripts/drive-first-design.mjs
//
// Cleans up after itself: stops the server and the client, drops the
// database, deletes every file it wrote (the seed test, the two key files,
// the bootstrap token, the throwaway Vite config, the seed JSON).
//
// **Current UI facts this drive learns, that an older one would not**: the
// trail is folded to a strip on the right edge — `button[aria-label="Open
// the trail"]` before reading a `.racks-trail__row`; the levels are named
// Site › Building › Closet in the interface, so the organisation-level
// scope-creation button reads "New site", not "New scope".

import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrateUrl, runtimeUrl, superuserUrl } from './drive-lib/db.mjs';

const pw = await import(
  process.env.PW_PLAYWRIGHT || '/opt/node22/lib/node_modules/playwright/index.js'
);
const { chromium } = pw.default ?? pw;

const ROOT = process.env.FATHOM_ROOT
  || resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = process.env.PW_CHROMIUM
  || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const CLIENT = ROOT + '/client';
// As the other real-server drives: a given binary, else the (possibly shared) target dir.
const TARGET_DIR = process.env.CARGO_TARGET_DIR ?? resolve(ROOT, 'target');
const SERVER_BIN = process.env.FATHOM_SERVER_BIN ?? resolve(TARGET_DIR, 'debug', 'fathom-server');
const SHOTS = `${process.env.FATHOM_SHOTS ?? join(tmpdir(), 'fathom-shots')}/`;
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
// The setup password the server starts with (ADR-0057).
const SETUP_PASSWORD = 'amber-kestrel-harbour-0057';
const OPERATOR_ADDRESS = 'operator@fathom.invalid';
const SEED_TEST_PATH = `${ROOT}/crates/fathom-server/tests/seed_first_design.rs`;
const VITE_CONFIG_PATH = `${CLIENT}/vite.drive-first-design.config.ts`;

const MIGRATE_URL = migrateUrl(DB_NAME);
const SUPERUSER_URL = superuserUrl(DB_NAME);
const RUNTIME_URL = runtimeUrl(DB_NAME);

// ADR-0055 decision 10: 15 to 128 characters, no composition rules. Neither
// account confirms an authenticator, so the real sign-in form never asks
// either of these for a verification code (`sessions.rs` branch 2's "A0").
const STEWARD_PASSWORD = 'session-seven-steward-passphrase-kept-for-this-proof-only';
const DRAWER_PASSWORD = 'session-seven-drawer-passphrase-kept-for-this-proof-only';

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
//! both accounts (still needed here: the authority/grants system signs with
//! it, independent of how a browser session is opened).
//!
//! **Since ADR-0056, sign-in is a password.** Rather than pull the scalar
//! above into a browser's non-extractable key store, this seed also gives
//! each account a real password directly against \`accounts.password_hash\`
//! — the same shape \`tests/credentials.rs\`'s own \`set_password_directly\`
//! fixture uses: \`credentials::hash_password\` and \`credentials::seal_for_write\`
//! in the one statement \`0025\`'s own constraint trigger requires. Neither
//! account ever confirms an authenticator, so \`sessions.rs\`'s branch 2
//! ("otherwise A0, which is a full session for a steward with no app code")
//! is what a real sign-in reaches on the password alone — \`SignIn.tsx\`'s
//! real form, typed into, the real \`signIn()\` challenge/response exchange
//! and the real server-side password verification run completely unmodified.
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
use fathom_server::credentials;
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
    set_password(&pool, &ring, steward_account, "${STEWARD_PASSWORD}").await;

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
    set_password(&pool, &ring, drawer_account, "${DRAWER_PASSWORD}").await;

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

/// \`tests/credentials.rs\`'s own \`set_password_directly\`, verbatim: a
/// password set without a session, the way \`/enrolment/operator/setup\` and
/// \`/credentials/reset/redeem\` do — used only to bootstrap this fixture into
/// the state this proof is actually about. The hash and its seal go in ONE
/// statement, the shape \`0025\`'s own constraint trigger requires of anything
/// that puts a first credential on a row.
async fn set_password(pool: &deadpool_postgres::Pool, ring: &KeyRing, account: fathom_server::repo::AccountId, password: &str) {
    let hash = credentials::hash_password(password).expect("hash the seed password");
    let mut client = pool.get().await.expect("connection");
    let tx = client.transaction().await.expect("begin");
    tx.execute("SELECT set_config('app.reset_custody', 'yes', true)", &[])
        .await
        .expect("reset custody");
    let account_text = account.to_string();
    let mut next = credentials::read_credentials(&tx, ring, &account_text)
        .await
        .expect("read credentials")
        .expect("the account exists");
    next.password_hash = Some(hash.clone());
    let seal = credentials::seal_for_write(&tx, ring, &account_text, &mut next, None)
        .await
        .expect("seal the credential columns");
    tx.execute(
        "UPDATE accounts SET password_hash = $2, credential_seal = $3, \
                credential_row_version = $4, credential_seq = $5 \
          WHERE id = $1",
        &[
            &account_text,
            &hash,
            &seal,
            &next.credential_row_version,
            &next.seq_column(),
        ],
    )
    .await
    .expect("set the password");
    tx.commit().await.expect("commit");
}
`;

let serverProc = null;
let clientProc = null;

async function main() {
  console.log(`==> database ${DB_NAME}`);
  sh('psql', ['-d', superuserUrl('postgres'), '-c', `CREATE DATABASE ${DB_NAME} OWNER fathom_test;`]);

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

  if (!process.env.FATHOM_SERVER_BIN) {
    console.log('==> building fathom-server');
    sh('cargo', ['build', '-p', 'fathom-server'], { cwd: ROOT, stdio: 'inherit' });
  }

  console.log('==> starting fathom-server on ' + SERVER_URL);
  serverProc = spawn(SERVER_BIN, [], {
    cwd: ROOT,
    env: {
      ...process.env,
      DATABASE_URL: RUNTIME_URL,
      FATHOM_MIGRATE_DATABASE_URL: MIGRATE_URL,
      FATHOM_SCHEMA_ROOT: `${ROOT}/schema`,
      FATHOM_MASTER_KEY: `file://${MASTER_KEY_PATH}`,
      FATHOM_CHAIN_KEY: `file://${CHAIN_KEY_PATH}`,
      FATHOM_OPERATOR_NOTICE_ADDRESS: OPERATOR_ADDRESS,
      FATHOM_SETUP_PASSWORD: SETUP_PASSWORD,
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
    // Finish the operator's first run, so the stewards get the sign-in page.
    // Async, so the server's piped output keeps draining meanwhile.
    const firstRun = await new Promise((resolve) => {
      spawn('node', [`${ROOT}/scripts/ci/first-operator-signin.mjs`, SETUP_PASSWORD, OPERATOR_ADDRESS, SERVER_URL], { stdio: 'inherit' })
        .on('exit', resolve);
    });
    check('the operator finished first run (ci/first-operator-signin.mjs)', firstRun === 0, `exit ${firstRun}`);
    if (firstRun !== 0) throw new Error('first run did not complete');
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

/** ADR-0056: the real, unmodified `SignIn.tsx` form — an address, a
 * password, and (skipped here: neither seeded account confirms an
 * authenticator, `sessions.rs` branch 2's "A0") no verification code. */
async function signIn(page, address, password) {
  await page.goto(CLIENT_URL, { waitUntil: 'domcontentloaded' });
  await page.locator('#signin-address').fill(address);
  await page.locator('#signin-password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  // Home, or straight into the design when it is the only one (ADR-0046 §3).
  await page.getByText('Your organisations').or(page.locator('.racks-place__loading, .drawing-chassis')).first().waitFor({ timeout: 15000 });
}

/** The trail is folded to a strip on the right edge — open it before
 * reading a `.racks-trail__row`. */
async function openTheTrail(page) {
  const handle = page.locator('button[aria-label="Open the trail"]');
  if ((await handle.count()) > 0) {
    await handle.click();
  }
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
  // Headless Chromium can pause drawing in a tab that is not in front,
  // which leaves the diagram unmeasured; bring each tab forward before using it.
  await one.bringToFront();
  await one.goto(CLIENT_URL, { waitUntil: 'domcontentloaded' });
  await signIn(one, seed.steward.address, STEWARD_PASSWORD);
  check('browser one (steward): signed in and Home rendered', await one.getByText('Your organisations').isVisible());

  // Previously (see this script's git history): `client/src/api/scopes.ts`'s
  // `createScope` sent a JSON body while the real server's
  // `create_scope_handler` read `LP(parent) ‖ LP(label)`, so this same click
  // was refused 400 "malformed request" and this script worked around it
  // with a hand-built `signedFetch` call. `scopes.ts`'s `createScope` now
  // sends that same LP-framed body (unchanged by this task), so the real,
  // unmodified "New site" → "Create" form is driven directly here instead.
  // (The owner's naming, 2026-09-23: the top scope level reads "Site" in
  // the interface, not "New scope".)
  await one.getByRole('button', { name: 'New site' }).click();
  await one.locator('#home-new-scope-label').fill('Session 7 network');
  await one.getByRole('button', { name: 'Create', exact: true }).click();
  await one.getByText('Session 7 network').waitFor({ timeout: 10000 });
  check('browser one (steward): the new scope appears on Home (created via the real "New site" form)', await one.getByText('Session 7 network').isVisible());

  await one.screenshot({ path: `${SHOTS}s7-home.png` });
  check(
    'screenshot s7-home.png: Home shows New site and New design',
    (await one.getByRole('button', { name: 'New site' }).count()) > 0
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
  await openTheTrail(one); // folded to a strip on the right edge
  // GitHub issue #66's own brief item 4: `.racks-trail__row`, never `> *` of
  // `.racks-trail__rows` — an empty-state line (no changes yet) is a direct
  // child of that wrapper too, and is not itself a row; counting `> *`
  // would pass on an empty Trail exactly as easily as a real one.
  const trailRowsAfterFirstSave = await one.locator('.racks-trail__rows').first().locator('.racks-trail__row').count();
  check('browser one (steward): the Trail carries at least one entry after the first save', trailRowsAfterFirstSave >= 1);

  // FOUND BUG, now fixed (`components/racks/RacksPlace.tsx`'s `handlePlace`):
  // this drop mints a Premises and a Rack (`ensureRackToPlaceInto`) and then
  // places the Chassis (`placeChassis`) — every one of those three calls
  // used to dispatch with no `Actor` opts at all, so
  // `document/commands.ts`'s own `resolve` fell back to
  // `document/model.ts`'s `LOCAL_ACTOR` even while the steward is really
  // signed in, and the Trail's newest row (`components/racks/trail.ts`'s
  // `whoLabel`) read `'local'` for every one of the three rows this drop
  // produced. Asserted here against the newest row, the one this drop just
  // made.
  const newestWho = (await one.locator('.racks-trail__row').first().locator('.racks-trail__col--who').innerText()).trim();
  check(
    "browser one (steward): the Trail's newest row names the signed-in account, not 'local' (LOCAL_ACTOR)",
    newestWho !== 'local' && newestWho.length > 0,
    `who: ${JSON.stringify(newestWho)}`,
  );

  // The Ctrl Z half of this same check (does undo actually go through, now
  // that the batch is attributed rather than LOCAL_ACTOR) runs at the very
  // end of this proof instead of here: undoing this batch removes the one
  // device browser two is about to open the design and look for, and would
  // also perturb the version numbers the stale-save section below depends
  // on. See the end of `runProof`.

  await one.screenshot({ path: `${SHOTS}s7-first-save.png` });
  check('screenshot s7-first-save.png: taken after the first save landed', true);

  const designUrl = one.url();

  // -------------------------------------------------------------------
  // Browser two — the drawer: sign in, open the same design.
  // -------------------------------------------------------------------
  await two.bringToFront();
  await two.goto(CLIENT_URL, { waitUntil: 'domcontentloaded' });
  await signIn(two, seed.drawer.address, DRAWER_PASSWORD);
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
  await one.bringToFront();
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
  await two.bringToFront();
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

  // ADR-0054 §1 promises a Reload action inside this wash; a prior run of
  // this script (see its own git history) found none rendered and worked
  // around it with a fresh navigation and re-sign-in. `RacksPlace.tsx` now
  // renders a real `.racks-place__refusal-reload` button beside the
  // refusal text (unchanged by this task) — asserted directly here instead
  // of asserting its absence, then clicked, since the in-memory-only
  // session (`state/sessionState.ts`'s own doc) does not survive a
  // navigation and this route still needs a fresh sign-in either way.
  const hasReloadButton = (await two.getByRole('button', { name: /reload/i }).count()) > 0;
  check('the refusal wash renders a real Reload control (ADR-0054 §1)', hasReloadButton);

  await two.goto(designUrl, { waitUntil: 'domcontentloaded' });
  await signIn(two, seed.drawer.address, DRAWER_PASSWORD);
  await two.locator('.drawing-chassis').first().waitFor({ timeout: 15000 });
  await two.waitForFunction(() => document.querySelectorAll('.drawing-chassis').length >= 2, { timeout: 15000 });
  check(
    "a fresh sign-in and re-open (what clicking Reload does) shows browser one's two devices, no refusal",
    (await two.locator('.drawing-chassis').count()) >= 2 && (await two.locator('.racks-place__refusal').count()) === 0,
  );

  // ADR-0053 §1/§3 — the Ctrl Z half of the "not 'local'" check earlier in
  // this proof: only a batch attributed to a real account can be undone at
  // all (`document/undo.ts`'s `conflict`: an unattributed, `LOCAL_ACTOR`-
  // stamped batch refuses with `{ kind: 'unattributed' }`, which the Trail
  // shows as `.racks-trail__refusal`). With the actor now really threaded
  // through `RacksPlace.tsx`'s `handlePlace`/`handleMove`, Ctrl Z undoes
  // browser one's own last placement with no such refusal. Run last, once
  // nothing else in this proof still depends on the device count or the
  // design's saved version.
  const chassisBeforeUndo = await one.locator('.drawing-chassis').count();
  await one.bringToFront();
  await one.keyboard.press('Control+z');
  await one
    .waitForFunction(
      (before) => document.querySelectorAll('.drawing-chassis').length < before,
      chassisBeforeUndo,
      { timeout: 5000 },
    )
    .catch(() => {});
  const chassisAfterUndo = await one.locator('.drawing-chassis').count();
  const undoRefusalAfterUndo = await one.locator('.racks-trail__refusal').count();
  check(
    'browser one (steward): Ctrl Z undoes its own last placement — attributed to a real account, not refused as unattributed',
    chassisAfterUndo === chassisBeforeUndo - 1 && undoRefusalAfterUndo === 0,
    `chassis before=${chassisBeforeUndo} after=${chassisAfterUndo}, undo refusal divs: ${undoRefusalAfterUndo}`,
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
    sh('psql', ['-d', superuserUrl('postgres'), '-c', `DROP DATABASE IF EXISTS ${DB_NAME};`]);
  } catch (error) {
    console.log('could not drop the database: ' + error);
  }
  for (const p of [SEED_TEST_PATH, VITE_CONFIG_PATH, MASTER_KEY_PATH, CHAIN_KEY_PATH, SEED_OUTPUT_PATH]) {
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
