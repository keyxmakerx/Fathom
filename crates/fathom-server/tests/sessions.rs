//! Sessions and the per-request proof, against a real PostgreSQL and through
//! the real router.
//!
//! `docs/PHASE-2-ADMIN-AND-AUDIT-DESIGN.md` §4, §13 items 1-4 and 7, §15.6
//! item 4.
//!
//! **Every test here is written against a claim, and its name is the claim**
//! (CLAUDE.md rule 2). So:
//!
//! - the replayed request is a **genuine, correctly signed** request presented
//!   a second time, not a corrupted one, because the claim is that a valid
//!   signature does not survive its nonce being spent;
//! - the forged session row is minted **as the bootstrap superuser**, because
//!   the claim is that a row this server did not write fails at its first use
//!   at every privilege level — a test that inserted through the application
//!   would have proved something weaker while looking identical;
//! - the demonstration route is driven **over a real socket through the real
//!   router**, because the claim is about the chain from an HTTP request to
//!   `grants::authorise_account`, and a test that called the handler function
//!   would have skipped the extractor that does the work.

mod support;

use std::sync::Arc;
use std::time::Duration;

use deadpool_postgres::Pool;
use fathom_server::api::{
    self, ApiState, CredentialApiState, HEADER_COUNTER, HEADER_NONCE, HEADER_SESSION,
    HEADER_SIGNATURE, HEADER_TIMESTAMP, HEADER_TOKEN,
};
use fathom_server::authority::{self, Capability, GrantFacts, SoftwareKey};
use fathom_server::chains;
use fathom_server::client_address::ClientAddress;
use fathom_server::credentials::{self, CredentialStore};
use fathom_server::crypto::Key32;
use fathom_server::grants::{self, Authority, EpochWatch, GenesisGrant, GrantRequest};
use fathom_server::keys::{self, KeyRing};
use fathom_server::operators::OperatorStore;
use fathom_server::repo::{self, AccountId, OrganisationId};
use fathom_server::sessions::{
    self, PrincipalKind, SessionError, SessionStore, SignInAttempt, SignInLimits, SignedIn,
    SignedRequest, VerifiedSession,
};

/// The one master key this test database is encrypted under — the same value
/// every other suite uses, because ADR-0043 §4 stamps the configured key's id
/// per database and refuses a second.
const MASTER: [u8; 32] = [21; 32];

/// **The site chain master, not a per-suite one.** A session's row MAC is
/// taken under the SITE-scoped row key and sign-in appends to the SITE chain,
/// and there is exactly one site chain per database (`0009`'s one-row
/// `deployments` table). A suite that used its own chain master would leave
/// site entries no other suite can verify, and the symptom is `BROKEN AT ENTRY
/// 1` — which reads as a forgery alarm rather than as a fixture problem. Every
/// test here also takes `support::lock_the_site_chain`.
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

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/// One account, its address, and the software key it signs with.
struct Person {
    account: AccountId,
    address: String,
    key: SoftwareKey,
}

/// One bootstrapped organisation with one genesis steward.
struct Estate {
    organisation: OrganisationId,
    steward: Person,
}

async fn an_account(pool: &Pool, name: &str) -> Person {
    let address = unique(name);
    let account = repo::create_account(pool, &address, name)
        .await
        .expect("create account")
        .id;
    Person {
        account,
        address,
        key: SoftwareKey::random().expect("a keypair"),
    }
}

/// §6.1's genesis, driven as a browser would: derive the id from the root
/// public key and a salt, sign the genesis grant with the root private key,
/// hand the server the public half and the signature.
async fn bootstrap(pool: &Pool, ring: &KeyRing) -> Estate {
    let root = SoftwareKey::random().expect("a root keypair");
    let salt = [0x5au8; 16];
    let organisation_id = authority::derive_organisation_id(&root.public_key(), &salt);
    let root_fpr = authority::key_fingerprint(&root.public_key());

    let steward = an_account(pool, "steward").await;
    let now = now_unix();
    let subject_key_fpr = authority::key_fingerprint(&steward.key.public_key());
    let facts = GrantFacts {
        organisation: &organisation_id,
        root_pubkey_fpr: &root_fpr,
        scope: "",
        subject: &steward.account.to_string(),
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
        subject: steward.account,
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
        steward.account,
        &unique("Org"),
        &root.public_key(),
        &salt,
        &[request],
    )
    .await
    .expect("genesis");
    tx.commit().await.expect("commit");

    enrol(pool, ring, genesis.organisation, &steward).await;

    Estate {
        organisation: genesis.organisation,
        steward,
    }
}

async fn enrol(pool: &Pool, ring: &KeyRing, organisation: OrganisationId, person: &Person) {
    let mut client = pool.get().await.expect("connection");
    let tx = client.transaction().await.expect("begin");
    let ctx = repo::open_tenant_context(&tx, organisation, person.account)
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
    grants::enrol_software_key(&tx, &auth, &person.key.public_key())
        .await
        .expect("enrol");
    tx.commit().await.expect("commit");
}

/// A member of the organisation with a key enrolled and, optionally, a grant
/// at the organisation scope signed by the genesis steward.
async fn a_member_with(
    pool: &Pool,
    ring: &KeyRing,
    estate: &Estate,
    name: &str,
    capability: Option<Capability>,
) -> Person {
    let person = an_account(pool, name).await;
    repo::add_member(
        pool,
        estate.organisation,
        estate.steward.account,
        person.account,
        repo::Role::Member,
    )
    .await
    .expect("membership");
    enrol(pool, ring, estate.organisation, &person).await;

    if let Some(capability) = capability {
        let mut client = pool.get().await.expect("connection");
        let tx = client.transaction().await.expect("begin");
        let ctx = repo::open_tenant_context(&tx, estate.organisation, estate.steward.account)
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
        let proposal = grants::propose_grant(
            &tx,
            &auth,
            &GrantRequest {
                scope: None,
                subject: person.account,
                capability,
                expires_at_unix: now_unix() + 30 * 24 * 3600,
            },
        )
        .await
        .expect("proposed");
        let signature = estate.steward.key.sign(&proposal.bytes);
        grants::sign_grant(&tx, &auth, &proposal, &signature)
            .await
            .expect("signed");
        tx.commit().await.expect("commit");
    }
    person
}

async fn store(pool: &Pool, ring: Arc<KeyRing>) -> SessionStore {
    let client = pool.get().await.expect("connection");
    let deployment = chains::deployment_id(&**client)
        .await
        .expect("this deployment is stamped at startup");
    SessionStore::new(pool.clone(), ring, deployment, SignInLimits::defaults())
}

/// A source address **this call and no other test will ever use**.
///
/// The source bucket is a rate limit, not a lockout: forty-five attempts per
/// fifteen minutes (`SignInLimits::defaults`, raised from thirty on 2026-09-22
/// when the second-factor probe started costing one), counted per source
/// string, in a row of `sign_in_attempts`
/// in the shared test database. Every sign-in below used to hand it the same
/// literal address, so the whole binary shared one bucket and the window
/// carried over between runs — and on 2026-09-13 a third `cargo test` inside
/// fifteen minutes tripped it, failing five tests that have nothing to do with
/// rate limiting, with `RateLimited { retry_after_seconds: 487 }`.
///
/// Unique per call, and per process, so a re-run starts clean. The cap itself
/// had no test at all until this change; it has one now, and that test holds a
/// single source across its own attempts on purpose.
fn a_source_of_its_own() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT: AtomicU64 = AtomicU64::new(0);
    format!(
        "198.51.100.7-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    )
}

/// Sign in the way a browser would: a fresh non-extractable keypair, a
/// challenge derived from its public half, and the account's enrolled key
/// signing that challenge.
async fn sign_in(store: &SessionStore, person: &Person) -> (SignedIn, SoftwareKey) {
    let session_key = SoftwareKey::random().expect("a session keypair");
    let signed_in = sign_in_with(store, person, &session_key)
        .await
        .expect("sign-in succeeds for an account with an enrolled key");
    (signed_in, session_key)
}

async fn sign_in_with(
    store: &SessionStore,
    person: &Person,
    session_key: &SoftwareKey,
) -> Result<SignedIn, SessionError> {
    sign_in_from(store, person, session_key, &a_source_of_its_own()).await
}

/// As [`sign_in_with`], from a named source — because since `0014` the
/// challenge route counts against the source bucket too, and a test about that
/// bucket has to drive both halves through one address.
async fn sign_in_from(
    store: &SessionStore,
    person: &Person,
    session_key: &SoftwareKey,
    source: &str,
) -> Result<SignedIn, SessionError> {
    let pubkey = session_key.public_key();
    let challenge = store
        .issue_challenge(PrincipalKind::Steward, &person.address, &pubkey, source)
        .await?;
    let digest = sessions::session_challenge(&pubkey, &challenge.nonce, &challenge.deployment_id);
    let evidence = person.key.sign(&digest);
    store
        .sign_in(
            PrincipalKind::Steward,
            &pubkey,
            &challenge.nonce,
            &evidence,
            source,
        )
        .await
}

/// The counter a browser would send next: one past the mark the server
/// recorded when it issued the nonce.
///
/// **Read from the row rather than made up.** `0014` bounds the accepted
/// counter to `issued_counter + `[`sessions::COUNTER_WINDOW`], because storing
/// a client-chosen `i64::MAX` through `GREATEST` bricked the session for the
/// rest of its life. These tests used to send `now_unix()`, which is a clock
/// and not a tally; a real client keeps its own count and this is the cheapest
/// honest stand-in for one.
async fn next_counter(session_id: &str) -> i64 {
    let mark: i64 = support::superuser_client_on_test_database()
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

/// Everything a signed request needs, so that a test can vary exactly one
/// field of it and nothing else.
struct Call {
    session_id: String,
    nonce: [u8; 32],
    unix_ms: i64,
    counter: i64,
    signature: [u8; 64],
}

async fn a_call(
    store: &SessionStore,
    signed_in: &SignedIn,
    session_key: &SoftwareKey,
    method: &str,
    path: &str,
    body: &[u8],
) -> Call {
    let nonce = store
        .issue_request_nonce(&signed_in.session_id, &signed_in.token)
        .await
        .expect("a live session may ask for a nonce");
    let unix_ms = now_ms();
    let counter = next_counter(&signed_in.session_id).await;
    let message = sessions::request_bytes(
        &signed_in.session_id,
        method,
        path,
        &sessions::body_digest(body),
        &nonce,
        unix_ms,
        counter,
    );
    Call {
        session_id: signed_in.session_id.clone(),
        nonce,
        unix_ms,
        counter,
        signature: session_key.sign(&message),
    }
}

fn as_request<'a>(
    call: &'a Call,
    method: &'a str,
    path: &'a str,
    body: &'a [u8],
) -> SignedRequest<'a> {
    SignedRequest {
        session_id: &call.session_id,
        method,
        path,
        body,
        nonce: call.nonce,
        unix_ms: call.unix_ms,
        counter: call.counter,
        signature: call.signature,
    }
}

// ---------------------------------------------------------------------------
// §4.1 and §4.2 — the proof itself
// ---------------------------------------------------------------------------

#[tokio::test]
async fn a_signed_request_verifies_and_names_the_account_from_the_session_and_not_the_caller() {
    let _site = support::lock_the_site_chain().await;
    let pool = support::migrated_pool().await;
    let ring = ring();
    let estate = bootstrap(&pool, &ring).await;
    let store = store(&pool, Arc::clone(&ring)).await;

    let (signed_in, session_key) = sign_in(&store, &estate.steward).await;
    let call = a_call(&store, &signed_in, &session_key, "GET", "/x", b"").await;
    let verified = store
        .verify_request(&as_request(&call, "GET", "/x", b""))
        .await
        .expect("a fresh, correctly signed request verifies");

    assert_eq!(verified.principal_id(), estate.steward.account.to_string());
    // ADR-0053 §3: the sign-in answer carries the account id so the client
    // can stamp every change it makes with the real actor.
    assert_eq!(signed_in.account_id, estate.steward.account.to_string());
    assert_eq!(verified.kind(), PrincipalKind::Steward);
    assert_eq!(
        verified.assurance(),
        sessions::Assurance::A1,
        "a session established by signing a challenge with an enrolled key is A1: the server \
         can re-issue neither the key nor the signature"
    );

    // §0: stopping the log stops the act. The sign-in is on the site chain,
    // and the session row's MAC covers that entry's seq, so there is no
    // session without its sealed entry.
    // Through the SUPERUSER, because `sessions` is behind a policy only the
    // session-custody transaction satisfies -- which is itself worth
    // asserting, and is the next test.
    let client = support::superuser_client_on_test_database().await;
    let seq: i64 = client
        .query_one(
            "SELECT chain_seq FROM sessions WHERE id = $1",
            &[&signed_in.session_id],
        )
        .await
        .expect("the session row")
        .get(0);
    let kind: String = client
        .query_one(
            "SELECT entry_type FROM chain_entries WHERE chain_kind = 'site' AND seq = $1",
            &[&seq],
        )
        .await
        .expect("the entry the row names")
        .get(0);
    assert_eq!(kind, "account_signin");
}

#[tokio::test]
async fn a_request_with_a_valid_signature_but_a_reused_nonce_is_refused() {
    let _site = support::lock_the_site_chain().await;
    let pool = support::migrated_pool().await;
    let ring = ring();
    let estate = bootstrap(&pool, &ring).await;
    let store = store(&pool, Arc::clone(&ring)).await;
    let (signed_in, session_key) = sign_in(&store, &estate.steward).await;

    // ONE call, presented twice. The signature is genuine both times and the
    // bytes are identical both times -- which is exactly what a network
    // observer replaying a captured request has.
    let call = a_call(&store, &signed_in, &session_key, "GET", "/x", b"").await;
    store
        .verify_request(&as_request(&call, "GET", "/x", b""))
        .await
        .expect("the first presentation verifies");

    let again = store
        .verify_request(&as_request(&call, "GET", "/x", b""))
        .await;
    assert!(
        matches!(again, Err(SessionError::NonceNotFresh)),
        "a replayed request must be refused for want of a fresh nonce, got {again:?}"
    );
}

#[tokio::test]
async fn a_signature_over_a_different_path_or_body_is_refused() {
    let _site = support::lock_the_site_chain().await;
    let pool = support::migrated_pool().await;
    let ring = ring();
    let estate = bootstrap(&pool, &ring).await;
    let store = store(&pool, Arc::clone(&ring)).await;
    let (signed_in, session_key) = sign_in(&store, &estate.steward).await;

    // Signed for one path, presented for another.
    let call = a_call(&store, &signed_in, &session_key, "GET", "/designs/a", b"").await;
    let moved = store
        .verify_request(&as_request(&call, "GET", "/designs/b", b""))
        .await;
    assert!(
        matches!(moved, Err(SessionError::Signature(_))),
        "a signature over one path must not authorise another, got {moved:?}"
    );

    // Signed for one body, presented with another.
    let call = a_call(&store, &signed_in, &session_key, "POST", "/x", b"one").await;
    let swapped = store
        .verify_request(&as_request(&call, "POST", "/x", b"two"))
        .await;
    assert!(
        matches!(swapped, Err(SessionError::Signature(_))),
        "a signature over one body must not authorise another, got {swapped:?}"
    );

    // And the method, for the same reason a path is covered: a signed read is
    // not a signed delete.
    let call = a_call(&store, &signed_in, &session_key, "GET", "/x", b"").await;
    let promoted = store
        .verify_request(&as_request(&call, "DELETE", "/x", b""))
        .await;
    assert!(
        matches!(promoted, Err(SessionError::Signature(_))),
        "a signature over one method must not authorise another, got {promoted:?}"
    );
}

