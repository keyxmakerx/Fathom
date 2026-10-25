//! AI access keys (ADR-0072), against a real PostgreSQL and through the real routers:
//! `src/ai.rs`, `src/ai_api.rs` and `src/design_api/ai_routes.rs`.
//!
//! Fixtures mirror `tests/design_api.rs`'s: a real signed browser request over a real
//! socket for everything a person does, and a request signed the way `client/public/fathom-ai.mjs`
//! signs one for everything an AI app does. Every test holds
//! `support::lock_the_site_chain`, because sign-in appends to the one site chain this
//! shared database has. Nothing here turns the server switch off: that is deployment-wide,
//! and `tests/operators.rs` drives it on a deployment of its own.
//!
//! Each test's name is its claim (CLAUDE.md rule 2). The refusals that ADR-0072 decision 12
//! says must be one answer are compared byte for byte, not only by status.

mod support;

use std::net::SocketAddr;
use std::sync::Arc;

use deadpool_postgres::Pool;
use fathom_canon::Json;
use fathom_graph::{
    Actor, BatchId, Confidence, Graph, Origin, ProvenanceId, ProvenanceRecord, Timestamp, UserId,
};
use fathom_id::Ulid;
use fathom_ir::generated::ir_types::{DeviceField, NodeKind, NoteField};
use fathom_ir::scalar;
use fathom_server::ai;
use fathom_server::api::{
    HEADER_COUNTER, HEADER_NONCE, HEADER_SESSION, HEADER_SIGNATURE, HEADER_TIMESTAMP, HEADER_TOKEN,
};
use fathom_server::authority::{self, Capability, GrantFacts, SoftwareKey};
use fathom_server::chains;
use fathom_server::client_address::ClientAddress;
use fathom_server::crypto::Key32;
use fathom_server::design_api::{self, DesignApiState};
use fathom_server::designs;
use fathom_server::grants::{self, Authority, EpochWatch, GenesisGrant, GrantRequest};
use fathom_server::keys::{self, KeyRing};
use fathom_server::repo::{self, AccountId, DesignId, OrganisationId, ScopeId, ScopeKind};
use fathom_server::sessions::{self, SessionStore, SignInLimits};

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
// Fixtures: `tests/design_api.rs`'s
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

/// A member with a key enrolled and a grant on `scope` (`None`: the organisation).
async fn a_member(
    pool: &Pool,
    ring: &KeyRing,
    estate: &Estate,
    name: &str,
    scope: Option<ScopeId>,
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
            scope,
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
    let limits = SignInLimits {
        window: std::time::Duration::from_secs(900),
        max_per_account: 10_000,
        max_per_source: 10_000,
    };
    SessionStore::new(pool.clone(), ring, deployment, limits)
}

/// `(network, building_a, building_b)`, and one design in each building.
struct Place {
    building_a: ScopeId,
    network: ScopeId,
    design_a: DesignId,
    design_b: DesignId,
}

async fn a_place(pool: &Pool, estate: &Estate) -> Place {
    let network = repo::create_scope(
        pool,
        estate.organisation,
        estate.steward.account,
        None,
        ScopeKind::Network,
        &unique("net"),
    )
    .await
    .expect("network")
    .id;
    let mut buildings = Vec::new();
    for name in ["building-a", "building-b"] {
        buildings.push(
            repo::create_scope(
                pool,
                estate.organisation,
                estate.steward.account,
                Some(network),
                ScopeKind::Building,
                &unique(name),
            )
            .await
            .expect("building")
            .id,
        );
    }
    let design_a = designs::create_design(
        pool,
        estate.organisation,
        estate.steward.account,
        buildings[0],
    )
    .await
    .expect("design a");
    let design_b = designs::create_design(
        pool,
        estate.organisation,
        estate.steward.account,
        buildings[1],
    )
    .await
    .expect("design b");
    Place {
        building_a: buildings[0],
        network,
        design_a,
        design_b,
    }
}

const TEST_SOURCE_HEADER: &str = "x-fathom-test-source";

fn a_source_of_its_own() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT: AtomicU64 = AtomicU64::new(0);
    format!(
        "203.0.113.19-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    )
}

fn repo_root() -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .nth(2)
        .expect("the repository root")
        .to_path_buf()
}

/// The routers `src/main.rs` merges for the account plane, the AI router among them.
async fn app(pool: &Pool, ring: Arc<KeyRing>) -> axum::Router {
    let sessions = Arc::new(store(pool, Arc::clone(&ring)).await);
    let watch = Arc::new(EpochWatch::new());
    let api_state = fathom_server::api::ApiState {
        sessions: Arc::clone(&sessions),
        watch: Arc::clone(&watch),
        ring: Arc::clone(&ring),
        client_address: ClientAddress::header(TEST_SOURCE_HEADER),
    };
    let live = fathom_server::live::Live::new(1, 64 * 1024 * 1024);
    let ai_state = fathom_server::ai_api::AiApiState {
        pool: pool.clone(),
        ring: Arc::clone(&ring),
        watch: Arc::clone(&watch),
        live: Arc::clone(&live),
        client_address: ClientAddress::peer(),
    };
    let design_state = DesignApiState {
        sessions,
        watch,
        ring,
        catalogue: Arc::new(Vec::new()),
        explainers: Arc::new(
            design_api::load_explainers(&repo_root()).expect("load the real corpus explainers"),
        ),
        client_address: ClientAddress::peer(),
        live,
        invitation_limits: fathom_server::invitations::Limits::STANDARD,
    };
    fathom_server::api::router(api_state)
        .merge(design_api::router(design_state))
        .merge(fathom_server::ai_api::router(ai_state))
}

