//! Steward-issued invitations, "Waiting for you" and batch confirm, against a real
//! PostgreSQL and through the real router. `src/invitations.rs`,
//! `migrations/0037_steward_invitations.sql`.
//!
//! Follows `tests/design_api.rs`'s conventions: real signed HTTP over a real
//! socket, `support::migrated_pool`, and the site chain lock held for every test
//! (issuing and redeeming both append to the one site chain). **Every test is a
//! claim and its name is the claim.** The claims come from the security design's
//! ordered test list: policy and trigger first, then issue, redemption, no access
//! before confirm, the Waiting list, the batch, its atomicity and shape, stale
//! proposals, steward requests, key substitution, refuse and cancel, another
//! organisation, the joined window, and timing.

mod support;

use std::net::SocketAddr;
use std::sync::Arc;

use deadpool_postgres::Pool;

use fathom_canon::Json;
use fathom_server::api::{
    HEADER_COUNTER, HEADER_NONCE, HEADER_SESSION, HEADER_SIGNATURE, HEADER_TIMESTAMP, HEADER_TOKEN,
};
use fathom_server::authority::{self, Capability, GrantFacts, SoftwareKey};
use fathom_server::chains;
use fathom_server::client_address::ClientAddress;
use fathom_server::crypto::Key32;
use fathom_server::design_api::{self, DesignApiState};
use fathom_server::grants::{
    self, Authority, AuthorityError, EpochWatch, GenesisGrant, GrantRequest,
};
use fathom_server::invitations::{self, Limits};
use fathom_server::keys::{self, KeyRing};
use fathom_server::operators::{OperatorError, OperatorStore, TokenFacts};
use fathom_server::repo::{self, AccountId, OrganisationId, ScopeId, ScopeKind};
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
// Fixtures
// ---------------------------------------------------------------------------

struct Person {
    account: AccountId,
    /// What they sign in with: an email for the genesis stewards and members, the
    /// server's sign-in name for somebody who joined from an invitation.
    address: String,
    key: SoftwareKey,
}

struct Estate {
    organisation: OrganisationId,
    stewards: Vec<Person>,
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

async fn tenant_tx<'a>(
    client: &'a mut deadpool_postgres::Client,
    ring: &KeyRing,
    organisation: OrganisationId,
    account: AccountId,
) -> (
    deadpool_postgres::Transaction<'a>,
    repo::TenantContext,
    keys::DataKey,
) {
    let tx = client.transaction().await.expect("begin");
    let ctx = repo::open_tenant_context(&tx, organisation, account)
        .await
        .expect("tenant context");
    let tenant_key = keys::tenant_key(&tx, ring, &ctx).await.expect("tenant key");
    (tx, ctx, tenant_key)
}

/// An organisation with `steward_count` genesis stewards (organisation-wide), so
/// two or more make §3.5's quorum two.
async fn bootstrap(pool: &Pool, ring: &KeyRing, steward_count: usize) -> Estate {
    let root = SoftwareKey::random().expect("a root keypair");
    let salt = [0x5au8; 16];
    let organisation_id = authority::derive_organisation_id(&root.public_key(), &salt);
    let root_fpr = authority::key_fingerprint(&root.public_key());

    let mut stewards = Vec::new();
    for n in 0..steward_count {
        stewards.push(an_account(pool, &format!("steward{n}")).await);
    }
    let now = now_unix();
    let requests: Vec<GenesisGrant> = stewards
        .iter()
        .map(|s| {
            let subject_key_fpr = authority::key_fingerprint(&s.key.public_key());
            let facts = GrantFacts {
                organisation: &organisation_id,
                root_pubkey_fpr: &root_fpr,
                scope: "",
                subject: &s.account.to_string(),
                subject_key_fpr: &subject_key_fpr,
                capability: Capability::Steward,
                granter: None,
                granter_key_fpr: &root_fpr,
                effective_from_unix: now,
                expires_at_unix: now + 365 * 24 * 3600,
                sole_steward_appointment: false,
                auth_epoch: 1,
            };
            GenesisGrant {
                subject: s.account,
                subject_key_fpr,
                capability: Capability::Steward,
                effective_from_unix: now,
                expires_at_unix: now + 365 * 24 * 3600,
                signature: root.sign(&authority::grant_bytes(&facts)),
            }
        })
        .collect();

    let mut client = pool.get().await.expect("connection");
    let tx = client.transaction().await.expect("begin");
    let genesis = grants::bootstrap_organisation(
        &tx,
        ring,
        stewards[0].account,
        &unique("Org"),
        &root.public_key(),
        &salt,
        &requests,
    )
    .await
    .expect("genesis");
    tx.commit().await.expect("commit");

    for (n, steward) in stewards.iter().enumerate() {
        if n > 0 {
            repo::add_member(
                pool,
                genesis.organisation,
                stewards[0].account,
                steward.account,
                repo::Role::Member,
            )
            .await
            .expect("membership");
        }
        enrol(pool, ring, genesis.organisation, steward).await;
    }
    Estate {
        organisation: genesis.organisation,
        stewards,
    }
}

async fn enrol(pool: &Pool, ring: &KeyRing, organisation: OrganisationId, person: &Person) {
    let mut client = pool.get().await.expect("connection");
    let (tx, ctx, tenant_key) = tenant_tx(&mut client, ring, organisation, person.account).await;
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

/// A member with a key and, optionally, a grant at `scope` signed by steward 0.
async fn a_member(
    pool: &Pool,
    ring: &KeyRing,
    estate: &Estate,
    name: &str,
    grant: Option<(Option<ScopeId>, Capability)>,
) -> Person {
    let person = an_account(pool, name).await;
    repo::add_member(
        pool,
        estate.organisation,
        estate.stewards[0].account,
        person.account,
        repo::Role::Member,
    )
    .await
    .expect("membership");
    enrol(pool, ring, estate.organisation, &person).await;
    if let Some((scope, capability)) = grant {
        sign_grant_as(pool, ring, estate, 0, &person, scope, capability).await;
    }
    person
}

/// A grant by genesis steward `granter`, returned by id.
async fn sign_grant_as(
    pool: &Pool,
    ring: &KeyRing,
    estate: &Estate,
    granter: usize,
    person: &Person,
    scope: Option<ScopeId>,
    capability: Capability,
) -> String {
    let mut client = pool.get().await.expect("connection");
    let (tx, ctx, tenant_key) = tenant_tx(
        &mut client,
        ring,
        estate.organisation,
        estate.stewards[granter].account,
    )
    .await;
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
    let signature = estate.stewards[granter].key.sign(&proposal.bytes);
    let id = grants::sign_grant(&tx, &auth, &proposal, &signature)
        .await
        .expect("signed");
    tx.commit().await.expect("commit");
    id
}

/// A steward at one scope only: a steward grant by steward 0, seconded by steward 1
/// (needs an organisation with two genesis stewards).
async fn a_folder_steward(
    pool: &Pool,
    ring: &KeyRing,
    estate: &Estate,
    scope: ScopeId,
    name: &str,
) -> Person {
    let person = a_member(pool, ring, estate, name, None).await;
    let grant = sign_grant_as(
        pool,
        ring,
        estate,
        0,
        &person,
        Some(scope),
        Capability::Steward,
    )
    .await;
    let mut client = pool.get().await.expect("connection");
    let (tx, ctx, tenant_key) = tenant_tx(
        &mut client,
        ring,
        estate.organisation,
        estate.stewards[1].account,
    )
    .await;
    let watch = EpochWatch::new();
    let auth = Authority {
        ring,
        ctx: &ctx,
        tenant_key: &tenant_key,
        watch: &watch,
    };
    let view = grants::second_view(&tx, &auth, Some(scope), &grant)
        .await
        .expect("the second steward may second it");
    let signature = estate.stewards[1].key.sign(&view.second_bytes);
    grants::second_grant_guarded(&tx, &auth, Some(scope), &grant, &signature)
        .await
        .expect("seconded");
    tx.commit().await.expect("commit");
    person
}

async fn a_scope(
    pool: &Pool,
    estate: &Estate,
    parent: Option<ScopeId>,
    kind: ScopeKind,
) -> ScopeId {
    repo::create_scope(
        pool,
        estate.organisation,
        estate.stewards[0].account,
        parent,
        kind,
        &unique("scope"),
    )
    .await
    .expect("create scope")
    .id
}

fn lowercase_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn from_hex(text: &str) -> Vec<u8> {
    (0..text.len() / 2)
        .map(|i| u8::from_str_radix(&text[2 * i..2 * i + 2], 16).unwrap())
        .collect()
}

fn lp(out: &mut Vec<u8>, field: &[u8]) {
    out.extend_from_slice(&(field.len() as u32).to_le_bytes());
    out.extend_from_slice(field);
}

fn read_lp(bytes: &[u8]) -> (&[u8], &[u8]) {
    let len = u32::from_le_bytes(bytes[..4].try_into().unwrap()) as usize;
    (&bytes[4..4 + len], &bytes[4 + len..])
}

// ---- the server ----

const TEST_SOURCE_HEADER: &str = "x-fathom-test-source";

fn a_source_of_its_own() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT: AtomicU64 = AtomicU64::new(0);
    format!(
        "203.0.113.77-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    )
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

async fn app(pool: &Pool, ring: Arc<KeyRing>, limits: Limits) -> axum::Router {
    let sessions = Arc::new(store(pool, Arc::clone(&ring)).await);
    let watch = Arc::new(EpochWatch::new());
    let api_state = fathom_server::api::ApiState {
        sessions: Arc::clone(&sessions),
        watch: Arc::clone(&watch),
        ring: Arc::clone(&ring),
        client_address: ClientAddress::header(TEST_SOURCE_HEADER),
    };
    let live = fathom_server::live::Live::new(1, 64 * 1024 * 1024);
    let app_url = support::test_database_url();
    let app_config = fathom_server::config::Config::from_lookup(|k| {
        (k == "DATABASE_URL").then(|| app_url.clone())
    })
    .expect("a DATABASE_URL-only config must always parse");
    live.listen(fathom_server::db::listener_config(&app_config).expect("a listener config"));
    let design_state = DesignApiState {
        sessions,
        watch,
        ring,
        catalogue: Arc::new(Vec::new()),
        client_address: ClientAddress::peer(),
        live,
        invitation_limits: limits,
    };
    fathom_server::api::router(api_state).merge(design_api::router(design_state))
}

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

struct LiveSession {
    id: String,
    token: Vec<u8>,
    key: SoftwareKey,
}

async fn sign_in_session(addr: SocketAddr, person: &Person) -> LiveSession {
    let session_key = SoftwareKey::random().unwrap();
    let pubkey = session_key.public_key();
    let source = a_source_of_its_own();

    let mut chal = Vec::new();
    lp(&mut chal, b"steward");
    lp(&mut chal, person.address.as_bytes());
    lp(&mut chal, &pubkey);
    let (status, answer) = raw_request(
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
    let (status, answer) = raw_request(
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
    }
}

async fn sign_with(
    addr: SocketAddr,
    session: &LiveSession,
    method: &str,
    path: &str,
    body: &[u8],
) -> Vec<(&'static str, String)> {
    let (status, answer) = raw_request(
        addr,
        "POST",
        "/session/nonce",
        &[
            (HEADER_SESSION, session.id.clone()),
            (HEADER_TOKEN, lowercase_hex(&session.token)),
        ],
        b"",
    )
    .await;
    assert_eq!(status, "200", "nonce");
    let (nonce, _) = read_lp(&answer);
    let nonce: [u8; 32] = nonce.try_into().unwrap();
    let unix_ms = now_ms();
    let message = sessions::request_bytes(
        &session.id,
        method,
        path,
        &sessions::body_digest(body),
        &nonce,
        unix_ms,
        1,
    );
    vec![
        (HEADER_SESSION, session.id.clone()),
        (HEADER_NONCE, lowercase_hex(&nonce)),
        (HEADER_TIMESTAMP, unix_ms.to_string()),
        (HEADER_COUNTER, "1".to_string()),
        (HEADER_SIGNATURE, lowercase_hex(&session.key.sign(&message))),
    ]
}

/// Sign in as `person`, sign one request, and return the status and body.
async fn call(
    addr: SocketAddr,
    person: &Person,
    method: &str,
    path: &str,
    body: &[u8],
) -> (String, Vec<u8>) {
    let session = sign_in_session(addr, person).await;
    let headers = sign_with(addr, &session, method, path, body).await;
    raw_request(addr, method, path, &headers, body).await
}

// ---- JSON ----

fn parse(body: &[u8]) -> Json {
    Json::parse_canonical(body).unwrap_or_else(|e| {
        panic!(
            "not canonical JSON ({e:?}): {}",
            String::from_utf8_lossy(body)
        )
    })
}

fn field<'a>(j: &'a Json, key: &str) -> &'a Json {
    match j {
        Json::Obj(map) => map.get(key).unwrap_or_else(|| {
            panic!(
                "no {key} in {}",
                String::from_utf8_lossy(&j.to_canonical_bytes())
            )
        }),
        _ => panic!("not an object"),
    }
}

fn text(j: &Json, key: &str) -> String {
    match field(j, key) {
        Json::Str(s) => s.clone(),
        Json::Null => String::new(),
        other => panic!("{key} is not text: {other:?}"),
    }
}

fn int(j: &Json, key: &str) -> i64 {
    match field(j, key) {
        Json::Int(n) => *n,
        other => panic!("{key} is not an integer: {other:?}"),
    }
}

fn boolean(j: &Json, key: &str) -> bool {
    match field(j, key) {
        Json::Bool(b) => *b,
        other => panic!("{key} is not a boolean: {other:?}"),
    }
}

fn array<'a>(j: &'a Json, key: &str) -> &'a Vec<Json> {
    match field(j, key) {
        Json::Arr(a) => a,
        other => panic!("{key} is not an array: {other:?}"),
    }
}