#[tokio::test]
async fn a_request_signed_by_another_browsers_key_is_refused() {
    let _site = support::lock_the_site_chain().await;
    let pool = support::migrated_pool().await;
    let ring = ring();
    let estate = bootstrap(&pool, &ring).await;
    let store = store(&pool, Arc::clone(&ring)).await;
    let (signed_in, _session_key) = sign_in(&store, &estate.steward).await;

    // §4.1's copying attack, in its cheapest form: the attacker has the
    // session id and its bearer token — everything the row holds — and their
    // own keypair. The private half the row's public key names is the one
    // thing they do not have.
    let attacker = SoftwareKey::random().unwrap();
    let call = a_call(&store, &signed_in, &attacker, "GET", "/x", b"").await;
    let refused = store
        .verify_request(&as_request(&call, "GET", "/x", b""))
        .await;
    assert!(
        matches!(refused, Err(SessionError::Signature(_))),
        "cloning a session into another browser must fail: the browser-held key is the proof, \
         got {refused:?}"
    );
}

#[tokio::test]
async fn a_session_row_minted_from_sql_by_a_superuser_fails_its_mac_at_first_use() {
    let _site = support::lock_the_site_chain().await;
    let pool = support::migrated_pool().await;
    let ring = ring();
    let estate = bootstrap(&pool, &ring).await;
    let store = store(&pool, Arc::clone(&ring)).await;

    // The tier-2 and tier-3 move: write the row directly, with a public key
    // whose private half the attacker holds, naming the victim's account.
    // PostgreSQL exempts a superuser from row security, so no policy is in
    // the way -- which is the point. `K_row_site` is not in the database.
    let superuser = support::superuser_client_on_test_database().await;
    let attacker = SoftwareKey::random().unwrap();
    let id = "01JQZZZZZZZZZZZZZZZZZZZZZZ";
    superuser
        .execute(
            "INSERT INTO sessions \
                 (id, principal_id, principal_kind, token_hash, session_pubkey, session_alg, \
                  bound_nonce, assurance, chain_seq, expires_at, row_mac) \
             VALUES ($1, $2, 'steward', $3, $4, 1, $5, 'A0', 1, now() + interval '1 hour', $6)",
            &[
                &id,
                &estate.steward.account.to_string(),
                &vec![7u8; 32],
                &attacker.public_key().to_vec(),
                &vec![9u8; 32],
                &vec![0u8; 32],
            ],
        )
        .await
        .expect("a superuser can write the row; that is the premise, not the failure");

    // A nonce, also minted directly, so that the refusal cannot be blamed on
    // the attacker having no way to get one.
    superuser
        .execute(
            "INSERT INTO session_nonces (nonce, purpose, session_id, issued_counter, expires_at) \
             VALUES ($1, 'request', $2, 0, now() + interval '1 hour')",
            &[&vec![5u8; 32], &id],
        )
        .await
        .expect("insert the nonce");

    let nonce = [5u8; 32];
    let unix_ms = now_ms();
    let message = sessions::request_bytes(
        id,
        "GET",
        "/x",
        &sessions::body_digest(b""),
        &nonce,
        unix_ms,
        1,
    );
    let refused = store
        .verify_request(&SignedRequest {
            session_id: id,
            method: "GET",
            path: "/x",
            body: b"",
            nonce,
            unix_ms,
            counter: 1,
            signature: attacker.sign(&message),
        })
        .await;

    assert!(
        matches!(refused, Err(SessionError::Unverifiable(_))),
        "a session row this server did not write must fail its MAC at its first use, and the \
         refusal must be an integrity alarm rather than a permission error (§3.4 step 2), got \
         {refused:?}"
    );

    superuser
        .execute("DELETE FROM sessions WHERE id = $1", &[&id])
        .await
        .expect("clean up");
}

#[tokio::test]
async fn an_expired_session_is_refused_and_the_row_goes_with_it() {
    let _site = support::lock_the_site_chain().await;
    let pool = support::migrated_pool().await;
    let ring = ring();
    let estate = bootstrap(&pool, &ring).await;
    let deployment = {
        let client = pool.get().await.expect("connection");
        chains::deployment_id(&**client).await.expect("deployment")
    };
    // A short lifetime, and then a real wait past it. The alternative --
    // moving `expires_at` in SQL -- breaks the row MAC, so the refusal
    // observed would be the MAC's and this test would prove nothing about
    // expiry. That fence has its own test below.
    //
    // **Four seconds, not one.** The lifetime has to cover signing in AND
    // taking a nonce, both of which are real database round trips, because
    // the session is already ticking when `sign_in` returns. At one second
    // this test failed on a loaded machine with `a live session may ask for a
    // nonce: Expired` -- the session expiring before the test had finished
    // setting itself up, so it never reached the refusal it exists to check.
    // Observed 2026-09-16 while running the suite repeatedly. Four seconds is
    // still an expiry a person would notice and costs the suite under five.
    const LIFETIME: std::time::Duration = std::time::Duration::from_secs(4);
    let store = SessionStore::with_lifetime(
        pool.clone(),
        Arc::clone(&ring),
        deployment,
        SignInLimits::defaults(),
        LIFETIME,
    );
    let (signed_in, session_key) = sign_in(&store, &estate.steward).await;

    // A nonce first, so the refusal is about the session's lifetime and not
    // about the caller having nothing to present.
    let call = a_call(&store, &signed_in, &session_key, "GET", "/x", b"").await;
    tokio::time::sleep(LIFETIME + std::time::Duration::from_millis(500)).await;

    let refused = store
        .verify_request(&as_request(&call, "GET", "/x", b""))
        .await;
    assert!(
        matches!(refused, Err(SessionError::Expired)),
        "an expired session must be refused as expired -- which tells a person to sign in again \
         -- and not as anything that sends somebody looking for an attacker, got {refused:?}"
    );

    let left: i64 = support::superuser_client_on_test_database()
        .await
        .query_one(
            "SELECT count(*) FROM sessions WHERE id = $1",
            &[&signed_in.session_id],
        )
        .await
        .expect("count")
        .get(0);
    assert_eq!(
        left, 0,
        "an expired session is deleted at the use that found it expired, so nothing is left to \
         be resurrected"
    );
}

#[tokio::test]
async fn moving_a_sessions_expiry_in_sql_breaks_its_mac() {
    let _site = support::lock_the_site_chain().await;
    let pool = support::migrated_pool().await;
    let ring = ring();
    let estate = bootstrap(&pool, &ring).await;
    let store = store(&pool, Arc::clone(&ring)).await;
    let (signed_in, session_key) = sign_in(&store, &estate.steward).await;
    let call = a_call(&store, &signed_in, &session_key, "GET", "/x", b"").await;

    // The other half of §4.3's second fence. Extending a session by a year is
    // a one-line `UPDATE` for anybody holding a database credential, and
    // `expires_at` is inside the MAC precisely so that the row stops
    // verifying when they do.
    support::superuser_client_on_test_database()
        .await
        .execute(
            "UPDATE sessions SET expires_at = now() + interval '365 days' WHERE id = $1",
            &[&signed_in.session_id],
        )
        .await
        .expect("a superuser can write the column; that is the premise");

    let refused = store
        .verify_request(&as_request(&call, "GET", "/x", b""))
        .await;
    assert!(
        matches!(refused, Err(SessionError::Unverifiable(_))),
        "a rewritten session row must fail its MAC, and the refusal is an integrity alarm \
         rather than a permission error, got {refused:?}"
    );
}

#[tokio::test]
async fn a_session_for_a_disabled_account_stops_at_the_next_request() {
    let _site = support::lock_the_site_chain().await;
    let pool = support::migrated_pool().await;
    let ring = ring();
    let estate = bootstrap(&pool, &ring).await;
    let store = store(&pool, Arc::clone(&ring)).await;
    let (signed_in, session_key) = sign_in(&store, &estate.steward).await;

    let call = a_call(&store, &signed_in, &session_key, "GET", "/x", b"").await;
    store
        .verify_request(&as_request(&call, "GET", "/x", b""))
        .await
        .expect("the session works before the account is disabled");

    store
        .set_account_disabled(&estate.steward.account.to_string(), true)
        .await
        .expect("disable the account");

    let call = a_call(&store, &signed_in, &session_key, "GET", "/x", b"").await;
    let refused = store
        .verify_request(&as_request(&call, "GET", "/x", b""))
        .await;
    assert!(
        matches!(refused, Err(SessionError::AccountDisabled)),
        "a live session must not outlive its account being disabled, got {refused:?}"
    );

    // And a new sign-in is refused too, with the uniform message.
    let attempt = sign_in_with(&store, &estate.steward, &SoftwareKey::random().unwrap()).await;
    assert!(
        matches!(attempt, Err(SessionError::SignInRefused)),
        "a disabled account cannot sign in, and the refusal says no more than any other, got \
         {attempt:?}"
    );
}

#[tokio::test]
async fn a_session_whose_key_was_retired_stops_at_the_next_request() {
    let _site = support::lock_the_site_chain().await;
    let pool = support::migrated_pool().await;
    let ring = ring();
    let estate = bootstrap(&pool, &ring).await;
    let store = store(&pool, Arc::clone(&ring)).await;
    let (signed_in, session_key) = sign_in(&store, &estate.steward).await;

    let call = a_call(&store, &signed_in, &session_key, "GET", "/x", b"").await;
    store
        .verify_request(&as_request(&call, "GET", "/x", b""))
        .await
        .expect("the session works while the key that proved it is in service");

    // §8.4's retirement, as a signed act by the key's own holder, taking
    // effect a minute ago -- the shape that matters is "the key is out of
    // service now", which is what a stolen laptop's owner does.
    let at = now_unix() - 60;
    let mut client = pool.get().await.expect("connection");
    let tx = client.transaction().await.expect("begin");
    let ctx = repo::open_tenant_context(&tx, estate.organisation, estate.steward.account)
        .await
        .expect("tenant context");
    let tenant_key = keys::tenant_key(&tx, &ring, &ctx)
        .await
        .expect("tenant key");
    let key = grants::signing_key_of(&tx, &estate.steward.account.to_string())
        .await
        .expect("read")
        .expect("a key");
    let signature = estate.steward.key.sign(&authority::retire_bytes(
        &estate.steward.account.to_string(),
        &key.fpr,
        &key.fpr,
        at,
    ));
    let watch = EpochWatch::new();
    let auth = Authority {
        ring: &ring,
        ctx: &ctx,
        tenant_key: &tenant_key,
        watch: &watch,
    };
    grants::retire_key(&tx, &auth, &key.id, &signature, at)
        .await
        .expect("a holder may retire their own key");
    tx.commit().await.expect("commit");

    let call = a_call(&store, &signed_in, &session_key, "GET", "/x", b"").await;
    let refused = store
        .verify_request(&as_request(&call, "GET", "/x", b""))
        .await;
    assert!(
        matches!(refused, Err(SessionError::EvidenceKeyNotInService)),
        "a session must not outlive the key that established it, got {refused:?}"
    );
}

#[tokio::test]
async fn signing_out_deletes_the_row_and_the_next_request_is_refused() {
    let _site = support::lock_the_site_chain().await;
    let pool = support::migrated_pool().await;
    let ring = ring();
    let estate = bootstrap(&pool, &ring).await;
    let store = store(&pool, Arc::clone(&ring)).await;
    let (signed_in, session_key) = sign_in(&store, &estate.steward).await;

    let call = a_call(&store, &signed_in, &session_key, "DELETE", "/session", b"").await;
    let verified = store
        .verify_request(&as_request(&call, "DELETE", "/session", b""))
        .await
        .expect("the sign-out request is itself signed");
    store.sign_out(&verified).await.expect("sign out");

    let left: i64 = support::superuser_client_on_test_database()
        .await
        .query_one(
            "SELECT count(*) FROM sessions WHERE id = $1",
            &[&signed_in.session_id],
        )
        .await
        .expect("count")
        .get(0);
    assert_eq!(left, 0, "sign-out deletes the row rather than flagging it");

    let nonce = store
        .issue_request_nonce(&signed_in.session_id, &signed_in.token)
        .await;
    assert!(
        matches!(nonce, Err(SessionError::NoSuchSession)),
        "a session that has been signed out is gone, got {nonce:?}"
    );
}

// ---------------------------------------------------------------------------
// §4.2 — the sign-in binding
// ---------------------------------------------------------------------------

#[tokio::test]
async fn a_bind_nonce_cannot_bind_a_second_public_key() {
    let _site = support::lock_the_site_chain().await;
    let pool = support::migrated_pool().await;
    let ring = ring();
    let estate = bootstrap(&pool, &ring).await;
    let store = store(&pool, Arc::clone(&ring)).await;

    let honest = SoftwareKey::random().unwrap();
    let attacker = SoftwareKey::random().unwrap();
    let challenge = store
        .issue_challenge(
            PrincipalKind::Steward,
            &estate.steward.address,
            &honest.public_key(),
            &a_source_of_its_own(),
        )
        .await
        .expect("a challenge");

    // §4.2: *"the assertion is accepted only if the challenge inside it
    // recomputes from the session_pubkey the client is asking to register"*.
    // Here the account's own key signs the honest challenge — a genuine
    // signature — and the attacker asks for their key to be bound instead.
    let digest = sessions::session_challenge(
        &honest.public_key(),
        &challenge.nonce,
        &challenge.deployment_id,
    );
    let evidence = estate.steward.key.sign(&digest);
    let refused = store
        .sign_in(
            PrincipalKind::Steward,
            &attacker.public_key(),
            &challenge.nonce,
            &evidence,
            &a_source_of_its_own(),
        )
        .await;
    assert!(
        matches!(refused, Err(SessionError::SignInRefused)),
        "a genuine signature over one challenge must not bind a different browser's key, got \
         {refused:?}"
    );

    // And the nonce is spent either way, so the honest key cannot be bound
    // with it afterwards either.
    let second = store
        .sign_in(
            PrincipalKind::Steward,
            &honest.public_key(),
            &challenge.nonce,
            &evidence,
            &a_source_of_its_own(),
        )
        .await;
    assert!(
        matches!(second, Err(SessionError::SignInRefused)),
        "a bind nonce is single-use and is consumed by the attempt, got {second:?}"
    );
}

