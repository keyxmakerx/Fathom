//! Throwaway seed for `scripts/drive-people.mjs`: one organisation with one
//! steward, Ann, whose KEY COMES FROM HER BROWSER. The drive generates a
//! non-extractable keypair in the browser, files it where the client keeps its
//! enrolled key, and passes the public half here, so what Ann's browser signs
//! (invitations confirmed, grants given) verifies against the key the server
//! holds for her. Everyone else joins through the real invitation flow.
//!
//! Accounts, keys and the organisation go in the way `tests/design_api.rs`'s
//! `bootstrap`/`enrol` fixtures do it; the master and chain keys load through
//! the same `KeySource::parse` + `KeyRing::load` call `main.rs` makes, from the
//! same `file://` paths the real server is then started against. Ann also gets a
//! password directly (`tests/credentials.rs`'s `set_password_directly`), so the
//! real sign-in form can be typed into.
//!
//! Written and deleted by the drive.

mod support;

use std::io::Write as _;

use fathom_server::authority::{self, Capability, GrantFacts, SoftwareKey};
use fathom_server::chains;
use fathom_server::credentials;
use fathom_server::crypto::Key32;
use fathom_server::grants::{self, Authority, EpochWatch, GenesisGrant};
use fathom_server::keyprovider::KeySource;
use fathom_server::keys::{self, KeyRing};
use fathom_server::repo;

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

fn unhex(text: &str) -> Vec<u8> {
    (0..text.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&text[i..i + 2], 16).expect("hex"))
        .collect()
}

#[allow(dead_code)]
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
#[allow(dead_code)]
fn fresh_key() -> ([u8; 32], SoftwareKey) {
    let scalar = *Key32::random().expect("OS randomness").expose();
    let key = SoftwareKey::from_bytes(&scalar).expect("a valid P-256 scalar");
    (scalar, key)
}

#[tokio::test]
async fn seed_for_the_people_drive() {
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

    let steward_address =
        std::env::var("SEED_STEWARD_ADDRESS").expect("SEED_STEWARD_ADDRESS (the address Ann signs in as)");
    let steward_public = unhex(
        &std::env::var("SEED_STEWARD_PUBKEY").expect("SEED_STEWARD_PUBKEY (hex SEC1 point from her browser)"),
    );
    let steward_account = repo::create_account(&pool, &steward_address, "Ann Alder")
        .await
        .expect("create the steward's account shell")
        .id;

    let now = now_unix();
    let steward_subject_fpr = authority::key_fingerprint(&steward_public);
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

    enrol(&pool, &ring, organisation, steward_account, &steward_public).await;
    set_password(&pool, &ring, steward_account, "@@STEWARD_PW@@").await;

    let json = format!("{{\"steward\": \"{steward_address}\"}}\n");
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
    public_key: &[u8],
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
    grants::enrol_software_key(&tx, &auth, public_key)
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
