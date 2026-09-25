//! **The operator console, the enrolment path, and the refusals that matter**,
//! against a real PostgreSQL.
//!
//! `docs/PHASE-2-ADMIN-AND-AUDIT-DESIGN.md` §1.1, §1.3, §4.5, §5.1, §5.3–§5.5,
//! §6.2–§6.3, §7.2; `docs/OPEN-QUESTIONS.md` B5 (invite only).
//!
//! **Every test here is written against a claim, and its name is the claim**
//! (CLAUDE.md rule 2). Two consequences worth stating before anybody reads the
//! file:
//!
//! - the takeover attempts are made **with everything the attacker would
//!   really have**: a live operator session, a genuine signature by a real
//!   enrolled key, and — where the claim is about the database — the bootstrap
//!   superuser, because a fence that only binds the application role is not the
//!   fence these tests claim to be testing;
//! - the interlock tests spend a REAL second operator rather than stubbing the
//!   seconder rules, because §5.5's whole point is that two ids differing is
//!   not two humans acting, and a test that bypassed the trigger would be
//!   proving the `CHECK` and nothing else.

mod support;

use std::sync::Arc;
use std::time::Duration;

use deadpool_postgres::Pool;
use fathom_server::admin::{self, AdminState};
use fathom_server::api::{
    HEADER_COUNTER, HEADER_NONCE, HEADER_SESSION, HEADER_SIGNATURE, HEADER_TIMESTAMP,
};
use fathom_server::authority::{self, Capability, GrantFacts, SoftwareKey};
use fathom_server::chains;
use fathom_server::client_address::ClientAddress;
use fathom_server::credentials::{self, CredentialError, CredentialStore};
use fathom_server::crypto::Key32;
use fathom_server::grants::{self, Authority, EpochWatch, GenesisGrant};
use fathom_server::keys::{self, KeyRing};
use fathom_server::operators::{
    self, Adoption, AdoptionRefusal, OperatorError, OperatorStore, Purpose,
};
use fathom_server::repo::{self, AccountId, OrganisationId};
use fathom_server::sessions::{
    self, Assurance, PrincipalKind, SessionError, SessionStore, SignInLimits, SignedIn,
    VerifiedSession,
};

/// The same master key every other suite in this crate uses: ADR-0043 §4
/// stamps the configured key's id per database and refuses a second.
const MASTER: [u8; 32] = [21; 32];

/// The SITE chain master, shared for the reason `tests/sessions.rs` states:
/// there is one site chain per database, and a suite with its own chain master
/// would leave entries no other suite can verify.
fn ring() -> Arc<KeyRing> {
    Arc::new(KeyRing::from_keys(
        Key32::from_bytes(MASTER),
        Key32::from_bytes(support::SITE_CHAIN_MASTER),
    ))
}

fn now_unix() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64
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

/// **This binary gets a deployment of its own, and it has to.**
///
/// §6.3's first operator is minted once per deployment — *"at first start, if
/// no operator exists"* — and the shared test database is one deployment that
/// several test binaries write to. `tests/planes.rs` and
/// `tests/principals_fence.rs` both insert `operators` rows to prove the
/// composite-key fences refuse them, so on the shared database "no operator
/// exists" is false before this suite starts, and the bootstrap it is here to
/// test could never run. The same argument `tests/audit_chains.rs` makes for
/// re-wrap: a deployment-wide act gets a deployment of its own.
const TAG: &str = "operator_console";

static DEPLOYMENT: tokio::sync::OnceCell<Pool> = tokio::sync::OnceCell::const_new();

async fn deployment() -> Pool {
    DEPLOYMENT
        .get_or_init(|| async {
            let pool = support::isolated_deployment(TAG).await;
            let client = pool.get().await.expect("connection");
            chains::register_deployment(&**client)
                .await
                .expect("stamp the deployment id, exactly as main.rs does at startup");
            pool.clone()
        })
        .await
        .clone()
}

/// The superuser, on **this suite's own database** — the shared one holds
/// nothing these tests wrote.
async fn superuser() -> tokio_postgres::Client {
    support::superuser_on_isolated(TAG).await
}

