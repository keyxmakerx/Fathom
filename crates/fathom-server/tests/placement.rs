//! **Console placement, end to end, against a real PostgreSQL** — ADR-0055
//! decisions 9 and 11, migration `0020_console_placement.sql`.
//!
//! Every test here is written against a claim and its name is the claim
//! (CLAUDE.md rule 2). The claims, in the order decision 11 makes them:
//!
//! 1. a placement applies AT ONCE and is sealed in the same transaction;
//! 2. the gate follows it immediately, on this process, with no restart;
//! 3. the first verified `/admin` request on a matching `Host` inside the
//!    window confirms it — there is no confirmation route, because the
//!    browser that followed the console there IS the confirmation;
//! 4. an unconfirmed window reverts to the last confirmed placement, sealed;
//! 5. `console-placement --reset` clears it from the host, sealed;
//! 6. the `smtp` setting's value envelope is checked before it is sealed, and
//!    a test send answers 503 because no mail client ships in this phase.
//!
//! The requests are made with everything a real console has: a live operator
//! session, a genuine ES256 signature by the operator's enrolled key over
//! `placement::placement_request_bytes`, and the real router with the real
//! `admin_exposure` gate and the real confirmation layer over it.

mod support;

use std::sync::Arc;
use std::time::Duration;

use deadpool_postgres::Pool;
use fathom_server::admin::{self, AdminState};
use fathom_server::admin_exposure::AdminExposure;
use fathom_server::api::{
    HEADER_COUNTER, HEADER_NONCE, HEADER_SESSION, HEADER_SIGNATURE, HEADER_TIMESTAMP,
};
use fathom_server::authority::SoftwareKey;
use fathom_server::chains;
use fathom_server::client_address::ClientAddress;
use fathom_server::credentials::{self, CredentialStore};
use fathom_server::crypto::Key32;
use fathom_server::grants;
use fathom_server::keys::KeyRing;
use fathom_server::operators::{OperatorError, OperatorStore};
use fathom_server::placement::{self, PlacementState, PlacementStore, TlsMode};
use fathom_server::sessions::{
    self, PrincipalKind, SessionStore, SignInLimits, SignedIn, VerifiedSession,
};

/// The same master key every other suite in this crate uses: ADR-0043 §4
/// stamps the configured key's id per database and refuses a second.
const MASTER: [u8; 32] = [21; 32];

/// This binary's own deployment. §6.3's first operator is minted once per
/// deployment, and the shared test database already has one — the same
/// argument `tests/operators.rs` makes for its own.
const TAG: &str = "place_console";

/// One test at a time inside this binary: several of these count site-chain
/// entries of a type across the whole chain, and the deployment is this
/// binary's alone.
static SERIAL: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

static DEPLOYMENT: tokio::sync::OnceCell<Pool> = tokio::sync::OnceCell::const_new();

/// The first operator's private key, fixed for this binary — a test fixture,
/// in a database `cargo test` owns, and nowhere else.
const FIRST_OPERATOR_SECRET: [u8; 32] = [9; 32];

static FIRST_OPERATOR: tokio::sync::OnceCell<String> = tokio::sync::OnceCell::const_new();

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

fn ring() -> Arc<KeyRing> {
    Arc::new(KeyRing::from_keys(
        Key32::from_bytes(MASTER),
        Key32::from_bytes(support::SITE_CHAIN_MASTER),
    ))
}

async fn deployment_id(pool: &Pool) -> String {
    let client = pool.get().await.expect("connection");
    chains::deployment_id(&**client)
        .await
        .expect("this deployment is stamped at startup")
}

async fn sessions_store(pool: &Pool, ring: Arc<KeyRing>) -> SessionStore {
    SessionStore::new(
        pool.clone(),
        ring,
        deployment_id(pool).await,
        SignInLimits::defaults(),
    )
}

async fn operators_store(pool: &Pool, ring: Arc<KeyRing>) -> OperatorStore {
    OperatorStore::with_delay(
        pool.clone(),
        ring,
        deployment_id(pool).await,
        Duration::from_secs(1),
    )
}

async fn placement_store(pool: &Pool, ring: Arc<KeyRing>) -> Arc<PlacementStore> {
    let store = Arc::new(PlacementStore::new(
        pool.clone(),
        ring,
        deployment_id(pool).await,
    ));
    store.refresh().await.expect("read the live placement");
    store
}

struct Operator {
    id: String,
    key: SoftwareKey,
    signed_in: SignedIn,
    session_key: SoftwareKey,
    session: VerifiedSession,
}