// ---- the routes ----

fn invitations_path(estate: &Estate) -> String {
    format!("/organisations/{}/invitations", estate.organisation)
}

fn issue_body(name: &str, email: &str, capability: &str, scope: Option<ScopeId>) -> Vec<u8> {
    let mut body = Vec::new();
    lp(&mut body, name.as_bytes());
    lp(&mut body, email.as_bytes());
    lp(&mut body, capability.as_bytes());
    lp(
        &mut body,
        scope.map(|s| s.to_string()).unwrap_or_default().as_bytes(),
    );
    body
}

/// What a steward got back when they invited someone.
struct Invited {
    invitation: String,
    account: String,
    sign_in_name: String,
    token: Vec<u8>,
    answer: Vec<u8>,
}

async fn invite(
    addr: SocketAddr,
    estate: &Estate,
    by: &Person,
    name: &str,
    capability: &str,
    scope: Option<ScopeId>,
) -> Invited {
    let (status, answer) = call(
        addr,
        by,
        "POST",
        &invitations_path(estate),
        &issue_body(name, "typed@example.org", capability, scope),
    )
    .await;
    assert_eq!(status, "200", "{}", String::from_utf8_lossy(&answer));
    let json = parse(&answer);
    let token = text(&json, "token");
    assert!(
        token.starts_with("inv_") && token.len() == 4 + 64,
        "{token}"
    );
    Invited {
        invitation: text(&json, "invitation"),
        account: text(&json, "account"),
        sign_in_name: text(&json, "sign_in_name"),
        token: from_hex(&token[4..]),
        answer,
    }
}

async fn operators(pool: &Pool, ring: &Arc<KeyRing>) -> OperatorStore {
    let client = pool.get().await.expect("connection");
    let deployment = chains::deployment_id(&**client).await.expect("deployment");
    OperatorStore::new(pool.clone(), Arc::clone(ring), deployment)
}

/// The person follows the link: a fresh keypair, the sign-in name and the token.
async fn join(pool: &Pool, ring: &Arc<KeyRing>, invited: &Invited) -> Person {
    let key = SoftwareKey::random().expect("a keypair");
    operators(pool, ring)
        .await
        .redeem_account_enrolment(&invited.token, &invited.sign_in_name, &key.public_key())
        .await
        .expect("the link is redeemed");
    Person {
        account: invited.account.parse().expect("account id"),
        address: invited.sign_in_name.clone(),
        key,
    }
}

async fn waiting(addr: SocketAddr, estate: &Estate, by: &Person) -> (String, Vec<u8>) {
    call(addr, by, "GET", &invitations_path(estate), b"").await
}

fn propose_body(items: &[(&str, &str, Option<ScopeId>)], expires: Option<&str>) -> Vec<u8> {
    let mut body = Vec::new();
    lp(&mut body, items.len().to_string().as_bytes());
    for (id, capability, scope) in items {
        lp(&mut body, id.as_bytes());
        lp(&mut body, capability.as_bytes());
        lp(
            &mut body,
            scope.map(|s| s.to_string()).unwrap_or_default().as_bytes(),
        );
    }
    if let Some(expires) = expires {
        lp(&mut body, expires.as_bytes());
    }
    body
}

async fn propose(addr: SocketAddr, estate: &Estate, by: &Person, body: &[u8]) -> (String, Vec<u8>) {
    call(
        addr,
        by,
        "POST",
        &format!(
            "/organisations/{}/invitations/confirm/propose",
            estate.organisation
        ),
        body,
    )
    .await
}

/// What the client does with a proposal: rebuild every grant's bytes from the
/// fields it was shown and refuse unless they are the server's.
fn client_bytes(item: &Json, estate: &Estate, granter: &Person) -> Vec<u8> {
    let fpr = |k: &str| -> [u8; 32] { from_hex(&text(item, k)).try_into().unwrap() };
    let organisation = estate.organisation.to_string();
    let subject = text(item, "subject");
    let granter_id = granter.account.to_string();
    authority::grant_bytes(&GrantFacts {
        organisation: &organisation,
        root_pubkey_fpr: &fpr("root_pubkey_fpr"),
        scope: &text(item, "scope_id"),
        subject: &subject,
        subject_key_fpr: &fpr("subject_key_fpr"),
        capability: Capability::parse(&text(item, "capability")).unwrap(),
        granter: Some(&granter_id),
        granter_key_fpr: &fpr("granter_key_fpr"),
        effective_from_unix: int(item, "effective_from_unix"),
        expires_at_unix: int(item, "expires_at_unix"),
        sole_steward_appointment: boolean(item, "sole_steward_appointment"),
        auth_epoch: int(item, "auth_epoch") as u32 as i32,
    })
}

/// The confirm body for a proposal, each line signed over the bytes the client
/// rebuilt itself. `sign` may corrupt one signature.
fn confirm_body(
    items: &[Json],
    estate: &Estate,
    signer: &Person,
    sign: &dyn Fn(usize, Vec<u8>) -> Vec<u8>,
) -> Vec<u8> {
    let mut body = Vec::new();
    lp(&mut body, items.len().to_string().as_bytes());
    for (index, item) in items.iter().enumerate() {
        let rebuilt = client_bytes(item, estate, signer);
        assert_eq!(
            lowercase_hex(&rebuilt),
            text(item, "bytes"),
            "the client's own bytes must equal the server's for item {index}"
        );
        let signature = sign(index, signer.key.sign(&rebuilt).to_vec());
        lp(&mut body, text(item, "invitation").as_bytes());
        lp(&mut body, text(item, "capability").as_bytes());
        lp(&mut body, text(item, "scope_id").as_bytes());
        lp(
            &mut body,
            int(item, "effective_from_unix").to_string().as_bytes(),
        );
        lp(&mut body, int(item, "auth_epoch").to_string().as_bytes());
        lp(
            &mut body,
            int(item, "expires_at_unix").to_string().as_bytes(),
        );
        lp(&mut body, text(item, "granter_key_fpr").as_bytes());
        lp(&mut body, text(item, "subject_key_fpr").as_bytes());
        lp(&mut body, text(item, "root_pubkey_fpr").as_bytes());
        lp(&mut body, lowercase_hex(&signature).as_bytes());
    }
    body
}

async fn confirm(addr: SocketAddr, estate: &Estate, by: &Person, body: &[u8]) -> (String, Vec<u8>) {
    call(
        addr,
        by,
        "POST",
        &format!("/organisations/{}/invitations/confirm", estate.organisation),
        body,
    )
    .await
}

/// Propose and confirm `ids` at `capability` in `scope`, as `by`, and return the
/// confirm's status and body.
async fn confirm_all(
    addr: SocketAddr,
    estate: &Estate,
    by: &Person,
    ids: &[&str],
    capability: &str,
    scope: Option<ScopeId>,
) -> (String, Vec<u8>) {
    let mut sorted: Vec<&str> = ids.to_vec();
    sorted.sort();
    let items: Vec<(&str, &str, Option<ScopeId>)> =
        sorted.iter().map(|id| (*id, capability, scope)).collect();
    let (status, answer) = propose(addr, estate, by, &propose_body(&items, None)).await;
    assert_eq!(status, "200", "{}", String::from_utf8_lossy(&answer));
    let proposal = parse(&answer);
    let body = confirm_body(array(&proposal, "items"), estate, by, &|_, s| s);
    confirm(addr, estate, by, &body).await
}

// ---- the database, looked at directly ----

async fn su() -> tokio_postgres::Client {
    support::superuser_client_on_test_database().await
}

async fn count(client: &tokio_postgres::Client, sql: &str, param: &str) -> i64 {
    client
        .query_one(sql, &[&param])
        .await
        .expect("count")
        .get(0)
}

async fn org_entries(client: &tokio_postgres::Client, estate: &Estate, entry_type: &str) -> i64 {
    client
        .query_one(
            "SELECT count(*) FROM chain_entries WHERE chain_kind = 'org' AND chain_id = $1 \
              AND entry_type = $2",
            &[&estate.organisation.to_string(), &entry_type],
        )
        .await
        .expect("count entries")
        .get(0)
}

async fn site_entries(client: &tokio_postgres::Client, entry_type: &str) -> i64 {
    client
        .query_one(
            "SELECT count(*) FROM chain_entries WHERE chain_kind = 'site' AND entry_type = $1",
            &[&entry_type],
        )
        .await
        .expect("count entries")
        .get(0)
}

async fn head_epoch(client: &tokio_postgres::Client, estate: &Estate) -> i32 {
    client
        .query_one(
            "SELECT auth_epoch FROM organisation_auth_head WHERE organisation_id = $1",
            &[&estate.organisation.to_string()],
        )
        .await
        .expect("head")
        .get(0)
}

async fn memberships_of(client: &tokio_postgres::Client, account: &str) -> i64 {
    count(
        client,
        "SELECT count(*) FROM memberships WHERE account_id = $1",
        account,
    )
    .await
}

async fn grants_of(client: &tokio_postgres::Client, account: &str) -> i64 {
    count(
        client,
        "SELECT count(*) FROM scope_grants WHERE subject_id = $1",
        account,
    )
    .await
}

/// The whole of the organisation chain and the site chain still verify.
async fn the_chains_verify(pool: &Pool, ring: &KeyRing, estate: &Estate) {
    let mut client = pool.get().await.expect("connection");
    let (tx, ctx, _) = tenant_tx(
        &mut client,
        ring,
        estate.organisation,
        estate.stewards[0].account,
    )
    .await;
    let report = chains::verify_org(&tx, ring, &ctx, true)
        .await
        .expect("verify the organisation chain");
    assert!(
        matches!(
            report.outcome,
            fathom_server::chain::Outcome::Verified { .. }
        ),
        "{report}"
    );
    let report = chains::verify_site(&tx, ring, false)
        .await
        .expect("verify the site chain");
    assert!(
        matches!(
            report.outcome,
            fathom_server::chain::Outcome::Verified { .. }
        ),
        "{report}"
    );
    tx.rollback().await.expect("rollback");
}

/// Read one invitation row as the steward who may see it.
async fn read_row(
    pool: &Pool,
    ring: &KeyRing,
    estate: &Estate,
    id: &str,
) -> invitations::InvitationRow {
    let mut client = pool.get().await.expect("connection");
    let (tx, _ctx, _) = tenant_tx(
        &mut client,
        ring,
        estate.organisation,
        estate.stewards[0].account,
    )
    .await;
    let row = invitations::read_invitation(&tx, id, false)
        .await
        .expect("read")
        .expect("the invitation exists");
    tx.rollback().await.expect("rollback");
    row
}

// ===========================================================================
// 1. 0037's policies and trigger, as `fathom_app`
// ===========================================================================

/// An invitation row exists for the tests below: issued through the library as
/// the estate's first steward, with the caps lifted so it never refuses.
async fn issued_directly(
    pool: &Pool,
    ring: &Arc<KeyRing>,
    estate: &Estate,
    name: &str,
    capability: Capability,
    scope: Option<ScopeId>,
) -> (invitations::Issued, Vec<u8>) {
    let mut client = pool.get().await.expect("connection");
    let (tx, ctx, tenant_key) = tenant_tx(
        &mut client,
        ring,
        estate.organisation,
        estate.stewards[0].account,
    )
    .await;
    let watch = EpochWatch::new();
    let auth = Authority {
        ring,
        ctx: &ctx,
        tenant_key: &tenant_key,
        watch: &watch,
    };
    let limits = Limits {
        open_max: 100_000,
        per_steward_per_day: 100_000,
    };
    let issued = invitations::issue(
        &tx,
        pool,
        ring,
        &auth,
        &invitations::IssueRequest {
            display_name: name.to_string(),
            contact_email: Some("note@example.org".to_string()),
            capability,
            scope,
        },
        &limits,
    )
    .await
    .expect("issued");
    tx.commit().await.expect("commit");
    let token = from_hex(&issued.token[4..]);
    (issued, token)
}