/// **The account oracle, closed and proved closed at every attempt.**
///
/// `CLAUDE.md` rule 2 is why this test is shaped the way it is. Until
/// 2026-09-14 it made ONE failed sign-in and asserted that both answers were
/// `SignInRefused` — and the divergence did not begin until the eleventh. The
/// account bucket was counted only when the consumed bind nonce carried a
/// principal, so an address belonging to nobody never crossed the cap and
/// answered `401` for ever, while a real address answered `429` with a
/// `Retry-After` header from attempt eleven. One attempt was exactly the
/// number at which the two agree.
///
/// So this drives both **past the cap** and compares the whole answer at every
/// attempt: status line, every header, and body. It runs over the real HTTP
/// surface because that is where the divergence was visible — the
/// `Retry-After` header is added by `api.rs` and a test at the store's API
/// would have to know to look for it.
///
/// Each address gets a source of its own, so the source bucket — which is
/// shared and which closes for both alike — cannot be what makes them agree.
#[tokio::test]
async fn an_address_that_belongs_to_no_account_gets_the_same_answer_as_one_that_does() {
    let _site = support::lock_the_site_chain().await;
    let pool = support::migrated_pool().await;
    let ring = ring();
    let estate = bootstrap(&pool, &ring).await;
    let deployment = {
        let client = pool.get().await.expect("connection");
        chains::deployment_id(&**client).await.expect("deployment")
    };
    // A small account cap, because the shape is what is under test and not the
    // number; the source cap is put far out of the way so there is no question
    // which bucket answered.
    let store = SessionStore::new(
        pool.clone(),
        Arc::clone(&ring),
        deployment,
        SignInLimits {
            window: std::time::Duration::from_secs(900),
            max_per_account: 3,
            max_per_source: 1_000_000,
        },
    );
    let state = ApiState {
        sessions: Arc::new(store),
        watch: Arc::new(EpochWatch::new()),
        ring: Arc::clone(&ring),
        client_address: ClientAddress::header("x-forwarded-for"),
    };
    let addr = serve(api::router(state)).await;

    let wrong = SoftwareKey::random().unwrap();
    let known_source = a_source_of_its_own();
    let unknown_source = a_source_of_its_own();
    let known_address = estate.steward.address.clone();
    let unknown_address = unique("nobody");

    // **Interleaved**, one attempt each, rather than one run after the other:
    // the two answers are then microseconds apart, and any difference between
    // them is a difference in what the server said rather than in when it was
    // asked.
    let mut known: Vec<(String, Vec<String>, String)> = Vec::new();
    let mut unknown: Vec<(String, Vec<String>, String)> = Vec::new();
    let mut retry_after: Vec<(i64, i64)> = Vec::new();
    for _ in 0..8 {
        let a = one_failed_sign_in(addr, &known_address, &known_source, &wrong).await;
        let b = one_failed_sign_in(addr, &unknown_address, &unknown_source, &wrong).await;
        if let (Some(x), Some(y)) = (retry_after_of(&a.1), retry_after_of(&b.1)) {
            retry_after.push((x, y));
        }
        known.push(a);
        unknown.push(b);
    }

    for (n, (a, b)) in known.iter().zip(unknown.iter()).enumerate() {
        // `Retry-After` counts down to the end of the fixed window, so its
        // VALUE moves with the clock and not with the address. The name, the
        // presence and the attempt it first appears at are what carry the
        // oracle, so the value is normalised here and compared for closeness
        // below rather than dropped.
        assert_eq!(
            (&a.0, normalise(&a.1), &a.2),
            (&b.0, normalise(&b.1), &b.2),
            "attempt {}: an address that belongs to an account answered {a:?} and one that \
             belongs to nobody answered {b:?}. A refusal is uniform only if EVERY refusal this \
             surface can produce is uniform, at every attempt — the status, the headers and the \
             body — or the rate limiter is an oracle over the deployment's user list",
            n + 1
        );
    }
    assert!(
        !retry_after.is_empty(),
        "the run must produce a `Retry-After` for both, or the normalisation above is hiding the \
         very header the oracle was read off"
    );
    for (x, y) in &retry_after {
        assert!(
            (x - y).abs() <= 2,
            "the two `Retry-After` values are {x} and {y}: they must both be the time left in \
             the window and nothing about which address was claimed"
        );
    }

    // And the property is not vacuous: both really do cross the cap, so this
    // is not two identical `401`s agreeing because nothing ever changed.
    assert!(
        known.iter().any(|(status, _, _)| status == "429"),
        "the run must actually pass the cap, or the equality above proves nothing: {known:?}"
    );
    assert!(
        known.iter().any(|(status, _, _)| status == "401"),
        "and it must start below it: {known:?}"
    );
    assert!(
        known
            .iter()
            .any(|(_, headers, _)| headers.iter().any(|h| h.starts_with("retry-after:"))),
        "the `Retry-After` header is the observable the oracle was read off, so it has to be in \
         what is compared: {known:?}"
    );
}

/// One complete failed sign-in — challenge, then a real signature by the wrong
/// key — and the whole of what came back.
///
/// The signature is genuine and by a key the account never enrolled, so the
/// failure under test is authentication rather than a malformed message, and
/// the known address fails exactly as often as the unknown one does.
async fn one_failed_sign_in(
    addr: std::net::SocketAddr,
    address: &str,
    source: &str,
    wrong: &SoftwareKey,
) -> (String, Vec<String>, String) {
    let session_key = SoftwareKey::random().unwrap();
    let pubkey = session_key.public_key();

    let mut body = Vec::new();
    lp(&mut body, b"steward");
    lp(&mut body, address.as_bytes());
    lp(&mut body, &pubkey);
    let (status, answer, _) = post_bytes_full(
        addr,
        "/session/challenge",
        &body,
        &[("x-forwarded-for", source.to_string())],
    )
    .await;
    assert_eq!(
        status, "200",
        "the challenge route answers alike either way"
    );
    let (nonce, rest) = read_lp(&answer);
    let (deployment, _) = read_lp(rest);
    let deployment = String::from_utf8(deployment.to_vec()).unwrap();
    let nonce: [u8; 32] = nonce.try_into().unwrap();

    let digest = sessions::session_challenge(&pubkey, &nonce, &deployment);
    let mut body = Vec::new();
    lp(&mut body, b"steward");
    lp(&mut body, &pubkey);
    lp(&mut body, &nonce);
    lp(&mut body, &wrong.sign(&digest));

    // ADR-0055 decision 10 widened `POST /session` from four length-prefixed
    // fields to six: a credential and an app code, both empty on the key-only
    // branch this test drives. `read_fields` still refuses an inexact count,
    // so the two empty fields are not optional.
    lp(&mut body, b"");
    lp(&mut body, b"");
    let (status, answer, headers) = post_bytes_full(
        addr,
        "/session",
        &body,
        &[("x-forwarded-for", source.to_string())],
    )
    .await;
    (
        status,
        headers,
        String::from_utf8_lossy(&answer).into_owned(),
    )
}

/// The header list with `Retry-After`'s countdown replaced by a placeholder,
/// so the comparison is of what the server said and not of when it was asked.
fn normalise(headers: &[String]) -> Vec<String> {
    headers
        .iter()
        .map(|h| {
            if h.starts_with("retry-after:") {
                "retry-after: <seconds left in the window>".to_string()
            } else {
                h.clone()
            }
        })
        .collect()
}

fn retry_after_of(headers: &[String]) -> Option<i64> {
    headers
        .iter()
        .find_map(|h| h.strip_prefix("retry-after:"))
        .and_then(|v| v.trim().parse().ok())
}

// ---------------------------------------------------------------------------
// ADR-0055 decision 10 — the operator custody needs a second factor
// ---------------------------------------------------------------------------
//
// **`the_operator_sign_in_surface_accepts_no_password_shaped_input` stood here
// and is deleted.** It asserted §4.5's "an operator session is A1 or it does
// not exist, there is no password path", and ADR-0055 decision 10 reopens
// exactly that on the owner's own decision, recorded in that ADR's header. A
// test that forbids what the product now does is not a weakened test, it is a
// false one.
//
// What replaces it is the guard the ADR puts in place of the ban: an account
// that holds the operator custody and has not enrolled its app code has a
// session that may finish its setup and do nothing else. The contracts name
// this test by name.

/// **An anonymous attacker gets ONE sealed entry per window, whatever they
/// spray.**
///
/// `0013` §D's rule is that a refusal is *"a typed error and a sealed entry,
/// and the entry is written ONCE per window rather than once per refused
/// request: otherwise the audit chain grows without bound at whatever rate an
/// anonymous attacker chooses, which converts a rate limit into an amplifier."*
///
/// The test that used to stand here asserted exactly that and did not test it.
/// It attacked a KNOWN address with a small account cap — the one case where
/// the old latch fired at all — so its attacker was never anonymous, which is
/// the case the rule is about. An anonymous failure counted no account bucket,
/// so nothing ever locked and an entry was appended on every single attempt.
///
/// This attacker is genuinely anonymous: **a different address that belongs to
/// nobody, every time**, from one source. That defeats the claimed-address
/// bucket too — each address is a fresh bucket with a fresh cap — so what has
/// to hold the line is the per-source anonymous latch, and nothing else can be
/// what makes this pass.
#[tokio::test]
async fn an_anonymous_attacker_gets_one_sealed_entry_per_window_however_many_addresses_they_spray()
{
    let _site = support::lock_the_site_chain().await;
    let pool = support::migrated_pool().await;
    let ring = ring();
    let _estate = bootstrap(&pool, &ring).await;
    let store = store(&pool, Arc::clone(&ring)).await;

    let before = failed_entries(&pool).await;
    let source = a_source_of_its_own();
    let wrong = SoftwareKey::random().unwrap();
    let mut refusals = Vec::new();
    for _ in 0..12 {
        let session_key = SoftwareKey::random().unwrap();
        let pubkey = session_key.public_key();
        // A fresh address that belongs to nobody on every attempt.
        let challenge = store
            .issue_challenge(PrincipalKind::Steward, &unique("nobody"), &pubkey, &source)
            .await
            .expect("a challenge");
        let digest =
            sessions::session_challenge(&pubkey, &challenge.nonce, &challenge.deployment_id);
        refusals.push(
            store
                .sign_in(
                    PrincipalKind::Steward,
                    &pubkey,
                    &challenge.nonce,
                    &wrong.sign(&digest),
                    &source,
                )
                .await,
        );
    }

    assert!(
        refusals
            .iter()
            .all(|r| matches!(r, Err(SessionError::SignInRefused))),
        "twelve unknown addresses are twelve fresh account buckets, so none of them crosses a \
         cap and every answer is the ordinary refusal: {refusals:?}"
    );

    let written = failed_entries(&pool).await - before;
    assert_eq!(
        written, 1,
        "a (source, window) pair yields at most one anonymous entry. {written} entries for \
         twelve attempts means an unauthenticated caller still chooses how fast this \
         deployment's sealed audit chain grows"
    );
}

/// The account bucket, against a KNOWN address — the other half of the rule.
///
/// Bounded by that account's own cap rather than by the source latch, which is
/// deliberate: a run of failures against a real address is a signal an
/// operator wants, and an attacker cannot inflate it without holding the
/// address.
#[tokio::test]
async fn repeated_failures_against_one_account_close_its_window_and_then_stop_recording() {
    let _site = support::lock_the_site_chain().await;
    let pool = support::migrated_pool().await;
    let ring = ring();
    let estate = bootstrap(&pool, &ring).await;
    let deployment = {
        let client = pool.get().await.expect("connection");
        chains::deployment_id(&**client).await.expect("deployment")
    };
    // A small limit, because the shape is what is being tested and not the
    // number: §13 item 7 leaves the number to the deployment.
    let store = SessionStore::new(
        pool.clone(),
        Arc::clone(&ring),
        deployment,
        SignInLimits {
            window: std::time::Duration::from_secs(900),
            max_per_account: 3,
            max_per_source: 1_000_000,
        },
    );

    let before = failed_entries(&pool).await;
    let source = a_source_of_its_own();
    let wrong = SoftwareKey::random().unwrap();
    let mut refusals = Vec::new();
    for _ in 0..8 {
        let session_key = SoftwareKey::random().unwrap();
        let pubkey = session_key.public_key();
        let challenge = store
            .issue_challenge(
                PrincipalKind::Steward,
                &estate.steward.address,
                &pubkey,
                &source,
            )
            .await
            .expect("a challenge");
        let digest =
            sessions::session_challenge(&pubkey, &challenge.nonce, &challenge.deployment_id);
        // A real signature by the wrong key: the failure under test is
        // authentication, not a malformed message.
        refusals.push(
            store
                .sign_in(
                    PrincipalKind::Steward,
                    &pubkey,
                    &challenge.nonce,
                    &wrong.sign(&digest),
                    &source,
                )
                .await,
        );
    }

    assert!(
        matches!(refusals[0], Err(SessionError::SignInRefused)),
        "the first failure is an ordinary refusal, got {:?}",
        refusals[0]
    );
    assert!(
        matches!(refusals[7], Err(SessionError::RateLimited { .. })),
        "past the limit, the refusal must tell the caller to wait, got {:?}",
        refusals[7]
    );

    let written = failed_entries(&pool).await - before;
    assert!(
        written >= 1,
        "a refused sign-in is a sealed entry §7.2 names, and at least one must be written"
    );
    assert!(
        written <= 5,
        "once the window is closed the entries stop: at most one per attempt up to the cap of \
         three, plus the one that records the cap closing. {written} entries for eight attempts"
    );
}

async fn failed_entries(pool: &Pool) -> i64 {
    pool.get()
        .await
        .expect("connection")
        .query_one(
            "SELECT count(*) FROM chain_entries \
              WHERE chain_kind = 'site' AND entry_type = 'account_signin_failed'",
            &[],
        )
        .await
        .expect("count")
        .get(0)
}

/// The source bucket, which had no test of its own until the sign-in helpers
/// stopped sharing one address (2026-09-13).
///
/// Deliberately a **valid** sign-in every time: the source number is a rate
/// limit on attempts and not a lockout on failures, so the cap has to bite a
/// caller whose signature is perfect. `max_per_account` is put far out of the
/// way so there is no question which bucket refused.
///
/// **A complete sign-in costs two**, since `0014` counts `/session/challenge`
/// against the same bucket — it writes a `session_nonces` row and was
/// unmetered, so one anonymous POST was one permanent row. A cap of five
/// therefore admits two complete sign-ins and refuses at the challenge of the
/// third, and that is what this asserts rather than the old arithmetic.
#[tokio::test]
async fn the_source_bucket_refuses_a_valid_sign_in_past_its_cap() {
    let _site = support::lock_the_site_chain().await;
    let pool = support::migrated_pool().await;
    let ring = ring();
    let estate = bootstrap(&pool, &ring).await;
    let deployment = {
        let client = pool.get().await.expect("connection");
        chains::deployment_id(&**client).await.expect("deployment")
    };
    let store = SessionStore::new(
        pool.clone(),
        Arc::clone(&ring),
        deployment,
        SignInLimits {
            window: std::time::Duration::from_secs(900),
            max_per_account: 1_000_000,
            max_per_source: 5,
        },
    );

    // One source for all three attempts -- the bucket under test -- but one no
    // other test and no earlier run has counted against.
    let source = a_source_of_its_own();
    let mut answers = Vec::new();
    for _ in 0..3 {
        let session_key = SoftwareKey::random().expect("a session keypair");
        answers.push(sign_in_from(&store, &estate.steward, &session_key, &source).await);
    }

    for (i, answer) in answers.iter().take(2).enumerate() {
        assert!(
            answer.is_ok(),
            "attempt {} is inside the cap and its signature is good: {answer:?}",
            i + 1
        );
    }
    assert!(
        matches!(answers[2], Err(SessionError::RateLimited { .. })),
        "past the source cap even a perfect sign-in is told to wait: {:?}",
        answers[2]
    );
}

/// The challenge route is metered, which is the half of `0014` §C that is not
/// about sweeping.
///
/// Before it, `issue_challenge` counted nothing at all: one unauthenticated
/// POST was one permanent `session_nonces` row, and an attacker chose how many.
#[tokio::test]
async fn the_challenge_route_is_counted_against_the_source_bucket() {
    let _site = support::lock_the_site_chain().await;
    let pool = support::migrated_pool().await;
    let ring = ring();
    let _estate = bootstrap(&pool, &ring).await;
    let deployment = {
        let client = pool.get().await.expect("connection");
        chains::deployment_id(&**client).await.expect("deployment")
    };
    let store = SessionStore::new(
        pool.clone(),
        Arc::clone(&ring),
        deployment,
        SignInLimits {
            window: std::time::Duration::from_secs(900),
            max_per_account: 1_000_000,
            max_per_source: 3,
        },
    );

    let source = a_source_of_its_own();
    let mut answers = Vec::new();
    for _ in 0..4 {
        let key = SoftwareKey::random().unwrap();
        answers.push(
            store
                .issue_challenge(
                    PrincipalKind::Steward,
                    "nobody@example.invalid",
                    &key.public_key(),
                    &source,
                )
                .await
                .map(|_| ()),
        );
    }

    for (i, answer) in answers.iter().take(3).enumerate() {
        assert!(answer.is_ok(), "challenge {} is inside the cap", i + 1);
    }
    assert!(
        matches!(answers[3], Err(SessionError::RateLimited { .. })),
        "past the cap the challenge route refuses too, so an anonymous caller cannot grow \
         `session_nonces` without bound: {:?}",
        answers[3]
    );
}

