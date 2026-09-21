//! Firmware staging, against a real PostgreSQL, a real socket and the real
//! router — `src/firmware.rs` and `migrations/0017_firmware_staging.sql`.
//!
//! Follows `tests/design_api.rs`'s conventions exactly: `support::migrated_pool`,
//! `support::lock_the_site_chain` held for every test that signs in, and HTTP
//! spoken by hand because there is no HTTP client crate in this closure.
//!
//! **Every test is written against a claim and its name is the claim**
//! (CLAUDE.md rule 2). The refusals come first, because they are the feature:
//!
//! - the `draw` caller's refusal is compared **byte for byte** against the
//!   refusal for an organisation that does not exist, because the claim is that
//!   the two are indistinguishable and not merely that both are `403`;
//! - the lying declaration is checked by looking at the **directory**, not at
//!   the response, because the claim is that no bytes survived;
//! - the fetch token is checked against **captured log output**, because the
//!   claim is that it is never written, and a claim about logging can only be
//!   tested by capturing logging.

mod support;

use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock};

use deadpool_postgres::Pool;

use fathom_server::api::{
    HEADER_COUNTER, HEADER_NONCE, HEADER_SESSION, HEADER_SIGNATURE, HEADER_TIMESTAMP, HEADER_TOKEN,
};
use fathom_server::authority::{self, Capability, GrantFacts, SoftwareKey};
use fathom_server::chains;
use fathom_server::client_address::ClientAddress;
use fathom_server::crypto::Key32;
use fathom_server::firmware::{self, FirmwareState, FirmwareStore, HEADER_UPLOAD_TOKEN};
use fathom_server::grants::{self, Authority, EpochWatch, GenesisGrant, GrantRequest};
use fathom_server::keys::{self, KeyRing};
use fathom_server::repo::{self, AccountId, OrganisationId, ScopeId, ScopeKind};
use fathom_server::sessions::{self, SessionStore, SignInLimits};

/// The one master key this test database is encrypted under (ADR-0043 §4).
const MASTER: [u8; 32] = [21; 32];

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
// Capturing what this binary logs
//
// The fetch token must appear in no log line. That is a claim about `tracing`,
// so it is tested by installing a subscriber and reading what came out. The
// subscriber is PROCESS-WIDE and can only be installed once, so every test in
// this binary logs into one buffer -- which is harmless, and in fact stronger:
// the assertion is "this token appears nowhere in anything this binary logged",
// not "nowhere in this one call".
// ---------------------------------------------------------------------------

#[derive(Clone, Default)]
struct Capture(Arc<Mutex<Vec<u8>>>);

impl Capture {
    fn text(&self) -> String {
        String::from_utf8_lossy(&self.0.lock().unwrap()).into_owned()
    }
}

impl std::io::Write for Capture {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(buf);
        Ok(buf.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

impl<'a> tracing_subscriber::fmt::MakeWriter<'a> for Capture {
    type Writer = Capture;
    fn make_writer(&'a self) -> Self::Writer {
        self.clone()
    }
}

static LOGS: OnceLock<Capture> = OnceLock::new();

/// Everything this binary logs, at `TRACE` — because a leak that only shows up
/// at `debug` is still a leak.
fn logs() -> &'static Capture {
    LOGS.get_or_init(|| {
        let capture = Capture::default();
        let subscriber = tracing_subscriber::fmt()
            .with_max_level(tracing::Level::TRACE)
            .with_ansi(false)
            .with_writer(capture.clone())
            .finish();
        let _ = tracing::subscriber::set_global_default(subscriber);
        capture
    })
}

// ---------------------------------------------------------------------------
// Fixtures — `tests/design_api.rs`'s, unchanged
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
    let limits = SignInLimits {
        window: std::time::Duration::from_secs(900),
        max_per_account: 10_000,
        max_per_source: 10_000,
    };
    SessionStore::new(pool.clone(), ring, deployment, limits)
}

async fn a_scope(pool: &Pool, estate: &Estate) -> ScopeId {
    repo::create_scope(
        pool,
        estate.organisation,
        estate.steward.account,
        None,
        ScopeKind::Network,
        &unique("net"),
    )
    .await
    .expect("create scope")
    .id
}

const TEST_SOURCE_HEADER: &str = "x-fathom-test-source";

fn a_source_of_its_own() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT: AtomicU64 = AtomicU64::new(0);
    format!(
        "203.0.113.11-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    )
}

/// A staging directory of this test's own, so that "the partial file was
/// deleted" is a statement about a directory nothing else writes to.
fn a_staging_directory() -> PathBuf {
    let dir = std::env::temp_dir().join(unique("fathom-firmware"));
    std::fs::create_dir_all(&dir).expect("create this test's staging directory");
    dir
}

fn files_in(dir: &PathBuf) -> Vec<String> {
    let mut names: Vec<String> = std::fs::read_dir(dir)
        .expect("read the staging directory")
        .filter_map(|e| e.ok())
        .filter_map(|e| e.file_name().into_string().ok())
        .collect();
    names.sort();
    names
}

/// The real router: `api::router` for sign-in and nonces, merged with
/// `firmware::router` — exactly the shape `src/main.rs` is meant to assemble.
async fn app(pool: &Pool, ring: Arc<KeyRing>, directory: PathBuf) -> axum::Router {
    let _ = logs();
    let sessions = Arc::new(store(pool, Arc::clone(&ring)).await);
    let watch = Arc::new(EpochWatch::new());

    let api_state = fathom_server::api::ApiState {
        sessions: Arc::clone(&sessions),
        watch: Arc::clone(&watch),
        ring: Arc::clone(&ring),
        client_address: ClientAddress::header(TEST_SOURCE_HEADER),
    };
    let firmware_state = FirmwareState {
        sessions,
        watch,
        ring,
        store: Arc::new(
            FirmwareStore::open(
                directory,
                64 * 1024 * 1024,
                "https://fathom.test.invalid".to_string(),
                ClientAddress::header(TEST_SOURCE_HEADER),
            )
            .expect("this test's staging directory is usable"),
        ),
    };
    fathom_server::api::router(api_state).merge(firmware::router(firmware_state))
}