#[tokio::test]
async fn a_steward_shaped_token_is_refused_without_the_custody_or_for_another_issuer() {
    let _site = support::lock_the_site_chain().await;
    let pool = support::migrated_pool().await;
    let ring = ring();
    let estate = bootstrap(&pool, &ring, 1).await;
    let (issued, _) =
        issued_directly(&pool, &ring, &estate, "Custody", Capability::Read, None).await;

    // The shape of a steward's token row, with a fresh id and hash each time.
    const INSERT: &str = "INSERT INTO enrolment_tokens \
        (id, purpose, token_hash, account_id, issued_by, issued_by_account, invitation_id, \
         issued_seq, expires_at, row_version, row_seal) \
        VALUES ($1, 'account', $2, $3, NULL, $4, $5, 1, now() + interval '1 hour', 1, $6)";
    let steward = estate.stewards[0].account.to_string();

    // As the application role, in the steward's own tenant context.
    let attempt = |custody: Option<&'static str>, issuer: String, invitation: String| {
        let pool = pool.clone();
        let (ring, estate_org, steward_id, account) = (
            ring.clone(),
            estate.organisation,
            estate.stewards[0].account,
            issued.account.clone(),
        );
        async move {
            let mut client = pool.get().await.expect("connection");
            let (tx, _ctx, _) = tenant_tx(&mut client, &ring, estate_org, steward_id).await;
            if let Some(custody) = custody {
                tx.execute(
                    "SELECT set_config('app.invitation_custody', $1, true)",
                    &[&custody],
                )
                .await
                .unwrap();
            }
            let id = fathom_server::ids::new_ulid().to_string();
            let hash = Key32::random().unwrap().expose().to_vec();
            let result = tx
                .execute(
                    INSERT,
                    &[&id, &hash, &account, &issuer, &invitation, &vec![7u8; 32]],
                )
                .await;
            let _ = tx.rollback().await;
            result
        }
    };

    // No custody: refused by row security, not by a constraint.
    let refused = attempt(None, steward.clone(), issued.invitation.clone()).await;
    let error = refused.expect_err("no invitation custody, no token");
    assert_eq!(
        error.code(),
        Some(&tokio_postgres::error::SqlState::INSUFFICIENT_PRIVILEGE),
        "{error}"
    );
    // Custody but the issuer is not the account acting: refused.
    let other = estate.stewards[0].account.to_string().replace('0', "1");
    let refused = attempt(Some("yes"), other, issued.invitation.clone()).await;
    assert!(refused.is_err(), "an issuer other than app.account_id");
    // The same row, custody and the right issuer: passes the policy (the row
    // then fails only because its invitation already has a token).
    let accepted = attempt(Some("yes"), steward, issued.invitation.clone()).await;
    let error = accepted.expect_err("the invitation has its one token already");
    assert_eq!(
        error.code(),
        Some(&tokio_postgres::error::SqlState::UNIQUE_VIOLATION),
        "the policy admitted the row and only uniqueness refused it: {error}"
    );
}

#[tokio::test]
async fn the_invitation_table_isolates_tenants_refuses_delete_and_every_illegal_move() {
    let _site = support::lock_the_site_chain().await;
    let pool = support::migrated_pool().await;
    let ring = ring();
    let estate = bootstrap(&pool, &ring, 1).await;
    let elsewhere = bootstrap(&pool, &ring, 1).await;
    let (issued, _) =
        issued_directly(&pool, &ring, &estate, "Isolation", Capability::Read, None).await;

    // Tenant isolation: the other organisation's steward reads no row of it.
    let mut client = pool.get().await.unwrap();
    let (tx, _, _) = tenant_tx(
        &mut client,
        &ring,
        elsewhere.organisation,
        elsewhere.stewards[0].account,
    )
    .await;
    let seen: i64 = tx
        .query_one("SELECT count(*) FROM organisation_invitations", &[])
        .await
        .unwrap()
        .get(0);
    assert_eq!(seen, 0, "another tenant's invitation is not visible");
    // ... and cannot write one into the first tenant's organisation.
    let none = tx
        .execute(
            "UPDATE organisation_invitations SET state = 'cancelled' WHERE id = $1",
            &[&issued.invitation],
        )
        .await;
    assert!(
        none.is_err() || matches!(none, Ok(0)),
        "no update across tenants"
    );
    tx.rollback().await.unwrap();

    let steward = estate.stewards[0].account;
    // No DELETE for the application role at all.
    let (tx, _, _) = tenant_tx(&mut client, &ring, estate.organisation, steward).await;
    tx.execute(
        "SELECT set_config('app.invitation_custody', 'yes', true)",
        &[],
    )
    .await
    .unwrap();
    let error = tx
        .execute(
            "DELETE FROM organisation_invitations WHERE id = $1",
            &[&issued.invitation],
        )
        .await
        .expect_err("delete is refused");
    assert_eq!(
        error.code(),
        Some(&tokio_postgres::error::SqlState::INSUFFICIENT_PRIVILEGE)
    );
    tx.rollback().await.unwrap();

    // A column outside the grant list is refused at the privilege layer.
    let (tx, _, _) = tenant_tx(&mut client, &ring, estate.organisation, steward).await;
    tx.execute(
        "SELECT set_config('app.invitation_custody', 'yes', true)",
        &[],
    )
    .await
    .unwrap();
    let error = tx
        .execute(
            "UPDATE organisation_invitations SET display_name = 'Someone Else' WHERE id = $1",
            &[&issued.invitation],
        )
        .await
        .expect_err("the request columns are not updatable");
    assert_eq!(
        error.code(),
        Some(&tokio_postgres::error::SqlState::INSUFFICIENT_PRIVILEGE)
    );
    tx.rollback().await.unwrap();

    // Illegal moves, by the trigger: with the steward custody an `asked` row may
    // not become `confirmed`, `refused` or `joined`; and the trigger is also what
    // says only a redemption joins.
    for (to, why) in [
        ("confirmed", "asked to confirmed skips joining"),
        ("refused", "asked to refused skips joining"),
        ("joined", "a steward may not mark somebody joined"),
    ] {
        let (tx, _, _) = tenant_tx(&mut client, &ring, estate.organisation, steward).await;
        tx.execute(
            "SELECT set_config('app.invitation_custody', 'yes', true)",
            &[],
        )
        .await
        .unwrap();
        let error = tx
            .execute(
                "UPDATE organisation_invitations SET state = $2, row_version = row_version + 1 \
                  WHERE id = $1",
                &[&issued.invitation, &to],
            )
            .await
            .expect_err(why);
        let said = error
            .as_db_error()
            .map(|e| e.message().to_owned())
            .unwrap_or_default();
        assert!(
            said.contains("may not move") || said.contains("only a redemption"),
            "{why}: {said}"
        );
        tx.rollback().await.unwrap();
    }
    // The legal move for a steward passes: asked to cancelled, version bumped.
    let (tx, _, _) = tenant_tx(&mut client, &ring, estate.organisation, steward).await;
    tx.execute(
        "SELECT set_config('app.invitation_custody', 'yes', true)",
        &[],
    )
    .await
    .unwrap();
    let moved = tx
        .execute(
            "UPDATE organisation_invitations \
                SET state = 'cancelled', closed_at = now(), closed_seq = 1, closed_by = $2, \
                    row_version = row_version + 1 \
              WHERE id = $1",
            &[&issued.invitation, &steward.to_string()],
        )
        .await
        .expect("asked to cancelled is a legal move");
    assert_eq!(
        moved, 1,
        "the positive control: the legal move updates the row"
    );
    tx.rollback().await.unwrap();

    // TRUNCATE is refused even for the superuser.
    let superuser = su().await;
    let error = superuser
        .batch_execute("BEGIN; TRUNCATE organisation_invitations CASCADE")
        .await
        .expect_err("truncate is refused");
    superuser.batch_execute("ROLLBACK").await.unwrap();
    let said = error
        .as_db_error()
        .map(|e| e.message().to_owned())
        .unwrap_or_default();
    assert!(said.contains("append-only"), "{said}");
}

// ===========================================================================
// 2. Issue
// ===========================================================================

#[tokio::test]
async fn a_steward_invites_someone_and_every_part_of_it_is_recorded() {
    let _site = support::lock_the_site_chain().await;
    let pool = support::migrated_pool().await;
    let ring = ring();
    let estate = bootstrap(&pool, &ring, 1).await;
    let addr = serve(app(&pool, Arc::clone(&ring), Limits::STANDARD).await).await;
    let superuser = su().await;

    let account_created = site_entries(&superuser, "account_created").await;
    let token_issued = site_entries(&superuser, "enrolment_token_issued").await;
    let org_issued = org_entries(&superuser, &estate, "invitation_issued").await;

    let invited = invite(
        addr,
        &estate,
        &estate.stewards[0],
        "Grace Hopper",
        "draw",
        None,
    )
    .await;

    // The sign-in name is the server's, with no "@"; the typed email is a
    // contact note on the invitation and is nowhere in `accounts`.
    assert!(
        !invited.sign_in_name.contains('@'),
        "{}",
        invited.sign_in_name
    );
    assert!(invited.sign_in_name.starts_with("grace-hopper-"));
    let row = read_row(&pool, &ring, &estate, &invited.invitation).await;
    assert_eq!(row.contact_email.as_deref(), Some("typed@example.org"));
    assert_eq!(row.sign_in_name, invited.sign_in_name);
    assert_eq!(row.capability_asked, Capability::Draw);
    assert_eq!(row.state, invitations::State::Asked);
    assert!(invitations::row_verifies(&ring, &row));
    let stored_email: String = superuser
        .query_one(
            "SELECT email FROM accounts WHERE id = $1",
            &[&invited.account],
        )
        .await
        .unwrap()
        .get(0);
    assert_eq!(
        stored_email, invited.sign_in_name,
        "the account's address is the sign-in name"
    );
    assert_eq!(
        count(
            &superuser,
            "SELECT count(*) FROM accounts WHERE email = $1",
            "typed@example.org"
        )
        .await,
        0,
        "the typed email is in no account"
    );

    // The token was answered once, and only its hash is stored anywhere: scan
    // every table, as text, for the token's hex.
    let token_hex = lowercase_hex(&invited.token);
    assert!(String::from_utf8_lossy(&invited.answer).contains(&token_hex));
    let tables: Vec<String> = superuser
        .query(
            "SELECT table_name FROM information_schema.tables \
              WHERE table_schema = 'public' AND table_type = 'BASE TABLE'",
            &[],
        )
        .await
        .unwrap()
        .iter()
        .map(|r| r.get(0))
        .collect();
    for table in tables {
        let found: i64 = superuser
            .query_one(
                &format!("SELECT count(*) FROM {table} t WHERE t::text ILIKE '%' || $1 || '%'"),
                &[&token_hex],
            )
            .await
            .unwrap()
            .get(0);
        assert_eq!(found, 0, "the token's bytes are in {table}");
    }

    // The three entries are written, and both chains still verify.
    assert_eq!(
        site_entries(&superuser, "account_created").await,
        account_created + 1
    );
    assert_eq!(
        site_entries(&superuser, "enrolment_token_issued").await,
        token_issued + 1
    );
    assert_eq!(
        org_entries(&superuser, &estate, "invitation_issued").await,
        org_issued + 1
    );
    the_chains_verify(&pool, &ring, &estate).await;

    // The invitation has no membership and no grant: it is a request.
    assert_eq!(memberships_of(&superuser, &invited.account).await, 0);
    assert_eq!(grants_of(&superuser, &invited.account).await, 0);
}

#[tokio::test]
async fn a_non_steward_and_a_folder_steward_asking_at_the_root_are_refused_identically() {
    let _site = support::lock_the_site_chain().await;
    let pool = support::migrated_pool().await;
    let ring = ring();
    let estate = bootstrap(&pool, &ring, 2).await;
    let folder = a_scope(&pool, &estate, None, ScopeKind::Network).await;
    let sibling = a_scope(&pool, &estate, None, ScopeKind::Network).await;
    let drawer = a_member(
        &pool,
        &ring,
        &estate,
        "drawer",
        Some((None, Capability::Draw)),
    )
    .await;
    let folder_steward = a_folder_steward(&pool, &ring, &estate, folder, "folder-steward").await;
    let addr = serve(app(&pool, Arc::clone(&ring), Limits::STANDARD).await).await;

    let path = invitations_path(&estate);
    let at_root = issue_body("Nobody", "", "read", None);
    let (a_status, a_body) = call(addr, &drawer, "POST", &path, &at_root).await;
    let (b_status, b_body) = call(addr, &folder_steward, "POST", &path, &at_root).await;
    assert_eq!((a_status.as_str(), &a_body), ("403", &b_body), "{a_body:?}");
    assert_eq!(a_status, b_status);
    // Nor can the folder steward invite at a sibling folder: the same refusal.
    let (c_status, c_body) = call(
        addr,
        &folder_steward,
        "POST",
        &path,
        &issue_body("Nobody", "", "read", Some(sibling)),
    )
    .await;
    assert_eq!((c_status.as_str(), &c_body), ("403", &a_body));
    // The positive control: at their own folder they may.
    let (status, answer) = call(
        addr,
        &folder_steward,
        "POST",
        &path,
        &issue_body("Somebody", "", "read", Some(folder)),
    )
    .await;
    assert_eq!(status, "200", "{}", String::from_utf8_lossy(&answer));
}