/// `0014` §C's sweep, on all three tables, driven through the write paths that
/// carry it.
///
/// Nothing in `0013` ever deleted an expired row. The two deletes in
/// `sessions.rs` matched one exact nonce, and `0013` §F took DELETE on
/// `sign_in_attempts` away from `fathom_app` on the argument that nothing
/// would ever want it.
#[tokio::test]
async fn every_write_path_sweeps_what_has_expired_on_the_table_it_writes_to() {
    let _site = support::lock_the_site_chain().await;
    let pool = support::migrated_pool().await;
    let ring = ring();
    let estate = bootstrap(&pool, &ring).await;
    let store = store(&pool, Arc::clone(&ring)).await;
    let superuser = support::superuser_client_on_test_database().await;

    // Twenty bind nonces and one live session, then time moved on for all of
    // them. `expires_at` is not inside the nonce's MAC -- there is none -- and
    // for the session it is, which is why the session here is one this test
    // then abandons rather than one it goes on to use.
    let (abandoned, _key) = sign_in(&store, &estate.steward).await;
    for _ in 0..20 {
        let key = SoftwareKey::random().unwrap();
        store
            .issue_challenge(
                PrincipalKind::Steward,
                "nobody@example.invalid",
                &key.public_key(),
                &a_source_of_its_own(),
            )
            .await
            .expect("a challenge");
    }
    superuser
        .execute(
            "UPDATE session_nonces \
                SET issued_at = now() - interval '2 hours', \
                    expires_at = now() - interval '1 hour'",
            &[],
        )
        .await
        .expect("age the nonces");
    superuser
        .execute(
            "UPDATE sessions \
                SET issued_at = now() - interval '2 hours', \
                    expires_at = now() - interval '1 hour' \
              WHERE id = $1",
            &[&abandoned.session_id],
        )
        .await
        .expect("age the session");
    // An attempt row for a window that has already closed.
    superuser
        .execute(
            "INSERT INTO sign_in_attempts (bucket_kind, bucket_key, window_start, attempts) \
             VALUES ('source', $1, now() - interval '3 days', 7)",
            &[&unique("ancient")],
        )
        .await
        .expect("an old attempt row");
    let ancient_before: i64 = superuser
        .query_one(
            "SELECT count(*) FROM sign_in_attempts WHERE window_start < now() - interval '1 day'",
            &[],
        )
        .await
        .expect("count")
        .get(0);
    assert!(ancient_before >= 1, "the fixture must actually be there");

    // One more sign-in: it writes to all three tables, so it pays for all
    // three.
    let session_key = SoftwareKey::random().unwrap();
    sign_in_with(&store, &estate.steward, &session_key)
        .await
        .expect("a good sign-in");

    for (what, sql) in [
        (
            "expired nonces",
            "SELECT count(*) FROM session_nonces WHERE expires_at <= now()",
        ),
        (
            "expired sessions",
            "SELECT count(*) FROM sessions WHERE expires_at <= now()",
        ),
        (
            "attempt rows for a closed window",
            "SELECT count(*) FROM sign_in_attempts \
              WHERE window_start < now() - interval '1 day'",
        ),
    ] {
        let left: i64 = superuser.query_one(sql, &[]).await.expect("count").get(0);
        assert_eq!(
            left, 0,
            "{left} {what} survived a write on their own table. Without a sweep one anonymous \
             POST is one permanent row, and this deployment has no scheduler to run a background \
             one in"
        );
    }
}

// ---------------------------------------------------------------------------
// §13 item 1 — the actor comes from the session, structurally
// ---------------------------------------------------------------------------

#[test]
fn no_route_can_obtain_an_actor_except_through_a_verified_session() {
    // The type system carries most of this: `VerifiedSession` has private
    // fields, no public constructor, and no accessor that yields an
    // `AccountId`, and `sessions::open_tenant_context` is the only function
    // that turns one into a `repo::TenantContext`. What a type cannot stop is
    // a handler parsing an id out of a header and calling the repository
    // itself, so this reads the surface's own source.
    let source = include_str!("../src/api.rs");
    // Comments are excluded: the module header DESCRIBES this rule, and a
    // check that failed on its own documentation is a check somebody deletes.
    let code: String = source
        .lines()
        .filter(|line| !line.trim_start().starts_with("//"))
        .collect::<Vec<_>>()
        .join("\n");
    for forbidden in ["repo::open_tenant_context", "AccountId"] {
        assert!(
            !code.contains(forbidden),
            "src/api.rs names `{forbidden}` in code. §13 item 1: `actor` comes from a session, \
             never from the caller — and the HTTP surface is the one place a caller's bytes \
             could be turned into one"
        );
    }
    // The one bridge, named, so that deleting it fails this test rather than
    // quietly leaving the rule with nothing behind it.
    assert!(
        source.contains("sessions::open_tenant_context"),
        "the surface must reach the repository through the session bridge"
    );
}

// ---------------------------------------------------------------------------
// The demonstration route, end to end through the real router
// ---------------------------------------------------------------------------

#[tokio::test]
async fn the_demonstration_route_answers_read_draw_steward_and_not_authorised_from_real_grants() {
    let _site = support::lock_the_site_chain().await;
    let pool = support::migrated_pool().await;
    let ring = ring();
    let estate = bootstrap(&pool, &ring).await;
    let reader = a_member_with(&pool, &ring, &estate, "reader", Some(Capability::Read)).await;
    let drawer = a_member_with(&pool, &ring, &estate, "drawer", Some(Capability::Draw)).await;
    let stranger = a_member_with(&pool, &ring, &estate, "stranger", None).await;

    let state = ApiState {
        sessions: Arc::new(store(&pool, Arc::clone(&ring)).await),
        watch: Arc::new(EpochWatch::new()),
        ring: Arc::clone(&ring),
        // Trusted so that `call_over_http` can give this test a rate-limit
        // bucket of its own; see its doc comment for what happens without
        // one. This is a test driving its own router, not advice: the header
        // is only safe to trust where a proxy you control overwrites it, as
        // `ApiState::client_address` says.
        client_address: ClientAddress::header("x-forwarded-for"),
    };
    let addr = serve(api::router(state)).await;

    // Four sign-ins follow. One source for all four is fine — the cap is far
    // above four — but it must not be a source any other test or any earlier
    // run shares.
    let source = a_source_of_its_own();

    let path = format!("/organisations/{}/capability", estate.organisation);
    for (who, expected) in [
        (&estate.steward, "steward\n"),
        (&reader, "read\n"),
        (&drawer, "draw\n"),
    ] {
        let (status, body) = call_over_http(addr, who, "GET", &path, &source).await;
        assert_eq!(status, "200", "{} got {status} {body}", who.address);
        assert_eq!(body, expected, "for {}", who.address);
    }

    let (status, body) = call_over_http(addr, &stranger, "GET", &path, &source).await;
    assert_eq!(
        status, "403",
        "a member with no grant is not authorised, and the refusal is a permission error rather \
         than an integrity alarm: {body}"
    );

    // A route reached with no signature at all is refused before the handler
    // runs -- which is the extractor doing its job, not the handler.
    let (status, _) = raw_request(addr, "GET", &path, &[], b"").await;
    assert_eq!(status, "401");
}

/// Sign in, take a nonce and sign one request, all over the real HTTP surface.
/// `source` is the value sent as `x-forwarded-for`, which the state this
/// helper is driven against must trust (`ApiState::client_address`).
///
/// **It has to be a source of the caller's own.** Without it every request
/// here counts against the peer address — `127.0.0.1` for every test in this
/// file at once — and the sign-in rate limit is a counter in the database that
/// outlives a single `cargo test`. On a fresh database that is invisible; on a
/// database a suite has already run against, this test's four sign-ins land on
/// a bucket near its cap and the challenge answers `429` instead of `200`.
/// Found on 2026-09-16 by running the suite repeatedly against one database.
/// `docs/NEXT.md` ground rule 3: anything global needs a lock or a key of its
/// own, and a rate-limit bucket is global.
async fn call_over_http(
    addr: std::net::SocketAddr,
    person: &Person,
    method: &str,
    path: &str,
    source: &str,
) -> (String, String) {
    let session_key = SoftwareKey::random().unwrap();
    let pubkey = session_key.public_key();
    let forwarded: &[(&str, String)] = &[("x-forwarded-for", source.to_string())];

    // POST /session/challenge
    let mut body = Vec::new();
    lp(&mut body, b"steward");
    lp(&mut body, person.address.as_bytes());
    lp(&mut body, &pubkey);
    let (status, answer) = post_bytes(addr, "/session/challenge", &body, forwarded).await;
    assert_eq!(status, "200", "challenge");
    let (nonce, rest) = read_lp(&answer);
    let (deployment, _) = read_lp(rest);
    let deployment = String::from_utf8(deployment.to_vec()).unwrap();
    let nonce: [u8; 32] = nonce.try_into().unwrap();

    // POST /session
    let digest = sessions::session_challenge(&pubkey, &nonce, &deployment);
    let mut body = Vec::new();
    lp(&mut body, b"steward");
    lp(&mut body, &pubkey);
    lp(&mut body, &nonce);
    lp(&mut body, &person.key.sign(&digest));

    // ADR-0055 decision 10 widened `POST /session` from four length-prefixed
    // fields to six: a credential and an app code, both empty on the key-only
    // branch this test drives. `read_fields` still refuses an inexact count,
    // so the two empty fields are not optional.
    lp(&mut body, b"");
    lp(&mut body, b"");
    let (status, answer) = post_bytes(addr, "/session", &body, forwarded).await;
    assert_eq!(status, "200", "sign-in");
    let (session_id, rest) = read_lp(&answer);
    let (token, rest) = read_lp(rest);
    let session_id = String::from_utf8(session_id.to_vec()).unwrap();

    // ADR-0053 §3: the answer's fourth field, after the 8-byte
    // `expires_at_unix`, is the signed-in account's ulid.
    let account_id = String::from_utf8(read_lp(&rest[8..]).0.to_vec()).unwrap();
    assert_eq!(
        account_id,
        person.account.to_string(),
        "account id over HTTP"
    );

    // POST /session/nonce
    let (status, answer) = post_bytes(
        addr,
        "/session/nonce",
        b"",
        &[
            (HEADER_SESSION, session_id.clone()),
            (HEADER_TOKEN, hex(token)),
        ],
    )
    .await;
    assert_eq!(status, "200", "nonce");
    let (nonce, _) = read_lp(&answer);
    let nonce: [u8; 32] = nonce.try_into().unwrap();

    // The signed call itself. The session is one request old, so its mark is
    // still zero and the browser's own tally is at one.
    let unix_ms = now_ms();
    let counter = 1i64;
    let message = sessions::request_bytes(
        &session_id,
        method,
        path,
        &sessions::body_digest(b""),
        &nonce,
        unix_ms,
        counter,
    );
    let signature = session_key.sign(&message);
    let (status, body) = raw_request(
        addr,
        method,
        path,
        &[
            (HEADER_SESSION, session_id),
            (HEADER_NONCE, hex(&nonce)),
            (HEADER_TIMESTAMP, unix_ms.to_string()),
            (HEADER_COUNTER, counter.to_string()),
            (HEADER_SIGNATURE, hex(&signature)),
        ],
        b"",
    )
    .await;
    (status, String::from_utf8_lossy(&body).into_owned())
}

// ---------------------------------------------------------------------------
// Speaking HTTP by hand — there is no HTTP client crate in this closure, and
// `schema_endpoint.rs` and `src/healthcheck.rs` already do this for the same
// reason.
// ---------------------------------------------------------------------------

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

async fn post_bytes(
    addr: std::net::SocketAddr,
    path: &str,
    body: &[u8],
    headers: &[(&str, String)],
) -> (String, Vec<u8>) {
    raw_request(addr, "POST", path, headers, body).await
}

/// As [`post_bytes`], and it also hands back **every response header**,
/// lower-cased and sorted.
///
/// The account oracle was read off a header — `Retry-After` — and not off a
/// status or a body, so a test about two answers being the same has to be able
/// to compare the whole of both. `Date` is dropped because it moves on its own
/// and would make every comparison a clock comparison.
async fn post_bytes_full(
    addr: std::net::SocketAddr,
    path: &str,
    body: &[u8],
    headers: &[(&str, String)],
) -> (String, Vec<u8>, Vec<String>) {
    let (status, head, body) = raw_request_full(addr, "POST", path, headers, body).await;
    let mut lines: Vec<String> = head
        .lines()
        .skip(1)
        .map(|l| l.trim().to_ascii_lowercase())
        .filter(|l| !l.is_empty() && !l.starts_with("date:"))
        .collect();
    lines.sort();
    (status, body, lines)
}

async fn raw_request(
    addr: std::net::SocketAddr,
    method: &str,
    path: &str,
    headers: &[(&str, String)],
    body: &[u8],
) -> (String, Vec<u8>) {
    let (status, _, body) = raw_request_full(addr, method, path, headers, body).await;
    (status, body)
}

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

// ---------------------------------------------------------------------------
// The policy fence — `0013` §E
// ---------------------------------------------------------------------------

#[tokio::test]
async fn an_ordinary_transaction_reads_zero_rows_from_the_session_tables() {
    let _site = support::lock_the_site_chain().await;
    let pool = support::migrated_pool().await;
    let ring = ring();
    let estate = bootstrap(&pool, &ring).await;
    let store = store(&pool, Arc::clone(&ring)).await;
    let (signed_in, _key) = sign_in(&store, &estate.steward).await;

    // The row exists -- the superuser can see it.
    let there: i64 = support::superuser_client_on_test_database()
        .await
        .query_one(
            "SELECT count(*) FROM sessions WHERE id = $1",
            &[&signed_in.session_id],
        )
        .await
        .expect("count")
        .get(0);
    assert_eq!(there, 1);

    // And the runtime role, in an ordinary tenant transaction -- a design
    // read, an authority act, anything that is not a verification -- reaches
    // none of it. `app.session_custody` is set by `sessions.rs` and by nothing
    // else, for the length of one transaction that does nothing but verify.
    let mut client = pool.get().await.expect("connection");
    let tx = client.transaction().await.expect("begin");
    let ctx = repo::open_tenant_context(&tx, estate.organisation, estate.steward.account)
        .await
        .expect("tenant context");
    let _ = ctx;
    for table in ["sessions", "session_nonces", "sign_in_attempts"] {
        let seen: i64 = tx
            .query_one(&format!("SELECT count(*) FROM {table}"), &[])
            .await
            .expect("count")
            .get(0);
        assert_eq!(
            seen, 0,
            "a tenant transaction read {seen} rows from {table}; a query written wrong on a \
             design path must not reach a token hash, a nonce or a session public key"
        );
    }
    tx.rollback().await.expect("rollback");
}

fn lp(out: &mut Vec<u8>, field: &[u8]) {
    out.extend_from_slice(&(field.len() as u32).to_le_bytes());
    out.extend_from_slice(field);
}