// ---------------------------------------------------------------------------
// Speaking HTTP by hand — `tests/design_api.rs`'s pattern
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

/// One string field out of a canonical-JSON answer.
///
/// Crude on purpose: `fathom-canon` emits `"key":"value"` with no spaces, and
/// every value read here is a hex string, an id or a URL — none of which can
/// contain a quote or a backslash. A general JSON reader would be a
/// dependency, and this file has no need of one.
fn json_str(body: &[u8], key: &str) -> String {
    let text = String::from_utf8_lossy(body).into_owned();
    let needle = format!("\"{key}\":\"");
    let start = text
        .find(&needle)
        .unwrap_or_else(|| panic!("no {key} in {text}"))
        + needle.len();
    let rest = &text[start..];
    let end = rest.find('"').expect("a closing quote");
    rest[..end].to_string()
}

/// Sign in as a browser would and make one signed request.
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

// ---------------------------------------------------------------------------
// Building the messages
// ---------------------------------------------------------------------------

fn declaration(filename: &str, byte_length: u64, sha256: &[u8; 32]) -> Vec<u8> {
    let mut out = Vec::new();
    lp(&mut out, filename.as_bytes());
    lp(&mut out, &byte_length.to_le_bytes());
    lp(&mut out, sha256);
    out
}

/// Bytes that stand in for an image. Not random: a fixed pattern makes a
/// truncation visible in a hex dump when something goes wrong.
fn an_image(len: usize) -> Vec<u8> {
    (0..len).map(|i| (i % 251) as u8).collect()
}

fn sha256_of(bytes: &[u8]) -> [u8; 32] {
    use sha2::{Digest, Sha256};
    Sha256::digest(bytes).into()
}

/// Declare, then send the bytes, and return the staged image's id.
async fn stage(
    addr: SocketAddr,
    person: &Person,
    organisation: OrganisationId,
    scope: ScopeId,
    filename: &str,
    bytes: &[u8],
) -> String {
    let digest = sha256_of(bytes);
    let (status, body) = call(
        addr,
        person,
        "POST",
        &format!("/organisations/{organisation}/scopes/{scope}/firmware"),
        &declaration(filename, bytes.len() as u64, &digest),
    )
    .await;
    assert_eq!(status, "200", "declare: {}", String::from_utf8_lossy(&body));
    let image = json_str(&body, "image_id");
    let token = json_str(&body, "upload_token");

    let (status, body) = raw_request(
        addr,
        "POST",
        &format!("/firmware/uploads/{image}"),
        &[(HEADER_UPLOAD_TOKEN, token)],
        bytes,
    )
    .await;
    assert_eq!(status, "200", "upload: {}", String::from_utf8_lossy(&body));
    image
}

// ---------------------------------------------------------------------------
// Refusals first
// ---------------------------------------------------------------------------

/// Staging is a `steward` act. A `draw` caller is refused — and the refusal
/// for an organisation that does not exist is the same bytes, so the route
/// cannot be walked to find out which organisations are real.
#[tokio::test]
async fn a_draw_caller_is_refused_staging_and_cannot_tell_a_real_organisation_from_an_invented_one()
{
    let _site = support::lock_the_site_chain().await;
    let pool = support::migrated_pool().await;
    let ring = ring();
    let estate = bootstrap(&pool, &ring).await;
    let scope = a_scope(&pool, &estate).await;
    let drawer = a_member_with(&pool, &ring, &estate, "drawer", Some(Capability::Draw)).await;
    let directory = a_staging_directory();
    let addr = serve(app(&pool, Arc::clone(&ring), directory.clone()).await).await;

    let bytes = an_image(512);
    let body = declaration(
        "junos-install-21.4R3.tgz",
        bytes.len() as u64,
        &sha256_of(&bytes),
    );

    let (real_status, real_body) = call(
        addr,
        &drawer,
        "POST",
        &format!(
            "/organisations/{}/scopes/{scope}/firmware",
            estate.organisation
        ),
        &body,
    )
    .await;

    // An organisation id shaped exactly like a real one, that nothing was ever
    // created under.
    let invented = OrganisationId(fathom_server::ids::new_ulid());
    let (invented_status, invented_body) = call(
        addr,
        &drawer,
        "POST",
        &format!("/organisations/{invented}/scopes/{scope}/firmware"),
        &body,
    )
    .await;

    assert_eq!(
        real_status,
        "403",
        "a draw caller must not stage firmware: {}",
        String::from_utf8_lossy(&real_body)
    );
    assert_eq!(
        real_status, invented_status,
        "a real organisation the caller cannot steward and one that never existed must answer \
         identically"
    );
    assert_eq!(
        real_body, invented_body,
        "the refusal body must not differ either, or the two are distinguishable after all"
    );
    assert!(
        files_in(&directory).is_empty(),
        "a refused declaration must leave nothing on disk: {:?}",
        files_in(&directory)
    );
}