#[tokio::test]
async fn an_invitation_has_no_account_field_and_the_caps_hold() {
    let _site = support::lock_the_site_chain().await;
    let pool = support::migrated_pool().await;
    let ring = ring();
    let estate = bootstrap(&pool, &ring, 1).await;
    let steward = &estate.stewards[0];
    let path = invitations_path(&estate);

    // Production's numbers are the design's.
    assert_eq!(invitations::Limits::STANDARD.open_max, 500);
    assert_eq!(invitations::Limits::STANDARD.per_steward_per_day, 50);
    assert_eq!(invitations::CONFIRM_BATCH_MAX, 500);

    // A body that names an account is not part of the format.
    let addr = serve(
        app(
            &pool,
            Arc::clone(&ring),
            Limits {
                open_max: 3,
                per_steward_per_day: 100,
            },
        )
        .await,
    )
    .await;
    let mut with_account = issue_body("Mallory", "", "read", None);
    lp(
        &mut with_account,
        estate.stewards[0].account.to_string().as_bytes(),
    );
    let (status, _) = call(addr, steward, "POST", &path, &with_account).await;
    assert_eq!(status, "400");

    // The open-invitation cap: three are fine, the fourth is refused, and a
    // cancelled one frees a place.
    let mut first = None;
    for n in 0..3 {
        let invited = invite(addr, &estate, steward, &format!("Cap {n}"), "read", None).await;
        first.get_or_insert(invited.invitation);
    }
    let (status, answer) = call(
        addr,
        steward,
        "POST",
        &path,
        &issue_body("One too many", "", "read", None),
    )
    .await;
    assert_eq!(status, "429", "{}", String::from_utf8_lossy(&answer));
    let (status, _) = call(
        addr,
        steward,
        "POST",
        &format!("{path}/{}/cancel", first.unwrap()),
        b"",
    )
    .await;
    assert_eq!(status, "200");
    invite(addr, &estate, steward, "After the cancel", "read", None).await;

    // The per-steward daily rate.
    let limited = serve(
        app(
            &pool,
            Arc::clone(&ring),
            Limits {
                open_max: 1000,
                per_steward_per_day: 1,
            },
        )
        .await,
    )
    .await;
    let other_estate = bootstrap(&pool, &ring, 1).await;
    invite(
        limited,
        &other_estate,
        &other_estate.stewards[0],
        "Rate 1",
        "read",
        None,
    )
    .await;
    let (status, _) = call(
        limited,
        &other_estate.stewards[0],
        "POST",
        &invitations_path(&other_estate),
        &issue_body("Rate 2", "", "read", None),
    )
    .await;
    assert_eq!(status, "429");
}

// ===========================================================================
// 3. Redemption: the link enrols a first key and nothing else
// ===========================================================================

#[tokio::test]
async fn the_link_enrols_the_first_key_and_marks_the_invitation_joined() {
    let _site = support::lock_the_site_chain().await;
    let pool = support::migrated_pool().await;
    let ring = ring();
    let estate = bootstrap(&pool, &ring, 1).await;
    let (issued, token) =
        issued_directly(&pool, &ring, &estate, "Joiner", Capability::Draw, None).await;
    let superuser = su().await;
    let redeemed_before = site_entries(&superuser, "enrolment_token_redeemed").await;

    let key = SoftwareKey::random().unwrap();
    let key_id = operators(&pool, &ring)
        .await
        .redeem_account_enrolment(&token, &issued.sign_in_name, &key.public_key())
        .await
        .expect("redeemed");

    let row = read_row(&pool, &ring, &estate, &issued.invitation).await;
    assert_eq!(row.state, invitations::State::Joined);
    assert_eq!(
        row.enrolled_key_fpr,
        Some(authority::key_fingerprint(&key.public_key())),
        "the invitation seals the fingerprint of the posted key"
    );
    assert_eq!(row.enrolled_key_id.as_deref(), Some(key_id.as_str()));
    assert!(invitations::row_verifies(&ring, &row));
    assert_eq!(
        site_entries(&superuser, "enrolment_token_redeemed").await,
        redeemed_before + 1,
        "the join is the site entry the redemption already writes, with the invitation named"
    );
    // A key and nothing else.
    assert_eq!(memberships_of(&superuser, &issued.account).await, 0);
    assert_eq!(grants_of(&superuser, &issued.account).await, 0);
    the_chains_verify(&pool, &ring, &estate).await;
}

#[tokio::test]
async fn a_link_is_single_use_and_the_wrong_sign_in_name_does_not_spend_it() {
    let _site = support::lock_the_site_chain().await;
    let pool = support::migrated_pool().await;
    let ring = ring();
    let estate = bootstrap(&pool, &ring, 1).await;
    let (issued, token) =
        issued_directly(&pool, &ring, &estate, "Single", Capability::Read, None).await;
    let store = operators(&pool, &ring).await;
    let key = SoftwareKey::random().unwrap();

    let wrong = store
        .redeem_account_enrolment(&token, "someone-else-00000000", &key.public_key())
        .await;
    assert!(
        matches!(wrong, Err(OperatorError::EnrolmentRefused)),
        "{wrong:?}"
    );
    let row = read_row(&pool, &ring, &estate, &issued.invitation).await;
    assert_eq!(
        row.state,
        invitations::State::Asked,
        "a wrong guess spends nothing"
    );

    store
        .redeem_account_enrolment(&token, &issued.sign_in_name, &key.public_key())
        .await
        .expect("the right name still works");
    let again = store
        .redeem_account_enrolment(
            &token,
            &issued.sign_in_name,
            &SoftwareKey::random().unwrap().public_key(),
        )
        .await;
    assert!(
        matches!(again, Err(OperatorError::EnrolmentRefused)),
        "{again:?}"
    );
}

#[tokio::test]
async fn a_link_is_refused_after_a_cancel_after_72_hours_and_for_an_account_with_a_key() {
    let _site = support::lock_the_site_chain().await;
    let pool = support::migrated_pool().await;
    let ring = ring();
    let estate = bootstrap(&pool, &ring, 1).await;
    let addr = serve(app(&pool, Arc::clone(&ring), Limits::STANDARD).await).await;
    let store = operators(&pool, &ring).await;
    let steward = &estate.stewards[0];
    let superuser = su().await;

    // After a cancel.
    let cancelled = invite(addr, &estate, steward, "Cancelled", "read", None).await;
    let (status, _) = call(
        addr,
        steward,
        "POST",
        &format!(
            "{}/{}/cancel",
            invitations_path(&estate),
            cancelled.invitation
        ),
        b"",
    )
    .await;
    assert_eq!(status, "200");
    let refused = store
        .redeem_account_enrolment(
            &cancelled.token,
            &cancelled.sign_in_name,
            &SoftwareKey::random().unwrap().public_key(),
        )
        .await;
    assert!(
        matches!(refused, Err(OperatorError::EnrolmentRefused)),
        "{refused:?}"
    );

    // After 72 hours: the token's expiry moved into the past, the row re-sealed so
    // it is the expiry that refuses and not a stale seal.
    let late = invite(addr, &estate, steward, "Late", "read", None).await;
    {
        let row = superuser
            .query_one(
                "SELECT token_hash, issued_seq, row_version, id FROM enrolment_tokens \
                  WHERE invitation_id = $1",
                &[&late.invitation],
            )
            .await
            .unwrap();
        let token_hash: Vec<u8> = row.get(0);
        let token_hash: [u8; 32] = token_hash.try_into().unwrap();
        let (issued_seq, row_version, token_id): (i64, i32, String) =
            (row.get(1), row.get(2), row.get(3));
        let past = now_unix() - 1;
        let steward_id = steward.account.to_string();
        let facts = TokenFacts {
            id: &token_id,
            purpose: fathom_server::operators::Purpose::Account,
            token_hash: &token_hash,
            subject: &late.account,
            issued_by: "",
            issued_by_account: Some(&steward_id),
            invitation: Some(&late.invitation),
            expires_at_unix: past,
            redeemed_at_unix: 0,
            expired_at_unix: 0,
        };
        let mut client = pool.get().await.unwrap();
        let tx = client.transaction().await.unwrap();
        let seal = store
            .token_seal(&tx, &facts, issued_seq, row_version)
            .await
            .expect("reseal");
        support::tamper(
            &superuser,
            "enrolment_tokens",
            "UPDATE enrolment_tokens SET expires_at = to_timestamp($2::bigint), \
                 issued_at = to_timestamp($2::bigint) - interval '1 hour', row_seal = $3 \
              WHERE id = $1",
            &[&token_id, &past, &seal.to_vec()],
        )
        .await;
    }
    let refused = store
        .redeem_account_enrolment(
            &late.token,
            &late.sign_in_name,
            &SoftwareKey::random().unwrap().public_key(),
        )
        .await;
    assert!(
        matches!(refused, Err(OperatorError::EnrolmentRefused)),
        "{refused:?}"
    );

    // For an account that already has a key: the link enrols a first key only.
    let keyed = invite(addr, &estate, steward, "Keyed", "read", None).await;
    {
        let mut client = pool.get().await.unwrap();
        let tx = client.transaction().await.unwrap();
        tx.execute(
            "SELECT set_config('app.account_id', $1, true)",
            &[&keyed.account],
        )
        .await
        .unwrap();
        let someone_elses_key = SoftwareKey::random().unwrap();
        let deployment = chains::deployment_id(&*tx).await.unwrap();
        grants::enrol_software_key_at_invitation(
            &tx,
            &ring,
            &deployment,
            &keyed.account,
            &someone_elses_key.public_key(),
        )
        .await
        .expect("an operator-style key lands on the shell first");
        tx.commit().await.unwrap();
    }
    let refused = store
        .redeem_account_enrolment(
            &keyed.token,
            &keyed.sign_in_name,
            &SoftwareKey::random().unwrap().public_key(),
        )
        .await;
    assert!(
        matches!(refused, Err(OperatorError::EnrolmentRefused)),
        "an invitation token must not add a key to a keyed account: {refused:?}"
    );
    let row = read_row(&pool, &ring, &estate, &keyed.invitation).await;
    assert_eq!(row.state, invitations::State::Asked);
    // And confirm would refuse it anyway (the live key set is not the enrolled one),
    // so there is nothing to confirm: the row never reached `joined`.
}

#[tokio::test]
async fn a_tampered_invitation_row_is_refused_at_redemption() {
    let _site = support::lock_the_site_chain().await;
    let pool = support::migrated_pool().await;
    let ring = ring();
    let estate = bootstrap(&pool, &ring, 1).await;
    let (issued, token) =
        issued_directly(&pool, &ring, &estate, "Tampered", Capability::Read, None).await;
    let superuser = su().await;
    support::tamper(
        &superuser,
        "organisation_invitations",
        "UPDATE organisation_invitations SET capability_asked = 'steward' WHERE id = $1",
        &[&issued.invitation],
    )
    .await;
    let refused = operators(&pool, &ring)
        .await
        .redeem_account_enrolment(
            &token,
            &issued.sign_in_name,
            &SoftwareKey::random().unwrap().public_key(),
        )
        .await;
    assert!(
        matches!(refused, Err(OperatorError::Unverifiable(_))),
        "a row edited to ask for steward does not verify, so it enrols nothing: {refused:?}"
    );
}

// ===========================================================================
// 4. No access before confirm
// ===========================================================================

#[tokio::test]
async fn somebody_who_has_joined_but_not_been_confirmed_has_no_access_of_any_kind() {
    let _site = support::lock_the_site_chain().await;
    let pool = support::migrated_pool().await;
    let ring = ring();
    let estate = bootstrap(&pool, &ring, 1).await;
    let scope = a_scope(&pool, &estate, None, ScopeKind::Network).await;
    let addr = serve(app(&pool, Arc::clone(&ring), Limits::STANDARD).await).await;
    let invited = invite(
        addr,
        &estate,
        &estate.stewards[0],
        "Unconfirmed",
        "read",
        Some(scope),
    )
    .await;
    let person = join(&pool, &ring, &invited).await;
    let superuser = su().await;

    // The sign-in name works, and the organisation list is empty.
    let (status, list) = call(addr, &person, "GET", "/organisations", b"").await;
    assert_eq!(status, "200", "{}", String::from_utf8_lossy(&list));
    assert_eq!(parse(&list), Json::Arr(Vec::new()));
    // The organisation refuses them as it refuses a stranger.
    let stranger = a_member(&pool, &ring, &estate, "stranger", None).await;
    let (status, _) = call(
        addr,
        &person,
        "GET",
        &format!("/organisations/{}/scopes", estate.organisation),
        b"",
    )
    .await;
    assert_ne!(status, "200");
    let (none_status, _) = call(
        addr,
        &stranger,
        "GET",
        &format!("/organisations/{}/people", estate.organisation),
        b"",
    )
    .await;
    assert_eq!(none_status, "403");
    let (status, _) = call(
        addr,
        &person,
        "GET",
        &format!("/organisations/{}/people", estate.organisation),
        b"",
    )
    .await;
    assert_ne!(status, "200", "the joined person lists nobody");
    assert_eq!(memberships_of(&superuser, &invited.account).await, 0);

    // Sharing to them is refused: they are not a member.
    let mut body = Vec::new();
    lp(&mut body, invited.account.as_bytes());
    lp(&mut body, b"read");
    let (status, _) = call(
        addr,
        &estate.stewards[0],
        "POST",
        &format!(
            "/organisations/{}/scopes/{}/grants/propose",
            estate.organisation, scope
        ),
        &body,
    )
    .await;
    assert_ne!(status, "200", "a share to a non-member is refused");
}

