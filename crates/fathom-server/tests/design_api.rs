//! The drawing surface's HTTP endpoints, against a real PostgreSQL and
//! through the real router — `src/design_api.rs`.
//!
//! Follows `tests/sessions.rs`'s own conventions: a real signed HTTP request
//! over a real socket, `support::migrated_pool`, and `support::lock_the_site_chain`
//! held for the duration of every test that signs in, because sign-in appends
//! to the one site chain this shared test database has.
//!
//! **Every test here is written against a claim, and its name is the claim**
//! (CLAUDE.md rule 2):
//!
//! - the read-only caller's refusal is compared **byte for byte** against the
//!   refusal for a design that was never created, because the claim is that
//!   the two are indistinguishable, not merely that both are `403`;
//! - the account with no capability's list is compared against the empty
//!   array exactly, because the claim is that the design is *absent*, not
//!   present-but-marked-forbidden;
//! - the broken chain is broken with `support::tamper` against `chain_entries`
//!   directly, the way `tests/design_storage.rs` already does it, because the
//!   claim is about what a real tamper reports, not what a mock would.

mod support;

use std::net::SocketAddr;
use std::sync::Arc;

use deadpool_postgres::Pool;

use fathom_graph::{
    Actor, BatchId, Confidence, Graph, Origin, ProvenanceId, ProvenanceRecord, Timestamp, UserId,
};
use fathom_id::Ulid;
use fathom_ir::generated::ir_types::{CaptureField, NodeKind, NoteField};
use fathom_ir::scalar;
use fathom_server::api::{
    HEADER_COUNTER, HEADER_NONCE, HEADER_SESSION, HEADER_SIGNATURE, HEADER_TIMESTAMP, HEADER_TOKEN,
};
use fathom_server::audit;
use fathom_server::authority::{self, Capability, GrantFacts, SoftwareKey};
use fathom_server::chains;
use fathom_server::client_address::ClientAddress;
use fathom_server::crypto::Key32;
use fathom_server::design_api::{self, DesignApiState};
use fathom_server::designs;
use fathom_server::grants::{
    self, Authority, AuthorityError, EpochWatch, GenesisGrant, GrantRequest,
};
use fathom_server::keys::{self, KeyRing};
use fathom_server::repo::{self, AccountId, DesignId, OrganisationId, ScopeId, ScopeKind};
use fathom_server::sessions::{self, SessionStore, SignInLimits};

/// The one master key this test database is encrypted under (ADR-0043 §4:
/// one configured key id per database).
const MASTER: [u8; 32] = [21; 32];

/// **The site chain master, not a per-suite one** — see `tests/sessions.rs`'s
/// identical fixture for the reasoning: sign-in appends to the one site chain
/// this shared test database has, and every test here signs in.
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
// Fixtures — mirrors `tests/sessions.rs`'s
// ---------------------------------------------------------------------------

struct Person {
    account: AccountId,
    address: String,
    key: SoftwareKey,
}

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

/// A member of the organisation with a key enrolled and, optionally, an
/// organisation-wide grant signed by the genesis steward.
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

/// Like [`a_member_with`], but the grant (when `capability` is `Some`) is
/// scoped to `scope` rather than the whole organisation (`scope: None`) —
/// what test 2 for `GET /organisations/{organisation}/scopes` needs: a
/// capability that covers one subtree and nothing above or beside it.
async fn a_member_with_scope(
    pool: &Pool,
    ring: &KeyRing,
    estate: &Estate,
    name: &str,
    scope: ScopeId,
    capability: Capability,
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
            scope: Some(scope),
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
    person
}

async fn store(pool: &Pool, ring: Arc<KeyRing>) -> SessionStore {
    let client = pool.get().await.expect("connection");
    let deployment = chains::deployment_id(&**client)
        .await
        .expect("this deployment is stamped at startup");
    // Every test here signs in over a real socket from the loopback address,
    // so every one of them shares §13 item 7's source bucket -- unlike
    // `tests/sessions.rs`'s own rate-limit tests, none of these is ABOUT that
    // cap, and `SignInLimits::defaults`'s 30-per-source window is easily
    // crossed by this file's own test count on a second run within the same
    // fifteen minutes. Generous, fixed limits here so this suite tests what
    // its names say and `tests/sessions.rs` keeps sole ownership of the cap
    // itself.
    let limits = SignInLimits {
        window: std::time::Duration::from_secs(900),
        max_per_account: 10_000,
        max_per_source: 10_000,
    };
    SessionStore::new(pool.clone(), ring, deployment, limits)
}

/// A scope (a root network) and one design hung off it, created by the
/// estate's steward — plain repository calls, exactly as `create_design`'s
/// own doc says a caller reaches it: no HTTP surface builds a design yet, and
/// this task's brief does not ask for one.
async fn a_scope_and_design(pool: &Pool, estate: &Estate) -> (ScopeId, DesignId) {
    let scope = repo::create_scope(
        pool,
        estate.organisation,
        estate.steward.account,
        None,
        ScopeKind::Network,
        &unique("net"),
    )
    .await
    .expect("create scope");
    let design =
        designs::create_design(pool, estate.organisation, estate.steward.account, scope.id)
            .await
            .expect("create design");
    (scope.id, design)
}

/// A three-level tree the scopes tests share: one network, two buildings
/// under it, and one rack under the first building. `(network, building_a,
/// building_b, rack_under_a)`.
async fn a_scope_tree(pool: &Pool, estate: &Estate) -> (ScopeId, ScopeId, ScopeId, ScopeId) {
    let network = repo::create_scope(
        pool,
        estate.organisation,
        estate.steward.account,
        None,
        ScopeKind::Network,
        &unique("net"),
    )
    .await
    .expect("create network")
    .id;
    let building_a = repo::create_scope(
        pool,
        estate.organisation,
        estate.steward.account,
        Some(network),
        ScopeKind::Building,
        &unique("building-a"),
    )
    .await
    .expect("create building a")
    .id;
    let building_b = repo::create_scope(
        pool,
        estate.organisation,
        estate.steward.account,
        Some(network),
        ScopeKind::Building,
        &unique("building-b"),
    )
    .await
    .expect("create building b")
    .id;
    let rack_under_a = repo::create_scope(
        pool,
        estate.organisation,
        estate.steward.account,
        Some(building_a),
        ScopeKind::Rack,
        &unique("rack-a"),
    )
    .await
    .expect("create rack under a")
    .id;
    (network, building_a, building_b, rack_under_a)
}

/// The header `app` trusts for the source bucket, so this file's own tests
/// can each carry a source of their own (see `a_source_of_its_own`) rather
/// than sharing one real loopback address with every other test binary that
/// runs against this database in the same fifteen-minute window — which is
/// exactly what `tests/sessions.rs`'s own fixture comment warns tripped it
/// on 2026-09-13.
const TEST_SOURCE_HEADER: &str = "x-fathom-test-source";

/// A source address this call and no other test will ever use — mirrors
/// `tests/sessions.rs`'s helper of the same purpose.
fn a_source_of_its_own() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT: AtomicU64 = AtomicU64::new(0);
    format!(
        "203.0.113.9-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    )
}

/// The real router: `api::router` for sign-in and nonces, merged with
/// `design_api::router` for everything this task built — exactly the shape
/// `src/main.rs` is meant to assemble, and the reason `call`'s `/session/...`
/// steps have anywhere to land. Building only `design_api::router` on its own
/// answers every one of those with a `404`, since this module deliberately
/// has no session-establishment routes of its own (module doc).
async fn app(
    pool: &Pool,
    ring: Arc<KeyRing>,
    catalogue: Vec<fathom_corpus::catalogue::Model>,
) -> axum::Router {
    let sessions = Arc::new(store(pool, Arc::clone(&ring)).await);
    let watch = Arc::new(EpochWatch::new());

    let api_state = fathom_server::api::ApiState {
        sessions: Arc::clone(&sessions),
        watch: Arc::clone(&watch),
        ring: Arc::clone(&ring),
        client_address: ClientAddress::header(TEST_SOURCE_HEADER),
    };
    let design_state = DesignApiState {
        sessions,
        watch,
        ring,
        catalogue: Arc::new(catalogue),
    };
    fathom_server::api::router(api_state).merge(design_api::router(design_state))
}

/// A `DesignId` this database will never have created a row for — built from
/// the same generator `designs.rs` mints real ones from
/// (`fathom_server::ids::new_ulid`), so it is shaped exactly like a real id
/// and not distinguishable from one by its syntax alone.
fn a_design_id_nothing_was_ever_created_under() -> DesignId {
    DesignId(fathom_server::ids::new_ulid())
}

/// A real `fathom-plain 1` document (ADR-0049 #2: `save_design_handler` now
/// reads every payload back with `fathom_workspace::read_plain` before
/// storing it, so a save test's body has to be one of these rather than
/// arbitrary bytes). `seed` only keeps the ULIDs distinct across the tests
/// that call this more than once; the content otherwise carries nothing
/// these tests read back.
fn a_plain_face_payload(seed: u128) -> Vec<u8> {
    let mut g = Graph::new();
    g.begin_batch(BatchId(Ulid(seed * 10)), "design_api test fixture")
        .expect("open batch");
    g.insert_node(
        NodeKind::Device,
        Ulid(seed * 10 + 1),
        ProvenanceRecord {
            id: ProvenanceId(Ulid(seed * 10 + 2)),
            origin: Origin::Hand,
            asserted_at: Timestamp(0),
            asserted_by: Actor::User(UserId(Ulid(seed * 10 + 3))),
            confidence: Confidence::Asserted,
            supersedes: None,
        },
    )
    .expect("bare device");
    g.end_batch().expect("close batch");
    fathom_workspace::write_plain(&g).expect("a graph this crate built must write")
}

/// ADR-0049 #4's wire number for the schema version currently declared on
/// line 3 of every payload [`a_plain_face_payload`] writes -- `"0.10"` at time
/// of writing, whose minor component this is. Kept as its own named constant
/// rather than a bare `10` at each call site so a future schema bump has one
/// place to change.
const CURRENT_SCHEMA_WIRE_VERSION: u32 = 10;

fn save_body(schema_version: u32, payload: &[u8]) -> Vec<u8> {
    let mut out = schema_version.to_le_bytes().to_vec();
    out.extend_from_slice(payload);
    out
}

// ---------------------------------------------------------------------------
// Speaking HTTP by hand — `tests/sessions.rs`'s own pattern; there is no HTTP
// client crate in this closure.
// ---------------------------------------------------------------------------

async fn serve(router: axum::Router) -> SocketAddr {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind an ephemeral loopback port");
    let addr = listener.local_addr().expect("local addr");
    tokio::spawn(async move {
        let _ = axum::serve(
            listener,
            router.into_make_service_with_connect_info::<SocketAddr>(),
        )
        .await;
    });
    addr
}

async fn post_bytes(
    addr: SocketAddr,
    path: &str,
    body: &[u8],
    headers: &[(&str, String)],
) -> (String, Vec<u8>) {
    raw_request(addr, "POST", path, headers, body).await
}

