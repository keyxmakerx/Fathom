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

use deadpool_postgres::Pool;
use fathom_server::api::{
    self, ApiState, HEADER_COUNTER, HEADER_NONCE, HEADER_SESSION, HEADER_SIGNATURE,
    HEADER_TIMESTAMP, HEADER_TOKEN,
};
use fathom_server::authority::{self, Capability, GrantFacts, SoftwareKey};
use fathom_server::chains;
use fathom_server::crypto::Key32;
use fathom_server::grants::{self, Authority, EpochWatch, GenesisGrant, GrantRequest};
use fathom_server::keys::{self, KeyRing};
use fathom_server::repo::{self, AccountId, OrganisationId};
use fathom_server::sessions::{
    self, PrincipalKind, SessionError, SessionStore, SignInLimits, SignedIn, SignedRequest,
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
/// The source bucket is a rate limit, not a lockout: thirty attempts per
/// fifteen minutes, counted per source string, in a row of `sign_in_attempts`
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
        trusted_client_ip_header: Some("x-forwarded-for".to_string()),
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

#[tokio::test]
async fn the_operator_sign_in_surface_accepts_no_password_shaped_input() {
    let _site = support::lock_the_site_chain().await;
    let pool = support::migrated_pool().await;
    let ring = ring();
    let store = store(&pool, Arc::clone(&ring)).await;

    // §4.5: an operator session is A1 or it does not exist. There is no
    // password path, no reset link and no "forgot" flow.
    //
    // **Updated for `0015`, which makes the operator plane real.** This used
    // to assert `OperatorHasNoAuthenticator`, because no operator key could be
    // enrolled at all and so every attempt could safely say why. Now that one
    // can, saying why would tell an unauthenticated caller which operator ids
    // have enrolled and which are still holding a token — so the refusal is
    // the same uniform `SignInRefused` an unknown account address gets, and
    // the sealed `operator_signin_failed` entry carries the reason where an
    // operator can read it. `tests/operators.rs` drives the path that now
    // succeeds.
    let key = SoftwareKey::random().unwrap();
    let challenge = store
        .issue_challenge(
            PrincipalKind::Operator,
            "operator@example.org",
            &key.public_key(),
            &a_source_of_its_own(),
        )
        .await
        .expect("the operator surface answers a challenge like any other");
    let digest = sessions::session_challenge(
        &key.public_key(),
        &challenge.nonce,
        &challenge.deployment_id,
    );
    let refused = store
        .sign_in(
            PrincipalKind::Operator,
            &key.public_key(),
            &challenge.nonce,
            &key.sign(&digest),
            &a_source_of_its_own(),
        )
        .await;
    assert!(
        matches!(refused, Err(SessionError::SignInRefused)),
        "got {refused:?}"
    );

    // **The structural half of the claim**: there is no field a password
    // could arrive in. The sign-in message is four length-prefixed fields —
    // kind, public key, nonce, signature — and a body carrying a fifth is
    // refused rather than having the extra ignored.
    let state = ApiState {
        sessions: Arc::new(store),
        watch: Arc::new(EpochWatch::new()),
        ring: Arc::clone(&ring),
        trusted_client_ip_header: None,
    };
    let addr = serve(api::router(state)).await;

    let mut body = Vec::new();
    lp(&mut body, b"operator");
    lp(&mut body, &key.public_key());
    lp(&mut body, &challenge.nonce);
    lp(&mut body, &[0u8; 64]);
    lp(
        &mut body,
        b"a password, which this protocol has no field for",
    );
    let refused = post_bytes(addr, "/session", &body, &[]).await;
    assert_eq!(
        refused.0, "400",
        "a sign-in body with a field this protocol does not have must be refused, not silently \
         truncated: {refused:?}"
    );

    // And the operator surface's refusals are on the site chain under §7.2's
    // own name for them.
    let client = pool.get().await.expect("connection");
    let seen: i64 = client
        .query_one(
            "SELECT count(*) FROM chain_entries \
              WHERE chain_kind = 'site' AND entry_type = 'operator_signin_failed'",
            &[],
        )
        .await
        .expect("count")
        .get(0);
    assert!(seen >= 1, "an operator sign-in attempt must be recorded");
}

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
        // `ApiState::trusted_client_ip_header` says.
        trusted_client_ip_header: Some("x-forwarded-for".to_string()),
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
/// helper is driven against must trust (`ApiState::trusted_client_ip_header`).
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
    let (status, answer) = post_bytes(addr, "/session", &body, forwarded).await;
    assert_eq!(status, "200", "sign-in");
    let (session_id, rest) = read_lp(&answer);
    let (token, _) = read_lp(rest);
    let session_id = String::from_utf8(session_id.to_vec()).unwrap();

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
        trusted_client_ip_header: None,
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
        trusted_client_ip_header: None,
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
