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
    let pubkey = session_key.public_key();
    let challenge = store
        .issue_challenge(PrincipalKind::Steward, &person.address, &pubkey)
        .await?;
    let digest = sessions::session_challenge(&pubkey, &challenge.nonce, &challenge.deployment_id);
    let evidence = person.key.sign(&digest);
    store
        .sign_in(
            PrincipalKind::Steward,
            &pubkey,
            &challenge.nonce,
            &evidence,
            &a_source_of_its_own(),
        )
        .await
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
    let counter = now_unix();
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
    // A one-second lifetime, and then a real second. The alternative -- moving
    // `expires_at` in SQL -- breaks the row MAC, so the refusal observed would
    // be the MAC's and this test would prove nothing about expiry. That fence
    // has its own test below.
    let store = SessionStore::with_lifetime(
        pool.clone(),
        Arc::clone(&ring),
        deployment,
        SignInLimits::defaults(),
        std::time::Duration::from_secs(1),
    );
    let (signed_in, session_key) = sign_in(&store, &estate.steward).await;

    // A nonce first, so the refusal is about the session's lifetime and not
    // about the caller having nothing to present.
    let call = a_call(&store, &signed_in, &session_key, "GET", "/x", b"").await;
    tokio::time::sleep(std::time::Duration::from_millis(1_200)).await;

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

#[tokio::test]
async fn an_address_that_belongs_to_no_account_gets_the_same_answer_as_one_that_does() {
    let _site = support::lock_the_site_chain().await;
    let pool = support::migrated_pool().await;
    let ring = ring();
    let estate = bootstrap(&pool, &ring).await;
    let store = store(&pool, Arc::clone(&ring)).await;

    let key = SoftwareKey::random().unwrap();
    let real = store
        .issue_challenge(
            PrincipalKind::Steward,
            &estate.steward.address,
            &key.public_key(),
        )
        .await
        .expect("a challenge for a real account");
    let imaginary = store
        .issue_challenge(
            PrincipalKind::Steward,
            "nobody@example.invalid",
            &key.public_key(),
        )
        .await
        .expect("a challenge for an address that belongs to nobody");

    assert_eq!(real.nonce.len(), imaginary.nonce.len());
    assert_eq!(real.deployment_id, imaginary.deployment_id);
    assert_ne!(
        real.nonce, imaginary.nonce,
        "two challenges are two nonces; the point is that neither answer says whether the \
         account exists"
    );

    // The refusal comes later, and says no more than any other refusal.
    let digest = sessions::session_challenge(
        &key.public_key(),
        &imaginary.nonce,
        &imaginary.deployment_id,
    );
    let refused = store
        .sign_in(
            PrincipalKind::Steward,
            &key.public_key(),
            &imaginary.nonce,
            &estate.steward.key.sign(&digest),
            "198.51.100.9",
        )
        .await;
    assert!(
        matches!(refused, Err(SessionError::SignInRefused)),
        "got {refused:?}"
    );
}