async fn raw_request(
    addr: SocketAddr,
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
    let resp_body = buf[split + 4..].to_vec();
    let status = head
        .lines()
        .next()
        .unwrap_or_default()
        .split_whitespace()
        .nth(1)
        .unwrap_or_default()
        .to_string();
    (status, resp_body)
}

fn lp(out: &mut Vec<u8>, field: &[u8]) {
    out.extend_from_slice(&(field.len() as u32).to_le_bytes());
    out.extend_from_slice(field);
}

fn read_lp(bytes: &[u8]) -> (&[u8], &[u8]) {
    let len = u32::from_le_bytes(bytes[..4].try_into().unwrap()) as usize;
    (&bytes[4..4 + len], &bytes[4 + len..])
}

fn hex(bytes: impl AsRef<[u8]>) -> String {
    bytes.as_ref().iter().map(|b| format!("{b:02x}")).collect()
}

/// Sign in as a browser would, take a request nonce, sign one request over
/// the real HTTP surface, and return its status and raw body.
async fn call(
    addr: SocketAddr,
    person: &Person,
    method: &str,
    path: &str,
    body: &[u8],
) -> (String, Vec<u8>) {
    let session_key = SoftwareKey::random().unwrap();
    let pubkey = session_key.public_key();
    let source = a_source_of_its_own();

    let mut chal = Vec::new();
    lp(&mut chal, b"steward");
    lp(&mut chal, person.address.as_bytes());
    lp(&mut chal, &pubkey);
    let (status, answer) = post_bytes(
        addr,
        "/session/challenge",
        &chal,
        &[(TEST_SOURCE_HEADER, source.clone())],
    )
    .await;
    assert_eq!(status, "200", "challenge");
    let (nonce, rest) = read_lp(&answer);
    let (deployment, _) = read_lp(rest);
    let deployment = String::from_utf8(deployment.to_vec()).unwrap();
    let nonce: [u8; 32] = nonce.try_into().unwrap();

    let digest = sessions::session_challenge(&pubkey, &nonce, &deployment);
    let mut signin = Vec::new();
    lp(&mut signin, b"steward");
    lp(&mut signin, &pubkey);
    lp(&mut signin, &nonce);
    lp(&mut signin, &person.key.sign(&digest));

    // ADR-0055 decision 10 widened `POST /session` from four length-prefixed
    // fields to six: a credential and an app code, both empty on the key-only
    // branch this test drives. `read_fields` still refuses an inexact count,
    // so the two empty fields are not optional.
    lp(&mut signin, b"");
    lp(&mut signin, b"");
    let (status, answer) =
        post_bytes(addr, "/session", &signin, &[(TEST_SOURCE_HEADER, source)]).await;
    assert_eq!(status, "200", "sign-in");
    let (session_id, rest) = read_lp(&answer);
    let (token, _) = read_lp(rest);
    let session_id = String::from_utf8(session_id.to_vec()).unwrap();

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

    let unix_ms = now_ms();
    let counter = 1i64;
    let message = sessions::request_bytes(
        &session_id,
        method,
        path,
        &sessions::body_digest(body),
        &nonce,
        unix_ms,
        counter,
    );
    let signature = session_key.sign(&message);
    raw_request(
        addr,
        method,
        path,
        &[
            (HEADER_SESSION, session_id),
            (HEADER_NONCE, hex(nonce)),
            (HEADER_TIMESTAMP, unix_ms.to_string()),
            (HEADER_COUNTER, counter.to_string()),
            (HEADER_SIGNATURE, hex(signature)),
        ],
        body,
    )
    .await
}

/// [`call`], but with the last byte of the signature flipped after it is
/// computed — a real session, a real nonce, and a signature that does not
/// verify. Otherwise identical, on purpose: the only thing this must prove
/// differently from an unsigned request is that a *wrong* signature is
/// refused too, not only a missing one.
async fn call_badly_signed(
    addr: SocketAddr,
    person: &Person,
    method: &str,
    path: &str,
    body: &[u8],
) -> (String, Vec<u8>) {
    let session_key = SoftwareKey::random().unwrap();
    let pubkey = session_key.public_key();
    let source = a_source_of_its_own();

    let mut chal = Vec::new();
    lp(&mut chal, b"steward");
    lp(&mut chal, person.address.as_bytes());
    lp(&mut chal, &pubkey);
    let (status, answer) = post_bytes(
        addr,
        "/session/challenge",
        &chal,
        &[(TEST_SOURCE_HEADER, source.clone())],
    )
    .await;
    assert_eq!(status, "200", "challenge");
    let (nonce, rest) = read_lp(&answer);
    let (deployment, _) = read_lp(rest);
    let deployment = String::from_utf8(deployment.to_vec()).unwrap();
    let nonce: [u8; 32] = nonce.try_into().unwrap();

    let digest = sessions::session_challenge(&pubkey, &nonce, &deployment);
    let mut signin = Vec::new();
    lp(&mut signin, b"steward");
    lp(&mut signin, &pubkey);
    lp(&mut signin, &nonce);
    lp(&mut signin, &person.key.sign(&digest));

    // ADR-0055 decision 10 widened `POST /session` from four length-prefixed
    // fields to six: a credential and an app code, both empty on the key-only
    // branch this test drives. `read_fields` still refuses an inexact count,
    // so the two empty fields are not optional.
    lp(&mut signin, b"");
    lp(&mut signin, b"");
    let (status, answer) =
        post_bytes(addr, "/session", &signin, &[(TEST_SOURCE_HEADER, source)]).await;
    assert_eq!(status, "200", "sign-in");
    let (session_id, rest) = read_lp(&answer);
    let (token, _) = read_lp(rest);
    let session_id = String::from_utf8(session_id.to_vec()).unwrap();

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

    let unix_ms = now_ms();
    let counter = 1i64;
    let message = sessions::request_bytes(
        &session_id,
        method,
        path,
        &sessions::body_digest(body),
        &nonce,
        unix_ms,
        counter,
    );
    let mut signature = session_key.sign(&message);
    signature[63] ^= 0xff;
    raw_request(
        addr,
        method,
        path,
        &[
            (HEADER_SESSION, session_id),
            (HEADER_NONCE, hex(nonce)),
            (HEADER_TIMESTAMP, unix_ms.to_string()),
            (HEADER_COUNTER, counter.to_string()),
            (HEADER_SIGNATURE, hex(signature)),
        ],
        body,
    )
    .await
}

// ---------------------------------------------------------------------------
// Save: a `read`-only caller is refused, and the refusal does not leak
// whether the design exists
// ---------------------------------------------------------------------------

#[tokio::test]
async fn a_read_only_caller_is_refused_a_save_and_the_refusal_does_not_leak_whether_the_design_exists(
) {
    let _site = support::lock_the_site_chain().await;
    let pool = support::migrated_pool().await;
    let ring = ring();
    let estate = bootstrap(&pool, &ring).await;
    let (_scope, design) = a_scope_and_design(&pool, &estate).await;
    let reader = a_member_with(&pool, &ring, &estate, "reader", Some(Capability::Read)).await;

    let addr = serve(app(&pool, Arc::clone(&ring), Vec::new()).await).await;

    // A real `fathom-plain` payload (ADR-0049 #2 now refuses anything else
    // before the capability check below is even reached), so this test
    // still proves what its name says: the capability check, not the
    // payload's own shape.
    let body = save_body(CURRENT_SCHEMA_WIRE_VERSION, &a_plain_face_payload(1));

    let real_path = format!(
        "/organisations/{}/designs/{}/versions?base=0",
        estate.organisation, design
    );
    let (real_status, real_body) = call(addr, &reader, "POST", &real_path, &body).await;

    let fake = a_design_id_nothing_was_ever_created_under();
    let fake_path = format!(
        "/organisations/{}/designs/{}/versions?base=0",
        estate.organisation, fake
    );
    let (fake_status, fake_body) = call(addr, &reader, "POST", &fake_path, &body).await;

    assert_eq!(
        real_status, "403",
        "a read-only caller must be refused a save: {real_body:?}"
    );
    assert_eq!(
        real_status, fake_status,
        "a real design the caller cannot draw on and a design that never existed must answer \
         identically"
    );
    assert_eq!(
        real_body, fake_body,
        "the refusal body must not differ either, or the two are distinguishable after all"
    );

    // The positive control: nothing was written even for the real design.
    let latest = designs::read_version(
        &pool,
        &ring,
        estate.organisation,
        estate.steward.account,
        design,
        None,
    )
    .await;
    assert!(
        matches!(latest, Err(designs::DesignError::NoSuchVersion)),
        "the reader's refused save must not have written a version: {latest:?}"
    );
}

// ---------------------------------------------------------------------------
// List: no capability, no entry — absent, not forbidden
// ---------------------------------------------------------------------------

#[tokio::test]
async fn a_caller_with_no_capability_gets_a_list_that_omits_the_design_entirely() {
    let _site = support::lock_the_site_chain().await;
    let pool = support::migrated_pool().await;
    let ring = ring();
    let estate = bootstrap(&pool, &ring).await;
    let (_scope, design) = a_scope_and_design(&pool, &estate).await;
    let outsider = a_member_with(&pool, &ring, &estate, "outsider", None).await;

    let addr = serve(app(&pool, Arc::clone(&ring), Vec::new()).await).await;

    let path = format!("/organisations/{}/designs", estate.organisation);

    let (status, body) = call(addr, &outsider, "GET", &path, b"").await;
    assert_eq!(status, "200", "{}", String::from_utf8_lossy(&body));
    assert_eq!(
        body,
        b"[]\n",
        "a member with no grant must see an empty list, not a design marked forbidden: {}",
        String::from_utf8_lossy(&body)
    );

    // The positive control: the steward, who holds the genesis grant, does
    // see it — proving the empty answer above is about capability and not a
    // broken list.
    let (status, body) = call(addr, &estate.steward, "GET", &path, b"").await;
    assert_eq!(status, "200");
    let text = String::from_utf8_lossy(&body);
    assert!(
        text.contains(&design.to_string()),
        "the steward must see the design it created: {text}"
    );
    assert!(text.contains("\"capability\":\"steward\""), "{text}");
}

// ---------------------------------------------------------------------------
// Cross-tenant: an account in one organisation cannot open another's design
// ---------------------------------------------------------------------------

#[tokio::test]
async fn an_account_in_one_organisation_cannot_open_anothers_design() {
    let _site = support::lock_the_site_chain().await;
    let pool = support::migrated_pool().await;
    let ring = ring();

    let estate_a = bootstrap(&pool, &ring).await;
    let (_scope, design_a) = a_scope_and_design(&pool, &estate_a).await;
    designs::write_version(
        &pool,
        &ring,
        estate_a.organisation,
        estate_a.steward.account,
        design_a,
        b"organisation A's own estate",
        1,
    )
    .await
    .expect("A can write its own design");

    let estate_b = bootstrap(&pool, &ring).await;

    let addr = serve(app(&pool, Arc::clone(&ring), Vec::new()).await).await;

    let path = format!(
        "/organisations/{}/designs/{}",
        estate_a.organisation, design_a
    );
    let (status, body) = call(addr, &estate_b.steward, "GET", &path, b"").await;
    assert_eq!(
        status,
        "403",
        "B holds no membership in A's organisation at all: {}",
        String::from_utf8_lossy(&body)
    );

    // The positive control: A's own steward can open it.
    let (status, body) = call(addr, &estate_a.steward, "GET", &path, b"").await;
    assert_eq!(status, "200", "{}", String::from_utf8_lossy(&body));
    assert_eq!(body, b"organisation A's own estate");
}

