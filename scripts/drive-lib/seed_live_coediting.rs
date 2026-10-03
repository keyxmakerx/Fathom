//! Session 7 proof-builder scaffolding, throwaway: seeds one organisation
//! with a steward (organisation-wide `Capability::Steward`) and a drawer
//! (organisation-wide `Capability::Draw`) directly against the database —
//! exactly the path `tests/design_api.rs`'s own `bootstrap`/`enrol`/
//! `a_member_with` fixtures use (the security-bearing code exercised is the
//! real `grants`/`authority` module, unchanged).
//!
//! **Why this exists instead of driving a scripted browser enrolment**:
//! `client/src/crypto/keys.ts` generates the account keypair with
//! `crypto.subtle.generateKey(..., false, ...)` — non-extractable — and the
//! client has no route that imports a key it did not generate itself. Reaching
//! the real token-redemption route for two accounts needs a real operator
//! session (`admin.rs`'s two-role plane), so this uses the OTHER path this
//! task's brief names instead: seed accounts, keys and organisation-wide
//! capability straight into the database, holding the raw P-256 scalar for
//! both accounts (still needed here: the authority/grants system signs with
//! it, independent of how a browser session is opened).
//!
//! **Since ADR-0056, sign-in is a password.** Rather than pull the scalar
//! above into a browser's non-extractable key store, this seed also gives
//! each account a real password directly against `accounts.password_hash`
//! — the same shape `tests/credentials.rs`'s own `set_password_directly`
//! fixture uses: `credentials::hash_password` and `credentials::seal_for_write`
//! in the one statement `0025`'s own constraint trigger requires. Neither
//! account ever confirms an authenticator, so `sessions.rs`'s branch 2
//! ("otherwise A0, which is a full session for a steward with no app code")
//! is what a real sign-in reaches on the password alone — `SignIn.tsx`'s
//! real form, typed into, the real `signIn()` challenge/response exchange
//! and the real server-side password verification run completely unmodified.
//!
//! The master and chain keys are loaded through the SAME `KeySource::parse`
//! + `KeyRing::load(..., true)` call `main.rs` makes at real startup, from
//! the same `file://` paths the real `fathom-server` binary is then started
//! against, so the sealed rows this binary writes are readable by that real
//! server afterward.
//!
//! Not committed as a permanent fixture: written and deleted by
//! `scripts/drive-first-design.mjs`.

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

#[allow(dead_code)]
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
/// `SoftwareKey` built from it — unlike `SoftwareKey::random()`, which never
/// hands the scalar back.
fn fresh_key() -> ([u8; 32], SoftwareKey) {
    let scalar = *Key32::random().expect("OS randomness").expose();
    let key = SoftwareKey::from_bytes(&scalar).expect("a valid P-256 scalar");
    (scalar, key)
}

#[tokio::test]
async fn seed_for_the_live_coediting_drive() {
    let master_spec =
        std::env::var("FATHOM_MASTER_KEY").expect("FATHOM_MASTER_KEY (file:// spec) must be set");
    let chain_spec =
        std::env::var("FATHOM_CHAIN_KEY").expect("FATHOM_CHAIN_KEY (file:// spec) must be set");
    let output_path =
        std::env::var("SEED_OUTPUT").expect("SEED_OUTPUT (a file path to write JSON to)");

    let master_source = KeySource::parse(&master_spec).expect("a valid FATHOM_MASTER_KEY spec");
    let chain_source = KeySource::parse(&chain_spec).expect("a valid FATHOM_CHAIN_KEY spec");
    // `create_if_missing = true`, exactly like `main.rs`'s own startup call —
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
    // The organisation and its steward — `tests/design_api.rs`'s
    // `bootstrap()`, verbatim in shape, except the steward's scalar is kept
    // rather than thrown away.
    // ------------------------------------------------------------------
    let root = SoftwareKey::random().expect("an organisation root keypair");
    let salt = [0x5au8; 16];
    let organisation_id = authority::derive_organisation_id(&root.public_key(), &salt);
    let root_fpr = authority::key_fingerprint(&root.public_key());

    let steward_address = unique("steward");
    let steward_account = repo::create_account(&pool, &steward_address, "Ann Alder")
        .await
        .expect("create the steward's account shell")
        .id;
    let (_steward_scalar, steward_key) = fresh_key();

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
    set_password(&pool, &ring, steward_account, "@@STEWARD_PW@@").await;

    // ------------------------------------------------------------------
    // Two more members: a drawer (Capability::Draw) and a reader
    // (Capability::Read), each the shape of `a_member_with`.
    // ------------------------------------------------------------------
    let drawer_address = unique("drawer");
    let reader_address = unique("reader");
    for (address, name, capability, password) in [
        (&drawer_address, "Bob Birch", Capability::Draw, "@@DRAWER_PW@@"),
        (&reader_address, "Cy Cedar", Capability::Read, "@@READER_PW@@"),
    ] {
        let account = repo::create_account(&pool, address, name)
            .await
            .expect("create the account shell")
            .id;
        repo::add_member(&pool, organisation, steward_account, account, Role::Member)
            .await
            .expect("membership");
        let (_scalar, key) = fresh_key();
        enrol(&pool, &ring, organisation, account, &key).await;
        set_password(&pool, &ring, account, password).await;

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
                subject: account,
                capability,
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

    let json = format!(
        "{{\"steward\": \"{steward_address}\", \"drawer\": \"{drawer_address}\", \"reader\": \"{reader_address}\"}}\n"
    );
    let mut file = std::fs::File::create(&output_path).expect("create SEED_OUTPUT");
    file.write_all(json.as_bytes()).expect("write SEED_OUTPUT");
}

/// `tests/design_api.rs`'s own `enrol`, verbatim: enrol `key`'s public half
/// for `account` inside `organisation`.
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

/// `tests/credentials.rs`'s own `set_password_directly`, verbatim: a
/// password set without a session, the way `/enrolment/operator/setup` and
/// `/credentials/reset/redeem` do — used only to bootstrap this fixture into
/// the state this proof is actually about. The hash and its seal go in ONE
/// statement, the shape `0025`'s own constraint trigger requires of anything
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
        "UPDATE accounts SET password_hash = $2, credential_seal = $3,                 credential_row_version = $4, credential_seq = $5           WHERE id = $1",
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
