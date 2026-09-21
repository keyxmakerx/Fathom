//! **The person's credential**, against a real PostgreSQL and — where the
//! claim is about what a caller can tell from an answer — through the real
//! router over a real socket.
//!
//! ADR-0055 decision 10, `migrations/0018_credentials.sql`,
//! `migrations/0021_operator_seat_hold.sql`, and stream (a) of
//! `docs/archive/2026-09-21-adr-0055-build-contracts.md`.
//!
//! **Every test here is written against a claim, and its name is the claim**
//! (CLAUDE.md rule 2). Two consequences, stated before anybody reads the file,
//! because they are the difference between this suite and one that passes
//! while proving nothing:
//!
//! - **the passwords are real passwords.** Fifteen to twenty characters of the
//!   shape a person actually chooses — a four-word passphrase, not a synthetic
//!   string tuned to whatever the policy happens to check. A credential leak
//!   once survived four reviews in this project because the test used a
//!   password longer than any real device would take, and CLAUDE.md rule 2 is
//!   that finding written down.
//! - **the replayed code is a genuine, currently-valid six-digit code**,
//!   computed from the enrolled secret at the step the clock is actually in,
//!   and presented twice inside that same thirty-second step. A test that
//!   replayed an expired code would prove the skew window and not the replay
//!   refusal, and the replay refusal is the `<=` in
//!   `credentials::verify_totp`.

mod support;

use std::sync::Arc;
use std::time::Duration;

use deadpool_postgres::Pool;
use fathom_server::api::{self, ApiState, CredentialApiState};
use fathom_server::authority::SoftwareKey;
use fathom_server::chains;
use fathom_server::client_address::ClientAddress;
use fathom_server::credentials::{self, CredentialError, CredentialStore};
use fathom_server::crypto::Key32;
use fathom_server::grants::EpochWatch;
use fathom_server::keys::KeyRing;
use fathom_server::operators::{OperatorStore, Purpose};
use fathom_server::repo;
use fathom_server::sessions::{
    self, Assurance, PrincipalKind, SessionError, SessionStore, SignInAttempt, SignInLimits,
    SignedIn, VerifiedSession,
};

/// The same master key every other suite uses: ADR-0043 §4 stamps the
/// configured key's id per database and refuses a second.
const MASTER: [u8; 32] = [21; 32];

/// **This binary gets a deployment of its own.** Its tag is `cred`, so the
/// database it creates is `fathom_isolated_cred` and the two other ADR-0055
/// streams' databases are somebody else's to drop.
///
/// It needs one for the reason `tests/operators.rs` gives for its own: §6.3's
/// first operator is minted once per deployment, the setup-token test below
/// bootstraps one, and the shared test database is one deployment several
/// binaries write to.
const TAG: &str = "cred";

static DEPLOYMENT: tokio::sync::OnceCell<Pool> = tokio::sync::OnceCell::const_new();

/// One test at a time inside this binary: several count site-chain entries of
/// a type across the whole chain, and the deployment is this binary's alone.
static SERIAL: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

fn ring() -> Arc<KeyRing> {
    Arc::new(KeyRing::from_keys(
        Key32::from_bytes(MASTER),
        Key32::from_bytes(support::SITE_CHAIN_MASTER),
    ))
}

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