// ---------------------------------------------------------------------------
// Save and open, round trip; history; verify (verified, then broken)
// ---------------------------------------------------------------------------

#[tokio::test]
async fn a_drawer_saves_a_version_and_the_steward_opens_the_same_bytes_back() {
    let _site = support::lock_the_site_chain().await;
    let pool = support::migrated_pool().await;
    let ring = ring();
    let estate = bootstrap(&pool, &ring).await;
    let (_scope, design) = a_scope_and_design(&pool, &estate).await;
    let drawer = a_member_with(&pool, &ring, &estate, "drawer", Some(Capability::Draw)).await;

    let addr = serve(app(&pool, Arc::clone(&ring), Vec::new()).await).await;

    let versions_path = format!(
        "/organisations/{}/designs/{}/versions?base=0",
        estate.organisation, design
    );
    // A real `fathom-plain` payload -- ADR-0049 #2, exactly as the read-only
    // caller test above notes.
    let payload = a_plain_face_payload(2);
    let (status, body) = call(
        addr,
        &drawer,
        "POST",
        &versions_path,
        &save_body(CURRENT_SCHEMA_WIRE_VERSION, &payload),
    )
    .await;
    assert_eq!(status, "200", "{}", String::from_utf8_lossy(&body));
    assert_eq!(body, b"1\n", "the first version this design has ever had");

    let open_path = format!("/organisations/{}/designs/{}", estate.organisation, design);
    let (status, body) = call(addr, &estate.steward, "GET", &open_path, b"").await;
    assert_eq!(status, "200");
    assert_eq!(
        body, payload,
        "the steward must read back exactly what the drawer saved"
    );

    // History names the write.
    let history_path = format!(
        "/organisations/{}/designs/{}/history",
        estate.organisation, design
    );
    let (status, body) = call(addr, &estate.steward, "GET", &history_path, b"").await;
    assert_eq!(status, "200");
    let text = String::from_utf8_lossy(&body);
    assert!(text.contains("\"entry_type\":\"create\""), "{text}");
    assert!(text.contains("\"design_version\":1"), "{text}");
}

// ---------------------------------------------------------------------------
// ADR-0049 #2 and #4: the server reads every design payload back before
// storing it, and the wire prefix must agree with the payload's own line 3
// ---------------------------------------------------------------------------

#[tokio::test]
async fn a_payload_written_by_write_plain_saves_and_opens_back_byte_for_byte() {
    let _site = support::lock_the_site_chain().await;
    let pool = support::migrated_pool().await;
    let ring = ring();
    let estate = bootstrap(&pool, &ring).await;
    let (_scope, design) = a_scope_and_design(&pool, &estate).await;
    let drawer = a_member_with(&pool, &ring, &estate, "drawer", Some(Capability::Draw)).await;

    let addr = serve(app(&pool, Arc::clone(&ring), Vec::new()).await).await;

    let payload = a_plain_face_payload(3);
    let versions_path = format!(
        "/organisations/{}/designs/{}/versions?base=0",
        estate.organisation, design
    );
    let (status, body) = call(
        addr,
        &drawer,
        "POST",
        &versions_path,
        &save_body(CURRENT_SCHEMA_WIRE_VERSION, &payload),
    )
    .await;
    assert_eq!(
        status,
        "200",
        "a payload write_plain wrote must be accepted: {}",
        String::from_utf8_lossy(&body)
    );

    let open_path = format!("/organisations/{}/designs/{}", estate.organisation, design);
    let (status, body) = call(addr, &drawer, "GET", &open_path, b"").await;
    assert_eq!(status, "200");
    assert_eq!(
        body, payload,
        "the bytes read back must equal the bytes write_plain produced, byte for byte"
    );
}

/// Line 2 of a `fathom-plain` payload is [`fathom_workspace::PLAIN_WARNING`],
/// byte for byte -- flipping the case of its first letter edits it away
/// without moving any other offset in the file.
fn corrupt_warning_line(payload: &[u8]) -> Vec<u8> {
    let mut out = payload.to_vec();
    let first_nl = out
        .iter()
        .position(|&b| b == b'\n')
        .expect("line 1 ends in a newline");
    let warning_start = first_nl + 1;
    assert_eq!(
        out[warning_start], b'T',
        "line 2 must start with the T of THIS -- fathom_workspace::PLAIN_WARNING"
    );
    out[warning_start] = b't';
    out
}

#[tokio::test]
async fn a_payload_whose_warning_line_is_edited_is_refused_with_the_named_error() {
    let _site = support::lock_the_site_chain().await;
    let pool = support::migrated_pool().await;
    let ring = ring();
    let estate = bootstrap(&pool, &ring).await;
    let (_scope, design) = a_scope_and_design(&pool, &estate).await;
    let drawer = a_member_with(&pool, &ring, &estate, "drawer", Some(Capability::Draw)).await;

    let addr = serve(app(&pool, Arc::clone(&ring), Vec::new()).await).await;

    let corrupted = corrupt_warning_line(&a_plain_face_payload(4));
    let versions_path = format!(
        "/organisations/{}/designs/{}/versions?base=0",
        estate.organisation, design
    );
    let (status, body) = call(
        addr,
        &drawer,
        "POST",
        &versions_path,
        &save_body(CURRENT_SCHEMA_WIRE_VERSION, &corrupted),
    )
    .await;
    let text = String::from_utf8_lossy(&body);
    assert_eq!(
        status, "422",
        "an edited warning line must be refused, never stored: {text}"
    );
    assert!(
        text.contains("MissingPlaintextBanner"),
        "the refusal must name the plain-face error rather than a generic failure: {text}"
    );

    // Positive control: nothing was written.
    let latest = designs::read_version(
        &pool,
        &ring,
        estate.organisation,
        estate.steward.account,
        design,
        None,
    )
    .await;
    assert!(
        matches!(latest, Err(designs::DesignError::NoSuchVersion)),
        "the refused save must not have written a version: {latest:?}"
    );
}

#[tokio::test]
async fn a_payload_whose_prefix_disagrees_with_line_3_is_refused() {
    let _site = support::lock_the_site_chain().await;
    let pool = support::migrated_pool().await;
    let ring = ring();
    let estate = bootstrap(&pool, &ring).await;
    let (_scope, design) = a_scope_and_design(&pool, &estate).await;
    let drawer = a_member_with(&pool, &ring, &estate, "drawer", Some(Capability::Draw)).await;

    let addr = serve(app(&pool, Arc::clone(&ring), Vec::new()).await).await;

    let payload = a_plain_face_payload(5);
    let versions_path = format!(
        "/organisations/{}/designs/{}/versions?base=0",
        estate.organisation, design
    );
    let (status, body) = call(
        addr,
        &drawer,
        "POST",
        &versions_path,
        // The payload's own line 3 declares CURRENT_SCHEMA_WIRE_VERSION; the
        // wire prefix disagrees on purpose.
        &save_body(CURRENT_SCHEMA_WIRE_VERSION + 1, &payload),
    )
    .await;
    let text = String::from_utf8_lossy(&body);
    assert_eq!(
        status, "422",
        "a prefix that disagrees with line 3 must be refused, never stored: {text}"
    );
    assert!(
        text.contains("schema version"),
        "the refusal must name the disagreement rather than a generic failure: {text}"
    );

    let latest = designs::read_version(
        &pool,
        &ring,
        estate.organisation,
        estate.steward.account,
        design,
        None,
    )
    .await;
    assert!(
        matches!(latest, Err(designs::DesignError::NoSuchVersion)),
        "the refused save must not have written a version: {latest:?}"
    );
}

// ---------------------------------------------------------------------------
// ADR-0054 #1: a save names the version it was based on
// ---------------------------------------------------------------------------

#[tokio::test]
async fn a_save_with_no_base_at_all_is_refused_with_400() {
    let _site = support::lock_the_site_chain().await;
    let pool = support::migrated_pool().await;
    let ring = ring();
    let estate = bootstrap(&pool, &ring).await;
    let (_scope, design) = a_scope_and_design(&pool, &estate).await;
    let drawer = a_member_with(&pool, &ring, &estate, "drawer", Some(Capability::Draw)).await;

    let addr = serve(app(&pool, Arc::clone(&ring), Vec::new()).await).await;

    let versions_path = format!(
        "/organisations/{}/designs/{}/versions",
        estate.organisation, design
    );
    let (status, body) = call(
        addr,
        &drawer,
        "POST",
        &versions_path,
        &save_body(CURRENT_SCHEMA_WIRE_VERSION, &a_plain_face_payload(6)),
    )
    .await;
    assert_eq!(
        status,
        "400",
        "a save with no base at all must be refused, never treated as no precondition: {}",
        String::from_utf8_lossy(&body)
    );

    let latest = designs::read_version(
        &pool,
        &ring,
        estate.organisation,
        estate.steward.account,
        design,
        None,
    )
    .await;
    assert!(
        matches!(latest, Err(designs::DesignError::NoSuchVersion)),
        "the refused save must not have written a version: {latest:?}"
    );
}

#[tokio::test]
async fn a_save_with_a_non_integer_base_is_refused_with_400() {
    let _site = support::lock_the_site_chain().await;
    let pool = support::migrated_pool().await;
    let ring = ring();
    let estate = bootstrap(&pool, &ring).await;
    let (_scope, design) = a_scope_and_design(&pool, &estate).await;
    let drawer = a_member_with(&pool, &ring, &estate, "drawer", Some(Capability::Draw)).await;

    let addr = serve(app(&pool, Arc::clone(&ring), Vec::new()).await).await;

    let versions_path = format!(
        "/organisations/{}/designs/{}/versions?base=not-a-number",
        estate.organisation, design
    );
    let (status, _) = call(
        addr,
        &drawer,
        "POST",
        &versions_path,
        &save_body(CURRENT_SCHEMA_WIRE_VERSION, &a_plain_face_payload(7)),
    )
    .await;
    assert_eq!(status, "400");
}