fn read_lp(bytes: &[u8]) -> (&[u8], &[u8]) {
    let len = u32::from_le_bytes(bytes[..4].try_into().unwrap()) as usize;
    (&bytes[4..4 + len], &bytes[4 + len..])
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

// ---------------------------------------------------------------------------
// `0014` — the numbers a client chooses
// ---------------------------------------------------------------------------

/// **A header does not panic the request task.**
///
/// `fathom-timestamp: -9223372036854775808` parses cleanly as an `i64` and
/// used to reach `(now * 1000 - unix_ms).abs() / 1000`. The server profile sets
/// `overflow-checks = true`, so the subtraction is `attempt to subtract with
/// overflow`, and `.abs()` on `i64::MIN` panics on the same line for a second
/// reason. Reachable with a stolen bearer token, which the design says buys
/// nothing.
///
/// Driven through the real HTTP surface as well as the store, because the
/// header is where the value comes from and `api.rs` is what parses it.
#[tokio::test]
async fn a_client_timestamp_at_the_edges_of_i64_is_refused_and_does_not_panic() {
    let _site = support::lock_the_site_chain().await;
    let pool = support::migrated_pool().await;
    let ring = ring();
    let estate = bootstrap(&pool, &ring).await;
    let store = store(&pool, Arc::clone(&ring)).await;
    let (signed_in, session_key) = sign_in(&store, &estate.steward).await;

    for unix_ms in [i64::MIN, i64::MIN + 1, -1, i64::MAX, i64::MAX - 1] {
        let nonce = store
            .issue_request_nonce(&signed_in.session_id, &signed_in.token)
            .await
            .expect("a nonce");
        let counter = next_counter(&signed_in.session_id).await;
        let message = sessions::request_bytes(
            &signed_in.session_id,
            "GET",
            "/x",
            &sessions::body_digest(b""),
            &nonce,
            unix_ms,
            counter,
        );
        let refused = store
            .verify_request(&SignedRequest {
                session_id: &signed_in.session_id,
                method: "GET",
                path: "/x",
                body: b"",
                nonce,
                unix_ms,
                counter,
                signature: session_key.sign(&message),
            })
            .await;
        assert!(
            matches!(refused, Err(SessionError::Malformed(_))),
            "a timestamp of {unix_ms} must be refused before any arithmetic touches it, got \
             {refused:?}"
        );
    }

    // And the session is unharmed: the refusals cost it nothing but its nonces.
    let call = a_call(&store, &signed_in, &session_key, "GET", "/x", b"").await;
    store
        .verify_request(&as_request(&call, "GET", "/x", b""))
        .await
        .expect("an honest request still verifies");
}

/// The same value, arriving the way it actually would: as a header, over a
/// socket, into the extractor.
#[tokio::test]
async fn the_timestamp_header_at_i64_min_answers_rather_than_dropping_the_connection() {
    let _site = support::lock_the_site_chain().await;
    let pool = support::migrated_pool().await;
    let ring = ring();
    let estate = bootstrap(&pool, &ring).await;
    let state = ApiState {
        sessions: Arc::new(store(&pool, Arc::clone(&ring)).await),
        watch: Arc::new(EpochWatch::new()),
        ring: Arc::clone(&ring),
        client_address: ClientAddress::peer(),
    };
    let addr = serve(api::router(state)).await;

    let path = format!("/organisations/{}/capability", estate.organisation);
    let (status, _) = raw_request(
        addr,
        "GET",
        &path,
        &[
            (HEADER_SESSION, "01JQZ0000000000000000000AA".to_string()),
            (HEADER_NONCE, hex(&[0u8; 32])),
            (HEADER_TIMESTAMP, i64::MIN.to_string()),
            (HEADER_COUNTER, "1".to_string()),
            (HEADER_SIGNATURE, hex(&[0u8; 64])),
        ],
        b"",
    )
    .await;
    assert_eq!(
        status, "400",
        "a timestamp outside the range a wall clock can produce is a malformed request, and the \
         one thing it must not be is a panicked task"
    );

    // The router is still serving, which is the whole claim: with
    // `panic = \"unwind\"` a panicked task takes one request down, and this
    // asserts the next one is still answered.
    let (status, _) = raw_request(addr, "GET", &path, &[], b"").await;
    assert_eq!(status, "401");
}

/// **A client-chosen counter cannot brick a session.**
///
/// `request_counter` is stored as `GREATEST(request_counter, $counter)`, so one
/// signed request carrying `i64::MAX` set the mark to `i64::MAX` and no later
/// nonce could ever satisfy `counter > issued_counter` again. The session was
/// dead for the rest of its twelve hours.
#[tokio::test]
async fn a_counter_past_the_window_is_refused_and_the_session_still_works() {
    let _site = support::lock_the_site_chain().await;
    let pool = support::migrated_pool().await;
    let ring = ring();
    let estate = bootstrap(&pool, &ring).await;
    let store = store(&pool, Arc::clone(&ring)).await;
    let (signed_in, session_key) = sign_in(&store, &estate.steward).await;

    for counter in [i64::MAX, sessions::COUNTER_WINDOW + 1, -1, 0] {
        let nonce = store
            .issue_request_nonce(&signed_in.session_id, &signed_in.token)
            .await
            .expect("a nonce");
        let unix_ms = now_ms();
        let message = sessions::request_bytes(
            &signed_in.session_id,
            "GET",
            "/x",
            &sessions::body_digest(b""),
            &nonce,
            unix_ms,
            counter,
        );
        let refused = store
            .verify_request(&SignedRequest {
                session_id: &signed_in.session_id,
                method: "GET",
                path: "/x",
                body: b"",
                nonce,
                unix_ms,
                counter,
                signature: session_key.sign(&message),
            })
            .await;
        assert!(
            matches!(refused, Err(SessionError::CounterNotFresh)),
            "a counter of {counter} is not the next one and must be refused, got {refused:?}"
        );
    }

    let stored: i64 = support::superuser_client_on_test_database()
        .await
        .query_one(
            "SELECT request_counter FROM sessions WHERE id = $1",
            &[&signed_in.session_id],
        )
        .await
        .expect("the session row")
        .get(0);
    assert_eq!(
        stored, 0,
        "a refused counter is not stored, so the mark is still where the session left it"
    );

    // The session is still usable, which is the half a bound on the counter
    // exists for.
    let call = a_call(&store, &signed_in, &session_key, "GET", "/x", b"").await;
    store
        .verify_request(&as_request(&call, "GET", "/x", b""))
        .await
        .expect("the session survives a client that lost count");
}

/// The top of the window is accepted, so the bound does not break the case it
/// exists to permit: a browser with several requests in flight against one
/// mark, each picking the next value of its own tally.
#[tokio::test]
async fn several_requests_in_flight_against_one_mark_are_all_accepted() {
    let _site = support::lock_the_site_chain().await;
    let pool = support::migrated_pool().await;
    let ring = ring();
    let estate = bootstrap(&pool, &ring).await;
    let store = store(&pool, Arc::clone(&ring)).await;
    let (signed_in, session_key) = sign_in(&store, &estate.steward).await;

    // Four nonces taken before any of them is spent: all four carry the same
    // `issued_counter`, which is the shape `0013` §B says must keep working.
    let mut nonces = Vec::new();
    for _ in 0..4 {
        nonces.push(
            store
                .issue_request_nonce(&signed_in.session_id, &signed_in.token)
                .await
                .expect("a nonce"),
        );
    }
    for (n, nonce) in nonces.into_iter().enumerate() {
        let counter = n as i64 + 1;
        let unix_ms = now_ms();
        let message = sessions::request_bytes(
            &signed_in.session_id,
            "GET",
            "/x",
            &sessions::body_digest(b""),
            &nonce,
            unix_ms,
            counter,
        );
        store
            .verify_request(&SignedRequest {
                session_id: &signed_in.session_id,
                method: "GET",
                path: "/x",
                body: b"",
                nonce,
                unix_ms,
                counter,
                signature: session_key.sign(&message),
            })
            .await
            .unwrap_or_else(|e| panic!("request {} of four in flight was refused: {e:?}", n + 1));
    }
}

// ---------------------------------------------------------------------------
// `0014` §D — sign-out is recorded, not only performed
// ---------------------------------------------------------------------------

/// **A signed-out session row restored from a backup does not come back to
/// life.**
///
/// `0013` argued that *"a deleted row cannot be resurrected without the site
/// row key, which is not in PostgreSQL"*. That is true of minting a row and
/// false of restoring one: the row MAC covers the row's own fields, none of
/// which changes when a session is signed out, so last night's bytes verify
/// for ever.
///
/// The restore is performed **as the bootstrap superuser**, with every column
/// copied verbatim from before the sign-out, because the claim is about bytes
/// that are genuinely the server's own and not about a forgery.
#[tokio::test]
async fn a_signed_out_session_restored_from_a_backup_is_refused() {
    let _site = support::lock_the_site_chain().await;
    let pool = support::migrated_pool().await;
    let ring = ring();
    let estate = bootstrap(&pool, &ring).await;
    let store = store(&pool, Arc::clone(&ring)).await;
    let (signed_in, session_key) = sign_in(&store, &estate.steward).await;

    let superuser = support::superuser_client_on_test_database().await;
    let backup = superuser
        .query_one(
            "SELECT principal_id, principal_kind, token_hash, session_pubkey, session_alg, \
                    bound_nonce, evidence_key_id, evidence_sig, assertion_digest, assurance, \
                    chain_seq, issued_at, last_seen_at, expires_at, row_version, row_mac \
               FROM sessions WHERE id = $1",
            &[&signed_in.session_id],
        )
        .await
        .expect("last night's backup holds the row");

    let call = a_call(&store, &signed_in, &session_key, "DELETE", "/session", b"").await;
    let verified = store
        .verify_request(&as_request(&call, "DELETE", "/session", b""))
        .await
        .expect("the sign-out request is itself signed");
    store.sign_out(&verified).await.expect("sign out");

    // The sign-out is on the site chain and the revocation row names its seq,
    // so stopping the log stops the act here as it does for sign-in.
    let seq: i64 = superuser
        .query_one(
            "SELECT chain_seq FROM session_revocations WHERE session_id = $1",
            &[&signed_in.session_id],
        )
        .await
        .expect("the revocation row")
        .get(0);
    let entry: String = superuser
        .query_one(
            "SELECT entry_type FROM chain_entries WHERE chain_kind = 'site' AND seq = $1",
            &[&seq],
        )
        .await
        .expect("the entry the row names")
        .get(0);
    assert_eq!(entry, "account_signed_out");

    superuser
        .execute(
            "INSERT INTO sessions (id, principal_id, principal_kind, token_hash, session_pubkey, \
                 session_alg, bound_nonce, evidence_key_id, evidence_sig, assertion_digest, \
                 assurance, chain_seq, issued_at, last_seen_at, expires_at, row_version, row_mac) \
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)",
            &[
                &signed_in.session_id,
                &backup.get::<_, String>(0),
                &backup.get::<_, String>(1),
                &backup.get::<_, Vec<u8>>(2),
                &backup.get::<_, Vec<u8>>(3),
                &backup.get::<_, i16>(4),
                &backup.get::<_, Vec<u8>>(5),
                &backup.get::<_, Option<String>>(6),
                &backup.get::<_, Option<Vec<u8>>>(7),
                &backup.get::<_, Option<Vec<u8>>>(8),
                &backup.get::<_, String>(9),
                &backup.get::<_, i64>(10),
                &backup.get::<_, std::time::SystemTime>(11),
                &backup.get::<_, std::time::SystemTime>(12),
                &backup.get::<_, std::time::SystemTime>(13),
                &backup.get::<_, i32>(14),
                &backup.get::<_, Vec<u8>>(15),
            ],
        )
        .await
        .expect("a tier-3 attacker restores one row; that is the premise, not the failure");

    // Even a nonce minted alongside it, so the refusal cannot be blamed on the
    // attacker having nothing to present.
    superuser
        .execute(
            "INSERT INTO session_nonces (nonce, purpose, session_id, issued_counter, expires_at) \
             VALUES ($1, 'request', $2, 0, now() + interval '1 hour')",
            &[&vec![11u8; 32], &signed_in.session_id],
        )
        .await
        .expect("insert the nonce");

    let nonce = [11u8; 32];
    let unix_ms = now_ms();
    let message = sessions::request_bytes(
        &signed_in.session_id,
        "GET",
        "/x",
        &sessions::body_digest(b""),
        &nonce,
        unix_ms,
        1,
    );
    let refused = store
        .verify_request(&SignedRequest {
            session_id: &signed_in.session_id,
            method: "GET",
            path: "/x",
            body: b"",
            nonce,
            unix_ms,
            counter: 1,
            signature: session_key.sign(&message),
        })
        .await;
    assert!(
        matches!(refused, Err(SessionError::SessionRevoked)),
        "a session recorded as signed out must be refused whatever a restore puts back, got \
         {refused:?}"
    );

    // And the record is append-only to the runtime role at the privilege
    // layer, which is the second statement of the same rule.
    let client = pool.get().await.expect("connection");
    for verb in ["UPDATE", "DELETE"] {
        let may: bool = client
            .query_one(
                "SELECT has_table_privilege('fathom_app', 'session_revocations', $1)",
                &[&verb],
            )
            .await
            .expect("privilege")
            .get(0);
        assert!(
            !may,
            "the runtime role may {verb} a revocation, so recording one is one statement from \
             being un-recorded again"
        );
    }

    superuser
        .execute(
            "DELETE FROM sessions WHERE id = $1",
            &[&signed_in.session_id],
        )
        .await
        .expect("clean up");
}

// ---------------------------------------------------------------------------
// `0014`, finding 8 — one transaction across verification and authorisation
// ---------------------------------------------------------------------------

/// **Verification and authorisation share one transaction**, so the
/// disabled-account check, the evidence-key check and grant evaluation share a
/// snapshot.
///
/// The type system carries the claim once the shape is right — a handler can
/// only reach `verify_pending` with a transaction in its hand — so this reads
/// the surface's own source for the two things that would undo it: a second
/// `client.transaction()` inside `capability`, and a `verify_request` call on
/// a route that goes on to authorise.
#[test]
fn the_protected_routes_verify_and_authorise_in_one_transaction() {
    let source = include_str!("../src/api.rs");
    let code: String = source
        .lines()
        .filter(|line| !line.trim_start().starts_with("//"))
        .collect::<Vec<_>>()
        .join("\n");
    assert!(
        !code.contains("verify_request"),
        "src/api.rs calls `verify_request`, which opens and commits a transaction of its own. A \
         route that then authorises does so against a second snapshot, which is the defect \
         `0014` closed"
    );
    assert!(
        code.contains("signed.verify(&state, &tx)"),
        "the surface must verify through the path that takes the handler's own transaction, or \
         the rule above has nothing behind it"
    );
}

/// The same claim against the database rather than the source: an account
/// disabled **after** its session's nonce was issued is refused at the route,
/// on the same snapshot the authorisation would have run on.
#[tokio::test]
async fn an_account_disabled_before_the_request_arrives_is_refused_by_the_route() {
    let _site = support::lock_the_site_chain().await;
    let pool = support::migrated_pool().await;
    let ring = ring();
    let estate = bootstrap(&pool, &ring).await;
    let store = store(&pool, Arc::clone(&ring)).await;
    let (signed_in, session_key) = sign_in(&store, &estate.steward).await;

    let state = ApiState {
        sessions: Arc::new(SessionStore::new(
            pool.clone(),
            Arc::clone(&ring),
            store.deployment().to_string(),
            SignInLimits::defaults(),
        )),
        watch: Arc::new(EpochWatch::new()),
        ring: Arc::clone(&ring),
        client_address: ClientAddress::peer(),
    };
    let addr = serve(api::router(state)).await;
    let path = format!("/organisations/{}/capability", estate.organisation);

    // The nonce is taken first, so the disabling happens strictly between the
    // two halves of what used to be two transactions.
    let nonce = store
        .issue_request_nonce(&signed_in.session_id, &signed_in.token)
        .await
        .expect("a nonce");

    store
        .set_account_disabled(&estate.steward.account.to_string(), true)
        .await
        .expect("disable the account");

    let unix_ms = now_ms();
    let counter = next_counter(&signed_in.session_id).await;
    let message = sessions::request_bytes(
        &signed_in.session_id,
        "GET",
        &path,
        &sessions::body_digest(b""),
        &nonce,
        unix_ms,
        counter,
    );
    let (status, _) = raw_request(
        addr,
        "GET",
        &path,
        &[
            (HEADER_SESSION, signed_in.session_id.clone()),
            (HEADER_NONCE, hex(&nonce)),
            (HEADER_TIMESTAMP, unix_ms.to_string()),
            (HEADER_COUNTER, counter.to_string()),
            (HEADER_SIGNATURE, hex(&session_key.sign(&message))),
        ],
        b"",
    )
    .await;
    assert_eq!(
        status, "401",
        "the disabled-account check and the authorisation it gates now run on one snapshot, so a \
         disabled account is refused at the route rather than authorised beside a check that \
         already committed"
    );
}

// ---------------------------------------------------------------------------
// ADR-0055 fix (S1) — what the 2026-09-21 checker found in sessions and the API
// ---------------------------------------------------------------------------
//
// Six findings, six claims, six tests that failed before the fix beside them.
// Each is written the way CLAUDE.md rule 2 asks: **real inputs.** A genuine
// six-digit code computed from the enrolled secret at the step the clock is
// actually in; a real four-word passphrase of the length a person types;
// concurrency where the finding is about concurrency, run on a multi-threaded
// runtime because a current-thread one proves something weaker while looking
// identical.
//
// **These tests get a deployment of their own**, tag `sess`, for the reason
// `tests/credentials.rs` gives for its: they bind an account to an operator,
// they count rows of a table other suites share, and the shared test database
// is one deployment several binaries write to.

/// This section's own database: `fathom_isolated_sess`.
const ADR55_TAG: &str = "sess";

static ADR55_DEPLOYMENT: tokio::sync::OnceCell<Pool> = tokio::sync::OnceCell::const_new();

/// One of these tests at a time. The timing test below measures argon2id, and
/// two of them running at once on the same machine measure each other.
static ADR55_SERIAL: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// **A real password**: four words, twenty-seven characters, the shape a
/// password manager's generator and the XKCD advice both produce. Not fifteen
/// `a`s and not a string built to satisfy the check.
const ADR55_PASSWORD: &str = "harbour-lantern-copper-nine";

/// A second real one, wrong for every account here, for the refusals.
const ADR55_WRONG_PASSWORD: &str = "orchard-thimble-marble-four";

async fn adr55_deployment() -> Pool {
    ADR55_DEPLOYMENT
        .get_or_init(|| async {
            let pool = support::isolated_deployment(ADR55_TAG).await;
            let client = pool.get().await.expect("connection");
            chains::register_deployment(&**client)
                .await
                .expect("stamp the deployment id, exactly as main.rs does at startup");
            pool.clone()
        })
        .await
        .clone()
}

async fn adr55_superuser() -> tokio_postgres::Client {
    support::superuser_on_isolated(ADR55_TAG).await
}

async fn adr55_store(pool: &Pool, ring: Arc<KeyRing>, limits: SignInLimits) -> SessionStore {
    let client = pool.get().await.expect("connection");
    let deployment = chains::deployment_id(&**client)
        .await
        .expect("this deployment is stamped at startup");
    SessionStore::new(pool.clone(), ring, deployment, limits)
}

async fn adr55_credentials(pool: &Pool, ring: Arc<KeyRing>) -> CredentialStore {
    let client = pool.get().await.expect("connection");
    let deployment = chains::deployment_id(&**client)
        .await
        .expect("this deployment is stamped at startup");
    CredentialStore::new(pool.clone(), ring, deployment)
}

async fn adr55_operators(pool: &Pool, ring: Arc<KeyRing>) -> OperatorStore {
    let client = pool.get().await.expect("connection");
    let deployment = chains::deployment_id(&**client)
        .await
        .expect("this deployment is stamped at startup");
    OperatorStore::with_delay(pool.clone(), ring, deployment, Duration::from_secs(1))
}

async fn adr55_account(pool: &Pool, name: &str) -> Person {
    let address = unique(name);
    let account = repo::create_account(pool, &address, name)
        .await
        .expect("create account")
        .id;
    Person {
        account,
        address,
        key: SoftwareKey::random().expect("a keypair"),
    }
}

/// Set a password with no session, the way `/enrolment/operator/setup` and
/// `/credentials/reset/redeem` do — only ever to bootstrap a fixture into the
/// state a test is actually about.
async fn adr55_set_password(pool: &Pool, person: &Person, password: &str) {
    let hash = credentials::hash_password(password).expect("hash");
    let mut client = pool.get().await.expect("connection");
    let tx = client.transaction().await.expect("begin");
    tx.execute("SELECT set_config('app.reset_custody', 'yes', true)", &[])
        .await
        .expect("reset custody");
    // Migration 0025 §B: a row image that carries a credential and no seal is
    // refused at commit whichever statement left it behind, so a FIRST
    // credential and its seal go into the table in ONE statement — the shape
    // `credentials::seal_for_write` documents and `set_password` takes.
    let account = person.account.to_string();
    let mut next = credentials::read_credentials(&tx, &ring(), &account)
        .await
        .expect("read the row")
        .expect("the account exists");
    next.password_hash = Some(hash.clone());
    let seal = credentials::seal_for_write(&tx, &ring(), &account, &mut next, None)
        .await
        .expect("seal the credential");
    tx.execute(
        "UPDATE accounts SET password_hash = $2, credential_seal = $3, \
                credential_row_version = $4, credential_seq = $5 \
          WHERE id = $1",
        &[
            &account,
            &hash,
            &seal,
            &next.credential_row_version,
            &next.seq_column(),
        ],
    )
    .await
    .expect("set the credential");
    tx.commit().await.expect("commit");
}

/// Sign in with a credential and whatever second factor is handed over, and
/// optionally with an evidence signature by a key the account has enrolled.
async fn adr55_sign_in(
    store: &SessionStore,
    address: &str,
    password: &str,
    code: &str,
    evidence: Option<&SoftwareKey>,
) -> Result<(SignedIn, SoftwareKey), SessionError> {
    let session_key = SoftwareKey::random().expect("a session keypair");
    let pubkey = session_key.public_key();
    let source = a_source_of_its_own();
    let challenge = store
        .issue_challenge(PrincipalKind::Steward, address, &pubkey, &source)
        .await?;
    let signature = evidence.map(|key| {
        key.sign(&sessions::session_challenge(
            &pubkey,
            &challenge.nonce,
            &challenge.deployment_id,
        ))
    });
    let signed_in = store
        .sign_in_with_credentials(&SignInAttempt {
            kind: PrincipalKind::Steward,
            session_pubkey: &pubkey,
            nonce: &challenge.nonce,
            evidence_sig: signature.as_ref().map(|s| &s[..]).unwrap_or(b""),
            password,
            totp_code: code,
            source: &source,
        })
        .await?;
    Ok((signed_in, session_key))
}

async fn adr55_next_counter(session_id: &str) -> i64 {
    let mark: i64 = adr55_superuser()
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

async fn adr55_try_verify(
    store: &SessionStore,
    signed_in: &SignedIn,
    session_key: &SoftwareKey,
    method: &str,
    path: &str,
) -> Result<VerifiedSession, SessionError> {
    let nonce = store
        .issue_request_nonce(&signed_in.session_id, &signed_in.token)
        .await?;
    let counter = adr55_next_counter(&signed_in.session_id).await;
    let unix_ms = now_ms();
    let message = sessions::request_bytes(
        &signed_in.session_id,
        method,
        path,
        &sessions::body_digest(b""),
        &nonce,
        unix_ms,
        counter,
    );
    store
        .verify_request(&SignedRequest {
            session_id: &signed_in.session_id,
            method,
            path,
            body: b"",
            nonce,
            unix_ms,
            counter,
            signature: session_key.sign(&message),
        })
        .await
}

async fn adr55_assurance_of(session_id: &str) -> String {
    adr55_superuser()
        .await
        .query_one(
            "SELECT assurance FROM sessions WHERE id = $1",
            &[&session_id],
        )
        .await
        .expect("the session row")
        .get(0)
}

/// The secret this account's app code is computed from, opened as the server
/// opens it — because what these tests present is what a real authenticator
/// would be showing.
async fn adr55_totp_secret(pool: &Pool, ring: &KeyRing, account: &str) -> Vec<u8> {
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
    let row = credentials::read_credentials(&tx, ring, account)
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

/// A code at a step that has not been spent yet.
///
/// `totp_last_step` refuses a code at or below the last accepted step, and
/// confirming the enrolment spends one — so a test that signs in afterwards
/// waits for the step to turn over. The wait is the replay refusal doing its
/// job.
async fn adr55_a_fresh_code(secret: &[u8]) -> String {
    let step = credentials::totp_step(now_unix());
    loop {
        let now = now_unix();
        if credentials::totp_step(now) > step {
            return credentials::totp_code(secret, credentials::totp_step(now));
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
}

struct Adr55Enrolled {
    person: Person,
    secret: Vec<u8>,
}

/// An account with a credential and a **confirmed** app code, built the way
/// the product builds one: set the credential, sign in, enrol, confirm with a
/// real six-digit code.
async fn adr55_enrolled(
    pool: &Pool,
    ring: &Arc<KeyRing>,
    sessions: &SessionStore,
    creds: &CredentialStore,
    name: &str,
) -> Adr55Enrolled {
    let person = adr55_account(pool, name).await;
    adr55_set_password(pool, &person, ADR55_PASSWORD).await;

    let (signed_in, session_key) =
        adr55_sign_in(sessions, &person.address, ADR55_PASSWORD, "", None)
            .await
            .expect("a steward with a credential and no app code signs in");

    let session = adr55_try_verify(
        sessions,
        &signed_in,
        &session_key,
        "POST",
        "/credentials/totp/enrol",
    )
    .await
    .expect("a live session verifies its own signed request");
    creds.enrol_totp(&session).await.expect("enrol an app code");

    let secret = adr55_totp_secret(pool, ring, &person.account.to_string()).await;
    let session = adr55_try_verify(
        sessions,
        &signed_in,
        &session_key,
        "POST",
        "/credentials/totp/confirm",
    )
    .await
    .expect("a live session verifies its own signed request");
    creds
        .confirm_totp(
            &session,
            &credentials::totp_code(&secret, credentials::totp_step(now_unix())),
        )
        .await
        .expect("a real six-digit code confirms the enrolment");

    Adr55Enrolled { person, secret }
}

/// Create an operator row and bind this account to it.
///
/// **Written as the superuser with a placeholder seal.** Nothing under test
/// here verifies the binding — `credentials::holds_operator_custody` is a
/// membership lookup whose own doc says so, and the authorisation it feeds is
/// a refusal, so a forged binding locks its holder out rather than letting
/// anybody in.
async fn adr55_bind_to_an_operator(person: &Person) -> String {
    let su = adr55_superuser().await;
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

async fn adr55_credential_surface(
    pool: &Pool,
    ring: &Arc<KeyRing>,
    sessions: Arc<SessionStore>,
) -> std::net::SocketAddr {
    let creds = Arc::new(adr55_credentials(pool, Arc::clone(ring)).await);
    let operators = Arc::new(adr55_operators(pool, Arc::clone(ring)).await);
    serve(api::credential_router(CredentialApiState {
        sessions,
        credentials: creds,
        operators,
        client_address: ClientAddress::header("x-forwarded-for"),
    }))
    .await
}

/// One signed `POST` to the credential surface, over a real socket.
///
/// The per-request nonce is drawn in process rather than through
/// `/session/nonce`, which the credential router does not mount; the nonce is
/// not what these tests are about, and the signature over method, path, body
/// digest, nonce, time and counter is assembled exactly as the client does.
async fn adr55_signed_post(
    addr: std::net::SocketAddr,
    store: &SessionStore,
    signed_in: &SignedIn,
    session_key: &SoftwareKey,
    path: &str,
    body: &[u8],
) -> (String, String) {
    let nonce = store
        .issue_request_nonce(&signed_in.session_id, &signed_in.token)
        .await
        .expect("a live session may ask for a nonce");
    let counter = adr55_next_counter(&signed_in.session_id).await;
    let unix_ms = now_ms();
    let message = sessions::request_bytes(
        &signed_in.session_id,
        "POST",
        path,
        &sessions::body_digest(body),
        &nonce,
        unix_ms,
        counter,
    );
    let (status, answer) = raw_request(
        addr,
        "POST",
        path,
        &[
            (HEADER_SESSION, signed_in.session_id.clone()),
            (HEADER_NONCE, hex(&nonce)),
            (HEADER_TIMESTAMP, unix_ms.to_string()),
            (HEADER_COUNTER, counter.to_string()),
            (HEADER_SIGNATURE, hex(&session_key.sign(&message))),
        ],
        body,
    )
    .await;
    (status, String::from_utf8_lossy(&answer).into_owned())
}

fn median(mut xs: Vec<u128>) -> u128 {
    xs.sort_unstable();
    xs[xs.len() / 2]
}

/// **ADR-0055 decision 10's *"a code accepted once"* holds against sign-ins
/// that arrive at the same moment, not only against one that arrives twice.**
///
/// The checker of 2026-09-21 fired three `POST /session` calls together, each
/// from its own source, each carrying the SAME live six-digit code, and got
/// three sessions. `check_second_factor` read the high-water mark with a plain
/// `SELECT`, decided, and only then advanced it, so every attempt in flight
/// decided against the same stale number; what had been masking it was the
/// per-source row lock in `sign_in_attempts`, which serialises attempts from
/// one address and does nothing about three.
///
/// **A multi-threaded runtime, real parallel tasks, and one genuine code.**
/// The code is computed from the enrolled secret at the step the clock is in —
/// what an authenticator would be showing — and every task presents the same
/// characters.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn one_app_code_presented_by_four_sign_ins_at_once_opens_exactly_one_session() {
    let _serial = ADR55_SERIAL.lock().await;
    let pool = adr55_deployment().await;
    let ring = ring();
    let store = Arc::new(adr55_store(&pool, Arc::clone(&ring), SignInLimits::defaults()).await);
    let creds = adr55_credentials(&pool, Arc::clone(&ring)).await;
    let enrolled = adr55_enrolled(&pool, &ring, &store, &creds, "at-once").await;

    // A step the enrolment has not already spent.
    let code = adr55_a_fresh_code(&enrolled.secret).await;

    // Four challenges, drawn one after another, so that nothing in the race
    // below is waiting on the challenge route. Four different sources, because
    // the shared per-source row was the accidental lock that hid this.
    let mut prepared = Vec::new();
    for _ in 0..4 {
        let session_key = SoftwareKey::random().expect("a session keypair");
        let pubkey = session_key.public_key();
        let source = a_source_of_its_own();
        let challenge = store
            .issue_challenge(
                PrincipalKind::Steward,
                &enrolled.person.address,
                &pubkey,
                &source,
            )
            .await
            .expect("a challenge");
        prepared.push((pubkey, challenge.nonce, source));
    }

    let mut running = Vec::new();
    for (pubkey, nonce, source) in prepared {
        let store = Arc::clone(&store);
        let code = code.clone();
        running.push(tokio::spawn(async move {
            store
                .sign_in_with_credentials(&SignInAttempt {
                    kind: PrincipalKind::Steward,
                    session_pubkey: &pubkey,
                    nonce: &nonce,
                    evidence_sig: b"",
                    password: ADR55_PASSWORD,
                    totp_code: &code,
                    source: &source,
                })
                .await
        }));
    }

    let mut opened = 0;
    let mut refused = 0;
    for task in running {
        match task.await.expect("the task did not panic") {
            Ok(_) => opened += 1,
            Err(SessionError::PasswordRefused) => refused += 1,
            Err(other) => panic!(
                "a second sign-in on a spent code must be the uniform credential refusal, not \
                 {other:?}"
            ),
        }
    }

    assert_eq!(
        (opened, refused),
        (1, 3),
        "four sign-ins presenting ONE six-digit code opened {opened} sessions and were refused \
         {refused} times. ADR-0055 decision 10 says a code is accepted once, and an \
         adversary-in-the-middle relaying a victim's live code submits in parallel precisely so \
         that the victim's own sign-in still succeeds and nothing looks wrong"
    );

    // Read off the table, not off the return values. `A0T` is `0018` §B2's
    // "a credential and a verified app code" and is the assurance exactly one
    // of these four can honestly have; the fixture's own enrolment session is
    // `A0` and is not counted, because it never presented a code.
    let opened_by_a_code: i64 = adr55_superuser()
        .await
        .query_one(
            "SELECT count(*) FROM sessions WHERE principal_id = $1 AND assurance = 'A0T'",
            &[&enrolled.person.account.to_string()],
        )
        .await
        .expect("count sessions")
        .get(0);
    assert_eq!(
        opened_by_a_code, 1,
        "one code, one session row that says a code made it"
    );
}

/// **A known address and an unknown one are refused in the same time, not only
/// with the same words.**
///
/// OWASP ASVS 5.0.0 6.3.8, which ADR-0055 quotes and this suite's fixtures were
/// read against on 2026-09-21: *"no account enumeration through messages, codes
/// or timing."* The checker measured this deployment at a median 498.7 ms for a
/// known address against 5.9 ms for an unknown one — 85 to 1, no statistics
/// needed — because the argon2id verification ran only when there was a stored
/// hash to run it against.
///
/// # The tolerance, and why it is this one
///
/// One argon2id at `m=19456, t=2` is hundreds of milliseconds in a debug build
/// and tens in a release one; the database work that differs between the two
/// branches — one row read, a keyring lookup — is single-figure milliseconds
/// on either. So the honest assertion is that **neither median is more than
/// twice the other**: a factor of two is far more than the residue can
/// account for and far less than the 85 the oracle was worth, and it leaves
/// room for a scheduler on a shared runner. The probes are interleaved so that
/// any load hits both sides alike, and both medians are also required to be
/// large enough that the test is not two fast paths agreeing about nothing.
#[tokio::test]
async fn a_credential_refused_for_an_unknown_address_costs_the_same_time_as_one_for_a_known_one() {
    let _serial = ADR55_SERIAL.lock().await;
    let pool = adr55_deployment().await;
    let ring = ring();
    // The account cap is put out of the way: this test is about the clock, and
    // a `429` at the eleventh probe would be a different path being timed.
    let store = adr55_store(
        &pool,
        Arc::clone(&ring),
        SignInLimits {
            window: Duration::from_secs(900),
            max_per_account: 1_000_000,
            max_per_source: 1_000_000,
        },
    )
    .await;

    let person = adr55_account(&pool, "known").await;
    adr55_set_password(&pool, &person, ADR55_PASSWORD).await;
    let nobody = unique("nobody");

    let probe = |address: String| {
        let store = &store;
        async move {
            let started = std::time::Instant::now();
            let outcome = adr55_sign_in(store, &address, ADR55_WRONG_PASSWORD, "", None).await;
            let elapsed = started.elapsed().as_micros();
            (outcome, elapsed)
        }
    };

    // One of each first, uncounted: the first argon2id of a process pays for
    // whatever the allocator has not done yet.
    let _ = probe(person.address.clone()).await;
    let _ = probe(nobody.clone()).await;

    let mut known = Vec::new();
    let mut unknown = Vec::new();
    for _ in 0..7 {
        let (outcome, took) = probe(person.address.clone()).await;
        assert!(
            matches!(outcome, Err(SessionError::PasswordRefused)),
            "a wrong credential for a known address is the uniform refusal"
        );
        known.push(took);

        let (outcome, took) = probe(nobody.clone()).await;
        assert!(
            matches!(outcome, Err(SessionError::SignInRefused)),
            "an address that belongs to nobody is the uniform refusal"
        );
        unknown.push(took);
    }

    let (a, b) = (median(known.clone()), median(unknown.clone()));
    let (low, high) = (a.min(b), a.max(b));
    assert!(
        low >= 5_000,
        "the medians are {a} µs (known) and {b} µs (unknown): both are too small for an argon2id \
         to have happened on either side, so this test would pass on a build that does no work \
         at all. known={known:?} unknown={unknown:?}"
    );
    assert!(
        high <= low * 2,
        "a wrong credential for a known address took a median {a} µs and one for an address that \
         belongs to nobody took {b} µs. OWASP ASVS 5.0.0 6.3.8 asks for no enumeration through \
         timing, and a caller who can tell those apart holds a list of this deployment's people. \
         known={known:?} unknown={unknown:?}"
    );
}

/// **The setup rule is about the ACCOUNT, not about how strong the session
/// is.**
///
/// ADR-0055 decision 10: an app code is *Required for any account holding the
/// operator custody*, and *"such an account is taken to the enrolment screen
/// before anything else until it has one"*. The gate was written as
/// `assurance == A0`, so the same person signing in with a credential **and a
/// browser key** got `A1` and walked straight past it — and the checker of
/// 2026-09-21 rode that all the way to `POST /admin/operators/self/key`, which
/// registers the key every operator act is signed with, having never enrolled
/// a code.
///
/// The state needs no database access to reach and no unusual order: register
/// a browser key as an ordinary steward, then be promoted. That is the order
/// below.
#[tokio::test]
async fn an_account_holding_the_operator_custody_with_no_app_code_is_a_setup_session_at_a1_too() {
    let _serial = ADR55_SERIAL.lock().await;
    let pool = adr55_deployment().await;
    let ring = ring();
    let store = adr55_store(&pool, Arc::clone(&ring), SignInLimits::defaults()).await;
    let creds = adr55_credentials(&pool, Arc::clone(&ring)).await;

    // An ordinary steward with a credential, no app code and no custody.
    let person = adr55_account(&pool, "promoted").await;
    adr55_set_password(&pool, &person, ADR55_PASSWORD).await;
    let browser = SoftwareKey::random().expect("a browser keypair");

    let (signed_in, session_key) = adr55_sign_in(&store, &person.address, ADR55_PASSWORD, "", None)
        .await
        .expect("a steward with a credential and no app code signs in");
    let session = adr55_try_verify(&store, &signed_in, &session_key, "POST", "/credentials/key")
        .await
        .expect("a live session verifies its own signed request");
    creds
        .register_key(&session, &browser.public_key())
        .await
        .expect("an ordinary steward may register this browser's key");

    // Now promoted: the account is bound to an operator. `operators.rs` USES
    // an account that already exists at the address rather than making a
    // second one, so this is the state the product itself produces.
    adr55_bind_to_an_operator(&person).await;

    // And the sign-in that used to escape the rule: the credential AND the key.
    let (signed_in, session_key) =
        adr55_sign_in(&store, &person.address, ADR55_PASSWORD, "", Some(&browser))
            .await
            .expect(
                "the key is live, so this sign-in succeeds — the refusal is at the next request",
            );
    assert_eq!(
        adr55_assurance_of(&signed_in.session_id).await,
        "A1",
        "the session really is the strong one, or this test is not about the hole it is named for"
    );

    let refused = adr55_try_verify(
        &store,
        &signed_in,
        &session_key,
        "GET",
        "/organisations/01JQZ0000000000000000000AA/capability",
    )
    .await;
    assert!(
        matches!(refused, Err(SessionError::TotpRequired)),
        "an A1 session on an account that holds the operator custody and has no app code reached \
         a route that is not `/credentials/*` and was answered {refused:?}. A second factor that \
         a stronger first factor turns off is not a second factor"
    );

    // And the way out is open, or the rule is a lockout rather than a gate.
    adr55_try_verify(
        &store,
        &signed_in,
        &session_key,
        "POST",
        "/credentials/totp/enrol",
    )
    .await
    .expect("the enrolment screen is exactly what a setup session may reach");
}

/// **`POST /credentials/reset` has a budget per address, and spending it
/// changes nothing a caller can see.**
///
/// ADR-0055 decision 7 asks for *"per-account and per-source rate limits that
/// already exist"* and `0018` §D describes the bucket by name — `sign_in_attempts`
/// under a `reset:` prefix. Only the source bucket was spent: the checker of
/// 2026-09-21 sent ten requests for one address from one source and found ten
/// simultaneously live 24-hour tokens for one person and ten sealed entries,
/// with a distributed caller unbounded per victim.
///
/// The cap here is three rather than the default ten because the shape is what
/// is under test and not the number.
#[tokio::test]
async fn ten_resets_for_one_address_mint_tokens_only_up_to_its_own_cap_and_all_answer_alike() {
    let _serial = ADR55_SERIAL.lock().await;
    let pool = adr55_deployment().await;
    let ring = ring();
    let store = Arc::new(
        adr55_store(
            &pool,
            Arc::clone(&ring),
            SignInLimits {
                window: Duration::from_secs(900),
                max_per_account: 3,
                max_per_source: 1_000_000,
            },
        )
        .await,
    );
    let addr = adr55_credential_surface(&pool, &ring, Arc::clone(&store)).await;

    let person = adr55_account(&pool, "flooded").await;
    let nobody = unique("nobody");
    let source = a_source_of_its_own();

    let mut answers = Vec::new();
    for address in [person.address.clone(), nobody.clone()] {
        for _ in 0..10 {
            let mut body = Vec::new();
            lp(&mut body, address.as_bytes());
            let (status, answer, headers) = post_bytes_full(
                addr,
                "/credentials/reset",
                &body,
                &[("x-forwarded-for", source.clone())],
            )
            .await;
            answers.push((address.clone(), status, normalise(&headers), answer));
        }
    }

    let first = answers.first().expect("ten of each").clone();
    for (address, status, headers, answer) in &answers {
        assert_eq!(
            (status, headers, answer),
            (&first.1, &first.2, &first.3),
            "the reset route answered differently for {address}: over the cap and under it, for \
             an address that belongs to somebody and one that belongs to nobody, decision 7 asks \
             for one answer. A 429 here would say 'this address has asked recently', which is the \
             enumeration the uniform 200 exists to prevent"
        );
        assert_eq!(status, "200", "and that one answer is 200");
    }

    let minted: i64 = adr55_superuser()
        .await
        .query_one(
            "SELECT count(*) FROM password_reset_tokens WHERE account_id = $1",
            &[&person.account.to_string()],
        )
        .await
        .expect("count tokens")
        .get(0);
    assert_eq!(
        minted, 3,
        "ten requests for one address minted {minted} live tokens against a cap of three. Once \
         stream 5 mails these links that is a mail-bomb at a named person; today it is an \
         unauthenticated caller choosing how fast the sealed audit grows"
    );
}

/// **A person told why their password was refused.**
///
/// `credentials.rs`'s header rule 4 — *"no refusal explains which check it
/// failed, except the password policy"* — and the arm in `api.rs` that renders
/// the four policy sentences. The checker of 2026-09-21 found that arm
/// unreachable from every route: the handlers returned `Refusal`, and the
/// `From` impl on the way there folded all four into
/// `SessionError::Malformed` → `400 malformed request`. A person told that
/// retries with something shorter, not with something better.
#[tokio::test]
async fn a_credential_refused_by_the_policy_says_which_rule_it_broke() {
    let _serial = ADR55_SERIAL.lock().await;
    let pool = adr55_deployment().await;
    let ring = ring();
    let store = Arc::new(adr55_store(&pool, Arc::clone(&ring), SignInLimits::defaults()).await);
    let addr = adr55_credential_surface(&pool, &ring, Arc::clone(&store)).await;

    let person = adr55_account(&pool, "told").await;
    adr55_set_password(&pool, &person, ADR55_PASSWORD).await;
    let (signed_in, session_key) = adr55_sign_in(&store, &person.address, ADR55_PASSWORD, "", None)
        .await
        .expect("a steward with a credential signs in");

    // Long enough to pass the length rule and hopeless for the reason the
    // policy actually cares about: it carries the one thing an attacker
    // already knows.
    let chosen = format!("{}-lantern-copper", person.address);
    assert!(
        chosen.chars().count() >= credentials::PASSWORD_MIN,
        "the fixture has to clear the length rule, or this test proves the wrong refusal"
    );
    let mut body = Vec::new();
    lp(&mut body, chosen.as_bytes());
    let (status, answer) = adr55_signed_post(
        addr,
        &store,
        &signed_in,
        &session_key,
        "/credentials/password",
        &body,
    )
    .await;

    assert_eq!(
        status, "400",
        "a policy refusal is a 400 about what the caller just chose: {answer}"
    );
    assert!(
        answer.contains("must not contain the address it opens"),
        "the answer was {answer:?}. The sentence is safe to give — it is a statement about a \
         credential the caller supplied and already holds — and without it the only honest thing \
         a person can do is guess"
    );
}

/// **Asking to enrol a second app code over a live one is a conflict, and it
/// says so.**
///
/// It was rendered as `SessionError::SignInRefused`: `401 sign-in refused`, to
/// a caller holding a live, verified session. That reads as "your session
/// died" and sends a client back to the door it has just come through, when
/// the real answer is that replacing a live second factor from inside a
/// session is not a form at all — it is ADR-0055 decision 8's host command.
#[tokio::test]
async fn enrolling_a_second_app_code_over_a_live_one_is_a_conflict_and_says_which() {
    let _serial = ADR55_SERIAL.lock().await;
    let pool = adr55_deployment().await;
    let ring = ring();
    let store = Arc::new(adr55_store(&pool, Arc::clone(&ring), SignInLimits::defaults()).await);
    let creds = adr55_credentials(&pool, Arc::clone(&ring)).await;
    let addr = adr55_credential_surface(&pool, &ring, Arc::clone(&store)).await;

    let enrolled = adr55_enrolled(&pool, &ring, &store, &creds, "already").await;
    let code = adr55_a_fresh_code(&enrolled.secret).await;
    let (signed_in, session_key) = adr55_sign_in(
        &store,
        &enrolled.person.address,
        ADR55_PASSWORD,
        &code,
        None,
    )
    .await
    .expect("a credential and a real six-digit code open a session");

    let (status, answer) = adr55_signed_post(
        addr,
        &store,
        &signed_in,
        &session_key,
        "/credentials/totp/enrol",
        b"",
    )
    .await;

    assert_eq!(
        status, "409",
        "an account that already has a confirmed authenticator asked to enrol another and was \
         answered {status} {answer:?}. A live session being told 'sign-in refused' is told its \
         session is the problem, and it is not"
    );
    assert!(
        answer.contains("already has a confirmed authenticator"),
        "the answer was {answer:?}, which does not say what happened"
    );
}

// ---------------------------------------------------------------------------
// ADR-0056 decision 3 — sign-in is two steps
// ---------------------------------------------------------------------------
//
// The client asks for the address and the credential first, and the server
// says whether a verification code is needed before drawing a field for one.
// The probe is on the way to EVERY ordinary sign-in, which is why what it
// costs is as much of the claim as what it answers.

/// Everything one bucket has counted in the current window, summed: zero when
/// the bucket has never been written.
async fn adr56_attempts(bucket_kind: &str, bucket_key: &str) -> i64 {
    adr55_superuser()
        .await
        .query_one(
            "SELECT COALESCE(SUM(attempts), 0)::bigint FROM sign_in_attempts \
              WHERE bucket_kind = $1 AND bucket_key = $2",
            &[&bucket_kind, &bucket_key],
        )
        .await
        .expect("read the bucket")
        .get(0)
}

/// How many session rows one account holds right now.
async fn adr56_sessions_of(account: &str) -> i64 {
    adr55_superuser()
        .await
        .query_one(
            "SELECT count(*) FROM sessions WHERE principal_id = $1",
            &[&account],
        )
        .await
        .expect("count sessions")
        .get(0)
}

/// The `assurance` column of one session row.
async fn adr56_assurance_of(session_id: &str) -> String {
    adr55_superuser()
        .await
        .query_one(
            "SELECT assurance FROM sessions WHERE id = $1",
            &[&session_id],
        )
        .await
        .expect("the session row")
        .get(0)
}

/// **An empty verification code on an account that holds a confirmed
/// authenticator asks for the second factor and leaves every trace of the
/// request behind it: no session, no entry, no count, and the challenge still
/// usable.**
///
/// ADR-0056 decision 3 as the 2026-09-22 review settled it. The halves are one
/// claim, and the claim is about COST: the client makes this request on the way
/// to every ordinary sign-in, so anything it spends is spent by the person who
/// is signing in correctly.
///
/// **The measurement starts before the challenge**, which is the half the
/// ADR-0056 build's own test missed. It read the source bucket after the
/// challenge, so the second challenge step two needed — because the probe had
/// consumed the nonce — was invisible.
///
/// **What the journey costs, 2026-09-22 (second round): three source units** —
/// challenge, probe, completion. The first round rolled the probe's own count
/// back with everything else, which made the answer free and repeatable; the
/// count is committed separately now and
/// `SignInLimits::defaults().max_per_source` rose from thirty to forty-five so
/// that fifteen sign-ins a window is still fifteen. The account bucket and the
/// chain are untouched, which is the half that must not move: a person signing
/// in correctly passes through here.
#[tokio::test]
async fn an_empty_verification_code_asks_for_the_second_factor_and_leaves_the_challenge_unspent() {
    let _serial = ADR55_SERIAL.lock().await;
    let pool = adr55_deployment().await;
    let ring = ring();
    let store = Arc::new(adr55_store(&pool, Arc::clone(&ring), SignInLimits::defaults()).await);
    let creds = adr55_credentials(&pool, Arc::clone(&ring)).await;
    let enrolled = adr55_enrolled(&pool, &ring, &store, &creds, "twostep").await;
    let account = enrolled.person.account.to_string();

    let sessions_before = adr56_sessions_of(&account).await;
    let account_before = adr56_attempts("account", &account).await;
    let failed_before = failed_entries(&pool).await;

    // From here to the session: one source of its own, read before anything
    // has touched it.
    let source = a_source_of_its_own();
    let source_before = adr56_attempts("source", &source).await;

    // **One challenge for the whole two-step sign-in.** Step two re-posts this
    // one — the same keypair, the same nonce, the same (absent) evidence
    // signature — which is what makes the pair cost what a one-shot sign-in
    // cost before this ADR.
    let session_key = SoftwareKey::random().expect("a session keypair");
    let pubkey = session_key.public_key();
    let challenge = store
        .issue_challenge(
            PrincipalKind::Steward,
            &enrolled.person.address,
            &pubkey,
            &source,
        )
        .await
        .expect("a challenge");

    let probed = store
        .sign_in_with_credentials(&SignInAttempt {
            kind: PrincipalKind::Steward,
            session_pubkey: &pubkey,
            nonce: &challenge.nonce,
            evidence_sig: b"",
            password: ADR55_PASSWORD,
            totp_code: "",
            source: &source,
        })
        .await;

    assert!(
        matches!(probed, Err(SessionError::SecondFactorNeeded)),
        "an account with a confirmed authenticator and no code must be told which screen comes \
         next, not given a session and not given the uniform refusal: {probed:?}"
    );
    assert_eq!(
        adr56_sessions_of(&account).await,
        sessions_before,
        "no session is issued by step one"
    );
    assert_eq!(
        failed_entries(&pool).await,
        failed_before,
        "the probe sealed a sign-in FAILURE for somebody who is signing in correctly, and it did \
         it past the once-per-window latch every other refusal goes through. It is a protocol \
         step; the sealed sign-in a second later is the record"
    );
    assert_eq!(
        adr56_attempts("account", &account).await,
        account_before,
        "and it counted nothing against the account"
    );

    // **Step two: the same challenge, with the code.** If the probe had
    // consumed the nonce this would be refused and the client would have to ask
    // for a second challenge — which is the source unit the old test could not
    // see.
    let code = adr55_a_fresh_code(&enrolled.secret).await;
    let signed_in = store
        .sign_in_with_credentials(&SignInAttempt {
            kind: PrincipalKind::Steward,
            session_pubkey: &pubkey,
            nonce: &challenge.nonce,
            evidence_sig: b"",
            password: ADR55_PASSWORD,
            totp_code: &code,
            source: &source,
        })
        .await
        .expect(
            "the probe left the challenge unconsumed, so the same nonce and the verification \
             code open the session",
        );
    assert_eq!(
        adr56_assurance_of(&signed_in.session_id).await,
        "A0T",
        "and the session says a code made it"
    );

    assert_eq!(
        adr56_attempts("source", &source).await,
        source_before + 3,
        "an ordinary two-step sign-in costs one unit for the challenge, one for the probe and \
         one for the completion. More than that is the person who signs in correctly paying \
         for the shape of the conversation; fewer is a password holder running argon2id for \
         nothing"
    );
    assert_eq!(
        adr56_attempts("account", &account).await,
        account_before,
        "and the account bucket is where it started"
    );

    // And the nonce IS spent now: single use is single use, and the rolled-back
    // probe is the one step that does not burn it.
    let spent = store
        .sign_in_with_credentials(&SignInAttempt {
            kind: PrincipalKind::Steward,
            session_pubkey: &pubkey,
            nonce: &challenge.nonce,
            evidence_sig: b"",
            password: ADR55_PASSWORD,
            totp_code: &code,
            source: &a_source_of_its_own(),
        })
        .await;
    assert!(
        matches!(spent, Err(SessionError::SignInRefused)),
        "a third post of the same challenge, after it opened a session, must be refused: {spent:?}"
    );
}

/// **Every probe costs its source one unit of the budget, and nothing else
/// moves.**
///
/// The 2026-09-22 review drove forty probes against one challenge and one
/// source and found them all free: the rollback that keeps the nonce and the
/// account bucket intact was also giving back the source count, so a password
/// holder could run argon2id on this server for as long as they liked on one
/// challenge. Whatever else the probe is, it is a request, and a request costs
/// its source one unit here.
///
/// The three things that must still NOT move are asserted beside it, because
/// the fix is worth nothing if it was bought by making a correct sign-in a
/// failure: no chain entry, no account count, and the nonce still good. And a
/// WRONG credential on the same account is driven last, on a source of its own,
/// to show the refusal path is untouched — sealed, counted against the account,
/// and the challenge consumed.
#[tokio::test]
async fn every_second_factor_probe_costs_one_source_unit_and_leaves_the_rest_alone() {
    const PROBES: i64 = 12;
    let _serial = ADR55_SERIAL.lock().await;
    let pool = adr55_deployment().await;
    let ring = ring();
    let store = Arc::new(adr55_store(&pool, Arc::clone(&ring), SignInLimits::defaults()).await);
    let creds = adr55_credentials(&pool, Arc::clone(&ring)).await;
    let enrolled = adr55_enrolled(&pool, &ring, &store, &creds, "probecost").await;
    let account = enrolled.person.account.to_string();

    let account_before = adr56_attempts("account", &account).await;
    let failed_before = failed_entries(&pool).await;
    let source = a_source_of_its_own();
    let source_before = adr56_attempts("source", &source).await;

    let session_key = SoftwareKey::random().expect("a session keypair");
    let pubkey = session_key.public_key();
    let challenge = store
        .issue_challenge(
            PrincipalKind::Steward,
            &enrolled.person.address,
            &pubkey,
            &source,
        )
        .await
        .expect("a challenge");

    for probe in 0..PROBES {
        let answer = store
            .sign_in_with_credentials(&SignInAttempt {
                kind: PrincipalKind::Steward,
                session_pubkey: &pubkey,
                nonce: &challenge.nonce,
                evidence_sig: b"",
                password: ADR55_PASSWORD,
                totp_code: "",
                source: &source,
            })
            .await;
        assert!(
            matches!(answer, Err(SessionError::SecondFactorNeeded)),
            "probe {probe} was answered {answer:?}"
        );
        assert_eq!(
            adr56_attempts("source", &source).await,
            source_before + 1 + probe + 1,
            "probe {probe} did not cost its source a unit. The challenge cost one; each probe \
             costs one more, or a password holder runs unlimited argon2id on one challenge"
        );
    }

    assert_eq!(
        adr56_attempts("account", &account).await,
        account_before,
        "no probe may count against the ACCOUNT: the person signing in correctly makes this \
         request on the way to every sign-in, and would spend their own window on it"
    );
    assert_eq!(
        failed_entries(&pool).await,
        failed_before,
        "no probe may seal a sign-in failure: it is a protocol step, and the sealed sign-in \
         that follows is the record"
    );

    // The nonce survived all of them, which is what makes step two the same
    // challenge.
    let code = adr55_a_fresh_code(&enrolled.secret).await;
    let signed_in = store
        .sign_in_with_credentials(&SignInAttempt {
            kind: PrincipalKind::Steward,
            session_pubkey: &pubkey,
            nonce: &challenge.nonce,
            evidence_sig: b"",
            password: ADR55_PASSWORD,
            totp_code: &code,
            source: &source,
        })
        .await
        .expect("the probes left the challenge unconsumed");
    assert_eq!(adr56_assurance_of(&signed_in.session_id).await, "A0T");

    // And the refusal path is where it always was. A fresh challenge on a
    // source of its own, a wrong credential: sealed, counted against the
    // account, and the nonce spent.
    let wrong_source = a_source_of_its_own();
    let wrong_key = SoftwareKey::random().expect("a session keypair");
    let wrong_pub = wrong_key.public_key();
    let wrong_challenge = store
        .issue_challenge(
            PrincipalKind::Steward,
            &enrolled.person.address,
            &wrong_pub,
            &wrong_source,
        )
        .await
        .expect("a challenge");
    let account_before_wrong = adr56_attempts("account", &account).await;
    let failed_before_wrong = failed_entries(&pool).await;
    let refused = store
        .sign_in_with_credentials(&SignInAttempt {
            kind: PrincipalKind::Steward,
            session_pubkey: &wrong_pub,
            nonce: &wrong_challenge.nonce,
            evidence_sig: b"",
            password: "harbour-lantern-copper-ten",
            totp_code: "",
            source: &wrong_source,
        })
        .await;
    assert!(
        matches!(refused, Err(SessionError::PasswordRefused)),
        "a wrong credential is still the refusal that renders as the one generic sentence: \
         {refused:?}"
    );
    assert_eq!(
        adr56_attempts("account", &account).await,
        account_before_wrong + 1,
        "and it still costs the account bucket a failure"
    );
    assert!(
        failed_entries(&pool).await > failed_before_wrong,
        "and it is still sealed"
    );
    let reused = store
        .sign_in_with_credentials(&SignInAttempt {
            kind: PrincipalKind::Steward,
            session_pubkey: &wrong_pub,
            nonce: &wrong_challenge.nonce,
            evidence_sig: b"",
            password: ADR55_PASSWORD,
            totp_code: &adr55_a_fresh_code(&enrolled.secret).await,
            source: &wrong_source,
        })
        .await;
    assert!(
        matches!(reused, Err(SessionError::SignInRefused)),
        "a refused credential consumes the challenge, unlike the probe: {reused:?}"
    );
}

/// **An account with no authenticator and an empty code still gets its `A0`
/// session, exactly as it did before ADR-0056.**
///
/// The two-step answer is chosen by the STORED authenticator and never by
/// which fields the caller filled in — the same rule ADR-0055 decision 10
/// states for the credential branch. Without this, the probe could be made to
/// fire for every account and the setup flow would have no way in at all: the
/// first operator has no authenticator yet, and an empty code is all they have.
#[tokio::test]
async fn an_account_with_no_authenticator_still_signs_in_with_an_empty_code() {
    let _serial = ADR55_SERIAL.lock().await;
    let pool = adr55_deployment().await;
    let ring = ring();
    let store = adr55_store(&pool, Arc::clone(&ring), SignInLimits::defaults()).await;

    let person = adr55_account(&pool, "nofactor").await;
    adr55_set_password(&pool, &person, ADR55_PASSWORD).await;

    let (signed_in, _key) = adr55_sign_in(&store, &person.address, ADR55_PASSWORD, "", None)
        .await
        .expect("a steward with a credential and no authenticator signs in on an empty code");
    assert_eq!(
        adr56_assurance_of(&signed_in.session_id).await,
        "A0",
        "an account with a credential and no second factor is `A0`, which is the session that \
         reaches the screen that enrols one"
    );
}

/// **Over the wire: 401 and one sentence the client can act on.**
///
/// The bytes are the contract the browser client and
/// `scripts/ci/first-operator-signin.mjs` both read, and a status alone would
/// not tell the two-step client from a refused credential.
#[tokio::test]
async fn the_second_factor_answer_is_401_and_says_what_is_missing() {
    let _serial = ADR55_SERIAL.lock().await;
    let pool = adr55_deployment().await;
    let ring = ring();
    let store = Arc::new(adr55_store(&pool, Arc::clone(&ring), SignInLimits::defaults()).await);
    let creds = adr55_credentials(&pool, Arc::clone(&ring)).await;
    let enrolled = adr55_enrolled(&pool, &ring, &store, &creds, "overthewire").await;

    let addr = serve(api::router(ApiState {
        sessions: Arc::clone(&store),
        watch: Arc::new(EpochWatch::new()),
        ring: Arc::clone(&ring),
        client_address: ClientAddress::header("x-forwarded-for"),
    }))
    .await;

    let source = a_source_of_its_own();
    for (credential, expected, why) in [
        (
            ADR55_PASSWORD,
            "second factor needed\n",
            "the sentence is the client's contract: it is what tells the second screen to open \
             rather than the first one to redraw with a refusal on it",
        ),
        (
            ADR55_WRONG_PASSWORD,
            "sign-in refused\n",
            "a wrong credential gets the one sentence ADR-0055 decision 7 and ASVS 5.0.0 6.3.8 \
             ask for, whatever the account holds",
        ),
    ] {
        let session_key = SoftwareKey::random().expect("a session keypair");
        let pubkey = session_key.public_key();
        let challenge = store
            .issue_challenge(
                PrincipalKind::Steward,
                &enrolled.person.address,
                &pubkey,
                &source,
            )
            .await
            .expect("a challenge");
        let mut body = Vec::new();
        lp(&mut body, b"steward");
        lp(&mut body, &pubkey);
        lp(&mut body, &challenge.nonce);
        lp(&mut body, b"");
        lp(&mut body, credential.as_bytes());
        lp(&mut body, b"");
        let (status, answer) = post_bytes(
            addr,
            "/session",
            &body,
            &[("x-forwarded-for", source.clone())],
        )
        .await;
        assert_eq!(status, "401", "no session was issued, so it is not a 200");
        assert_eq!(String::from_utf8_lossy(&answer), expected, "{why}");
    }
}