// ===========================================================================
// 5. The Waiting list
// ===========================================================================

#[tokio::test]
async fn a_steward_sees_who_is_waiting_with_the_key_code_and_a_non_steward_sees_nothing() {
    let _site = support::lock_the_site_chain().await;
    let pool = support::migrated_pool().await;
    let ring = ring();
    let estate = bootstrap(&pool, &ring, 1).await;
    let drawer = a_member(
        &pool,
        &ring,
        &estate,
        "drawer",
        Some((None, Capability::Draw)),
    )
    .await;
    let addr = serve(app(&pool, Arc::clone(&ring), Limits::STANDARD).await).await;
    let steward = &estate.stewards[0];

    let invited = invite(addr, &estate, steward, "Ada Waits", "draw", None).await;
    let before = parse(&waiting(addr, &estate, steward).await.1);
    let item = array(&before, "invitations")
        .iter()
        .find(|i| text(i, "id") == invited.invitation)
        .expect("invited but not joined is on the list")
        .clone();
    assert_eq!(text(&item, "state"), "asked");
    assert!(matches!(field(&item, "key_code"), Json::Null));
    assert_eq!(
        int(&before, "waiting_count"),
        0,
        "not joined is not waiting"
    );

    let person = join(&pool, &ring, &invited).await;
    let after = parse(&waiting(addr, &estate, steward).await.1);
    let item = array(&after, "invitations")
        .iter()
        .find(|i| text(i, "id") == invited.invitation)
        .unwrap()
        .clone();
    assert_eq!(text(&item, "state"), "joined");
    assert_eq!(int(&after, "waiting_count"), 1);
    assert_eq!(text(&item, "display_name"), "Ada Waits");
    assert_eq!(text(&item, "contact_email"), "typed@example.org");
    assert_eq!(text(&item, "sign_in_name"), invited.sign_in_name);
    assert_eq!(text(&item, "capability_asked"), "draw");
    assert_eq!(text(&item, "issued_by"), steward.account.to_string());
    assert!(!text(&item, "issued_by_name").is_empty());
    assert!(int(&item, "issued_at_unix") > 0 && int(&item, "joined_at_unix") > 0);
    assert!(int(&item, "window_ends_at_unix") > int(&item, "joined_at_unix"));
    assert!(boolean(&item, "can_confirm"));
    let fpr = authority::key_fingerprint(&person.key.public_key());
    assert_eq!(
        text(&item, "key_code"),
        invitations::key_code(&fpr),
        "the code is the first 50 bits of the key's fingerprint, which the joiner computes locally"
    );

    // A non-steward: the plain refusal, and no email anywhere in the answer.
    let (status, answer) = waiting(addr, &estate, &drawer).await;
    assert_eq!(status, "403");
    assert!(!String::from_utf8_lossy(&answer).contains("typed@example.org"));
    // Nor does the People page.
    let (status, answer) = call(
        addr,
        &drawer,
        "GET",
        &format!("/organisations/{}/people", estate.organisation),
        b"",
    )
    .await;
    assert_eq!(status, "403");
    assert!(!String::from_utf8_lossy(&answer).contains("typed@example.org"));
}

#[tokio::test]
async fn a_folder_steward_sees_only_their_own_subtree_and_a_bad_row_is_flagged() {
    let _site = support::lock_the_site_chain().await;
    let pool = support::migrated_pool().await;
    let ring = ring();
    let estate = bootstrap(&pool, &ring, 2).await;
    let mine = a_scope(&pool, &estate, None, ScopeKind::Network).await;
    let theirs = a_scope(&pool, &estate, None, ScopeKind::Network).await;
    let folder_steward = a_folder_steward(&pool, &ring, &estate, mine, "folder-steward").await;
    let addr = serve(app(&pool, Arc::clone(&ring), Limits::STANDARD).await).await;

    let a = invite(
        addr,
        &estate,
        &estate.stewards[0],
        "In Mine",
        "read",
        Some(mine),
    )
    .await;
    let b = invite(
        addr,
        &estate,
        &estate.stewards[0],
        "In Theirs",
        "read",
        Some(theirs),
    )
    .await;
    let c = invite(addr, &estate, &estate.stewards[0], "At Root", "read", None).await;
    let seen = parse(&waiting(addr, &estate, &folder_steward).await.1);
    let ids: Vec<String> = array(&seen, "invitations")
        .iter()
        .map(|i| text(i, "id"))
        .collect();
    assert_eq!(ids, vec![a.invitation.clone()], "only the subtree: {ids:?}");
    // The organisation steward sees all three.
    let all = parse(&waiting(addr, &estate, &estate.stewards[0]).await.1);
    assert_eq!(array(&all, "invitations").len(), 3);
    let _ = (b, c);

    // An unverifiable row is flagged and cannot be confirmed.
    let person = join(&pool, &ring, &a).await;
    let superuser = su().await;
    support::tamper(
        &superuser,
        "organisation_invitations",
        "UPDATE organisation_invitations SET display_name = 'Edited Outside' WHERE id = $1",
        &[&a.invitation],
    )
    .await;
    let seen = parse(&waiting(addr, &estate, &estate.stewards[0]).await.1);
    let item = array(&seen, "invitations")
        .iter()
        .find(|i| text(i, "id") == a.invitation)
        .unwrap();
    assert!(boolean(item, "unverifiable"));
    assert!(!boolean(item, "can_confirm"));
    assert_eq!(int(&seen, "waiting_count"), 0);
    let (status, _) = propose(
        addr,
        &estate,
        &estate.stewards[0],
        &propose_body(&[(&a.invitation, "read", Some(mine))], None),
    )
    .await;
    assert_ne!(status, "200", "an unverifiable row cannot be proposed");
    let _ = person;
}

// ===========================================================================
// 6. Confirm N = 3, 7. atomicity, 8. shape, 9. stale
// ===========================================================================

/// Three people invited, joined, and waiting at `scope`.
async fn three_waiting(
    pool: &Pool,
    ring: &Arc<KeyRing>,
    addr: SocketAddr,
    estate: &Estate,
    scope: Option<ScopeId>,
) -> Vec<(Invited, Person)> {
    let mut out = Vec::new();
    for n in 0..3 {
        let invited = invite(
            addr,
            estate,
            &estate.stewards[0],
            &format!("Waiting {n}"),
            "read",
            scope,
        )
        .await;
        let person = join(pool, ring, &invited).await;
        out.push((invited, person));
    }
    out
}

#[tokio::test]
async fn confirming_three_people_signs_three_grants_that_each_verify_on_their_own() {
    let _site = support::lock_the_site_chain().await;
    let pool = support::migrated_pool().await;
    let ring = ring();
    let estate = bootstrap(&pool, &ring, 1).await;
    let scope = a_scope(&pool, &estate, None, ScopeKind::Network).await;
    let addr = serve(app(&pool, Arc::clone(&ring), Limits::STANDARD).await).await;
    let people = three_waiting(&pool, &ring, addr, &estate, Some(scope)).await;
    let superuser = su().await;
    let head_before = head_epoch(&superuser, &estate).await;
    let closed_before = org_entries(&superuser, &estate, "invitation_closed").await;
    let ids: Vec<&str> = people.iter().map(|(i, _)| i.invitation.as_str()).collect();

    let (status, answer) = confirm_all(
        addr,
        &estate,
        &estate.stewards[0],
        &ids,
        "read",
        Some(scope),
    )
    .await;
    assert_eq!(status, "200", "{}", String::from_utf8_lossy(&answer));
    let done = parse(&answer);
    let batch_id = text(&done, "batch_id");
    assert_eq!(array(&done, "confirmed").len(), 3);

    // Consecutive epochs, one head advance per grant.
    assert_eq!(head_epoch(&superuser, &estate).await, head_before + 3);
    let mut epochs = Vec::new();
    for item in array(&done, "confirmed") {
        let row = superuser
            .query_one(
                "SELECT auth_epoch, capability, subject_id, granter_sig, scope_id FROM scope_grants WHERE id = $1",
                &[&text(item, "grant")],
            )
            .await
            .unwrap();
        epochs.push(row.get::<_, i32>(0));
        assert_eq!(row.get::<_, String>(1), "read");
    }
    epochs.sort();
    assert_eq!(
        epochs,
        vec![head_before + 1, head_before + 2, head_before + 3]
    );

    for (invited, person) in &people {
        // A member, and only ever `member`.
        let role: String = superuser
            .query_one(
                "SELECT role FROM memberships WHERE account_id = $1 AND organisation_id = $2",
                &[&invited.account, &estate.organisation.to_string()],
            )
            .await
            .expect("they are a member now")
            .get(0);
        assert_eq!(role, "member");
        // The invitation is closed `confirmed` with its grant.
        let row = read_row(&pool, &ring, &estate, &invited.invitation).await;
        assert_eq!(row.state, invitations::State::Confirmed);
        assert!(row.grant_id.is_some() && invitations::row_verifies(&ring, &row));
        // Each grant verifies on its own: the person is authorised by it, which
        // runs `verify_grant_row` over that one row, signature and key binding.
        let mut client = pool.get().await.unwrap();
        let (tx, ctx, tenant_key) =
            tenant_tx(&mut client, &ring, estate.organisation, person.account).await;
        let watch = EpochWatch::new();
        let auth = Authority {
            ring: &ring,
            ctx: &ctx,
            tenant_key: &tenant_key,
            watch: &watch,
        };
        let capabilities = grants::authorise_account(&tx, &auth, Some(scope), Capability::Read)
            .await
            .expect("the confirmed person can read at the scope");
        assert_eq!(capabilities.via_grant, row.grant_id.clone().unwrap());
        let denied = grants::authorise_account(&tx, &auth, Some(scope), Capability::Draw).await;
        assert!(matches!(denied, Err(AuthorityError::NotAuthorised)));
        tx.rollback().await.unwrap();
    }

    // The entries are written, with the batch's id and size, and the chains verify.
    assert_eq!(
        org_entries(&superuser, &estate, "invitation_closed").await,
        closed_before + 3
    );
    let _ = batch_id;
    the_chains_verify(&pool, &ring, &estate).await;

    // The list no longer shows them.
    let seen = parse(&waiting(addr, &estate, &estate.stewards[0]).await.1);
    assert!(array(&seen, "invitations").is_empty());
}

#[tokio::test]
async fn one_bad_signature_leaves_nothing_changed_and_the_head_where_it_was() {
    let _site = support::lock_the_site_chain().await;
    let pool = support::migrated_pool().await;
    let ring = ring();
    let estate = bootstrap(&pool, &ring, 1).await;
    let addr = serve(app(&pool, Arc::clone(&ring), Limits::STANDARD).await).await;
    let people = three_waiting(&pool, &ring, addr, &estate, None).await;
    let superuser = su().await;
    let head_before = head_epoch(&superuser, &estate).await;
    let ids: Vec<&str> = {
        let mut v: Vec<&str> = people.iter().map(|(i, _)| i.invitation.as_str()).collect();
        v.sort();
        v
    };
    let items: Vec<(&str, &str, Option<ScopeId>)> =
        ids.iter().map(|i| (*i, "read", None)).collect();
    let steward = &estate.stewards[0];
    let (status, proposal) = propose(addr, &estate, steward, &propose_body(&items, None)).await;
    assert_eq!(status, "200");
    let proposal = parse(&proposal);

    // The second item (index 1) carries a signature over something else.
    let body = confirm_body(
        array(&proposal, "items"),
        &estate,
        steward,
        &|index, sig| {
            if index == 1 {
                steward.key.sign(b"not the grant").to_vec()
            } else {
                sig
            }
        },
    );
    let (status, answer) = confirm(addr, &estate, steward, &body).await;
    assert_eq!(status, "422", "{}", String::from_utf8_lossy(&answer));
    let refusal = parse(&answer);
    assert_eq!(int(&refusal, "index"), 1);
    assert_eq!(text(&refusal, "reason"), "bad_signature");

    // Nothing moved: no grant, no membership, no state change, and the head.
    assert_eq!(head_epoch(&superuser, &estate).await, head_before);
    for (invited, _) in &people {
        assert_eq!(memberships_of(&superuser, &invited.account).await, 0);
        assert_eq!(grants_of(&superuser, &invited.account).await, 0);
        let row = read_row(&pool, &ring, &estate, &invited.invitation).await;
        assert_eq!(row.state, invitations::State::Joined);
    }
    // The organisation still authorises its steward afterwards: the rolled-back
    // epochs did not poison the rollback watch.
    the_chains_verify(&pool, &ring, &estate).await;
    let (status, _) = waiting(addr, &estate, steward).await;
    assert_eq!(status, "200");
    // And the honest batch still goes through.
    let body = confirm_body(array(&proposal, "items"), &estate, steward, &|_, s| s);
    let (status, answer) = confirm(addr, &estate, steward, &body).await;
    assert_eq!(status, "200", "{}", String::from_utf8_lossy(&answer));
}