#[tokio::test]
async fn the_operator_sign_in_surface_accepts_no_password_shaped_input() {
    let _site = support::lock_the_site_chain().await;
    let pool = support::migrated_pool().await;
    let ring = ring();
    let store = store(&pool, Arc::clone(&ring)).await;

    // §4.5: an operator session is A1 or it does not exist. There is no
    // password path, no reset link and no "forgot" flow — and no operator
    // authenticator can be enrolled yet, so every attempt is refused with the
    // reason said out loud rather than folded into a generic failure.
    let key = SoftwareKey::random().unwrap();
    let challenge = store
        .issue_challenge(
            PrincipalKind::Operator,
            "operator@example.org",
            &key.public_key(),
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
            "198.51.100.11",
        )
        .await;
    assert!(
        matches!(refused, Err(SessionError::OperatorHasNoAuthenticator)),
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

#[tokio::test]
async fn repeated_failures_close_the_window_and_write_one_sealed_entry_rather_than_one_each() {
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
    let wrong = SoftwareKey::random().unwrap();
    let mut refusals = Vec::new();
    for _ in 0..6 {
        let session_key = SoftwareKey::random().unwrap();
        let pubkey = session_key.public_key();
        let challenge = store
            .issue_challenge(PrincipalKind::Steward, &estate.steward.address, &pubkey)
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
                    "203.0.113.5",
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
        refusals
            .iter()
            .any(|r| matches!(r, Err(SessionError::RateLimited { .. }))),
        "past the limit, the refusal must tell the caller to wait"
    );

    let written = failed_entries(&pool).await - before;
    assert!(
        written >= 1,
        "a refused sign-in is a sealed entry §7.2 names, and at least one must be written"
    );
    assert!(
        written < 6,
        "once the window is closed the entries stop, so an anonymous attacker cannot choose how \
         fast this deployment's audit chain grows: {written} entries for six attempts"
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
/// Deliberately a **valid** sign-in every time: §13 item 7's source number is a
/// rate limit on attempts, not a lockout on failures, so the cap has to bite a
/// caller whose signature is perfect — that is the whole difference between the
/// two buckets. `max_per_account` is put far out of the way so there is no
/// question which bucket refused.
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
            max_per_source: 3,
        },
    );

    // One source for all four attempts -- the bucket under test -- but one no
    // other test and no earlier run has counted against.
    let source = a_source_of_its_own();
    let mut answers = Vec::new();
    for _ in 0..4 {
        let session_key = SoftwareKey::random().expect("a session keypair");
        let pubkey = session_key.public_key();
        let challenge = store
            .issue_challenge(PrincipalKind::Steward, &estate.steward.address, &pubkey)
            .await
            .expect("a challenge");
        let digest =
            sessions::session_challenge(&pubkey, &challenge.nonce, &challenge.deployment_id);
        let evidence = estate.steward.key.sign(&digest);
        answers.push(
            store
                .sign_in(
                    PrincipalKind::Steward,
                    &pubkey,
                    &challenge.nonce,
                    &evidence,
                    &source,
                )
                .await,
        );
    }

    for (i, answer) in answers.iter().take(3).enumerate() {
        assert!(
            answer.is_ok(),
            "attempt {} is inside the cap and its signature is good: {answer:?}",
            i + 1
        );
    }
    assert!(
        matches!(answers[3], Err(SessionError::RateLimited { .. })),
        "past the source cap even a perfect sign-in is told to wait: {:?}",
        answers[3]
    );
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
        trusted_client_ip_header: None,
    };
    let addr = serve(api::router(state)).await;

    let path = format!("/organisations/{}/capability", estate.organisation);
    for (who, expected) in [
        (&estate.steward, "steward\n"),
        (&reader, "read\n"),
        (&drawer, "draw\n"),
    ] {
        let (status, body) = call_over_http(addr, who, "GET", &path).await;
        assert_eq!(status, "200", "{} got {status} {body}", who.address);
        assert_eq!(body, expected, "for {}", who.address);
    }

    let (status, body) = call_over_http(addr, &stranger, "GET", &path).await;
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
async fn call_over_http(
    addr: std::net::SocketAddr,
    person: &Person,
    method: &str,
    path: &str,
) -> (String, String) {
    let session_key = SoftwareKey::random().unwrap();
    let pubkey = session_key.public_key();

    // POST /session/challenge
    let mut body = Vec::new();
    lp(&mut body, b"steward");
    lp(&mut body, person.address.as_bytes());
    lp(&mut body, &pubkey);
    let (status, answer) = post_bytes(addr, "/session/challenge", &body, &[]).await;
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
    let (status, answer) = post_bytes(addr, "/session", &body, &[]).await;
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

    // The signed call itself.
    let unix_ms = now_ms();
    let counter = now_unix();
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

async fn raw_request(
    addr: std::net::SocketAddr,
    method: &str,
    path: &str,
    headers: &[(&str, String)],
    body: &[u8],
) -> (String, Vec<u8>) {
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
    (status, body)
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