/// The ADR's own two-session proof, all four of its clauses: A opens at
/// version 0 and saves; B, still holding base 0, is refused with a `409`
/// naming version 1 and sees A's own bytes on a fresh open, and the history
/// has exactly one entry; B reloads (base 1) and now saves; a stale base (7)
/// is refused; no base at all is a `400`.
#[tokio::test]
async fn two_sessions_saving_in_turn_get_adr_0054s_precondition() {
    let _site = support::lock_the_site_chain().await;
    let pool = support::migrated_pool().await;
    let ring = ring();
    let estate = bootstrap(&pool, &ring).await;
    let (_scope, design) = a_scope_and_design(&pool, &estate).await;
    let a = a_member_with(&pool, &ring, &estate, "session-a", Some(Capability::Draw)).await;
    let b = a_member_with(&pool, &ring, &estate, "session-b", Some(Capability::Draw)).await;

    let addr = serve(app(&pool, Arc::clone(&ring), Vec::new()).await).await;
    let versions_path = |base: &str| {
        format!(
            "/organisations/{}/designs/{}/versions?base={base}",
            estate.organisation, design
        )
    };

    // A, base 0 -> 200 "1".
    let (status, body) = call(
        addr,
        &a,
        "POST",
        &versions_path("0"),
        &save_body(CURRENT_SCHEMA_WIRE_VERSION, &a_plain_face_payload(8)),
    )
    .await;
    assert_eq!(status, "200", "{}", String::from_utf8_lossy(&body));
    assert_eq!(body, b"1\n");

    // B, still on base 0 -> 409 naming 1; open still returns A's bytes;
    // history has one entry.
    let b_payload = a_plain_face_payload(9);
    let (status, body) = call(
        addr,
        &b,
        "POST",
        &versions_path("0"),
        &save_body(CURRENT_SCHEMA_WIRE_VERSION, &b_payload),
    )
    .await;
    let text = String::from_utf8_lossy(&body);
    assert_eq!(status, "409", "{text}");
    assert!(
        text.contains("you opened version 0") && text.contains("it is now version 1"),
        "the refusal must name both numbers in one sentence: {text}"
    );
    assert!(text.contains("Reload"), "{text}");

    let open_path = format!("/organisations/{}/designs/{}", estate.organisation, design);
    let (status, body) = call(addr, &a, "GET", &open_path, b"").await;
    assert_eq!(status, "200");
    assert_eq!(
        body,
        a_plain_face_payload(8),
        "B's refused save must not have overwritten A's version"
    );

    let history_path = format!(
        "/organisations/{}/designs/{}/history",
        estate.organisation, design
    );
    let (status, body) = call(addr, &a, "GET", &history_path, b"").await;
    assert_eq!(status, "200");
    let history_text = String::from_utf8_lossy(&body);
    assert_eq!(
        history_text.matches("\"seq\":").count(),
        1,
        "B's refused save must not have appended a chain entry either: {history_text}"
    );

    // B reloads (base 1) -> 200 "2".
    let (status, body) = call(
        addr,
        &b,
        "POST",
        &versions_path("1"),
        &save_body(CURRENT_SCHEMA_WIRE_VERSION, &b_payload),
    )
    .await;
    assert_eq!(status, "200", "{}", String::from_utf8_lossy(&body));
    assert_eq!(body, b"2\n");

    // B, a stale base -> 409.
    let (status, body) = call(
        addr,
        &b,
        "POST",
        &versions_path("7"),
        &save_body(CURRENT_SCHEMA_WIRE_VERSION, &b_payload),
    )
    .await;
    assert_eq!(status, "409", "{}", String::from_utf8_lossy(&body));

    // No base at all -> 400.
    let no_base_path = format!(
        "/organisations/{}/designs/{}/versions",
        estate.organisation, design
    );
    let (status, _) = call(
        addr,
        &b,
        "POST",
        &no_base_path,
        &save_body(CURRENT_SCHEMA_WIRE_VERSION, &b_payload),
    )
    .await;
    assert_eq!(status, "400");
}

#[tokio::test]
async fn a_reader_cannot_save_but_can_still_open_and_verify() {
    let _site = support::lock_the_site_chain().await;
    let pool = support::migrated_pool().await;
    let ring = ring();
    let estate = bootstrap(&pool, &ring).await;
    let (_scope, design) = a_scope_and_design(&pool, &estate).await;
    designs::write_version(
        &pool,
        &ring,
        estate.organisation,
        estate.steward.account,
        design,
        b"already on file before the reader ever shows up",
        1,
    )
    .await
    .expect("seed a version");
    let reader = a_member_with(&pool, &ring, &estate, "reader", Some(Capability::Read)).await;

    let addr = serve(app(&pool, Arc::clone(&ring), Vec::new()).await).await;

    let open_path = format!("/organisations/{}/designs/{}", estate.organisation, design);
    let (status, body) = call(addr, &reader, "GET", &open_path, b"").await;
    assert_eq!(
        status,
        "200",
        "read holds at least read: {}",
        String::from_utf8_lossy(&body)
    );

    let verify_path = format!(
        "/organisations/{}/designs/{}/verify",
        estate.organisation, design
    );
    let (status, body) = call(addr, &reader, "GET", &verify_path, b"").await;
    assert_eq!(status, "200");
    let text = String::from_utf8_lossy(&body);
    assert!(text.contains("\"outcome\":\"verified\""), "{text}");

    // ADR-0052 §5, this session's brief item 1 ("canDraw = capability !==
    // 'read'"): the client gate the drawing/editor apply is proven honest
    // only if the server refuses the save it is meant to stop a reader from
    // ever reaching in the first place — this function's own name has
    // promised exactly that since it was written, but the body above never
    // actually attempted one, so the promise was untested. Completed here
    // rather than left beside `a_read_only_caller_is_refused_a_save_and_the_refusal_does_not_leak_whether_the_design_exists`
    // (which proves the same 403 against a *fresh* design with no prior
    // version) — this one proves it against a design the reader can already
    // open and verify, so a version already on file is not itself what was
    // making the read-only save win nothing: it never reaches version 2.
    let versions_path = format!(
        "/organisations/{}/designs/{}/versions?base=1",
        estate.organisation, design
    );
    let save_attempt = save_body(CURRENT_SCHEMA_WIRE_VERSION, &a_plain_face_payload(2));
    let (save_status, save_body_bytes) =
        call(addr, &reader, "POST", &versions_path, &save_attempt).await;
    assert_eq!(
        save_status,
        "403",
        "a reader's save must be refused: {}",
        String::from_utf8_lossy(&save_body_bytes)
    );

    // Positive control: the version this test seeded before the reader ever
    // showed up is still the latest one — the refused save neither replaced
    // it nor landed beside it as a second version.
    let latest = designs::read_version(
        &pool,
        &ring,
        estate.organisation,
        estate.steward.account,
        design,
        None,
    )
    .await
    .expect("the seeded version is still readable");
    assert_eq!(
        latest.version, 1,
        "the reader's refused save must not have written version 2"
    );
}

#[tokio::test]
async fn verify_reports_broken_at_the_tampered_entry() {
    let _site = support::lock_the_site_chain().await;
    let pool = support::migrated_pool().await;
    let ring = ring();
    let estate = bootstrap(&pool, &ring).await;
    let (_scope, design) = a_scope_and_design(&pool, &estate).await;
    for n in 1..=2 {
        designs::write_version(
            &pool,
            &ring,
            estate.organisation,
            estate.steward.account,
            design,
            format!("v{n}").as_bytes(),
            1,
        )
        .await
        .expect("write");
    }

    // The same tamper `tests/design_storage.rs` uses to prove the same
    // claim against `designs::verify_design` directly: a database-write
    // attacker with no chain key, caught without decrypting anything.
    let su = support::superuser_client_on_test_database().await;
    let changed = support::tamper(
        &su,
        "chain_entries",
        "UPDATE chain_entries SET metadata = $2 WHERE design_id = $1 AND seq = 2",
        &[
            &design.to_string(),
            &br#"{"actor":"someone else"}"#.to_vec(),
        ],
    )
    .await;
    assert_eq!(changed, 1);

    let addr = serve(app(&pool, Arc::clone(&ring), Vec::new()).await).await;

    let verify_path = format!(
        "/organisations/{}/designs/{}/verify",
        estate.organisation, design
    );
    let (status, body) = call(addr, &estate.steward, "GET", &verify_path, b"").await;
    assert_eq!(status, "200");
    let text = String::from_utf8_lossy(&body);
    assert!(text.contains("\"outcome\":\"broken_at\""), "{text}");
    assert!(text.contains("\"seq\":2"), "{text}");
    assert!(
        text.contains("\"verified_before\":1"),
        "entry 1 must still report verified: {text}"
    );
}

// ---------------------------------------------------------------------------
// The catalogue needs a session
// ---------------------------------------------------------------------------

#[tokio::test]
async fn the_catalogue_routes_refuse_an_unsigned_request() {
    let _site = support::lock_the_site_chain().await;
    let pool = support::migrated_pool().await;
    let ring = ring();

    let addr = serve(app(&pool, ring, Vec::new()).await).await;

    let (status, _) = raw_request(addr, "GET", "/catalogue/models", &[], b"").await;
    assert_eq!(
        status, "401",
        "the catalogue is public reference data, but it still sits behind a session"
    );
}

#[tokio::test]
async fn a_signed_in_caller_reads_the_catalogue_list_and_one_models_full_detail() {
    let _site = support::lock_the_site_chain().await;
    let pool = support::migrated_pool().await;
    let ring = ring();
    let estate = bootstrap(&pool, &ring).await;

    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .nth(2)
        .expect("the crate lives two levels under the repo root")
        .to_path_buf();
    let models = design_api::load_catalogue(&root).expect("load the real corpus catalogue");
    assert!(
        !models.is_empty(),
        "the corpus must carry at least one model for this to test anything"
    );
    let first = models[0].clone();

    let addr = serve(app(&pool, ring, models).await).await;

    let (status, body) = call(addr, &estate.steward, "GET", "/catalogue/models", b"").await;
    assert_eq!(status, "200");
    let text = String::from_utf8_lossy(&body);
    assert!(
        text.contains(&format!("\"vendor\":\"{}\"", first.vendor)),
        "{text}"
    );

    let path = format!("/catalogue/models/{}/{}", first.vendor, first.model);
    let (status, body) = call(addr, &estate.steward, "GET", &path, b"").await;
    assert_eq!(status, "200", "{}", String::from_utf8_lossy(&body));
    let text = String::from_utf8_lossy(&body);
    assert!(text.contains("\"ports\":["), "{text}");
    assert!(
        !text.contains("\"kind\":\"SFP+\"")
            || first
                .faceplates
                .iter()
                .any(|f| f.groups.iter().any(|g| g.kind.token() == "SFP+")),
        "must not invent a port kind the model does not have"
    );

    // The tower UPS's NEMA outlets round-trip through the same route, with
    // the lowercase `nema_5_15r` token PortKind::token() sends over the wire
    // (crates/fathom-corpus/src/catalogue.rs) — not the connector's own
    // "NEMA 5-15R" spelling.
    let ups_path = "/catalogue/models/cyberpower/PR1500LCDRT2U";
    let (status, body) = call(addr, &estate.steward, "GET", ups_path, b"").await;
    assert_eq!(status, "200", "{}", String::from_utf8_lossy(&body));
    let ups_text = String::from_utf8_lossy(&body);
    assert!(ups_text.contains("\"kind\":\"nema_5_15r\""), "{ups_text}");
    assert!(!ups_text.contains("\"kind\":\"NEMA 5-15R\""), "{ups_text}");

    // The shelf and the outlet box both round-trip too — the catalogue list
    // must carry every vendor directory `load_catalogue` found, not just the
    // one `first` happened to be.
    let (status, list_body) = call(addr, &estate.steward, "GET", "/catalogue/models", b"").await;
    assert_eq!(status, "200");
    let list_text = String::from_utf8_lossy(&list_body);
    assert!(
        list_text.contains("\"model\":\"SRSHELF2P1U\""),
        "{list_text}"
    );
    assert!(
        list_text.contains("\"model\":\"IC107SBTWH\""),
        "{list_text}"
    );
}