#[tokio::test]
async fn a_malformed_batch_is_refused_before_any_work_and_changes_nothing() {
    let _site = support::lock_the_site_chain().await;
    let pool = support::migrated_pool().await;
    let ring = ring();
    let estate = bootstrap(&pool, &ring, 1).await;
    let addr = serve(app(&pool, Arc::clone(&ring), Limits::STANDARD).await).await;
    let people = three_waiting(&pool, &ring, addr, &estate, None).await;
    let superuser = su().await;
    let head_before = head_epoch(&superuser, &estate).await;
    let steward = &estate.stewards[0];
    let mut ids: Vec<&str> = people.iter().map(|(i, _)| i.invitation.as_str()).collect();
    ids.sort();

    // Propose: zero, 501, a duplicate, unsorted.
    let read = |id: &str| (id.to_string(), "read".to_string(), None::<ScopeId>);
    let build = |count: &str, items: Vec<(String, String, Option<ScopeId>)>| {
        let mut body = Vec::new();
        lp(&mut body, count.as_bytes());
        for (id, cap, scope) in items {
            lp(&mut body, id.as_bytes());
            lp(&mut body, cap.as_bytes());
            lp(
                &mut body,
                scope.map(|s| s.to_string()).unwrap_or_default().as_bytes(),
            );
        }
        body
    };
    let cases: Vec<(&str, Vec<u8>)> = vec![
        ("zero", build("0", vec![])),
        ("501", build("501", vec![read(ids[0])])),
        ("duplicate", build("2", vec![read(ids[0]), read(ids[0])])),
        ("unsorted", build("2", vec![read(ids[1]), read(ids[0])])),
        (
            "a steward among two",
            build(
                "2",
                vec![
                    read(ids[0]),
                    (ids[1].to_string(), "steward".to_string(), None),
                ],
            ),
        ),
    ];
    for (why, body) in cases {
        let (status, _) = propose(addr, &estate, steward, &body).await;
        assert_eq!(status, "400", "{why}");
    }

    // Confirm: a good proposal, then the same lines mangled three ways.
    let items: Vec<(&str, &str, Option<ScopeId>)> =
        ids.iter().map(|i| (*i, "read", None)).collect();
    let (_, proposal) = propose(addr, &estate, steward, &propose_body(&items, None)).await;
    let proposal = parse(&proposal);
    let lines = array(&proposal, "items").clone();
    let mangled: Vec<(&str, Vec<Json>)> = vec![
        ("duplicate", vec![lines[0].clone(), lines[0].clone()]),
        ("unsorted", vec![lines[1].clone(), lines[0].clone()]),
        // Epochs that are not consecutive: drop the middle line of three.
        ("epoch gap", vec![lines[0].clone(), lines[2].clone()]),
    ];
    for (why, items) in mangled {
        // Build a body by hand, so the client's own checks (which would refuse
        // these) do not stop the test sending them.
        let mut body = Vec::new();
        lp(&mut body, items.len().to_string().as_bytes());
        for item in &items {
            let signature = steward.key.sign(&from_hex(&text(item, "bytes")));
            lp(&mut body, text(item, "invitation").as_bytes());
            lp(&mut body, text(item, "capability").as_bytes());
            lp(&mut body, b"");
            lp(
                &mut body,
                int(item, "effective_from_unix").to_string().as_bytes(),
            );
            lp(&mut body, int(item, "auth_epoch").to_string().as_bytes());
            lp(&mut body, b"0");
            lp(&mut body, text(item, "granter_key_fpr").as_bytes());
            lp(&mut body, text(item, "subject_key_fpr").as_bytes());
            lp(&mut body, text(item, "root_pubkey_fpr").as_bytes());
            lp(&mut body, lowercase_hex(&signature).as_bytes());
        }
        let (status, _) = confirm(addr, &estate, steward, &body).await;
        assert_eq!(status, "400", "{why}");
    }
    assert_eq!(
        head_epoch(&superuser, &estate).await,
        head_before,
        "no work was done"
    );
}

#[tokio::test]
async fn an_unrelated_share_between_propose_and_confirm_fails_the_whole_batch_and_proposing_again_works(
) {
    let _site = support::lock_the_site_chain().await;
    let pool = support::migrated_pool().await;
    let ring = ring();
    let estate = bootstrap(&pool, &ring, 1).await;
    let addr = serve(app(&pool, Arc::clone(&ring), Limits::STANDARD).await).await;
    let people = three_waiting(&pool, &ring, addr, &estate, None).await;
    let steward = &estate.stewards[0];
    let superuser = su().await;
    let mut ids: Vec<&str> = people.iter().map(|(i, _)| i.invitation.as_str()).collect();
    ids.sort();
    let items: Vec<(&str, &str, Option<ScopeId>)> =
        ids.iter().map(|i| (*i, "read", None)).collect();

    let (_, proposal) = propose(addr, &estate, steward, &propose_body(&items, None)).await;
    let proposal = parse(&proposal);

    // Somebody else's grant lands first.
    let bystander = a_member(&pool, &ring, &estate, "bystander", None).await;
    sign_grant_as(&pool, &ring, &estate, 0, &bystander, None, Capability::Read).await;

    let body = confirm_body(array(&proposal, "items"), &estate, steward, &|_, s| s);
    let (status, answer) = confirm(addr, &estate, steward, &body).await;
    assert_eq!(status, "409", "{}", String::from_utf8_lossy(&answer));
    assert_eq!(text(&parse(&answer), "reason"), "stale");
    for (invited, _) in &people {
        assert_eq!(grants_of(&superuser, &invited.account).await, 0);
        assert_eq!(memberships_of(&superuser, &invited.account).await, 0);
    }

    // Proposing again succeeds.
    let (status, answer) = confirm_all(addr, &estate, steward, &ids, "read", None).await;
    assert_eq!(status, "200", "{}", String::from_utf8_lossy(&answer));
}

// ===========================================================================
// 10. Steward requests
// ===========================================================================

#[tokio::test]
async fn a_steward_request_is_confirmed_alone_and_needs_a_second_signature() {
    let _site = support::lock_the_site_chain().await;
    let pool = support::migrated_pool().await;
    let ring = ring();
    let estate = bootstrap(&pool, &ring, 2).await;
    let scope = a_scope(&pool, &estate, None, ScopeKind::Network).await;
    let addr = serve(app(&pool, Arc::clone(&ring), Limits::STANDARD).await).await;
    let steward = &estate.stewards[0];
    let second = &estate.stewards[1];
    let superuser = su().await;

    let a = invite(
        addr,
        &estate,
        steward,
        "Wants Steward",
        "steward",
        Some(scope),
    )
    .await;
    let b = invite(addr, &estate, steward, "Wants Read", "read", Some(scope)).await;
    let person = join(&pool, &ring, &a).await;
    let _ = join(&pool, &ring, &b).await;
    let mut both = [a.invitation.as_str(), b.invitation.as_str()];
    both.sort();

    // Refused inside a multi-item batch.
    let items: Vec<(&str, &str, Option<ScopeId>)> = both
        .iter()
        .map(|id| {
            (
                *id,
                if *id == a.invitation {
                    "steward"
                } else {
                    "read"
                },
                Some(scope),
            )
        })
        .collect();
    let (status, _) = propose(addr, &estate, steward, &propose_body(&items, None)).await;
    assert_eq!(status, "400", "a steward request never goes in a batch");

    // Alone, with its own expiry field.
    let (status, proposal) = propose(
        addr,
        &estate,
        steward,
        &propose_body(&[(&a.invitation, "steward", Some(scope))], Some("")),
    )
    .await;
    assert_eq!(status, "200", "{}", String::from_utf8_lossy(&proposal));
    let proposal = parse(&proposal);
    let line = array(&proposal, "items")[0].clone();
    let year = 365 * 24 * 3600;
    assert!(
        (int(&line, "expires_at_unix") - (now_unix() + year)).abs() < 60,
        "the default is a year, from the named constant"
    );
    assert!(
        !boolean(&line, "sole_steward_appointment"),
        "two stewards: quorum two"
    );
    let body = confirm_body(std::slice::from_ref(&line), &estate, steward, &|_, s| s);
    let (status, answer) = confirm(addr, &estate, steward, &body).await;
    assert_eq!(status, "200", "{}", String::from_utf8_lossy(&answer));
    let done = parse(&answer);
    let confirmed = array(&done, "confirmed")[0].clone();
    assert!(boolean(&confirmed, "needs_second"));
    let grant = text(&confirmed, "grant");

    // Until it is seconded the new steward is QuorumNotMet.
    {
        let mut client = pool.get().await.unwrap();
        let (tx, ctx, tenant_key) =
            tenant_tx(&mut client, &ring, estate.organisation, person.account).await;
        let watch = EpochWatch::new();
        let auth = Authority {
            ring: &ring,
            ctx: &ctx,
            tenant_key: &tenant_key,
            watch: &watch,
        };
        let refused = grants::authorise_account(&tx, &auth, Some(scope), Capability::Steward).await;
        assert!(
            matches!(refused, Err(AuthorityError::QuorumNotMet { .. })),
            "{refused:?}"
        );
        tx.rollback().await.unwrap();
    }

    // The Waiting list offers it to the other steward, and not to the granter.
    let theirs = parse(&waiting(addr, &estate, second).await.1);
    let offered = array(&theirs, "seconding");
    assert_eq!(offered.len(), 1, "{offered:?}");
    assert_eq!(text(&offered[0], "grant"), grant);
    assert_eq!(
        text(&offered[0], "key_code"),
        invitations::key_code(&authority::key_fingerprint(&person.key.public_key()))
    );
    let mine = parse(&waiting(addr, &estate, steward).await.1);
    assert!(
        array(&mine, "seconding").is_empty(),
        "the granter is not asked to second"
    );

    // The route's own guards: the granter, the subject and a non-steward are refused.
    let route = format!(
        "/organisations/{}/scopes/{}/grants/{grant}/second",
        estate.organisation, scope
    );
    let bystander = a_member(
        &pool,
        &ring,
        &estate,
        "bystander",
        Some((None, Capability::Draw)),
    )
    .await;
    for (who, why) in [
        (steward, "the granter"),
        (&person, "the subject"),
        (&bystander, "a non-steward"),
    ] {
        let (status, _) = call(addr, who, "GET", &route, b"").await;
        assert_eq!(status, "403", "{why} may not see the seconding view");
        let mut body = Vec::new();
        lp(
            &mut body,
            lowercase_hex(&who.key.sign(b"anything")).as_bytes(),
        );
        let (status, _) = call(addr, who, "POST", &route, &body).await;
        assert_eq!(status, "403", "{why} may not second");
    }

    // The other steward rebuilds what the granter signed, checks it, and seconds.
    let (status, view) = call(addr, second, "GET", &route, b"").await;
    assert_eq!(status, "200", "{}", String::from_utf8_lossy(&view));
    let view = parse(&view);
    assert_eq!(text(&view, "subject_name"), "Wants Steward");
    let rebuilt = client_bytes(&view, &estate, steward);
    assert_eq!(lowercase_hex(&rebuilt), text(&view, "grant_bytes"));
    let second_bytes = authority::second_bytes(
        &rebuilt,
        &from_hex(&text(&view, "granter_key_fpr"))
            .try_into()
            .unwrap(),
    );
    assert_eq!(lowercase_hex(&second_bytes), text(&view, "second_bytes"));
    let mut body = Vec::new();
    lp(
        &mut body,
        lowercase_hex(&second.key.sign(&second_bytes)).as_bytes(),
    );
    let (status, answer) = call(addr, second, "POST", &route, &body).await;
    assert_eq!(status, "200", "{}", String::from_utf8_lossy(&answer));
    // A second seconding by the same steward is refused, and the any-scope route
    // reaches the same guards.
    let (status, _) = call(addr, second, "POST", &route, &body).await;
    assert_eq!(status, "403");
    let any = format!(
        "/organisations/{}/grants/{grant}/second",
        estate.organisation
    );
    let (status, _) = call(addr, second, "GET", &any, b"").await;
    assert_eq!(status, "403", "already seconded by this steward");

    // Now the new steward holds steward at the scope.
    let mut client = pool.get().await.unwrap();
    let (tx, ctx, tenant_key) =
        tenant_tx(&mut client, &ring, estate.organisation, person.account).await;
    let watch = EpochWatch::new();
    let auth = Authority {
        ring: &ring,
        ctx: &ctx,
        tenant_key: &tenant_key,
        watch: &watch,
    };
    grants::authorise_account(&tx, &auth, Some(scope), Capability::Steward)
        .await
        .expect("seconded, and now usable");
    tx.rollback().await.unwrap();
    let _ = superuser;
}