/// §6.3's first start: no operator, a bootstrap, a browser keypair redeeming
/// the token, and a sign-in.
async fn an_operator(operators: &OperatorStore, sessions: &SessionStore) -> Operator {
    let key = SoftwareKey::from_bytes(&FIRST_OPERATOR_SECRET).expect("a fixed test key");
    let id = FIRST_OPERATOR
        .get_or_init(|| async {
            match operators
                .bootstrap_first_operator("Installer", "operator@example.test")
                .await
            {
                Ok(bootstrap) => {
                    // ADR-0055 decision 1's path, as `tests/operators.rs` walks
                    // it: the bootstrap wrote an account for the notice
                    // address and bound the custody to it; the browser's key
                    // is registered on the account and then, from an account
                    // session, as the operator key every act is signed with.
                    an_account_browser_key(operators, &bootstrap.account_id, &key).await;
                    // ADR-0055 decision 10 and fix (g): an account holding the
                    // operator custody confirms its app code before it may
                    // register the operator key every act is signed with.
                    a_confirmed_app_code(operators, sessions, &bootstrap.account_id, &key).await;
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
                Err(OperatorError::AlreadyBootstrapped) => operator_holding(&key).await,
                Err(e) => panic!("bootstrap: {e}"),
            }
        })
        .await
        .clone();

    let session_key = SoftwareKey::random().expect("a session keypair");
    let pubkey = session_key.public_key();
    let source = a_source_of_its_own();
    let challenge = sessions
        .issue_challenge(PrincipalKind::Operator, &id, &pubkey, &source)
        .await
        .expect("a challenge");
    let digest = sessions::session_challenge(&pubkey, &challenge.nonce, &challenge.deployment_id);
    let evidence = key.sign(&digest);
    let signed_in = sessions
        .sign_in(
            PrincipalKind::Operator,
            &pubkey,
            &challenge.nonce,
            &evidence,
            &source,
        )
        .await
        .expect("an operator with an enrolled key signs in");
    let session = verify(sessions, &signed_in, &session_key, "POST", "/admin/x", b"").await;
    Operator {
        id,
        key,
        signed_in,
        session_key,
        session,
    }
}

/// The browser's key on the account itself, the act `POST /credentials/key`
/// performs, stood in for by the function it calls.
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

/// Enrol and confirm the app code, with a code a real authenticator would be
/// showing: `credentials::totp_code` over the secret the server sealed and the
/// live 30-second step. Six digits, RFC 6238, not a fixture string.
async fn a_confirmed_app_code(
    operators: &OperatorStore,
    sessions_store: &SessionStore,
    account: &str,
    key: &SoftwareKey,
) {
    let creds = CredentialStore::new(
        operators.pool().clone(),
        ring(),
        operators.deployment().to_string(),
    );
    let session = an_account_session(sessions_store, account, key, "/credentials/totp/enrol").await;
    creds
        .enrol_totp(&session)
        .await
        .expect("an account with the operator custody enrols an app code");

    let secret = {
        let mut client = operators.pool().get().await.expect("connection");
        let tx = client.transaction().await.expect("begin");
        tx.execute("SELECT set_config('app.session_custody', 'yes', true)", &[])
            .await
            .expect("session custody");
        let row = credentials::read_credentials(&tx, account)
            .await
            .expect("read")
            .expect("the account exists");
        let totp_key = credentials::totp_key_for(&tx, &ring())
            .await
            .expect("the credential key");
        let secret = row
            .totp_secret(&totp_key, operators.deployment(), account)
            .expect("open the secret")
            .expect("a secret is enrolled");
        tx.rollback().await.expect("rollback");
        secret
    };

    let session =
        an_account_session(sessions_store, account, key, "/credentials/totp/confirm").await;
    creds
        .confirm_totp(
            &session,
            &credentials::totp_code(&secret, credentials::totp_step(now_seconds())),
        )
        .await
        .expect("a real six-digit code confirms it");
}

fn now_seconds() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64
}

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

/// An `A1` account session for `path`, by the existing key sign-in.
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

async fn operator_holding(key: &SoftwareKey) -> String {
    let fpr = fathom_server::authority::key_fingerprint(&key.public_key()).to_vec();
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
            "this database was bootstrapped by an operator whose key this fixture does not hold. \
             Drop it and run again: the first operator is minted once per deployment.",
        )
}

fn a_source_of_its_own() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT: AtomicU64 = AtomicU64::new(0);
    format!(
        "198.51.100.7-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    )
}

async fn verify(
    store: &SessionStore,
    signed_in: &SignedIn,
    session_key: &SoftwareKey,
    method: &str,
    path: &str,
    body: &[u8],
) -> VerifiedSession {
    let nonce = store
        .issue_request_nonce(&signed_in.session_id, &signed_in.token)
        .await
        .expect("a nonce");
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
        .expect("a live session verifies its own signed request")
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

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64
}