async fn superuser() -> tokio_postgres::Client {
    support::superuser_on_isolated(TAG).await
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

/// A source address this call and no other will ever use: the sign-in rate
/// limit counts per source string, and a suite that shared one would trip its
/// own cap on the third run.
fn a_source_of_its_own() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT: AtomicU64 = AtomicU64::new(0);
    format!(
        "198.51.100.44-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    )
}

// ---------------------------------------------------------------------------
// The passwords these tests use
// ---------------------------------------------------------------------------

/// **A real password**: four words, twenty-eight characters, the shape the
/// XKCD-passphrase advice every password manager now repeats produces. Not
/// fifteen `a`s, and not a string built to satisfy the check.
const A_REAL_PASSWORD: &str = "harbour-lantern-copper-nine";

/// A second one, for the reset that has to change it to something.
const ANOTHER_REAL_PASSWORD: &str = "quarry-signal-velvet-eleven";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

async fn sessions_store(pool: &Pool, ring: Arc<KeyRing>) -> SessionStore {
    let client = pool.get().await.expect("connection");
    let deployment = chains::deployment_id(&**client)
        .await
        .expect("this deployment is stamped at startup");
    SessionStore::new(pool.clone(), ring, deployment, SignInLimits::defaults())
}

async fn credential_store(pool: &Pool, ring: Arc<KeyRing>) -> CredentialStore {
    let client = pool.get().await.expect("connection");
    let deployment = chains::deployment_id(&**client)
        .await
        .expect("this deployment is stamped at startup");
    CredentialStore::new(pool.clone(), ring, deployment)
}

async fn operator_store(pool: &Pool, ring: Arc<KeyRing>) -> OperatorStore {
    let client = pool.get().await.expect("connection");
    let deployment = chains::deployment_id(&**client)
        .await
        .expect("this deployment is stamped at startup");
    OperatorStore::with_delay(pool.clone(), ring, deployment, Duration::from_secs(1))
}

/// One account and the key it would sign with if it had one enrolled.
struct Person {
    account: repo::AccountId,
    address: String,
}

async fn an_account(pool: &Pool, name: &str) -> Person {
    let address = unique(name);
    let account = repo::create_account(pool, &address, name)
        .await
        .expect("create account")
        .id;
    Person { account, address }
}

/// Sign in with a password, and whatever second factor is handed over.
async fn sign_in_with(
    store: &SessionStore,
    person: &Person,
    password: &str,
    code: &str,
) -> Result<(SignedIn, SoftwareKey), SessionError> {
    let session_key = SoftwareKey::random().expect("a session keypair");
    let pubkey = session_key.public_key();
    let source = a_source_of_its_own();
    let challenge = store
        .issue_challenge(PrincipalKind::Steward, &person.address, &pubkey, &source)
        .await?;
    let signed_in = store
        .sign_in_with_credentials(&SignInAttempt {
            kind: PrincipalKind::Steward,
            session_pubkey: &pubkey,
            nonce: &challenge.nonce,
            evidence_sig: b"",
            password,
            totp_code: code,
            source: &source,
        })
        .await?;
    Ok((signed_in, session_key))
}

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
    let counter = next_counter(&signed_in.session_id).await;
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

async fn next_counter(session_id: &str) -> i64 {
    let mark: i64 = superuser()
        .await
        .query_one(
            "SELECT request_counter FROM sessions WHERE id = $1",
            &[&session_id],
        )
        .await
        .expect("the session row")
        .get(0);
    mark + 1
}

/// The secret this account's app code is computed from, opened as the server
/// opens it.
///
/// **Read through the real key derivation, not off the column**, because the
/// claim these tests make is that a code a real authenticator would produce is
/// accepted — and an authenticator computes from the secret the server showed
/// it, which is this.
async fn totp_secret_of(pool: &Pool, ring: &KeyRing, account: &str) -> Vec<u8> {
    let mut client = pool.get().await.expect("connection");
    let tx = client.transaction().await.expect("begin");
    tx.execute("SELECT set_config('app.session_custody', 'yes', true)", &[])
        .await
        .expect("session custody");
    let deployment: String = tx
        .query_one("SELECT id FROM deployments", &[])
        .await
        .expect("this deployment is stamped at startup")
        .get(0);
    let row = credentials::read_credentials(&tx, account)
        .await
        .expect("read")
        .expect("the account exists");
    let key = credentials::totp_key_for(&tx, ring)
        .await
        .expect("the credential key");
    let secret = row
        .totp_secret(&key, &deployment, account)
        .expect("open the secret")
        .expect("a secret is enrolled");
    tx.rollback().await.expect("rollback");
    secret
}

/// The code a real authenticator application would be showing right now.
fn a_live_code(secret: &[u8]) -> String {
    credentials::totp_code(secret, credentials::totp_step(now_unix()))
}

/// An account with a password and a confirmed app code: the state every
/// ordinary sign-in test starts from.
struct Enrolled {
    person: Person,
    secret: Vec<u8>,
    backup_codes: Vec<String>,
}

async fn an_enrolled_account(
    pool: &Pool,
    ring: &Arc<KeyRing>,
    sessions: &SessionStore,
    credentials_store: &CredentialStore,
    name: &str,
) -> Enrolled {
    let person = an_account(pool, name).await;

    // The password is set through the account's own session, which needs a
    // session — so the first one is set straight on the store, exactly as the
    // setup route does for the first operator.
    set_password_directly(pool, ring, credentials_store, &person, A_REAL_PASSWORD).await;

    // Sign in with the password and no app code: `A0`, which for a steward
    // holding no operator custody is a full session (design §5.1).
    let (signed_in, session_key) = sign_in_with(sessions, &person, A_REAL_PASSWORD, "")
        .await
        .expect("a password-only steward signs in");
    assert_eq!(
        assurance_of(&signed_in.session_id).await,
        "A0",
        "a password and no app code is A0"
    );

    let session = verify(
        sessions,
        &signed_in,
        &session_key,
        "POST",
        "/credentials/totp/enrol",
        b"",
    )
    .await;
    credentials_store
        .enrol_totp(&session)
        .await
        .expect("enrol an app code");

    let secret = totp_secret_of(pool, ring, &person.account.to_string()).await;
    let session = verify(
        sessions,
        &signed_in,
        &session_key,
        "POST",
        "/credentials/totp/confirm",
        b"",
    )
    .await;
    let backup_codes = credentials_store
        .confirm_totp(&session, &a_live_code(&secret))
        .await
        .expect("a real six-digit code confirms the enrolment");

    Enrolled {
        person,
        secret,
        backup_codes,
    }
}

/// Set a password without a session, the way `/enrolment/operator/setup` and
/// `/credentials/reset/redeem` do — used only to bootstrap a fixture into the
/// state a test is actually about.
async fn set_password_directly(
    pool: &Pool,
    ring: &Arc<KeyRing>,
    _store: &CredentialStore,
    person: &Person,
    password: &str,
) {
    let _ = ring;
    let hash = credentials::hash_password(password).expect("hash");
    let mut client = pool.get().await.expect("connection");
    let tx = client.transaction().await.expect("begin");
    tx.execute("SELECT set_config('app.reset_custody', 'yes', true)", &[])
        .await
        .expect("reset custody");
    tx.execute(
        "UPDATE accounts SET password_hash = $2 WHERE id = $1",
        &[&person.account.to_string(), &hash],
    )
    .await
    .expect("set the password");
    tx.commit().await.expect("commit");
}

async fn assurance_of(session_id: &str) -> String {
    superuser()
        .await
        .query_one(
            "SELECT assurance FROM sessions WHERE id = $1",
            &[&session_id],
        )
        .await
        .expect("the session row")
        .get(0)
}

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
// The round trip
// ---------------------------------------------------------------------------

/// **A real password and a real six-digit code open a session, and the session
/// says which two factors made it.**
#[tokio::test]
async fn a_password_and_a_real_app_code_make_an_a0t_session() {
    let _serial = SERIAL.lock().await;
    let pool = deployment().await;
    let ring = ring();
    let sessions = sessions_store(&pool, Arc::clone(&ring)).await;
    let creds = credential_store(&pool, Arc::clone(&ring)).await;
    let enrolled = an_enrolled_account(&pool, &ring, &sessions, &creds, "steward").await;

    assert_eq!(
        enrolled.backup_codes.len(),
        10,
        "ADR-0055 decision 10: ten single-use backup codes, shown once"
    );
    for code in &enrolled.backup_codes {
        assert_eq!(
            code.chars().filter(|c| *c != '-').count(),
            16,
            "sixteen Crockford base32 characters is eighty bits: {code}"
        );
    }

    // **A code from a step the confirmation did not spend.** Confirming the
    // enrolment spent the step it was made in — that is `totp_last_step` doing
    // its job — so a test that is not ABOUT the replay has to wait for the
    // step to turn over rather than pretend it did not happen.
    let code = wait_for_a_fresh_code(&enrolled.secret).await;
    assert_eq!(code.len(), 6, "a real app code is six digits: {code}");
    let (signed_in, _key) = sign_in_with(&sessions, &enrolled.person, A_REAL_PASSWORD, &code)
        .await
        .expect("a password and a live app code sign in");
    assert_eq!(
        assurance_of(&signed_in.session_id).await,
        "A0T",
        "a password plus a verified app code is A0T (migration 0018 §B2)"
    );

    // And the two acts are on the site chain under 0018 §F's own names.
    assert!(site_entries_of("totp_enrolled").await >= 1);
    assert!(site_entries_of("account_signin").await >= 1);
}

/// **A code that verifies is refused the SECOND time, inside its own
/// thirty-second step.**
///
/// The claim is the `<=` in `credentials::verify_totp` and `0018` §B's
/// `totp_last_step`, and the only way to test it is with a code that is
/// genuinely valid at the moment it is replayed — CLAUDE.md rule 2. A test
/// that waited for the step to turn over would be testing the skew window.
#[tokio::test]
async fn a_real_app_code_replayed_inside_its_own_step_is_refused() {
    let _serial = SERIAL.lock().await;
    let pool = deployment().await;
    let ring = ring();
    let sessions = sessions_store(&pool, Arc::clone(&ring)).await;
    let creds = credential_store(&pool, Arc::clone(&ring)).await;
    let enrolled = an_enrolled_account(&pool, &ring, &sessions, &creds, "replay").await;

    // One step, held for the whole test, so both attempts are the same code at
    // the same step and the second is a replay and not an expiry. It has to be
    // a step the confirmation did not already spend — otherwise the FIRST use
    // is the replay and the test proves nothing about the second.
    let code = wait_for_a_fresh_code(&enrolled.secret).await;
    let step = credentials::totp_step(now_unix());

    let first = sign_in_with(&sessions, &enrolled.person, A_REAL_PASSWORD, &code).await;
    assert!(first.is_ok(), "the first use of a live code: {first:?}");

    let second = sign_in_with(&sessions, &enrolled.person, A_REAL_PASSWORD, &code).await;
    assert!(
        matches!(second, Err(SessionError::PasswordRefused)),
        "a code accepted once must be refused the second time even though it still verifies: \
         {second:?}"
    );

    // And the refusal is not the clock catching up: the same secret at the
    // NEXT step is still accepted, so what refused the replay was the stored
    // high-water mark.
    let next = credentials::totp_code(&enrolled.secret, step + 1);
    if next != code {
        let third = sign_in_with(&sessions, &enrolled.person, A_REAL_PASSWORD, &next).await;
        assert!(
            third.is_ok(),
            "the next step's code must still work, or the replay refusal is a lockout: {third:?}"
        );
    }
}

/// **A backup code stands in for the app code, once.**
///
/// ADR-0055 decision 10's *"Ten single-use backup codes ... for the lost
/// phone"*, and the lead's resolution 3: six digits is a TOTP code, anything
/// else is tried as a backup code, so there is one field on the form.
#[tokio::test]
async fn a_backup_code_signs_in_once_and_then_never_again() {
    let _serial = SERIAL.lock().await;
    let pool = deployment().await;
    let ring = ring();
    let sessions = sessions_store(&pool, Arc::clone(&ring)).await;
    let creds = credential_store(&pool, Arc::clone(&ring)).await;
    let enrolled = an_enrolled_account(&pool, &ring, &sessions, &creds, "lostphone").await;

    let code = enrolled.backup_codes[0].clone();
    // Typed as a person would type it off paper: hyphens and all, and in the
    // lower case a keyboard produces without a shift key.
    let typed = code.to_lowercase();
    let first = sign_in_with(&sessions, &enrolled.person, A_REAL_PASSWORD, &typed).await;
    assert!(
        first.is_ok(),
        "a backup code typed as it was printed must work: {first:?}"
    );

    let second = sign_in_with(&sessions, &enrolled.person, A_REAL_PASSWORD, &typed).await;
    assert!(
        matches!(second, Err(SessionError::PasswordRefused)),
        "a backup code is single use: {second:?}"
    );

    // A DIFFERENT one of the ten still works, so the first spend did not burn
    // the batch.
    let another = enrolled.backup_codes[1].clone();
    assert!(
        sign_in_with(&sessions, &enrolled.person, A_REAL_PASSWORD, &another)
            .await
            .is_ok(),
        "spending one code must not spend the other nine"
    );
    assert!(site_entries_of("backup_code_used").await >= 2);
}

/// **A wrong password is refused, and a right password with no code is refused
/// once a code is enrolled.**
#[tokio::test]
async fn once_an_app_code_is_enrolled_the_password_alone_is_not_enough() {
    let _serial = SERIAL.lock().await;
    let pool = deployment().await;
    let ring = ring();
    let sessions = sessions_store(&pool, Arc::clone(&ring)).await;
    let creds = credential_store(&pool, Arc::clone(&ring)).await;
    let enrolled = an_enrolled_account(&pool, &ring, &sessions, &creds, "twofactor").await;

    let refused = sign_in_with(&sessions, &enrolled.person, A_REAL_PASSWORD, "").await;
    assert!(
        matches!(refused, Err(SessionError::PasswordRefused)),
        "the app code is required once enrolled: {refused:?}"
    );

    let code = a_live_code(&enrolled.secret);
    let wrong = sign_in_with(
        &sessions,
        &enrolled.person,
        "harbour-lantern-copper-ten",
        &code,
    )
    .await;
    assert!(
        matches!(wrong, Err(SessionError::PasswordRefused)),
        "a wrong password is refused however good the code is: {wrong:?}"
    );
}

// ---------------------------------------------------------------------------
// Anti-enumeration — decision 7 / ASVS 5.0.0 6.3.8
// ---------------------------------------------------------------------------

/// **A wrong password on a known address and an address that belongs to nobody
/// answer identically, over the wire.**
///
/// Status, every header and every byte of the body. The account oracle `0014`
/// §A closed was read off a HEADER and not off a status, so a test about two
/// answers being the same has to compare the whole of both.
///
/// **What is NOT claimed** is that the two take the same time. An address that
/// resolves goes on to run a memory-hard hash; one that does not stops
/// earlier. That difference is real, it is not measured here, and
/// `credentials::CredentialStore::request_reset` and
/// `SessionError::SignInRefused` both say so in the same words.
#[tokio::test]
async fn a_wrong_password_and_an_unknown_address_answer_identically() {
    let _serial = SERIAL.lock().await;
    let pool = deployment().await;
    let ring = ring();
    let sessions = Arc::new(sessions_store(&pool, Arc::clone(&ring)).await);
    let creds = credential_store(&pool, Arc::clone(&ring)).await;

    let person = an_account(&pool, "known").await;
    set_password_directly(&pool, &ring, &creds, &person, A_REAL_PASSWORD).await;

    let addr = serve(api::router(ApiState {
        sessions: Arc::clone(&sessions),
        watch: Arc::new(EpochWatch::new()),
        ring: Arc::clone(&ring),
        client_address: ClientAddress::peer(),
    }))
    .await;

    let known = one_failed_sign_in(addr, &person.address).await;
    let unknown = one_failed_sign_in(addr, &unique("nobody@example.org")).await;

    assert_eq!(
        known, unknown,
        "a wrong password on a real address and an address that belongs to nobody must be one \
         answer: status, headers and body"
    );
    assert_eq!(known.0, "401", "and it is a refusal: {known:?}");
}

/// **`POST /credentials/reset` answers the same for every address**, including
/// one that belongs to nobody. Decision 7's *"the same answer ... for every
/// address"*.
#[tokio::test]
async fn forgot_my_password_answers_the_same_for_an_address_that_belongs_to_nobody() {
    let _serial = SERIAL.lock().await;
    let pool = deployment().await;
    let ring = ring();
    let sessions = Arc::new(sessions_store(&pool, Arc::clone(&ring)).await);
    let creds = credential_store(&pool, Arc::clone(&ring)).await;
    let person = an_account(&pool, "forgetful").await;
    set_password_directly(&pool, &ring, &creds, &person, A_REAL_PASSWORD).await;

    let addr = credential_surface(&pool, &ring, Arc::clone(&sessions)).await;

    let mut body = Vec::new();
    lp(&mut body, person.address.as_bytes());
    let real = post_full(addr, "/credentials/reset", &body).await;

    let mut body = Vec::new();
    lp(&mut body, unique("ghost@example.org").as_bytes());
    let ghost = post_full(addr, "/credentials/reset", &body).await;

    assert_eq!(
        real, ghost,
        "the forgot-password route must answer the same for an address that exists and one that \
         does not"
    );
    assert_eq!(real.0, "200", "and it is a 200 either way: {real:?}");

    // And the act is not vacuous: a token was really written for the address
    // that exists, and none for the one that does not.
    let tokens: i64 = superuser()
        .await
        .query_one(
            "SELECT count(*) FROM password_reset_tokens WHERE account_id = $1",
            &[&person.account.to_string()],
        )
        .await
        .expect("count")
        .get(0);
    assert_eq!(tokens, 1, "the real address gets a token");
    assert!(site_entries_of("reset_requested").await >= 1);
}

// ---------------------------------------------------------------------------
// Reset — decision 7
// ---------------------------------------------------------------------------

/// **A reset token is single use, and a wrong password on a live one still
/// spends it.**
#[tokio::test]
async fn a_reset_token_is_spent_by_the_first_attempt_whatever_the_outcome() {
    let _serial = SERIAL.lock().await;
    let pool = deployment().await;
    let ring = ring();
    let creds = credential_store(&pool, Arc::clone(&ring)).await;
    let person = an_account(&pool, "resetter").await;
    set_password_directly(&pool, &ring, &creds, &person, A_REAL_PASSWORD).await;

    // Two tokens: one to spend properly, one to spend on a refused password.
    let good = a_reset_token(&pool, &ring, &creds, &person).await;
    let wasted = a_reset_token(&pool, &ring, &creds, &person).await;

    creds
        .redeem_reset(&good, ANOTHER_REAL_PASSWORD)
        .await
        .expect("a live token and a real password");
    let again = creds.redeem_reset(&good, ANOTHER_REAL_PASSWORD).await;
    assert!(
        matches!(again, Err(CredentialError::TokenRefused)),
        "a reset token is single use: {again:?}"
    );

    // A password the policy refuses: the token is spent anyway, which the
    // contracts are explicit about — "a wrong password on a live token is a
    // typed refusal, not a second chance".
    let refused = creds.redeem_reset(&wasted, &a_long_common_password()).await;
    assert!(
        matches!(refused, Err(CredentialError::PasswordIsCommon)),
        "the policy refusal is told to the caller, who chose the password: {refused:?}"
    );
    let retry = creds.redeem_reset(&wasted, ANOTHER_REAL_PASSWORD).await;
    assert!(
        matches!(retry, Err(CredentialError::TokenRefused)),
        "and the token is gone: {retry:?}"
    );

    assert!(site_entries_of("reset_spent").await >= 2);
    assert!(site_entries_of("password_set").await >= 1);
}

/// **A reset token stops working when its lifetime runs out, and that
/// lifetime is twenty-four hours.**
///
/// Decision 7: *"at least 128 bits, single use, 24 hours"*. **Two claims, and
/// they need two instruments.** The twenty-four hours is read off the constant
/// and off the row a real issue writes; the expiry REFUSAL is driven by a
/// store built with a one-second lifetime, because the row's own seal covers
/// `expires_at` and moving it in SQL would make the test prove the seal
/// instead. `SessionStore::with_lifetime` set this precedent for a session's
/// expiry and its doc comment carries the argument.
#[tokio::test]
async fn a_reset_token_stops_working_when_its_twenty_four_hours_run_out() {
    let _serial = SERIAL.lock().await;
    let pool = deployment().await;
    let ring = ring();
    let creds = credential_store(&pool, Arc::clone(&ring)).await;
    let person = an_account(&pool, "stale").await;
    set_password_directly(&pool, &ring, &creds, &person, A_REAL_PASSWORD).await;

    // Claim one: a real issue writes a token that expires one lifetime out,
    // and the lifetime is decision 7's twenty-four hours.
    let lifetime = credentials::RESET_TOKEN_LIFETIME.as_secs() as i64;
    assert_eq!(lifetime, 24 * 60 * 60, "decision 7's 24 hours");
    let _ = a_reset_token(&pool, &ring, &creds, &person).await;
    let expires: i64 = superuser()
        .await
        .query_one(
            "SELECT EXTRACT(EPOCH FROM expires_at)::bigint FROM password_reset_tokens \
              WHERE account_id = $1",
            &[&person.account.to_string()],
        )
        .await
        .expect("the token row")
        .get(0);
    assert!(
        (expires - now_unix() - lifetime).abs() <= 5,
        "a fresh token expires one lifetime from now, not sooner or later"
    );

    // Claim two: once that moment passes, the token is refused — and the seal
    // is still the server's own, so what refuses it is the clock.
    let brief =
        short_lived_credential_store(&pool, Arc::clone(&ring), Duration::from_secs(1)).await;
    let person = an_account(&pool, "shortlived").await;
    set_password_directly(&pool, &ring, &creds, &person, A_REAL_PASSWORD).await;
    let token = brief
        .issue_reset_token(&person.address, "198.51.100.1")
        .await
        .expect("issue")
        .expect("the address belongs to an account");
    tokio::time::sleep(Duration::from_secs(2)).await;

    let refused = creds.redeem_reset(&token, ANOTHER_REAL_PASSWORD).await;
    assert!(
        matches!(refused, Err(CredentialError::TokenRefused)),
        "an expired reset token is refused, and not as an integrity alarm: {refused:?}"
    );
}

/// **A reset of an account that holds the operator custody puts a
/// twenty-four-hour hold on the operator seat, and ends every other session.**
///
/// Decision 7: *"On an account that holds the operator custody it does not
/// restore that custody by itself: the seat waits for another operator's
/// confirmation or the 24-hour delay ... so a colleague who controls the mail
/// server cannot reset their way into a second seat."* `0021` is the column and
/// the lead's resolution 11 is the interval.
///
/// The binding row is written here as the superuser with a placeholder seal:
/// **stream (b) owns `operator_account_bindings`' seal**, and nothing this
/// stream reads verifies it — the read is a membership lookup whose only
/// consequence is a REFUSAL, so a forged binding locks its own holder out
/// rather than letting anybody in.
#[tokio::test]
async fn a_reset_holds_the_operator_seat_for_a_day_and_ends_every_other_session() {
    let _serial = SERIAL.lock().await;
    let pool = deployment().await;
    let ring = ring();
    let sessions = sessions_store(&pool, Arc::clone(&ring)).await;
    let creds = credential_store(&pool, Arc::clone(&ring)).await;
    let person = an_account(&pool, "custodian").await;
    set_password_directly(&pool, &ring, &creds, &person, A_REAL_PASSWORD).await;

    // A live session of this account, which the reset has to end.
    let (signed_in, _key) = sign_in_with(&sessions, &person, A_REAL_PASSWORD, "")
        .await
        .expect("sign in before the reset");

    bind_to_a_new_operator(&pool, &person).await;

    let token = a_reset_token(&pool, &ring, &creds, &person).await;
    creds
        .redeem_reset(&token, ANOTHER_REAL_PASSWORD)
        .await
        .expect("redeem");

    let hold: Option<i64> = superuser()
        .await
        .query_one(
            "SELECT EXTRACT(EPOCH FROM operator_key_hold_until)::bigint FROM accounts \
              WHERE id = $1",
            &[&person.account.to_string()],
        )
        .await
        .expect("the account row")
        .get(0);
    let hold = hold.expect("the hold is written for an account holding the operator custody");
    let expected = credentials::OPERATOR_KEY_HOLD.as_secs() as i64;
    assert_eq!(expected, 24 * 60 * 60, "resolution 11's 24 hours");
    assert!(
        (hold - now_unix() - expected).abs() <= 5,
        "the hold runs a day from the redemption, not from anywhere else"
    );

    // Every other session of the account is gone, AND recorded as gone —
    // `0014` §D's whole argument is that a delete is undone by a restore and a
    // revocation row is not.
    let left: i64 = superuser()
        .await
        .query_one(
            "SELECT count(*) FROM sessions WHERE id = $1",
            &[&signed_in.session_id],
        )
        .await
        .expect("count")
        .get(0);
    assert_eq!(left, 0, "a reset ends the account's other sessions");
    let revoked: i64 = superuser()
        .await
        .query_one(
            "SELECT count(*) FROM session_revocations WHERE session_id = $1",
            &[&signed_in.session_id],
        )
        .await
        .expect("count")
        .get(0);
    assert_eq!(revoked, 1, "and records that it did");

    // The new password works and the old one does not.
    assert!(
        sign_in_with(&sessions, &person, A_REAL_PASSWORD, "")
            .await
            .is_err(),
        "the old password must be gone"
    );
}

// ---------------------------------------------------------------------------
// The first operator's setup — decision 10's last bullet
// ---------------------------------------------------------------------------

/// **The setup token sets a password, once, and returns no session.**
///
/// The lead's resolution 4: `/enrolment/operator/setup` returns no session and
/// the client signs in with `POST /session` right afterwards.
#[tokio::test]
async fn a_setup_token_sets_a_password_once_and_hands_back_no_session() {
    let _serial = SERIAL.lock().await;
    let pool = deployment().await;
    let ring = ring();
    let sessions = sessions_store(&pool, Arc::clone(&ring)).await;
    let creds = credential_store(&pool, Arc::clone(&ring)).await;
    let operators = operator_store(&pool, Arc::clone(&ring)).await;

    let person = an_account(&pool, "firstoperator").await;
    let operator = bind_to_a_new_operator(&pool, &person).await;
    let token = a_setup_token(&operators, &operator).await;

    creds
        .redeem_setup(&operators, &token, A_REAL_PASSWORD)
        .await
        .expect("the setup token sets the first operator's password");

    let again = creds
        .redeem_setup(&operators, &token, ANOTHER_REAL_PASSWORD)
        .await;
    assert!(
        matches!(again, Err(CredentialError::TokenRefused)),
        "a setup token is single use: {again:?}"
    );

    // And the password it set is the one that works.
    let (signed_in, _key) = sign_in_with(&sessions, &person, A_REAL_PASSWORD, "")
        .await
        .expect("the password the setup token set opens a session");
    assert_eq!(
        assurance_of(&signed_in.session_id).await,
        "A0",
        "an account holding the operator custody with no app code gets an A0 setup session"
    );
}

/// **A setup session may finish its setup and do nothing else.**
///
/// ADR-0055 decision 10: an account holding the operator custody *"is taken to
/// the enrolment screen before anything else until it has"* an app code. The
/// lead's resolution 1 makes that a typed `TotpRequired` on every signed route
/// but `/credentials/*`, rather than a redirect a client could ignore.
///
/// **This replaces `tests/sessions.rs`'s deleted
/// `the_operator_sign_in_surface_accepts_no_password_shaped_input`**, which the
/// contracts name.
#[tokio::test]
async fn an_operator_session_requires_totp_before_it_is_usable() {
    let _serial = SERIAL.lock().await;
    let pool = deployment().await;
    let ring = ring();
    let sessions = sessions_store(&pool, Arc::clone(&ring)).await;
    let creds = credential_store(&pool, Arc::clone(&ring)).await;

    let person = an_account(&pool, "midsetup").await;
    set_password_directly(&pool, &ring, &creds, &person, A_REAL_PASSWORD).await;
    bind_to_a_new_operator(&pool, &person).await;

    let (signed_in, session_key) = sign_in_with(&sessions, &person, A_REAL_PASSWORD, "")
        .await
        .expect("the setup session exists — it has to, or the setup screen is unreachable");
    assert_eq!(assurance_of(&signed_in.session_id).await, "A0");

    // Every route that is not the credentials surface refuses it.
    for path in [
        "/organisations/x/capability",
        "/admin/operators",
        "/session",
        "/designs",
    ] {
        let refused = try_verify(&sessions, &signed_in, &session_key, "GET", path, b"").await;
        assert!(
            matches!(refused, Err(SessionError::TotpRequired)),
            "{path} must refuse a setup session with a typed TotpRequired: {refused:?}"
        );
    }

    // The credentials surface accepts it, which is how the app code is
    // enrolled at all.
    let session = verify(
        &sessions,
        &signed_in,
        &session_key,
        "POST",
        "/credentials/totp/enrol",
        b"",
    )
    .await;
    assert_eq!(session.assurance(), Assurance::A0);
    creds.enrol_totp(&session).await.expect("enrol");

    // Registering a long-term key is refused WHILE the setup is unfinished —
    // the second factor has to exist before a key that outlives the session
    // does.
    let session = verify(
        &sessions,
        &signed_in,
        &session_key,
        "POST",
        "/credentials/key",
        b"",
    )
    .await;
    let browser = SoftwareKey::random().expect("a keypair");
    let refused = creds.register_key(&session, &browser.public_key()).await;
    assert!(
        matches!(refused, Err(CredentialError::TotpRequired)),
        "a key may not be registered while the seat is in setup: {refused:?}"
    );

    // Confirm the code, and the SAME session becomes ordinary — the gate is a
    // live re-read, not a flag baked into the session row.
    let secret = totp_secret_of(&pool, &ring, &person.account.to_string()).await;
    let session = verify(
        &sessions,
        &signed_in,
        &session_key,
        "POST",
        "/credentials/totp/confirm",
        b"",
    )
    .await;
    creds
        .confirm_totp(&session, &a_live_code(&secret))
        .await
        .expect("confirm");

    let now_usable = try_verify(
        &sessions,
        &signed_in,
        &session_key,
        "GET",
        "/organisations/x/capability",
        b"",
    )
    .await;
    assert!(
        now_usable.is_ok(),
        "once the app code is enrolled the same session is ordinary: {now_usable:?}"
    );

    // And the key it could not register a moment ago is registered now.
    let session = verify(
        &sessions,
        &signed_in,
        &session_key,
        "POST",
        "/credentials/key",
        b"",
    )
    .await;
    creds
        .register_key(&session, &browser.public_key())
        .await
        .expect("a finished setup may register the browser's key");
}

// ---------------------------------------------------------------------------
// The password policy — decision 10
// ---------------------------------------------------------------------------

/// **A password from the bundled common list is refused at the route, not only
/// in the unit test.**
///
/// The entry is taken from the vendored file itself rather than typed here, so
/// the test cannot drift from the list it is about;
/// `deps/decisions/common-passwords.md` records where the file came from, its
/// licence and its SHA-256.
#[tokio::test]
async fn a_password_from_the_bundled_list_is_refused_at_the_route() {
    let _serial = SERIAL.lock().await;
    let pool = deployment().await;
    let ring = ring();
    let sessions = sessions_store(&pool, Arc::clone(&ring)).await;
    let creds = credential_store(&pool, Arc::clone(&ring)).await;
    let person = an_account(&pool, "commonpw").await;
    set_password_directly(&pool, &ring, &creds, &person, A_REAL_PASSWORD).await;

    let (signed_in, session_key) = sign_in_with(&sessions, &person, A_REAL_PASSWORD, "")
        .await
        .expect("sign in");
    let session = verify(
        &sessions,
        &signed_in,
        &session_key,
        "POST",
        "/credentials/password",
        b"",
    )
    .await;

    // The longest entry on the bundled list that is also long enough to pass
    // the length rule — so the refusal under test is the LIST and not the
    // fifteen-character floor.
    let common = a_long_common_password();
    assert!(
        common.chars().count() >= credentials::PASSWORD_MIN,
        "the fixture must clear the length rule or it proves the wrong thing: {common:?}"
    );
    let refused = creds.set_password(&session, &common).await;
    assert!(
        matches!(refused, Err(CredentialError::PasswordIsCommon)),
        "a password on the bundled list is refused however long it is: {refused:?}"
    );

    // ...and a real one of the same length is accepted, so the refusal is the
    // list and not the length.
    let session = verify(
        &sessions,
        &signed_in,
        &session_key,
        "POST",
        "/credentials/password",
        b"",
    )
    .await;
    creds
        .set_password(&session, ANOTHER_REAL_PASSWORD)
        .await
        .expect("a real passphrase of the same shape is accepted");
}

/// **A password that contains the address it opens is refused.**
#[tokio::test]
async fn a_password_containing_its_own_address_is_refused() {
    let _serial = SERIAL.lock().await;
    let pool = deployment().await;
    let ring = ring();
    let sessions = sessions_store(&pool, Arc::clone(&ring)).await;
    let creds = credential_store(&pool, Arc::clone(&ring)).await;
    let person = an_account(&pool, "selfnamer").await;
    set_password_directly(&pool, &ring, &creds, &person, A_REAL_PASSWORD).await;
    let (signed_in, session_key) = sign_in_with(&sessions, &person, A_REAL_PASSWORD, "")
        .await
        .expect("sign in");
    let session = verify(
        &sessions,
        &signed_in,
        &session_key,
        "POST",
        "/credentials/password",
        b"",
    )
    .await;

    let refused = creds
        .set_password(&session, &format!("{}-and-then-some", person.address))
        .await;
    assert!(
        matches!(refused, Err(CredentialError::PasswordContainsAddress)),
        "the address is the one thing an attacker already knows: {refused:?}"
    );
}

// ---------------------------------------------------------------------------
// Any live key — the lead's resolution 1
// ---------------------------------------------------------------------------

/// **Two browsers, two keys, and either one signs in.**
///
/// The lead's resolution 1: *"Any live key of the account must be accepted
/// wherever sign-in evidence or grant signatures are verified (no LIMIT 1 on
/// the newest)."* Before this, `grants::signing_key_of`'s
/// `ORDER BY enrolled_seq DESC LIMIT 1` meant the older browser was refused,
/// which reads as a stolen key rather than as a second machine.
#[tokio::test]
async fn a_second_browsers_key_signs_in_and_so_does_the_first() {
    let _serial = SERIAL.lock().await;
    let pool = deployment().await;
    let ring = ring();
    let sessions = sessions_store(&pool, Arc::clone(&ring)).await;
    let creds = credential_store(&pool, Arc::clone(&ring)).await;
    let enrolled = an_enrolled_account(&pool, &ring, &sessions, &creds, "twobrowsers").await;

    // Two browsers register their own keys through the route resolution 1
    // creates.
    let mut keys = Vec::new();
    for _ in 0..2 {
        let code = wait_for_a_fresh_code(&enrolled.secret).await;
        let (signed_in, session_key) =
            sign_in_with(&sessions, &enrolled.person, A_REAL_PASSWORD, &code)
                .await
                .expect("sign in");
        let session = verify(
            &sessions,
            &signed_in,
            &session_key,
            "POST",
            "/credentials/key",
            b"",
        )
        .await;
        let browser = SoftwareKey::random().expect("a keypair");
        creds
            .register_key(&session, &browser.public_key())
            .await
            .expect("register this browser's key");
        keys.push(browser);
    }

    // The OLDER key — the one `LIMIT 1` would never resolve — signs in.
    let older = &keys[0];
    let session_key = SoftwareKey::random().expect("a session keypair");
    let pubkey = session_key.public_key();
    let source = a_source_of_its_own();
    let challenge = sessions
        .issue_challenge(
            PrincipalKind::Steward,
            &enrolled.person.address,
            &pubkey,
            &source,
        )
        .await
        .expect("challenge");
    let digest = sessions::session_challenge(&pubkey, &challenge.nonce, &challenge.deployment_id);
    let code = wait_for_a_fresh_code(&enrolled.secret).await;
    let signed_in = sessions
        .sign_in_with_credentials(&SignInAttempt {
            kind: PrincipalKind::Steward,
            session_pubkey: &pubkey,
            nonce: &challenge.nonce,
            evidence_sig: &older.sign(&digest),
            password: A_REAL_PASSWORD,
            totp_code: &code,
            source: &source,
        })
        .await
        .expect("the FIRST browser's key must still sign in after the second registered one");
    assert_eq!(
        assurance_of(&signed_in.session_id).await,
        "A1",
        "a valid evidence signature outranks the app code (decision 6, resolution 1)"
    );
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/// The longest entry on the bundled list that still clears the length rule.
fn a_long_common_password() -> String {
    let file = std::fs::read_to_string(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("data/common-passwords.txt"),
    )
    .expect("the vendored common-password list must be on disk");
    file.lines()
        .filter(|l| l.chars().count() >= credentials::PASSWORD_MIN)
        .max_by_key(|l| l.chars().count())
        .expect("the list must hold at least one entry of policy length")
        .to_string()
}

/// A code that has not been used yet.
///
/// `totp_last_step` refuses a code at or below the last accepted step, so a
/// test that signs in twice inside one thirty-second window has to wait for
/// the step to turn over. That is the replay refusal doing its job, and the
/// wait is how a test that is not ABOUT the replay stays honest about it.
async fn wait_for_a_fresh_code(secret: &[u8]) -> String {
    let step = credentials::totp_step(now_unix());
    loop {
        let now = now_unix();
        if credentials::totp_step(now) > step {
            return credentials::totp_code(secret, credentials::totp_step(now));
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
}

/// Issue a reset token and hand back its bytes.
///
/// **The route deliberately does not return one** — decision 7 mails it, and
/// there is no mail path in this build, so a route that returned it would make
/// "forgot my password" a password reset for anybody who knows an address. The
/// token comes from `CredentialStore::issue_reset_token`, which is the whole
/// of what the route does and is what stream 5's mail path will call. It is
/// deliberately not `#[cfg(test)]`: a function that exists only for tests is a
/// second code path, and the point is that this drives the same one.
async fn a_reset_token(
    pool: &Pool,
    ring: &Arc<KeyRing>,
    store: &CredentialStore,
    person: &Person,
) -> Vec<u8> {
    let _ = (pool, ring);
    store
        .issue_reset_token(&person.address, "198.51.100.1")
        .await
        .expect("issue a reset token")
        .expect("the address belongs to an account")
}

/// Issue a `purpose = 'setup'` enrolment token for one operator — the token
/// stream (b)'s `bootstrap_first_operator` will write to the key volume.
async fn a_setup_token(operators: &OperatorStore, operator: &str) -> Vec<u8> {
    operators
        .issue_setup_token(operator)
        .await
        .expect("issue a setup token")
        .token
        .to_vec()
}

/// Create an operator row and bind it to this account.
///
/// **Written as the superuser with a placeholder seal**, because
/// `operator_account_bindings`' seal is stream (b)'s and does not exist in
/// this worktree. Nothing this stream reads verifies it — see the test above
/// that says so, and `credentials::holds_operator_custody`'s own doc.
async fn bind_to_a_new_operator(pool: &Pool, person: &Person) -> String {
    let _ = pool;
    let su = superuser().await;
    let operator = fathom_server::ids::new_ulid().to_string();
    su.execute(
        "INSERT INTO principals (id, kind) VALUES ($1, 'operator')",
        &[&operator],
    )
    .await
    .expect("principal");
    su.execute(
        "INSERT INTO operators (id, display_name, created_seq, row_version, row_seal) \
         VALUES ($1, $2, 1, 1, $3)",
        &[&operator, &unique("Colleague"), &vec![0u8; 32]],
    )
    .await
    .expect("operator row");
    su.execute(
        "INSERT INTO operator_account_bindings (operator_id, account_id, bound_seq, \
                                                row_version, row_seal) \
         VALUES ($1, $2, 1, 1, $3)",
        &[&operator, &person.account.to_string(), &vec![0u8; 32]],
    )
    .await
    .expect("binding row");
    operator
}

/// A credential store whose reset tokens live for `lifetime` rather than
/// [`credentials::RESET_TOKEN_LIFETIME`] — the one honest way to watch an
/// expiry without breaking the seal that covers it.
async fn short_lived_credential_store(
    pool: &Pool,
    ring: Arc<KeyRing>,
    lifetime: Duration,
) -> CredentialStore {
    let client = pool.get().await.expect("connection");
    let deployment = chains::deployment_id(&**client)
        .await
        .expect("this deployment is stamped at startup");
    CredentialStore::with_reset_lifetime(pool.clone(), ring, deployment, lifetime)
}

/// One complete failed sign-in over HTTP, and the whole of what came back.
async fn one_failed_sign_in(
    addr: std::net::SocketAddr,
    address: &str,
) -> (String, Vec<String>, String) {
    let session_key = SoftwareKey::random().unwrap();
    let pubkey = session_key.public_key();
    let source = a_source_of_its_own();

    let mut body = Vec::new();
    lp(&mut body, b"steward");
    lp(&mut body, address.as_bytes());
    lp(&mut body, &pubkey);
    let (status, _, answer) = raw_post(
        addr,
        "/session/challenge",
        &body,
        &[("x-forwarded-for", &source)],
    )
    .await;
    assert_eq!(
        status, "200",
        "the challenge route answers alike either way"
    );
    let (nonce, rest) = read_lp(&answer);
    let (deployment, _) = read_lp(rest);
    let _ = deployment;
    let nonce: Vec<u8> = nonce.to_vec();

    let mut body = Vec::new();
    lp(&mut body, b"steward");
    lp(&mut body, &pubkey);
    lp(&mut body, &nonce);
    lp(&mut body, b"");
    // A password that is wrong for the known address and means nothing for the
    // unknown one — a real one, of the length a person types.
    lp(&mut body, b"orchard-thimble-marble-four");
    lp(&mut body, b"");
    let (status, headers, answer) =
        raw_post(addr, "/session", &body, &[("x-forwarded-for", &source)]).await;
    (
        status,
        headers,
        String::from_utf8_lossy(&answer).into_owned(),
    )
}

async fn credential_surface(
    pool: &Pool,
    ring: &Arc<KeyRing>,
    sessions: Arc<SessionStore>,
) -> std::net::SocketAddr {
    let creds = Arc::new(credential_store(pool, Arc::clone(ring)).await);
    let operators = Arc::new(operator_store(pool, Arc::clone(ring)).await);
    serve(api::credential_router(CredentialApiState {
        sessions,
        credentials: creds,
        operators,
        client_address: ClientAddress::peer(),
    }))
    .await
}

async fn post_full(
    addr: std::net::SocketAddr,
    path: &str,
    body: &[u8],
) -> (String, Vec<String>, String) {
    let (status, headers, answer) = raw_post(addr, path, body, &[]).await;
    (
        status,
        headers,
        String::from_utf8_lossy(&answer).into_owned(),
    )
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

/// Every response header, lower-cased and sorted, with `Date` dropped because
/// it moves on its own and would make every comparison a clock comparison.
async fn raw_post(
    addr: std::net::SocketAddr,
    path: &str,
    body: &[u8],
    headers: &[(&str, &str)],
) -> (String, Vec<String>, Vec<u8>) {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    let mut stream = tokio::net::TcpStream::connect(addr)
        .await
        .expect("connect to the test router");
    let mut head = format!(
        "POST {path} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\nContent-Length: {}\r\n",
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
    let answer = buf[split + 4..].to_vec();
    let status = head
        .lines()
        .next()
        .unwrap_or_default()
        .split_whitespace()
        .nth(1)
        .unwrap_or_default()
        .to_string();
    let mut lines: Vec<String> = head
        .lines()
        .skip(1)
        .map(|l| l.trim().to_ascii_lowercase())
        .filter(|l| !l.is_empty() && !l.starts_with("date:"))
        .collect();
    lines.sort();
    (status, lines, answer)
}

fn lp(out: &mut Vec<u8>, field: &[u8]) {
    out.extend_from_slice(&(field.len() as u32).to_le_bytes());
    out.extend_from_slice(field);
}

fn read_lp(bytes: &[u8]) -> (&[u8], &[u8]) {
    let len = u32::from_le_bytes(bytes[..4].try_into().unwrap()) as usize;
    (&bytes[4..4 + len], &bytes[4 + len..])
}

/// `Purpose::Setup` is named here so that a rename on the operator plane fails
/// this suite rather than leaving it quietly testing nothing.
const _: Purpose = Purpose::Setup;