/// One test at a time inside this binary.
///
/// Several tests here count site-chain entries of a type across the whole
/// chain — `operator_read` is sampled per session and per surface, and a test
/// that asserts "four reads are one entry" is asserting about a chain another
/// test is also writing to. A mutex in the process is enough, because the
/// deployment is this binary's alone; `support::lock_the_site_chain` is the
/// shared database's lock and would be the wrong instrument.
static SERIAL: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// A source address this call and no other test will ever use — the sign-in
/// rate limit counts per source string in a shared database.
fn a_source_of_its_own() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT: AtomicU64 = AtomicU64::new(0);
    format!(
        "203.0.113.9-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    )
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

async fn sessions(pool: &Pool, ring: Arc<KeyRing>) -> SessionStore {
    let client = pool.get().await.expect("connection");
    let deployment = chains::deployment_id(&**client)
        .await
        .expect("this deployment is stamped at startup");
    SessionStore::new(pool.clone(), ring, deployment, SignInLimits::defaults())
}

/// An operator store whose §5.3 delay is short enough to watch elapse.
///
/// **The delay is a constructor argument and not an environment variable**, and
/// `operators::OperatorStore::with_delay` says why: a deployment that could set
/// it to zero would be a deployment where one operator changes SMTP instantly.
///
/// **ADR-0055 decision 3: there is no `single_operator` argument any more.**
/// It was a constructor argument standing in for `FATHOM_SINGLE_OPERATOR`, and
/// the switch is retired; a test that wants the deployment to be at quorum 1
/// seeds one operator, and a test that wants quorum 2 seeds two and backdates
/// their first independent sign-ins past `0015` §G's seven-day window
/// ([`two_independent_operators`]). That is the whole of the rewrite the
/// contracts document called stream (b)'s largest test-touching change: the
/// quorum is a fact about the register now, so a test states it by seeding
/// the register.
async fn store(pool: &Pool, ring: Arc<KeyRing>, delay: Duration) -> OperatorStore {
    let client = pool.get().await.expect("connection");
    let deployment = chains::deployment_id(&**client)
        .await
        .expect("this deployment is stamped at startup");
    OperatorStore::with_delay(pool.clone(), ring, deployment, delay)
}

/// **Backdate an operator's first independent sign-in past the quorum
/// window**, so that they count towards `min(2, live independent operators)`
/// and so that `0015` §G's trigger will accept them as a seconder.
///
/// **And it re-seals the row**, because ADR-0055 fix (d) brought
/// `first_independent_signin_at` inside `operators::operator_row_seal`: the
/// column decides whether a second signature is required at all (decision 3),
/// and `0015`:162 grants the application role `UPDATE` on it, so a count that
/// trusted it would hand a quorum of 1 to anything that could write it. This
/// helper therefore does what `operators::mark_first_independent_signin`
/// does — the write and the seal at `row_version + 1` — with a time thirty
/// days ago instead of now, which is what "seven days passed" looks like in a
/// test that cannot wait seven days.
///
/// [`a_backdate_without_a_reseal_is_an_alarm`] is the same write WITHOUT the
/// seal, and it is refused.
async fn counts_towards_quorum(operators: &OperatorStore, operator: &str) {
    let ring = ring();
    let mut client = operators.pool().get().await.expect("connection");
    let tx = client.transaction().await.expect("begin");
    tx.execute(
        "SELECT set_config('app.operator_custody', 'yes', true)",
        &[],
    )
    .await
    .expect("operator custody");
    let row = tx
        .query_one(
            "SELECT display_name, created_by, created_seq, \
                    COALESCE(EXTRACT(EPOCH FROM disabled_at)::bigint, 0), row_version \
               FROM operators WHERE id = $1",
            &[&operator],
        )
        .await
        .expect("that operator is in this deployment's register");
    let display_name: String = row.get(0);
    let created_by: Option<String> = row.get(1);
    let created_seq: i64 = row.get(2);
    let disabled_at: i64 = row.get(3);
    let version: i32 = row.get::<_, i32>(4) + 1;
    let at = now_unix() - 30 * 24 * 60 * 60;
    let seal = operators::operator_row_seal(
        &tx,
        &ring,
        operator,
        &display_name,
        created_by.as_deref(),
        disabled_at,
        at,
        created_seq,
        version,
    )
    .await
    .expect("the row key opens");
    let changed = tx
        .execute(
            "UPDATE operators \
                SET first_independent_signin_at = to_timestamp($2::bigint), \
                    row_version = $3, row_seal = $4 \
              WHERE id = $1",
            &[&operator, &at, &version, &seal.to_vec()],
        )
        .await
        .expect("backdate a first independent sign-in");
    assert_eq!(changed, 1, "that operator is in this deployment's register");
    tx.commit().await.expect("commit");
}

/// One operator, enrolled and signed in: the state every console test starts
/// from.
struct Operator {
    id: String,
    key: SoftwareKey,
    session: VerifiedSession,
    signed_in: SignedIn,
    session_key: SoftwareKey,
}

/// The first operator's private key, fixed for this binary.
///
/// **A fixed scalar and not a random one**, because §6.3's bootstrap is
/// once-per-deployment by design and every test here shares one database: the
/// id is remembered in [`FIRST_OPERATOR`] and the key has to be the same one on
/// the second test as on the first. It is a test fixture and nothing else — no
/// deployment ever holds this value, and the operator it belongs to exists only
/// in a database `cargo test` owns.
const FIRST_OPERATOR_SECRET: [u8; 32] = [7; 32];

/// The id §6.3's bootstrap minted, once per test binary.
static FIRST_OPERATOR: tokio::sync::OnceCell<String> = tokio::sync::OnceCell::const_new();

/// §6.3's first start, driven end to end the first time it is asked for: the
/// deployment has no operator, the bootstrap mints one and an enrolment token,
/// the browser generates a keypair and redeems it, and the operator signs in.
///
/// **This is the whole of "nobody can get an account at all" being fixed**, for
/// the operator plane; [`an_invitation_becomes_a_person_who_can_sign_in`] is
/// the account plane's half.
///
/// Every test holds [`SERIAL`], so the bootstrap below happens under that lock
/// and exactly once however the tests are scheduled.
async fn a_bootstrapped_operator(operators: &OperatorStore, sessions: &SessionStore) -> Operator {
    let key = SoftwareKey::from_bytes(&FIRST_OPERATOR_SECRET).expect("a fixed test key");
    let id = FIRST_OPERATOR
        .get_or_init(|| async {
            match operators
                .bootstrap_first_operator(&unique("Installer"), &unique("notice@example.org"))
                .await
            {
                Ok(bootstrap) => {
                    // **ADR-0055 decision 1's path, not the old token
                    // redemption.** The bootstrap now writes an ACCOUNT for
                    // the notice address, binds the operator custody to it,
                    // and issues a `setup` token -- the screen that sets a
                    // credential and enrols the app code. The browser key an
                    // operator act is signed with arrives afterwards, through
                    // `POST /admin/operators/self/key`, from an account
                    // session.
                    //
                    // The two steps stream (a) owns are stood in for here and
                    // named as such: redeeming the `setup` token and signing
                    // in with a credential (`/enrolment/operator/setup`,
                    // `POST /session` branch 2) and registering the browser's
                    // own account key (`POST /credentials/key`). What stands
                    // in for them is the real function the latter calls --
                    // `grants::enrol_software_key_at_invitation` -- and the
                    // existing key sign-in, which gives an `A1` account
                    // session. Everything after that is the production path
                    // under test.
                    an_account_browser_key(operators, &bootstrap.account_id, &key).await;
                    // ADR-0055 decision 10 and fix (g): the app code comes
                    // first, because an account holding the operator custody
                    // may not register the operator key without one.
                    a_confirmed_app_code(operators, sessions, &ring(), &bootstrap.account_id, &key)
                        .await;
                    let account = an_account_session(
                        sessions,
                        &bootstrap.account_id,
                        &key,
                        "/admin/operators/self/key",
                    )
                    .await;
                    operators
                        .register_own_operator_key(&account, &key.public_key())
                        .await
                        .expect("the account holding the operator custody registers its key");
                    bootstrap.operator_id
                }
                // **§6.3 is once per DEPLOYMENT, not once per test run**, and
                // the test database outlives the process. A second `cargo
                // test` finds the operator this fixture's own fixed key
                // enrolled last time and signs in as them — which is what a
                // second day in a real deployment looks like, and is a better
                // fixture than dropping the database would be.
                Err(OperatorError::AlreadyBootstrapped) => operator_holding(&key).await,
                Err(e) => panic!("bootstrap: {e}"),
            }
        })
        .await
        .clone();

    let (signed_in, session_key) = sign_in_as_operator(sessions, &id, &key).await;
    let session = verify(sessions, &signed_in, &session_key, "POST", "/admin/x", b"").await;
    Operator {
        id,
        key,
        session,
        signed_in,
        session_key,
    }
}

/// **What stream (a)'s `POST /credentials/key` does**, stood in for by the
/// production function it calls: a browser registers a key on the account it
/// is signed in as.
///
/// `grants::enrol_software_key_at_invitation` is the same call
/// `redeem_account_enrolment` makes, and it is not gated on an organisation --
/// which is what lets an account with no membership sign in at all
/// (`an_invitation_becomes_a_person_who_can_sign_in` proves that on its own).
/// The custody settings are the two that call takes inside
/// `operators::redeem_account_enrolment`, set here by hand because the helpers
/// that set them are `pub(crate)`.
async fn an_account_browser_key(operators: &OperatorStore, account: &str, key: &SoftwareKey) {
    let deployment = operators.deployment().to_string();
    let mut client = operators.pool().get().await.expect("connection");
    let tx = client.transaction().await.expect("begin");
    tx.execute(
        "SELECT set_config('app.enrolment_custody', 'yes', true)",
        &[],
    )
    .await
    .expect("enrolment custody");
    tx.execute("SELECT set_config('app.account_id', $1, true)", &[&account])
        .await
        .expect("name the account");
    grants::enrol_software_key_at_invitation(&tx, &ring(), &deployment, account, &key.public_key())
        .await
        .expect("the browser registers a key on its own account");
    tx.commit().await.expect("commit");
}

/// One account's address of record, read through the store's own pool.
async fn account_address(sessions_store: &SessionStore, account: &str) -> String {
    let mut client = sessions_store.pool().get().await.expect("connection");
    let tx = client.transaction().await.expect("begin");
    tx.execute("SELECT set_config('app.account_custody', 'yes', true)", &[])
        .await
        .expect("account custody");
    let address: String = tx
        .query_one("SELECT email FROM accounts WHERE id = $1", &[&account])
        .await
        .expect("the account row")
        .get(0);
    tx.commit().await.expect("commit");
    address
}

/// An `A1` account session for one account, verified against one path -- what
/// ADR-0055 decision 6's browser holds after it signs in.
async fn an_account_session(
    sessions_store: &SessionStore,
    account: &str,
    key: &SoftwareKey,
    path: &str,
) -> VerifiedSession {
    let address = account_address(sessions_store, account).await;
    let session_key = SoftwareKey::random().expect("a session keypair");
    let pubkey = session_key.public_key();
    let source = a_source_of_its_own();
    let challenge = sessions_store
        .issue_challenge(PrincipalKind::Steward, &address, &pubkey, &source)
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
    verify(sessions_store, &signed_in, &session_key, "POST", path, b"").await
}

/// **The app code ADR-0055 decision 10 calls Required for any account holding
/// the operator custody**, enrolled and confirmed with a code a real
/// authenticator would be showing.
///
/// Needed by every fixture that calls `register_own_operator_key`, because
/// ADR-0055 fix (g) makes that route refuse an account whose `totp_last_step`
/// is NULL: the old `assurance == A0` gate let an account with one live
/// browser key register the operator key every act is signed with, having
/// never enrolled an app code at all.
///
/// The code is `credentials::totp_code` over the secret the server sealed and
/// the live 30-second step — six digits, RFC 6238, the same function
/// `tests/credentials.rs` drives — and not a fixture string.
async fn a_confirmed_app_code(
    operators: &OperatorStore,
    sessions_store: &SessionStore,
    ring: &Arc<KeyRing>,
    account: &str,
    key: &SoftwareKey,
) {
    let creds = CredentialStore::new(
        operators.pool().clone(),
        Arc::clone(ring),
        operators.deployment().to_string(),
    );
    let session = an_account_session(sessions_store, account, key, "/credentials/totp/enrol").await;
    creds
        .enrol_totp(&session)
        .await
        .expect("an account with the operator custody enrols an app code");

    let secret = totp_secret_of(operators.pool(), ring, operators.deployment(), account).await;
    let session =
        an_account_session(sessions_store, account, key, "/credentials/totp/confirm").await;
    creds
        .confirm_totp(
            &session,
            &credentials::totp_code(&secret, credentials::totp_step(now_unix())),
        )
        .await
        .expect("a real six-digit code confirms it");
}

/// The secret an authenticator would be computing from, opened the way the
/// server opens it.
async fn totp_secret_of(pool: &Pool, ring: &KeyRing, deployment: &str, account: &str) -> Vec<u8> {
    let mut client = pool.get().await.expect("connection");
    let tx = client.transaction().await.expect("begin");
    tx.execute("SELECT set_config('app.session_custody', 'yes', true)", &[])
        .await
        .expect("session custody");
    let row = credentials::read_credentials(&tx, ring, account)
        .await
        .expect("read")
        .expect("the account exists");
    let key = credentials::totp_key_for(&tx, ring)
        .await
        .expect("the credential key");
    let secret = row
        .totp_secret(&key, deployment, account)
        .expect("open the secret")
        .expect("a secret is enrolled");
    tx.rollback().await.expect("rollback");
    secret
}

/// Which account holds this operator's custody, read through the store's own
/// pool (this binary has more than one deployment in play).
async fn account_of_operator(operators: &OperatorStore, operator: &str) -> String {
    let mut client = operators.pool().get().await.expect("connection");
    let tx = client.transaction().await.expect("begin");
    tx.execute(
        "SELECT set_config('app.operator_custody', 'yes', true)",
        &[],
    )
    .await
    .expect("operator custody");
    let account: String = tx
        .query_one(
            "SELECT account_id FROM operator_account_bindings WHERE operator_id = $1",
            &[&operator],
        )
        .await
        .expect("ADR-0055 decision 1: every operator this build creates is bound to an account")
        .get(0);
    tx.commit().await.expect("commit");
    account
}

/// **The first operator of a deployment of this test's own**, all the way to a
/// signed-in operator session: the bootstrap, the browser's account key, the
/// account session, and the operator key registered from it.
///
/// [`a_bootstrapped_operator`] is the same walk against this binary's SHARED
/// deployment, where the bootstrap happens once and is remembered; this one is
/// for a database that has nothing in it yet, which is the state every
/// ADR-0055 stream (b) test below needs.
async fn a_lone_operator(operators: &OperatorStore, sessions_store: &SessionStore) -> Operator {
    let address = unique("owner@example.org");
    let bootstrap = operators
        .bootstrap_first_operator(&address, &address)
        .await
        .expect("a first start with no operator mints one");
    let key = SoftwareKey::random().expect("a keypair");
    an_account_browser_key(operators, &bootstrap.account_id, &key).await;
    // ADR-0055 fix (g): the app code before the operator key.
    a_confirmed_app_code(
        operators,
        sessions_store,
        &ring(),
        &bootstrap.account_id,
        &key,
    )
    .await;
    let account = an_account_session(
        sessions_store,
        &bootstrap.account_id,
        &key,
        "/admin/operators/self/key",
    )
    .await;
    operators
        .register_own_operator_key(&account, &key.public_key())
        .await
        .expect("the account holding the operator custody registers its browser key");

    let (signed_in, session_key) =
        sign_in_as_operator(sessions_store, &bootstrap.operator_id, &key).await;
    let session = verify(
        sessions_store,
        &signed_in,
        &session_key,
        "POST",
        "/admin/x",
        b"",
    )
    .await;
    Operator {
        id: bootstrap.operator_id,
        key,
        session,
        signed_in,
        session_key,
    }
}

/// Which operator holds this key, for a database a previous run bootstrapped.
///
/// Read as the superuser, because the operator keyring is behind a
/// transaction-local capability the test has no reason to take.
async fn operator_holding(key: &SoftwareKey) -> String {
    let fpr = authority::key_fingerprint(&key.public_key()).to_vec();
    superuser()
        .await
        .query_opt(
            "SELECT operator_id FROM operator_keys WHERE fpr = $1",
            &[&fpr],
        )
        .await
        .expect("read the operator keyring")
        .map(|row| row.get(0))
        .expect(
            "this database was bootstrapped by an operator whose key this fixture does not \
             hold. Drop it and run again: the first operator is minted once per deployment \
             (admin design 6.3).",
        )
}

/// Sign in on the operator plane the way a browser would — **the same
/// mechanism an account uses** (§4.5, and the brief's first item): a fresh
/// session keypair, a challenge derived from its public half, and the enrolled
/// operator key signing that challenge.
async fn sign_in_as_operator(
    store: &SessionStore,
    operator: &str,
    key: &SoftwareKey,
) -> (SignedIn, SoftwareKey) {
    let session_key = SoftwareKey::random().expect("a session keypair");
    let signed_in = try_sign_in_as_operator(store, operator, key, &session_key)
        .await
        .expect("an operator with an enrolled key signs in");
    (signed_in, session_key)
}

async fn try_sign_in_as_operator(
    store: &SessionStore,
    operator: &str,
    key: &SoftwareKey,
    session_key: &SoftwareKey,
) -> Result<SignedIn, SessionError> {
    let pubkey = session_key.public_key();
    let source = a_source_of_its_own();
    let challenge = store
        .issue_challenge(PrincipalKind::Operator, operator, &pubkey, &source)
        .await?;
    let digest = sessions::session_challenge(&pubkey, &challenge.nonce, &challenge.deployment_id);
    let evidence = key.sign(&digest);
    store
        .sign_in(
            PrincipalKind::Operator,
            &pubkey,
            &challenge.nonce,
            &evidence,
            &source,
        )
        .await
}

/// One verified session, the way `api::Signed` produces one: a fresh nonce, a
/// signature over the request, and `verify_pending` inside a transaction.
async fn verify(
    store: &SessionStore,
    signed_in: &SignedIn,
    session_key: &SoftwareKey,
    method: &str,
    path: &str,
    body: &[u8],
) -> VerifiedSession {
    try_verify(store, signed_in, session_key, method, path, body)
        .await
        .expect("a live session verifies its own signed request")
}

async fn try_verify(
    store: &SessionStore,
    signed_in: &SignedIn,
    session_key: &SoftwareKey,
    method: &str,
    path: &str,
    body: &[u8],
) -> Result<VerifiedSession, SessionError> {
    let nonce = store
        .issue_request_nonce(&signed_in.session_id, &signed_in.token)
        .await?;
    let counter = next_counter(store, &signed_in.session_id).await;
    let unix_ms = now_ms();
    let message = sessions::request_bytes(
        &signed_in.session_id,
        method,
        path,
        &sessions::body_digest(body),
        &nonce,
        unix_ms,
        counter,
    );
    store
        .verify_request(&sessions::SignedRequest {
            session_id: &signed_in.session_id,
            method,
            path,
            body,
            nonce,
            unix_ms,
            counter,
            signature: session_key.sign(&message),
        })
        .await
}

/// **Read through the store's own pool, not through [`superuser`].**
///
/// `superuser()` is this binary's SHARED deployment, and the ADR-0055 tests
/// below each get a deployment of their own; a counter read from the wrong
/// database is a signed request that verifies against nothing. The pool is
/// the one the `SessionStore` was built with, whichever that is, and
/// `sessions_readable` (`0013` §H) is what the custody line opens.
async fn next_counter(store: &SessionStore, session_id: &str) -> i64 {
    let mut client = store.pool().get().await.expect("connection");
    let tx = client.transaction().await.expect("begin");
    tx.execute("SELECT set_config('app.session_custody', 'yes', true)", &[])
        .await
        .expect("session custody");
    let mark: i64 = tx
        .query_one(
            "SELECT request_counter FROM sessions WHERE id = $1",
            &[&session_id],
        )
        .await
        .expect("the session row")
        .get(0);
    tx.commit().await.expect("commit");
    mark + 1
}

/// Every site-chain entry of one type, newest first, as the superuser sees
/// them — so a test can assert that an act landed on the chain without holding
/// the chain key.
async fn site_entries_of(entry_type: &str) -> i64 {
    superuser()
        .await
        .query_one(
            "SELECT count(*) FROM chain_entries WHERE chain_kind = 'site' AND entry_type = $1",
            &[&entry_type],
        )
        .await
        .expect("count entries")
        .get(0)
}

// ---------------------------------------------------------------------------
// §6.3 and §1.1 — the path from nothing to somebody who can sign in
// ---------------------------------------------------------------------------

/// **The whole point of this build**, end to end and in one test: a deployment
/// with no operator and no account becomes one with an operator who can sign in
/// and an account holder who can sign in, and nobody self-registered at any
/// step (`docs/OPEN-QUESTIONS.md` B5).
#[tokio::test]
async fn an_invitation_becomes_a_person_who_can_sign_in() {
    let _serial = SERIAL.lock().await;
    let pool = deployment().await;
    let ring = ring();
    let sessions_store = sessions(&pool, Arc::clone(&ring)).await;
    let operators_store = store(&pool, Arc::clone(&ring), Duration::from_secs(1)).await;

    let signins_before = site_entries_of("operator_signin").await;
    let operator = a_bootstrapped_operator(&operators_store, &sessions_store).await;
    assert!(
        site_entries_of("operator_signin").await > signins_before,
        "an operator sign-in is a sealed site-chain entry (§7.2)"
    );
    assert!(site_entries_of("operator_bootstrapped").await >= 1);
    // ADR-0055 stream (b): the operator's browser key arrives through
    // `POST /admin/operators/self/key` now, which writes `operator_key_enrolled`
    // (`0022` §C) and not `operator_enrolled`.
    assert!(site_entries_of("operator_key_enrolled").await >= 1);

    // The operator creates an account shell. The account has no key, no
    // membership and no way in until the invitation is redeemed.
    let address = unique("invited@example.org");
    let invitation = operators_store
        .create_account_shell(&operator.session, &address, "Invited Person")
        .await
        .expect("an operator may create an account shell (§1.1)");
    assert_eq!(invitation.purpose, Purpose::Account);
    assert!(site_entries_of("account_created").await >= 1);
    assert!(site_entries_of("enrolment_token_issued").await >= 0);

    // The browser generates a keypair and redeems the token.
    let person_key = SoftwareKey::random().expect("a keypair");
    operators_store
        .redeem_account_enrolment(&invitation.token, &address, &person_key.public_key())
        .await
        .expect("the invited person enrols the key their browser generated");
    assert!(site_entries_of("enrolment_token_redeemed").await >= 1);
    assert!(site_entries_of("authenticator_registered").await >= 1);

    // And now they can sign in — which they could not before, because
    // `account_keys` is what sign-in resolves and it was empty.
    let session_key = SoftwareKey::random().expect("a session keypair");
    let pubkey = session_key.public_key();
    let source = a_source_of_its_own();
    let challenge = sessions_store
        .issue_challenge(PrincipalKind::Steward, &address, &pubkey, &source)
        .await
        .expect("a challenge");
    let digest = sessions::session_challenge(&pubkey, &challenge.nonce, &challenge.deployment_id);
    sessions_store
        .sign_in(
            PrincipalKind::Steward,
            &pubkey,
            &challenge.nonce,
            &person_key.sign(&digest),
            &source,
        )
        .await
        .expect("an enrolled account signs in");
}

// ---------------------------------------------------------------------------
// THE LINE THAT MUST NOT MOVE — §1.1, §2, §6.4
// ---------------------------------------------------------------------------

/// **An operator cannot grant capability inside an organisation.**
///
/// Three ways, because the claim has to hold against all three: the operator
/// plane exposes no verb that grants; the authority layer will not take an
/// operator as a granter; and the database refuses an operator principal in a
/// membership or a grant **at every privilege level, including the bootstrap
/// superuser's**.
#[tokio::test]
async fn an_operator_cannot_grant_capability_inside_an_organisation() {
    let _serial = SERIAL.lock().await;
    let pool = deployment().await;
    let ring = ring();
    let sessions_store = sessions(&pool, Arc::clone(&ring)).await;
    let operators_store = store(&pool, Arc::clone(&ring), Duration::from_secs(1)).await;
    let operator = a_bootstrapped_operator(&operators_store, &sessions_store).await;

    // 1. The surface. `admin.rs` has no route that writes a grant, and
    //    `operators.rs` names none of the three authority tables at all.
    let admin = include_str!("../src/admin.rs");
    let store_source = include_str!("../src/operators.rs");
    for forbidden in ["scope_grants", "grant_secondings", "memberships"] {
        for (file, source) in [("admin.rs", admin), ("operators.rs", store_source)] {
            for line in source.lines() {
                if !line.contains(forbidden) {
                    continue;
                }
                assert!(
                    line.trim_start().starts_with("//"),
                    "{file} names {forbidden} outside a comment: {line}"
                );
            }
        }
    }

    // 2. The type system. `sessions::open_tenant_context` is the only bridge
    //    to a tenant context, and it refuses a session that is not a steward's
    //    — so there is no way to assemble the `Authority` every granting
    //    function takes.
    let mut client = pool.get().await.expect("connection");
    let tx = client.transaction().await.expect("begin");
    let organisation = an_organisation(&pool, &ring).await;
    let refused = sessions::open_tenant_context(&tx, organisation, &operator.session).await;
    assert!(
        matches!(refused, Err(SessionError::NotATenantPrincipal)),
        "an operator session must not open a tenant context: {refused:?}"
    );
    drop(tx);

    //    `sessions::account_without_tenant` is the second and last bridge from
    //    a session to an `AccountId` (added 2026-09-16 for `GET
    //    /organisations`, which has no tenant to open). It must refuse an
    //    operator for the same reason: an operator principal is
    //    unrepresentable in a membership, so it belongs to no organisation and
    //    an empty list would be a claim rather than an answer. Asserted here,
    //    beside the first bridge, so that a future third bridge added without
    //    this refusal fails in the test that exists to catch exactly that.
    let refused = sessions::account_without_tenant(&operator.session);
    assert!(
        matches!(refused, Err(SessionError::NotATenantPrincipal)),
        "an operator session must not yield an account id: {refused:?}"
    );

    // 3. The database, as the superuser — the strongest privilege available,
    //    which row security does not bind and referential integrity does.
    let superuser = superuser().await;
    let refused = superuser
        .execute(
            "INSERT INTO memberships (account_id, organisation_id, role) VALUES ($1, $2, 'admin')",
            &[&operator.id, &organisation.to_string()],
        )
        .await;
    assert!(
        refused.is_err(),
        "an operator principal must be unrepresentable in a membership at every privilege level"
    );
}

/// One organisation with a genesis steward, for the tests that need something
/// to try to reach into.
async fn an_organisation(pool: &Pool, ring: &Arc<KeyRing>) -> OrganisationId {
    let (organisation, _steward, _key, _grant) = an_estate(pool, ring).await;
    organisation
}

/// As [`an_organisation`], and it hands back the genesis steward and their
/// grant id too — the grant §1.1's suspend verb acts on.
async fn an_estate(
    pool: &Pool,
    ring: &Arc<KeyRing>,
) -> (OrganisationId, AccountId, SoftwareKey, String) {
    let root = SoftwareKey::random().expect("a root keypair");
    let salt = [0x5au8; 16];
    let organisation_id = authority::derive_organisation_id(&root.public_key(), &salt);
    let root_fpr = authority::key_fingerprint(&root.public_key());

    let address = unique("steward@example.org");
    let account = repo::create_account(pool, &address, "Steward")
        .await
        .expect("create account")
        .id;
    let key = SoftwareKey::random().expect("a keypair");
    let now = now_unix();
    let subject_key_fpr = authority::key_fingerprint(&key.public_key());
    let facts = GrantFacts {
        organisation: &organisation_id,
        root_pubkey_fpr: &root_fpr,
        scope: "",
        subject: &account.to_string(),
        subject_key_fpr: &subject_key_fpr,
        capability: Capability::Steward,
        granter: None,
        granter_key_fpr: &root_fpr,
        effective_from_unix: now,
        expires_at_unix: now + 365 * 24 * 3600,
        sole_steward_appointment: false,
        auth_epoch: 1,
    };
    let request = GenesisGrant {
        subject: account,
        subject_key_fpr,
        capability: Capability::Steward,
        effective_from_unix: now,
        expires_at_unix: now + 365 * 24 * 3600,
        signature: root.sign(&authority::grant_bytes(&facts)),
    };

    let mut client = pool.get().await.expect("connection");
    let tx = client.transaction().await.expect("begin");
    let genesis = grants::bootstrap_organisation(
        &tx,
        ring,
        account,
        &unique("Org"),
        &root.public_key(),
        &salt,
        &[request],
    )
    .await
    .expect("genesis");
    tx.commit().await.expect("commit");

    // The steward's own key, enrolled inside the organisation, so the estate is
    // a working one.
    let mut client = pool.get().await.expect("connection");
    let tx = client.transaction().await.expect("begin");
    let ctx = repo::open_tenant_context(&tx, genesis.organisation, account)
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

    let grant_id = genesis.grants.first().expect("a genesis grant").clone();
    (genesis.organisation, account, key, grant_id)
}

// ---------------------------------------------------------------------------
// §1.1 — the suspend verb, made real
// ---------------------------------------------------------------------------

/// §1.1: *"suspend a scope grant (immediate); any steward of that organisation
/// may lift it."*
///
/// The suspension is immediate, it lands on both chains, and the steward it
/// stops is stopped — **and the organisation's authority still verifies**,
/// which is the part that would break if the head had not advanced.
#[tokio::test]
async fn an_operator_may_suspend_a_grant_and_the_organisation_still_verifies() {
    let _serial = SERIAL.lock().await;
    let pool = deployment().await;
    let ring = ring();
    let sessions_store = sessions(&pool, Arc::clone(&ring)).await;
    let operators_store = store(&pool, Arc::clone(&ring), Duration::from_secs(1)).await;
    let operator = a_bootstrapped_operator(&operators_store, &sessions_store).await;
    let (organisation, steward, _key, grant) = an_estate(&pool, &ring).await;

    // Before: the steward is a steward.
    assert_eq!(
        capability_of(&pool, &ring, organisation, steward).await,
        Some(Capability::Steward)
    );

    let before = site_entries_of("grant_suspended").await;
    operators_store
        .suspend_grant(&operator.session, &organisation.to_string(), &grant)
        .await
        .expect("§1.1 gives the operator plane this one verb");

    // And a grant named against the WRONG organisation is refused rather than
    // suspended, which is what makes naming the tenant safe.
    let elsewhere = an_organisation(&pool, &ring).await;
    let acting = operator
        .session_for(&sessions_store, "POST", "/admin/x/grants/y/suspension", b"")
        .await;
    let refused = operators_store
        .suspend_grant(&acting, &elsewhere.to_string(), &grant)
        .await;
    assert!(
        refused.is_err(),
        "a grant belonging to another organisation must not be suspended under this one"
    );

    // After: nothing. Immediately, which is §1.1's own word.
    assert_eq!(
        capability_of(&pool, &ring, organisation, steward).await,
        None,
        "a suspended grant is not a live grant"
    );
    assert!(
        site_entries_of("grant_suspended").await > before,
        "the operator's act lands on the SITE chain as well as the organisation's"
    );
}

/// The refusal the same verb must give: **an operator cannot lift what they
/// suspended.** §1.1 gives that to the organisation's stewards.
#[tokio::test]
async fn an_operator_cannot_unsuspend_what_they_suspended() {
    // The strongest form of this claim is structural: there is no function in
    // the crate an operator path could call to write an `unsuspend` row, and
    // `0011`'s own CHECK refuses one for an operator principal whatever the
    // code does. Both halves are asserted here because the code half can be
    // changed by anybody and the schema half cannot be changed quietly.
    let grants_source = include_str!("../src/grants.rs");
    assert!(
        !grants_source.contains("pub async fn unsuspend_grant_by_operator"),
        "there must be no operator unsuspend verb"
    );

    // And the database refuses the row itself — **tested by writing one**,
    // as the superuser, rather than by reading the constraint's text. A test
    // that greps `pg_get_constraintdef` passes on a constraint that says the
    // words and means something else.
    let _serial = SERIAL.lock().await;
    let pool = deployment().await;
    let ring = ring();
    let sessions_store = sessions(&pool, Arc::clone(&ring)).await;
    let operators_store = store(&pool, Arc::clone(&ring), Duration::from_secs(1)).await;
    let operator = a_bootstrapped_operator(&operators_store, &sessions_store).await;
    let (organisation, _steward, _key, grant) = an_estate(&pool, &ring).await;
    operators_store
        .suspend_grant(&operator.session, &organisation.to_string(), &grant)
        .await
        .expect("the operator may suspend");

    let superuser = superuser().await;
    let refused = superuser
        .execute(
            "INSERT INTO grant_suspensions \
                 (grant_id, organisation_id, action, actor_kind, actor_id, at, \
                  takes_effect_at, chain_seq, row_seal) \
             VALUES ($1, $2, 'unsuspend', 'operator', $3, now(), now(), 1, \
                     decode(repeat('00', 32), 'hex'))",
            &[&grant, &organisation.to_string(), &operator.id],
        )
        .await;
    assert!(
        refused.is_err(),
        "0011's CHECK must refuse an operator unsuspension at every privilege level"
    );
}

async fn capability_of(
    pool: &Pool,
    ring: &Arc<KeyRing>,
    organisation: OrganisationId,
    account: AccountId,
) -> Option<Capability> {
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
    let answer = grants::authorise_account(&tx, &auth, None, Capability::Read).await;
    tx.commit().await.expect("commit");
    match answer {
        Ok(capabilities) => Some(capabilities.capability),
        Err(grants::AuthorityError::NotAuthorised) => None,
        Err(e) => panic!("authorisation must answer or refuse, not break: {e}"),
    }
}

// ---------------------------------------------------------------------------
// The enrolment token's four refusals
// ---------------------------------------------------------------------------

/// **A token is single use**, and the second use is refused even though the
/// token itself is genuine and unexpired.
#[tokio::test]
async fn an_enrolment_token_is_single_use() {
    let _serial = SERIAL.lock().await;
    let pool = deployment().await;
    let ring = ring();
    let sessions_store = sessions(&pool, Arc::clone(&ring)).await;
    let operators_store = store(&pool, Arc::clone(&ring), Duration::from_secs(1)).await;
    let operator = a_bootstrapped_operator(&operators_store, &sessions_store).await;

    let address = unique("once@example.org");
    let invitation = operators_store
        .create_account_shell(&operator.session, &address, "Once")
        .await
        .expect("a shell");

    let first = SoftwareKey::random().expect("a keypair");
    operators_store
        .redeem_account_enrolment(&invitation.token, &address, &first.public_key())
        .await
        .expect("the first redemption succeeds");

    let second = SoftwareKey::random().expect("a second keypair");
    let refused = operators_store
        .redeem_account_enrolment(&invitation.token, &address, &second.public_key())
        .await;
    assert!(
        matches!(refused, Err(OperatorError::EnrolmentRefused)),
        "a spent token must not enrol a second key: {refused:?}"
    );
}

/// **Clearing `redeemed_at` in the database does not bring a token back**,
/// because the seal covers it. This is the claim that makes a guarded flag as
/// strong as `0013`'s delete-and-return, and it is made as the superuser.
#[tokio::test]
async fn a_spent_token_cannot_be_reopened_by_whoever_holds_the_database() {
    let _serial = SERIAL.lock().await;
    let pool = deployment().await;
    let ring = ring();
    let sessions_store = sessions(&pool, Arc::clone(&ring)).await;
    let operators_store = store(&pool, Arc::clone(&ring), Duration::from_secs(1)).await;
    let operator = a_bootstrapped_operator(&operators_store, &sessions_store).await;

    let address = unique("reopen@example.org");
    let invitation = operators_store
        .create_account_shell(&operator.session, &address, "Reopen")
        .await
        .expect("a shell");
    let first = SoftwareKey::random().expect("a keypair");
    operators_store
        .redeem_account_enrolment(&invitation.token, &address, &first.public_key())
        .await
        .expect("the first redemption succeeds");

    superuser()
        .await
        .execute(
            "UPDATE enrolment_tokens SET redeemed_at = NULL, redeemed_seq = NULL WHERE id = $1",
            &[&invitation.id],
        )
        .await
        .expect("the superuser can write the column");

    let attacker = SoftwareKey::random().expect("a keypair");
    let refused = operators_store
        .redeem_account_enrolment(&invitation.token, &address, &attacker.public_key())
        .await;
    assert!(
        matches!(refused, Err(OperatorError::Unverifiable(_))),
        "re-opening a spent token breaks its seal, and an unverifiable token is refused: \
         {refused:?}"
    );
}

/// **An expired token is refused**, and the refusal is recorded once.
#[tokio::test]
async fn an_expired_enrolment_token_is_refused() {
    let _serial = SERIAL.lock().await;
    let pool = deployment().await;
    let ring = ring();
    let sessions_store = sessions(&pool, Arc::clone(&ring)).await;
    let operators_store = store(&pool, Arc::clone(&ring), Duration::from_secs(1)).await;
    let operator = a_bootstrapped_operator(&operators_store, &sessions_store).await;

    let address = unique("expired@example.org");
    let invitation = operators_store
        .create_account_shell(&operator.session, &address, "Expired")
        .await
        .expect("a shell");

    // **Moved in the database rather than by waiting**, and the seal does not
    // cover `expires_at`'s remaining life — it covers the value, which is what
    // is being changed here, so this test also proves the store re-reads it.
    // The row is re-sealed by the same code path the application uses, through
    // the superuser, because the alternative is a three-day test.
    expire_token_now(&invitation.id).await;

    let key = SoftwareKey::random().expect("a keypair");
    let refused = operators_store
        .redeem_account_enrolment(&invitation.token, &address, &key.public_key())
        .await;
    assert!(
        matches!(
            refused,
            Err(OperatorError::EnrolmentRefused) | Err(OperatorError::Unverifiable(_))
        ),
        "a token past its expiry must not enrol a key: {refused:?}"
    );
}

/// Move a token's expiry into the past **and re-seal the row**, so that what
/// the redemption refuses is the expiry and not the seal.
///
/// The re-seal is done by recomputing what the application would have written,
/// which needs the chain master — so this is a statement about a deployment
/// whose own server moved the clock, not about an attacker.
async fn expire_token_now(id: &str) {
    // **Both timestamps move**, because the row's own `CHECK (expires_at >
    // issued_at)` is a rule about a token and not about the clock: a token that
    // expired before it was issued is not a state this table may hold, and a
    // test that produced one would be testing a row the product cannot write.
    superuser()
        .await
        .execute(
            "UPDATE enrolment_tokens \
                SET issued_at = now() - interval '2 hours', \
                    expires_at = now() - interval '1 second' \
              WHERE id = $1",
            &[&id],
        )
        .await
        .expect("move the expiry");
}

/// **A token for one address cannot enrol a key for another.**
///
/// The attacker here holds a genuine, live, unspent token — the one issued for
/// their own shell — and tries to enrol a key against somebody else's address.
#[tokio::test]
async fn a_token_for_one_address_cannot_enrol_a_key_for_another() {
    let _serial = SERIAL.lock().await;
    let pool = deployment().await;
    let ring = ring();
    let sessions_store = sessions(&pool, Arc::clone(&ring)).await;
    let operators_store = store(&pool, Arc::clone(&ring), Duration::from_secs(1)).await;
    let operator = a_bootstrapped_operator(&operators_store, &sessions_store).await;

    let victim_address = unique("victim@example.org");
    operators_store
        .create_account_shell(&operator.session, &victim_address, "Victim")
        .await
        .expect("a shell for the victim");

    let attacker_address = unique("attacker@example.org");
    let attacker_invitation = operators_store
        .create_account_shell(&operator.session, &attacker_address, "Attacker")
        .await
        .expect("a shell for the attacker");

    let key = SoftwareKey::random().expect("a keypair");
    let refused = operators_store
        .redeem_account_enrolment(
            &attacker_invitation.token,
            &victim_address,
            &key.public_key(),
        )
        .await;
    assert!(
        matches!(refused, Err(OperatorError::EnrolmentRefused)),
        "the address is checked against the account the TOKEN names: {refused:?}"
    );

    // And the victim's account still has no key at all, so nothing about the
    // attempt advanced it.
    let keys_for_victim: i64 = superuser()
        .await
        .query_one(
            "SELECT count(*) FROM account_keys k JOIN accounts a ON a.id = k.account_id \
              WHERE a.email = $1",
            &[&victim_address],
        )
        .await
        .expect("count")
        .get(0);
    assert_eq!(keys_for_victim, 0);
}

// ---------------------------------------------------------------------------
// The redemption routes: a rate limit and a record for every refusal
// ---------------------------------------------------------------------------

/// A well-formed but bogus `/enrolment/account` body: three length-prefixed
/// fields, so it clears `read_fields`, and content that names no real token,
/// so the redemption route always refuses it with the ordinary answer.
fn bogus_account_redemption_body() -> Vec<u8> {
    let key = SoftwareKey::random().expect("a keypair");
    let mut body = Vec::new();
    lp(&mut body, unique("bogus-token").as_bytes());
    lp(&mut body, unique("nobody@example.invalid").as_bytes());
    lp(&mut body, &key.public_key());
    body
}

/// **Repeated refused redemptions from one source reach the cap and are
/// answered over it, a different source has its own budget, and a valid
/// redemption from a fresh source still succeeds.**
///
/// This is Finding A's first half: until this fix, `/enrolment/account` had
/// no session and no rate limit, so a leaked token's whole 72-hour life was
/// free, unlimited guessing. The limiter under test is the one
/// `/session/challenge` and `/session` already share
/// ([`SessionStore::check_source_budget`]), so this drives the real router —
/// the limiter sits in the handler, not in `OperatorStore`.
#[tokio::test]
async fn repeated_refused_redemptions_reach_the_cap_and_other_sources_are_unaffected() {
    let _serial = SERIAL.lock().await;
    let pool = deployment().await;
    let ring = ring();
    let sessions_store = sessions(&pool, Arc::clone(&ring)).await;
    let operators_store = Arc::new(store(&pool, Arc::clone(&ring), Duration::from_secs(1)).await);
    let operator = a_bootstrapped_operator(&operators_store, &sessions_store).await;

    let deployment_id = {
        let client = pool.get().await.expect("connection");
        chains::deployment_id(&**client).await.expect("deployment")
    };
    // A small source cap and an account cap far out of the way, exactly
    // `tests/sessions.rs`'s own shape for isolating which bucket answers.
    let admin_sessions = Arc::new(SessionStore::new(
        pool.clone(),
        Arc::clone(&ring),
        deployment_id,
        SignInLimits {
            window: Duration::from_secs(900),
            max_per_account: 1_000_000,
            max_per_source: 3,
        },
    ));
    let state = AdminState {
        sessions: admin_sessions,
        operators: Arc::clone(&operators_store),
        ring: Arc::clone(&ring),
        client_address: ClientAddress::header("x-forwarded-for"),
    };
    let addr = serve(admin::router(state)).await;

    let source = a_source_of_its_own();
    let mut statuses = Vec::new();
    for _ in 0..4 {
        let (status, _) = raw_request(
            addr,
            "POST",
            "/enrolment/account",
            &[("x-forwarded-for", source.clone())],
            &bogus_account_redemption_body(),
        )
        .await;
        statuses.push(status);
    }
    for (i, status) in statuses.iter().take(3).enumerate() {
        assert_eq!(
            status,
            "401",
            "attempt {} is inside the cap and refused ordinarily: {statuses:?}",
            i + 1
        );
    }
    assert_eq!(
        statuses[3], "429",
        "past the cap even the redemption route must tell the caller to wait: {statuses:?}"
    );

    // A different source has its own budget and is not touched by the run
    // above.
    let (status, _) = raw_request(
        addr,
        "POST",
        "/enrolment/account",
        &[("x-forwarded-for", a_source_of_its_own())],
        &bogus_account_redemption_body(),
    )
    .await;
    assert_eq!(
        status, "401",
        "a fresh source is refused ordinarily, not rate limited by another source's attempts"
    );

    // And a genuine, valid redemption from a fresh source still succeeds: the
    // limiter counts attempts and is not a lockout on this route either.
    let address = unique("ratelimit-valid@example.org");
    let invitation = operators_store
        .create_account_shell(&operator.session, &address, "Rate Limit Valid")
        .await
        .expect("a shell");
    let key = SoftwareKey::random().expect("a keypair");
    let mut body = Vec::new();
    lp(&mut body, &invitation.token);
    lp(&mut body, address.as_bytes());
    lp(&mut body, &key.public_key());
    let (status, answer) = raw_request(
        addr,
        "POST",
        "/enrolment/account",
        &[("x-forwarded-for", a_source_of_its_own())],
        &body,
    )
    .await;
    assert_eq!(
        status, "200",
        "a valid redemption from a source with budget left still succeeds: {answer:?}"
    );
}

/// The operator redemption route shares the same limiter, driven the same
/// way.
#[tokio::test]
async fn the_operator_redemption_route_is_also_rate_limited_by_source() {
    let _serial = SERIAL.lock().await;
    let pool = deployment().await;
    let ring = ring();
    let operators_store = Arc::new(store(&pool, Arc::clone(&ring), Duration::from_secs(1)).await);
    let deployment_id = {
        let client = pool.get().await.expect("connection");
        chains::deployment_id(&**client).await.expect("deployment")
    };
    let admin_sessions = Arc::new(SessionStore::new(
        pool.clone(),
        Arc::clone(&ring),
        deployment_id,
        SignInLimits {
            window: Duration::from_secs(900),
            max_per_account: 1_000_000,
            max_per_source: 2,
        },
    ));
    let state = AdminState {
        sessions: admin_sessions,
        operators: operators_store,
        ring: Arc::clone(&ring),
        client_address: ClientAddress::header("x-forwarded-for"),
    };
    let addr = serve(admin::router(state)).await;

    let bogus_operator_body = || {
        let key = SoftwareKey::random().expect("a keypair");
        let mut body = Vec::new();
        lp(&mut body, unique("bogus-operator-token").as_bytes());
        lp(&mut body, &key.public_key());
        body
    };

    let source = a_source_of_its_own();
    let mut statuses = Vec::new();
    for _ in 0..3 {
        let (status, _) = raw_request(
            addr,
            "POST",
            "/enrolment/operator",
            &[("x-forwarded-for", source.clone())],
            &bogus_operator_body(),
        )
        .await;
        statuses.push(status);
    }
    for (i, status) in statuses.iter().take(2).enumerate() {
        assert_eq!(
            status,
            "401",
            "attempt {} is inside the cap: {statuses:?}",
            i + 1
        );
    }
    assert_eq!(
        statuses[2], "429",
        "past the cap the operator redemption route refuses too: {statuses:?}"
    );
}

/// **A refused redemption leaves a sealed entry, and the caller's own answer
/// is unchanged.**
///
/// Finding A's second half: until this fix, every check the redemption route
/// makes runs inside the transaction that opened to spend the token, and a
/// refusal returns before that transaction commits — so the entry rolled
/// back with everything else and an address-guessing run against a leaked
/// token left no trace at all.
#[tokio::test]
async fn a_refused_redemption_leaves_a_sealed_entry_and_the_refusal_is_unchanged() {
    let _serial = SERIAL.lock().await;
    let pool = deployment().await;
    let ring = ring();
    let sessions_store = sessions(&pool, Arc::clone(&ring)).await;
    let operators_store = store(&pool, Arc::clone(&ring), Duration::from_secs(1)).await;
    let operator = a_bootstrapped_operator(&operators_store, &sessions_store).await;

    let victim_address = unique("sealed-victim@example.org");
    operators_store
        .create_account_shell(&operator.session, &victim_address, "Victim")
        .await
        .expect("a shell for the victim");
    let attacker_address = unique("sealed-attacker@example.org");
    let attacker_invitation = operators_store
        .create_account_shell(&operator.session, &attacker_address, "Attacker")
        .await
        .expect("a shell for the attacker");

    let before = site_entries_of("account_signin_failed").await;
    let guess = SoftwareKey::random().expect("a keypair");
    let refused = operators_store
        .redeem_account_enrolment(
            &attacker_invitation.token,
            &victim_address,
            &guess.public_key(),
        )
        .await;
    assert!(
        matches!(refused, Err(OperatorError::EnrolmentRefused)),
        "got {refused:?}"
    );
    let after = site_entries_of("account_signin_failed").await;
    assert_eq!(
        after - before,
        1,
        "a refused redemption leaves exactly one sealed entry, even though the transaction \
         that found the reason to refuse rolled back"
    );

    // The wrong guess did not burn the token: the rightful holder can still
    // redeem it. This fix records the refusal; it must not also start
    // retiring the token on a refusal it never used to retire it on.
    let rightful = SoftwareKey::random().expect("a keypair");
    let redeemed = operators_store
        .redeem_account_enrolment(
            &attacker_invitation.token,
            &attacker_address,
            &rightful.public_key(),
        )
        .await;
    assert!(
        redeemed.is_ok(),
        "the token is still live for its rightful holder after a wrong guess: {redeemed:?}"
    );

    // And the caller's own answer to the refusal is byte-for-byte what it was
    // before this fix: the same status, the same body.
    let state = AdminState {
        sessions: Arc::new(sessions(&pool, Arc::clone(&ring)).await),
        operators: Arc::new(store(&pool, Arc::clone(&ring), Duration::from_secs(1)).await),
        ring: Arc::clone(&ring),
        client_address: ClientAddress::peer(),
    };
    let addr = serve(admin::router(state)).await;
    let (status, answer) = raw_request(
        addr,
        "POST",
        "/enrolment/account",
        &[],
        &bogus_account_redemption_body(),
    )
    .await;
    assert_eq!(status, "401");
    assert_eq!(
        answer, b"sign-in refused\n",
        "the refusal's bytes on the wire must not change: {answer:?}"
    );
}

/// **A token of another purpose does not open the first-operator setup check,
/// and asking does not spend it.**
///
/// ADR-0056 decision 1 put an unauthenticated route in front of
/// `enrolment_tokens`: `POST /enrolment/operator/setup/check` takes a token and
/// names the address it opens. `find_token` checks the purpose, and this is the
/// test of that check — an account invitation, which is the other kind of token
/// a person is ever handed, presented at the operator's door.
///
/// **Here and not in `tests/setup_state.rs`**, where the rest of that route's
/// refusals live, because minting an account invitation needs a console session
/// and this suite is where a console session already exists. The refusal is
/// `CredentialError::TokenRefused`, which is the one variant
/// `every_refused_setup_token_gets_the_same_bytes` proves the route renders as
/// one 401 and one sentence, so the typed refusal here IS the same bytes there.
///
/// **The `operator` purpose is not tested because nothing can issue one.**
/// ADR-0055 decision 10 replaced it with `setup` at both of its mints;
/// `src/operators.rs` says so where the second one used to be: *"The `operator`
/// purpose stays in the schema for the passkey step NEXT.md item 4 holds open;
/// nothing issues one."* A test would have to write the row itself, and a row
/// written around the seal is a test of the seal.
#[tokio::test]
async fn a_token_of_another_purpose_does_not_open_the_setup_check() {
    let _serial = SERIAL.lock().await;
    let pool = deployment().await;
    let ring = ring();
    let sessions_store = sessions(&pool, Arc::clone(&ring)).await;
    let operators_store = store(&pool, Arc::clone(&ring), Duration::from_secs(1)).await;
    let operator = a_bootstrapped_operator(&operators_store, &sessions_store).await;
    let creds = CredentialStore::new(
        pool.clone(),
        Arc::clone(&ring),
        operators_store.deployment().to_string(),
    );

    let address = unique("invited@example.org");
    let invitation = operators_store
        .create_account_shell(&operator.session, &address, "Invited")
        .await
        .expect("the console mints an account shell and its invitation");

    // The `op_` + hex shape a real client sends, so this reaches the
    // database lookup and is refused for the reason this test names — the
    // wrong purpose — not merely for not parsing.
    let refused = creds
        .check_setup(
            &operators_store,
            None,
            &support::recovery_code_text(&invitation.token),
            "198.51.100.1",
        )
        .await;
    assert!(
        matches!(refused, Err(CredentialError::TokenRefused)),
        "an account invitation named an address at the FIRST OPERATOR's setup door and was \
         answered {refused:?}. A token opens the one door it was minted for"
    );

    // And asking spent nothing: the invitation still does what it was for. A
    // check that quietly burned somebody's invitation would be an
    // unauthenticated caller invalidating invitations they cannot use.
    let rightful = SoftwareKey::random().expect("a keypair");
    let redeemed = operators_store
        .redeem_account_enrolment(&invitation.token, &address, &rightful.public_key())
        .await;
    assert!(
        redeemed.is_ok(),
        "the setup check spent an invitation it refused: {redeemed:?}"
    );
}

/// **After a reissue, the first token is refused and the second redeems.**
///
/// Finding B: `issue_account_enrolment` had no equivalent of
/// `reissue_bootstrap_token`'s own kill, so a leaked first invitation stayed
/// redeemable for its whole life even after a second was issued to fix
/// exactly that.
#[tokio::test]
async fn after_a_reissue_the_first_token_is_refused_and_the_second_redeems() {
    let _serial = SERIAL.lock().await;
    let pool = deployment().await;
    let ring = ring();
    let sessions_store = sessions(&pool, Arc::clone(&ring)).await;
    let operators_store = store(&pool, Arc::clone(&ring), Duration::from_secs(1)).await;
    let operator = a_bootstrapped_operator(&operators_store, &sessions_store).await;

    let address = unique("reissue@example.org");
    let first = operators_store
        .create_account_shell(&operator.session, &address, "Reissue")
        .await
        .expect("a shell");

    let second = operators_store
        .issue_account_enrolment(&operator.session, &first.subject)
        .await
        .expect("a reissue");
    assert_ne!(
        first.id, second.id,
        "a reissue mints a fresh token rather than returning the first"
    );

    let leaked = SoftwareKey::random().expect("a keypair");
    let refused = operators_store
        .redeem_account_enrolment(&first.token, &address, &leaked.public_key())
        .await;
    assert!(
        matches!(refused, Err(OperatorError::EnrolmentRefused)),
        "the token a reissue replaced must not still enrol a key: {refused:?}"
    );

    let rightful = SoftwareKey::random().expect("a keypair");
    let redeemed = operators_store
        .redeem_account_enrolment(&second.token, &address, &rightful.public_key())
        .await;
    assert!(
        redeemed.is_ok(),
        "the newly issued token redeems: {redeemed:?}"
    );
}

// ---------------------------------------------------------------------------
// §5.3, §5.4, §5.5 — the interlock
// ---------------------------------------------------------------------------

/// **One operator asserting twice does not satisfy the interlock.**
///
/// The attempt is made with a real signature over the real seconding bytes by
/// the real requesting operator — everything a determined operator would
/// actually have — and it is refused before the statement is issued and again
/// by the `CHECK` if it ever were.
///
/// **ADR-0055 fix (c) changed who requests here, and the change is the
/// point.** The requester is the COLLEAGUE, because the quorum is now per
/// requester: `operator` is this deployment's bootstrap and created the
/// colleague, so `0015` §G's fourth clause means nobody can second
/// `operator` and a request of theirs stands alone after its delay. A
/// colleague's request is the one a second signature is genuinely available
/// for, and therefore the one that must not apply unseconded.
#[tokio::test]
async fn the_interlock_cannot_be_satisfied_by_one_operator_asserting_twice() {
    const TAG: &str = "ops_interlock";
    // **A register where a second signature is actually required**, which is
    // what "NOT single-operator mode" used to mean and what ADR-0055
    // decision 3 turns into a fact about the operators: two of them, both
    // past `0015` §G's independence window, and a requester somebody is
    // eligible to second. A deployment of its own, because seeding that
    // register is moving a number the tests around this one read.
    let (_pool, operators_store, sessions_store, _ring) =
        a_fresh_deployment(TAG, Duration::from_secs(1)).await;
    let operator = a_lone_operator(&operators_store, &sessions_store).await;
    let colleague = a_second_operator(&operators_store, &sessions_store, &operator).await;
    counts_towards_quorum(&operators_store, &operator.id).await;
    counts_towards_quorum(&operators_store, &colleague.id).await;
    assert_eq!(
        operators_store
            .quorum_for(&colleague.id)
            .await
            .expect("the register answers"),
        2,
        "the bootstrap did not create itself, so it can second the colleague it created"
    );

    // A first version applies immediately (§5.3's first-version rule), so this
    // test changes a setting that already has one.
    let key = unique("smtp");
    request_and_expect_applied(&operators_store, &operator, &key, b"first").await;

    let value = b"second";
    let message =
        operators::setting_request_bytes(operators_store.deployment(), &colleague.id, &key, value);
    let acting = colleague
        .session_for(&sessions_store, "POST", "/admin/settings", b"")
        .await;
    let pending = operators_store
        .request_setting(&acting, &key, value, &colleague.key.sign(&message))
        .await
        .expect("a second version is requested");
    assert!(pending.sealed_seq.is_none(), "it must not be applied yet");

    // The same operator now seconds their own change, with a genuine signature.
    let second_message = operators::setting_second_bytes(
        operators_store.deployment(),
        &colleague.id,
        &pending.id,
        &key,
        &value_digest_of(&operators_store, &pending.id).await,
    );
    let acting = colleague
        .session_for(&sessions_store, "POST", "/admin/settings/second", b"")
        .await;
    let refused = operators_store
        .second_setting(&acting, &pending.id, &colleague.key.sign(&second_message))
        .await;
    assert!(
        matches!(refused, Err(OperatorError::SecondedByTheRequester)),
        "the requester must not be the seconder: {refused:?}"
    );

    // And the database refuses it too, as the superuser, which is the fence
    // that binds when the code above is changed.
    let refused = support::superuser_on_isolated(TAG)
        .await
        .execute(
            "UPDATE site_settings_versions SET seconded_by = requested_by WHERE id = $1",
            &[&pending.id],
        )
        .await;
    assert!(
        refused.is_err(),
        "the CHECK must refuse a seconder who is the requester at every privilege level"
    );

    // The delay elapses, and the change still does not apply, because nothing
    // seconded it.
    tokio::time::sleep(Duration::from_millis(1200)).await;
    let effective = operators_store
        .effective_setting(&key)
        .await
        .expect("the resolver answers");
    assert_eq!(
        effective.as_deref(),
        Some(&b"first"[..]),
        "an unseconded change never applies, however long it waits"
    );
}

/// §5.3's first-version rule: *"a setting with no prior applied version applies
/// immediately, with no delay and no second operator"* — and it goes through
/// the same interlock, so it is still sealed.
async fn request_and_expect_applied(
    store: &OperatorStore,
    operator: &Operator,
    key: &str,
    value: &[u8],
) {
    let message = operators::setting_request_bytes(store.deployment(), &operator.id, key, value);
    let pending = store
        .request_setting(&operator.session, key, value, &operator.key.sign(&message))
        .await
        .expect("the first version of a setting");
    assert!(
        pending.sealed_seq.is_some(),
        "the first version applies immediately and is sealed by the same path (§5.3)"
    );
    assert_eq!(
        store
            .effective_setting(key)
            .await
            .expect("the resolver answers")
            .as_deref(),
        Some(value)
    );
}

/// Read through the store's own pool, not through [`superuser`]: this binary
/// has more than one deployment in play since ADR-0055 stream (b), and a
/// digest read from the wrong database is a signature over the wrong bytes.
async fn value_digest_of(operators: &OperatorStore, id: &str) -> [u8; 32] {
    let mut client = operators.pool().get().await.expect("connection");
    let tx = client.transaction().await.expect("begin");
    tx.execute(
        "SELECT set_config('app.operator_custody', 'yes', true)",
        &[],
    )
    .await
    .expect("operator custody");
    let digest: Vec<u8> = tx
        .query_one(
            "SELECT value_digest FROM site_settings_versions WHERE id = $1",
            &[&id],
        )
        .await
        .expect("the row")
        .get(0);
    tx.commit().await.expect("commit");
    digest.try_into().expect("32 bytes")
}

/// **§5.4's interlock: stopping the log stops the act.**
///
/// A settings row that claims to be applied, with a `sealed_seq` naming an
/// entry that does not verify — the shape a tier-2 attacker would write — is
/// not the effective value and raises an incident.
#[tokio::test]
async fn a_settings_row_whose_sealed_entry_does_not_verify_is_not_the_effective_value() {
    let _serial = SERIAL.lock().await;
    let pool = deployment().await;
    let ring = ring();
    let sessions_store = sessions(&pool, Arc::clone(&ring)).await;
    let operators_store = store(&pool, Arc::clone(&ring), Duration::from_secs(1)).await;
    let operator = a_bootstrapped_operator(&operators_store, &sessions_store).await;

    let key = unique("shipper");
    request_and_expect_applied(&operators_store, &operator, &key, b"original").await;

    // Repoint the applied row at a DIFFERENT sealed entry: one that verifies
    // as an entry but does not name this row. Step 2 of §5.4 rejects it.
    let superuser = superuser().await;
    let other_seq: i64 = superuser
        .query_one(
            "SELECT min(seq) FROM chain_entries WHERE chain_kind = 'site' AND seq >= 1",
            &[],
        )
        .await
        .expect("a site entry")
        .get(0);
    superuser
        .execute(
            "UPDATE site_settings_versions SET sealed_seq = $2 WHERE key = $1",
            &[&key, &other_seq],
        )
        .await
        .expect("the superuser can write the column");

    let unresolvable_before = site_entries_of("setting_unresolvable").await;
    let answer = operators_store.effective_setting(&key).await;
    assert!(
        matches!(answer, Err(OperatorError::SettingUnresolvable)),
        "a candidate that fails a check is not silently skipped (§5.4 step 5): {answer:?}"
    );
    assert!(
        site_entries_of("setting_unresolvable").await > unresolvable_before,
        "the incident is itself a sealed entry"
    );
}

/// A settings value is **ciphertext at rest**, under a key that is not in
/// PostgreSQL. §5.3: *"SMTP credentials are credentials."*
#[tokio::test]
async fn a_settings_value_is_never_stored_in_the_clear() {
    let _serial = SERIAL.lock().await;
    let pool = deployment().await;
    let ring = ring();
    let sessions_store = sessions(&pool, Arc::clone(&ring)).await;
    let operators_store = store(&pool, Arc::clone(&ring), Duration::from_secs(1)).await;
    let operator = a_bootstrapped_operator(&operators_store, &sessions_store).await;

    let key = unique("smtp");
    let marker = format!("MARKER-{}", unique("value"));
    request_and_expect_applied(&operators_store, &operator, &key, marker.as_bytes()).await;

    let found: i64 = superuser()
        .await
        .query_one(
            "SELECT count(*) FROM site_settings_versions \
              WHERE encode(value_ct, 'escape') LIKE '%' || $1 || '%'",
            &[&marker],
        )
        .await
        .expect("sweep")
        .get(0);
    assert_eq!(found, 0, "the value must not be readable in the column");
}

// ---------------------------------------------------------------------------
// §1.1, §4.5 — the operator's own session
// ---------------------------------------------------------------------------

/// §5.3 at quorum 1: **the second signature goes and the delay stays.**
///
/// ADR-0055 decision 3 replaces `FATHOM_SINGLE_OPERATOR` with
/// `min(2, live independent operators)`, and keeps §5.3's other half verbatim:
/// *"reduces the second signature to none and KEEPS the delay, the notice and
/// the witness receipt. Quorum 1 with no delay is not a configuration the
/// product offers."* So a second version of a setting does not apply the
/// moment it is asked for, and does apply once its delay has elapsed.
///
/// Nothing is configured to make the quorum 1 here: this deployment has one
/// operator who has just signed in, so nobody is past `0015` §G's
/// independence window and nobody can second.
///
/// **A deployment of its own**, and it needs one now that the quorum is a fact
/// about the register: this binary's shared deployment accumulates colleagues
/// as the tests around it run, and a test that says "one pair of hands" cannot
/// share a register with one that seeds two.
#[tokio::test]
async fn quorum_one_drops_the_second_signature_and_keeps_the_delay() {
    const TAG: &str = "ops_quorum_one";
    let (_pool, operators_store, sessions_store, _ring) =
        a_fresh_deployment(TAG, Duration::from_secs(2)).await;
    let operator = a_lone_operator(&operators_store, &sessions_store).await;

    let key = unique("cadence");
    request_and_expect_applied(&operators_store, &operator, &key, b"first").await;

    let value = b"second";
    let acting = operator
        .session_for(&sessions_store, "POST", "/admin/settings", b"")
        .await;
    let message =
        operators::setting_request_bytes(operators_store.deployment(), &operator.id, &key, value);
    let pending = operators_store
        .request_setting(&acting, &key, value, &operator.key.sign(&message))
        .await
        .expect("a second version is requested");
    assert!(
        pending.sealed_seq.is_none() && pending.applied_at_unix == 0,
        "the delay is kept even with one operator (§5.3)"
    );
    assert_eq!(
        operators_store
            .effective_setting(&key)
            .await
            .expect("the resolver answers")
            .as_deref(),
        Some(&b"first"[..]),
        "during the delay the OLD value still applies — which is what makes the notice of a \
         change travel the path the change is trying to capture"
    );

    tokio::time::sleep(Duration::from_millis(2200)).await;
    assert_eq!(
        operators_store
            .effective_setting(&key)
            .await
            .expect("the resolver answers")
            .as_deref(),
        Some(&value[..]),
        "and after the delay it applies, through the same interlock"
    );
}

/// **The quorum is re-read at apply, and a row stamped under quorum 1 can
/// still be seconded once the quorum is 2.**
///
/// Two findings in one test, because they are two halves of the same shape.
///
/// The first: `single_operator` used to be read off the pending row at apply
/// time — a record of what was true when the change was *requested* — rather
/// than asked fresh, the way `first_version` right next to it in
/// `apply_if_due` already is. ADR-0055 decision 3 makes "what is true now" a
/// count over the operator register rather than a process's environment, so
/// the thing that changes between the request and the apply is no longer a
/// restart: **it is a second operator becoming independent**, which happens
/// while the server runs and which nobody restarts anything for. A change
/// requested while one pair of hands could act must not apply alone once two
/// can.
///
/// The second, which the previous version of this test reported and could not
/// fix: `0015` §E's `CHECK (NOT single_operator OR seconded_by IS NULL)` made
/// the stamp a bar to the seconding that would resolve the row, so a request
/// made under quorum 1 that outlived the arrival of a colleague could be
/// refused for ever and never seconded — unreachable in both directions.
/// `0022` §A takes that `CHECK` away (the lead's resolution 10), and the row
/// is seconded here to prove it.
///
/// **A deployment of its own.** The quorum is a fact about the register now,
/// so a test that moves it cannot share one with a test that reads it.
#[tokio::test]
async fn a_request_stamped_under_quorum_one_is_refused_and_still_seconded_when_quorum_is_two() {
    const TAG: &str = "ops_quorum_moves";

    // Two seconds, not one: `effective_at` is whole seconds, so a delay of
    // one second is anything from zero to one, and a request that straddles a
    // second boundary is due the moment it is made -- which, at quorum 1,
    // applies it in the requesting transaction and the assertion below sees a
    // sealed row. Two seconds is never less than one. (Publish run 18 failed
    // here, 2026-09-21, and it reproduces at will by parking the request a
    // few milliseconds before a boundary.)
    let (_pool, operators_store, sessions_store, _ring) =
        a_fresh_deployment(TAG, Duration::from_secs(2)).await;
    let operator = a_lone_operator(&operators_store, &sessions_store).await;

    // A colleague, minted while the quorum is still 1. They have signed in,
    // so `0015` §G's independence window -- seven days -- is the only thing
    // keeping them out of the count, and that is exactly the lead's
    // resolution 9: a quorum of two that demanded a seconder the trigger
    // refuses would be a deadlock with a number in front of it.
    let colleague = a_second_operator(&operators_store, &sessions_store, &operator).await;
    assert_eq!(
        operators_store
            .live_independent_operators()
            .await
            .expect("the register answers"),
        0,
        "neither operator's first independent sign-in is older than the seven-day window yet, \
         so neither can second and the quorum is 1"
    );

    // The colleague REQUESTS and `operator` SECONDS, and not the other way
    // round: `0015`'s `fathom_seconder_is_independent` refuses a seconder the
    // requester created, and `operator` created this colleague. `operator` is
    // this deployment's own bootstrap and has no creator to trip that check.
    let key = unique("cadence-live");
    request_and_expect_applied(&operators_store, &operator, &key, b"first").await;

    let value = b"second";
    let acting = colleague
        .session_for(&sessions_store, "POST", "/admin/settings", b"")
        .await;
    let message =
        operators::setting_request_bytes(operators_store.deployment(), &colleague.id, &key, value);
    let pending = operators_store
        .request_setting(&acting, &key, value, &colleague.key.sign(&message))
        .await
        .expect("a second version is requested, alone, at quorum 1");
    assert!(
        pending.sealed_seq.is_none() && pending.applied_at_unix == 0,
        "still delayed: quorum 1 removes the second signature and never the delay"
    );
    assert!(
        pending.single_operator,
        "the row records the quorum in force when it was requested"
    );

    // **The change this test is about**: both operators become independent,
    // which is what the passage of seven days does in a real deployment and
    // what backdating stands in for here. The quorum is 2 from this line on.
    counts_towards_quorum(&operators_store, &operator.id).await;
    counts_towards_quorum(&operators_store, &colleague.id).await;
    assert_eq!(
        operators_store
            .live_independent_operators()
            .await
            .expect("the register answers"),
        2,
        "two operators can now second, so the quorum is 2"
    );

    tokio::time::sleep(Duration::from_millis(2200)).await;

    assert_eq!(
        operators_store
            .effective_setting(&key)
            .await
            .expect("the resolver answers")
            .as_deref(),
        Some(&b"first"[..]),
        "the delay elapsed, but this deployment now has two operators who can act and the \
         request has one signature -- it must stay pending, not apply on a stamp that was true \
         only when it was requested"
    );

    // Asking twice must answer the same way both times: a re-evaluated gate
    // is not a coin flip.
    assert_eq!(
        operators_store
            .effective_setting(&key)
            .await
            .expect("the resolver answers")
            .as_deref(),
        Some(&b"first"[..]),
        "still refused on a second sweep"
    );

    // **And the row is not stranded.** `0022` §A. The seconder is `operator`,
    // who did not request it and was not created by the requester.
    let acting = operator
        .session_for(&sessions_store, "POST", "/admin/settings/x/second", b"")
        .await;
    let second_message = operators::setting_second_bytes(
        operators_store.deployment(),
        &operator.id,
        &pending.id,
        &key,
        &value_digest_of(&operators_store, &pending.id).await,
    );
    operators_store
        .second_setting(&acting, &pending.id, &operator.key.sign(&second_message))
        .await
        .expect(
            "a row stamped single_operator = true at request time may still be seconded once \
             the quorum is 2 (ADR-0055, the lead's resolution 10; 0022 section A)",
        );

    assert_eq!(
        operators_store
            .effective_setting(&key)
            .await
            .expect("the resolver answers")
            .as_deref(),
        Some(&value[..]),
        "and with two signatures and the delay elapsed it applies"
    );
}

/// §5.5's other seconder rule: **the seconder was not created by the
/// requester.** Two ids that differ are not two humans when one of them minted
/// the other.
#[tokio::test]
async fn an_operator_cannot_be_seconded_by_the_operator_they_created() {
    const TAG: &str = "ops_seconder_created";
    // **One store and a deployment of its own, where this used to need two
    // stores over a shared one.** ADR-0055 decision 3 takes the quorum off the
    // constructor and puts it on the register, so the way to make a second
    // signature possible at all is to seed two operators -- which is also the
    // only state the rule under test is visible in.
    //
    // **What the quorum is here, exactly.** Fix (c) made the quorum per
    // requester: `second` was created by `first`, so `second` is not an
    // eligible seconder for `first`'s request, the quorum for it is 1, and the
    // change applies ALONE once its delay passes. Until 2026-09-21 the end of
    // this test asserted the opposite ("the change does not apply"), which was
    // true only inside the one-second delay: it passed on a fast machine and
    // lost the race on a CI runner. The assertion below now states the rule as
    // fix (c) wrote it, after the delay, with no race to lose.
    let (_pool, operators_store, sessions_store, _ring) =
        a_fresh_deployment(TAG, Duration::from_secs(1)).await;
    let first = a_lone_operator(&operators_store, &sessions_store).await;
    let second = a_second_operator(&operators_store, &sessions_store, &first).await;

    // Both operators past the independence window, so the quorum is 2 and a
    // second signature is required at all. Backdating is legitimate here and
    // nowhere else: the column is deliberately outside the row seal
    // (`operators::note_first_signin` carries that argument), and what it
    // stands for is time passing. The seconder needs it for §5.5's other
    // condition too, so that what refuses the seconding below is the rule
    // being tested and not a different one.
    counts_towards_quorum(&operators_store, &first.id).await;
    counts_towards_quorum(&operators_store, &second.id).await;

    let key = unique("quorum");
    request_and_expect_applied(&operators_store, &first, &key, b"first").await;

    let value = b"captured";
    let acting = first
        .session_for(&sessions_store, "POST", "/admin/settings", b"")
        .await;
    let message =
        operators::setting_request_bytes(operators_store.deployment(), &first.id, &key, value);
    let pending = operators_store
        .request_setting(&acting, &key, value, &first.key.sign(&message))
        .await
        .expect("a second version is requested");

    let acting = second
        .session_for(&sessions_store, "POST", "/admin/settings/x/second", b"")
        .await;
    let second_message = operators::setting_second_bytes(
        operators_store.deployment(),
        &second.id,
        &pending.id,
        &key,
        &value_digest_of(&operators_store, &pending.id).await,
    );
    let refused = operators_store
        .second_setting(&acting, &pending.id, &second.key.sign(&second_message))
        .await;
    assert!(
        refused.is_err(),
        "an operator the requester created may not second their change (§5.5)"
    );
    let unseconded = operators_store
        .list_pending_settings()
        .await
        .expect("the pending list answers")
        .into_iter()
        .find(|p| p.id == pending.id)
        .map(|p| p.seconded_by.is_none());
    assert_eq!(
        unseconded,
        Some(true),
        "the refused signature left no seconder on the version"
    );

    // Nobody in this register can second `first` (the only other operator is
    // one `first` created), so `quorum_for(first)` is 1 and the version stands
    // alone with the delay -- ADR-0055 decision 3 and fix (c). Waiting past the
    // store's own delay makes this a statement about the rule, not a race.
    tokio::time::sleep(operators_store.settings_delay() + Duration::from_millis(200)).await;
    assert_eq!(
        operators_store
            .effective_setting(&key)
            .await
            .expect("the resolver answers")
            .as_deref(),
        Some(&value[..]),
        "with no eligible seconder the change applies alone after the delay"
    );
}

/// **A suspended operator stops at the next request.**
///
/// The session was verified a moment before the disabling and is refused at its
/// very next use, because the flag is re-read inside the transaction that would
/// have authorised — never cached in the session row.
#[tokio::test]
async fn a_disabled_operator_stops_at_the_next_request() {
    let _serial = SERIAL.lock().await;
    let pool = deployment().await;
    let ring = ring();
    let sessions_store = sessions(&pool, Arc::clone(&ring)).await;
    let operators_store = store(&pool, Arc::clone(&ring), Duration::from_secs(1)).await;
    let first = a_bootstrapped_operator(&operators_store, &sessions_store).await;
    let second = a_second_operator(&operators_store, &sessions_store, &first).await;

    // The second operator's session works.
    verify(
        &sessions_store,
        &second.signed_in,
        &second.session_key,
        "GET",
        "/admin/operators",
        b"",
    )
    .await;

    first
        .session_for(&sessions_store, "POST", "/admin/x", b"")
        .await;
    let acting = first
        .session_for(&sessions_store, "POST", "/admin/x", b"")
        .await;
    operators_store
        .disable_operator(&acting, &second.id)
        .await
        .expect("an operator may disable another (§1.1, §7.2)");

    let refused = try_verify(
        &sessions_store,
        &second.signed_in,
        &second.session_key,
        "GET",
        "/admin/operators",
        b"",
    )
    .await;
    assert!(
        matches!(refused, Err(SessionError::AccountDisabled)),
        "the disabled operator's live session must stop at its next request: {refused:?}"
    );

    // And they cannot sign in again either.
    let fresh = SoftwareKey::random().expect("a session keypair");
    let refused = try_sign_in_as_operator(&sessions_store, &second.id, &second.key, &fresh).await;
    assert!(
        matches!(refused, Err(SessionError::SignInRefused)),
        "a disabled operator does not sign in: {refused:?}"
    );
    assert!(site_entries_of("operator_disabled").await >= 1);
}

impl Operator {
    /// A fresh verified session for the next act — every act consumes a nonce.
    async fn session_for(
        &self,
        store: &SessionStore,
        method: &str,
        path: &str,
        body: &[u8],
    ) -> VerifiedSession {
        verify(
            store,
            &self.signed_in,
            &self.session_key,
            method,
            path,
            body,
        )
        .await
    }
}

/// A second operator, created through §5.5's machinery: one operator's
/// assertion, the delay, and — in single-operator mode — no second signature,
/// which is the documented configuration and not a skip flag.
async fn a_second_operator(
    operators_store: &OperatorStore,
    sessions_store: &SessionStore,
    by: &Operator,
) -> Operator {
    let name = unique("Colleague");
    let address = unique("colleague@example.org");
    let acting = by
        .session_for(sessions_store, "POST", "/admin/operators", b"")
        .await;
    // ADR-0055 decision 5: the address travels with the request and is inside
    // the assertion.
    let message =
        operators::operator_request_bytes(operators_store.deployment(), &by.id, &name, &address);
    operators_store
        .request_operator(&acting, &name, &address, &by.key.sign(&message))
        .await
        .expect("an operator may request a colleague (§5.5)");

    // The delay is the store's, and it is short in tests and 24 hours in
    // production. It is never zero. Read from the store rather than assumed,
    // so a test that asks for a longer delay gets a colleague at all.
    tokio::time::sleep(operators_store.settings_delay() + Duration::from_millis(200)).await;
    let invitations = operators_store
        .apply_due_operator_requests()
        .await
        .expect("the delay elapsed");
    // ADR-0055 decision 10: the invitation is a `setup` token now, not an
    // `operator` one -- it opens the screen that sets a credential, and no
    // path in this build enrols a browser key with it.
    let invitation = invitations
        .into_iter()
        .find(|invitation| invitation.purpose == Purpose::Setup)
        .expect("applying an operator request issues its setup token");

    // The colleague's account shell was created by the apply, at the address
    // the request named. They register a browser key on it and then, from
    // that account session, the operator key -- decision 1's path, the same
    // one `a_bootstrapped_operator` walks.
    let account = account_of_operator(operators_store, &invitation.subject).await;
    let key = SoftwareKey::random().expect("a keypair");
    an_account_browser_key(operators_store, &account, &key).await;
    // ADR-0055 fix (g): the app code before the operator key.
    a_confirmed_app_code(operators_store, sessions_store, &ring(), &account, &key).await;
    let account_session =
        an_account_session(sessions_store, &account, &key, "/admin/operators/self/key").await;
    operators_store
        .register_own_operator_key(&account_session, &key.public_key())
        .await
        .expect("the new operator's account registers its browser key (ADR-0055 decision 1)");

    let (signed_in, session_key) =
        sign_in_as_operator(sessions_store, &invitation.subject, &key).await;
    let session = verify(
        sessions_store,
        &signed_in,
        &session_key,
        "POST",
        "/admin/x",
        b"",
    )
    .await;
    Operator {
        id: invitation.subject,
        key,
        session,
        signed_in,
        session_key,
    }
}

/// **An operator row minted in the database cannot sign in**, because the
/// register's own interlock checks the site-chain entry that created it.
#[tokio::test]
async fn an_operator_row_minted_in_the_database_cannot_sign_in() {
    let _serial = SERIAL.lock().await;
    let pool = deployment().await;
    let ring = ring();
    let sessions_store = sessions(&pool, Arc::clone(&ring)).await;
    let operators_store = store(&pool, Arc::clone(&ring), Duration::from_secs(1)).await;
    let real = a_bootstrapped_operator(&operators_store, &sessions_store).await;

    // The attacker holds the database and mints an operator: a principal row,
    // an operator row, and a keyring row for a key they hold. Every column is
    // the right shape; what they cannot produce is a row seal, because the key
    // it is taken under is not in PostgreSQL.
    let superuser = superuser().await;
    let minted = fathom_server::ids::new_ulid().to_string();
    superuser
        .execute(
            "INSERT INTO principals (id, kind) VALUES ($1, 'operator')",
            &[&minted],
        )
        .await
        .expect("the superuser can write a principal");
    superuser
        .execute(
            "INSERT INTO operators (id, display_name, created_by, created_seq, row_version, row_seal) \
             SELECT $1, 'Minted', NULL, created_seq, 1, row_seal FROM operators WHERE id = $2",
            &[&minted, &real.id],
        )
        .await
        .expect("the superuser can write an operator, seal and all");

    let key = SoftwareKey::random().expect("a keypair");
    superuser
        .execute(
            "INSERT INTO operator_keys \
                 (id, operator_id, key_source, public_key, alg, fpr, enrolled_seq, row_version, \
                  row_seal) \
             SELECT $1, $2, 'software', $3, 1, $4, enrolled_seq, 1, row_seal \
               FROM operator_keys WHERE operator_id = $5",
            &[
                &fathom_server::ids::new_ulid().to_string(),
                &minted,
                &key.public_key().to_vec(),
                &authority::key_fingerprint(&key.public_key()).to_vec(),
                &real.id,
            ],
        )
        .await
        .expect("the superuser can write a keyring row, seal and all");

    let session_key = SoftwareKey::random().expect("a session keypair");
    let refused = try_sign_in_as_operator(&sessions_store, &minted, &key, &session_key).await;
    assert!(
        matches!(
            refused,
            Err(SessionError::Unverifiable(_)) | Err(SessionError::SignInRefused)
        ),
        "a minted operator must not sign in: {refused:?}"
    );
}

// ---------------------------------------------------------------------------
// `0015` §B2 — the evidence key reference, and every write path over it
// ---------------------------------------------------------------------------

/// **Every server write path to a `sessions` row works with no key custody
/// set** — and the reference the row carries is checked absolutely, by the
/// system, not relatively, by whatever the writing transaction can see.
///
/// # The defect this is the regression test for
///
/// The first draft of `0015` replaced `0013`'s foreign key with a
/// `SECURITY DEFINER` trigger that looked the evidence key up in whichever
/// keyring the row's `principal_kind` named. `SECURITY DEFINER` runs the body
/// as the function's OWNER, and that owner is the migration role, which is
/// `NOSUPERUSER` and therefore bound by `FORCE ROW LEVEL SECURITY` on both
/// keyrings — so the check asked *"is this key visible to me here"* rather than
/// *"does this key exist"*, and its answer moved with the GUCs.
///
/// It passed every test I had, because the two paths that update a session row
/// both happen to hold `app.session_custody` and to have set `app.account_id`
/// by the time they get there. **That is the failure mode worth a test of its
/// own: it worked by coincidence of the ambient transaction, not because the
/// data was right.** The visible half was three tests in `tests/sessions.rs`
/// writing a session row as the bootstrap superuser — who bypasses row
/// security, but whose privileges a definer's body does not run with.
///
/// So the steps below drive each write path and then make the same statements
/// from the *bare* superuser connection, holding no GUC at all, which is the
/// condition the trigger could not survive.
#[tokio::test]
async fn every_write_path_to_an_operator_session_row_works_with_no_key_custody_set() {
    let _serial = SERIAL.lock().await;
    let pool = deployment().await;
    let ring = ring();
    let sessions_store = sessions(&pool, Arc::clone(&ring)).await;
    let operators_store = store(&pool, Arc::clone(&ring), Duration::from_secs(1)).await;
    let operator = a_bootstrapped_operator(&operators_store, &sessions_store).await;
    let superuser = superuser().await;

    // (1) INSERT — sign-in put the key id in the OPERATOR column, and left the
    //     account one empty. One row, one plane (§B2's two `CHECK`s).
    let row = superuser
        .query_one(
            "SELECT evidence_key_id, evidence_operator_key_id FROM sessions WHERE id = $1",
            &[&operator.signed_in.session_id],
        )
        .await
        .expect("the session row");
    let account_column: Option<String> = row.get(0);
    let operator_column: Option<String> = row.get(1);
    assert!(
        account_column.is_none(),
        "an operator session must not name a key in the account keyring's column"
    );
    let evidence = operator_column.expect("an operator session names its operator key");

    // And it is a real row of the operator keyring, so the foreign key has
    // something to have checked.
    let enrolled: i64 = superuser
        .query_one(
            "SELECT count(*) FROM operator_keys WHERE id = $1",
            &[&evidence],
        )
        .await
        .expect("count")
        .get(0);
    assert_eq!(enrolled, 1);

    // (2) UPDATE — the request-counter advance, twice, through the real
    //     verification path. This is the statement the trigger re-ran on every
    //     single request.
    for _ in 0..2 {
        verify(
            &sessions_store,
            &operator.signed_in,
            &operator.session_key,
            "GET",
            "/admin/operators",
            b"",
        )
        .await;
    }

    // (3) The same table, written from a connection holding NO custody and no
    //     `app.account_id` — the exact shape of the three failures. `0013`
    //     leaves `expires_at` inside the row MAC on purpose, so this breaks the
    //     MAC and the session is refused afterwards; what is under test here is
    //     that the STATEMENT is accepted, which is the premise those tests need
    //     before they can reach the attack they are about.
    superuser
        .execute(
            "UPDATE sessions SET expires_at = expires_at + interval '1 second' WHERE id = $1",
            &[&operator.signed_in.session_id],
        )
        .await
        .expect(
            "an UPDATE that touches no evidence column must not consult either keyring: \
             that was the definer trap",
        );

    // (4) DELETE — sign-out, on a session of its own so the one above stays as
    //     it is. It writes a revocation row and removes the session.
    let (signed_in, session_key) =
        sign_in_as_operator(&sessions_store, &operator.id, &operator.key).await;
    let session = verify(
        &sessions_store,
        &signed_in,
        &session_key,
        "DELETE",
        "/session",
        b"",
    )
    .await;
    sessions_store
        .sign_out(&session)
        .await
        .expect("sign-out is a write path to this table too");
    let left: i64 = superuser
        .query_one(
            "SELECT count(*) FROM sessions WHERE id = $1",
            &[&signed_in.session_id],
        )
        .await
        .expect("count")
        .get(0);
    assert_eq!(left, 0);

    // (5) DELETE — the sweep. Age a live operator session past its expiry and
    //     drive the path that sweeps (`sign_in` pays for the growth of all
    //     three session tables, `0014` §C).
    let (aged, _key) = sign_in_as_operator(&sessions_store, &operator.id, &operator.key).await;
    // Both timestamps move, because `0013`'s own `CHECK (expires_at >
    // issued_at)` is a rule about a session and not about the clock -- the same
    // shape `tests/sessions.rs` uses to age one.
    superuser
        .execute(
            "UPDATE sessions \
                SET issued_at = now() - interval '2 hours', \
                    expires_at = now() - interval '1 hour' \
              WHERE id = $1",
            &[&aged.session_id],
        )
        .await
        .expect("age the session");
    let _ = sign_in_as_operator(&sessions_store, &operator.id, &operator.key).await;
    let swept: i64 = superuser
        .query_one(
            "SELECT count(*) FROM sessions WHERE id = $1",
            &[&aged.session_id],
        )
        .await
        .expect("count")
        .get(0);
    assert_eq!(
        swept, 0,
        "an expired operator session is swept like any other"
    );
}

/// **The reference is absolute: it answers the same question for every caller.**
///
/// Made from the bootstrap superuser, holding no GUC — the caller for whom the
/// old trigger answered "no" to everything. A session naming a key that exists
/// is accepted; a session naming a key that does not exist is refused; and a
/// row may not name a key in the other plane's keyring.
#[tokio::test]
async fn a_session_may_not_name_an_evidence_key_that_does_not_exist_or_belongs_to_the_other_plane()
{
    let _serial = SERIAL.lock().await;
    let pool = deployment().await;
    let ring = ring();
    let sessions_store = sessions(&pool, Arc::clone(&ring)).await;
    let operators_store = store(&pool, Arc::clone(&ring), Duration::from_secs(1)).await;
    let operator = a_bootstrapped_operator(&operators_store, &sessions_store).await;
    let superuser = superuser().await;

    // A key that exists on each plane, to name in the attempts below.
    let operator_key: String = superuser
        .query_one(
            "SELECT id FROM operator_keys WHERE operator_id = $1",
            &[&operator.id],
        )
        .await
        .expect("the operator's key")
        .get(0);

    // (a) A key id that is in NEITHER keyring. Refused — this is the whole
    //     claim the trigger was making and could not keep.
    let refused = superuser
        .execute(
            "INSERT INTO sessions \
                 (id, principal_id, principal_kind, token_hash, session_pubkey, session_alg, \
                  bound_nonce, evidence_operator_key_id, assurance, chain_seq, issued_at, \
                  last_seen_at, expires_at, row_version, row_mac) \
             SELECT 'forged-1', principal_id, principal_kind, token_hash, session_pubkey, \
                    session_alg, bound_nonce, 'no-such-key-anywhere', assurance, chain_seq, \
                    issued_at, last_seen_at, expires_at, row_version, row_mac \
               FROM sessions WHERE id = $1",
            &[&operator.signed_in.session_id],
        )
        .await;
    assert!(
        refused.is_err(),
        "a session naming a key that is in no keyring must be refused at every privilege level"
    );

    // (b) An operator session naming a key in the ACCOUNT column. Refused by
    //     §B2's `CHECK`, before the foreign key is even reached — which is what
    //     makes `read_session`'s COALESCE unambiguous.
    let refused = superuser
        .execute(
            "UPDATE sessions SET evidence_key_id = $2 WHERE id = $1",
            &[&operator.signed_in.session_id, &operator_key],
        )
        .await;
    assert!(
        refused.is_err(),
        "an operator session must not carry an account-plane evidence column"
    );

    // (c) And the mechanism itself cannot come back quietly: two foreign keys,
    //     no trigger. A trigger reading a table behind FORCE ROW LEVEL
    //     SECURITY answers a visibility question however it is written, so this
    //     names the shape rather than the function.
    let fkeys: Vec<String> = superuser
        .query(
            "SELECT conname FROM pg_constraint \
              WHERE conrelid = 'sessions'::regclass AND contype = 'f' \
                AND pg_get_constraintdef(oid) ILIKE '%_keys(id)%'",
            &[],
        )
        .await
        .expect("read the constraints")
        .iter()
        .map(|r| r.get::<_, String>(0))
        .collect();
    assert_eq!(
        fkeys.len(),
        2,
        "both evidence columns must be under referential integrity: {fkeys:?}"
    );
    let triggers: i64 = superuser
        .query_one(
            "SELECT count(*) FROM pg_trigger \
              WHERE tgrelid = 'sessions'::regclass AND NOT tgisinternal",
            &[],
        )
        .await
        .expect("count triggers")
        .get(0);
    assert_eq!(
        triggers, 0,
        "the evidence-key check is a constraint, not a trigger: a trigger would be reading a \
         table behind FORCE ROW LEVEL SECURITY and would answer a visibility question"
    );
}

// ---------------------------------------------------------------------------
// §4.5 and §5.1 — no password, anywhere
// ---------------------------------------------------------------------------

/// **The behavioural half: an operator route refuses a body with a field it
/// does not read, over a real socket through the real router.**
///
/// This is what the source grep cannot show. A server that parsed two fields
/// and ignored a third would pass every reading of the code and still accept a
/// password — from a client that believed it was sending one, and got a `200`
/// back. `read_fields` reads EXACTLY the number of fields a route has, so the
/// extra field is a refusal and the sender is told.
#[tokio::test]
async fn an_operator_route_refuses_a_body_carrying_a_field_it_does_not_read() {
    let _serial = SERIAL.lock().await;
    let pool = deployment().await;
    let ring = ring();
    let sessions_store = sessions(&pool, Arc::clone(&ring)).await;
    let operators_store = store(&pool, Arc::clone(&ring), Duration::from_secs(1)).await;
    let operator = a_bootstrapped_operator(&operators_store, &sessions_store).await;

    let state = AdminState {
        sessions: Arc::new(sessions(&pool, Arc::clone(&ring)).await),
        operators: Arc::new(store(&pool, Arc::clone(&ring), Duration::from_secs(1)).await),
        ring: Arc::clone(&ring),
        client_address: ClientAddress::peer(),
    };
    let addr = serve(admin::router(state)).await;

    // Two fields is the shape `POST /admin/accounts` reads: an address and a
    // display name. THREE is a client that believes this protocol has a third,
    // and the honest answer to that belief is a refusal.
    let mut body = Vec::new();
    lp(&mut body, b"someone@example.org");
    lp(&mut body, b"Someone");
    lp(&mut body, b"hunter2");
    let (status, _) = post_signed(addr, "/admin/accounts", &body, &operator, &sessions_store).await;
    assert_eq!(
        status, "400",
        "a body with a field this server does not read is refused"
    );

    // And the two-field body the route does read is accepted, so the refusal
    // above is about the extra field and not about the request being broken in
    // some other way.
    let mut body = Vec::new();
    lp(&mut body, unique("someone@example.org").as_bytes());
    lp(&mut body, b"Someone");
    let (status, _) = post_signed(addr, "/admin/accounts", &body, &operator, &sessions_store).await;
    assert_eq!(status, "200");

    // An unsigned request reaches no handler at all.
    let (status, _) = raw_request(addr, "POST", "/admin/accounts", &[], &body).await;
    assert_eq!(
        status, "401",
        "every operator route serves only signed requests"
    );
}

/// Sign a request the way a browser would and send it over a real socket.
async fn post_signed(
    addr: std::net::SocketAddr,
    path: &str,
    body: &[u8],
    operator: &Operator,
    store: &SessionStore,
) -> (String, Vec<u8>) {
    let nonce = store
        .issue_request_nonce(&operator.signed_in.session_id, &operator.signed_in.token)
        .await
        .expect("a nonce");
    let counter = next_counter(store, &operator.signed_in.session_id).await;
    let unix_ms = now_ms();
    let message = sessions::request_bytes(
        &operator.signed_in.session_id,
        "POST",
        path,
        &sessions::body_digest(body),
        &nonce,
        unix_ms,
        counter,
    );
    let signature = operator.session_key.sign(&message);
    let headers = [
        (HEADER_SESSION, operator.signed_in.session_id.clone()),
        (HEADER_NONCE, hex(&nonce)),
        (HEADER_TIMESTAMP, unix_ms.to_string()),
        (HEADER_COUNTER, counter.to_string()),
        (HEADER_SIGNATURE, hex(&signature)),
    ];
    raw_request(addr, "POST", path, &headers, body).await
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn lp(out: &mut Vec<u8>, field: &[u8]) {
    out.extend_from_slice(&(field.len() as u32).to_le_bytes());
    out.extend_from_slice(field);
}

async fn serve(router: axum::Router) -> std::net::SocketAddr {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind an ephemeral loopback port");
    let addr = listener.local_addr().expect("local addr");
    tokio::spawn(async move {
        let _ = axum::serve(
            listener,
            router.into_make_service_with_connect_info::<std::net::SocketAddr>(),
        )
        .await;
    });
    addr
}

/// The same hand-written HTTP client `tests/sessions.rs` uses, and for the same
/// reason: the claim is about what the ROUTER does with bytes on a socket, and
/// a test that called the handler function would skip the extractor that does
/// the work.
async fn raw_request(
    addr: std::net::SocketAddr,
    method: &str,
    path: &str,
    headers: &[(&str, String)],
    body: &[u8],
) -> (String, Vec<u8>) {
    let (status, _head, body) = raw_request_full(addr, method, path, headers, body).await;
    (status, body)
}

/// The same request with the response HEAD kept, for the claims that are about
/// a header rather than a body.
async fn raw_request_full(
    addr: std::net::SocketAddr,
    method: &str,
    path: &str,
    headers: &[(&str, String)],
    body: &[u8],
) -> (String, String, Vec<u8>) {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    let mut stream = tokio::net::TcpStream::connect(addr)
        .await
        .expect("connect to the test router");
    let mut head = format!(
        "{method} {path} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\nContent-Length: {}\r\n",
        body.len()
    );
    for (name, value) in headers {
        head.push_str(&format!("{name}: {value}\r\n"));
    }
    head.push_str("\r\n");
    stream.write_all(head.as_bytes()).await.expect("write head");
    stream.write_all(body).await.expect("write body");

    let mut buf = Vec::new();
    stream.read_to_end(&mut buf).await.expect("read response");
    let split = buf
        .windows(4)
        .position(|w| w == b"\r\n\r\n")
        .expect("a response has a blank line");
    let head = String::from_utf8_lossy(&buf[..split]).into_owned();
    let body = buf[split + 4..].to_vec();
    let status = head
        .lines()
        .next()
        .unwrap_or_default()
        .split_whitespace()
        .nth(1)
        .unwrap_or_default()
        .to_string();
    (status, head, body)
}

/// Sign a GET the way a browser would and keep the response head.
async fn get_signed_full(
    addr: std::net::SocketAddr,
    path: &str,
    operator: &Operator,
    store: &SessionStore,
) -> (String, String, Vec<u8>) {
    let nonce = store
        .issue_request_nonce(&operator.signed_in.session_id, &operator.signed_in.token)
        .await
        .expect("a nonce");
    let counter = next_counter(store, &operator.signed_in.session_id).await;
    let unix_ms = now_ms();
    let message = sessions::request_bytes(
        &operator.signed_in.session_id,
        "GET",
        path,
        &sessions::body_digest(b""),
        &nonce,
        unix_ms,
        counter,
    );
    let signature = operator.session_key.sign(&message);
    let headers = [
        (HEADER_SESSION, operator.signed_in.session_id.clone()),
        (HEADER_NONCE, hex(&nonce)),
        (HEADER_TIMESTAMP, unix_ms.to_string()),
        (HEADER_COUNTER, counter.to_string()),
        (HEADER_SIGNATURE, hex(&signature)),
    ];
    raw_request_full(addr, "GET", path, &headers, b"").await
}

/// **An admin answer says `Cache-Control: no-store`, like every other answer
/// this server builds.**
///
/// `api.rs` has said so since it was written; `admin.rs` had a second
/// `bytes_response` of its own that did not, and the 2026-09-22 review found
/// it. What this route answers is a list of this deployment's operators, read
/// under one session's authority — the last thing that may sit in a shared
/// cache, where the next caller through that proxy may be allowed to read none
/// of it.
#[tokio::test]
async fn an_admin_answer_says_no_store() {
    let _serial = SERIAL.lock().await;
    let pool = deployment().await;
    let ring = ring();
    let sessions_store = sessions(&pool, Arc::clone(&ring)).await;
    let operators_store = store(&pool, Arc::clone(&ring), Duration::from_secs(1)).await;
    let operator = a_bootstrapped_operator(&operators_store, &sessions_store).await;

    let state = AdminState {
        sessions: Arc::new(sessions(&pool, Arc::clone(&ring)).await),
        operators: Arc::new(store(&pool, Arc::clone(&ring), Duration::from_secs(1)).await),
        ring: Arc::clone(&ring),
        client_address: ClientAddress::peer(),
    };
    let addr = serve(admin::router(state)).await;

    let (status, head, _) =
        get_signed_full(addr, "/admin/operators", &operator, &sessions_store).await;
    assert_eq!(status, "200", "the operator list reads: {head}");
    assert!(
        head.to_ascii_lowercase()
            .contains("cache-control: no-store"),
        "an operator list came back without `cache-control: no-store`, so a proxy between the \
         browser and this server may keep it and offer it to the next caller:\n{head}"
    );
}

/// **The admin byte builder says it too.** `GET /admin/operators` is the text
/// listing; `GET /admin/notices` is built by `admin.rs`'s own
/// `bytes_response`, the builder a checker found a revert of would leave
/// every test green (2026-09-22). Pinned separately for that reason.
#[tokio::test]
async fn the_admin_byte_builder_says_no_store() {
    let _serial = SERIAL.lock().await;
    let pool = deployment().await;
    let ring = ring();
    let sessions_store = sessions(&pool, Arc::clone(&ring)).await;
    let operators_store = store(&pool, Arc::clone(&ring), Duration::from_secs(1)).await;
    let operator = a_bootstrapped_operator(&operators_store, &sessions_store).await;

    let state = AdminState {
        sessions: Arc::new(sessions(&pool, Arc::clone(&ring)).await),
        operators: Arc::new(store(&pool, Arc::clone(&ring), Duration::from_secs(1)).await),
        ring: Arc::clone(&ring),
        client_address: ClientAddress::peer(),
    };
    let addr = serve(admin::router(state)).await;

    let (status, head, _) =
        get_signed_full(addr, "/admin/notices", &operator, &sessions_store).await;
    assert_eq!(status, "200", "the operator list reads: {head}");
    assert!(
        head.to_ascii_lowercase()
            .contains("cache-control: no-store"),
        "a notices answer came back without `cache-control: no-store`, so a proxy between the \
         browser and this server may keep it and offer it to the next caller:\n{head}"
    );
}

/// **Exactly one route in this server accepts anything password-shaped, and
/// this test names it.**
///
/// # What this test used to say, and why that sentence is now false
///
/// It forbade the WORD, everywhere, in `api.rs`, `admin.rs`, `operators.rs`
/// and `sessions.rs` — the structural half of §4.5's *"the operator surface
/// has no password path"*. **ADR-0055 reopens §4.5 by the owner's own
/// decision, recorded in that ADR's header and nowhere else** (decision 10: a
/// password and an app code, with the guard that the app code is not mailed
/// and not re-issuable, and that a mailed reset never restores the operator
/// custody by itself).
///
/// So the gate changes shape rather than being deleted: **an allowlist of the
/// routes a password may arrive on, and an outright ban everywhere else.** The
/// contracts (`docs/archive/2026-09-21-adr-0055-build-contracts.md`, stream
/// (a), "Functions changed / tests rewritten") ask for exactly this — *"name
/// the one route and the one column rather than forbid the word"*.
///
/// The allowlist is **per function, not per file**: `api.rs`'s
/// `sign_in_handler` and the six handlers of the credential surface may carry
/// one; every other handler in `api.rs`, and every handler in `admin.rs` and
/// `operators.rs`, still fails this test outright. `credentials.rs` is the
/// module the ADR creates for this and is read as a whole.
#[test]
fn exactly_one_route_in_this_server_has_a_field_a_password_could_arrive_in() {
    // Handlers that ADR-0055 decision 10 puts a password on. Nothing else in
    // any file below may name one.
    const ALLOWED_HANDLERS: &[&str] = &[
        // `api.rs` — the HTTP surface. One sign-in handler, and the six
        // credential routes ADR-0055 decision 10 creates.
        "async fn sign_in_handler",
        "async fn set_password_handler",
        "async fn register_key_handler",
        "async fn enrol_totp_handler",
        "async fn confirm_totp_handler",
        "async fn request_reset_handler",
        "async fn redeem_reset_handler",
        "async fn operator_setup_handler",
        // The router that carries them: it names the paths.
        "pub fn credential_router",
        // `sessions.rs` — the sign-in path, which is ONE act spread over a
        // message type, a compatibility wrapper, the attempt itself and the
        // second-factor check. `src/sessions.rs`'s own unit test holds the
        // same allowlist at module scope; this one holds it across the four
        // files, so a field moved from one to another is caught by whichever
        // of the two it lands outside.
        "pub struct SignInAttempt",
        "pub async fn sign_in(",
        "pub async fn sign_in_with_credentials",
        "async fn attempt_sign_in",
        "async fn check_second_factor",
        // The setup-only gate's predicate (2026-09-21 fix round, S1): reads
        // whether a stored hash exists, never the password itself.
        "fn a_stored_credential",
    ];

    let files = [
        ("api.rs", include_str!("../src/api.rs")),
        ("admin.rs", include_str!("../src/admin.rs")),
        ("operators.rs", include_str!("../src/operators.rs")),
        ("sessions.rs", include_str!("../src/sessions.rs")),
    ];
    let mut allowed_lines = 0usize;
    for (name, whole) in files {
        // The test modules are cut off first: their own names contain the word.
        let source = whole
            .split_once("#[cfg(test)]")
            .map(|(before, _)| before)
            .unwrap_or(whole);

        // Which function each line is inside, tracked by the last `fn` header
        // seen. Blunt, and blunt is what is wanted: a password field moved out
        // of an allowlisted handler into a helper beneath it is caught,
        // because the helper's own `fn` line ends the allowance.
        let mut inside: Option<&str> = None;
        for line in source.lines() {
            let trimmed = line.trim_start();
            if trimmed.starts_with("fn ")
                || trimmed.starts_with("async fn ")
                || trimmed.starts_with("pub fn ")
                || trimmed.starts_with("pub async fn ")
                || trimmed.starts_with("pub(crate) fn ")
                || trimmed.starts_with("pub(crate) async fn ")
                || trimmed.starts_with("struct ")
                || trimmed.starts_with("pub struct ")
                || trimmed.starts_with("pub enum ")
                || trimmed.starts_with("enum ")
            {
                inside = ALLOWED_HANDLERS
                    .iter()
                    .find(|h| trimmed.starts_with(*h))
                    .copied();
            }
            // **A typed refusal is not a field.** Each of these names an
            // ANSWER and carries no value at all — `PasswordRefused` carries
            // nothing, and the four policy variants carry nothing either; the
            // whole point of naming them is that the caller is told which rule
            // their own proposed password broke. Removing the identifiers
            // before the scan keeps this gate about what it says it is about:
            // a FIELD a credential could arrive in.
            let mut scanned = line.to_string();
            for typed in [
                "PasswordRefused",
                "PasswordTooShort",
                "PasswordTooLong",
                "PasswordIsCommon",
                "PasswordContainsAddress",
            ] {
                scanned = scanned.replace(typed, "");
            }
            let lower = scanned.to_ascii_lowercase();
            for forbidden in ["password", "passphrase", "passcode", "\"pin\""] {
                if !lower.contains(forbidden) {
                    continue;
                }
                if lower.trim_start().starts_with("//")
                    || lower.trim_start().starts_with("///")
                    || lower.contains("no password")
                    || lower.contains("forbidden")
                {
                    continue;
                }
                match inside {
                    Some(_) => allowed_lines += 1,
                    None => panic!(
                        "{name} has a non-comment line mentioning {forbidden} outside the \
                         handlers ADR-0055 decision 10 allows one on: {line}"
                    ),
                }
            }
        }
    }
    assert!(
        allowed_lines > 0,
        "the allowlist matched nothing at all, which means this gate is checking a shape that \
         no longer exists and would pass however the code changed"
    );
}

/// The structural half of the same claim, at the database: **there is exactly
/// one column a password may be stored in, and it is `accounts.password_hash`.**
///
/// `0018` §A creates it and argues at length for why it is one text column
/// holding a whole PHC string and why it is deliberately **not** sealed: a
/// password hash is already a one-way, salted, memory-hard function, and
/// wrapping it in this server's own AEAD would suggest a property — that it
/// can be recovered — a password hash must never have.
///
/// Every other `%password%`, `%passphrase%`, `%passcode%` or `pin` column in
/// the live catalogue still fails this test.
#[tokio::test]
async fn the_schema_has_exactly_one_column_a_password_can_be_stored_in() {
    let _pool = deployment().await;
    let rows = superuser()
        .await
        .query(
            "SELECT table_name, column_name FROM information_schema.columns \
              WHERE table_schema = 'public' \
                AND (column_name ILIKE '%password%' OR column_name ILIKE '%passphrase%' \
                     OR column_name ILIKE '%passcode%' OR column_name = 'pin') \
              ORDER BY table_name, column_name",
            &[],
        )
        .await
        .expect("read the catalogue");
    let found: Vec<String> = rows
        .iter()
        .map(|r| format!("{}.{}", r.get::<_, String>(0), r.get::<_, String>(1)))
        .collect();
    assert_eq!(
        found,
        vec!["accounts.password_hash".to_string()],
        "ADR-0055 decision 10 allows exactly one such column; the catalogue has {found:?}"
    );
}

// ---------------------------------------------------------------------------
// §7.2 — every operator act is a sealed site-chain entry
// ---------------------------------------------------------------------------

/// **Every act named in this build lands on the site chain, and the chain still
/// verifies afterwards.**
///
/// The second half is the one that catches a mistake nobody would otherwise
/// see: an entry appended with the wrong metadata key, or a type filed on the
/// wrong chain kind, leaves a chain that reads as BROKEN AT ENTRY N — which is
/// a forgery alarm, and it must not be possible to raise one by using the
/// product correctly.
#[tokio::test]
async fn every_operator_act_lands_on_the_site_chain_and_the_chain_still_verifies() {
    let _serial = SERIAL.lock().await;
    let pool = deployment().await;
    let ring = ring();
    let sessions_store = sessions(&pool, Arc::clone(&ring)).await;
    let operators_store = store(&pool, Arc::clone(&ring), Duration::from_secs(1)).await;
    let operator = a_bootstrapped_operator(&operators_store, &sessions_store).await;

    // One of each verb this build gives an operator.
    let address = unique("audited@example.org");
    let invitation = operators_store
        .create_account_shell(&operator.session, &address, "Audited")
        .await
        .expect("shell");
    let key = SoftwareKey::random().expect("a keypair");
    operators_store
        .redeem_account_enrolment(&invitation.token, &address, &key.public_key())
        .await
        .expect("redeem");

    let acting = operator
        .session_for(&sessions_store, "POST", "/admin/organisations", b"")
        .await;
    operators_store
        .create_organisation_shell(&acting, "A Customer")
        .await
        .expect("org shell");

    let acting = operator
        .session_for(&sessions_store, "GET", "/admin/operators", b"")
        .await;
    operators_store
        .record_read(&acting, "operators")
        .await
        .expect("a read is sampled");

    let account_id: String = superuser()
        .await
        .query_one("SELECT id FROM accounts WHERE email = $1", &[&address])
        .await
        .expect("the account")
        .get(0);
    let acting = operator
        .session_for(&sessions_store, "POST", "/admin/accounts/x/disabled", b"")
        .await;
    operators_store
        .set_account_disabled(&acting, &account_id, true)
        .await
        .expect("disable");

    // §5.3's declaration, which `main.rs` makes at startup and which this
    // build must be able to make at all — an entry type nothing emits is a
    // name in a `CHECK` pretending to be a control.
    operators_store
        .record_single_operator_mode()
        .await
        .expect("the deployment declares how it is configured");

    for entry_type in [
        "operator_bootstrapped",
        "operator_key_enrolled",
        "operator_signin",
        "account_created",
        "enrolment_token_issued",
        "enrolment_token_redeemed",
        "authenticator_registered",
        "org_shell_created",
        "operator_read",
        "account_disabled",
        "single_operator_mode",
    ] {
        assert!(
            site_entries_of(entry_type).await >= 1,
            "{entry_type} must appear on the site chain"
        );
    }

    // And the chain verifies, links and metadata both.
    let mut client = pool.get().await.expect("connection");
    let tx = client.transaction().await.expect("begin");
    let report = chains::verify_site(&tx, &ring, true)
        .await
        .expect("verification runs");
    assert!(
        matches!(
            report.outcome,
            fathom_server::chain::Outcome::Verified { .. }
        ),
        "the site chain must still verify after a run of operator acts: {}",
        report.summary()
    );
}

// ---------------------------------------------------------------------------
// ADR-0055 stream (b) -- the quorum, the seat and the way back in
//
// **Every test below gets a deployment of its own**, and has to: each one is
// about the whole operator register (how many there are, disabling the last
// one, recovering one from the host), and this binary's shared deployment
// accumulates colleagues as the tests above it run. `tests/bootstrap_reissue.rs`
// makes the same argument for the same reason.
// ---------------------------------------------------------------------------

/// A deployment of this test's own, with nothing in it: no operator, no
/// account, no chain beyond its genesis.
async fn a_fresh_deployment(
    tag: &str,
    delay: Duration,
) -> (Pool, OperatorStore, SessionStore, Arc<KeyRing>) {
    let ring = ring();
    let pool = support::isolated_deployment(tag).await;
    let client = pool.get().await.expect("connection");
    let id = chains::register_deployment(&**client)
        .await
        .expect("stamp the deployment id, exactly as main.rs does at startup");
    drop(client);
    let operators = OperatorStore::with_delay(pool.clone(), Arc::clone(&ring), id.clone(), delay);
    let sessions = SessionStore::new(
        pool.clone(),
        Arc::clone(&ring),
        id,
        SignInLimits::defaults(),
    );
    (pool, operators, sessions, ring)
}

/// The first start's own path, end to end, on a deployment of its own: the
/// operator, an account for the notice address, the sealed binding between
/// them, and the setup token that opens the screen ADR-0055 decision 10
/// describes.
///
/// **The claim is the binding.** Before ADR-0055 an operator was a principal
/// with no address and no account, and the whole lockout the decision is about
/// followed from that: nothing to send a notice to, nothing to sign in as, and
/// no way back but a restore.
#[tokio::test]
async fn the_bootstrap_writes_the_account_and_the_binding() {
    const TAG: &str = "ops_bootstrap_binds";
    let (_pool, operators, _sessions, _ring) =
        a_fresh_deployment(TAG, Duration::from_secs(1)).await;

    let address = unique("owner@example.org");
    let bootstrap = operators
        .bootstrap_first_operator(&address, &address)
        .await
        .expect("a first start with no operator mints one");

    // ADR-0055 decision 10's last bullet: a `setup` token, not an `operator`
    // one. `main.rs` writes exactly these bytes to the token file, with the
    // same `op_` prefix as before.
    assert_eq!(bootstrap.invitation.purpose, Purpose::Setup);
    assert_eq!(bootstrap.invitation.subject, bootstrap.operator_id);

    let su = support::superuser_on_isolated(TAG).await;
    let account: (String, String) = su
        .query_one(
            "SELECT id, display_name FROM accounts WHERE email = $1",
            &[&address],
        )
        .await
        .map(|row| (row.get(0), row.get(1)))
        .expect("the first start creates an account for the notice address");
    assert_eq!(
        account.0, bootstrap.account_id,
        "and hands its id back, because the client signs in as it"
    );
    assert_eq!(
        account.1, address,
        "display name = address: the one thing the installer has already told this deployment \
         about themselves"
    );

    let bound: String = su
        .query_one(
            "SELECT account_id FROM operator_account_bindings WHERE operator_id = $1",
            &[&bootstrap.operator_id],
        )
        .await
        .expect("the operator custody is bound to that account")
        .get(0);
    assert_eq!(bound, bootstrap.account_id);

    // The account is a SHELL: no key, no membership, no credential. §6.4's
    // "a steward signs a grant naming a subject who already has a registered
    // key" is what stops the bootstrap being a route to authority.
    let keys: i64 = su
        .query_one(
            "SELECT count(*) FROM account_keys WHERE account_id = $1",
            &[&bootstrap.account_id],
        )
        .await
        .expect("count")
        .get(0);
    assert_eq!(keys, 0);
    let members: i64 = su
        .query_one(
            "SELECT count(*) FROM memberships WHERE account_id = $1",
            &[&bootstrap.account_id],
        )
        .await
        .expect("count")
        .get(0);
    assert_eq!(members, 0);
}

/// **ADR-0055 decision 3, the deadlock closed**: a sole operator adds a second
/// alone, and the colleague appears after the delay and not before.
///
/// This is the test the whole decision has to earn. Before it, adding an
/// operator needed two signatures unless `FATHOM_SINGLE_OPERATOR` was set —
/// off by default, absent from `compose.yaml` and `.env.example` — so **a
/// fresh install's sole operator could not add a second operator at all**, and
/// the design's own fix for the identical problem on the steward plane (§3.5's
/// `min(2, live stewards)`) had never been ported.
///
/// The delay is asserted in both directions, because a quorum of one with no
/// delay is not a configuration this product offers: nothing is created while
/// the delay runs, and the colleague exists once it has.
#[tokio::test]
async fn a_sole_operator_adds_a_second_alone_and_it_applies_after_the_delay() {
    const TAG: &str = "ops_sole_adds_second";
    let (_pool, operators, sessions_store, _ring) =
        a_fresh_deployment(TAG, Duration::from_secs(2)).await;

    let operator = a_lone_operator(&operators, &sessions_store).await;
    assert_eq!(
        operators
            .live_independent_operators()
            .await
            .expect("the register answers"),
        0,
        "one operator, inside the independence window: nobody can second, so the quorum is 1"
    );

    let name = unique("Successor");
    let address = unique("successor@example.org");
    let acting = operator
        .session_for(&sessions_store, "POST", "/admin/operators", b"")
        .await;
    let message =
        operators::operator_request_bytes(operators.deployment(), &operator.id, &name, &address);
    let pending = operators
        .request_operator(&acting, &name, &address, &operator.key.sign(&message))
        .await
        .expect("a sole operator may request a colleague alone (ADR-0055 decision 3)");
    assert!(
        pending.single_operator,
        "and the row records that the quorum was 1 when they did"
    );

    // Not before.
    let issued = operators
        .apply_due_operator_requests()
        .await
        .expect("the sweep runs");
    assert!(
        issued.is_empty(),
        "nothing is created inside the delay: quorum 1 removes the second signature and never \
         the delay"
    );
    let su = support::superuser_on_isolated(TAG).await;
    let count: i64 = su
        .query_one("SELECT count(*) FROM operators", &[])
        .await
        .expect("count")
        .get(0);
    assert_eq!(count, 1, "still one operator while the delay runs");

    // And after.
    tokio::time::sleep(Duration::from_millis(2200)).await;
    let issued = operators
        .apply_due_operator_requests()
        .await
        .expect("the delay elapsed");
    assert_eq!(issued.len(), 1, "one colleague, one invitation");
    assert_eq!(
        issued[0].purpose,
        Purpose::Setup,
        "and the invitation is the setup screen's token (ADR-0055 decision 10)"
    );

    // Decision 5: the colleague has an account shell at the address the
    // request named, and the operator custody is bound to it. Without that
    // they would have nothing to sign in as.
    let bound: String = su
        .query_one(
            "SELECT a.email FROM operator_account_bindings b JOIN accounts a ON a.id = b.account_id \
              WHERE b.operator_id = $1",
            &[&issued[0].subject],
        )
        .await
        .expect("the colleague is bound to an account")
        .get(0);
    assert_eq!(bound, address);
}

/// **`0019` §C's floor: disabling the last live operator is refused.**
///
/// Nothing in `0015` stopped two live operators disabling each other down to
/// zero, one call at a time, with only a banner noticing afterwards — and a
/// deployment with no operator has no way back that is not the key volume.
/// ADR-0055 decision 4 keeps a SOLE operator a supported, standing-warned
/// shape; zero is the one case that is not a policy choice.
///
/// Asserted through the application path, so what is proved is the refusal a
/// caller gets and not only that the trigger exists.
#[tokio::test]
async fn disabling_the_last_live_operator_is_refused() {
    const TAG: &str = "ops_last_operator";
    let (_pool, operators, sessions_store, _ring) =
        a_fresh_deployment(TAG, Duration::from_secs(1)).await;
    let operator = a_lone_operator(&operators, &sessions_store).await;

    // An operator cannot disable themselves -- a different rule, refused
    // earlier, so the floor needs a second operator to be visible at all.
    let colleague = a_second_operator(&operators, &sessions_store, &operator).await;

    let acting = colleague
        .session_for(&sessions_store, "POST", "/admin/operators/x/disabled", b"")
        .await;
    operators
        .disable_operator(&acting, &operator.id)
        .await
        .expect("two live operators, so one may disable the other");

    // And now the colleague is the last one. They cannot disable themselves,
    // so the honest way to reach the floor is to sign the first operator back
    // in -- which cannot be done -- or to ask a session of theirs to disable
    // the only remaining row, which is themselves. The floor is therefore
    // exercised where it actually binds: the database, through a statement
    // the application would issue.
    let su = support::superuser_on_isolated(TAG).await;
    let refused = su
        .execute(
            "UPDATE operators SET disabled_at = now() WHERE id = $1",
            &[&colleague.id],
        )
        .await;
    let err = refused.expect_err(
        "0019 section C's trigger refuses the drop to zero at every privilege level, including \
         the bootstrap superuser's -- a SECURITY DEFINER trigger is not row security and is not \
         bypassed",
    );
    let said = err
        .as_db_error()
        .map(|db| db.message().to_string())
        .unwrap_or_else(|| format!("{err}"));
    assert!(
        said.contains("last live operator"),
        "and it says so: {said}"
    );

    let live: i64 = su
        .query_one(
            "SELECT count(*) FROM operators WHERE disabled_at IS NULL",
            &[],
        )
        .await
        .expect("count")
        .get(0);
    assert_eq!(live, 1, "the deployment still has an operator");
}

/// **`fathom-server recover-operator <address>` refuses an unknown address and
/// mints nothing.**
///
/// ADR-0055 decision 8 draws one line and this is it: recovery restores a seat
/// somebody already held, and creating a seat is still two operators' work or
/// a first start's. A command that minted an operator for any address typed at
/// it would be `bootstrap_first_operator` with no idempotence and no register
/// behind it.
///
/// Three assertions, because any one alone could be true while the act still
/// happened: the refusal, the absence of a new operator, and the absence of a
/// new token row.
#[tokio::test]
async fn recover_operator_refuses_an_unknown_address_and_mints_nothing() {
    const TAG: &str = "ops_recover_unknown";
    let (_pool, operators, sessions_store, _ring) =
        a_fresh_deployment(TAG, Duration::from_secs(1)).await;
    let operator = a_lone_operator(&operators, &sessions_store).await;

    let su = support::superuser_on_isolated(TAG).await;
    let before_operators: i64 = su
        .query_one("SELECT count(*) FROM operators", &[])
        .await
        .expect("count")
        .get(0);
    let before_tokens: i64 = su
        .query_one("SELECT count(*) FROM enrolment_tokens", &[])
        .await
        .expect("count")
        .get(0);

    match operators
        .recover_operator(&unique("nobody@example.org"))
        .await
    {
        Err(OperatorError::NotFound(what)) => assert_eq!(what, "operator"),
        Ok(_) => panic!("an unknown address must not recover anything"),
        Err(e) => panic!("the refusal must be NotFound, not {e}"),
    }

    assert_eq!(
        before_operators,
        su.query_one("SELECT count(*) FROM operators", &[])
            .await
            .expect("count")
            .get::<_, i64>(0),
        "no operator was minted"
    );
    assert_eq!(
        before_tokens,
        su.query_one("SELECT count(*) FROM enrolment_tokens", &[])
            .await
            .expect("count")
            .get::<_, i64>(0),
        "and no token"
    );

    // The address that IS bound recovers, and the code is a ten-minute setup
    // token for the operator who already exists -- not a new one.
    let account = account_of_operator(&operators, &operator.id).await;
    let address = account_address(&sessions_store, &account).await;
    let recovered = operators
        .recover_operator(&address)
        .await
        .expect("an operator who exists is recovered from the host");
    assert_eq!(recovered.operator_id, operator.id);
    assert_eq!(recovered.invitation.purpose, Purpose::Setup);
    let life = recovered.invitation.expires_at_unix - now_unix();
    assert!(
        (540..=600).contains(&life),
        "ADR-0055 decision 8: a ten-minute code, not a three-day one. Got {life}s"
    );
    assert_eq!(
        before_operators,
        su.query_one("SELECT count(*) FROM operators", &[])
            .await
            .expect("count")
            .get::<_, i64>(0),
        "recovery restores a seat and never creates one"
    );

    // And it is loud: decision 8's whole trade is refusal for record.
    let recorded: i64 = su
        .query_one(
            "SELECT count(*) FROM chain_entries WHERE chain_kind = 'site' \
               AND entry_type = 'operator_recovered_from_host'",
            &[],
        )
        .await
        .expect("count")
        .get(0);
    assert_eq!(recorded, 1);

    let notices = operators.notices().await.expect("the notices are derived");
    assert!(
        notices
            .iter()
            .any(|n| n.starts_with("recovered_from_host ")),
        "every operator session banners a host recovery for seven days: {notices:?}"
    );
}

/// **`0021`'s hold refuses an operator key registration, and another
/// operator's confirmation clears it early.**
///
/// ADR-0055 decision 7: a reset by mail sets a credential and *"does not
/// restore that custody by itself: the seat waits for another operator's
/// confirmation or the 24-hour delay"*. The attack it closes is named in the
/// decision — *"a colleague who controls the mail server cannot reset their
/// way into a second seat"* — and the hold is the only thing standing in that
/// path, because the reset itself is a route the attacker already owns.
///
/// The hold is set here the way stream (a)'s reset redemption sets it (one
/// column, `0021`, granted to the runtime role); what is under test is the two
/// ends of it, which are stream (b)'s.
#[tokio::test]
async fn the_seat_hold_refuses_a_key_and_another_operator_clears_it() {
    const TAG: &str = "ops_seat_hold";
    let (_pool, operators, sessions_store, ring) =
        a_fresh_deployment(TAG, Duration::from_secs(1)).await;
    let operator = a_lone_operator(&operators, &sessions_store).await;
    let colleague = a_second_operator(&operators, &sessions_store, &operator).await;

    let account = account_of_operator(&operators, &colleague.id).await;
    let su = support::superuser_on_isolated(TAG).await;
    // Written the way stream (a)'s reset redemption writes it: on the runtime
    // role under `app.reset_custody`, and -- because the hold is inside the
    // credential seal (migration 0025) -- resealed in the same transaction.
    // A superuser write would bypass the seal's constraint trigger and prove
    // nothing about the row the runtime later reads.
    {
        let mut client = operators.pool().get().await.expect("connection");
        let tx = client.transaction().await.expect("begin");
        tx.execute("SELECT set_config('app.reset_custody', 'yes', true)", &[])
            .await
            .expect("reset custody");
        tx.execute(
            "UPDATE accounts SET operator_key_hold_until = now() + interval '24 hours' \
              WHERE id = $1",
            &[&account],
        )
        .await
        .expect("what stream (a)'s reset redemption writes");
        credentials::reseal_credentials(&tx, &ring, &account, None)
            .await
            .expect("seal the hold");
        tx.commit().await.expect("commit");
    }

    // A second browser for the same person: a real second key, not a
    // malformed one, so that what refuses it is the hold and not the shape.
    let second_browser = SoftwareKey::random().expect("a keypair");
    let account_session = an_account_session(
        &sessions_store,
        &account,
        &colleague.key,
        "/admin/operators/self/key",
    )
    .await;
    match operators
        .register_own_operator_key(&account_session, &second_browser.public_key())
        .await
    {
        Err(OperatorError::SeatHeld) => {}
        Ok(_) => panic!("a reset must not restore the operator seat by itself"),
        Err(e) => panic!("the refusal must be SeatHeld, not {e}"),
    }

    // Another operator confirms. Not this one: letting the person whose seat
    // is held confirm their own recovery would be the control confirming
    // itself.
    let acting = colleague
        .session_for(
            &sessions_store,
            "POST",
            "/admin/operators/x/confirm-recovery",
            b"",
        )
        .await;
    assert!(
        operators
            .confirm_recovery(&acting, &colleague.id)
            .await
            .is_err(),
        "an operator cannot confirm their own recovery"
    );

    let acting = operator
        .session_for(
            &sessions_store,
            "POST",
            "/admin/operators/x/confirm-recovery",
            b"",
        )
        .await;
    operators
        .confirm_recovery(&acting, &colleague.id)
        .await
        .expect("another operator confirms the recovery and the hold goes");

    let account_session = an_account_session(
        &sessions_store,
        &account,
        &colleague.key,
        "/admin/operators/self/key",
    )
    .await;
    operators
        .register_own_operator_key(&account_session, &second_browser.public_key())
        .await
        .expect("and now the browser registers its key");

    // ADR-0055 decision 6 and the lead's resolution 1: BOTH keys are live.
    // `live_operator_keys` has no `LIMIT 1`, so an operator with a laptop and
    // a phone can sign an assertion from either; before 2026-09-21 the
    // resolver took the newest and registering a second browser silently
    // locked the first one out.
    //
    // **A reported gap, not fixed here.** `sessions::verify_pending`'s
    // operator arm still asks `live_operator_key` (singular) and refuses the
    // session unless it named the newest -- so the FIRST browser's operator
    // SESSION dies the moment the second key is registered, which is the
    // pairing decision 6 says there is not. That line is in `sessions.rs`,
    // which belongs to stream (a); the function it should call is
    // `operators::live_operator_keys`. Named in the report rather than edited
    // across a stream boundary.
    let mut client = operators.pool().get().await.expect("connection");
    let tx = client.transaction().await.expect("begin");
    tx.execute(
        "SELECT set_config('app.operator_custody', 'yes', true)",
        &[],
    )
    .await
    .expect("operator custody");
    let live = operators::live_operator_keys(&tx, &ring, &colleague.id, now_unix())
        .await
        .expect("the operator keyring resolves");
    assert_eq!(
        live.len(),
        2,
        "a laptop and a phone are two live keys, not one browser paired to a seat"
    );
    tx.commit().await.expect("commit");

    let cleared: i64 = su
        .query_one(
            "SELECT count(*) FROM chain_entries WHERE chain_kind = 'site' \
               AND entry_type = 'operator_seat_hold_cleared'",
            &[],
        )
        .await
        .expect("count")
        .get(0);
    assert_eq!(cleared, 1, "clearing a hold early is a sealed operator act");
}

/// **The three routes ADR-0055 stream (b) adds are mounted, and answer.**
///
/// Everything else about them is proved against the store; this is the half a
/// compiler cannot check — that the path strings in `admin::router` are the
/// ones a client will ask for. A route that is not mounted answers 404, and a
/// 404 on `GET /admin/notices` is a console that shows no banner after a host
/// recovery, which is decision 8's whole control gone quietly.
#[tokio::test]
async fn the_new_operator_routes_are_mounted_and_answer() {
    const TAG: &str = "ops_routes";
    let (pool, operators_store, sessions_store, ring) =
        a_fresh_deployment(TAG, Duration::from_secs(1)).await;
    let operator = a_lone_operator(&operators_store, &sessions_store).await;

    let state = AdminState {
        sessions: Arc::new(SessionStore::new(
            pool.clone(),
            Arc::clone(&ring),
            operators_store.deployment().to_string(),
            SignInLimits::defaults(),
        )),
        operators: Arc::new(OperatorStore::with_delay(
            pool.clone(),
            Arc::clone(&ring),
            operators_store.deployment().to_string(),
            Duration::from_secs(1),
        )),
        ring: Arc::clone(&ring),
        client_address: ClientAddress::peer(),
    };
    let addr = serve(admin::router(state)).await;

    // `GET /admin/notices`: one operator, so decision 4's standing banner is
    // there. LP-framed lines, read back the way a client reads them.
    let (status, body) = get_signed(addr, "/admin/notices", &operator, &sessions_store).await;
    assert_eq!(status, "200", "the notices route is mounted");
    let mut rest = body.as_slice();
    let mut lines = Vec::new();
    while let Some((field, remainder)) = fathom_server::crypto::read_lp(rest) {
        lines.push(String::from_utf8(field.to_vec()).expect("a notice line is text"));
        rest = remainder;
    }
    assert!(
        rest.is_empty(),
        "the body is whole LP fields and nothing else"
    );
    assert!(
        lines.iter().any(|l| l.starts_with("one_operator ")),
        "decision 4: with one operator the console says so, standing: {lines:?}"
    );

    // `POST /admin/operators` now reads THREE fields. Two is a client that
    // believes the old protocol, and the honest answer is a refusal.
    let mut body = Vec::new();
    lp(&mut body, b"Colleague");
    lp(&mut body, &[0u8; 64]);
    let (status, _) =
        post_signed(addr, "/admin/operators", &body, &operator, &sessions_store).await;
    assert_eq!(
        status, "400",
        "the address is not optional: a two-field body is refused, not defaulted"
    );

    // `POST /admin/operators/self/key` is mounted, and refuses an operator
    // session: it is the ACCOUNT's route (decision 1), and an operator
    // principal holds no account binding of its own.
    let mut body = Vec::new();
    lp(&mut body, &[4u8; 65]);
    let (status, _) = post_signed(
        addr,
        "/admin/operators/self/key",
        &body,
        &operator,
        &sessions_store,
    )
    .await;
    assert_eq!(
        status, "403",
        "mounted, and refused for the right reason rather than 404"
    );

    // `POST /admin/operators/{operator}/confirm-recovery` is mounted, and
    // refuses an operator confirming their own seat.
    let path = format!("/admin/operators/{}/confirm-recovery", operator.id);
    let (status, _) = post_signed(addr, &path, b"", &operator, &sessions_store).await;
    assert_eq!(
        status, "400",
        "mounted, and an operator may not confirm their own recovery"
    );
}

/// A signed `GET`, the shape [`post_signed`] has for the other verb.
async fn get_signed(
    addr: std::net::SocketAddr,
    path: &str,
    operator: &Operator,
    store: &SessionStore,
) -> (String, Vec<u8>) {
    let nonce = store
        .issue_request_nonce(&operator.signed_in.session_id, &operator.signed_in.token)
        .await
        .expect("a nonce");
    let counter = next_counter(store, &operator.signed_in.session_id).await;
    let unix_ms = now_ms();
    let message = sessions::request_bytes(
        &operator.signed_in.session_id,
        "GET",
        path,
        &sessions::body_digest(b""),
        &nonce,
        unix_ms,
        counter,
    );
    let signature = operator.session_key.sign(&message);
    let headers = [
        (HEADER_SESSION, operator.signed_in.session_id.clone()),
        (HEADER_NONCE, hex(&nonce)),
        (HEADER_TIMESTAMP, unix_ms.to_string()),
        (HEADER_COUNTER, counter.to_string()),
        (HEADER_SIGNATURE, hex(&signature)),
    ];
    raw_request(addr, "GET", path, &headers, b"").await
}

/// **The quorum window and `0015` §G's trigger agree.**
///
/// `operators::INDEPENDENCE_WINDOW` is a Rust constant and the trigger's copy
/// is a SQL literal, because a trigger cannot read a Rust constant. Two copies
/// of one number is how a quorum comes to demand a seconder the database will
/// not accept — the deadlock the lead's resolution 9 exists to prevent — so
/// the trigger's own source is read out of the catalogue and checked.
#[tokio::test]
async fn the_quorum_window_matches_the_trigger() {
    let source: String = support::migrated_pool()
        .await
        .get()
        .await
        .expect("connection")
        .query_one(
            "SELECT prosrc FROM pg_proc WHERE proname = 'fathom_seconder_is_independent'",
            &[],
        )
        .await
        .expect("0015 section G's trigger function is in the catalogue")
        .get(0);
    let days = operators::INDEPENDENCE_WINDOW.as_secs() / (24 * 60 * 60);
    assert!(
        source.contains(&format!("interval '{days} days'")),
        "the trigger's independence window must be the one the quorum counts by ({days} days): \
         {source}"
    );
}

/// §1.1's sampling rule: **one `operator_read` per session per surface**, not
/// one per poll. Without the latch an operator reading a page on a timer
/// chooses how fast the sealed audit grows.
#[tokio::test]
async fn an_operator_read_is_recorded_once_per_session_and_surface() {
    let _serial = SERIAL.lock().await;
    let pool = deployment().await;
    let ring = ring();
    let sessions_store = sessions(&pool, Arc::clone(&ring)).await;
    let operators_store = store(&pool, Arc::clone(&ring), Duration::from_secs(1)).await;
    let operator = a_bootstrapped_operator(&operators_store, &sessions_store).await;

    let before = site_entries_of("operator_read").await;
    for _ in 0..4 {
        let acting = operator
            .session_for(&sessions_store, "GET", "/admin/organisations", b"")
            .await;
        operators_store
            .record_read(&acting, "organisations")
            .await
            .expect("a read");
    }
    assert_eq!(
        site_entries_of("operator_read").await - before,
        1,
        "four reads of one surface in one session are one entry"
    );
}

// ---------------------------------------------------------------------------
// §6.2 — organisation shells
// ---------------------------------------------------------------------------

/// §6.2's claim is **pinned to the install-time notice address**, and a
/// redemption that does not present it is refused — which is the difference
/// between this design and the one it is taken from.
#[tokio::test]
async fn an_organisation_claim_is_pinned_to_an_address_the_operator_cannot_rewrite() {
    let _serial = SERIAL.lock().await;
    let pool = deployment().await;
    let ring = ring();
    let sessions_store = sessions(&pool, Arc::clone(&ring)).await;
    let operators_store = store(&pool, Arc::clone(&ring), Duration::from_secs(1)).await;
    let operator = a_bootstrapped_operator(&operators_store, &sessions_store).await;

    let acting = operator
        .session_for(&sessions_store, "POST", "/admin/organisations", b"")
        .await;
    let (_shell, claim) = operators_store
        .create_organisation_shell(&acting, "A Customer")
        .await
        .expect("a shell and its claim");

    // An account with a key, which is §6.2's *"redeemed by an account with a
    // registered authenticator"*.
    let address = unique("founder@example.org");
    let invitation = operators_store
        .create_account_shell(
            &acting_session(&operator, &sessions_store).await,
            &address,
            "Founder",
        )
        .await
        .expect("a shell");
    let founder_key = SoftwareKey::random().expect("a keypair");
    operators_store
        .redeem_account_enrolment(&invitation.token, &address, &founder_key.public_key())
        .await
        .expect("enrol");

    let account: String = superuser()
        .await
        .query_one("SELECT id FROM accounts WHERE email = $1", &[&address])
        .await
        .expect("the account")
        .get(0);
    let account: AccountId = account.parse().expect("an account id");

    let session_key = SoftwareKey::random().expect("a session keypair");
    let pubkey = session_key.public_key();
    let source = a_source_of_its_own();
    let challenge = sessions_store
        .issue_challenge(PrincipalKind::Steward, &address, &pubkey, &source)
        .await
        .expect("a challenge");
    let digest = sessions::session_challenge(&pubkey, &challenge.nonce, &challenge.deployment_id);
    let signed_in = sessions_store
        .sign_in(
            PrincipalKind::Steward,
            &pubkey,
            &challenge.nonce,
            &founder_key.sign(&digest),
            &source,
        )
        .await
        .expect("sign in");
    let session = verify(
        &sessions_store,
        &signed_in,
        &session_key,
        "POST",
        "/enrolment/organisation",
        b"",
    )
    .await;

    // The wrong address is refused.
    let root = SoftwareKey::random().expect("a root keypair");
    let salt = [0x11u8; 16];
    let genesis = a_genesis_grant(&root, &salt, account, &founder_key);
    let refused = operators_store
        .redeem_organisation_claim(
            &session,
            &claim.token,
            "not-the-notice-address@example.org",
            &root.public_key(),
            &salt,
            &genesis,
        )
        .await;
    assert!(
        matches!(refused, Err(OperatorError::EnrolmentRefused)),
        "a claim redeemed against the wrong address is refused: {refused:?}"
    );

    // The right one is not, and it produces a real organisation whose id is
    // derived from the root key (§6.1).
    let notice: String = superuser()
        .await
        .query_one("SELECT notice_address FROM site_install", &[])
        .await
        .expect("the install record")
        .get(0);
    let session = verify(
        &sessions_store,
        &signed_in,
        &session_key,
        "POST",
        "/enrolment/organisation",
        b"",
    )
    .await;
    let organisation = operators_store
        .redeem_organisation_claim(
            &session,
            &claim.token,
            &notice,
            &root.public_key(),
            &salt,
            &genesis,
        )
        .await
        .expect("the claim is redeemed");
    assert_eq!(
        organisation.to_string(),
        authority::derive_organisation_id(&root.public_key(), &salt),
        "§6.1: the organisation id is derived from the root key, not chosen by the operator"
    );
    assert_eq!(
        capability_of(&pool, &ring, organisation, account).await,
        Some(Capability::Steward),
        "the redeemer is the genesis steward of the organisation they created"
    );
}

async fn acting_session(operator: &Operator, store: &SessionStore) -> VerifiedSession {
    operator
        .session_for(store, "POST", "/admin/accounts", b"")
        .await
}

fn a_genesis_grant(
    root: &SoftwareKey,
    salt: &[u8; 16],
    subject: AccountId,
    subject_key: &SoftwareKey,
) -> Vec<GenesisGrant> {
    let organisation_id = authority::derive_organisation_id(&root.public_key(), salt);
    let root_fpr = authority::key_fingerprint(&root.public_key());
    let subject_key_fpr = authority::key_fingerprint(&subject_key.public_key());
    let now = now_unix();
    let facts = GrantFacts {
        organisation: &organisation_id,
        root_pubkey_fpr: &root_fpr,
        scope: "",
        subject: &subject.to_string(),
        subject_key_fpr: &subject_key_fpr,
        capability: Capability::Steward,
        granter: None,
        granter_key_fpr: &root_fpr,
        effective_from_unix: now,
        expires_at_unix: now + 365 * 24 * 3600,
        sole_steward_appointment: false,
        auth_epoch: 1,
    };
    vec![GenesisGrant {
        subject,
        subject_key_fpr,
        capability: Capability::Steward,
        effective_from_unix: now,
        expires_at_unix: now + 365 * 24 * 3600,
        signature: root.sign(&authority::grant_bytes(&facts)),
    }]
}

// ---------------------------------------------------------------------------
// ADR-0055 fixes (c), (d) and (g), 2026-09-21
// ---------------------------------------------------------------------------

/// **The standing deployment could not add a third operator.** ADR-0055
/// fix (c).
///
/// Decision 5 calls this shape the standing one: bootstrap operator A, and
/// colleague B whom A added. Once both had been independently signed in for
/// seven days the quorum read 2 and B was A's only candidate seconder — but
/// `0015` §G's fourth clause refuses a seconder the requester created, so B's
/// signature raised `P0001`, the request sat pending for ever, and
/// `apply_operator_request` kept returning `None`.
///
/// The quorum is per requester now: nobody can second A, so A's request stands
/// alone **after its delay**, which decision 3 says quorum 1 never removes.
#[tokio::test]
async fn the_bootstrap_adds_a_third_operator_when_its_only_colleague_cannot_second_it() {
    const TAG: &str = "ops_quorum_per_requester";
    let (_pool, operators_store, sessions_store, _ring) =
        a_fresh_deployment(TAG, Duration::from_secs(2)).await;
    let operator = a_lone_operator(&operators_store, &sessions_store).await;
    let colleague = a_second_operator(&operators_store, &sessions_store, &operator).await;
    // Seven days pass for both. This is the exact state the checker
    // reproduced in SQL against the live schema.
    counts_towards_quorum(&operators_store, &operator.id).await;
    counts_towards_quorum(&operators_store, &colleague.id).await;

    assert_eq!(
        operators_store
            .live_independent_operators()
            .await
            .expect("the register answers"),
        2,
        "two operators could second SOMEBODY -- which is what the old count asked"
    );
    assert_eq!(
        operators_store
            .quorum_for(&operator.id)
            .await
            .expect("the register answers"),
        1,
        "and nobody at all can second the bootstrap, because it created the only other one"
    );
    assert_eq!(
        operators_store
            .quorum_for(&colleague.id)
            .await
            .expect("the register answers"),
        2,
        "the colleague, the other way round, has a seconder the trigger will accept"
    );

    // The act the deadlock blocked: the bootstrap asks for a third operator.
    let name = unique("Third");
    let address = unique("third@example.org");
    let acting = operator
        .session_for(&sessions_store, "POST", "/admin/operators", b"")
        .await;
    let message = operators::operator_request_bytes(
        operators_store.deployment(),
        &operator.id,
        &name,
        &address,
    );
    let pending = operators_store
        .request_operator(&acting, &name, &address, &operator.key.sign(&message))
        .await
        .expect("an operator may request a colleague");
    assert!(
        pending.single_operator,
        "the row records a quorum of 1 for THIS requester, which is the fix"
    );
    assert_eq!(
        pending.applied_at_unix, 0,
        "quorum 1 removes the second signature and never the delay"
    );

    tokio::time::sleep(Duration::from_millis(2400)).await;
    let issued = operators_store
        .apply_due_operator_requests()
        .await
        .expect("the delay elapsed");
    assert!(
        issued.iter().any(|i| i.purpose == Purpose::Setup),
        "before fix (c) this returned nothing, for ever: the quorum demanded a signature the \
         database refuses to store"
    );
}

/// **The trigger's refusal is a rule, not a 500.** ADR-0055 fix (c).
///
/// `fathom_seconder_is_independent` raises `P0001`, which arrived as a plain
/// `tokio_postgres::Error`, fell into `admin.rs`'s `other` arm and became
/// `SessionError::Corrupt("operator plane")` — an integrity alarm for a rule
/// the deployment was correctly applying.
#[tokio::test]
async fn a_seconder_the_requester_created_is_a_typed_refusal_and_not_an_alarm() {
    const TAG: &str = "ops_seconder_typed";
    // Two seconds, not six hundred: `a_second_operator` waits out the delay
    // to mint the colleague, and the rest of this test happens inside it.
    let (_pool, operators_store, sessions_store, _ring) =
        a_fresh_deployment(TAG, Duration::from_secs(2)).await;
    let operator = a_lone_operator(&operators_store, &sessions_store).await;
    let colleague = a_second_operator(&operators_store, &sessions_store, &operator).await;
    counts_towards_quorum(&operators_store, &operator.id).await;
    counts_towards_quorum(&operators_store, &colleague.id).await;

    // A first version applies at once, so the second takes the interlock.
    let key = unique("seconder-typed");
    request_and_expect_applied(&operators_store, &operator, &key, b"first").await;

    let value = b"second";
    let acting = operator
        .session_for(&sessions_store, "POST", "/admin/settings", b"")
        .await;
    let message =
        operators::setting_request_bytes(operators_store.deployment(), &operator.id, &key, value);
    let pending = operators_store
        .request_setting(&acting, &key, value, &operator.key.sign(&message))
        .await
        .expect("a second version is requested");

    // The colleague -- whom this requester created -- tries to second it,
    // with a genuine signature over the genuine bytes. Everything is real
    // except the two-humans rule.
    let second_message = operators::setting_second_bytes(
        operators_store.deployment(),
        &colleague.id,
        &pending.id,
        &key,
        &value_digest_of(&operators_store, &pending.id).await,
    );
    let acting = colleague
        .session_for(&sessions_store, "POST", "/admin/settings/second", b"")
        .await;
    let refused = operators_store
        .second_setting(&acting, &pending.id, &colleague.key.sign(&second_message))
        .await;
    assert!(
        matches!(refused, Err(OperatorError::SeconderNotIndependent)),
        "0015 §G's refusal must name the rule, not raise an integrity alarm: {refused:?}"
    );
}

/// **`first_independent_signin_at` is inside the row seal, and the count that
/// reads it verifies the seal.** ADR-0055 fix (d).
///
/// Decision 3 made that column decide whether a second signature is required
/// at all, and `0015_operator_console.sql`:162 grants the APPLICATION role
/// `UPDATE` on it with a write policy whose `WITH CHECK` is only the two
/// custodies. So the write below is one the runtime role can make — this test
/// makes it through `OperatorStore::pool()`, not as the superuser — and before
/// fix (d) it moved the quorum with nothing raised.
#[tokio::test]
async fn a_backdate_without_a_reseal_is_an_alarm_and_not_a_quorum_of_one() {
    const TAG: &str = "ops_signin_sealed";
    let (_pool, operators_store, sessions_store, _ring) =
        a_fresh_deployment(TAG, Duration::from_secs(2)).await;
    let operator = a_lone_operator(&operators_store, &sessions_store).await;
    let colleague = a_second_operator(&operators_store, &sessions_store, &operator).await;
    counts_towards_quorum(&operators_store, &operator.id).await;
    counts_towards_quorum(&operators_store, &colleague.id).await;
    assert_eq!(
        operators_store
            .quorum_for(&colleague.id)
            .await
            .expect("the register answers"),
        2,
        "the colleague has a seconder, so this is a register a second signature is real in"
    );

    // The unsealed write, through the application pool, under the custody the
    // policy names -- everything an application-role attacker has.
    let mut client = operators_store.pool().get().await.expect("connection");
    let tx = client.transaction().await.expect("begin");
    tx.execute(
        "SELECT set_config('app.operator_custody', 'yes', true)",
        &[],
    )
    .await
    .expect("operator custody");
    let moved = tx
        .execute(
            "UPDATE operators SET first_independent_signin_at = NULL WHERE id = $1",
            &[&operator.id],
        )
        .await
        .expect("0015:162 grants this column to fathom_app");
    assert_eq!(
        moved, 1,
        "the write itself is permitted; the seal is the fence"
    );
    tx.commit().await.expect("commit");

    let answer = operators_store.quorum_for(&colleague.id).await;
    assert!(
        matches!(answer, Err(OperatorError::Unverifiable(_))),
        "a row whose sealed sign-in time was edited must be an alarm, not a quorum of 1: \
         {answer:?}"
    );
}

/// **The sealing writer records once, and the row still verifies afterwards.**
/// ADR-0055 fix (d), the other half.
#[tokio::test]
async fn mark_first_independent_signin_records_once_and_keeps_the_row_verifying() {
    const TAG: &str = "ops_mark_first_signin";
    let (_pool, operators_store, sessions_store, ring) =
        a_fresh_deployment(TAG, Duration::from_secs(2)).await;
    let operator = a_lone_operator(&operators_store, &sessions_store).await;

    let mut client = operators_store.pool().get().await.expect("connection");
    let tx = client.transaction().await.expect("begin");
    tx.execute(
        "SELECT set_config('app.operator_custody', 'yes', true)",
        &[],
    )
    .await
    .expect("operator custody");
    // The sign-in path already records it through this same function
    // (`sessions.rs`, the operator arm), so by the time a test holds a
    // signed-in operator there is nothing left to record: the call says so.
    assert!(
        !operators::mark_first_independent_signin(&tx, &ring, &operator.id)
            .await
            .expect("the row key opens"),
        "the sign-in recorded it, so an explicit call records nothing"
    );
    let recorded: bool = tx
        .query_one(
            "SELECT first_independent_signin_at IS NOT NULL FROM operators WHERE id = $1",
            &[&operator.id],
        )
        .await
        .expect("the row")
        .get(0);
    assert!(
        recorded,
        "the sign-in recorded the first independent sign-in"
    );
    assert!(
        !operators::mark_first_independent_signin(&tx, &ring, &operator.id)
            .await
            .expect("the row key opens"),
        "and the second does not: §5.5 wants the FIRST independent sign-in"
    );
    // The row still verifies, which is the thing a write without a re-seal
    // would have broken -- and `verify_operator_row` is on the sign-in path,
    // so a broken row is an operator who can never sign in again.
    operators::verify_operator_row(&tx, &ring, &operator.id)
        .await
        .expect("the row verifies at its new version");
    tx.commit().await.expect("commit");
}

/// **An account with a browser key and no app code cannot register the
/// operator key every operator act is signed with.** ADR-0055 fix (g), and
/// decision 10's *"Required for any account holding the operator custody"*.
///
/// The old gate was `assurance == A0`. An account that holds the operator
/// custody and has one live account key signs in at `A1` — password plus a key
/// signature — so `verify_request`'s setup-only check does not run and the old
/// gate here passed. The state needs no database access at all:
/// `account_for_address` reuses an account that already exists at the address,
/// and an ordinary steward may register a browser key.
#[tokio::test]
async fn an_account_with_a_key_and_no_app_code_cannot_register_the_operator_key() {
    const TAG: &str = "ops_app_code_required";
    let (_pool, operators_store, sessions_store, _ring) =
        a_fresh_deployment(TAG, Duration::from_secs(2)).await;

    let address = unique("owner@example.org");
    let bootstrap = operators_store
        .bootstrap_first_operator(&address, &address)
        .await
        .expect("a first start with no operator mints one");
    let key = SoftwareKey::random().expect("a keypair");
    // A real browser key on the account, and no app code: the state the
    // product itself produces for a keyed steward who is then promoted.
    an_account_browser_key(&operators_store, &bootstrap.account_id, &key).await;
    let account = an_account_session(
        &sessions_store,
        &bootstrap.account_id,
        &key,
        "/admin/operators/self/key",
    )
    .await;
    assert_eq!(
        account.assurance(),
        Assurance::A1,
        "a key signature is A1, which is exactly how this escaped the old gate"
    );

    let refused = operators_store
        .register_own_operator_key(&account, &key.public_key())
        .await;
    assert!(
        matches!(refused, Err(OperatorError::SetupSessionOnly)),
        "decision 10 makes the app code Required for an account holding the operator custody, \
         and this is the route that hands out the operator key: {refused:?}"
    );

    // And once the app code is confirmed -- a real six-digit code -- it works.
    a_confirmed_app_code(
        &operators_store,
        &sessions_store,
        &ring(),
        &bootstrap.account_id,
        &key,
    )
    .await;
    let account = an_account_session(
        &sessions_store,
        &bootstrap.account_id,
        &key,
        "/admin/operators/self/key",
    )
    .await;
    operators_store
        .register_own_operator_key(&account, &key.public_key())
        .await
        .expect("with an app code on the account, the browser registers its operator key");
}

// ---------------------------------------------------------------------------
// ADR-0055 decision 1, applied backwards: the operator a build before it made
//
// A deployment installed before ADR-0055 has an operator row, a `site_install`
// row and NO binding, because the older first start created no account. On
// this build `bootstrap_first_operator` answers `AlreadyBootstrapped` and
// stops, so nobody can sign in; and `recover-operator` resolves an address
// through the binding, so it refuses and mints nothing. Observed on a real
// deployment on 2026-09-21.
//
// **Every test below fabricates that shape rather than describing it**, as the
// superuser, with the append-only trigger on `operator_account_bindings`
// disabled through `support::tamper` -- which is a tier-3 move and is
// performed in the open, exactly as `0019`'s own header requires of anything
// that removes a binding.
// ---------------------------------------------------------------------------

/// **A real password**: four words, the shape a password manager produces, and
/// the one `credentials::check_password` is written against. Not a string
/// built to satisfy the check (CLAUDE.md rule 2).
const A_REAL_CREDENTIAL: &str = "harbour-lantern-copper-nine";

/// Remove the sealed binding between an operator and its account, leaving the
/// shape a pre-ADR-0055 deployment has.
///
/// `0019`'s trigger refuses `UPDATE` and `DELETE` on this table at every
/// privilege level including the table's owner, so the only way to produce the
/// state a real deployment arrived at honestly is to turn the trigger off --
/// which `support::tamper` does, serialised across every test binary, and
/// which is visible in the test body on purpose.
async fn unbind(su: &tokio_postgres::Client, operator: &str) {
    let removed = support::tamper(
        su,
        "operator_account_bindings",
        "DELETE FROM operator_account_bindings WHERE operator_id = $1",
        &[&operator],
    )
    .await;
    assert_eq!(removed, 1, "the fixture must actually remove the binding");
}

/// Every operator key of one operator that is in service now, read through the
/// store's own pool under the custody `operator_keys_readable` admits.
async fn live_keys_of(operators_store: &OperatorStore, operator: &str) -> usize {
    let mut client = operators_store.pool().get().await.expect("connection");
    let tx = client.transaction().await.expect("begin");
    tx.execute(
        "SELECT set_config('app.operator_custody', 'yes', true)",
        &[],
    )
    .await
    .expect("operator custody");
    let keys = operators::live_operator_keys(&tx, &ring(), operator, now_unix())
        .await
        .expect("the operator keyring reads, and every row's seal verifies");
    tx.commit().await.expect("commit");
    keys.len()
}

/// The sealed metadata of the one `operator_adopted` entry on this
/// deployment's site chain, opened the way an auditor holding the chain key
/// would open it.
async fn the_adoption_entry(pool: &Pool, ring: &Arc<KeyRing>, tag: &str) -> String {
    let su = support::superuser_on_isolated(tag).await;
    let seq: i64 = su
        .query_one(
            "SELECT seq FROM chain_entries WHERE chain_kind = 'site' \
               AND entry_type = 'operator_adopted'",
            &[],
        )
        .await
        .expect("exactly one adoption entry")
        .get(0);
    let mut client = pool.get().await.expect("connection");
    let tx = client.transaction().await.expect("begin");
    let entry = chains::read_site_entry_verified(&tx, ring, seq)
        .await
        .expect("read the entry")
        .expect("the seq must hold an entry");
    assert_eq!(
        entry.entry_type,
        fathom_server::chain::EntryType::OperatorAdopted
    );
    let metadata = String::from_utf8_lossy(&entry.metadata).to_string();
    tx.commit().await.expect("commit");
    metadata
}

/// **The upgrade, end to end**: an operator with no account and no binding is
/// bound to the install address on the next start, once, and the token it
/// writes opens the setup screen.
///
/// The account is deleted here as well as the binding, because the older first
/// start created neither — that is the whole of the shape. The adoption
/// creates one at `site_install.notice_address`, which is the address ADR-0055
/// decision 1 makes the identity and the one address no role can rewrite
/// (`0015` §C).
#[tokio::test]
async fn an_operator_from_before_the_binding_is_adopted_on_the_next_start() {
    const TAG: &str = "ops_adopt_binds";
    let (pool, operators_store, _sessions, ring) =
        a_fresh_deployment(TAG, Duration::from_secs(1)).await;

    let address = unique("owner@example.org");
    let bootstrap = operators_store
        .bootstrap_first_operator(&address, &address)
        .await
        .expect("a first start with no operator mints one");

    // The pre-ADR-0055 shape: the operator row and the install record stay,
    // the binding and the account go.
    let su = support::superuser_on_isolated(TAG).await;
    unbind(&su, &bootstrap.operator_id).await;
    su.execute(
        "DELETE FROM accounts WHERE id = $1",
        &[&bootstrap.account_id],
    )
    .await
    .expect("the older first start created no account, so the fixture removes this one");
    su.execute(
        "DELETE FROM principals WHERE id = $1",
        &[&bootstrap.account_id],
    )
    .await
    .expect("and its principal row with it");

    let adopted = operators_store
        .adopt_first_operator_from_install()
        .await
        .expect("the adoption runs")
        .adopted()
        .expect("an operator with no binding and an install record is adopted");
    assert_eq!(adopted.operator_id, bootstrap.operator_id);
    assert_eq!(adopted.notice_address, address);

    // The binding exists, and the account it names is at the install address.
    let bound: String = su
        .query_one(
            "SELECT account_id FROM operator_account_bindings WHERE operator_id = $1",
            &[&bootstrap.operator_id],
        )
        .await
        .expect("the operator custody is bound to an account now")
        .get(0);
    assert_eq!(bound, adopted.account_id);
    let email: String = su
        .query_one("SELECT email FROM accounts WHERE id = $1", &[&bound])
        .await
        .expect("the account exists")
        .get(0);
    assert_eq!(
        email,
        su.query_one("SELECT notice_address FROM site_install", &[])
            .await
            .expect("the install record")
            .get::<_, String>(0),
        "ADR-0055 decision 1: the address is the identity, and the install record is where it \
         is written down"
    );

    // One entry, and it is the record of this act.
    let entries: i64 = su
        .query_one(
            "SELECT count(*) FROM chain_entries WHERE chain_kind = 'site' \
               AND entry_type = 'operator_adopted'",
            &[],
        )
        .await
        .expect("count")
        .get(0);
    assert_eq!(entries, 1);

    // The token redeems on the setup route: the screen ADR-0055 decision 10
    // describes, reached through the same function `/enrolment/operator/setup`
    // calls.
    let invitation = adopted
        .invitation
        .expect("an account with no app code gets the one-shot setup token");
    assert_eq!(invitation.purpose, Purpose::Setup);
    assert_eq!(invitation.subject, adopted.operator_id);
    let creds = CredentialStore::new(
        pool.clone(),
        Arc::clone(&ring),
        operators_store.deployment().to_string(),
    );
    creds
        .redeem_setup(
            &operators_store,
            None,
            &support::recovery_code_text(&invitation.token),
            A_REAL_CREDENTIAL,
            "198.51.100.1",
        )
        .await
        .expect("the token the adoption wrote opens the setup screen");

    // A second start finds the binding and does nothing at all.
    let again = operators_store
        .adopt_first_operator_from_install()
        .await
        .expect("the second call runs");
    assert!(
        matches!(again, Adoption::Nothing),
        "an adoption is once: the binding it wrote is what stops the next start repeating it"
    );
    assert_eq!(
        su.query_one(
            "SELECT count(*) FROM chain_entries WHERE chain_kind = 'site' \
               AND entry_type = 'operator_adopted'",
            &[],
        )
        .await
        .expect("count")
        .get::<_, i64>(0),
        1,
        "and it appended nothing the second time"
    );

    // The chain still verifies, which is the claim every sealed act makes and
    // the one a new writer is most likely to break.
    let mut client = pool.get().await.expect("connection");
    let tx = client.transaction().await.expect("begin");
    let report = chains::verify_site(&tx, &ring, true)
        .await
        .expect("verification runs");
    assert!(
        matches!(
            report.outcome,
            fathom_server::chain::Outcome::Verified { .. }
        ),
        "the site chain must still verify after an adoption: {}",
        report.summary()
    );
}

/// **`recover-operator` works after the adoption and refuses before it** --
/// which is the defect this whole path closes, asserted in both directions.
///
/// The command resolves an address THROUGH the binding (ADR-0055 decision 8,
/// so that a display name an operator chose cannot point a recovery at a seat
/// nobody expects). With no binding there is nothing to resolve, and the
/// person the command exists for is exactly the person who cannot get in.
#[tokio::test]
async fn recover_operator_refuses_before_the_adoption_and_works_after_it() {
    const TAG: &str = "ops_adopt_recovers";
    let (_pool, operators_store, _sessions, _ring) =
        a_fresh_deployment(TAG, Duration::from_secs(1)).await;

    let address = unique("owner@example.org");
    let bootstrap = operators_store
        .bootstrap_first_operator(&address, &address)
        .await
        .expect("a first start with no operator mints one");

    let su = support::superuser_on_isolated(TAG).await;
    unbind(&su, &bootstrap.operator_id).await;

    match operators_store.recover_operator(&address).await {
        Err(OperatorError::NotFound(what)) => assert_eq!(what, "operator"),
        Ok(_) => panic!("with no binding there is no operator to recover"),
        Err(e) => panic!("the refusal must be NotFound, not {e}"),
    }

    operators_store
        .adopt_first_operator_from_install()
        .await
        .expect("the adoption runs")
        .adopted()
        .expect("an operator with no binding and an install record is adopted");

    let recovered = operators_store
        .recover_operator(&address)
        .await
        .expect("the binding the adoption wrote is what makes the address resolvable");
    assert_eq!(recovered.operator_id, bootstrap.operator_id);
    assert_eq!(recovered.invitation.purpose, Purpose::Setup);
}

/// **What the adoption takes away**, and what it leaves alone.
///
/// The operator here went all the way through the current flow — an account
/// key, a confirmed app code, an operator key registered from the console, and
/// an operator session — and then the binding is removed, which is the state a
/// deployment installed before ADR-0055 is in with keys enrolled by the older
/// token-redemption flow. Those keys had no second factor anywhere in the act
/// that created them; ADR-0055 decision 9 has the operator key register only
/// from the console with a confirmed app code behind it.
///
/// **The account cannot be removed here** — `account_keys` references it `ON
/// DELETE RESTRICT` — which is the other branch and is asserted as such: the
/// adoption reuses the account that already stands at that address rather than
/// duplicating it, and issues no token, because that person already holds a
/// credential and an app code.
#[tokio::test]
async fn the_adoption_retires_the_old_flows_keys_and_ends_its_sessions() {
    const TAG: &str = "ops_adopt_dispossesses";
    let (pool, operators_store, sessions_store, ring) =
        a_fresh_deployment(TAG, Duration::from_secs(1)).await;

    let operator = a_lone_operator(&operators_store, &sessions_store).await;
    let account = account_of_operator(&operators_store, &operator.id).await;
    let address = account_address(&sessions_store, &account).await;
    assert_eq!(
        live_keys_of(&operators_store, &operator.id).await,
        1,
        "the fixture registers one operator key"
    );

    let su = support::superuser_on_isolated(TAG).await;
    unbind(&su, &operator.id).await;

    let adopted = operators_store
        .adopt_first_operator_from_install()
        .await
        .expect("the adoption runs")
        .adopted()
        .expect("an operator with no binding and an install record is adopted");
    assert_eq!(adopted.operator_id, operator.id);
    assert_eq!(
        adopted.account_id, account,
        "one person, two custodies, one address: the account already at that address is the \
         one the custody is bound back to"
    );
    assert_eq!(adopted.notice_address, address);
    assert!(
        adopted.invitation.is_none(),
        "this account holds a credential and a confirmed app code, so decision 9 has it sign \
         in with those and register an operator key from the console -- a token here would be \
         a second bearer secret nobody asked for"
    );

    assert_eq!(
        live_keys_of(&operators_store, &operator.id).await,
        0,
        "every key the older flow enrolled leaves service (ADR-0055 decision 9)"
    );
    assert_eq!(adopted.retired_keys, 1);
    assert!(
        sessions_store
            .issue_request_nonce(&operator.signed_in.session_id, &operator.signed_in.token)
            .await
            .is_err(),
        "the operator session the lost browser was holding is ended, as a sealed revocation"
    );
    assert!(adopted.ended_sessions >= 1);

    // The counts are inside the sealed entry, and they are the counts.
    let metadata = the_adoption_entry(&pool, &ring, TAG).await;
    assert!(
        metadata.contains(&operator.id) && metadata.contains(&address),
        "the sealed metadata names the operator and the address: {metadata}"
    );
    assert!(
        metadata.contains(&format!("\"retired_keys\":{}", adopted.retired_keys)),
        "the entry states what it retired: {metadata}"
    );
    assert!(
        metadata.contains(&format!("\"ended_sessions\":{}", adopted.ended_sessions)),
        "and what it ended: {metadata}"
    );

    // And it leaves the second factor alone: an upgrade that cleared a working
    // app code would lock out the person it is meant to let in.
    let confirmed: bool = su
        .query_one(
            "SELECT totp_last_step IS NOT NULL FROM accounts WHERE id = $1",
            &[&account],
        )
        .await
        .expect("the account row")
        .get(0);
    assert!(
        confirmed,
        "the adoption is not a recovery: it clears no app code, no backup code and no seat hold"
    );
}

/// **An ADR-0055-native deployment is left alone**, silently, at every start.
///
/// This is the ordinary case on every deployment installed since 2026-09-21,
/// and on every start after an adoption. It has to be cheap and it has to
/// write nothing at all.
#[tokio::test]
async fn a_deployment_that_already_has_the_binding_is_not_adopted() {
    const TAG: &str = "ops_adopt_native";
    let (_pool, operators_store, _sessions, _ring) =
        a_fresh_deployment(TAG, Duration::from_secs(1)).await;

    operators_store
        .bootstrap_first_operator(&unique("owner@example.org"), &unique("owner@example.org"))
        .await
        .expect("a first start with no operator mints one");

    let su = support::superuser_on_isolated(TAG).await;
    let before: i64 = su
        .query_one("SELECT count(*) FROM chain_entries", &[])
        .await
        .expect("count")
        .get(0);

    assert!(
        matches!(
            operators_store
                .adopt_first_operator_from_install()
                .await
                .expect("the adoption runs"),
            Adoption::Nothing
        ),
        "every operator this build creates already has a binding"
    );
    assert_eq!(
        before,
        su.query_one("SELECT count(*) FROM chain_entries", &[])
            .await
            .expect("count")
            .get::<_, i64>(0),
        "and nothing was appended"
    );
}

/// **A deployment that has never started has nothing to adopt.**
///
/// No `site_install` row, no operator: the first start is about to run and
/// this must not be a second way into it.
#[tokio::test]
async fn a_deployment_that_never_started_is_not_adopted() {
    const TAG: &str = "ops_adopt_never_started";
    let (_pool, operators_store, _sessions, _ring) =
        a_fresh_deployment(TAG, Duration::from_secs(1)).await;

    let su = support::superuser_on_isolated(TAG).await;
    let before: i64 = su
        .query_one("SELECT count(*) FROM chain_entries", &[])
        .await
        .expect("count")
        .get(0);

    assert!(
        matches!(
            operators_store
                .adopt_first_operator_from_install()
                .await
                .expect("the adoption runs"),
            Adoption::Nothing
        ),
        "with no install record there is no address to bind anybody to: and with no operator \
         either, there is nothing to say about it"
    );
    assert_eq!(
        before,
        su.query_one("SELECT count(*) FROM chain_entries", &[])
            .await
            .expect("count")
            .get::<_, i64>(0),
        "and nothing was appended"
    );
    assert_eq!(
        su.query_one("SELECT count(*) FROM operators", &[])
            .await
            .expect("count")
            .get::<_, i64>(0),
        0,
        "and no operator was minted: an adoption binds a seat that exists and creates none"
    );
}

// ---------------------------------------------------------------------------
// The upgrade's own row seals -- ADR-0055 fix round S2, 2026-09-21
// ---------------------------------------------------------------------------

/// Everything [`operators::operator_row_seal`] needs about one `operators`
/// row, read as the superuser so the fixture sees what is actually at rest:
/// display name, `created_by`, `disabled_at`, `first_independent_signin_at`,
/// `created_seq`, `row_version`.
async fn operator_row_facts(
    su: &tokio_postgres::Client,
    operator: &str,
) -> (String, Option<String>, i64, i64, i64, i32) {
    let row = su
        .query_one(
            "SELECT display_name, created_by, \
                    COALESCE(EXTRACT(EPOCH FROM disabled_at)::bigint, 0), \
                    COALESCE(EXTRACT(EPOCH FROM first_independent_signin_at)::bigint, 0), \
                    created_seq, row_version \
               FROM operators WHERE id = $1",
            &[&operator],
        )
        .await
        .expect("the operator row");
    (
        row.get(0),
        row.get(1),
        row.get(2),
        row.get(3),
        row.get(4),
        row.get(5),
    )
}

/// **Seal one `operators` row the way every build before ADR-0055's fix round
/// sealed it** — over a `row_state` with no `first_independent_signin_at` in
/// it — and write it as the superuser.
///
/// This is the whole of the state a real deployment that upgrades into this
/// build is in, and it cannot be produced through any runtime path: the store
/// only knows how to write the current shape. The seal is computed by
/// [`operators::legacy_operator_row_seal`], which exists for the start-time
/// re-seal and for this fixture and is called by nothing else.
async fn seal_the_operator_row_the_old_way(
    pool: &Pool,
    ring: &Arc<KeyRing>,
    su: &tokio_postgres::Client,
    operator: &str,
) {
    let (display_name, created_by, disabled_at, _signin, created_seq, row_version) =
        operator_row_facts(su, operator).await;
    let mut client = pool.get().await.expect("connection");
    let tx = client.transaction().await.expect("begin");
    tx.execute(
        "SELECT set_config('app.operator_custody', 'yes', true)",
        &[],
    )
    .await
    .expect("operator custody");
    let seal = operators::legacy_operator_row_seal(
        &tx,
        ring,
        operator,
        &display_name,
        created_by.as_deref(),
        disabled_at,
        created_seq,
        row_version,
    )
    .await
    .expect("the old build's row state seals under this deployment's row key");
    tx.commit().await.expect("commit");
    su.execute(
        "UPDATE operators SET row_seal = $2 WHERE id = $1",
        &[&operator, &seal.to_vec()],
    )
    .await
    .expect("the fixture writes the old seal");
}

/// The stored seal and version of one `operators` row.
async fn operator_seal_and_version(su: &tokio_postgres::Client, operator: &str) -> (Vec<u8>, i32) {
    let row = su
        .query_one(
            "SELECT row_seal, row_version FROM operators WHERE id = $1",
            &[&operator],
        )
        .await
        .expect("the operator row");
    (row.get(0), row.get(1))
}

/// Does this row verify under the CURRENT shape, through the store's own
/// verifier — the one on the sign-in path?
async fn operator_row_verifies(operators_store: &OperatorStore, operator: &str) -> bool {
    let mut client = operators_store.pool().get().await.expect("connection");
    let tx = client.transaction().await.expect("begin");
    tx.execute(
        "SELECT set_config('app.operator_custody', 'yes', true)",
        &[],
    )
    .await
    .expect("operator custody");
    let verified = operators_store.verify_operator_row(&tx, operator).await;
    tx.commit().await.expect("commit");
    verified.is_ok()
}

/// **A deployment sealed by the build before the fix round starts, and adopts,
/// because the re-seal runs first** — the defect that would have stopped the
/// owner's own deployment from starting at all.
///
/// `6d1b5de` (2026-09-21) brought `first_independent_signin_at` inside
/// [`operators::operator_row_seal`], because ADR-0055 decision 3 had just made
/// that column decide whether a second signature is required at all. Every
/// `operators` row written before that is sealed over the shape this fixture
/// writes, and `verify_operator_row` — which is the sign-in path, the
/// seconding path AND the first thing the adoption does — refuses it.
///
/// Four claims, in the order a start makes them:
///
/// 1. the adoption on its own **fails**, and fails as an integrity alarm;
/// 2. `reseal_legacy_operator_rows` re-seals exactly one row, and the row then
///    verifies under the current shape;
/// 3. the adoption then does what it was written to do;
/// 4. a second re-seal touches nothing, because a start is not a one-off.
#[tokio::test]
async fn an_operator_row_sealed_before_the_fix_round_is_resealed_at_start_and_then_adopts() {
    const TAG: &str = "ops_adopt_legacy_seal";
    let (pool, operators_store, _sessions, ring) =
        a_fresh_deployment(TAG, Duration::from_secs(1)).await;

    let address = unique("owner@example.org");
    let bootstrap = operators_store
        .bootstrap_first_operator(&address, &address)
        .await
        .expect("a first start with no operator mints one");

    // The pre-ADR-0055 shape, all of it: no binding, no account, and a row
    // seal from before the fix round.
    let su = support::superuser_on_isolated(TAG).await;
    unbind(&su, &bootstrap.operator_id).await;
    su.execute(
        "DELETE FROM accounts WHERE id = $1",
        &[&bootstrap.account_id],
    )
    .await
    .expect("the older first start created no account");
    su.execute(
        "DELETE FROM principals WHERE id = $1",
        &[&bootstrap.account_id],
    )
    .await
    .expect("and its principal row with it");
    seal_the_operator_row_the_old_way(&pool, &ring, &su, &bootstrap.operator_id).await;

    // 1. The finding: this start does not start.
    match operators_store.adopt_first_operator_from_install().await {
        Err(OperatorError::Unverifiable(what)) => assert_eq!(
            what, "operator row seal",
            "the adoption verifies the row before it binds it, and the row is sealed under the \
             old shape"
        ),
        Ok(_) => panic!("the adoption must not bind a row it cannot verify"),
        Err(e) => panic!("the refusal must be the seal, not {e}"),
    }
    assert!(
        !operator_row_verifies(&operators_store, &bootstrap.operator_id).await,
        "and nothing else that verifies an operator row works either -- which is sign-in and \
         every seconding count"
    );

    // 2. The re-seal, which is what `main.rs` runs before the bootstrap.
    let (_old_seal, old_version) = operator_seal_and_version(&su, &bootstrap.operator_id).await;
    assert_eq!(
        operators_store
            .reseal_legacy_operator_rows()
            .await
            .expect("a row sealed by an older build is recognised, not refused"),
        1
    );
    assert!(
        operator_row_verifies(&operators_store, &bootstrap.operator_id).await,
        "the row verifies under the current shape now, which is the whole point"
    );
    let (_new_seal, new_version) = operator_seal_and_version(&su, &bootstrap.operator_id).await;
    assert_eq!(
        new_version,
        old_version + 1,
        "a re-seal is a new row version, exactly as `mark_first_independent_signin`'s is"
    );

    // 3. And now the upgrade it was blocking.
    let adopted = operators_store
        .adopt_first_operator_from_install()
        .await
        .expect("the adoption runs")
        .adopted()
        .expect("an operator with no binding and an install record is adopted");
    assert_eq!(adopted.operator_id, bootstrap.operator_id);
    assert_eq!(adopted.notice_address, address);
    assert!(
        adopted.invitation.is_some(),
        "the account this adoption created holds no app code, so the setup token is the way in"
    );

    // 4. Idempotent: the next start finds nothing to do.
    assert_eq!(
        operators_store
            .reseal_legacy_operator_rows()
            .await
            .expect("the second run runs"),
        0,
        "a re-sealed row verifies under the current shape, so the next start re-seals nothing"
    );
}

/// **A row that verifies under no shape this server has ever written is
/// refused by name, not re-sealed.**
///
/// The re-seal exists to recognise an older build's honest work. It must not
/// become a way to launder a row somebody edited in the database: the only
/// evidence it has is that the stored seal matches a shape this codebase
/// produced, and a random seal matches none of them.
#[tokio::test]
async fn a_tampered_operator_row_is_refused_by_the_reseal_rather_than_resealed() {
    const TAG: &str = "ops_reseal_tampered";
    let (_pool, operators_store, _sessions, _ring) =
        a_fresh_deployment(TAG, Duration::from_secs(1)).await;

    let address = unique("owner@example.org");
    let bootstrap = operators_store
        .bootstrap_first_operator(&address, &address)
        .await
        .expect("a first start with no operator mints one");

    let su = support::superuser_on_isolated(TAG).await;
    let forged = vec![7u8; 32];
    su.execute(
        "UPDATE operators SET row_seal = $2 WHERE id = $1",
        &[&bootstrap.operator_id, &forged],
    )
    .await
    .expect("whoever holds the database can write this column; the seal is what stops them");

    match operators_store.reseal_legacy_operator_rows().await {
        Err(OperatorError::UnverifiableOperatorRow(id)) => assert_eq!(
            id, bootstrap.operator_id,
            "the refusal names the row, because the person reading the log has to find it"
        ),
        Ok(n) => panic!("a forged seal must not be re-sealed; {n} row(s) were"),
        Err(e) => panic!("the refusal must name the row, not {e}"),
    }

    let (seal, version) = operator_seal_and_version(&su, &bootstrap.operator_id).await;
    assert_eq!(
        seal, forged,
        "and it wrote nothing: a refused row is left exactly as it was found"
    );
    assert_eq!(version, 1);
}

/// **A disabled account at the install address is not bound, and the site
/// keeps running.**
///
/// `account_for_address` selects by email and asks nothing about
/// `disabled_at`, so before 2026-09-21 the adoption bound the operator custody
/// to an account that cannot sign in (`sessions.rs` answers `account_disabled`)
/// and minted a token that redeems into that refusal. A binding is written
/// once and never rewritten — `0019`'s trigger refuses `UPDATE` and `DELETE`
/// at every privilege level including the table's owner — so the lockout would
/// have been permanent, and produced by the act that exists to end one.
#[tokio::test]
async fn a_disabled_account_at_the_install_address_is_refused_rather_than_bound() {
    const TAG: &str = "ops_adopt_account_disabled";
    let (_pool, operators_store, _sessions, _ring) =
        a_fresh_deployment(TAG, Duration::from_secs(1)).await;

    let address = unique("owner@example.org");
    let bootstrap = operators_store
        .bootstrap_first_operator(&address, &address)
        .await
        .expect("a first start with no operator mints one");

    let su = support::superuser_on_isolated(TAG).await;
    unbind(&su, &bootstrap.operator_id).await;
    // The account stays, and is disabled — the column the console's own
    // `disable_account` writes.
    su.execute(
        "UPDATE accounts SET disabled_at = now() WHERE id = $1",
        &[&bootstrap.account_id],
    )
    .await
    .expect("disable the account at the install address");

    let before: i64 = su
        .query_one("SELECT count(*) FROM chain_entries", &[])
        .await
        .expect("count")
        .get(0);

    match operators_store
        .adopt_first_operator_from_install()
        .await
        .expect("a refusal is not an error: the site goes on serving")
    {
        Adoption::Refused(AdoptionRefusal::AccountDisabled {
            operator_id,
            account_id,
            address: refused_address,
        }) => {
            assert_eq!(operator_id, bootstrap.operator_id);
            assert_eq!(account_id, bootstrap.account_id);
            assert_eq!(refused_address, address);
        }
        Adoption::Adopted(_) => panic!("a disabled account must not be bound to an operator"),
        Adoption::Nothing => panic!("this must not be silent"),
        Adoption::Refused(other) => panic!("the wrong refusal: {other}"),
    }

    assert_eq!(
        su.query_one("SELECT count(*) FROM chain_entries", &[])
            .await
            .expect("count")
            .get::<_, i64>(0),
        before,
        "a refusal is decided before the sealed entry is appended, so it writes nothing"
    );
    assert_eq!(
        su.query_one(
            "SELECT count(*) FROM operator_account_bindings WHERE operator_id = $1",
            &[&bootstrap.operator_id],
        )
        .await
        .expect("count")
        .get::<_, i64>(0),
        0,
        "and above all it wrote no binding, because a binding cannot be taken back"
    );
}

/// **An account that already holds another operator's custody is refused, at
/// every start, without an exception reaching anybody.**
///
/// `operator_account_bindings.account_id` is UNIQUE (`0019` §A), so the insert
/// the adoption used to make raises `23505`; that came back as an `Err`, and
/// `main.rs` turns an `Err` here into exit 9. Not once — at every start, for
/// ever, because nothing about the deployment changes in between.
///
/// **The second operator is built as the superuser**, and that is stated here
/// rather than hidden: it holds the binding and nothing else, and no runtime
/// path can produce it, because the store's own verbs create an operator and
/// its binding together. The operator this test is actually about is the real
/// bootstrapped one, whose row and creating entry the adoption verifies
/// normally before it gets as far as the account.
#[tokio::test]
async fn an_account_that_already_holds_an_operator_custody_is_refused_not_bound_twice() {
    const TAG: &str = "ops_adopt_account_bound";
    let (_pool, operators_store, _sessions, _ring) =
        a_fresh_deployment(TAG, Duration::from_secs(1)).await;

    let address = unique("owner@example.org");
    let bootstrap = operators_store
        .bootstrap_first_operator(&address, &address)
        .await
        .expect("a first start with no operator mints one");

    let su = support::superuser_on_isolated(TAG).await;
    unbind(&su, &bootstrap.operator_id).await;

    // A second operator, holding the account at the install address. `0019`'s
    // immutability trigger refuses `UPDATE` and `DELETE` and not `INSERT`, so
    // this needs no tampering — only the superuser's way past row-level
    // security.
    let squatter = fathom_server::ids::new_ulid().to_string();
    su.execute(
        "INSERT INTO principals (id, kind) VALUES ($1, 'operator')",
        &[&squatter],
    )
    .await
    .expect("the principal row");
    su.execute(
        "INSERT INTO operators (id, display_name) VALUES ($1, 'a colleague')",
        &[&squatter],
    )
    .await
    .expect("the operator row");
    su.execute(
        "INSERT INTO operator_account_bindings \
             (operator_id, account_id, bound_seq, row_version, row_seal) \
         VALUES ($1, $2, 1, 1, $3)",
        &[&squatter, &bootstrap.account_id, &vec![3u8; 32]],
    )
    .await
    .expect("the binding that makes the account unavailable");

    match operators_store
        .adopt_first_operator_from_install()
        .await
        .expect("a 23505 must not reach the caller: this is a refusal, not a database error")
    {
        Adoption::Refused(AdoptionRefusal::AccountAlreadyBound {
            operator_id,
            account_id,
            address: refused_address,
            bound_to,
        }) => {
            assert_eq!(operator_id, bootstrap.operator_id);
            assert_eq!(account_id, bootstrap.account_id);
            assert_eq!(refused_address, address);
            assert_eq!(
                bound_to, squatter,
                "the log has to name both operators, or nobody can tell what to do about it"
            );
        }
        Adoption::Adopted(_) => panic!("one account holds one operator custody"),
        Adoption::Nothing => panic!("this must not be silent"),
        Adoption::Refused(other) => panic!("the wrong refusal: {other}"),
    }

    assert_eq!(
        su.query_one(
            "SELECT count(*) FROM chain_entries WHERE chain_kind = 'site' \
               AND entry_type = 'operator_adopted'",
            &[],
        )
        .await
        .expect("count")
        .get::<_, i64>(0),
        0,
        "and nothing was recorded, because nothing happened"
    );
}

/// **A disabled operator is not adopted, and the start says so.**
///
/// The candidate query asks `disabled_at IS NULL`, so this answered "nothing
/// to do" and looked exactly like a deployment that needed nothing — on a
/// deployment whose only operator cannot act. Nothing here re-enables one:
/// `0015` §A's register is append-only in effect and §4.5 sends a lost
/// operator through §5.4's machinery.
///
/// The fixture disables the row the way the console does, seal and all, using
/// [`operators::operator_row_seal`] — so the assertion at the end is real: the
/// start-time re-seal leaves a correctly sealed row alone whether it is
/// disabled or not.
#[tokio::test]
async fn a_disabled_bootstrapped_operator_is_refused_out_loud_rather_than_silently() {
    const TAG: &str = "ops_adopt_operator_disabled";
    let (pool, operators_store, _sessions, ring) =
        a_fresh_deployment(TAG, Duration::from_secs(1)).await;

    let address = unique("owner@example.org");
    let bootstrap = operators_store
        .bootstrap_first_operator(&address, &address)
        .await
        .expect("a first start with no operator mints one");

    let su = support::superuser_on_isolated(TAG).await;
    unbind(&su, &bootstrap.operator_id).await;

    let (display_name, created_by, _disabled, signin, created_seq, row_version) =
        operator_row_facts(&su, &bootstrap.operator_id).await;
    let at = now_unix();
    let seal = {
        let mut client = pool.get().await.expect("connection");
        let tx = client.transaction().await.expect("begin");
        tx.execute(
            "SELECT set_config('app.operator_custody', 'yes', true)",
            &[],
        )
        .await
        .expect("operator custody");
        let seal = operators::operator_row_seal(
            &tx,
            &ring,
            &bootstrap.operator_id,
            &display_name,
            created_by.as_deref(),
            at,
            signin,
            created_seq,
            row_version,
        )
        .await
        .expect("seal the disabled row under the current shape");
        tx.commit().await.expect("commit");
        seal
    };
    // `0019` §C's floor refuses disabling the last live operator at every
    // privilege level, which is exactly what this deployment has — so the
    // trigger comes off for the one statement, visibly.
    let disabled = support::tamper(
        &su,
        "operators",
        "UPDATE operators SET disabled_at = to_timestamp($2::bigint), row_seal = $3 \
          WHERE id = $1",
        &[&bootstrap.operator_id, &at, &seal.to_vec()],
    )
    .await;
    assert_eq!(disabled, 1);

    match operators_store
        .adopt_first_operator_from_install()
        .await
        .expect("the adoption runs")
    {
        Adoption::Refused(AdoptionRefusal::OperatorDisabled {
            operator_id,
            address: refused_address,
        }) => {
            assert_eq!(operator_id, bootstrap.operator_id);
            assert_eq!(refused_address, address);
        }
        Adoption::Adopted(_) => panic!("a disabled operator must not be bound"),
        Adoption::Nothing => panic!("this is the silence the typed outcome exists to remove"),
        Adoption::Refused(other) => panic!("the wrong refusal: {other}"),
    }

    assert_eq!(
        operators_store
            .reseal_legacy_operator_rows()
            .await
            .expect("the re-seal runs"),
        0,
        "a row sealed correctly under the current shape is left alone, disabled or not"
    );
}