#[tokio::test]
async fn a_sole_stewards_request_takes_effect_after_a_day_and_is_never_seconded() {
    let _site = support::lock_the_site_chain().await;
    let pool = support::migrated_pool().await;
    let ring = ring();
    let estate = bootstrap(&pool, &ring, 1).await;
    let addr = serve(app(&pool, Arc::clone(&ring), Limits::STANDARD).await).await;
    let steward = &estate.stewards[0];

    let a = invite(addr, &estate, steward, "Second Steward", "steward", None).await;
    let _person = join(&pool, &ring, &a).await;
    let (status, proposal) = propose(
        addr,
        &estate,
        steward,
        &propose_body(&[(&a.invitation, "steward", None)], Some("")),
    )
    .await;
    assert_eq!(status, "200", "{}", String::from_utf8_lossy(&proposal));
    let proposal = parse(&proposal);
    let line = array(&proposal, "items")[0].clone();
    assert!(boolean(&line, "sole_steward_appointment"));
    assert!(
        (int(&line, "effective_from_unix") - (now_unix() + 24 * 3600)).abs() < 60,
        "takes effect in 24 hours"
    );
    let body = confirm_body(std::slice::from_ref(&line), &estate, steward, &|_, s| s);
    let (status, answer) = confirm(addr, &estate, steward, &body).await;
    assert_eq!(status, "200", "{}", String::from_utf8_lossy(&answer));
    let confirmed = array(&parse(&answer), "confirmed")[0].clone();
    assert!(
        !boolean(&confirmed, "needs_second"),
        "the sole path never seconds"
    );
    // Nobody is offered it to second.
    let theirs = parse(&waiting(addr, &estate, steward).await.1);
    assert!(array(&theirs, "seconding").is_empty());
}

// ===========================================================================
// 11. Key substitution
// ===========================================================================

#[tokio::test]
async fn a_second_key_after_joining_makes_confirm_refuse_and_a_swapped_fingerprint_is_refused() {
    let _site = support::lock_the_site_chain().await;
    let pool = support::migrated_pool().await;
    let ring = ring();
    let estate = bootstrap(&pool, &ring, 1).await;
    let addr = serve(app(&pool, Arc::clone(&ring), Limits::STANDARD).await).await;
    let steward = &estate.stewards[0];
    let superuser = su().await;

    let a = invite(addr, &estate, steward, "Substituted", "read", None).await;
    let _person = join(&pool, &ring, &a).await;
    let (status, proposal) = propose(
        addr,
        &estate,
        steward,
        &propose_body(&[(&a.invitation, "read", None)], None),
    )
    .await;
    assert_eq!(status, "200");
    let proposal = parse(&proposal);
    let line = array(&proposal, "items")[0].clone();

    // A proposal whose subject key is not the invitation's is refused: swap the
    // fingerprint in the confirm body (and sign what the swapped bytes would be).
    let mut swapped = line.clone();
    if let Json::Obj(map) = &mut swapped {
        map.insert(
            "subject_key_fpr".to_string(),
            Json::Str(lowercase_hex(&[0xabu8; 32])),
        );
    }
    let mut body = Vec::new();
    lp(&mut body, b"1");
    let bytes = client_bytes(&swapped, &estate, steward);
    lp(&mut body, a.invitation.as_bytes());
    lp(&mut body, b"read");
    lp(&mut body, b"");
    lp(
        &mut body,
        int(&line, "effective_from_unix").to_string().as_bytes(),
    );
    lp(&mut body, int(&line, "auth_epoch").to_string().as_bytes());
    lp(&mut body, b"0");
    lp(&mut body, text(&line, "granter_key_fpr").as_bytes());
    lp(&mut body, text(&swapped, "subject_key_fpr").as_bytes());
    lp(&mut body, text(&line, "root_pubkey_fpr").as_bytes());
    lp(
        &mut body,
        lowercase_hex(&steward.key.sign(&bytes)).as_bytes(),
    );
    let (status, answer) = confirm(addr, &estate, steward, &body).await;
    assert_eq!(status, "409", "{}", String::from_utf8_lossy(&answer));
    assert_eq!(text(&parse(&answer), "reason"), "key_changed");

    // A second key lands on the account after it joined (a person adding another
    // browser, or an operator's token): the honest proposal is then refused.
    {
        let mut client = pool.get().await.unwrap();
        let tx = client.transaction().await.unwrap();
        tx.execute(
            "SELECT set_config('app.account_id', $1, true)",
            &[&a.account],
        )
        .await
        .unwrap();
        let deployment = chains::deployment_id(&*tx).await.unwrap();
        grants::enrol_software_key_at_invitation(
            &tx,
            &ring,
            &deployment,
            &a.account,
            &SoftwareKey::random().unwrap().public_key(),
        )
        .await
        .expect("a second key");
        tx.commit().await.unwrap();
    }
    let body = confirm_body(&[line], &estate, steward, &|_, s| s);
    let (status, answer) = confirm(addr, &estate, steward, &body).await;
    assert_eq!(status, "409", "{}", String::from_utf8_lossy(&answer));
    assert_eq!(text(&parse(&answer), "reason"), "key_changed");
    assert_eq!(
        memberships_of(&superuser, &a.account).await,
        0,
        "nothing was written"
    );
    assert_eq!(grants_of(&superuser, &a.account).await, 0);
}

// ===========================================================================
// 12. Refuse and cancel, 13. another organisation, 14. the joined window
// ===========================================================================

#[tokio::test]
async fn refuse_and_cancel_create_no_membership_and_a_later_confirm_is_refused() {
    let _site = support::lock_the_site_chain().await;
    let pool = support::migrated_pool().await;
    let ring = ring();
    let estate = bootstrap(&pool, &ring, 1).await;
    let drawer = a_member(
        &pool,
        &ring,
        &estate,
        "drawer",
        Some((None, Capability::Draw)),
    )
    .await;
    let addr = serve(app(&pool, Arc::clone(&ring), Limits::STANDARD).await).await;
    let steward = &estate.stewards[0];
    let superuser = su().await;
    let path = invitations_path(&estate);

    let refused = invite(addr, &estate, steward, "To Refuse", "read", None).await;
    let cancelled = invite(addr, &estate, steward, "To Cancel", "read", None).await;
    let _ = join(&pool, &ring, &refused).await;
    let _ = join(&pool, &ring, &cancelled).await;

    // A non-steward is refused both.
    for (id, verb) in [
        (&refused.invitation, "refuse"),
        (&cancelled.invitation, "cancel"),
    ] {
        let (status, _) = call(addr, &drawer, "POST", &format!("{path}/{id}/{verb}"), b"").await;
        assert_eq!(status, "403", "{verb}");
    }
    let (status, answer) = call(
        addr,
        steward,
        "POST",
        &format!("{path}/{}/refuse", refused.invitation),
        b"",
    )
    .await;
    assert_eq!(status, "200", "{}", String::from_utf8_lossy(&answer));
    assert_eq!(text(&parse(&answer), "state"), "refused");
    let (status, _) = call(
        addr,
        steward,
        "POST",
        &format!("{path}/{}/cancel", cancelled.invitation),
        b"",
    )
    .await;
    assert_eq!(status, "200");
    // Closing twice is a conflict, not a second record.
    let (status, _) = call(
        addr,
        steward,
        "POST",
        &format!("{path}/{}/cancel", cancelled.invitation),
        b"",
    )
    .await;
    assert_eq!(status, "409");

    for invited in [&refused, &cancelled] {
        assert_eq!(memberships_of(&superuser, &invited.account).await, 0);
        assert_eq!(grants_of(&superuser, &invited.account).await, 0);
    }
    // A later confirm is refused: they are no longer waiting.
    let (status, answer) = propose(
        addr,
        &estate,
        steward,
        &propose_body(&[(&refused.invitation, "read", None)], None),
    )
    .await;
    assert_eq!(status, "409", "{}", String::from_utf8_lossy(&answer));
    assert_eq!(text(&parse(&answer), "reason"), "not_waiting");
    // A person who has not joined can be cancelled but not refused.
    let unjoined = invite(addr, &estate, steward, "Never Joined", "read", None).await;
    let (status, _) = call(
        addr,
        steward,
        "POST",
        &format!("{path}/{}/refuse", unjoined.invitation),
        b"",
    )
    .await;
    assert_eq!(status, "409");
    let _ = (org_entries(&superuser, &estate, "invitation_closed").await,);
    the_chains_verify(&pool, &ring, &estate).await;
}

#[tokio::test]
async fn another_organisations_invitation_gets_the_same_refusal_as_one_that_never_existed() {
    let _site = support::lock_the_site_chain().await;
    let pool = support::migrated_pool().await;
    let ring = ring();
    let estate = bootstrap(&pool, &ring, 1).await;
    let elsewhere = bootstrap(&pool, &ring, 1).await;
    let addr = serve(app(&pool, Arc::clone(&ring), Limits::STANDARD).await).await;
    let theirs = invite(
        addr,
        &elsewhere,
        &elsewhere.stewards[0],
        "Over There",
        "read",
        None,
    )
    .await;
    let _ = join(&pool, &ring, &theirs).await;
    let never = fathom_server::ids::new_ulid().to_string();
    let steward = &estate.stewards[0];
    let path = invitations_path(&estate);

    for verb in ["cancel", "refuse"] {
        let (a_status, a_body) = call(
            addr,
            steward,
            "POST",
            &format!("{path}/{}/{verb}", theirs.invitation),
            b"",
        )
        .await;
        let (b_status, b_body) = call(
            addr,
            steward,
            "POST",
            &format!("{path}/{never}/{verb}"),
            b"",
        )
        .await;
        assert_eq!((a_status.as_str(), &a_body), ("404", &b_body), "{verb}");
        assert_eq!(a_status, b_status);
    }
    // Confirm: the same refusal for both.
    let mut ids = [theirs.invitation.as_str(), never.as_str()];
    ids.sort();
    for id in ids {
        let (status, answer) = propose(
            addr,
            &estate,
            steward,
            &propose_body(&[(id, "read", None)], None),
        )
        .await;
        assert_eq!(status, "409", "{}", String::from_utf8_lossy(&answer));
        assert_eq!(text(&parse(&answer), "reason"), "not_waiting");
    }
    // And the other organisation's steward cannot see it in their own list.
    let seen = parse(&waiting(addr, &estate, steward).await.1);
    assert!(array(&seen, "invitations").is_empty());
    let own = parse(&waiting(addr, &elsewhere, &elsewhere.stewards[0]).await.1);
    assert_eq!(array(&own, "invitations").len(), 1);
}

#[tokio::test]
async fn a_backdated_joined_window_makes_the_invitation_unconfirmable() {
    let _site = support::lock_the_site_chain().await;
    let pool = support::migrated_pool().await;
    let ring = ring();
    let estate = bootstrap(&pool, &ring, 1).await;
    let addr = serve(app(&pool, Arc::clone(&ring), Limits::STANDARD).await).await;
    let steward = &estate.stewards[0];
    let a = invite(addr, &estate, steward, "Too Late", "read", None).await;
    let _ = join(&pool, &ring, &a).await;

    // joined_at moved back past the window, and the row re-sealed so it is the
    // window that refuses and not the seal.
    let mut row = read_row(&pool, &ring, &estate, &a.invitation).await;
    row.joined_at_unix -= invitations::JOINED_WINDOW_SECONDS + 60;
    let seal = invitations::invitation_seal(&ring, &row);
    let superuser = su().await;
    support::tamper(
        &superuser,
        "organisation_invitations",
        "UPDATE organisation_invitations \
            SET joined_at = to_timestamp($2::bigint), row_seal = $3 WHERE id = $1",
        &[&a.invitation, &row.joined_at_unix, &seal.to_vec()],
    )
    .await;

    let seen = parse(&waiting(addr, &estate, steward).await.1);
    let item = array(&seen, "invitations")
        .iter()
        .find(|i| text(i, "id") == a.invitation)
        .unwrap();
    assert!(boolean(item, "expired"));
    assert!(!boolean(item, "can_confirm"));
    assert_eq!(int(&seen, "waiting_count"), 0);
    let (status, answer) = propose(
        addr,
        &estate,
        steward,
        &propose_body(&[(&a.invitation, "read", None)], None),
    )
    .await;
    assert_eq!(status, "409", "{}", String::from_utf8_lossy(&answer));
    assert_eq!(text(&parse(&answer), "reason"), "window_closed");
}

// ===========================================================================
// 16. People, and removing a steward
// ===========================================================================