/// The declared hash is a claim. A claim that is false produces no staged
/// image, and — the part that matters — **no file**.
#[tokio::test]
async fn a_declaration_whose_hash_is_a_lie_is_caught_and_the_partial_file_is_deleted() {
    let _site = support::lock_the_site_chain().await;
    let pool = support::migrated_pool().await;
    let ring = ring();
    let estate = bootstrap(&pool, &ring).await;
    let scope = a_scope(&pool, &estate).await;
    let directory = a_staging_directory();
    let addr = serve(app(&pool, Arc::clone(&ring), directory.clone()).await).await;

    let bytes = an_image(64 * 1024);
    // The right length, the wrong hash: the only thing that can catch this is
    // hashing the bytes that actually arrive.
    let lie = [0xAAu8; 32];
    assert_ne!(lie, sha256_of(&bytes));

    let (status, body) = call(
        addr,
        &estate.steward,
        "POST",
        &format!(
            "/organisations/{}/scopes/{scope}/firmware",
            estate.organisation
        ),
        &declaration("junos-install-21.4R3.tgz", bytes.len() as u64, &lie),
    )
    .await;
    assert_eq!(status, "200", "declare: {}", String::from_utf8_lossy(&body));
    let image = json_str(&body, "image_id");
    let token = json_str(&body, "upload_token");

    let (status, body) = raw_request(
        addr,
        "POST",
        &format!("/firmware/uploads/{image}"),
        &[(HEADER_UPLOAD_TOKEN, token)],
        &bytes,
    )
    .await;
    assert_eq!(
        status, "409",
        "an upload whose hash does not match the declaration must be refused"
    );
    let text = String::from_utf8_lossy(&body);
    assert!(text.contains("NOTHING WAS STAGED"), "{text}");

    assert!(
        files_in(&directory).is_empty(),
        "the partial file must be deleted: {:?}",
        files_in(&directory)
    );

    // ...and the image is not staged, and reports no hash at all. The declared
    // hash is never echoed back as if this server had computed it.
    let (status, list) = call(
        addr,
        &estate.steward,
        "GET",
        &format!(
            "/organisations/{}/scopes/{scope}/firmware",
            estate.organisation
        ),
        b"",
    )
    .await;
    assert_eq!(status, "200");
    let text = String::from_utf8_lossy(&list);
    assert!(text.contains("\"state\":\"failed\""), "{text}");
    assert!(text.contains("\"sha256\":null"), "{text}");
    assert!(
        !text.contains(&hex(lie)),
        "the declared hash must never appear in an answer:\n{text}"
    );
}

/// Trap 2 of `docs/UPGRADING-A-JUNIPER.md`, which is the whole reason this
/// feature exists: a short transfer must not become a file anybody serves.
#[tokio::test]
async fn a_truncated_upload_is_caught_and_nothing_is_staged() {
    let _site = support::lock_the_site_chain().await;
    let pool = support::migrated_pool().await;
    let ring = ring();
    let estate = bootstrap(&pool, &ring).await;
    let scope = a_scope(&pool, &estate).await;
    let directory = a_staging_directory();
    let addr = serve(app(&pool, Arc::clone(&ring), directory.clone()).await).await;

    let whole = an_image(40_000);
    let digest = sha256_of(&whole);

    let (status, body) = call(
        addr,
        &estate.steward,
        "POST",
        &format!(
            "/organisations/{}/scopes/{scope}/firmware",
            estate.organisation
        ),
        &declaration("junos-install-21.4R3.tgz", whole.len() as u64, &digest),
    )
    .await;
    assert_eq!(status, "200", "declare");
    let image = json_str(&body, "image_id");
    let token = json_str(&body, "upload_token");

    // Everything but the last hundred bytes.
    let (status, body) = raw_request(
        addr,
        "POST",
        &format!("/firmware/uploads/{image}"),
        &[(HEADER_UPLOAD_TOKEN, token)],
        &whole[..whole.len() - 100],
    )
    .await;
    assert_eq!(status, "409", "a short upload must be refused");
    let text = String::from_utf8_lossy(&body);
    assert!(text.contains("NOTHING WAS STAGED"), "{text}");
    assert!(
        text.contains(&format!("{} bytes arrived", whole.len() - 100)),
        "the refusal must say how much actually arrived: {text}"
    );

    assert!(
        files_in(&directory).is_empty(),
        "the partial file must be deleted: {:?}",
        files_in(&directory)
    );
}

/// An upload token is spent by the transfer it authorises, and a second
/// presentation of it buys nothing.
#[tokio::test]
async fn an_upload_token_works_once() {
    let _site = support::lock_the_site_chain().await;
    let pool = support::migrated_pool().await;
    let ring = ring();
    let estate = bootstrap(&pool, &ring).await;
    let scope = a_scope(&pool, &estate).await;
    let directory = a_staging_directory();
    let addr = serve(app(&pool, Arc::clone(&ring), directory.clone()).await).await;

    let bytes = an_image(8192);
    let (status, body) = call(
        addr,
        &estate.steward,
        "POST",
        &format!(
            "/organisations/{}/scopes/{scope}/firmware",
            estate.organisation
        ),
        &declaration("junos.tgz", bytes.len() as u64, &sha256_of(&bytes)),
    )
    .await;
    assert_eq!(status, "200", "declare");
    let image = json_str(&body, "image_id");
    let token = json_str(&body, "upload_token");

    let (first, _) = raw_request(
        addr,
        "POST",
        &format!("/firmware/uploads/{image}"),
        &[(HEADER_UPLOAD_TOKEN, token.clone())],
        &bytes,
    )
    .await;
    assert_eq!(first, "200", "the first upload");

    let (second, body) = raw_request(
        addr,
        "POST",
        &format!("/firmware/uploads/{image}"),
        &[(HEADER_UPLOAD_TOKEN, token)],
        &bytes,
    )
    .await;
    assert_eq!(
        second,
        "401",
        "a spent upload token must buy nothing: {}",
        String::from_utf8_lossy(&body)
    );

    // The staged file is still exactly what arrived the first time.
    assert_eq!(files_in(&directory), vec![format!("{image}.img")]);
    assert_eq!(
        std::fs::read(directory.join(format!("{image}.img"))).expect("the staged file"),
        bytes
    );
}