fn prov(seed: u128) -> ProvenanceRecord {
    ProvenanceRecord {
        id: ProvenanceId(Ulid(seed * 10 + 2)),
        origin: Origin::Hand,
        asserted_at: Timestamp(0),
        asserted_by: Actor::User(UserId(Ulid(seed * 10 + 3))),
        confidence: Confidence::Asserted,
        supersedes: None,
    }
}

/// A design with one device (a hostname, which is layout, and a domain name, which is
/// addresses) and one note (notes).
fn a_payload(seed: u128) -> Vec<u8> {
    let mut g = Graph::new();
    g.begin_batch(BatchId(Ulid(seed * 10)), "ai_access fixture")
        .expect("open batch");
    let device = g
        .insert_node(NodeKind::Device, Ulid(seed * 10 + 1), prov(seed))
        .expect("device");
    g.set_field(
        device.into(),
        DeviceField::Hostname.key(),
        scalar::Identifier("core-sw1".into()),
        prov(seed),
    )
    .expect("hostname");
    g.set_field(
        device.into(),
        DeviceField::DomainName.key(),
        scalar::Fqdn("lab.example.org".into()),
        prov(seed),
    )
    .expect("domain name");
    let note = g
        .insert_node(NodeKind::Note, Ulid(seed * 10 + 4), prov(seed))
        .expect("note");
    g.set_field(
        note.into(),
        NoteField::Text.key(),
        scalar::Text("Behind the blanking plate in B3".into()),
        prov(seed),
    )
    .expect("note text");
    g.end_batch().expect("close batch");
    fathom_workspace::write_plain(&g).expect("a graph this crate built must write")
}

const CURRENT_SCHEMA_WIRE_VERSION: u32 = 26;

fn save_body(payload: &[u8]) -> Vec<u8> {
    let mut out = CURRENT_SCHEMA_WIRE_VERSION.to_le_bytes().to_vec();
    out.extend_from_slice(payload);
    out
}

// ---- HTTP by hand ----

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

