//! **The way back into a deployment whose operator lost their browser, and
//! what it is still not allowed to do.**
//!
//! `docs/decisions/adr-0055-one-person-two-custodies.md` decision 8;
//! `operators::OperatorStore::recover_operator`; §6.3 and §7.2 for the shape
//! it grew out of.
//!
//! # What this file used to claim, and why it does not any more
//!
//! Until 2026-09-21 this suite was about `reissue_bootstrap_token` and its one
//! gate: **any** row in `operator_keys` and it refused. The argument was that
//! a re-issue that worked after enrolment would let whoever can run a command
//! on this host mint themselves an operator session without holding a key this
//! deployment had ever seen.
//!
//! ADR-0055 decision 8 reopens that on the owner's decision, and answers the
//! argument rather than ignoring it: *"the host already holds every key
//! (ADR-0043 §2), so a delay here is theatre."* A host-level attacker is tier 3
//! in `docs/PHASE-2-ADMIN-AND-AUDIT-DESIGN.md` §0.1 and already holds the
//! master key, the chain key and the database. What the gate cost was real —
//! a sole operator who lost their browser had no way back that was not a
//! restore — and every product the ADR surveyed recovers from the host.
//!
//! **So the control moved from refusal to record**, and that is what this file
//! tests now:
//!
//! - it mints no operator, ever, for any address
//!   ([`recovery_before_a_first_start_creates_nothing`]);
//! - it kills the tokens it replaces, so one seat never has two live bearer
//!   secrets ([`a_recovery_code_replaces_the_token_it_could_not_find`]);
//! - every use is a sealed `operator_recovered_from_host` entry
//!   ([`recovery_after_a_key_is_enrolled_works_and_is_recorded`]);
//! - and the code it prints goes to stdout and never into the log
//!   ([`the_command_prints_the_code_to_stdout_and_never_to_the_log`]).
//!
//! **Every test gets a deployment of its own**, for `tests/operators.rs`'s
//! reason and one more: the state under test is a whole operator register, and
//! it is not shareable.

mod support;

use std::sync::Arc;
use std::time::Duration;