/// The whole shape, end to end: the hash Fathom reports is the hash of the
/// bytes Fathom holds, a device collects them once, and a second attempt with
/// the same URL gets nothing.
#[tokio::test]
async fn a_fetch_url_serves_the_staged_bytes_once_and_then_never_again() {
    let _site = support::lock_the_site_chain().await;
    let pool = support::migrated_pool().await;
    let ring = ring();
    let estate = bootstrap(&pool, &ring).await;
    let scope = a_scope(&pool, &estate).await;
    let directory = a_staging_directory();
    let addr = serve(app(&pool, Arc::clone(&ring), directory.clone()).await).await;

    let bytes = an_image(100_000);
    let image = stage(
        addr,
        &estate.steward,
        estate.organisation,
        scope,
        "junos-install-ex-x86-64-21.4R3-S5.5.tgz",
        &bytes,
    )
    .await;

    let (status, body) = call(
        addr,
        &estate.steward,
        "POST",
        &format!(
            "/organisations/{}/firmware/{image}/fetch-urls",
            estate.organisation
        ),
        b"",
    )
    .await;
    assert_eq!(
        status,
        "200",
        "issue a fetch url: {}",
        String::from_utf8_lossy(&body)
    );

    // The hash in the answer is the hash of the bytes on disk, computed by
    // this server, and the commands carry it.
    assert_eq!(json_str(&body, "sha256"), hex(sha256_of(&bytes)));
    let url = json_str(&body, "fetch_url");
    let text = String::from_utf8_lossy(&body);
    assert!(
        text.contains(&format!("file copy {url} /var/tmp/")),
        "the copy command must carry the real URL:\n{text}"
    );
    assert!(
        text.contains("file checksum sha-256 /var/tmp/junos-install-ex-x86-64-21.4R3-S5.5.tgz"),
        "{text}"
    );

    let path = url
        .strip_prefix("https://fathom.test.invalid")
        .expect("the configured base url");

    let (status, served) = raw_request(addr, "GET", path, &[], b"").await;
    assert_eq!(status, "200", "the device's first fetch");
    assert_eq!(served, bytes, "exactly the staged bytes, and nothing else");

    let (status, body) = raw_request(addr, "GET", path, &[], b"").await;
    assert_eq!(
        status,
        "401",
        "a fetch URL is single use: {}",
        String::from_utf8_lossy(&body)
    );
}

/// **The fetch streams.** The claim is not "the handler names a stream type" —
/// a type is not a measurement — it is that a fetch costs the server a buffer
/// and not an image, and that the bytes still arrive whole.
///
/// How this measures it. The router under test runs **in this process**, so
/// this process's resident set is the server's. The staged image is built once
/// and **deliberately kept alive** for the whole test, so the allocator is not
/// holding a free 40 MiB arena that a buffering implementation could quietly
/// reuse without the resident set moving. A baseline is taken after staging and
/// after the fetch URL is issued; the body is then read in fixed 64 KiB chunks,
/// hashed and discarded — never collected — with the resident set sampled on
/// every chunk. A handler that read the file whole would have to add the
/// image's size to the resident set before the first byte reached the socket.
///
/// `std::fs::read` of this image is 41,943,040 bytes; the bound asserted here
/// is a quarter of that. On Linux this reads `/proc/self/statm`; where that
/// file does not exist the memory half is skipped and the correctness half
/// still runs, which is stated rather than hidden.
///
/// It also pins the framing. `Body::from_stream` has no length of its own, so
/// without the explicit `Content-Length` the response would be chunked — and
/// the raw socket readers in this file would then see the chunk headers as
/// body. That is a real regression, so it is asserted directly.
#[tokio::test]
async fn a_large_image_streams_back_whole_and_the_server_never_holds_it() {
    use sha2::{Digest, Sha256};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    let _site = support::lock_the_site_chain().await;
    let pool = support::migrated_pool().await;
    let ring = ring();
    let estate = bootstrap(&pool, &ring).await;
    let scope = a_scope(&pool, &estate).await;
    let directory = a_staging_directory();
    let addr = serve(app(&pool, Arc::clone(&ring), directory.clone()).await).await;

    // 40 MiB: 160 chunks of the fetch path's 256 KiB, so the streaming loop is
    // exercised rather than incidentally skipped, and comfortably under the
    // 64 MiB `max_image_bytes` this test router is built with.
    let length = 40 * 1024 * 1024;
    let bytes = an_image(length);
    let expected = sha256_of(&bytes);
    let image = stage(
        addr,
        &estate.steward,
        estate.organisation,
        scope,
        "junos-install-ex-x86-64-21.4R3-S5.5.tgz",
        &bytes,
    )
    .await;

    let (status, body) = call(
        addr,
        &estate.steward,
        "POST",
        &format!(
            "/organisations/{}/firmware/{image}/fetch-urls",
            estate.organisation
        ),
        b"",
    )
    .await;
    assert_eq!(
        status,
        "200",
        "issue a fetch url: {}",
        String::from_utf8_lossy(&body)
    );
    let url = json_str(&body, "fetch_url");
    let path = url
        .strip_prefix("https://fathom.test.invalid")
        .expect("the configured base url");

    let baseline = resident_bytes();

    let mut stream = tokio::net::TcpStream::connect(addr)
        .await
        .expect("connect to the test router");
    stream
        .write_all(
            format!("GET {path} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n")
                .as_bytes(),
        )
        .await
        .expect("write the fetch request");

    // Fixed buffer, hashing as it goes: this reader is the shape the claim is
    // about, so it must not itself accumulate the image.
    let mut buffer = vec![0u8; 64 * 1024];
    let mut head: Vec<u8> = Vec::new();
    let mut head_done = false;
    let mut hasher = Sha256::new();
    let mut received: u64 = 0;
    let mut peak: u64 = 0;
    loop {
        let n = stream.read(&mut buffer).await.expect("read the response");
        if n == 0 {
            break;
        }
        let mut chunk = &buffer[..n];
        if !head_done {
            head.extend_from_slice(chunk);
            match head.windows(4).position(|w| w == b"\r\n\r\n") {
                None => continue,
                Some(split) => {
                    let body_start = head.split_off(split + 4);
                    head_done = true;
                    hasher.update(&body_start);
                    received += body_start.len() as u64;
                    chunk = &[];
                }
            }
        }
        hasher.update(chunk);
        received += chunk.len() as u64;
        if let (Some(base), Some(now)) = (baseline, resident_bytes()) {
            peak = peak.max(now.saturating_sub(base));
        }
    }

    let head = String::from_utf8_lossy(&head).to_lowercase();
    assert!(head.starts_with("http/1.1 200"), "{head}");
    assert!(
        head.contains(&format!("content-length: {length}")),
        "a streamed body still states its length, or a device cannot tell a truncated transfer \
         from a complete one:\n{head}"
    );
    assert!(
        !head.contains("transfer-encoding"),
        "the length is stated, so this must not also be chunked:\n{head}"
    );

    assert_eq!(received, length as u64, "every staged byte came back");
    assert_eq!(
        <[u8; 32]>::from(hasher.finalize()),
        expected,
        "the bytes that came back are the bytes that were staged"
    );

    match baseline {
        None => eprintln!(
            "resident set not readable on this platform; the memory half of \
             a_large_image_streams_back_whole_and_the_server_never_holds_it did not run"
        ),
        Some(_) => assert!(
            peak < (length as u64) / 4,
            "serving a {length}-byte image grew this process's resident set by {peak} bytes. A \
             fetch must cost a buffer, not an image — see src/firmware.rs's module doc"
        ),
    }

    // Held to here on purpose: see the doc comment. Freeing it earlier would
    // leave an arena a buffering implementation could reuse invisibly.
    assert_eq!(bytes.len(), length);
}

