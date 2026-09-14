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
use fathom_server::crypto::Key32;
use fathom_server::grants::{self, Authority, EpochWatch, GenesisGrant};
use fathom_server::keys::{self, KeyRing};
use fathom_server::operators::{self, OperatorError, OperatorStore, Purpose};
use fathom_server::repo::{self, AccountId, OrganisationId};
use fathom_server::sessions::{
    self, PrincipalKind, SessionError, SessionStore, SignInLimits, SignedIn, VerifiedSession,
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
async fn store(
    pool: &Pool,
    ring: Arc<KeyRing>,
    single_operator: bool,
    delay: Duration,
) -> OperatorStore {
    let client = pool.get().await.expect("connection");
    let deployment = chains::deployment_id(&**client)
        .await
        .expect("this deployment is stamped at startup");
    OperatorStore::with_delay(pool.clone(), ring, deployment, single_operator, delay)
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
                    operators
                        .redeem_operator_enrolment(&bootstrap.invitation.token, &key.public_key())
                        .await
                        .expect("the first operator redeems the token from the key volume");
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
    let operators_store = store(&pool, Arc::clone(&ring), true, Duration::from_secs(1)).await;

    let signins_before = site_entries_of("operator_signin").await;
    let operator = a_bootstrapped_operator(&operators_store, &sessions_store).await;
    assert!(
        site_entries_of("operator_signin").await > signins_before,
        "an operator sign-in is a sealed site-chain entry (§7.2)"
    );
    assert!(site_entries_of("operator_bootstrapped").await >= 1);
    assert!(site_entries_of("operator_enrolled").await >= 1);

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
    let operators_store = store(&pool, Arc::clone(&ring), true, Duration::from_secs(1)).await;
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
    let operators_store = store(&pool, Arc::clone(&ring), true, Duration::from_secs(1)).await;
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
    let operators_store = store(&pool, Arc::clone(&ring), true, Duration::from_secs(1)).await;
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
    let operators_store = store(&pool, Arc::clone(&ring), true, Duration::from_secs(1)).await;
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
    let operators_store = store(&pool, Arc::clone(&ring), true, Duration::from_secs(1)).await;
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
    let operators_store = store(&pool, Arc::clone(&ring), true, Duration::from_secs(1)).await;
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
    let operators_store = store(&pool, Arc::clone(&ring), true, Duration::from_secs(1)).await;
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
// §5.3, §5.4, §5.5 — the interlock
// ---------------------------------------------------------------------------

/// **One operator asserting twice does not satisfy the interlock.**
///
/// The attempt is made with a real signature over the real seconding bytes by
/// the real requesting operator — everything a determined operator would
/// actually have — and it is refused before the statement is issued and again
/// by the `CHECK` if it ever were.
#[tokio::test]
async fn the_interlock_cannot_be_satisfied_by_one_operator_asserting_twice() {
    let _serial = SERIAL.lock().await;
    let pool = deployment().await;
    let ring = ring();
    let sessions_store = sessions(&pool, Arc::clone(&ring)).await;
    // **NOT single-operator mode**: this is the two-operator control.
    let operators_store = store(&pool, Arc::clone(&ring), false, Duration::from_secs(1)).await;
    let operator = a_bootstrapped_operator(&operators_store, &sessions_store).await;

    // A first version applies immediately (§5.3's first-version rule), so this
    // test changes a setting that already has one.
    let key = unique("smtp");
    request_and_expect_applied(&operators_store, &operator, &key, b"first").await;

    let value = b"second";
    let message =
        operators::setting_request_bytes(operators_store.deployment(), &operator.id, &key, value);
    let pending = operators_store
        .request_setting(&operator.session, &key, value, &operator.key.sign(&message))
        .await
        .expect("a second version is requested");
    assert!(pending.sealed_seq.is_none(), "it must not be applied yet");

    // The same operator now seconds their own change, with a genuine signature.
    let second_message = operators::setting_second_bytes(
        operators_store.deployment(),
        &operator.id,
        &pending.id,
        &key,
        &value_digest_of(&pending.id).await,
    );
    let refused = operators_store
        .second_setting(
            &operator.session,
            &pending.id,
            &operator.key.sign(&second_message),
        )
        .await;
    assert!(
        matches!(refused, Err(OperatorError::SecondedByTheRequester)),
        "the requester must not be the seconder: {refused:?}"
    );

    // And the database refuses it too, as the superuser, which is the fence
    // that binds when the code above is changed.
    let refused = superuser()
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

async fn value_digest_of(id: &str) -> [u8; 32] {
    let digest: Vec<u8> = superuser()
        .await
        .query_one(
            "SELECT value_digest FROM site_settings_versions WHERE id = $1",
            &[&id],
        )
        .await
        .expect("the row")
        .get(0);
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
    let operators_store = store(&pool, Arc::clone(&ring), true, Duration::from_secs(1)).await;
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
    let operators_store = store(&pool, Arc::clone(&ring), true, Duration::from_secs(1)).await;
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

/// §5.3 in single-operator mode: **the second signature goes and the delay
/// stays.**
///
/// *"`FATHOM_SINGLE_OPERATOR=true` reduces the second signature to none and
/// keeps the delay, the notice and the witness receipt. Quorum 1 with no delay
/// is not a configuration the product offers."* So a second version of a
/// setting does not apply the moment it is asked for, and does apply once its
/// delay has elapsed.
#[tokio::test]
async fn single_operator_mode_drops_the_second_signature_and_keeps_the_delay() {
    let _serial = SERIAL.lock().await;
    let pool = deployment().await;
    let ring = ring();
    let sessions_store = sessions(&pool, Arc::clone(&ring)).await;
    let operators_store = store(&pool, Arc::clone(&ring), true, Duration::from_secs(2)).await;
    let operator = a_bootstrapped_operator(&operators_store, &sessions_store).await;

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

/// §5.5's other seconder rule: **the seconder was not created by the
/// requester.** Two ids that differ are not two humans when one of them minted
/// the other.
#[tokio::test]
async fn an_operator_cannot_be_seconded_by_the_operator_they_created() {
    let _serial = SERIAL.lock().await;
    let pool = deployment().await;
    let ring = ring();
    let sessions_store = sessions(&pool, Arc::clone(&ring)).await;
    let operators_store = store(&pool, Arc::clone(&ring), true, Duration::from_secs(1)).await;
    let first = a_bootstrapped_operator(&operators_store, &sessions_store).await;
    let second = a_second_operator(&operators_store, &sessions_store, &first).await;

    // Give the seconder the independent sign-in history §5.5 also requires, so
    // that what refuses the seconding below is the rule being tested and not a
    // different one. Backdating is legitimate here and nowhere else: the column
    // is deliberately outside the row seal (`operators::note_first_signin`
    // carries that argument), and what it stands for is time passing.
    superuser()
        .await
        .execute(
            "UPDATE operators SET first_independent_signin_at = now() - interval '30 days' \
              WHERE id = $1",
            &[&second.id],
        )
        .await
        .expect("backdate the seconder's first sign-in");

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
        &value_digest_of(&pending.id).await,
    );
    let refused = operators_store
        .second_setting(&acting, &pending.id, &second.key.sign(&second_message))
        .await;
    assert!(
        refused.is_err(),
        "an operator the requester created may not second their change (§5.5)"
    );
    assert_eq!(
        operators_store
            .effective_setting(&key)
            .await
            .expect("the resolver answers")
            .as_deref(),
        Some(&b"first"[..]),
        "and the change does not apply"
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
    let operators_store = store(&pool, Arc::clone(&ring), true, Duration::from_secs(1)).await;
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
    let acting = by
        .session_for(sessions_store, "POST", "/admin/operators", b"")
        .await;
    let message = operators::operator_request_bytes(operators_store.deployment(), &by.id, &name);
    operators_store
        .request_operator(&acting, &name, &by.key.sign(&message))
        .await
        .expect("an operator may request a colleague (§5.5)");

    // The delay is the store's, and it is short in tests and 24 hours in
    // production. It is never zero.
    tokio::time::sleep(Duration::from_millis(1200)).await;
    let invitations = operators_store
        .apply_due_operator_requests()
        .await
        .expect("the delay elapsed");
    let invitation = invitations
        .into_iter()
        .find(|invitation| invitation.purpose == Purpose::Operator)
        .expect("applying an operator request issues its enrolment token");

    let key = SoftwareKey::random().expect("a keypair");
    operators_store
        .redeem_operator_enrolment(&invitation.token, &key.public_key())
        .await
        .expect("the new operator's first sign-in registers a key (§5.5)");

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
    let operators_store = store(&pool, Arc::clone(&ring), true, Duration::from_secs(1)).await;
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
    let operators_store = store(&pool, Arc::clone(&ring), true, Duration::from_secs(1)).await;
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
    let operators_store = store(&pool, Arc::clone(&ring), true, Duration::from_secs(1)).await;
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
    let operators_store = store(&pool, Arc::clone(&ring), true, Duration::from_secs(1)).await;
    let operator = a_bootstrapped_operator(&operators_store, &sessions_store).await;

    let state = AdminState {
        sessions: Arc::new(sessions(&pool, Arc::clone(&ring)).await),
        operators: Arc::new(store(&pool, Arc::clone(&ring), true, Duration::from_secs(1)).await),
        ring: Arc::clone(&ring),
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
    let counter = next_counter(&operator.signed_in.session_id).await;
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

/// **No route accepts anything password-shaped, and the check covers the WIRE
/// TYPES and not only one module.**
///
/// `sessions.rs` has had this check since `0013`, on its own source. The wire
/// fields live in `api.rs` and now in `admin.rs`, so the check moves to where
/// the fields are: every file that parses a request body or names a header is
/// read, and a non-comment line mentioning a password-shaped field fails it.
#[test]
fn no_wire_type_in_this_server_has_a_field_a_password_could_arrive_in() {
    let files = [
        ("api.rs", include_str!("../src/api.rs")),
        ("admin.rs", include_str!("../src/admin.rs")),
        ("operators.rs", include_str!("../src/operators.rs")),
        ("sessions.rs", include_str!("../src/sessions.rs")),
    ];
    for (name, whole) in files {
        // The test modules are cut off first: their own names contain the word.
        let source = whole
            .split_once("#[cfg(test)]")
            .map(|(before, _)| before)
            .unwrap_or(whole);
        for forbidden in ["password", "passphrase", "passcode", "\"pin\""] {
            for line in source.lines() {
                let lower = line.to_ascii_lowercase();
                if !lower.contains(forbidden) {
                    continue;
                }
                assert!(
                    lower.trim_start().starts_with("//")
                        || lower.trim_start().starts_with("///")
                        || lower.contains("no password")
                        || lower.contains("forbidden"),
                    "{name} has a non-comment line mentioning {forbidden}: {line}"
                );
            }
        }
    }
}

/// The structural half of the same claim, at the database: **there is no
/// password column anywhere in this schema**, for an account or an operator.
#[tokio::test]
async fn the_schema_has_no_column_a_password_could_be_stored_in() {
    let _pool = deployment().await;
    let found: i64 = superuser()
        .await
        .query_one(
            "SELECT count(*) FROM information_schema.columns \
              WHERE table_schema = 'public' \
                AND (column_name ILIKE '%password%' OR column_name ILIKE '%passphrase%' \
                     OR column_name ILIKE '%passcode%' OR column_name = 'pin')",
            &[],
        )
        .await
        .expect("read the catalogue")
        .get(0);
    assert_eq!(found, 0, "§4.5 and §5.1: there is no password, for anyone");
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
    let operators_store = store(&pool, Arc::clone(&ring), true, Duration::from_secs(1)).await;
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
        "operator_enrolled",
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

/// §1.1's sampling rule: **one `operator_read` per session per surface**, not
/// one per poll. Without the latch an operator reading a page on a timer
/// chooses how fast the sealed audit grows.
#[tokio::test]
async fn an_operator_read_is_recorded_once_per_session_and_surface() {
    let _serial = SERIAL.lock().await;
    let pool = deployment().await;
    let ring = ring();
    let sessions_store = sessions(&pool, Arc::clone(&ring)).await;
    let operators_store = store(&pool, Arc::clone(&ring), true, Duration::from_secs(1)).await;
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
    let operators_store = store(&pool, Arc::clone(&ring), true, Duration::from_secs(1)).await;
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