use deadpool_postgres::Pool;
use fathom_server::authority::SoftwareKey;
use fathom_server::chain::EntryType;
use fathom_server::chains;
use fathom_server::crypto::Key32;
use fathom_server::grants;
use fathom_server::keys::KeyRing;
use fathom_server::operators::{OperatorError, OperatorStore, Purpose};
use fathom_server::sessions::{self, PrincipalKind, SessionStore, SignInLimits, VerifiedSession};

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
/// startup, and the two stores over it.
///
/// **No `single_operator` argument**: ADR-0055 decision 3 retires the switch
/// and derives the quorum from the register, so there is nothing to configure.
async fn deployment(tag: &str, ring: Arc<KeyRing>) -> (Pool, OperatorStore, SessionStore) {
    let pool = support::isolated_deployment(tag).await;
    let client = pool.get().await.expect("connection");
    let id = chains::register_deployment(&**client)
        .await
        .expect("stamp the deployment id, exactly as main.rs does at startup");
    drop(client);
    let operators = OperatorStore::with_delay(
        pool.clone(),
        Arc::clone(&ring),
        id.clone(),
        Duration::from_secs(1),
    );
    let sessions = SessionStore::new(pool.clone(), ring, id, SignInLimits::defaults());
    (pool, operators, sessions)
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

fn a_source_of_its_own() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT: AtomicU64 = AtomicU64::new(0);
    format!(
        "203.0.113.11-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
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

async fn operator_rows(tag: &str) -> i64 {
    support::superuser_on_isolated(tag)
        .await
        .query_one("SELECT count(*) FROM operators", &[])
        .await
        .expect("count operators")
        .get(0)
}

// ---------------------------------------------------------------------------
// Getting an operator with a key, ADR-0055 decision 1's way
// ---------------------------------------------------------------------------

/// **What stream (a)'s `POST /credentials/key` does**, stood in for by the
/// production function it calls.
///
/// ADR-0055 decision 1 gives the operator custody to an ACCOUNT, and the
/// browser key an operator act is signed with is registered from an account
/// session through `POST /admin/operators/self/key`. The two steps between the
/// bootstrap and that session are stream (a)'s — redeem the `setup` token, set
/// a credential, sign in — and are stood in for here by the same call
/// `operators::redeem_account_enrolment` makes plus the existing key sign-in.
/// Everything after is the production path.
async fn an_operator_with_a_key(
    operators: &OperatorStore,
    sessions_store: &SessionStore,
    ring: &KeyRing,
    address: &str,
) -> (String, SoftwareKey) {
    let bootstrap = operators
        .bootstrap_first_operator(address, address)
        .await
        .expect("a deployment with no operator bootstraps one");
    let key = SoftwareKey::random().expect("a keypair");

    let deployment = operators.deployment().to_string();
    let mut client = operators.pool().get().await.expect("connection");
    let tx = client.transaction().await.expect("begin");
    tx.execute(
        "SELECT set_config('app.enrolment_custody', 'yes', true)",
        &[],
    )
    .await
    .expect("enrolment custody");
    tx.execute(
        "SELECT set_config('app.account_id', $1, true)",
        &[&bootstrap.account_id],
    )
    .await
    .expect("name the account");
    grants::enrol_software_key_at_invitation(
        &tx,
        ring,
        &deployment,
        &bootstrap.account_id,
        &key.public_key(),
    )
    .await
    .expect("the browser registers a key on its own account");
    tx.commit().await.expect("commit");
    drop(client);

    let session = an_account_session(sessions_store, address, &key).await;
    operators
        .register_own_operator_key(&session, &key.public_key())
        .await
        .expect("the account holding the operator custody registers its browser key");
    (bootstrap.operator_id, key)
}

async fn an_account_session(
    sessions_store: &SessionStore,
    address: &str,
    key: &SoftwareKey,
) -> VerifiedSession {
    let session_key = SoftwareKey::random().expect("a session keypair");
    let pubkey = session_key.public_key();
    let source = a_source_of_its_own();
    let challenge = sessions_store
        .issue_challenge(PrincipalKind::Steward, address, &pubkey, &source)
        .await
        .expect("a challenge");
    let digest = sessions::session_challenge(&pubkey, &challenge.nonce, &challenge.deployment_id);
    let signed_in = sessions_store
        .sign_in(
            PrincipalKind::Steward,
            &pubkey,
            &challenge.nonce,
            &key.sign(&digest),
            &source,
        )
        .await
        .expect("an account with a registered key signs in");

    let nonce = sessions_store
        .issue_request_nonce(&signed_in.session_id, &signed_in.token)
        .await
        .expect("a nonce");
    let unix_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64;
    let path = "/admin/operators/self/key";
    let message = sessions::request_bytes(
        &signed_in.session_id,
        "POST",
        path,
        &sessions::body_digest(b""),
        &nonce,
        unix_ms,
        1,
    );
    sessions_store
        .verify_request(&sessions::SignedRequest {
            session_id: &signed_in.session_id,
            method: "POST",
            path,
            body: b"",
            nonce,
            unix_ms,
            counter: 1,
            signature: session_key.sign(&message),
        })
        .await
        .expect("a live session verifies its own signed request")
}

// ---------------------------------------------------------------------------
// The claim that replaced the old one
// ---------------------------------------------------------------------------

/// **Recovery works after a key is enrolled, and every use is on the chain.**
///
/// This test is the exact inverse of the one it replaces, and the inversion is
/// ADR-0055 decision 8's, made on the owner's decision and argued in the ADR's
/// "What it gives up": *"§6.3's 'never from the host once a credential exists'
/// becomes 'from the host, recorded and noticed'. What it protected against
/// was already inside tier 3."*
///
/// So the assertions are about the record, which is now the whole control: a
/// sealed `operator_recovered_from_host` entry, a ten-minute code and not a
/// three-day one, the same operator and not a new one, and a banner every
/// operator session will show for seven days.
#[tokio::test]
async fn recovery_after_a_key_is_enrolled_works_and_is_recorded() {
    const TAG: &str = "ops_recover_after_enrolment";
    let ring = ring();
    let (_pool, operators, sessions_store) = deployment(TAG, Arc::clone(&ring)).await;

    let address = unique("owner@example.org");
    let (operator_id, _key) =
        an_operator_with_a_key(&operators, &sessions_store, &ring, &address).await;
    assert!(
        site_entries_of(TAG, "operator_key_enrolled").await >= 1,
        "the ordinary thing that happens within minutes of a first start"
    );

    let operators_before = operator_rows(TAG).await;
    let recovered = operators
        .recover_operator(&address)
        .await
        .expect("ADR-0055 decision 8: from the host, recorded and noticed");

    assert_eq!(
        recovered.operator_id, operator_id,
        "the seat that already existed, not a new one"
    );
    assert_eq!(
        operator_rows(TAG).await,
        operators_before,
        "IT MINTS NO OPERATOR. That is the line decision 8 draws and the one this command \
         must never cross"
    );
    assert_eq!(
        recovered.invitation.purpose,
        Purpose::Setup,
        "the code opens the setup screen -- set a credential, enrol the app code -- and not a \
         browser-key enrolment"
    );

    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64;
    let life = recovered.invitation.expires_at_unix - now;
    assert!(
        (540..=600).contains(&life),
        "decision 8 says ten minutes, and this is read off a terminal by the person who just \
         typed the command. Got {life}s"
    );

    assert_eq!(
        site_entries_of(TAG, "operator_recovered_from_host").await,
        1,
        "every use appends a sealed entry: the record IS the control now"
    );

    let notices = operators.notices().await.expect("the notices are derived");
    assert!(
        notices
            .iter()
            .any(|n| n.starts_with("recovered_from_host ")),
        "and every operator session banners it for seven days: {notices:?}"
    );

    // The hold `0021` adds is NOT set by this path, and that is decision 8's
    // own sentence: *"No delay: the host already holds every key."* The hold
    // exists because a MAILED reset is a route an attacker who controls the
    // mail server can walk; the key volume is not.
    let held: Option<i64> = support::superuser_on_isolated(TAG)
        .await
        .query_one(
            "SELECT EXTRACT(EPOCH FROM operator_key_hold_until)::bigint FROM accounts \
              WHERE email = $1",
            &[&address],
        )
        .await
        .expect("the account row")
        .get(0);
    assert!(
        held.is_none(),
        "a host recovery takes no delay: decision 8 calls one here theatre"
    );
}

/// **A recovery kills the token it could not find**, so one seat never has two
/// live bearer secrets.
///
/// `reissue_bootstrap_token`'s own rule, kept for its own reason: the token
/// this command is run because nobody can find is exactly the one nobody can
/// account for, and leaving it live would mean a deployment where the operator
/// believes they hold the only way in while a lost file still holds another.
#[tokio::test]
async fn a_recovery_code_replaces_the_token_it_could_not_find() {
    const TAG: &str = "ops_recover_replaces";
    let ring = ring();
    let (pool, operators, _sessions) = deployment(TAG, Arc::clone(&ring)).await;

    let address = unique("owner@example.org");
    let bootstrap = operators
        .bootstrap_first_operator(&address, &address)
        .await
        .expect("a first start, whose token file this operator then lost");
    let lost = bootstrap.invitation.id.clone();

    let expired_before = site_entries_of(TAG, "enrolment_token_expired").await;
    let recovered = operators
        .recover_operator(&address)
        .await
        .expect("the operator exists, so the seat is recoverable");

    assert_eq!(
        recovered.expired,
        vec![lost],
        "the token it replaces is expired in the same transaction"
    );
    assert_eq!(
        site_entries_of(TAG, "enrolment_token_expired").await,
        expired_before + 1,
        "expiring the old token is a sealed act like every other (§7.2)"
    );
    assert_ne!(
        recovered.invitation.token, bootstrap.invitation.token,
        "a fresh code, not the same one read back"
    );

    // The act is on the site chain, sealed, and its metadata names the
    // operator — so an auditor holding the chain key can tell a recovery from
    // the host command line from anything the console did.
    let mut client = pool.get().await.expect("connection");
    let tx = client.transaction().await.expect("transaction");
    let entry = chains::read_site_entry_verified(&tx, &ring, recovered.issued_seq)
        .await
        .expect("read the entry")
        .expect("the seq the recovery reported must hold an entry");
    assert_eq!(entry.entry_type, EntryType::OperatorRecoveredFromHost);
    let metadata = String::from_utf8_lossy(&entry.metadata).to_string();
    assert!(
        metadata.contains(&recovered.operator_id),
        "the sealed metadata must name the operator: {metadata}"
    );
    assert!(
        metadata.contains(&address),
        "and the address it was recovered at: {metadata}"
    );

    // The whole chain still verifies afterwards, which is the claim every
    // sealed act in this product makes and the one a new writer is most
    // likely to break.
    let report = chains::verify_site(&tx, &ring, true)
        .await
        .expect("verification runs");
    assert!(
        matches!(
            report.outcome,
            fathom_server::chain::Outcome::Verified { .. }
        ),
        "the site chain must still verify after a recovery: {}",
        report.summary()
    );
}

/// **A deployment that has never started has nothing to recover.** The command
/// must not be a second way to create the first operator — that is §6.3's
/// first start, under its own advisory lock, writing its own
/// `operator_bootstrapped` entry.
#[tokio::test]
async fn recovery_before_a_first_start_creates_nothing() {
    const TAG: &str = "ops_recover_never_started";
    let ring = ring();
    let (_pool, operators, _sessions) = deployment(TAG, Arc::clone(&ring)).await;

    assert!(
        matches!(
            operators
                .recover_operator(&unique("owner@example.org"))
                .await,
            Err(OperatorError::NotFound("operator"))
        ),
        "with no operator row, this refuses rather than creating one"
    );
    assert_eq!(
        site_entries_of(TAG, "operator_bootstrapped").await,
        0,
        "and it certainly does not bootstrap"
    );
    assert_eq!(operator_rows(TAG).await, 0);
    assert_eq!(enrolment_token_rows(TAG).await, 0);
}

// ---------------------------------------------------------------------------
// The shipped binary, run as an operator would run it
// ---------------------------------------------------------------------------

/// A directory of this test's own, mode 0700, for the key files. No `tempfile`
/// crate: `scripts/gate-zero.sh` fails on an unapproved dependency, and this
/// is a `mkdir` and an `rm -r`.
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
/// and hand back its exit status, its stdout and its stderr **separately** —
/// which is the whole point here, because the claim is about which of the two
/// the code lands in.
fn run(
    subcommand: &[&str],
    database_url: &str,
    keys: (&std::path::Path, &std::path::Path),
    token: &std::path::Path,
) -> (std::process::Output, String, String) {
    let output = std::process::Command::new(env!("CARGO_BIN_EXE_fathom-server"))
        .args(subcommand)
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
    let out = String::from_utf8_lossy(&output.stdout).to_string();
    let err = String::from_utf8_lossy(&output.stderr).to_string();
    (output, out, err)
}

/// **`fathom-server recover-operator <address>`, run as an operator would run
/// it**: the code goes to stdout, the log goes to stderr, and the code is in
/// neither the log nor any error message.
///
/// This one runs the SHIPPED BINARY rather than calling into the library,
/// because the claim is about what a program prints, on which stream, and what
/// it exits with — and the only honest way to prove that is to run it and read
/// what it printed.
///
/// **Two streams, deliberately.** Logs are shipped off the box by design
/// (`audit.rs`), and a token in a log is a token in whatever holds the logs.
/// Everywhere else in the binary the subscriber writes to stdout, which is
/// what a container runtime collects; this subcommand writes its log to
/// stderr so that `fathom-server recover-operator a@b > code` is a working
/// sentence and the code is not in the collected stream.
#[tokio::test]
async fn the_command_prints_the_code_to_stdout_and_never_to_the_log() {
    const TAG: &str = "ops_recover_cli";
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
    let (_pool, operators, _sessions) = deployment(TAG, Arc::clone(&ring)).await;
    let address = unique("owner@example.org");
    operators
        .bootstrap_first_operator(&address, &address)
        .await
        .expect("a first start, whose token file this operator then lost");

    let url = support::isolated_database_url(TAG);
    let keys = (master_file.as_path(), chain_file.as_path());

    // ---- an address nobody is bound to --------------------------------
    let before = operator_rows(TAG).await;
    let (refused, _out, err) = run(
        &["recover-operator", "nobody@example.org"],
        &url,
        keys,
        &token_file,
    );
    assert!(
        !refused.status.success(),
        "an address no operator is bound to must not recover anything"
    );
    assert!(
        err.contains("nothing was minted") || err.contains("no operator is bound"),
        "and it must say that nothing was written: {err}"
    );
    assert_eq!(
        operator_rows(TAG).await,
        before,
        "IT MINTS NO OPERATOR, whatever it is handed"
    );

    // ---- the recovery itself -------------------------------------------
    let (output, out, err) = run(&["recover-operator", &address], &url, keys, &token_file);
    assert!(
        output.status.success(),
        "an operator who exists is recoverable from the host: {err}"
    );

    let code = out.trim().to_string();
    let token = hex_to_32(
        code.strip_prefix(fathom_server::operators::BOOTSTRAP_TOKEN_PREFIX)
            .unwrap_or_else(|| panic!("the code carries the operator prefix: {code:?}")),
    );

    // THE CLAIM. Every form the code could take in a log line: the hex, upper
    // case, and the `Debug` of the byte array.
    for form in [code.clone(), code.to_uppercase(), format!("{token:?}")] {
        assert!(
            !err.contains(&form),
            "the code appeared in what the command LOGGED. Logs are shipped off the box by \
             design (audit.rs), and a token in a log is a token in whatever holds the logs.\n\
             stderr was:\n{err}"
        );
    }
    assert!(
        err.contains("ten minutes"),
        "the log must tell the operator how long they have: {err}"
    );
    assert!(
        !token_file.exists(),
        "a recovery writes no token file: it is read off the terminal, not out of a volume"
    );

    // ---- the deprecated alias still works, and says so ------------------
    let (aliased, alias_out, alias_err) = run(
        &["reissue-bootstrap-token", &address],
        &url,
        keys,
        &token_file,
    );
    assert!(
        aliased.status.success(),
        "`reissue-bootstrap-token` folds into `recover-operator` (ADR-0055 decision 8): \
         {alias_err}"
    );
    assert!(
        alias_err.contains("deprecated"),
        "and the alias says it is deprecated: {alias_err}"
    );
    assert!(
        alias_out
            .trim()
            .starts_with(fathom_server::operators::BOOTSTRAP_TOKEN_PREFIX),
        "and prints a code on stdout like the command it aliases: {alias_out:?}"
    );

    // ---- the code the command printed is real ---------------------------
    let spent = support::superuser_on_isolated(TAG)
        .await
        .query_one(
            "SELECT count(*) FROM enrolment_tokens WHERE purpose = 'setup' \
               AND redeemed_at IS NULL AND expired_at IS NULL",
            &[],
        )
        .await
        .expect("count live setup tokens")
        .get::<_, i64>(0);
    assert_eq!(
        spent, 1,
        "exactly one live setup token: the alias's recovery killed the first command's code, \
         which is the same rule that killed the bootstrap's"
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