/// **A device that hangs up mid-transfer, twelve times, leaves no open file.**
///
/// The buffered version could not leak a file handle, because it held no handle
/// while the response was being written. Streaming holds one open for the
/// length of the transfer, so the question this answers is the one that
/// introduces: what happens to it when the device goes away, and can a switch
/// that retries badly accumulate handles until the process runs out.
///
/// Measured, not reasoned about. The router under test runs in this process, so
/// `/proc/self/fd` **is** the server's descriptor table; each entry is a symlink
/// to the file it holds, and this test's staging directory is its own, so a
/// descriptor pointing into it can only be a fetch's. Twelve fetch URLs are
/// issued for one 16 MiB image — far larger than any socket buffer, so each
/// transfer is certainly still running — each is fetched far enough to see body
/// bytes arrive, and then the socket is dropped without being drained.
///
/// The count is polled rather than asserted instantly: `tokio::fs::File`'s
/// close is handed to the blocking pool, so it is a moment behind the drop.
/// Waiting for it to reach zero and failing on the timeout is the honest shape
/// — a leak never reaches zero, however long the poll waits.
#[tokio::test]
async fn a_device_that_hangs_up_mid_transfer_leaves_no_open_file_behind() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    let _site = support::lock_the_site_chain().await;
    let pool = support::migrated_pool().await;
    let ring = ring();
    let estate = bootstrap(&pool, &ring).await;
    let scope = a_scope(&pool, &estate).await;
    let directory = a_staging_directory();
    let addr = serve(app(&pool, Arc::clone(&ring), directory.clone()).await).await;

    if open_files_under(&directory).is_none() {
        eprintln!(
            "/proc/self/fd is not readable on this platform; \
             a_device_that_hangs_up_mid_transfer_leaves_no_open_file_behind cannot measure"
        );
        return;
    }

    let bytes = an_image(16 * 1024 * 1024);
    let image = stage(
        addr,
        &estate.steward,
        estate.organisation,
        scope,
        "junos-install-ex-x86-64-21.4R3-S5.5.tgz",
        &bytes,
    )
    .await;

    for attempt in 0..12 {
        let (status, body) = call(
            addr,
            &estate.steward,
            "POST",
            &format!(
                "/organisations/{}/firmware/{image}/fetch-urls",
                estate.organisation
            ),
            b"",
        )
        .await;
        assert_eq!(
            status,
            "200",
            "issue fetch url {attempt}: {}",
            String::from_utf8_lossy(&body)
        );
        let url = json_str(&body, "fetch_url");
        let path = url
            .strip_prefix("https://fathom.test.invalid")
            .expect("the configured base url");

        let mut stream = tokio::net::TcpStream::connect(addr)
            .await
            .expect("connect to the test router");
        stream
            .write_all(
                format!("GET {path} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n")
                    .as_bytes(),
            )
            .await
            .expect("write the fetch request");

        // Read until the body has started, so the hang-up is genuinely
        // mid-transfer and not before the handler ever opened anything.
        let mut seen = Vec::new();
        let mut buffer = vec![0u8; 8 * 1024];
        while seen.len() < 64 * 1024 || !seen.windows(4).any(|w| w == b"\r\n\r\n") {
            let n = stream.read(&mut buffer).await.expect("read the response");
            assert!(n > 0, "the transfer ended before it could be interrupted");
            seen.extend_from_slice(&buffer[..n]);
        }
        assert!(
            String::from_utf8_lossy(&seen[..64]).starts_with("HTTP/1.1 200"),
            "fetch {attempt} must have started: {}",
            String::from_utf8_lossy(&seen[..64])
        );

        // The device goes away. No shutdown, no drain: the socket is dropped
        // with 16 MiB still unsent, which is what a switch losing power does.
        drop(stream);
    }

    // Every one of the twelve is now abandoned. Wait for the descriptor count
    // to come back to zero; a leak would never get there.
    let mut left = usize::MAX;
    for _ in 0..100 {
        left = open_files_under(&directory).expect("checked above that this is readable");
        if left == 0 {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    assert_eq!(
        left, 0,
        "twelve devices hung up mid-transfer and this process still holds {left} open descriptors \
         into the staging directory. A device that retries badly would exhaust the process's \
         descriptors"
    );
}

/// How many of this process's open descriptors point inside `directory`.
///
/// `None` where `/proc/self/fd` does not exist, which is stated by the caller
/// rather than silently passing.
fn open_files_under(directory: &PathBuf) -> Option<usize> {
    let entries = std::fs::read_dir("/proc/self/fd").ok()?;
    Some(
        entries
            .filter_map(|e| e.ok())
            .filter_map(|e| std::fs::read_link(e.path()).ok())
            .filter(|target| target.starts_with(directory))
            .count(),
    )
}

/// This process's resident set in bytes, or `None` where the kernel does not
/// publish it. Field two of `/proc/self/statm` is resident pages.
fn resident_bytes() -> Option<u64> {
    let text = std::fs::read_to_string("/proc/self/statm").ok()?;
    let pages: u64 = text.split_whitespace().nth(1)?.parse().ok()?;
    Some(pages * 4096)
}

/// A fetch URL that has run out of time is refused, and the refusal is the
/// same one an unknown token gets.
#[tokio::test]
async fn an_expired_fetch_url_is_refused() {
    let _site = support::lock_the_site_chain().await;
    let pool = support::migrated_pool().await;
    let ring = ring();
    let estate = bootstrap(&pool, &ring).await;
    let scope = a_scope(&pool, &estate).await;
    let directory = a_staging_directory();
    let addr = serve(app(&pool, Arc::clone(&ring), directory.clone()).await).await;

    let bytes = an_image(4096);
    let image = stage(
        addr,
        &estate.steward,
        estate.organisation,
        scope,
        "junos.tgz",
        &bytes,
    )
    .await;

    let (status, body) = call(
        addr,
        &estate.steward,
        "POST",
        &format!(
            "/organisations/{}/firmware/{image}/fetch-urls",
            estate.organisation
        ),
        b"",
    )
    .await;
    assert_eq!(status, "200", "issue a fetch url");
    let url = json_str(&body, "fetch_url");
    let token_id = json_str(&body, "fetch_token_id");
    let path = url.strip_prefix("https://fathom.test.invalid").unwrap();

    // Wind the expiry back. `expires_at` is not a column the runtime role may
    // write at all -- `0017` grants UPDATE on the redemption columns and no
    // others -- so this needs the superuser, which is itself the point: nothing
    // reachable from a request can extend or revive a token's life.
    let su = support::superuser_client_on_test_database().await;
    // Both timestamps move: `0017` refuses a row whose expiry precedes its
    // issue, so the token is made to look like one issued two hours ago rather
    // than one with an impossible lifetime.
    su.execute(
        "UPDATE firmware_fetch_tokens \
            SET issued_at = now() - interval '2 hours', \
                expires_at = now() - interval '1 hour' \
         WHERE id = $1",
        &[&token_id],
    )
    .await
    .expect("wind the expiry back");

    let (status, _) = raw_request(addr, "GET", path, &[], b"").await;
    assert_eq!(status, "401", "an expired fetch URL must be refused");

    // ...and the refusal is indistinguishable from one for a token that was
    // never issued at all.
    let never_issued = hex([0x5au8; 32]);
    let (unknown_status, unknown_body) = raw_request(
        addr,
        "GET",
        &format!("/firmware/fetch/{never_issued}"),
        &[],
        b"",
    )
    .await;
    let (expired_status, expired_body) = raw_request(addr, "GET", path, &[], b"").await;
    assert_eq!(expired_status, unknown_status);
    assert_eq!(expired_body, unknown_body);
}

/// A filename never becomes a path. The obvious traversal is refused at the
/// door, and the directory is checked afterwards to prove nothing landed
/// anywhere at all.
#[tokio::test]
async fn a_filename_containing_dot_dot_or_a_slash_does_not_escape_the_directory() {
    let _site = support::lock_the_site_chain().await;
    let pool = support::migrated_pool().await;
    let ring = ring();
    let estate = bootstrap(&pool, &ring).await;
    let scope = a_scope(&pool, &estate).await;
    let directory = a_staging_directory();
    let addr = serve(app(&pool, Arc::clone(&ring), directory.clone()).await).await;

    let bytes = an_image(64);
    let digest = sha256_of(&bytes);
    let outside = directory.join("..").join("fathom-firmware-escape-probe");

    for attempt in [
        "../../../etc/cron.d/fathom",
        "../fathom-firmware-escape-probe",
        "/etc/passwd",
        "sub/dir/junos.tgz",
        "..",
    ] {
        let (status, body) = call(
            addr,
            &estate.steward,
            "POST",
            &format!(
                "/organisations/{}/scopes/{scope}/firmware",
                estate.organisation
            ),
            &declaration(attempt, bytes.len() as u64, &digest),
        )
        .await;
        assert_eq!(
            status,
            "400",
            "{attempt:?} must be refused: {}",
            String::from_utf8_lossy(&body)
        );
    }

    assert!(
        files_in(&directory).is_empty(),
        "nothing may be written by a refused declaration: {:?}",
        files_in(&directory)
    );
    assert!(
        !outside.exists(),
        "nothing may be written beside the staging directory either"
    );

    // And the positive half of the same claim: a real staging writes exactly
    // one file, named for the image id, inside the directory.
    let image = stage(
        addr,
        &estate.steward,
        estate.organisation,
        scope,
        "junos-install-21.4R3.tgz",
        &bytes,
    )
    .await;
    assert_eq!(
        files_in(&directory),
        vec![format!("{image}.img")],
        "the on-disk name is the id, never the operator's filename"
    );
}

/// The fetch token is the credential. It is never written to a log line, for
/// the same reason the bootstrap token is not.
#[tokio::test]
async fn the_fetch_token_never_appears_in_a_log_line() {
    let _site = support::lock_the_site_chain().await;
    let pool = support::migrated_pool().await;
    let ring = ring();
    let estate = bootstrap(&pool, &ring).await;
    let scope = a_scope(&pool, &estate).await;
    let directory = a_staging_directory();
    let addr = serve(app(&pool, Arc::clone(&ring), directory.clone()).await).await;

    let bytes = an_image(2048);
    let image = stage(
        addr,
        &estate.steward,
        estate.organisation,
        scope,
        "junos.tgz",
        &bytes,
    )
    .await;

    let (status, body) = call(
        addr,
        &estate.steward,
        "POST",
        &format!(
            "/organisations/{}/firmware/{image}/fetch-urls",
            estate.organisation
        ),
        b"",
    )
    .await;
    assert_eq!(status, "200");
    let url = json_str(&body, "fetch_url");
    let token_id = json_str(&body, "fetch_token_id");
    let path = url.strip_prefix("https://fathom.test.invalid").unwrap();
    let token = path
        .strip_prefix("/firmware/fetch/")
        .expect("the token is the last segment")
        .to_string();
    assert_eq!(token.len(), 64, "256 bits, hex");

    let (status, _) = raw_request(addr, "GET", path, &[], b"").await;
    assert_eq!(status, "200", "the device's fetch");

    // ...and one refused fetch too, because a refusal is exactly where an
    // implementation is tempted to log what it was given.
    let (status, _) = raw_request(addr, "GET", path, &[], b"").await;
    assert_eq!(status, "401");

    let text = logs().text();

    // First, prove the capture is live: the fetch DID log, by image id.
    assert!(
        text.contains(&image),
        "this test proves a negative, so it must first prove the log was captured at all -- \
         nothing about the fetch was recorded:\n{text}"
    );
    assert!(
        text.contains(&token_id),
        "the token's ID is what ties a log line to the sealed entry, and it must be there:\n{text}"
    );

    // Then the claim.
    assert!(
        !text.contains(&token),
        "the fetch token appeared in a log line. It is the whole authorisation for those bytes"
    );
    assert!(
        !text.contains("/firmware/fetch/"),
        "the fetch PATH appeared in a log line, which carries the token inside it"
    );
}

/// Issuing and redeeming are acts, not reads, so each leaves a sealed entry on
/// the organisation's chain — and so does the staging that preceded them.
#[tokio::test]
async fn issuing_and_redeeming_a_fetch_url_both_land_on_the_organisations_chain() {
    let _site = support::lock_the_site_chain().await;
    let pool = support::migrated_pool().await;
    let ring = ring();
    let estate = bootstrap(&pool, &ring).await;
    let scope = a_scope(&pool, &estate).await;
    let directory = a_staging_directory();
    let addr = serve(app(&pool, Arc::clone(&ring), directory.clone()).await).await;

    let bytes = an_image(3000);
    let image = stage(
        addr,
        &estate.steward,
        estate.organisation,
        scope,
        "junos.tgz",
        &bytes,
    )
    .await;

    let (status, body) = call(
        addr,
        &estate.steward,
        "POST",
        &format!(
            "/organisations/{}/firmware/{image}/fetch-urls",
            estate.organisation
        ),
        b"",
    )
    .await;
    assert_eq!(status, "200");
    let url = json_str(&body, "fetch_url");
    let path = url.strip_prefix("https://fathom.test.invalid").unwrap();
    let (status, _) = raw_request(addr, "GET", path, &[], b"").await;
    assert_eq!(status, "200");

    // Read the chain as the superuser: an organisation chain's entries are
    // behind `organisation_id = app.tenant_id`, and this assertion is about
    // rows rather than about what a tenant can see.
    let su = support::superuser_client_on_test_database().await;
    let rows = su
        .query(
            "SELECT entry_type FROM chain_entries \
             WHERE chain_kind = 'org' AND organisation_id = $1 \
               AND entry_type LIKE 'firmware%' ORDER BY seq",
            &[&estate.organisation.to_string()],
        )
        .await
        .expect("read the organisation chain");
    let types: Vec<String> = rows.iter().map(|r| r.get(0)).collect();
    assert_eq!(
        types,
        vec![
            "firmware_staged".to_string(),
            "firmware_fetch_issued".to_string(),
            "firmware_fetch_redeemed".to_string(),
        ],
        "staging, issuing and redeeming each leave one sealed entry, in that order"
    );

    // The redemption's own row records which entry it is, so an auditor can
    // walk from the token to the chain.
    let redeemed: Option<i64> = su
        .query_one(
            "SELECT redeemed_seq FROM firmware_fetch_tokens WHERE image_id = $1",
            &[&image],
        )
        .await
        .expect("the token row")
        .get(0);
    assert!(
        redeemed.is_some(),
        "a redeemed token must name the entry that recorded it"
    );
}

/// The tenant boundary, on both of this module's doors.
#[tokio::test]
async fn an_account_in_another_organisation_can_neither_list_nor_reach_an_image() {
    let _site = support::lock_the_site_chain().await;
    let pool = support::migrated_pool().await;
    let ring = ring();
    let ours = bootstrap(&pool, &ring).await;
    let theirs = bootstrap(&pool, &ring).await;
    let scope = a_scope(&pool, &ours).await;
    let directory = a_staging_directory();
    let addr = serve(app(&pool, Arc::clone(&ring), directory.clone()).await).await;

    let bytes = an_image(1024);
    let image = stage(
        addr,
        &ours.steward,
        ours.organisation,
        scope,
        "junos.tgz",
        &bytes,
    )
    .await;

    // A steward of another organisation, with every capability in their own.
    let outsider = &theirs.steward;

    let (status, body) = call(
        addr,
        outsider,
        "GET",
        &format!(
            "/organisations/{}/scopes/{scope}/firmware",
            ours.organisation
        ),
        b"",
    )
    .await;
    assert_eq!(
        status,
        "403",
        "another organisation's steward must not list: {}",
        String::from_utf8_lossy(&body)
    );

    let (status, _) = call(
        addr,
        outsider,
        "POST",
        &format!(
            "/organisations/{}/firmware/{image}/fetch-urls",
            ours.organisation
        ),
        b"",
    )
    .await;
    assert_eq!(
        status, "403",
        "another organisation's steward must not be able to publish our bytes"
    );

    // And they cannot declare into our scope either.
    let (status, _) = call(
        addr,
        outsider,
        "POST",
        &format!(
            "/organisations/{}/scopes/{scope}/firmware",
            ours.organisation
        ),
        &declaration("junos.tgz", bytes.len() as u64, &sha256_of(&bytes)),
    )
    .await;
    assert_eq!(status, "403", "nor stage into our scope");

    // A caller with no token at all reaches the device door and gets nothing.
    let (status, _) = raw_request(
        addr,
        "GET",
        &format!("/firmware/fetch/{}", hex([0x11u8; 32])),
        &[],
        b"",
    )
    .await;
    assert_eq!(status, "401", "a guessed fetch token must buy nothing");
}

/// A `read` caller may see what is staged, with the hash and the commands, and
/// still may not stage or publish anything.
#[tokio::test]
async fn a_read_caller_sees_the_staged_image_and_its_real_hash_and_can_publish_nothing() {
    let _site = support::lock_the_site_chain().await;
    let pool = support::migrated_pool().await;
    let ring = ring();
    let estate = bootstrap(&pool, &ring).await;
    let scope = a_scope(&pool, &estate).await;
    let reader = a_member_with(&pool, &ring, &estate, "reader", Some(Capability::Read)).await;
    let directory = a_staging_directory();
    let addr = serve(app(&pool, Arc::clone(&ring), directory.clone()).await).await;

    let bytes = an_image(5000);
    let image = stage(
        addr,
        &estate.steward,
        estate.organisation,
        scope,
        "junos-install-21.4R3.tgz",
        &bytes,
    )
    .await;

    let (status, body) = call(
        addr,
        &reader,
        "GET",
        &format!(
            "/organisations/{}/scopes/{scope}/firmware",
            estate.organisation
        ),
        b"",
    )
    .await;
    assert_eq!(status, "200", "a read caller may look");
    let text = String::from_utf8_lossy(&body);
    assert!(text.contains(&image), "{text}");
    assert!(text.contains(&hex(sha256_of(&bytes))), "{text}");
    assert!(text.contains("\"state\":\"staged\""), "{text}");
    assert!(
        text.contains("file checksum sha-256 /var/tmp/junos-install-21.4R3.tgz"),
        "the commands must carry this image's own filename: {text}"
    );
    // The list cannot hand out a URL, because this server keeps only the hash
    // of one. See `list_handler`'s own doc.
    assert!(
        !text.contains("https://fathom.test.invalid/firmware/fetch/"),
        "a GET must not mint or reveal a fetch URL: {text}"
    );

    let (status, _) = call(
        addr,
        &reader,
        "POST",
        &format!(
            "/organisations/{}/firmware/{image}/fetch-urls",
            estate.organisation
        ),
        b"",
    )
    .await;
    assert_eq!(status, "403", "a read caller may not publish the bytes");
}

/// The directory is proved usable at startup, not at the first two-gigabyte
/// transfer.
#[test]
fn a_missing_or_unwritable_staging_directory_is_refused_at_startup() {
    let missing = std::env::temp_dir().join(unique("fathom-firmware-absent"));
    let err = match FirmwareStore::open(
        missing.clone(),
        1024,
        "https://example.invalid".to_string(),
        ClientAddress::peer(),
    ) {
        Ok(_) => panic!("a directory that does not exist cannot be staged into"),
        Err(e) => e,
    };
    assert_eq!(err.directory, missing);

    let file = std::env::temp_dir().join(unique("fathom-firmware-file"));
    std::fs::write(&file, b"not a directory").expect("write the probe file");
    let err = match FirmwareStore::open(
        file.clone(),
        1024,
        "https://example.invalid".to_string(),
        ClientAddress::peer(),
    ) {
        Ok(_) => panic!("a file is not a directory"),
        Err(e) => e,
    };
    assert!(err.to_string().contains("not a directory"), "{err}");
    let _ = std::fs::remove_file(&file);

    let good = a_staging_directory();
    assert!(
        FirmwareStore::open(
            good.clone(),
            1024,
            "https://example.invalid".to_string(),
            ClientAddress::peer(),
        )
        .is_ok(),
        "a real, writable directory is accepted"
    );
    // ...and the probe file it wrote is gone again.
    assert!(files_in(&good).is_empty(), "{:?}", files_in(&good));
}