fn now_unix() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn lp(out: &mut Vec<u8>, field: &[u8]) {
    out.extend_from_slice(&(field.len() as u32).to_le_bytes());
    out.extend_from_slice(field);
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

/// The console as `main.rs` assembles it: the admin router, the placement
/// router beside it, the confirmation layer over both, and the exposure gate
/// outermost — plus the unauthenticated flag, which is outside all of it.
async fn serve(
    pool: &Pool,
    ring: Arc<KeyRing>,
    placement: Arc<PlacementStore>,
) -> (std::net::SocketAddr, SessionStore) {
    let sessions = Arc::new(sessions_store(pool, Arc::clone(&ring)).await);
    let admin_state = AdminState {
        sessions: Arc::clone(&sessions),
        operators: Arc::new(operators_store(pool, Arc::clone(&ring)).await),
        ring: Arc::clone(&ring),
        client_address: ClientAddress::peer(),
    };
    let exposure =
        AdminExposure::new([], [], ClientAddress::peer()).with_placement(placement.view());
    let app = admin::router(admin_state)
        .merge(placement::router(PlacementState {
            sessions: Arc::clone(&sessions),
            placement: Arc::clone(&placement),
        }))
        .layer(axum::middleware::from_fn_with_state(
            Arc::clone(&placement),
            placement::confirm_on_the_new_host,
        ))
        .layer(axum::middleware::from_fn_with_state(
            exposure.clone(),
            fathom_server::admin_exposure::gate,
        ))
        .merge(placement::flag_router(exposure));

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind an ephemeral loopback port");
    let addr = listener.local_addr().expect("local addr");
    tokio::spawn(async move {
        let _ = axum::serve(
            listener,
            app.into_make_service_with_connect_info::<std::net::SocketAddr>(),
        )
        .await;
    });
    (addr, sessions_store(pool, ring).await)
}

/// Sign a request the way a browser would and send it over a real socket, to
/// a `Host` this test chooses — which is the whole subject of this file.
async fn signed_request(
    addr: std::net::SocketAddr,
    method: &str,
    path: &str,
    host: &str,
    body: &[u8],
    operator: &Operator,
    store: &SessionStore,
) -> (String, Vec<u8>) {
    let nonce = store
        .issue_request_nonce(&operator.signed_in.session_id, &operator.signed_in.token)
        .await
        .expect("a nonce");
    let counter = next_counter(&operator.signed_in.session_id).await;
    let unix_ms = now_ms();
    let message = sessions::request_bytes(
        &operator.signed_in.session_id,
        method,
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
    raw_request(addr, method, path, host, &headers, body).await
}

async fn raw_request(
    addr: std::net::SocketAddr,
    method: &str,
    path: &str,
    host: &str,
    headers: &[(&str, String)],
    body: &[u8],
) -> (String, Vec<u8>) {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    let mut stream = tokio::net::TcpStream::connect(addr)
        .await
        .expect("connect to the test router");
    let mut head = format!(
        "{method} {path} HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\nContent-Length: {}\r\n",
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

/// The body `POST /admin/placement` takes, signed by the operator's enrolled
/// key over exactly the fields it carries.
fn placement_body(
    operator: &Operator,
    deployment: &str,
    hosts: &str,
    sources: &str,
    window_seconds: i64,
) -> Vec<u8> {
    let message = placement::placement_request_bytes(
        deployment,
        &operator.id,
        hosts,
        sources,
        window_seconds,
    );
    let assertion = operator.key.sign(&message);
    let mut body = Vec::new();
    lp(&mut body, hosts.as_bytes());
    lp(&mut body, sources.as_bytes());
    lp(&mut body, window_seconds.to_string().as_bytes());
    lp(&mut body, &assertion);
    body
}

fn read_lp_fields(body: &[u8], n: usize) -> Vec<Vec<u8>> {
    let mut rest = body;
    let mut out = Vec::new();
    for _ in 0..n {
        let (field, tail) = fathom_server::crypto::read_lp(rest).expect("a length-prefixed field");
        out.push(field.to_vec());
        rest = tail;
    }
    out
}

// ---------------------------------------------------------------------------
// Decision 11 — the interlock
// ---------------------------------------------------------------------------

/// **The whole of decision 11 in one test**: a placement applies at once, is
/// sealed, confines the console immediately, and is confirmed by the first
/// verified `/admin` request on the new host inside the window.
#[tokio::test]
async fn a_placement_applies_at_once_and_a_matching_host_request_confirms_it() {
    let _serial = SERIAL.lock().await;
    let pool = deployment().await;
    let ring = ring();
    let sessions = sessions_store(&pool, Arc::clone(&ring)).await;
    let operators = operators_store(&pool, Arc::clone(&ring)).await;
    let operator = an_operator(&operators, &sessions).await;
    let placement = placement_store(&pool, Arc::clone(&ring)).await;
    // Start from open: a previous test that failed part way through leaves
    // its placement behind, and a cascade of 404s hides the failure that
    // caused it.
    placement.reset_from_host().await.expect("start from open");
    let (addr, store) = serve(&pool, Arc::clone(&ring), Arc::clone(&placement)).await;
    let deployment_id = deployment_id(&pool).await;

    let requested_before = site_entries_of("console_placement_requested").await;
    let confirmed_before = site_entries_of("console_placement_confirmed").await;

    // The console is open before this: every host answers.
    let (status, _) = signed_request(
        addr,
        "GET",
        "/admin/organisations/list",
        "anything.example.test",
        b"",
        &operator,
        &store,
    )
    .await;
    assert_eq!(
        status, "200",
        "the console answers everywhere until a placement says otherwise"
    );

    // Move it. The window is the smallest the schema allows, which is a real
    // number an operator could type.
    let body = placement_body(
        &operator,
        &deployment_id,
        "console.example.test",
        "127.0.0.1/32",
        60,
    );
    let (status, answer) = signed_request(
        addr,
        "POST",
        "/admin/placement",
        "anything.example.test",
        &body,
        &operator,
        &store,
    )
    .await;
    assert_eq!(status, "200", "an operator may move the console");
    let fields = read_lp_fields(&answer, 1);
    let id = String::from_utf8(fields[0].clone()).expect("a ulid");
    assert_eq!(id.len(), 26);

    // Sealed in the same transaction, and applied at once: `sealed_seq` is
    // NOT NULL from the INSERT (`0020`).
    assert_eq!(
        site_entries_of("console_placement_requested").await,
        requested_before + 1,
        "a placement is a sealed site-chain entry"
    );
    let sealed: Option<i64> = superuser()
        .await
        .query_one(
            "SELECT sealed_seq FROM console_placements WHERE id = $1",
            &[&id],
        )
        .await
        .expect("the row")
        .get(0);
    assert!(
        sealed.is_some(),
        "a placement is a fact the instant it is written"
    );

    // The gate follows immediately, with no restart: the old host is 404 and
    // the new one answers.
    let (status, _) = signed_request(
        addr,
        "GET",
        "/admin/organisations/list",
        "anything.example.test",
        b"",
        &operator,
        &store,
    )
    .await;
    assert_eq!(
        status, "404",
        "the console has moved and does not answer here"
    );
    assert_eq!(
        site_entries_of("console_placement_confirmed").await,
        confirmed_before,
        "a 404 on the old host is not a confirmation"
    );

    // ...and the request that lands on the NEW host, verified, IS the
    // confirmation. There is no confirmation route.
    let (status, _) = signed_request(
        addr,
        "GET",
        "/admin/organisations/list",
        "console.example.test",
        b"",
        &operator,
        &store,
    )
    .await;
    assert_eq!(status, "200");
    assert_eq!(
        site_entries_of("console_placement_confirmed").await,
        confirmed_before + 1,
        "the first verified /admin request on the new host confirms the placement"
    );
    let row = superuser()
        .await
        .query_one(
            "SELECT confirmed_by, confirmed_at IS NOT NULL, confirmed_seq IS NOT NULL \
               FROM console_placements WHERE id = $1",
            &[&id],
        )
        .await
        .expect("the row");
    assert_eq!(
        row.get::<_, Option<String>>(0).as_deref(),
        Some(operator.id.as_str())
    );
    assert!(row.get::<_, bool>(1) && row.get::<_, bool>(2));

    // The flag, on every host, says where the console is.
    let (status, body) = raw_request(
        addr,
        "GET",
        "/placement/flag",
        "console.example.test",
        &[],
        b"",
    )
    .await;
    assert_eq!(status, "200");
    assert_eq!(read_lp_fields(&body, 1)[0], b"yes");
    let (status, body) = raw_request(
        addr,
        "GET",
        "/placement/flag",
        "anything.example.test",
        &[],
        b"",
    )
    .await;
    assert_eq!(
        status, "200",
        "the flag answers where /admin is 404 -- that is the point of it"
    );
    assert_eq!(read_lp_fields(&body, 1)[0], b"no");

    // Clean up for the tests that follow: the placement is cleared from the
    // host, which is decision 11's own way out.
    placement.reset_from_host().await.expect("clear it");
}

/// **Decision 11's revert**: a window that runs out with nobody having reached
/// the new host puts the console back where it was, sealed.
#[tokio::test]
async fn an_unconfirmed_window_reverts_to_the_last_confirmed_placement() {
    let _serial = SERIAL.lock().await;
    let pool = deployment().await;
    let ring = ring();
    let sessions = sessions_store(&pool, Arc::clone(&ring)).await;
    let operators = operators_store(&pool, Arc::clone(&ring)).await;
    let operator = an_operator(&operators, &sessions).await;
    let placement = placement_store(&pool, Arc::clone(&ring)).await;
    // Start from open: a previous test that failed part way through leaves
    // its placement behind, and a cascade of 404s hides the failure that
    // caused it.
    placement.reset_from_host().await.expect("start from open");
    let (addr, store) = serve(&pool, Arc::clone(&ring), Arc::clone(&placement)).await;
    let deployment_id = deployment_id(&pool).await;

    // A placement that IS confirmed, so there is something to fall back to.
    let body = placement_body(
        &operator,
        &deployment_id,
        "first.example.test",
        "127.0.0.1/32",
        60,
    );
    let (status, answer) = signed_request(
        addr,
        "POST",
        "/admin/placement",
        "anything.example.test",
        &body,
        &operator,
        &store,
    )
    .await;
    assert_eq!(status, "200");
    let first = String::from_utf8(read_lp_fields(&answer, 1)[0].clone()).unwrap();
    let (status, _) = signed_request(
        addr,
        "GET",
        "/admin/organisations/list",
        "first.example.test",
        b"",
        &operator,
        &store,
    )
    .await;
    assert_eq!(status, "200");

    // ...and a second one that nobody confirms.
    let body = placement_body(
        &operator,
        &deployment_id,
        "second.example.test",
        "127.0.0.1/32",
        60,
    );
    let (status, answer) = signed_request(
        addr,
        "POST",
        "/admin/placement",
        "first.example.test",
        &body,
        &operator,
        &store,
    )
    .await;
    assert_eq!(status, "200");
    let second = String::from_utf8(read_lp_fields(&answer, 1)[0].clone()).unwrap();

    // **The window is moved into the past rather than waited out.** The floor
    // is sixty seconds (`0020`'s own CHECK, and decision 11's "it cannot be
    // turned off"), and a test that slept a minute is a test nobody runs. The
    // superuser moves the row's own clock; everything after this is the real
    // sweep on a real expired row.
    superuser()
        .await
        .execute(
            "UPDATE console_placements \
                SET requested_at = now() - interval '120 seconds', \
                    confirm_by = now() - interval '1 second' \
              WHERE id = $1",
            &[&second],
        )
        .await
        .expect("move the window into the past");
    placement.refresh().await.expect("re-read it");

    // Before the sweep has written anything, the GATE has already stopped
    // honouring the expired window: `Placement::effective` decides by the
    // clock, so a failed move cannot strand the console on a host nobody
    // reached.
    let (status, _) = signed_request(
        addr,
        "GET",
        "/admin/organisations/list",
        "second.example.test",
        b"",
        &operator,
        &store,
    )
    .await;
    assert_eq!(status, "404", "an expired window is not a placement");

    let reverted_before = site_entries_of("console_placement_reverted").await;
    // The request that lands on the host the console fell BACK to sweeps it,
    // which is the same shape `apply_due_operator_requests` has: the paths
    // that care do the sweeping.
    let (status, _) = signed_request(
        addr,
        "GET",
        "/admin/organisations/list",
        "first.example.test",
        b"",
        &operator,
        &store,
    )
    .await;
    assert_eq!(
        status, "200",
        "the console is back where it was last confirmed"
    );
    assert_eq!(
        site_entries_of("console_placement_reverted").await,
        reverted_before + 1,
        "the revert is sealed"
    );
    let reason: Option<String> = superuser()
        .await
        .query_one(
            "SELECT revert_reason FROM console_placements WHERE id = $1",
            &[&second],
        )
        .await
        .expect("the row")
        .get(0);
    assert_eq!(reason.as_deref(), Some("window_expired"));

    // The first placement is untouched by its successor's failure.
    let still: Option<String> = superuser()
        .await
        .query_one(
            "SELECT revert_reason FROM console_placements WHERE id = $1",
            &[&first],
        )
        .await
        .expect("the row")
        .get(0);
    assert_eq!(still, None);

    placement.reset_from_host().await.expect("clear it");
}

/// **Decision 11's last sentence**: the host clears a placement that locked
/// everyone out, and the act is on the chain.
#[tokio::test]
async fn the_host_can_clear_a_placement_and_says_so_on_the_chain() {
    let _serial = SERIAL.lock().await;
    let pool = deployment().await;
    let ring = ring();
    let sessions = sessions_store(&pool, Arc::clone(&ring)).await;
    let operators = operators_store(&pool, Arc::clone(&ring)).await;
    let operator = an_operator(&operators, &sessions).await;
    let placement = placement_store(&pool, Arc::clone(&ring)).await;
    // Start from open: a previous test that failed part way through leaves
    // its placement behind, and a cascade of 404s hides the failure that
    // caused it.
    placement.reset_from_host().await.expect("start from open");
    let (addr, store) = serve(&pool, Arc::clone(&ring), Arc::clone(&placement)).await;
    let deployment_id = deployment_id(&pool).await;

    let body = placement_body(
        &operator,
        &deployment_id,
        "vanished.example.test",
        "127.0.0.1/32",
        600,
    );
    let (status, answer) = signed_request(
        addr,
        "POST",
        "/admin/placement",
        "anything.example.test",
        &body,
        &operator,
        &store,
    )
    .await;
    assert_eq!(status, "200");
    let placement_id =
        String::from_utf8(read_lp_fields(&answer, 1)[0].clone()).expect("the placement id");
    // The host it moved to does not exist any more: nobody can confirm, and
    // nobody can reach the console to move it back.
    let (status, _) = signed_request(
        addr,
        "GET",
        "/admin/organisations/list",
        "anything.example.test",
        b"",
        &operator,
        &store,
    )
    .await;
    assert_eq!(status, "404");

    let reverted_before = site_entries_of("console_placement_reverted").await;
    let cleared = placement
        .reset_from_host()
        .await
        .expect("the host clears it");
    assert_eq!(cleared, 1);
    assert_eq!(
        site_entries_of("console_placement_reverted").await,
        reverted_before + 1,
        "clearing a placement from the host is sealed, and loudly"
    );
    // By id, not by "the newest reverted row": `reverted_at` is whole
    // seconds, and a window another test left to expire can be swept in the
    // same second this reset runs, which made the newest row a coin flip.
    let reason: Option<String> = superuser()
        .await
        .query_one(
            "SELECT revert_reason FROM console_placements WHERE id = $1",
            &[&placement_id],
        )
        .await
        .expect("the row")
        .get(0);
    assert_eq!(reason.as_deref(), Some("host_reset"));

    // And the console answers again.
    let (status, _) = signed_request(
        addr,
        "GET",
        "/admin/organisations/list",
        "anything.example.test",
        b"",
        &operator,
        &store,
    )
    .await;
    assert_eq!(status, "200");
}

/// **`console-placement --reset` reaches a server that is already running** —
/// ADR-0055 fix (b), the second half of decision 11's only way back from a
/// console lockout.
///
/// # What was wrong
///
/// `reset_from_host` reverted the rows and called `self.refresh()` on the CLI
/// process's own `PlacementStore`. The serving process holds a different
/// `Arc<RwLock<Placement>>` in a different process and nothing invalidated it,
/// so the gate went on enforcing the dead placement until somebody restarted
/// the server — while the CLI's log line said the console now answered
/// everywhere. Reproduced by the checker on a throwaway deployment on
/// 2026-09-21: `/admin/operators` was still 404 on `127.0.0.1` and
/// `/placement/flag` still `no` after a `reverted=1 reason="host_reset"`.
///
/// # Why the old tests could not catch it
///
/// Every existing test here calls `placement.reset_from_host()` on the SAME
/// in-process store the router was handed — a relationship the CLI can never
/// have. **So this one uses two stores over one pool**, which is the shape two
/// processes actually have: `serving` is the one the gate reads, `host` is the
/// CLI's. Only the refresher connects them.
#[tokio::test]
async fn a_reset_from_another_process_reaches_a_running_server_within_the_ttl() {
    let _serial = SERIAL.lock().await;
    let pool = deployment().await;
    let ring = ring();
    let sessions = sessions_store(&pool, Arc::clone(&ring)).await;
    let operators = operators_store(&pool, Arc::clone(&ring)).await;
    let operator = an_operator(&operators, &sessions).await;

    // The SERVING process's store, with the snapshot refresher `main.rs`
    // starts beside it.
    let serving = placement_store(&pool, Arc::clone(&ring)).await;
    serving.reset_from_host().await.expect("start from open");
    let (addr, store) = serve(&pool, Arc::clone(&ring), Arc::clone(&serving)).await;
    let deployment_id = deployment_id(&pool).await;

    // A placement that locks the console to a host nobody can reach.
    let body = placement_body(
        &operator,
        &deployment_id,
        "gone.example.test",
        "127.0.0.1/32",
        600,
    );
    let (status, _) = signed_request(
        addr,
        "POST",
        "/admin/placement",
        "anything.example.test",
        &body,
        &operator,
        &store,
    )
    .await;
    assert_eq!(status, "200");
    let (status, _) = signed_request(
        addr,
        "GET",
        "/admin/organisations/list",
        "anything.example.test",
        b"",
        &operator,
        &store,
    )
    .await;
    assert_eq!(
        status, "404",
        "the console is locked to a host that is gone"
    );

    // **A SECOND store over the same pool** — the CLI's, in what is a second
    // process in production. It shares nothing with `serving` but the
    // database.
    let host = Arc::new(PlacementStore::new(
        pool.clone(),
        Arc::clone(&ring),
        deployment_id.clone(),
    ));
    assert!(
        !Arc::ptr_eq(&host.view(), &serving.view()),
        "two stores, two snapshots -- otherwise this test proves nothing"
    );

    let refresher = PlacementStore::spawn_snapshot_refresher(Arc::clone(&serving));
    let cleared = host
        .reset_from_host()
        .await
        .expect("the host clears the placement that locked everyone out");
    assert_eq!(cleared, 1);

    // The claim, with the TTL the CLI's own log line now quotes and a margin
    // for the poll landing just after a tick.
    tokio::time::sleep(placement::SNAPSHOT_TTL + Duration::from_secs(2)).await;
    let (status, _) = signed_request(
        addr,
        "GET",
        "/admin/organisations/list",
        "anything.example.test",
        b"",
        &operator,
        &store,
    )
    .await;
    assert_eq!(
        status, "200",
        "the running server must honour a reset made by another process without a restart; \
         before ADR-0055 fix (b) this stayed 404 until the server was restarted"
    );
    let (status, flag) = raw_request(
        addr,
        "GET",
        "/placement/flag",
        "anything.example.test",
        &[],
        b"",
    )
    .await;
    assert_eq!(status, "200");
    assert_eq!(read_lp_fields(&flag, 1)[0], b"yes");

    refresher.abort();
}

/// The refusals: a placement nobody signed, a window outside the schema's
/// bounds, and hosts that are not hosts.
#[tokio::test]
async fn a_placement_is_refused_unless_the_operator_signed_exactly_it() {
    let _serial = SERIAL.lock().await;
    let pool = deployment().await;
    let ring = ring();
    let sessions = sessions_store(&pool, Arc::clone(&ring)).await;
    let operators = operators_store(&pool, Arc::clone(&ring)).await;
    let operator = an_operator(&operators, &sessions).await;
    let placement = placement_store(&pool, Arc::clone(&ring)).await;
    // Start from open: a previous test that failed part way through leaves
    // its placement behind, and a cascade of 404s hides the failure that
    // caused it.
    placement.reset_from_host().await.expect("start from open");
    let (addr, store) = serve(&pool, Arc::clone(&ring), Arc::clone(&placement)).await;
    let deployment_id = deployment_id(&pool).await;
    let before = site_entries_of("console_placement_requested").await;

    // A signature over a DIFFERENT host than the one in the body: this is the
    // attack the assertion exists to stop, and it must not turn into a
    // placement.
    let mut body = Vec::new();
    let message = placement::placement_request_bytes(
        &deployment_id,
        &operator.id,
        "honest.example.test",
        "127.0.0.1/32",
        60,
    );
    lp(&mut body, b"attacker.example.test");
    lp(&mut body, b"127.0.0.1/32");
    lp(&mut body, b"60");
    lp(&mut body, &operator.key.sign(&message));
    let (status, _) = signed_request(
        addr,
        "POST",
        "/admin/placement",
        "anything.example.test",
        &body,
        &operator,
        &store,
    )
    .await;
    assert_eq!(
        status, "401",
        "a placement nobody signed is not a placement"
    );

    // A window under the floor and over the ceiling.
    for window in [59, 3601] {
        let body = placement_body(
            &operator,
            &deployment_id,
            "console.example.test",
            "127.0.0.1/32",
            window,
        );
        let (status, _) = signed_request(
            addr,
            "POST",
            "/admin/placement",
            "anything.example.test",
            &body,
            &operator,
            &store,
        )
        .await;
        assert_eq!(
            status, "400",
            "the window is bounded at 60 and 3600 seconds"
        );
    }

    // A host that is not a host, and a source that is not a range.
    for (hosts, sources) in [
        ("https://console.example.test", "127.0.0.1/32"),
        ("console.example.test", "not-a-range"),
        ("", "127.0.0.1/32"),
    ] {
        let body = placement_body(&operator, &deployment_id, hosts, sources, 60);
        let (status, _) = signed_request(
            addr,
            "POST",
            "/admin/placement",
            "anything.example.test",
            &body,
            &operator,
            &store,
        )
        .await;
        assert_eq!(status, "400", "{hosts:?} / {sources:?}");
    }

    // A body with a field this route does not read.
    let mut body = placement_body(
        &operator,
        &deployment_id,
        "console.example.test",
        "127.0.0.1/32",
        60,
    );
    lp(&mut body, b"surprise");
    let (status, _) = signed_request(
        addr,
        "POST",
        "/admin/placement",
        "anything.example.test",
        &body,
        &operator,
        &store,
    )
    .await;
    assert_eq!(status, "400");

    assert_eq!(
        site_entries_of("console_placement_requested").await,
        before,
        "not one of those wrote a placement"
    );
}

// ---------------------------------------------------------------------------
// Decision 11 — the SMTP setting
// ---------------------------------------------------------------------------

/// **The `smtp` value envelope is checked before it is sealed**, and a test
/// send says plainly that mail is not built yet rather than pretending.
#[tokio::test]
async fn the_smtp_envelope_is_checked_and_a_test_send_says_mail_is_not_built_yet() {
    let _serial = SERIAL.lock().await;
    let pool = deployment().await;
    let ring = ring();
    let sessions = sessions_store(&pool, Arc::clone(&ring)).await;
    let operators = operators_store(&pool, Arc::clone(&ring)).await;
    let operator = an_operator(&operators, &sessions).await;
    let placement = placement_store(&pool, Arc::clone(&ring)).await;
    // Start from open: a previous test that failed part way through leaves
    // its placement behind, and a cascade of 404s hides the failure that
    // caused it.
    placement.reset_from_host().await.expect("start from open");
    let (addr, store) = serve(&pool, Arc::clone(&ring), Arc::clone(&placement)).await;
    let deployment_id = deployment_id(&pool).await;

    // A real submission configuration, with a password of the shape a
    // provider actually issues (CLAUDE.md rule 2).
    let value = placement::smtp_value_bytes(
        "smtp.example.test",
        587,
        TlsMode::StartTls,
        "fathom@example.test",
        "Tr0ub4dor&3xK!ngf1sh",
        "fathom@example.test",
    );
    let (status, answer) =
        settings_request(addr, &operator, &store, &deployment_id, "smtp", &value).await;
    assert_eq!(status, "200", "a well-formed SMTP form is accepted");
    let id = String::from_utf8(read_lp_fields(&answer, 1)[0].clone()).unwrap();

    // The value is in the database only as ciphertext.
    let stored: Vec<u8> = superuser()
        .await
        .query_one(
            "SELECT value_ct FROM site_settings_versions WHERE id = $1",
            &[&id],
        )
        .await
        .expect("the row")
        .get(0);
    assert!(
        !stored.windows(20).any(|w| w == b"Tr0ub4dor&3xK!ngf1sh"),
        "an SMTP password is sealed before it is stored"
    );

    // Malformed envelopes are refused at the door, with nothing stored.
    let mut five_fields = Vec::new();
    for field in [
        &b"smtp.example.test"[..],
        b"587",
        b"starttls",
        b"fathom@example.test",
        b"Tr0ub4dor&3xK!ngf1sh",
    ] {
        lp(&mut five_fields, field);
    }
    let mut wrong_mode = Vec::new();
    for field in [
        &b"smtp.example.test"[..],
        b"587",
        b"ssl-maybe",
        b"fathom@example.test",
        b"Tr0ub4dor&3xK!ngf1sh",
        b"fathom@example.test",
    ] {
        lp(&mut wrong_mode, field);
    }
    let bad_from = placement::smtp_value_bytes(
        "smtp.example.test",
        587,
        TlsMode::StartTls,
        "fathom@example.test",
        "Tr0ub4dor&3xK!ngf1sh",
        "not-an-address",
    );
    for (what, value) in [
        ("five fields", five_fields),
        ("a tls mode outside the closed set", wrong_mode),
        ("a from-address that is not one", bad_from),
    ] {
        let (status, _) =
            settings_request(addr, &operator, &store, &deployment_id, "smtp", &value).await;
        assert_eq!(status, "400", "{what} must be refused");
    }

    // A key that is not `smtp` is untouched by any of this: the envelope
    // check is for the one key that has a form.
    let (status, _) = settings_request(
        addr,
        &operator,
        &store,
        &deployment_id,
        "retention_days",
        b"90",
    )
    .await;
    assert_eq!(status, "200", "other settings are not SMTP envelopes");

    // The test send: rate-limited, recorded, and honest.
    let (status, body) = signed_request(
        addr,
        "POST",
        &format!("/admin/settings/{id}/test-send"),
        "anything.example.test",
        b"",
        &operator,
        &store,
    )
    .await;
    assert_eq!(status, "503");
    assert_eq!(
        String::from_utf8_lossy(&body),
        "mail sending is not built yet\n"
    );
    let (status, _) = signed_request(
        addr,
        "POST",
        &format!("/admin/settings/{id}/test-send"),
        "anything.example.test",
        b"",
        &operator,
        &store,
    )
    .await;
    assert_eq!(
        status, "429",
        "one test send per operator per five minutes, in the bucket the sign-in limiter keeps"
    );
    let spent: i64 = superuser()
        .await
        .query_one(
            "SELECT count(*) FROM sign_in_attempts \
              WHERE bucket_kind = 'account' AND bucket_key LIKE 'smtp-test:%'",
            &[],
        )
        .await
        .expect("count buckets")
        .get(0);
    assert!(
        spent >= 1,
        "the test send spends the bucket it says it does"
    );
}

/// `POST /admin/settings` with a key, a value and the operator's assertion.
async fn settings_request(
    addr: std::net::SocketAddr,
    operator: &Operator,
    store: &SessionStore,
    deployment_id: &str,
    key: &str,
    value: &[u8],
) -> (String, Vec<u8>) {
    let message =
        fathom_server::operators::setting_request_bytes(deployment_id, &operator.id, key, value);
    let assertion = operator.key.sign(&message);
    let mut body = Vec::new();
    lp(&mut body, key.as_bytes());
    lp(&mut body, value);
    lp(&mut body, &assertion);
    signed_request(
        addr,
        "POST",
        "/admin/settings",
        "anything.example.test",
        &body,
        operator,
        store,
    )
    .await
}

/// The session fixture is used by every test above; this keeps the compiler
/// from warning about the field nothing reads directly.
#[allow(dead_code)]
fn unused(operator: &Operator) -> &VerifiedSession {
    &operator.session
}

#[allow(dead_code)]
fn unused_now() -> i64 {
    now_unix()
}