// ---------------------------------------------------------------------------
// GET /organisations — which tenants the signed-in account belongs to
// ---------------------------------------------------------------------------

fn contains_org(text: &str, id: OrganisationId) -> bool {
    text.contains(&format!("\"organisation_id\":\"{id}\""))
}

/// Enrol a key on the site chain at "invitation" time, exactly as an account
/// with no organisation yet would be enrolled (`grants::enrol_software_key_at_invitation`'s
/// own doc: "the first key of an invited person is enrolled before any
/// organisation knows their name"). Needed for the "belongs to none" case
/// below, since `enrol` (this file's other fixture) opens a tenant context
/// and so requires a membership that a lonely account does not have.
async fn enrol_at_invitation(pool: &Pool, ring: &KeyRing, person: &Person) {
    let client = pool.get().await.expect("connection");
    let deployment = chains::deployment_id(&**client)
        .await
        .expect("this deployment is stamped");
    drop(client);

    let mut client = pool.get().await.expect("connection");
    let tx = client.transaction().await.expect("begin");
    // `account_keys_insertable` (`0011_authority.sql`) checks `account_id =
    // app.account_id`; the token-redemption path this mirrors sets it from
    // the token's own row (`operators.rs`'s `set_account_id`) for the same
    // reason.
    tx.execute(
        "SELECT set_config('app.account_id', $1, true)",
        &[&person.account.to_string()],
    )
    .await
    .expect("set app.account_id");
    grants::enrol_software_key_at_invitation(
        &tx,
        ring,
        &deployment,
        &person.account.to_string(),
        &person.key.public_key(),
    )
    .await
    .expect("enrol at invitation");
    tx.commit().await.expect("commit");
}

#[tokio::test]
async fn an_account_sees_exactly_the_organisations_it_belongs_to_and_none_it_does_not() {
    let _site = support::lock_the_site_chain().await;
    let pool = support::migrated_pool().await;
    let ring = ring();

    let estate_a = bootstrap(&pool, &ring).await;
    let estate_b = bootstrap(&pool, &ring).await;

    // estate_b's steward is ALSO a member of A -- one account, two
    // organisations. Membership alone is enough for this route: the account's
    // key, enrolled once in `bootstrap`, is account-scoped, not
    // organisation-scoped (`grants::insert_account_key`'s own doc), so no
    // second enrolment is needed to sign in.
    repo::add_member(
        &pool,
        estate_a.organisation,
        estate_a.steward.account,
        estate_b.steward.account,
        repo::Role::Member,
    )
    .await
    .expect("add estate_b's steward to A as well");

    let addr = serve(app(&pool, Arc::clone(&ring), Vec::new()).await).await;

    // The account in two organisations sees exactly both.
    let (status, body) = call(addr, &estate_b.steward, "GET", "/organisations", b"").await;
    assert_eq!(status, "200", "{}", String::from_utf8_lossy(&body));
    let text = String::from_utf8_lossy(&body);
    assert!(
        contains_org(&text, estate_a.organisation) && contains_org(&text, estate_b.organisation),
        "an account in both organisations must see both: {text}"
    );
    assert_eq!(
        text.matches("\"organisation_id\":\"").count(),
        2,
        "and exactly those two, no more: {text}"
    );

    // The assertion that matters: the account that belongs ONLY to A must
    // never see B, even though B exists and this same database just proved
    // another account can see it. If RLS's `account_id` branch were bypassed
    // this would silently return every organisation in the database instead.
    let (status, body) = call(addr, &estate_a.steward, "GET", "/organisations", b"").await;
    assert_eq!(status, "200", "{}", String::from_utf8_lossy(&body));
    let text = String::from_utf8_lossy(&body);
    assert!(
        contains_org(&text, estate_a.organisation),
        "must still see its own organisation: {text}"
    );
    assert!(
        !contains_org(&text, estate_b.organisation),
        "an account must never see an organisation it is not a member of: {text}"
    );
    assert_eq!(text.matches("\"organisation_id\":\"").count(), 1, "{text}");
}

#[tokio::test]
async fn an_account_that_belongs_to_no_organisation_gets_an_empty_list() {
    let _site = support::lock_the_site_chain().await;
    let pool = support::migrated_pool().await;
    let ring = ring();

    let lonely = an_account(&pool, "lonely").await;
    enrol_at_invitation(&pool, &ring, &lonely).await;

    let addr = serve(app(&pool, Arc::clone(&ring), Vec::new()).await).await;

    let (status, body) = call(addr, &lonely, "GET", "/organisations", b"").await;
    assert_eq!(status, "200", "{}", String::from_utf8_lossy(&body));
    assert_eq!(
        body,
        b"[]\n",
        "an account in no organisation gets an empty list, not an error: {}",
        String::from_utf8_lossy(&body)
    );
}

#[tokio::test]
async fn organisations_refuses_unsigned_and_badly_signed_requests_like_every_other_route() {
    let _site = support::lock_the_site_chain().await;
    let pool = support::migrated_pool().await;
    let ring = ring();
    let estate = bootstrap(&pool, &ring).await;

    let addr = serve(app(&pool, Arc::clone(&ring), Vec::new()).await).await;

    let (status, _) = raw_request(addr, "GET", "/organisations", &[], b"").await;
    assert_eq!(
        status, "401",
        "an unsigned request must be refused before any handler runs, exactly like every other \
         signed route"
    );

    let (status, _) = call_badly_signed(addr, &estate.steward, "GET", "/organisations", b"").await;
    assert_eq!(
        status, "401",
        "a session that is real but a signature that does not verify must be refused the same \
         way an unsigned request is"
    );
}

/// **The finding this guards:** every route through `design_api::Signed`
/// used to read its body at `design_api::MAX_SIGNED_BODY` (64 MiB) before
/// `begin_request` -- the nonce spend and the signature check -- ever ran, so
/// a caller who never held a valid session, presenting headers of the right
/// SHAPE (this test's own signature is real cryptographic garbage: a
/// well-formed session and a bit flipped in the signature, exactly
/// `call_badly_signed`'s own shape), could still make this process buffer 64
/// MiB on a plain `GET /organisations`, which has no legitimate body at all.
///
/// The proof is a comparison, not a guess about what is happening inside the
/// server: `organisations_refuses_unsigned_and_badly_signed_requests_like_every_other_route`
/// (immediately above) sends the IDENTICAL bad signature with an EMPTY body
/// and gets `401` -- the signature was checked and failed. Here, the same bad
/// signature with a 2 MiB body -- comfortably over `api::MAX_SIGNED_BODY`'s
/// one mebibyte this route reads at, comfortably under the 64 MiB the two
/// write routes are allowed (`design_api::is_large_body_route`, and
/// `/organisations` is not one of them) -- must come back `400`, the fixed
/// `malformed request` sentence `axum::body::to_bytes` exceeding its cap
/// produces, and MUST NOT come back `401`: a `401` here would mean the whole
/// 2 MiB was buffered and a signature check was even attempted, which is
/// exactly the finding.
#[tokio::test]
async fn a_two_mebibyte_body_with_an_invented_signature_is_refused_by_the_cap_before_the_signature_is_ever_checked(
) {
    let _site = support::lock_the_site_chain().await;
    let pool = support::migrated_pool().await;
    let ring = ring();
    let estate = bootstrap(&pool, &ring).await;

    let addr = serve(app(&pool, Arc::clone(&ring), Vec::new()).await).await;

    let body = vec![0u8; 2 * 1024 * 1024];
    let (status, response) =
        call_badly_signed(addr, &estate.steward, "GET", "/organisations", &body).await;
    assert_eq!(
        status, "400",
        "the small cap must refuse this body before begin_request runs at all -- NOT the 401 \
         the identical bad signature earns over an empty body once begin_request actually \
         checks it"
    );
    assert_eq!(
        String::from_utf8_lossy(&response),
        "malformed request\n",
        "the fixed sentence `api::Refusal` gives every `SessionError::Malformed`, which is what \
         a body over `axum::body::to_bytes`'s cap produces"
    );
}

/// The residual the module doc now states explicitly: `is_large_body_route`
/// narrows which routes read at the 64 MiB cap, it does not require
/// authority first. A bad signature over a 2 MiB body -- comfortably over
/// `api::MAX_SIGNED_BODY`'s one mebibyte, comfortably under the 64 MiB this
/// route is allowed -- to `POST .../versions` must still come back `401`,
/// not `400`: a `400` would mean the small cap caught it, which would mean
/// this is not actually one of the two large-body routes any more. The body
/// must be a well-formed plain-face payload, not arbitrary bytes: this
/// handler's own [`validate_payload`] parses and credential-scans the body
/// BEFORE `signed.verify` ever runs (its own doc: "a malformed request costs
/// nothing from the database either way"), so a body that fails to parse
/// answers `422` without ever reaching the signature check at all -- a
/// second, worse-shaped instance of the same residual (parsing runs before
/// authority too), not exercised by this test. `401` here proves the whole
/// 2 MiB was parsed AND buffered and a signature check was attempted against
/// invented header values, before any session was looked up -- exactly the
/// residual the module doc names, recorded rather than left implied closed.
#[tokio::test]
async fn a_two_mebibyte_body_with_an_invented_signature_on_a_large_body_route_is_still_buffered_before_the_signature_is_checked(
) {
    let _site = support::lock_the_site_chain().await;
    let pool = support::migrated_pool().await;
    let ring = ring();
    let estate = bootstrap(&pool, &ring).await;
    let (_scope, design) = a_scope_and_design(&pool, &estate).await;

    let addr = serve(app(&pool, Arc::clone(&ring), Vec::new()).await).await;
    let versions_path = format!(
        "/organisations/{}/designs/{}/versions?base=0",
        estate.organisation, design
    );

    // A valid, large plain-face payload: a 2 MiB `Capture.text` of ordinary
    // words, so `validate_payload` accepts it and the request reaches
    // `signed.verify`, the thing this test actually checks. Not `"x"`
    // repeated with no separator -- that is one giant token, and
    // `looks_like_credential_bare`'s own `base64ish` shape detector (any
    // run of 24+ base64-alphabet characters) trips on it, which would make
    // this test measure a credential-detector false positive instead of the
    // signature-check residual it is for.
    let big_line = "filler ".repeat(2 * 1024 * 1024 / "filler ".len());
    let capture_payload = a_payload_with_capture_text(310, &big_line);
    let body = save_body(CURRENT_SCHEMA_WIRE_VERSION, &capture_payload);
    let (status, _response) =
        call_badly_signed(addr, &estate.steward, "POST", &versions_path, &body).await;
    assert_eq!(
        status, "401",
        "a 2 MiB body on a large-body route must still be buffered, parsed and reach the \
         signature check -- a 400 or 422 here would mean it never got that far"
    );
}

