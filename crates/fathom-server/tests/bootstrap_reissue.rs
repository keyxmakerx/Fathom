//! **The way back into a deployment whose first-operator token was lost, and
//! the refusal that stops it being a backdoor.**
//!
//! `docs/PHASE-2-ADMIN-AND-AUDIT-DESIGN.md` §6.3, §7.2;
//! `operators::OperatorStore::reissue_bootstrap_token`.
//!
//! §6.3's enrolment token is handed out once, into a file, and it is the only
//! way into a new deployment. Lose it and nothing re-bootstraps: an operator
//! row exists, so the first-start path is closed, and the token is gone. The
//! re-issue closes that hole — and the whole of its safety is one condition,
//! which is what most of this file is about:
//!
//! > **once any operator key is enrolled, a re-issue is refused.**
//!
//! Without that, anybody who can run a command on the host could mint
//! themselves an operator enrolment token, redeem it with a key of their own,
//! and hold an operator session, without ever holding a key this deployment
//! has seen. [`reissue_is_refused_once_an_operator_key_is_enrolled`] is the
//! test that matters here; the rest prove the thing works at all and that it
//! does not leak what it mints.
//!
//! **Every test gets a deployment of its own**, for `tests/operators.rs`'s
//! reason and one more: the state under test is "a deployment with a first
//! operator and NO enrolled key", which exists for about one second in the
//! life of a real installation and cannot be shared between tests.

mod support;

use std::sync::Arc;
use std::time::Duration;

use deadpool_postgres::Pool;
use fathom_server::authority::SoftwareKey;
use fathom_server::chain::EntryType;
use fathom_server::chains;
use fathom_server::crypto::Key32;
use fathom_server::keys::KeyRing;
use fathom_server::operators::{OperatorError, OperatorStore};

/// The same master key every other suite in this crate uses: ADR-0043 §4
/// stamps the configured key's id per database and refuses a second.
const MASTER: [u8; 32] = [21; 32];

fn ring() -> Arc<KeyRing> {
    Arc::new(KeyRing::from_keys(
        Key32::from_bytes(MASTER),
        Key32::from_bytes(support::SITE_CHAIN_MASTER),
    ))
}