#[tokio::test]
async fn people_lists_everyone_with_their_access_and_removing_a_steward_waits_a_day() {
    let _site = support::lock_the_site_chain().await;
    let pool = support::migrated_pool().await;
    let ring = ring();
    let estate = bootstrap(&pool, &ring, 2).await;
    let scope = a_scope(&pool, &estate, None, ScopeKind::Network).await;
    let addr = serve(app(&pool, Arc::clone(&ring), Limits::STANDARD).await).await;
    let steward = &estate.stewards[0];
    let reader = a_member(
        &pool,
        &ring,
        &estate,
        "reader",
        Some((Some(scope), Capability::Read)),
    )
    .await;
    let folder_steward = a_folder_steward(&pool, &ring, &estate, scope, "folder-steward").await;
    let invited = invite(addr, &estate, steward, "Not Yet", "draw", Some(scope)).await;
    let waiting_person = invite(addr, &estate, steward, "Waiting Wendy", "read", Some(scope)).await;
    let _ = join(&pool, &ring, &waiting_person).await;
    let people_path = format!("/organisations/{}/people", estate.organisation);

    let (status, answer) = call(addr, steward, "GET", &people_path, b"").await;
    assert_eq!(status, "200", "{}", String::from_utf8_lossy(&answer));
    let listing = parse(&answer);
    let people = array(&listing, "people");
    let find = |account: &str| {
        people
            .iter()
            .find(|p| text(p, "account") == account)
            .cloned()
    };
    let me = find(&steward.account.to_string()).expect("the caller is listed");
    assert!(boolean(&me, "you"));
    assert_eq!(text(&me, "state"), "active");
    let reader_row = find(&reader.account.to_string()).unwrap();
    assert!(!boolean(&reader_row, "you"));
    let access = array(&reader_row, "access");
    assert_eq!(access.len(), 1);
    assert_eq!(text(&access[0], "scope_id"), scope.to_string());
    assert!(!text(&access[0], "label").is_empty());
    assert_eq!(text(&access[0], "capability"), "read");
    assert!(!boolean(&access[0], "inherited"));
    assert!(boolean(&access[0], "revocable"));
    let invited_row = find(&invited.account).unwrap();
    assert_eq!(text(&invited_row, "state"), "invited");
    assert_eq!(text(&invited_row, "email"), "typed@example.org");
    assert_eq!(text(field(&invited_row, "asked"), "capability"), "draw");
    let waiting_row = find(&waiting_person.account).unwrap();
    assert_eq!(text(&waiting_row, "state"), "waiting");
    assert_eq!(int(&listing, "waiting_count"), 1);

    // The folder steward's grant shows as a steward grant with its delay in words
    // of seconds, and the reader's inherited rows are not revocable from above.
    let folder_row = find(&folder_steward.account.to_string()).unwrap();
    let steward_line = array(&folder_row, "access")
        .iter()
        .find(|l| boolean(l, "steward"))
        .expect("a steward line")
        .clone();
    assert_eq!(
        int(&steward_line, "revoke_takes_effect_in_seconds"),
        24 * 3600
    );
    assert!(boolean(&steward_line, "revocable"));
    assert!(
        !boolean(&steward_line, "awaiting_second"),
        "it was seconded"
    );
    // Genesis lines are visible and never revocable.
    let genesis_line = array(&me, "access")
        .iter()
        .find(|l| boolean(l, "genesis"))
        .expect("the genesis grant is listed")
        .clone();
    assert!(!boolean(&genesis_line, "revocable"));

    // A folder steward sees the whole organisation's people but only their own
    // folder's access rows; the genesis steward's organisation-wide grant shows
    // as inherited at their folder.
    let (status, answer) = call(addr, &folder_steward, "GET", &people_path, b"").await;
    assert_eq!(status, "200");
    let theirs = parse(&answer);
    let genesis_row = array(&theirs, "people")
        .iter()
        .find(|p| text(p, "account") == steward.account.to_string())
        .unwrap()
        .clone();
    let inherited = array(&genesis_row, "access");
    assert!(
        inherited
            .iter()
            .all(|l| boolean(l, "inherited") && !boolean(l, "revocable")),
        "{inherited:?}"
    );

    // Revoking the folder steward's steward grant: the answer says when it bites.
    let grant = text(&steward_line, "grant");
    let route = format!(
        "/organisations/{}/scopes/{}/grants/{grant}/revoke",
        estate.organisation, scope
    );
    let (status, prep) = call(addr, steward, "GET", &route, b"").await;
    assert_eq!(status, "200", "{}", String::from_utf8_lossy(&prep));
    let prep = parse(&prep);
    assert!(boolean(&prep, "steward"));
    assert!(int(&prep, "takes_effect_at_unix") >= int(&prep, "at") + 24 * 3600 - 1);
    let mut body = Vec::new();
    lp(&mut body, int(&prep, "at").to_string().as_bytes());
    lp(
        &mut body,
        lowercase_hex(&steward.key.sign(&from_hex(&text(&prep, "bytes")))).as_bytes(),
    );
    let (status, answer) = call(addr, steward, "POST", &route, &body).await;
    assert_eq!(status, "200", "{}", String::from_utf8_lossy(&answer));
    let answer = parse(&answer);
    assert!(
        boolean(&answer, "delayed"),
        "removing another steward waits"
    );
    assert!(int(&answer, "takes_effect_at_unix") > now_unix() + 23 * 3600);
    // ... and until then they still are one, and the listing says it is going.
    let mut client = pool.get().await.unwrap();
    let (tx, ctx, tenant_key) = tenant_tx(
        &mut client,
        &ring,
        estate.organisation,
        folder_steward.account,
    )
    .await;
    let watch = EpochWatch::new();
    let auth = Authority {
        ring: &ring,
        ctx: &ctx,
        tenant_key: &tenant_key,
        watch: &watch,
    };
    grants::authorise_account(&tx, &auth, Some(scope), Capability::Steward)
        .await
        .expect("still a steward for a day");
    tx.rollback().await.unwrap();
    let (_, answer) = call(addr, steward, "GET", &people_path, b"").await;
    let after = parse(&answer);
    let row = array(&after, "people")
        .iter()
        .find(|p| text(p, "account") == folder_steward.account.to_string())
        .unwrap()
        .clone();
    let line = array(&row, "access")
        .iter()
        .find(|l| text(l, "grant") == grant)
        .unwrap();
    assert!(int(line, "revoking_at_unix") > now_unix() + 23 * 3600);

    // A genesis grant is never revoked from here.
    let genesis_grant = text(&genesis_line, "grant");
    let (status, _) = call(
        addr,
        steward,
        "GET",
        &format!(
            "/organisations/{}/scopes/{}/grants/{genesis_grant}/revoke",
            estate.organisation, scope
        ),
        b"",
    )
    .await;
    assert_eq!(status, "403");
    // A read grant still revokes at once.
    let read_grant = text(&access[0], "grant");
    let (_, prep) = call(
        addr,
        steward,
        "GET",
        &format!(
            "/organisations/{}/scopes/{}/grants/{read_grant}/revoke",
            estate.organisation, scope
        ),
        b"",
    )
    .await;
    let prep = parse(&prep);
    assert!(!boolean(&prep, "steward"));
    assert_eq!(int(&prep, "takes_effect_at_unix"), int(&prep, "at"));
}

/// Act as the shipper until the spool is empty, to a receiver that keeps nothing.
/// The caller holds the spool lock, so nobody else is waiting on these lines.
async fn ship_the_backlog(client: &tokio_postgres::Client) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let target =
        fathom_server::audit::SyslogTarget::parse(&listener.local_addr().unwrap().to_string())
            .expect("a bound address is host:port");
    let receiver = tokio::spawn(async move {
        loop {
            let Ok((mut socket, _)) = listener.accept().await else {
                return;
            };
            tokio::spawn(async move {
                use tokio::io::AsyncReadExt;
                let mut sink = Vec::new();
                let _ = socket.read_to_end(&mut sink).await;
            });
        }
    });
    for _ in 0..2000 {
        let drained = fathom_server::audit::drain_once(client, &target)
            .await
            .unwrap();
        if drained.remaining == 0 || drained.shipped == 0 {
            break;
        }
    }
    receiver.abort();
}

// ===========================================================================
// 15. Timing: five hundred in one batch
// ===========================================================================

#[tokio::test]
async fn five_hundred_people_confirm_in_one_batch_inside_the_drift_budget() {
    let _site = support::lock_the_site_chain().await;
    // This test queues thousands of audit lines. Holding the shipper's lock keeps
    // the spool tests in `audit_chains` from running over that backlog, and the
    // drain at the end hands it on through the shipper's own path.
    let spool = support::lock_the_spool().await;
    let pool = support::migrated_pool().await;
    let ring = ring();
    let estate = bootstrap(&pool, &ring, 1).await;
    let scope = a_scope(&pool, &estate, None, ScopeKind::Network).await;

    // Some history first: existing members with grants make the authority state
    // the batch has to re-read for every item a realistic size.
    for n in 0..100 {
        a_member(
            &pool,
            &ring,
            &estate,
            &format!("existing-{n}"),
            Some((Some(scope), Capability::Read)),
        )
        .await;
    }

    // Five hundred invited and joined.
    let started = std::time::Instant::now();
    let mut waiting_ids = Vec::new();
    for n in 0..500 {
        let (issued, token) = issued_directly(
            &pool,
            &ring,
            &estate,
            &format!("Batch {n}"),
            Capability::Read,
            Some(scope),
        )
        .await;
        operators(&pool, &ring)
            .await
            .redeem_account_enrolment(
                &token,
                &issued.sign_in_name,
                &SoftwareKey::random().unwrap().public_key(),
            )
            .await
            .expect("joined");
        waiting_ids.push(issued.invitation);
    }
    eprintln!("seeded 500 joined invitations in {:?}", started.elapsed());
    waiting_ids.sort();

    // Propose, sign every grant as the client would, confirm: in the library, so
    // the time is the server's and not five hundred HTTP sign-ins.
    let steward = &estate.stewards[0];
    let items: Vec<invitations::ProposeItem> = waiting_ids
        .iter()
        .map(|id| invitations::ProposeItem {
            invitation: id.clone(),
            capability: Capability::Read,
            scope: Some(scope),
            expires_at_unix: None,
        })
        .collect();
    let mut client = pool.get().await.unwrap();
    let (tx, ctx, tenant_key) =
        tenant_tx(&mut client, &ring, estate.organisation, steward.account).await;
    let watch = EpochWatch::new();
    let auth = Authority {
        ring: &ring,
        ctx: &ctx,
        tenant_key: &tenant_key,
        watch: &watch,
    };
    let propose_started = std::time::Instant::now();
    let proposed = invitations::propose(&tx, &ring, &auth, &items, now_unix())
        .await
        .expect("proposed");
    let propose_took = propose_started.elapsed();
    tx.rollback().await.unwrap();
    assert_eq!(proposed.len(), 500);

    let confirm_items: Vec<invitations::ConfirmItem> = proposed
        .iter()
        .map(|p| invitations::ConfirmItem {
            invitation: p.invitation.id.clone(),
            capability: Capability::Read,
            scope: Some(scope),
            effective_from_unix: p.proposal.effective_from_unix,
            auth_epoch: p.proposal.auth_epoch,
            expires_at_unix: 0,
            granter_key_fpr: p.proposal.granter_key_fpr,
            subject_key_fpr: p.proposal.subject_key_fpr,
            root_pubkey_fpr: p.proposal.root_pubkey_fpr,
            signature: steward.key.sign(&p.proposal.bytes).to_vec(),
        })
        .collect();
    let (tx, ctx, tenant_key) =
        tenant_tx(&mut client, &ring, estate.organisation, steward.account).await;
    let auth = Authority {
        ring: &ring,
        ctx: &ctx,
        tenant_key: &tenant_key,
        watch: &watch,
    };
    let confirm_started = std::time::Instant::now();
    let (_batch, confirmed) = invitations::confirm(&tx, &ring, &auth, &confirm_items, now_unix())
        .await
        .expect("five hundred confirmed");
    let confirm_took = confirm_started.elapsed();
    tx.commit().await.expect("commit");
    eprintln!("500-item batch: propose {propose_took:?}, confirm {confirm_took:?}");
    assert_eq!(confirmed.len(), 500);
    assert!(
        confirm_took.as_secs() < grants::PROPOSAL_SKEW_SECONDS as u64,
        "the batch must finish inside the drift budget ({} s): took {confirm_took:?}",
        grants::PROPOSAL_SKEW_SECONDS
    );
    let superuser = su().await;
    let confirmed_count: i64 = superuser
        .query_one(
            "SELECT count(*) FROM organisation_invitations WHERE organisation_id = $1 AND state = 'confirmed'",
            &[&estate.organisation.to_string()],
        )
        .await
        .unwrap()
        .get(0);
    assert_eq!(confirmed_count, 500);
    the_chains_verify(&pool, &ring, &estate).await;

    ship_the_backlog(&spool).await;
}