// ---------------------------------------------------------------------------
// GET /organisations/{organisation}/scopes — D11
// ---------------------------------------------------------------------------

#[tokio::test]
async fn a_steward_sees_every_scope_in_the_organisation_in_path_order_root_first() {
    let _site = support::lock_the_site_chain().await;
    let pool = support::migrated_pool().await;
    let ring = ring();
    let estate = bootstrap(&pool, &ring).await;
    let (network, building_a, building_b, rack_under_a) = a_scope_tree(&pool, &estate).await;

    let addr = serve(app(&pool, Arc::clone(&ring), Vec::new()).await).await;
    let path = format!("/organisations/{}/scopes", estate.organisation);
    let (status, body) = call(addr, &estate.steward, "GET", &path, b"").await;
    assert_eq!(status, "200", "{}", String::from_utf8_lossy(&body));
    let text = String::from_utf8_lossy(&body).into_owned();

    for scope in [network, building_a, building_b, rack_under_a] {
        assert!(
            text.contains(&format!("\"scope_id\":\"{scope}\"")),
            "every scope in the organisation must be present: missing {scope}: {text}"
        );
    }
    // Object keys are a `BTreeMap`, so alphabetical: "parent_scope_id" is
    // always immediately followed by "path" in the emitted JSON.
    assert!(
        text.contains(&format!("\"parent_scope_id\":null,\"path\":\"{network}\"")),
        "the root's parent_scope_id must be JSON null: {text}"
    );

    // Root first, path order: the network's own row must appear before
    // either building's, and each building's row before the rack under it.
    let at = |needle: &str| {
        text.find(needle)
            .unwrap_or_else(|| panic!("{needle} not found in {text}"))
    };
    let network_at = at(&format!("\"scope_id\":\"{network}\""));
    let building_a_at = at(&format!("\"scope_id\":\"{building_a}\""));
    let building_b_at = at(&format!("\"scope_id\":\"{building_b}\""));
    let rack_at = at(&format!("\"scope_id\":\"{rack_under_a}\""));
    assert!(
        network_at < building_a_at && network_at < building_b_at,
        "the root must be listed before its children: {text}"
    );
    assert!(
        building_a_at < rack_at,
        "a parent must be listed before its own descendant: {text}"
    );
}

/// **The finding this guards:** `list_scopes_handler` used to call
/// `grants::authorise_account` once per row, and that function does §3.4's
/// whole seven steps from scratch every time -- steps 2 through 5 read and
/// verify the organisation's entire authority head, state and genesis, none
/// of which depends on which row is being checked. A hundred scopes in one
/// organisation meant that work done a hundred times over one list. This
/// asserts the fix directly, by counting: `grants::verify_authority_state`
/// (steps 2-5) must run exactly ONCE for this whole list, no matter how many
/// scopes are in it -- `grants::verify_authority_state_calls` is instrumented
/// for exactly this (see its own doc).
#[tokio::test]
async fn listing_a_hundred_scopes_verifies_the_whole_authority_state_once_not_once_per_row() {
    let _site = support::lock_the_site_chain().await;
    let pool = support::migrated_pool().await;
    let ring = ring();
    let estate = bootstrap(&pool, &ring).await;

    let network = repo::create_scope(
        &pool,
        estate.organisation,
        estate.steward.account,
        None,
        ScopeKind::Network,
        &unique("net-100"),
    )
    .await
    .expect("create network")
    .id;
    let building = repo::create_scope(
        &pool,
        estate.organisation,
        estate.steward.account,
        Some(network),
        ScopeKind::Building,
        &unique("building-100"),
    )
    .await
    .expect("create building")
    .id;
    for i in 0..100 {
        repo::create_scope(
            &pool,
            estate.organisation,
            estate.steward.account,
            Some(building),
            ScopeKind::Rack,
            &unique(&format!("rack-{i}")),
        )
        .await
        .expect("create rack");
    }

    let addr = serve(app(&pool, Arc::clone(&ring), Vec::new()).await).await;
    let path = format!("/organisations/{}/scopes", estate.organisation);
    let organisation = estate.organisation.to_string();

    let before = grants::verify_authority_state_calls(&organisation);
    let (status, body) = call(addr, &estate.steward, "GET", &path, b"").await;
    assert_eq!(status, "200", "{}", String::from_utf8_lossy(&body));
    let after = grants::verify_authority_state_calls(&organisation);

    let text = String::from_utf8_lossy(&body).into_owned();
    let rows = text.matches("\"scope_id\":").count();
    assert_eq!(
        rows, 102,
        "network, building and 100 racks -- every row must still be listed: {text}"
    );
    assert_eq!(
        after - before,
        1,
        "one verification for the whole list of {rows} scopes, not one per row"
    );
}

#[tokio::test]
async fn an_account_granted_read_on_one_child_scope_sees_only_that_subtree_not_its_parent_or_siblings(
) {
    let _site = support::lock_the_site_chain().await;
    let pool = support::migrated_pool().await;
    let ring = ring();
    let estate = bootstrap(&pool, &ring).await;
    let (network, building_a, building_b, rack_under_a) = a_scope_tree(&pool, &estate).await;

    let narrow = a_member_with_scope(
        &pool,
        &ring,
        &estate,
        "narrow",
        building_a,
        Capability::Read,
    )
    .await;

    let addr = serve(app(&pool, Arc::clone(&ring), Vec::new()).await).await;
    let path = format!("/organisations/{}/scopes", estate.organisation);
    let (status, body) = call(addr, &narrow, "GET", &path, b"").await;
    assert_eq!(status, "200", "{}", String::from_utf8_lossy(&body));
    let text = String::from_utf8_lossy(&body).into_owned();

    // The assertion that matters: the granted scope and its own descendant
    // are present...
    assert!(
        text.contains(&format!("\"scope_id\":\"{building_a}\"")),
        "the scope the grant covers must be present: {text}"
    );
    assert!(
        text.contains(&format!("\"scope_id\":\"{rack_under_a}\"")),
        "a descendant of the granted scope must be present too: {text}"
    );
    // ...but its parent and its sibling, which exist in this same
    // organisation and were just proven present for the steward, must be
    // absent — not present-but-marked-forbidden, simply absent.
    assert!(
        !text.contains(&format!("\"scope_id\":\"{network}\"")),
        "the granted scope's parent must be absent even though it exists: {text}"
    );
    assert!(
        !text.contains(&format!("\"scope_id\":\"{building_b}\"")),
        "a sibling scope must be absent even though it exists: {text}"
    );

    // The positive control: the steward sees all four, proving the omission
    // above is about capability and not a broken tree.
    let (status, body) = call(addr, &estate.steward, "GET", &path, b"").await;
    assert_eq!(status, "200");
    let text = String::from_utf8_lossy(&body);
    for scope in [network, building_a, building_b, rack_under_a] {
        assert!(
            text.contains(&format!("\"scope_id\":\"{scope}\"")),
            "the steward, unlike the narrow grant above, must see every scope: {text}"
        );
    }
}

#[tokio::test]
async fn an_account_with_no_grant_in_the_organisation_gets_an_empty_scope_list() {
    // Matches `list_designs_handler`'s own answer to the identical question
    // (`a_caller_with_no_capability_gets_a_list_that_omits_the_design_entirely`,
    // above): a member with no grant sees `[]`, not a refusal. Membership
    // alone opens the tenant context; `authorise_account` is what actually
    // gates every row, and it is called per scope here exactly as it is
    // called per design there.
    let _site = support::lock_the_site_chain().await;
    let pool = support::migrated_pool().await;
    let ring = ring();
    let estate = bootstrap(&pool, &ring).await;
    let _tree = a_scope_tree(&pool, &estate).await;
    let outsider = a_member_with(&pool, &ring, &estate, "outsider", None).await;

    let addr = serve(app(&pool, Arc::clone(&ring), Vec::new()).await).await;
    let path = format!("/organisations/{}/scopes", estate.organisation);
    let (status, body) = call(addr, &outsider, "GET", &path, b"").await;
    assert_eq!(status, "200", "{}", String::from_utf8_lossy(&body));
    assert_eq!(
        body,
        b"[]\n",
        "a member with no grant must see an empty list, not scopes marked forbidden: {}",
        String::from_utf8_lossy(&body)
    );
}

#[tokio::test]
async fn scopes_refuses_unsigned_and_badly_signed_requests_like_every_other_route() {
    let _site = support::lock_the_site_chain().await;
    let pool = support::migrated_pool().await;
    let ring = ring();
    let estate = bootstrap(&pool, &ring).await;
    let _tree = a_scope_tree(&pool, &estate).await;

    let addr = serve(app(&pool, Arc::clone(&ring), Vec::new()).await).await;
    let path = format!("/organisations/{}/scopes", estate.organisation);

    let (status, _) = raw_request(addr, "GET", &path, &[], b"").await;
    assert_eq!(
        status, "401",
        "an unsigned request must be refused before any handler runs, exactly like every other \
         signed route"
    );

    let (status, _) = call_badly_signed(addr, &estate.steward, "GET", &path, b"").await;
    assert_eq!(
        status, "401",
        "a session that is real but a signature that does not verify must be refused the same \
         way an unsigned request is"
    );
}

// ---------------------------------------------------------------------------
// ADR-0054 #2: a drawer creates a design on a scope, in one transaction
// ---------------------------------------------------------------------------

/// The client's own `emptyDocument()` (`client/src/document/model.ts`),
/// carried through `fathom_workspace::write_plain` exactly as a real drawer
/// creating a design would send it.
fn empty_document_payload() -> Vec<u8> {
    fathom_workspace::write_plain(&Graph::new()).expect("an empty graph writes")
}