/// A fresh deployment with its identity stamped, exactly as `main.rs` does at
/// startup, and an operator store over it.
async fn deployment(tag: &str, ring: Arc<KeyRing>) -> (Pool, OperatorStore) {
    let pool = support::isolated_deployment(tag).await;
    let client = pool.get().await.expect("connection");
    let id = chains::register_deployment(&**client)
        .await
        .expect("stamp the deployment id, exactly as main.rs does at startup");
    drop(client);
    let store = OperatorStore::with_delay(pool.clone(), ring, id, true, Duration::from_secs(1));
    (pool, store)
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

/// Count site-chain entries of one type, as the superuser sees them — so a
/// test can assert an act did or did not land on the chain without holding the
/// chain key.
async fn site_entries_of(tag: &str, entry_type: &str) -> i64 {
    support::superuser_on_isolated(tag)
        .await
        .query_one(
            "SELECT count(*) FROM chain_entries WHERE chain_kind = 'site' AND entry_type = $1",
            &[&entry_type],
        )
        .await
        .expect("count entries")
        .get(0)
}

async fn enrolment_token_rows(tag: &str) -> i64 {
    support::superuser_on_isolated(tag)
        .await
        .query_one("SELECT count(*) FROM enrolment_tokens", &[])
        .await
        .expect("count tokens")
        .get(0)
}

// ---------------------------------------------------------------------------
// The refusal that matters
// ---------------------------------------------------------------------------

/// **Once an operator key is enrolled, the first operator's enrolment token
/// cannot be re-issued.**
///
/// This is the test the whole subcommand has to earn. A re-issue that still
/// worked here would be a way for anyone who can run a command on this host —
/// a backup operator, a CI runner, anybody who talks their way onto the box —
/// to mint an operator enrolment token, redeem it with a keypair they
/// generated, and hold an operator session. Every other control on the
/// operator plane (§4.5's "an operator session is `A1` or it does not exist",
/// §5.5's two assertions, §5.3's delay) assumes the keyring is the fence. This
/// would go round all of them at once.
///
/// The refusal is asserted three ways, because any one of them alone could be
/// true while the act still happened: the error, the absence of a new token
/// row, and the absence of a new sealed entry.
#[tokio::test]
async fn reissue_is_refused_once_an_operator_key_is_enrolled() {
    const TAG: &str = "reissue_after_enrolment";
    let ring = ring();
    let (_pool, store) = deployment(TAG, Arc::clone(&ring)).await;

    let bootstrap = store
        .bootstrap_first_operator(&unique("Installer"), &unique("notice@example.org"))
        .await
        .expect("a deployment with no operator bootstraps one");

    // The first operator enrols a key, which is the ordinary thing that
    // happens within minutes of a first start.
    let key = SoftwareKey::random().expect("a keypair");
    store
        .redeem_operator_enrolment(&bootstrap.invitation.token, &key.public_key())
        .await
        .expect("the first operator redeems the token from the token file");

    let tokens_before = enrolment_token_rows(TAG).await;
    let issued_before = site_entries_of(TAG, "enrolment_token_issued").await;

    match store.reissue_bootstrap_token().await {
        Err(OperatorError::AlreadyEnrolled) => {}
        Err(other) => panic!("refused, but for the wrong reason: {other}"),
        Ok(_) => panic!(
            "A RE-ISSUE AFTER ENROLMENT IS A BACKDOOR. Whoever can run a command on this host \
             just minted themselves an operator enrolment token."
        ),
    }

    // The refusal says what the way back in actually is, because an operator
    // reading it at three in the morning is the person this message is for.
    let said = OperatorError::AlreadyEnrolled.to_string();
    assert!(
        said.contains("another operator") && said.contains("restore"),
        "the refusal must name the remedy: {said}"
    );

    assert_eq!(
        enrolment_token_rows(TAG).await,
        tokens_before,
        "a refused re-issue must not leave a token row behind"
    );
    assert_eq!(
        site_entries_of(TAG, "enrolment_token_issued").await,
        issued_before,
        "a refused re-issue must not append an issuance to the site chain"
    );
}

/// **A disabled key is still a key.** The gate counts every row in
/// `operator_keys`, live or retired, and this is why: a deployment where the
/// only operator's key was retired is a deployment with a key history, and the
/// way back in is another operator or a restore — not a command on the host
/// that mints a fresh one.
#[tokio::test]
async fn reissue_is_refused_even_when_the_enrolled_key_is_no_longer_in_service() {
    const TAG: &str = "reissue_retired_key";
    let ring = ring();
    let (_pool, store) = deployment(TAG, Arc::clone(&ring)).await;

    let bootstrap = store
        .bootstrap_first_operator(&unique("Installer"), &unique("notice@example.org"))
        .await
        .expect("bootstrap");
    let key = SoftwareKey::random().expect("a keypair");
    store
        .redeem_operator_enrolment(&bootstrap.invitation.token, &key.public_key())
        .await
        .expect("enrol");

    // Retired in the database directly: there is no console verb that retires
    // an operator key without a second operator, and what is under test is the
    // COUNT, not the path that got the row into that state.
    support::superuser_on_isolated(TAG)
        .await
        .execute("UPDATE operator_keys SET retired_at = now()", &[])
        .await
        .expect("retire the key");

    assert!(
        matches!(
            store.reissue_bootstrap_token().await,
            Err(OperatorError::AlreadyEnrolled)
        ),
        "a key that was enrolled and then retired is still an enrolment that happened"
    );
}

// ---------------------------------------------------------------------------
// That it works at all, before enrolment
// ---------------------------------------------------------------------------

/// **A re-issued token enrols the first operator, lands on the site chain, and
/// kills the token it replaces.**
///
/// The deployment this describes is the one the change exists for: a first
/// start happened, an operator row exists, and nobody can find the token file.
#[tokio::test]
async fn a_reissued_token_enrols_the_first_operator_and_the_old_one_stops_working() {
    const TAG: &str = "reissue_before_enrolment";
    let ring = ring();
    let (pool, store) = deployment(TAG, Arc::clone(&ring)).await;

    let bootstrap = store
        .bootstrap_first_operator(&unique("Installer"), &unique("notice@example.org"))
        .await
        .expect("bootstrap");
    let lost = bootstrap.invitation.token;

    let expired_before = site_entries_of(TAG, "enrolment_token_expired").await;
    let reissued = store
        .reissue_bootstrap_token()
        .await
        .expect("no operator key is enrolled, so the token can be re-issued");

    assert_eq!(
        reissued.operator_id, bootstrap.operator_id,
        "the token is for the operator the first start created, not for a new one"
    );
    assert_ne!(
        reissued.invitation.token, lost,
        "a fresh token, not the same one read back"
    );
    assert_eq!(
        reissued.expired,
        vec![bootstrap.invitation.id.clone()],
        "the token it replaces is expired in the same transaction: two live tokens for one \
         enrolment is two bearer secrets"
    );
    assert_eq!(
        site_entries_of(TAG, "enrolment_token_expired").await,
        expired_before + 1,
        "expiring the old token is a sealed act like every other (§7.2)"
    );

    // The lost token is dead. If it turned up in a backup, in a terminal
    // buffer or in whatever the operator was worried about, it is no longer a
    // way in.
    let someone_else = SoftwareKey::random().expect("a keypair");
    assert!(
        matches!(
            store
                .redeem_operator_enrolment(&lost, &someone_else.public_key())
                .await,
            Err(OperatorError::EnrolmentRefused)
        ),
        "the replaced token must not still enrol"
    );

    // And the new one works, which is the point of the exercise.
    let key = SoftwareKey::random().expect("a keypair");
    store
        .redeem_operator_enrolment(&reissued.invitation.token, &key.public_key())
        .await
        .expect("the re-issued token enrols the first operator's key");

    // The issuance is on the site chain, sealed, and its metadata says how it
    // came about — `bootstrap_reissue`, not `bootstrap` — so an auditor
    // holding the chain key can tell a token minted from the host command line
    // from one minted by a console the deployment was already using.
    let mut client = pool.get().await.expect("connection");
    let tx = client.transaction().await.expect("transaction");
    let entry = chains::read_site_entry_verified(&tx, &ring, reissued.issued_seq)
        .await
        .expect("read the entry")
        .expect("the seq the re-issue reported must hold an entry");
    assert_eq!(entry.entry_type, EntryType::EnrolmentTokenIssued);
    let metadata = String::from_utf8_lossy(&entry.metadata).to_string();
    assert!(
        metadata.contains("bootstrap_reissue"),
        "the sealed metadata must say this was a re-issue: {metadata}"
    );
    assert!(
        metadata.contains(&reissued.operator_id),
        "and which operator it was for: {metadata}"
    );

    // The whole chain still verifies afterwards, which is the claim every
    // sealed act in this product makes and the one a new writer is most likely
    // to break.
    let report = chains::verify_site(&tx, &ring, true)
        .await
        .expect("verification runs");
    assert!(
        matches!(
            report.outcome,
            fathom_server::chain::Outcome::Verified { .. }
        ),
        "the site chain must still verify after a re-issue: {}",
        report.summary()
    );
}

/// **A deployment that has never started has nothing to re-issue for.** The
/// command must not be a second way to create the first operator — that is
/// §6.3's first start, under its own advisory lock, writing its own
/// `operator_bootstrapped` entry.
#[tokio::test]
async fn there_is_nothing_to_reissue_before_a_first_start() {
    const TAG: &str = "reissue_never_started";
    let ring = ring();
    let (_pool, store) = deployment(TAG, Arc::clone(&ring)).await;

    assert!(
        matches!(
            store.reissue_bootstrap_token().await,
            Err(OperatorError::NotFound("first operator"))
        ),
        "with no operator row, this refuses rather than creating one"
    );
    assert_eq!(
        site_entries_of(TAG, "operator_bootstrapped").await,
        0,
        "and it certainly does not bootstrap"
    );
}

// ---------------------------------------------------------------------------
// The shipped binary, run as an operator would run it
// ---------------------------------------------------------------------------

/// A directory of this test's own, mode 0700, for the key files and the token
/// file. No `tempfile` crate: `scripts/gate-zero.sh` fails on an unapproved
/// dependency, and this is a `mkdir` and an `rm -r`.
struct Scratch(std::path::PathBuf);

impl Scratch {
    fn new(tag: &str) -> Self {
        let dir = std::env::temp_dir().join(format!(
            "fathom-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).expect("create the scratch directory");
        std::fs::set_permissions(&dir, std::os::unix::fs::PermissionsExt::from_mode(0o700))
            .expect("0700 on the scratch directory");
        Self(dir)
    }

    /// A key file the way ADR-0043 §1 wants one: 32 raw bytes, mode 0400.
    /// `keyprovider::load_file` refuses anything more permissive, which is
    /// itself worth exercising from a test that writes the file by hand.
    fn key_file(&self, name: &str, bytes: [u8; 32]) -> std::path::PathBuf {
        use std::io::Write as _;
        use std::os::unix::fs::OpenOptionsExt as _;
        let path = self.0.join(name);
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o400)
            .open(&path)
            .expect("create the key file");
        file.write_all(&bytes).expect("write the key file");
        path
    }

    fn path(&self, name: &str) -> std::path::PathBuf {
        self.0.join(name)
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// Run the shipped binary's subcommand with a deliberately empty environment,
/// and hand back everything it exited with and everything it printed.
fn run_reissue(
    database_url: &str,
    keys: (&std::path::Path, &std::path::Path),
    token: &std::path::Path,
) -> (std::process::Output, String) {
    let output = std::process::Command::new(env!("CARGO_BIN_EXE_fathom-server"))
        .arg("reissue-bootstrap-token")
        // Cleared, not extended: this test binary's own environment holds a
        // DATABASE_URL pointing at a different database, and a subcommand that
        // silently picked it up would be a test proving nothing about the
        // deployment it claims to describe.
        .env_clear()
        .env("DATABASE_URL", database_url)
        .env("FATHOM_MASTER_KEY", format!("file://{}", keys.0.display()))
        .env("FATHOM_CHAIN_KEY", format!("file://{}", keys.1.display()))
        .env("FATHOM_BOOTSTRAP_TOKEN_FILE", token)
        .env("FATHOM_LOG", "info")
        .output()
        .expect("run the shipped binary");
    let said = format!(
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    (output, said)
}

/// **`fathom-server reissue-bootstrap-token`, run as an operator would run
/// it**: it writes the token to the file the deployment named, it never prints
/// it, it refuses to overwrite a file that is already there, and once a key is
/// enrolled it refuses outright.
///
/// This one runs the SHIPPED BINARY rather than calling into the library,
/// because two of those four claims are about what a program prints and what
/// it exits with, and the only honest way to prove that is to run it and read
/// what it printed.
#[tokio::test]
async fn the_command_writes_the_token_to_the_file_and_never_to_its_output() {
    const TAG: &str = "reissue_cli";
    let scratch = Scratch::new(TAG);

    // The binary loads its keys from files; this test's own store has to be
    // the same keyring, or the entries it wrote at bootstrap would not verify
    // under the ones the binary loads. Same bytes, two ways in.
    let master = [31u8; 32];
    let chain = [32u8; 32];
    let master_file = scratch.key_file("master.key", master);
    let chain_file = scratch.key_file("chain.key", chain);
    let token_file = scratch.path("first-operator-token");

    let ring = Arc::new(KeyRing::from_keys(
        Key32::from_bytes(master),
        Key32::from_bytes(chain),
    ));
    let (_pool, store) = deployment(TAG, Arc::clone(&ring)).await;
    store
        .bootstrap_first_operator(&unique("Installer"), &unique("notice@example.org"))
        .await
        .expect("a first start, whose token file this operator then lost");

    let url = support::isolated_database_url(TAG);
    let keys = (master_file.as_path(), chain_file.as_path());

    // ---- the re-issue itself ------------------------------------------
    let (output, said) = run_reissue(&url, keys, &token_file);
    assert!(
        output.status.success(),
        "the re-issue must succeed before any key is enrolled: {said}"
    );

    let written = std::fs::read_to_string(&token_file).expect("the token file must exist");
    let token = hex_to_32(written.trim());

    // THE CLAIM. Every form the token could take in a log line: the hex the
    // file holds, upper case, and the `Debug` of the byte array.
    for form in [
        written.trim().to_string(),
        written.trim().to_uppercase(),
        format!("{token:?}"),
    ] {
        assert!(
            !said.contains(&form),
            "the token appeared in what the command printed. Logs are shipped off the box by \
             design (audit.rs), and a token in a log is a token in whatever holds the logs.\n\
             output was:\n{said}"
        );
    }
    // The path is named, though: an operator has to be told where to look.
    assert!(
        said.contains(&token_file.display().to_string()),
        "the path must be in the output even though the token never is: {said}"
    );

    let mode = std::os::unix::fs::PermissionsExt::mode(
        &std::fs::metadata(&token_file).expect("stat").permissions(),
    ) & 0o777;
    assert_eq!(mode, 0o400, "a bearer token is readable by its owner alone");

    // ---- a file that is already there is not overwritten ---------------
    let (again, said_again) = run_reissue(&url, keys, &token_file);
    assert!(
        !again.status.success(),
        "a token file that already exists may be the valid one: {said_again}"
    );
    assert_eq!(
        std::fs::read_to_string(&token_file).expect("read"),
        written,
        "and it must be exactly as it was"
    );

    // ---- the token in the file is real ---------------------------------
    let key = SoftwareKey::random().expect("a keypair");
    store
        .redeem_operator_enrolment(&token, &key.public_key())
        .await
        .expect("the token the command wrote must actually enrol the first operator");

    // ---- and now the gate closes, for good ------------------------------
    std::fs::remove_file(&token_file).expect("clear the way, so the refusal is the gate's");
    let (after, said_after) = run_reissue(&url, keys, &token_file);
    assert!(
        !after.status.success(),
        "AFTER ENROLMENT THIS MUST REFUSE. It succeeded: {said_after}"
    );
    assert!(
        said_after.contains("already enrolled"),
        "and say why: {said_after}"
    );
    assert!(
        !token_file.exists(),
        "a refused re-issue writes no token file"
    );
}

fn hex_to_32(hex: &str) -> [u8; 32] {
    assert_eq!(hex.len(), 64, "32 bytes of hex: {hex:?}");
    let mut out = [0u8; 32];
    for (i, byte) in out.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&hex[i * 2..i * 2 + 2], 16).expect("hex");
    }
    out
}