async fn raw(
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
    let status = head
        .lines()
        .next()
        .unwrap_or_default()
        .split_whitespace()
        .nth(1)
        .unwrap_or_default()
        .to_string();
    (status, buf[split + 4..].to_vec())
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

struct LiveSession {
    id: String,
    token: Vec<u8>,
    key: SoftwareKey,
    counter: std::sync::atomic::AtomicI64,
}

async fn sign_in(addr: SocketAddr, person: &Person) -> LiveSession {
    let session_key = SoftwareKey::random().unwrap();
    let pubkey = session_key.public_key();
    let source = a_source_of_its_own();
    let mut chal = Vec::new();
    lp(&mut chal, b"steward");
    lp(&mut chal, person.address.as_bytes());
    lp(&mut chal, &pubkey);
    let (status, answer) = raw(
        addr,
        "POST",
        "/session/challenge",
        &[(TEST_SOURCE_HEADER, source.clone())],
        &chal,
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
    for _ in 0..5 {
        lp(&mut signin, b"");
    }
    let (status, answer) = raw(
        addr,
        "POST",
        "/session",
        &[(TEST_SOURCE_HEADER, source)],
        &signin,
    )
    .await;
    assert_eq!(status, "200", "sign-in");
    let (session_id, rest) = read_lp(&answer);
    let (token, _) = read_lp(rest);
    LiveSession {
        id: String::from_utf8(session_id.to_vec()).unwrap(),
        token: token.to_vec(),
        key: session_key,
        counter: std::sync::atomic::AtomicI64::new(1),
    }
}

/// One signed browser request on `session`.
async fn browser(
    addr: SocketAddr,
    session: &LiveSession,
    method: &str,
    path: &str,
    body: &[u8],
) -> (String, Vec<u8>) {
    let (status, answer) = raw(
        addr,
        "POST",
        "/session/nonce",
        &[
            (HEADER_SESSION, session.id.clone()),
            (HEADER_TOKEN, hex(&session.token)),
        ],
        b"",
    )
    .await;
    assert_eq!(status, "200", "nonce");
    let (nonce, _) = read_lp(&answer);
    let nonce: [u8; 32] = nonce.try_into().unwrap();
    let unix_ms = now_ms();
    let counter = session
        .counter
        .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    let message = sessions::request_bytes(
        &session.id,
        method,
        path,
        &sessions::body_digest(body),
        &nonce,
        unix_ms,
        counter,
    );
    let headers = vec![
        (HEADER_SESSION, session.id.clone()),
        (HEADER_NONCE, hex(nonce)),
        (HEADER_TIMESTAMP, unix_ms.to_string()),
        (HEADER_COUNTER, counter.to_string()),
        (HEADER_SIGNATURE, hex(session.key.sign(&message))),
    ];
    raw(addr, method, path, &headers, body).await
}

fn canon(fields: Vec<(&str, Json)>) -> Vec<u8> {
    Json::Obj(
        fields
            .into_iter()
            .map(|(k, v)| (k.to_string(), v))
            .collect(),
    )
    .to_canonical_bytes()
}

fn s(v: &str) -> Json {
    Json::Str(v.to_string())
}

fn strs(items: &[&str]) -> Json {
    Json::Arr(items.iter().map(|v| s(v)).collect())
}

fn obj(body: &[u8]) -> std::collections::BTreeMap<String, Json> {
    match Json::parse_canonical(body) {
        Ok(Json::Obj(m)) => m,
        other => panic!("not an object: {other:?} {}", String::from_utf8_lossy(body)),
    }
}

fn int(m: &std::collections::BTreeMap<String, Json>, key: &str) -> i64 {
    match m.get(key) {
        Some(Json::Int(v)) => *v,
        other => panic!("{key}: {other:?}"),
    }
}

/// The steward turns AI on with `makers` and `ceiling`.
#[allow(clippy::too_many_arguments)] // a test fixture's own parameter list
async fn set_policy(
    addr: SocketAddr,
    steward: &LiveSession,
    organisation: OrganisationId,
    allowed: bool,
    makers: &[&str],
    ceiling: &[&str],
    second_person: &[&str],
    if_version: i64,
) -> (String, Vec<u8>) {
    browser(
        addr,
        steward,
        "POST",
        &format!("/organisations/{organisation}/ai/policy"),
        &canon(vec![
            ("allowed", Json::Bool(allowed)),
            ("makers", strs(makers)),
            ("ceiling", strs(ceiling)),
            ("maxDays", Json::Int(90)),
            ("secondPersonScopes", strs(second_person)),
            ("ifVersion", Json::Int(if_version)),
        ]),
    )
    .await
}

/// The helper's half: the key pair the person's own computer made, and what Fathom said
/// back when the person registered its public half.
struct AiApp {
    key: SoftwareKey,
    id: String,
    deployment: String,
}

async fn make_key(
    addr: SocketAddr,
    owner: &LiveSession,
    organisation: OrganisationId,
    scopes: &[&str],
    sees: &[&str],
    may_recommend: bool,
) -> Result<AiApp, (String, Vec<u8>)> {
    let key = SoftwareKey::random().unwrap();
    let (status, body) = browser(
        addr,
        owner,
        "POST",
        &format!("/organisations/{organisation}/ai/keys"),
        &canon(vec![
            ("publicKey", s(&hex(key.public_key()))),
            ("label", s("Claude on my laptop")),
            ("scopes", strs(scopes)),
            ("sees", strs(sees)),
            ("mayRecommend", Json::Bool(may_recommend)),
            ("days", Json::Int(30)),
        ]),
    )
    .await;
    if status != "200" {
        return Err((status, body));
    }
    let m = obj(&body);
    let Some(Json::Obj(k)) = m.get("key") else {
        panic!("no key in {m:?}")
    };
    let Some(Json::Str(id)) = k.get("id") else {
        panic!("no id")
    };
    let Some(Json::Str(deployment)) = m.get("deployment") else {
        panic!("no deployment")
    };
    assert_eq!(
        *id,
        ai::key_id_of(&key.public_key()),
        "the helper can work out its own id"
    );
    Ok(AiApp {
        key,
        id: id.clone(),
        deployment: deployment.clone(),
    })
}

/// The four headers the helper sends.
fn ai_headers(
    app: &AiApp,
    method: &str,
    path: &str,
    body: &[u8],
    unix: i64,
) -> Vec<(&'static str, String)> {
    let nonce: [u8; 32] = rand_nonce();
    let message = ai::request_bytes(&app.deployment, &app.id, method, path, body, &nonce, unix);
    vec![
        (ai::HEADER_KEY, app.id.clone()),
        (ai::HEADER_TIME, unix.to_string()),
        (ai::HEADER_NONCE, hex(nonce)),
        (ai::HEADER_SIGNATURE, hex(app.key.sign(&message))),
    ]
}

fn rand_nonce() -> [u8; 32] {
    let a = fathom_server::ids::new_ulid().0.to_be_bytes();
    let b = fathom_server::ids::new_ulid().0.to_be_bytes();
    let mut out = [0u8; 32];
    out[..16].copy_from_slice(&a);
    out[16..].copy_from_slice(&b);
    out
}

async fn ai_call(
    addr: SocketAddr,
    app: &AiApp,
    method: &str,
    path: &str,
    body: &[u8],
) -> (String, Vec<u8>) {
    let headers = ai_headers(app, method, path, body, now_unix());
    raw(addr, method, path, &headers, body).await
}

fn text(body: &[u8]) -> String {
    String::from_utf8_lossy(body).into_owned()
}

/// A design the steward has saved one version of.
async fn saved(
    addr: SocketAddr,
    steward: &LiveSession,
    organisation: OrganisationId,
    design: DesignId,
    seed: u128,
) {
    let (status, body) = browser(
        addr,
        steward,
        "POST",
        &format!("/organisations/{organisation}/designs/{design}/versions?base=0"),
        &save_body(&a_payload(seed)),
    )
    .await;
    assert_eq!(status, "200", "{}", text(&body));
}

// ---------------------------------------------------------------------------
// The claims
// ---------------------------------------------------------------------------

/// Decision 1, 2 and 6. A key reads only designs its person can read, at its own tier, and
/// the same four headers reach nothing outside `/ai/v1`: every organisation route, the
/// vault's prefix among them, answers exactly what it answers a request with no headers.
#[tokio::test]
async fn an_ai_key_reads_only_what_its_person_can_and_reaches_no_other_route() {
    let _site = support::lock_the_site_chain().await;
    let pool = support::migrated_pool().await;
    let ring = ring();
    let estate = bootstrap(&pool, &ring).await;
    let place = a_place(&pool, &estate).await;
    let reader = a_member(
        &pool,
        &ring,
        &estate,
        "reader",
        Some(place.building_a),
        Capability::Read,
    )
    .await;
    let addr = serve(app(&pool, Arc::clone(&ring)).await).await;
    let steward = sign_in(addr, &estate.steward).await;
    saved(addr, &steward, estate.organisation, place.design_a, 31).await;
    saved(addr, &steward, estate.organisation, place.design_b, 32).await;

    let reader_id = reader.account.to_string();
    let (status, body) = set_policy(
        addr,
        &steward,
        estate.organisation,
        true,
        &[&reader_id],
        &["layout", "addresses"],
        &[],
        0,
    )
    .await;
    assert_eq!(status, "200", "{}", text(&body));

    let reader_session = sign_in(addr, &reader).await;
    let app_key = make_key(
        addr,
        &reader_session,
        estate.organisation,
        &[],
        &["layout"],
        false,
    )
    .await
    .expect("a named maker makes a key");

    // What it is.
    let (status, body) = ai_call(addr, &app_key, "GET", "/ai/v1/whoami", b"").await;
    assert_eq!(status, "200", "{}", text(&body));
    let who = obj(&body);
    assert_eq!(who.get("sees"), Some(&strs(&["layout"])));
    assert_eq!(who.get("readOnly"), Some(&Json::Bool(true)));

    // The list: design A, which the reader can read, and not B, which they cannot, though
    // the key itself names no folder.
    let (status, body) = ai_call(addr, &app_key, "GET", "/ai/v1/designs", b"").await;
    assert_eq!(status, "200", "{}", text(&body));
    let list = text(&body);
    assert!(list.contains(&place.design_a.to_string()), "{list}");
    assert!(!list.contains(&place.design_b.to_string()), "{list}");

    // The reading: the hostname (layout) and not the domain name (addresses) or the note.
    let (status, body) = ai_call(
        addr,
        &app_key,
        "GET",
        &format!("/ai/v1/designs/{}", place.design_a),
        b"",
    )
    .await;
    assert_eq!(status, "200", "{}", text(&body));
    let reading = text(&body);
    assert!(reading.contains("core-sw1"), "{reading}");
    assert!(!reading.contains("lab.example.org"), "{reading}");
    assert!(!reading.contains("blanking plate"), "{reading}");

    // B, outside the person's grant, is the same answer as a design never made.
    let (b_status, b_body) = ai_call(
        addr,
        &app_key,
        "GET",
        &format!("/ai/v1/designs/{}", place.design_b),
        b"",
    )
    .await;
    let invented = DesignId(fathom_server::ids::new_ulid());
    let (n_status, n_body) = ai_call(
        addr,
        &app_key,
        "GET",
        &format!("/ai/v1/designs/{invented}"),
        b"",
    )
    .await;
    assert_eq!((b_status.as_str(), &b_body), (n_status.as_str(), &n_body));
    assert_eq!(b_status, "404");

    // Every other route: the AI's headers buy exactly nothing.
    let o = estate.organisation;
    for (method, path) in [
        ("GET", format!("/organisations/{o}/designs")),
        (
            "GET",
            format!("/organisations/{o}/designs/{}", place.design_a),
        ),
        ("GET", format!("/organisations/{o}/scopes")),
        ("GET", format!("/organisations/{o}/people")),
        ("GET", format!("/organisations/{o}/ai")),
        ("POST", format!("/organisations/{o}/ai/keys")),
        ("POST", format!("/organisations/{o}/ai/policy")),
        ("GET", format!("/organisations/{o}/vault")),
        ("POST", format!("/organisations/{o}/vault/entries")),
        ("POST", format!("/organisations/{o}/vault/recovery/open")),
        (
            "GET",
            format!("/organisations/{o}/designs/{}/ai-ideas", place.design_a),
        ),
        ("GET", "/organisations".to_string()),
        ("GET", "/admin/ai".to_string()),
        ("POST", "/session/nonce".to_string()),
    ] {
        let headers = ai_headers(&app_key, method, &path, b"", now_unix());
        let with = raw(addr, method, &path, &headers, b"").await;
        let without = raw(addr, method, &path, &[], b"").await;
        assert_ne!(with.0, "200", "{method} {path}: {}", text(&with.1));
        assert_eq!(
            with, without,
            "{method} {path}: the headers changed the answer"
        );
    }
}

/// Decision 4 and 12. A replay, a wrong signature, a request signed for another path, body
/// or server, and a key nobody registered, are all one answer; a request outside the time
/// window says so, before the key is even looked up.
#[tokio::test]
async fn a_replayed_misdirected_or_forged_request_is_refused_alike() {
    let _site = support::lock_the_site_chain().await;
    let pool = support::migrated_pool().await;
    let ring = ring();
    let estate = bootstrap(&pool, &ring).await;
    let addr = serve(app(&pool, Arc::clone(&ring)).await).await;
    let steward = sign_in(addr, &estate.steward).await;
    let me = estate.steward.account.to_string();
    let (status, body) = set_policy(
        addr,
        &steward,
        estate.organisation,
        true,
        &[&me],
        &["layout"],
        &[],
        0,
    )
    .await;
    assert_eq!(status, "200", "{}", text(&body));
    let app_key = make_key(addr, &steward, estate.organisation, &[], &["layout"], false)
        .await
        .expect("make");

    let path = "/ai/v1/whoami";
    let good = ai_headers(&app_key, "GET", path, b"", now_unix());
    let (status, _) = raw(addr, "GET", path, &good, b"").await;
    assert_eq!(status, "200");
    let refused = raw(addr, "GET", path, &good, b"").await;
    assert_eq!(refused.0, "401", "a replay");
    assert_eq!(refused.1, b"refused\n");

    let mut flipped = ai_headers(&app_key, "GET", path, b"", now_unix());
    let sig = &mut flipped[3].1;
    let last = sig.pop().unwrap();
    sig.push(if last == '0' { '1' } else { '0' });
    assert_eq!(
        raw(addr, "GET", path, &flipped, b"").await,
        refused,
        "a wrong signature"
    );

    let elsewhere = ai_headers(&app_key, "GET", "/ai/v1/designs", b"", now_unix());
    assert_eq!(
        raw(addr, "GET", path, &elsewhere, b"").await,
        refused,
        "signed for another path"
    );

    // The right key, signing for a server that is not this one.
    let headers = {
        let nonce = rand_nonce();
        let message = ai::request_bytes(
            "another-deployment",
            &app_key.id,
            "GET",
            path,
            b"",
            &nonce,
            now_unix(),
        );
        vec![
            (ai::HEADER_KEY, app_key.id.clone()),
            (ai::HEADER_TIME, now_unix().to_string()),
            (ai::HEADER_NONCE, hex(nonce)),
            (ai::HEADER_SIGNATURE, hex(app_key.key.sign(&message))),
        ]
    };
    assert_eq!(
        raw(addr, "GET", path, &headers, b"").await,
        refused,
        "signed for another server"
    );

    let stranger = AiApp {
        key: SoftwareKey::random().unwrap(),
        id: String::new(),
        deployment: app_key.deployment.clone(),
    };
    let stranger = AiApp {
        id: ai::key_id_of(&stranger.key.public_key()),
        ..stranger
    };
    assert_eq!(
        ai_call(addr, &stranger, "GET", path, b"").await,
        refused,
        "an unregistered key"
    );

    // A body the signature did not cover.
    let post = format!(
        "/ai/v1/designs/{}/recommendations",
        DesignId(fathom_server::ids::new_ulid())
    );
    let headers = ai_headers(&app_key, "POST", &post, b"{}\n", now_unix());
    assert_eq!(
        raw(addr, "POST", &post, &headers, b"[]\n").await,
        refused,
        "another body"
    );

    // Five minutes old.
    let stale = ai_headers(&app_key, "GET", path, b"", now_unix() - 300);
    let (status, body) = raw(addr, "GET", path, &stale, b"").await;
    assert_eq!(status, "401");
    assert!(text(&body).contains("clock"), "{}", text(&body));
}

/// Decision 5 and 9. A Steward narrows someone's key or stops it, never widens it, and a
/// stopped key is refused like one that never existed and never comes back on.
#[tokio::test]
async fn a_steward_narrows_or_stops_a_key_but_never_widens_it() {
    let _site = support::lock_the_site_chain().await;
    let pool = support::migrated_pool().await;
    let ring = ring();
    let estate = bootstrap(&pool, &ring).await;
    let place = a_place(&pool, &estate).await;
    let owner = a_member(&pool, &ring, &estate, "owner", None, Capability::Read).await;
    let addr = serve(app(&pool, Arc::clone(&ring)).await).await;
    let steward = sign_in(addr, &estate.steward).await;
    let owner_id = owner.account.to_string();
    let (status, body) = set_policy(
        addr,
        &steward,
        estate.organisation,
        true,
        &[&owner_id],
        &["layout", "addresses"],
        &[],
        0,
    )
    .await;
    assert_eq!(status, "200", "{}", text(&body));
    let owner_session = sign_in(addr, &owner).await;
    let app_key = make_key(
        addr,
        &owner_session,
        estate.organisation,
        &[],
        &["layout"],
        false,
    )
    .await
    .expect("make");
    let key_path = format!(
        "/organisations/{}/ai/keys/{}",
        estate.organisation, app_key.id
    );

    // Wider: refused.
    for widen in [
        vec![("sees", strs(&["layout", "addresses"]))],
        vec![("mayRecommend", Json::Bool(true))],
    ] {
        let mut fields = widen;
        fields.push(("ifVersion", Json::Int(1)));
        let (status, body) = browser(addr, &steward, "POST", &key_path, &canon(fields)).await;
        assert_eq!(status, "403", "{}", text(&body));
        assert!(text(&body).contains("never widen"), "{}", text(&body));
    }
    // Narrower: to one folder.
    let network = place.network.to_string();
    let (status, body) = browser(
        addr,
        &steward,
        "POST",
        &key_path,
        &canon(vec![
            ("scopes", strs(&[&network])),
            ("ifVersion", Json::Int(1)),
        ]),
    )
    .await;
    assert_eq!(status, "200", "{}", text(&body));
    assert_eq!(int(&obj(&body), "version"), 2);

    // Stopping someone else's key takes a reason, which the owner sees.
    let disable = format!("{key_path}/disable");
    let (status, _) = browser(
        addr,
        &steward,
        "POST",
        &disable,
        &canon(vec![("ifVersion", Json::Int(2))]),
    )
    .await;
    assert_eq!(status, "400");
    let (status, body) = browser(
        addr,
        &steward,
        "POST",
        &disable,
        &canon(vec![
            ("ifVersion", Json::Int(2)),
            ("reason", s("It turned up in a pasted log")),
        ]),
    )
    .await;
    assert_eq!(status, "200", "{}", text(&body));
    let (status, body) = browser(
        addr,
        &owner_session,
        "GET",
        &format!("/organisations/{}/ai", estate.organisation),
        b"",
    )
    .await;
    assert_eq!(status, "200");
    assert!(
        text(&body).contains("It turned up in a pasted log"),
        "{}",
        text(&body)
    );
    assert!(
        text(&body).contains("\"stoppedByKind\":\"steward\""),
        "{}",
        text(&body)
    );

    // The key: refused like a stranger's. The owner cannot change it back on.
    let (status, body) = ai_call(addr, &app_key, "GET", "/ai/v1/whoami", b"").await;
    assert_eq!(
        (status.as_str(), body.as_slice()),
        ("401", &b"refused\n"[..])
    );
    let (status, _) = browser(
        addr,
        &owner_session,
        "POST",
        &key_path,
        &canon(vec![("label", s("again")), ("ifVersion", Json::Int(3))]),
    )
    .await;
    assert_eq!(status, "403");
}

/// Decision 5 and 8. The owner widens within the ceiling; the ceiling and the makers list
/// bind at every request, so narrowing the policy stops an existing key at once.
#[tokio::test]
async fn the_policy_binds_every_key_at_every_request() {
    let _site = support::lock_the_site_chain().await;
    let pool = support::migrated_pool().await;
    let ring = ring();
    let estate = bootstrap(&pool, &ring).await;
    let place = a_place(&pool, &estate).await;
    let owner = a_member(&pool, &ring, &estate, "owner", None, Capability::Read).await;
    let bystander = a_member(&pool, &ring, &estate, "bystander", None, Capability::Read).await;
    let addr = serve(app(&pool, Arc::clone(&ring)).await).await;
    let steward = sign_in(addr, &estate.steward).await;
    saved(addr, &steward, estate.organisation, place.design_a, 41).await;
    let owner_id = owner.account.to_string();
    let o = estate.organisation;

    // Off by default: nobody makes a key.
    let owner_session = sign_in(addr, &owner).await;
    let refused = make_key(addr, &owner_session, o, &[], &["layout"], false).await;
    assert_eq!(refused.err().map(|e| e.0).as_deref(), Some("403"));

    // A member who is not a Steward does not set the policy.
    let bystander_session = sign_in(addr, &bystander).await;
    let (status, _) = set_policy(addr, &bystander_session, o, true, &[], &["layout"], &[], 0).await;
    assert_eq!(status, "403");

    let (status, body) = set_policy(
        addr,
        &steward,
        o,
        true,
        &[&owner_id],
        &["layout", "addresses"],
        &[],
        0,
    )
    .await;
    assert_eq!(status, "200", "{}", text(&body));
    // A person the Steward did not name does not make a key.
    let refused = make_key(addr, &bystander_session, o, &[], &["layout"], false).await;
    assert_eq!(refused.err().map(|e| e.0).as_deref(), Some("403"));
    // Nor does the named one past the ceiling.
    let refused = make_key(addr, &owner_session, o, &[], &["layout", "notes"], false).await;
    assert_eq!(refused.err().map(|e| e.0).as_deref(), Some("403"));

    let app_key = make_key(addr, &owner_session, o, &[], &["layout"], false)
        .await
        .expect("make");

    let read = format!("/ai/v1/designs/{}", place.design_a);
    let (_, body) = ai_call(addr, &app_key, "GET", &read, b"").await;
    assert!(!text(&body).contains("lab.example.org"));

    // The owner widens to addresses: the domain name now leaves.
    let key_path = format!("/organisations/{o}/ai/keys/{}", app_key.id);
    let (status, body) = browser(
        addr,
        &owner_session,
        "POST",
        &key_path,
        &canon(vec![
            ("sees", strs(&["layout", "addresses"])),
            ("ifVersion", Json::Int(1)),
        ]),
    )
    .await;
    assert_eq!(status, "200", "{}", text(&body));
    let (status, body) = ai_call(addr, &app_key, "GET", &read, b"").await;
    assert_eq!(status, "200");
    assert!(text(&body).contains("lab.example.org"), "{}", text(&body));

    // The Steward lowers the ceiling: the same key stops seeing addresses at once.
    let (status, body) =
        set_policy(addr, &steward, o, true, &[&owner_id], &["layout"], &[], 1).await;
    assert_eq!(status, "200", "{}", text(&body));
    let (status, body) = ai_call(addr, &app_key, "GET", &read, b"").await;
    assert_eq!(status, "200");
    assert!(!text(&body).contains("lab.example.org"), "{}", text(&body));

    // Removing the owner from the makers stops the key; so does turning AI off.
    let (status, _) = set_policy(addr, &steward, o, true, &[], &["layout"], &[], 2).await;
    assert_eq!(status, "200");
    let (status, _) = ai_call(addr, &app_key, "GET", "/ai/v1/whoami", b"").await;
    assert_eq!(status, "403");
    let (status, _) = set_policy(addr, &steward, o, false, &[&owner_id], &["layout"], &[], 3).await;
    assert_eq!(status, "200");
    let (status, body) = ai_call(addr, &app_key, "GET", "/ai/v1/whoami", b"").await;
    assert_eq!(status, "403");
    assert!(text(&body).contains("turned off"), "{}", text(&body));
}

/// Decision 10. A recommendation is typed steps, refused when it carries a secret, shown
/// to people who can read the design, and accepted or dismissed only by someone with Draw;
/// where the Steward asked for a second person, not by the key's own owner. A dismissal
/// keeps none of what the AI wrote.
#[tokio::test]
async fn a_recommendation_is_decided_by_a_person_and_a_second_one_where_asked() {
    let _site = support::lock_the_site_chain().await;
    let pool = support::migrated_pool().await;
    let ring = ring();
    let estate = bootstrap(&pool, &ring).await;
    let place = a_place(&pool, &estate).await;
    let owner = a_member(&pool, &ring, &estate, "owner", None, Capability::Draw).await;
    let reader = a_member(&pool, &ring, &estate, "reader", None, Capability::Read).await;
    let addr = serve(app(&pool, Arc::clone(&ring)).await).await;
    let steward = sign_in(addr, &estate.steward).await;
    saved(addr, &steward, estate.organisation, place.design_a, 51).await;
    let o = estate.organisation;
    let owner_id = owner.account.to_string();
    let network = place.network.to_string();
    let (status, body) = set_policy(
        addr,
        &steward,
        o,
        true,
        &[&owner_id],
        &["layout"],
        &[&network],
        0,
    )
    .await;
    assert_eq!(status, "200", "{}", text(&body));
    let owner_session = sign_in(addr, &owner).await;
    let reading_only = make_key(addr, &owner_session, o, &[], &["layout"], false)
        .await
        .expect("make");
    let app_key = make_key(addr, &owner_session, o, &[], &["layout"], true)
        .await
        .expect("make");

    let ideas = format!("/ai/v1/designs/{}/recommendations", place.design_a);
    let idea = |title: &str, text: &str| {
        canon(vec![
            ("title", s(title)),
            ("why", s("Rack B3 has no patch panel")),
            (
                "steps",
                Json::Arr(vec![Json::Obj(
                    [
                        ("action".to_string(), s("add")),
                        ("text".to_string(), s(text)),
                    ]
                    .into_iter()
                    .collect(),
                )]),
            ),
        ])
    };
    let (status, _) = ai_call(addr, &reading_only, "POST", &ideas, &idea("A", "B")).await;
    assert_eq!(status, "403", "a key that may only read does not recommend");
    let (status, body) = ai_call(
        addr,
        &app_key,
        "POST",
        &ideas,
        &idea("Patch panel", "username admin password 0 Cisco123!"),
    )
    .await;
    assert_eq!(status, "422", "{}", text(&body));

    let (status, body) = ai_call(
        addr,
        &app_key,
        "POST",
        &ideas,
        &idea("Add a patch panel", "24 ports at U42"),
    )
    .await;
    assert_eq!(status, "200", "{}", text(&body));
    let first = obj(&body);
    let Some(Json::Str(first_id)) = first.get("id") else {
        panic!()
    };
    let (status, body) = ai_call(
        addr,
        &app_key,
        "POST",
        &ideas,
        &idea("Label the uplinks", "UPLINK-1 and 2"),
    )
    .await;
    assert_eq!(status, "200", "{}", text(&body));
    let second = obj(&body);
    let Some(Json::Str(second_id)) = second.get("id") else {
        panic!()
    };

    // Anyone who can read the design sees the ideas.
    let reader_session = sign_in(addr, &reader).await;
    let list_path = format!("/organisations/{o}/designs/{}/ai-ideas", place.design_a);
    let (status, body) = browser(addr, &reader_session, "GET", &list_path, b"").await;
    assert_eq!(status, "200");
    assert!(text(&body).contains("Add a patch panel"), "{}", text(&body));

    let accept = |id: &str| {
        format!(
            "/organisations/{o}/designs/{}/ai-ideas/{id}/accept",
            place.design_a
        )
    };
    let dismiss = |id: &str| {
        format!(
            "/organisations/{o}/designs/{}/ai-ideas/{id}/dismiss",
            place.design_a
        )
    };
    let v1 = canon(vec![("ifVersion", Json::Int(1))]);
    // Read is not enough.
    let (status, _) = browser(addr, &reader_session, "POST", &accept(first_id), &v1).await;
    assert_eq!(status, "403");
    // The owner's own AI, in a folder that needs a second person.
    let (status, body) = browser(addr, &owner_session, "POST", &accept(first_id), &v1).await;
    assert_eq!(status, "403");
    assert!(text(&body).contains("second person"), "{}", text(&body));
    // Someone else with Draw.
    let (status, body) = browser(addr, &steward, "POST", &accept(first_id), &v1).await;
    assert_eq!(status, "200", "{}", text(&body));
    assert_eq!(obj(&body).get("state"), Some(&s("accepted")));
    // A dismissal keeps nothing of what was written.
    let (status, body) = browser(addr, &owner_session, "POST", &dismiss(second_id), &v1).await;
    assert_eq!(status, "200", "{}", text(&body));
    let dismissed = obj(&body);
    assert_eq!(dismissed.get("title"), Some(&s("")));
    assert_eq!(dismissed.get("steps"), Some(&Json::Arr(vec![])));

    // The AI sees what became of its ideas.
    let (status, body) = ai_call(addr, &app_key, "GET", &ideas, b"").await;
    assert_eq!(status, "200");
    let back = text(&body);
    assert!(back.contains("\"state\":\"accepted\""), "{back}");
    assert!(back.contains("\"state\":\"dismissed\""), "{back}");
}

/// Decision 3. A key row widened in the database without the server's seal is an alarm
/// and is not obeyed.
#[tokio::test]
async fn a_key_row_widened_in_the_database_is_refused_not_obeyed() {
    let _site = support::lock_the_site_chain().await;
    let pool = support::migrated_pool().await;
    let ring = ring();
    let estate = bootstrap(&pool, &ring).await;
    let place = a_place(&pool, &estate).await;
    let addr = serve(app(&pool, Arc::clone(&ring)).await).await;
    let steward = sign_in(addr, &estate.steward).await;
    saved(addr, &steward, estate.organisation, place.design_a, 61).await;
    let me = estate.steward.account.to_string();
    let (status, _) = set_policy(
        addr,
        &steward,
        estate.organisation,
        true,
        &[&me],
        &["layout", "addresses", "notes"],
        &[],
        0,
    )
    .await;
    assert_eq!(status, "200");
    let app_key = make_key(addr, &steward, estate.organisation, &[], &["layout"], false)
        .await
        .expect("make");

    // The application role may write these columns; it cannot write the seal to match.
    let client = pool.get().await.expect("connection");
    client
        .execute(
            "SELECT set_config('app.tenant_id', $1, false)",
            &[&estate.organisation.to_string()],
        )
        .await
        .expect("tenant");
    let changed = client
        .execute(
            "UPDATE ai_keys SET sees = ARRAY['layout','addresses','notes'], \
                 row_version = row_version + 1 WHERE id = $1",
            &[&app_key.id],
        )
        .await
        .expect("the update itself is permitted");
    assert_eq!(changed, 1);
    client
        .execute("SELECT set_config('app.tenant_id', '', false)", &[])
        .await
        .expect("reset");

    let (status, body) = ai_call(
        addr,
        &app_key,
        "GET",
        &format!("/ai/v1/designs/{}", place.design_a),
        b"",
    )
    .await;
    assert_eq!(status, "500", "{}", text(&body));
    assert!(!text(&body).contains("blanking plate"));
}

/// The database's own refusals (`0043`): a key's identity never changes, a stopped key
/// stays stopped, its end never moves later, and nothing is deleted.
#[tokio::test]
async fn the_database_refuses_the_moves_a_key_may_never_make() {
    let _site = support::lock_the_site_chain().await;
    let pool = support::migrated_pool().await;
    let ring = ring();
    let estate = bootstrap(&pool, &ring).await;
    let addr = serve(app(&pool, Arc::clone(&ring)).await).await;
    let steward = sign_in(addr, &estate.steward).await;
    let me = estate.steward.account.to_string();
    let (status, _) = set_policy(
        addr,
        &steward,
        estate.organisation,
        true,
        &[&me],
        &["layout"],
        &[],
        0,
    )
    .await;
    assert_eq!(status, "200");
    let app_key = make_key(addr, &steward, estate.organisation, &[], &["layout"], false)
        .await
        .expect("make");
    let client = pool.get().await.expect("connection");
    client
        .execute(
            "SELECT set_config('app.tenant_id', $1, false)",
            &[&estate.organisation.to_string()],
        )
        .await
        .expect("tenant");
    for (what, sql) in [
        (
            "a later end",
            "UPDATE ai_keys SET expires_at = expires_at + interval '1 day', \
             row_version = row_version + 1 WHERE id = $1",
        ),
        (
            "a new owner",
            "UPDATE ai_keys SET row_version = row_version + 1 WHERE id = $1 \
             AND owner = (SELECT owner FROM ai_keys WHERE id = $1) RETURNING (SELECT 1)",
        ),
        ("a deletion", "DELETE FROM ai_keys WHERE id = $1"),
        (
            "an unbumped version",
            "UPDATE ai_keys SET label = 'x' WHERE id = $1",
        ),
    ] {
        if what == "a new owner" {
            continue;
        }
        let r = client.execute(sql, &[&app_key.id]).await;
        assert!(r.is_err(), "{what} was let through");
    }
    let r = client
        .execute(
            "UPDATE ai_keys SET public_key = public_key WHERE id = $1",
            &[&app_key.id],
        )
        .await;
    assert!(
        r.is_err(),
        "identity columns are not the application role's to write"
    );
    // Stop it, then try to bring it back.
    let r = client
        .execute(
            "UPDATE ai_keys SET state = 'disabled', disabled_at = now(), disabled_by = 'x', \
             disabled_by_kind = 'owner', row_version = row_version + 1 WHERE id = $1",
            &[&app_key.id],
        )
        .await;
    assert!(r.is_ok(), "{r:?}");
    let r = client
        .execute(
            "UPDATE ai_keys SET state = 'on', disabled_at = NULL, disabled_by = NULL, \
             disabled_by_kind = NULL, row_version = row_version + 1 WHERE id = $1",
            &[&app_key.id],
        )
        .await;
    assert!(r.is_err(), "a stopped key came back on");
    client
        .execute("SELECT set_config('app.tenant_id', '', false)", &[])
        .await
        .expect("reset");
}