#[tokio::test]
async fn a_drawer_creates_a_design_on_a_scope_and_a_reader_is_refused() {
    let _site = support::lock_the_site_chain().await;
    let pool = support::migrated_pool().await;
    let ring = ring();
    let estate = bootstrap(&pool, &ring).await;
    let scope = repo::create_scope(
        &pool,
        estate.organisation,
        estate.steward.account,
        None,
        ScopeKind::Network,
        &unique("net"),
    )
    .await
    .expect("scope");
    let drawer = a_member_with(&pool, &ring, &estate, "drawer", Some(Capability::Draw)).await;
    let reader = a_member_with(&pool, &ring, &estate, "reader", Some(Capability::Read)).await;

    let addr = serve(app(&pool, Arc::clone(&ring), Vec::new()).await).await;
    let path = format!(
        "/organisations/{}/scopes/{}/designs",
        estate.organisation, scope.id
    );
    let body = save_body(CURRENT_SCHEMA_WIRE_VERSION, &empty_document_payload());

    // A reader is refused, and nothing is created for the attempt.
    let (status, resp) = call(addr, &reader, "POST", &path, &body).await;
    assert_eq!(status, "403", "{}", String::from_utf8_lossy(&resp));

    // A drawer succeeds and gets the design list's own element shape back.
    let (status, resp) = call(addr, &drawer, "POST", &path, &body).await;
    assert_eq!(status, "200", "{}", String::from_utf8_lossy(&resp));
    let text = String::from_utf8_lossy(&resp).into_owned();
    assert!(
        text.contains(&format!("\"scope_id\":\"{}\"", scope.id)),
        "{text}"
    );
    assert!(text.contains("\"latest_version\":1"), "{text}");
    assert!(
        text.contains(&format!("\"capability\":\"{}\"", Capability::Draw.as_str())),
        "{text}"
    );

    // The design and its first version were both actually created, in one
    // transaction: opening it returns the empty document, not "no such
    // version" -- a bodiless design was never minted.
    let design_id_text = text
        .split("\"design_id\":\"")
        .nth(1)
        .and_then(|s| s.split('"').next())
        .expect("a design_id in the answer")
        .to_string();
    let open_path = format!(
        "/organisations/{}/designs/{}",
        estate.organisation, design_id_text
    );
    let (status, opened) = call(addr, &drawer, "GET", &open_path, b"").await;
    assert_eq!(status, "200");
    assert_eq!(opened, empty_document_payload());

    // Exactly one design exists: the refused reader attempt created none of
    // its own.
    let list_path = format!("/organisations/{}/designs", estate.organisation);
    let (status, list_body) = call(addr, &estate.steward, "GET", &list_path, b"").await;
    assert_eq!(status, "200");
    let list_text = String::from_utf8_lossy(&list_body);
    assert_eq!(
        list_text.matches("\"design_id\":").count(),
        1,
        "the refused reader attempt must not have created a design of its own: {list_text}"
    );
}

#[tokio::test]
async fn creating_a_design_on_a_foreign_or_missing_scope_answers_like_one_that_never_existed() {
    let _site = support::lock_the_site_chain().await;
    let pool = support::migrated_pool().await;
    let ring = ring();
    let estate = bootstrap(&pool, &ring).await;
    let drawer = a_member_with(&pool, &ring, &estate, "drawer", Some(Capability::Draw)).await;

    let addr = serve(app(&pool, Arc::clone(&ring), Vec::new()).await).await;
    let body = save_body(CURRENT_SCHEMA_WIRE_VERSION, &empty_document_payload());

    // A scope id nothing was ever created under.
    let missing = ScopeId(fathom_server::ids::new_ulid());
    let missing_path = format!(
        "/organisations/{}/scopes/{}/designs",
        estate.organisation, missing
    );
    let (missing_status, missing_body) = call(addr, &drawer, "POST", &missing_path, &body).await;

    // A scope that is real, but in a different organisation entirely.
    let estate_b = bootstrap(&pool, &ring).await;
    let scope_b = repo::create_scope(
        &pool,
        estate_b.organisation,
        estate_b.steward.account,
        None,
        ScopeKind::Network,
        &unique("net"),
    )
    .await
    .expect("scope in B");
    let foreign_path = format!(
        "/organisations/{}/scopes/{}/designs",
        estate.organisation, scope_b.id
    );
    let (foreign_status, foreign_body) = call(addr, &drawer, "POST", &foreign_path, &body).await;

    assert_eq!(
        missing_status,
        "403",
        "{}",
        String::from_utf8_lossy(&missing_body)
    );
    assert_eq!(missing_status, foreign_status);
    assert_eq!(
        missing_body, foreign_body,
        "a missing scope and a foreign one must answer identically"
    );
}

#[tokio::test]
async fn creating_a_design_past_the_spool_bound_leaves_no_row() {
    let _site = support::lock_the_site_chain().await;
    let pool = support::migrated_pool().await;
    let ring = ring();
    let estate = bootstrap(&pool, &ring).await;
    let scope = repo::create_scope(
        &pool,
        estate.organisation,
        estate.steward.account,
        None,
        ScopeKind::Network,
        &unique("net"),
    )
    .await
    .expect("scope");

    // Seed the spool so it is not empty, under the real defaults -- the
    // positive control `tests/audit_chains.rs` uses for the same claim
    // against a save.
    let seed_design =
        designs::create_design(&pool, estate.organisation, estate.steward.account, scope.id)
            .await
            .expect("seed design");
    designs::write_version_under(
        &pool,
        &ring,
        estate.organisation,
        estate.steward.account,
        seed_design,
        b"seed",
        1,
        audit::SpoolBounds::defaults(),
    )
    .await
    .expect("seed write");

    let mut client = pool.get().await.expect("connection");
    let tx = client.transaction().await.expect("begin");
    let ctx = repo::open_tenant_context(&tx, estate.organisation, estate.steward.account)
        .await
        .expect("ctx");
    let tenant_key = keys::tenant_key(&tx, &ring, &ctx)
        .await
        .expect("tenant key");
    let watch = EpochWatch::new();
    let auth = Authority {
        ring: &ring,
        ctx: &ctx,
        tenant_key: &tenant_key,
        watch: &watch,
    };

    let beyond = audit::SpoolBounds {
        max_age: audit::SpoolBounds::DEFAULT_MAX_AGE,
        max_bytes: 1,
    };
    let err = designs::create_design_with_first_version_in_tx(
        &tx,
        &auth,
        scope.id,
        &empty_document_payload(),
        CURRENT_SCHEMA_WIRE_VERSION as i32,
        &beyond,
    )
    .await
    .expect_err("past the bound, a create must be refused");
    assert!(
        matches!(err, designs::DesignError::AuditSpoolBeyondBounds { .. }),
        "{err:?}"
    );
    tx.rollback().await.expect("rollback");

    // No row: exactly the one design this test itself seeded, and no more.
    let su = support::superuser_client_on_test_database().await;
    let count: i64 = su
        .query_one(
            "SELECT count(*) FROM designs WHERE scope_id = $1",
            &[&scope.id.to_string()],
        )
        .await
        .expect("count")
        .get(0);
    assert_eq!(
        count, 1,
        "a create refused for the spool bound must leave no design row behind"
    );
}

// ---------------------------------------------------------------------------
// ADR-0054 #3: a steward of the parent creates a scope
// ---------------------------------------------------------------------------

fn scope_create_body(parent: Option<ScopeId>, label: &str) -> Vec<u8> {
    let mut body = Vec::new();
    lp(
        &mut body,
        parent.map(|p| p.to_string()).unwrap_or_default().as_bytes(),
    );
    lp(&mut body, label.as_bytes());
    body
}

#[tokio::test]
async fn a_steward_creates_scopes_down_the_tree_and_a_drawer_is_refused() {
    let _site = support::lock_the_site_chain().await;
    let pool = support::migrated_pool().await;
    let ring = ring();
    let estate = bootstrap(&pool, &ring).await;
    let drawer = a_member_with(&pool, &ring, &estate, "drawer", Some(Capability::Draw)).await;

    let addr = serve(app(&pool, Arc::clone(&ring), Vec::new()).await).await;
    let path = format!("/organisations/{}/scopes", estate.organisation);

    // A drawer, even organisation-wide, may not create a root network.
    let net_label = unique("net");
    let (status, body) = call(
        addr,
        &drawer,
        "POST",
        &path,
        &scope_create_body(None, &net_label),
    )
    .await;
    assert_eq!(status, "403", "{}", String::from_utf8_lossy(&body));

    // A steward of the organisation creates the root network.
    let (status, body) = call(
        addr,
        &estate.steward,
        "POST",
        &path,
        &scope_create_body(None, &net_label),
    )
    .await;
    assert_eq!(status, "200", "{}", String::from_utf8_lossy(&body));
    let text = String::from_utf8_lossy(&body).into_owned();
    assert!(text.contains("\"kind\":\"network\""), "{text}");
    assert!(text.contains("\"parent_scope_id\":null"), "{text}");
    assert!(
        text.contains(&format!("\"display_name\":\"{net_label}\"")),
        "{text}"
    );
    assert!(text.contains("\"capability\":\"steward\""), "{text}");
    let network_id: ScopeId = text
        .split("\"scope_id\":\"")
        .nth(1)
        .and_then(|s| s.split('"').next())
        .expect("a scope_id")
        .parse()
        .expect("a well-formed scope id");

    // Stewardship inherits down the path: the same organisation-wide
    // steward creates a building under the network it just made.
    let building_label = unique("building");
    let (status, body) = call(
        addr,
        &estate.steward,
        "POST",
        &path,
        &scope_create_body(Some(network_id), &building_label),
    )
    .await;
    assert_eq!(status, "200", "{}", String::from_utf8_lossy(&body));
    let text = String::from_utf8_lossy(&body);
    assert!(text.contains("\"kind\":\"building\""), "{text}");
    assert!(
        text.contains(&format!("\"parent_scope_id\":\"{network_id}\"")),
        "{text}"
    );

    // A drawer may not create a building under it either.
    let (status, body) = call(
        addr,
        &drawer,
        "POST",
        &path,
        &scope_create_body(Some(network_id), &unique("building")),
    )
    .await;
    assert_eq!(status, "403", "{}", String::from_utf8_lossy(&body));
}

// ---------------------------------------------------------------------------
// This session's brief, item 4: a Capture or a Note carrying a credential
// ---------------------------------------------------------------------------

fn a_graph_prov(seed: u128) -> ProvenanceRecord {
    ProvenanceRecord {
        id: ProvenanceId(Ulid(seed * 10 + 2)),
        origin: Origin::Hand,
        asserted_at: Timestamp(0),
        asserted_by: Actor::User(UserId(Ulid(seed * 10 + 3))),
        confidence: Confidence::Asserted,
        supersedes: None,
    }
}

/// A plain-face payload carrying one `Capture` node whose `text` is `line`,
/// verbatim -- the wire shape a redaction-gate miss (or a client that never
/// ran the gate at all) would produce.
fn a_payload_with_capture_text(seed: u128, line: &str) -> Vec<u8> {
    let mut g = Graph::new();
    g.begin_batch(BatchId(Ulid(seed * 10)), "credential test fixture")
        .expect("open batch");
    let capture = g
        .insert_node(NodeKind::Capture, Ulid(seed * 10 + 1), a_graph_prov(seed))
        .expect("capture node");
    g.set_field(
        capture.into(),
        CaptureField::Text.key(),
        scalar::Text(line.to_string()),
        a_graph_prov(seed),
    )
    .expect("set capture text");
    g.end_batch().expect("close batch");
    fathom_workspace::write_plain(&g).expect("a graph this crate built must write")
}

/// The same, for a `Note` node instead.
fn a_payload_with_note_text(seed: u128, line: &str) -> Vec<u8> {
    let mut g = Graph::new();
    g.begin_batch(BatchId(Ulid(seed * 10)), "credential test fixture")
        .expect("open batch");
    let note = g
        .insert_node(NodeKind::Note, Ulid(seed * 10 + 1), a_graph_prov(seed))
        .expect("note node");
    g.set_field(
        note.into(),
        NoteField::Text.key(),
        scalar::Text(line.to_string()),
        a_graph_prov(seed),
    )
    .expect("set note text");
    g.end_batch().expect("close batch");
    fathom_workspace::write_plain(&g).expect("a graph this crate built must write")
}

#[tokio::test]
async fn a_capture_or_note_carrying_a_junos_psk_refuses_the_write_naming_the_kind_and_line() {
    let _site = support::lock_the_site_chain().await;
    let pool = support::migrated_pool().await;
    let ring = ring();
    let estate = bootstrap(&pool, &ring).await;
    let (_scope, design) = a_scope_and_design(&pool, &estate).await;
    let drawer = a_member_with(&pool, &ring, &estate, "drawer", Some(Capability::Draw)).await;

    let addr = serve(app(&pool, Arc::clone(&ring), Vec::new()).await).await;
    let versions_path = format!(
        "/organisations/{}/designs/{}/versions?base=0",
        estate.organisation, design
    );

    // A real-length Junos pre-shared-key crypt hash, the shape a device
    // itself would accept (CLAUDE.md rule 2) -- `$9$` plus twenty-one more
    // characters, well past `crypt_prefix`'s own bar. Unquoted: `pieces`
    // splits a token on `=`/`:`/`,` but not `"`, so a quoted value would
    // start with the quote character, not `$`, and `crypt_prefix` would
    // never see it -- the same reason `fathom-ingest`'s own unit test for
    // this exact shape (`looks_like_credential_catches_real_credential_shapes`)
    // carries it unquoted too.
    let psk_line =
        "set security ike proposal IKE-PROP pre-shared-key ascii-text $9$EXAMPLEnotARealKey01234";

    let capture_payload = a_payload_with_capture_text(201, psk_line);
    let (status, body) = call(
        addr,
        &drawer,
        "POST",
        &versions_path,
        &save_body(CURRENT_SCHEMA_WIRE_VERSION, &capture_payload),
    )
    .await;
    let text = String::from_utf8_lossy(&body);
    assert_eq!(status, "422", "{text}");
    assert!(text.contains("Capture"), "{text}");
    assert!(text.contains("line 1"), "{text}");

    let note_payload = a_payload_with_note_text(202, psk_line);
    let (status, body) = call(
        addr,
        &drawer,
        "POST",
        &versions_path,
        &save_body(CURRENT_SCHEMA_WIRE_VERSION, &note_payload),
    )
    .await;
    let text = String::from_utf8_lossy(&body);
    assert_eq!(status, "422", "{text}");
    assert!(text.contains("Note"), "{text}");

    // Neither refused save wrote anything.
    let latest = designs::read_version(
        &pool,
        &ring,
        estate.organisation,
        estate.steward.account,
        design,
        None,
    )
    .await;
    assert!(
        matches!(latest, Err(designs::DesignError::NoSuchVersion)),
        "{latest:?}"
    );
}

/// CLAUDE.md rule 2: a safety gate is tested against what a real device
/// accepts, not against the one shape its detector cannot miss. These carry
/// no `$x$` crypt prefix, no long hex/base64 run and no `:`/`=` delimiter —
/// the space-separated form Cisco IOS and Junos set-form overwhelmingly use
/// — so a detector that only matched the delimited or crypt-prefixed shape
/// (`looks_like_credential` alone) would let every one of these through.
#[tokio::test]
async fn a_capture_carrying_a_space_separated_real_device_credential_refuses_the_write() {
    let _site = support::lock_the_site_chain().await;
    let pool = support::migrated_pool().await;
    let ring = ring();
    let estate = bootstrap(&pool, &ring).await;
    let (_scope, design) = a_scope_and_design(&pool, &estate).await;
    let drawer = a_member_with(&pool, &ring, &estate, "drawer", Some(Capability::Draw)).await;

    let addr = serve(app(&pool, Arc::clone(&ring), Vec::new()).await).await;
    let versions_path = format!(
        "/organisations/{}/designs/{}/versions?base=0",
        estate.organisation, design
    );

    for (seed, line) in [
        (301u128, "snmp-server community s3cr3tR0 RO"),
        (302, "enable secret cisco123"),
        (303, "crypto isakmp key Sh4redS3cret address 10.0.0.1"),
    ] {
        let capture_payload = a_payload_with_capture_text(seed, line);
        let (status, body) = call(
            addr,
            &drawer,
            "POST",
            &versions_path,
            &save_body(CURRENT_SCHEMA_WIRE_VERSION, &capture_payload),
        )
        .await;
        let text = String::from_utf8_lossy(&body);
        assert_eq!(status, "422", "{line}: {text}");
        assert!(text.contains("Capture"), "{line}: {text}");
    }
}

// ---------------------------------------------------------------------------
// ADR-0054 #5: a grant revoked between the check and the act stops the write
// ---------------------------------------------------------------------------

/// Like [`a_member_with`], but hands back the grant's own id too, so the
/// test below can revoke exactly this grant.
async fn a_member_with_revocable_grant(
    pool: &Pool,
    ring: &KeyRing,
    estate: &Estate,
    name: &str,
    capability: Capability,
) -> (Person, String) {
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
    let grant_id = grants::sign_grant(&tx, &auth, &proposal, &signature)
        .await
        .expect("signed");
    tx.commit().await.expect("commit");
    (person, grant_id)
}

/// The bytes a revocation of `grant_id` signs over -- copied from
/// `tests/authority.rs`'s own `grant_bytes_for` (private to that file; this
/// is the same reconstruction, off the public columns and
/// `authority::grant_bytes`, for this file's own use).
async fn grant_bytes_for(tx: &deadpool_postgres::Transaction<'_>, grant_id: &str) -> Vec<u8> {
    let row = tx
        .query_one(
            "SELECT organisation_id, scope_id, subject_id, subject_key_fpr, capability, \
                    granted_by, granter_key_fpr, auth_epoch, \
                    EXTRACT(EPOCH FROM effective_from)::bigint, \
                    COALESCE(EXTRACT(EPOCH FROM expires_at)::bigint, 0), \
                    sole_steward_appointment \
               FROM scope_grants WHERE id = $1",
            &[&grant_id],
        )
        .await
        .expect("the grant");
    let organisation: String = row.get(0);
    let scope: Option<String> = row.get(1);
    let subject: String = row.get(2);
    let subject_fpr: Vec<u8> = row.get(3);
    let capability: String = row.get(4);
    let granted_by: Option<String> = row.get(5);
    let granter_fpr: Vec<u8> = row.get(6);

    let root_pubkey: Vec<u8> = tx
        .query_one(
            "SELECT root_pubkey FROM organisation_roots WHERE organisation_id = $1",
            &[&organisation],
        )
        .await
        .expect("the root")
        .get(0);

    authority::grant_bytes(&GrantFacts {
        organisation: &organisation,
        root_pubkey_fpr: &authority::key_fingerprint(&root_pubkey),
        scope: scope.as_deref().unwrap_or(""),
        subject: &subject,
        subject_key_fpr: &subject_fpr.try_into().expect("32 bytes"),
        capability: Capability::parse(&capability).expect("a capability"),
        granter: granted_by.as_deref(),
        granter_key_fpr: &granter_fpr.try_into().expect("32 bytes"),
        effective_from_unix: row.get(8),
        expires_at_unix: row.get(9),
        sole_steward_appointment: row.get(10),
        auth_epoch: row.get(7),
    })
}

async fn revoke(pool: &Pool, ring: &KeyRing, estate: &Estate, grant_id: &str) {
    let mut client = pool.get().await.expect("connection");
    let tx = client.transaction().await.expect("begin");
    let ctx = repo::open_tenant_context(&tx, estate.organisation, estate.steward.account)
        .await
        .expect("ctx");
    let tenant_key = keys::tenant_key(&tx, ring, &ctx).await.expect("tenant key");
    let watch = EpochWatch::new();
    let auth = Authority {
        ring,
        ctx: &ctx,
        tenant_key: &tenant_key,
        watch: &watch,
    };
    let at = now_unix();
    let grant_bytes = grant_bytes_for(&tx, grant_id).await;
    let signature = estate.steward.key.sign(&authority::revoke_bytes(
        &estate.organisation.to_string(),
        grant_id,
        &grant_bytes,
        at,
    ));
    grants::revoke_grant(&tx, &auth, grant_id, &signature, at)
        .await
        .expect("revoke");
    tx.commit().await.expect("commit");
}

#[tokio::test]
async fn a_grant_revoked_between_the_check_and_the_act_stops_the_write() {
    let _site = support::lock_the_site_chain().await;
    let pool = support::migrated_pool().await;
    let ring = ring();
    let estate = bootstrap(&pool, &ring).await;
    let (_scope, design) = a_scope_and_design(&pool, &estate).await;
    let (drawer, grant_id) =
        a_member_with_revocable_grant(&pool, &ring, &estate, "drawer", Capability::Draw).await;

    // Open the transaction the act will run in, and prove the grant
    // authorises a draw right now -- exactly what `save_design_handler`'s
    // own capability check would find.
    let mut client = pool.get().await.expect("connection");
    let tx = client.transaction().await.expect("begin");
    let ctx = repo::open_tenant_context(&tx, estate.organisation, drawer.account)
        .await
        .expect("ctx");
    let tenant_key = keys::tenant_key(&tx, &ring, &ctx)
        .await
        .expect("tenant key");
    let watch = EpochWatch::new();
    let auth = Authority {
        ring: &ring,
        ctx: &ctx,
        tenant_key: &tenant_key,
        watch: &watch,
    };
    grants::authorise_account(&tx, &auth, None, Capability::Draw)
        .await
        .expect("authorised, before the revoke");

    // Revoke it now, from a completely separate connection, committed. The
    // transaction above is still open and has read nothing about this grant
    // since the line above.
    revoke(&pool, &ring, &estate, &grant_id).await;

    // The act, in the SAME still-open transaction: `write_version_in_tx`
    // re-checks the grant itself, immediately before touching
    // `design_payload`, and READ COMMITTED means that re-check sees the
    // revocation just committed.
    let result = designs::write_version_in_tx(
        &tx,
        &auth,
        design,
        None,
        &a_plain_face_payload(20),
        CURRENT_SCHEMA_WIRE_VERSION as i32,
        0,
        &audit::SpoolBounds::from_env(),
    )
    .await;
    assert!(
        matches!(
            result,
            Err(designs::DesignError::Authority(
                AuthorityError::NotAuthorised
            ))
        ),
        "a grant revoked between the check and the act must stop the write: {result:?}"
    );
    let _ = tx.rollback().await;

    // Positive control: nothing was written.
    let latest = designs::read_version(
        &pool,
        &ring,
        estate.organisation,
        estate.steward.account,
        design,
        None,
    )
    .await;
    assert!(
        matches!(latest, Err(designs::DesignError::NoSuchVersion)),
        "{latest:?}"
    );
}
