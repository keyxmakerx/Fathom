//! **The two reads the setup screen makes before anybody is signed in**, against
//! a real PostgreSQL and — where the claim is about what a caller can tell from
//! an answer — through the real router over a real socket.
//!
//! ADR-0056 (`docs/decisions/adr-0056-first-run-and-sign-in.md`, accepted
//! 2026-09-22) decisions 1 and 2:
//!
//! * `GET /setup/state` — one bit about the DEPLOYMENT: is the first operator
//!   still without a credential?
//! * `POST /enrolment/operator/setup/check` — whose setup does this token file
//!   open? So that the address is never typed and can never mismatch.
//!
//! **Every test here is written against a claim, and its name is the claim**
//! (CLAUDE.md rule 2). Two consequences worth stating first:
//!
//! - **a deployment per test.** The state is a fact about a whole deployment —
//!   its install record, its first operator, that operator's account — and the
//!   shared test database is one deployment several binaries write to. The
//!   same argument `tests/operators.rs` makes for its own.
//! - **the credential is a real one.** Four words, twenty-seven characters,
//!   past the fifteen-character floor and not on the bundled common list, for
//!   the reason `tests/credentials.rs`'s header gives.
//! - **the setup-state cache is process-wide and keyed by deployment**
//!   (`credentials::forget_setup_state`), so a database of its own per test is
//!   also a cache of its own per test.

mod support;

use std::sync::Arc;
use std::time::{Duration, Instant};

use deadpool_postgres::Pool;
use fathom_server::api::{self, CredentialApiState};
use fathom_server::chains;
use fathom_server::client_address::ClientAddress;
use fathom_server::credentials::{self, CredentialError, CredentialStore, SetupSecret, SetupState};
use fathom_server::crypto::Key32;
use fathom_server::keys::KeyRing;
use fathom_server::operators::{OperatorError, OperatorStore};
use fathom_server::sessions::{SessionStore, SignInLimits};

/// The same master key every other suite uses: ADR-0043 §4 stamps the
/// configured key's id per database and refuses a second.
const MASTER: [u8; 32] = [21; 32];

/// A real credential, of the shape a person actually chooses.
const A_REAL_CREDENTIAL: &str = "harbour-lantern-copper-nine";

fn ring() -> Arc<KeyRing> {
    Arc::new(KeyRing::from_keys(
        Key32::from_bytes(MASTER),
        Key32::from_bytes(support::SITE_CHAIN_MASTER),
    ))
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

/// A source address this call and no other will ever use: the enrolment routes
/// count per source string, and a suite that shared one would trip its own cap.
fn a_source_of_its_own() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT: AtomicU64 = AtomicU64::new(0);
    format!(
        "192.0.2.11-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    )
}

/// Everything one test needs, on a database of its own.
///
/// **One store of each kind, shared with the router**, exactly as `main.rs`
/// builds them: the stores carry the budget and the custodies, and a test that
/// gave the surface a second set would be measuring something the product does
/// not have. The setup-state cache is process-wide and keyed by this
/// deployment's id, so the database of its own is a cache of its own too.
struct Deployment {
    pool: Pool,
    operators: Arc<OperatorStore>,
    credentials: Arc<CredentialStore>,
    sessions: Arc<SessionStore>,
}

async fn a_fresh_deployment(tag: &str) -> Deployment {
    let ring = ring();
    let pool = support::isolated_deployment(tag).await;
    let client = pool.get().await.expect("connection");
    let id = chains::register_deployment(&**client)
        .await
        .expect("stamp the deployment id, exactly as main.rs does at startup");
    drop(client);
    Deployment {
        operators: Arc::new(OperatorStore::with_delay(
            pool.clone(),
            Arc::clone(&ring),
            id.clone(),
            Duration::from_secs(1),
        )),
        credentials: Arc::new(CredentialStore::new(
            pool.clone(),
            Arc::clone(&ring),
            id.clone(),
        )),
        sessions: Arc::new(SessionStore::new(
            pool.clone(),
            Arc::clone(&ring),
            id,
            SignInLimits::defaults(),
        )),
        pool,
    }
}

impl Deployment {
    /// The routes as `main.rs` mounts them, on a loopback port.
    async fn surface(&self) -> std::net::SocketAddr {
        self.surface_with_setup_secret(None).await
    }

    /// [`Deployment::surface`], with an ADR-0057 setup secret live behind it
    /// — the shape `main.rs` builds whenever `FATHOM_SETUP_PASSWORD` passes
    /// the policy and this deployment's first operator is still pending.
    async fn surface_with_setup_secret(
        &self,
        setup_secret: Option<credentials::SetupSecret>,
    ) -> std::net::SocketAddr {
        serve(api::credential_router(CredentialApiState {
            sessions: Arc::clone(&self.sessions),
            credentials: Arc::clone(&self.credentials),
            operators: Arc::clone(&self.operators),
            setup_secret,
            client_address: ClientAddress::header("x-forwarded-for"),
        }))
        .await
    }

    /// This deployment's id, which is the key the setup-state cache and its
    /// query counter are kept under.
    async fn deployment(&self) -> String {
        let client = self.pool.get().await.expect("connection");
        chains::deployment_id(&**client).await.expect("deployment")
    }
}

// ---------------------------------------------------------------------------
// Decision 1 — the deployment's own bit
// ---------------------------------------------------------------------------

/// **A deployment with nothing in it says `done`, not `pending`.**
///
/// ADR-0056 decision 1's last clause: with no install record and no operator
/// there is nothing for the setup screen to offer, and a door onto a wall is
/// worse than no door. The first start has not run yet here, which is the one
/// moment this state is real.
#[tokio::test]
async fn a_deployment_with_no_install_record_says_setup_is_done() {
    const TAG: &str = "setup_state_empty";
    let it = a_fresh_deployment(TAG).await;

    assert_eq!(
        it.credentials.setup_state().await.expect("the state reads"),
        SetupState::Done,
        "there is no install record and no operator, so the setup screen would have nothing to \
         offer and nothing to check a token against"
    );
}

/// **After a first start the state is `pending`, and it is `done` the moment
/// the first operator's credential is set.**
///
/// ADR-0056 decisions 1 and 2: while pending the client shows the setup flow
/// and nothing else, so this bit is what decides whether anybody sees a
/// sign-in page at all.
#[tokio::test]
async fn the_state_is_pending_after_a_first_start_and_done_once_the_credential_is_set() {
    const TAG: &str = "setup_state_bootstrap";
    let it = a_fresh_deployment(TAG).await;

    let address = unique("owner@example.org");
    let bootstrap = it
        .operators
        .bootstrap_first_operator(&address, &address)
        .await
        .expect("a first start with no operator mints one");

    assert_eq!(
        it.credentials.setup_state().await.expect("the state reads"),
        SetupState::Pending,
        "the first operator has an account and no credential, which is exactly the state the \
         setup flow exists for"
    );

    // Over the wire, unauthenticated, no session and no signature: the answer
    // is one length-prefixed word and nothing else.
    let addr = it.surface().await;
    let (status, body) = raw_request(addr, "GET", "/setup/state", &[], b"").await;
    assert_eq!(status, "200");
    assert_eq!(read_lp(&body), b"pending", "the wire says pending");

    it.credentials
        .redeem_setup(
            &it.operators,
            None,
            &support::recovery_code_text(&bootstrap.invitation.token),
            A_REAL_CREDENTIAL,
            "198.51.100.1",
        )
        .await
        .expect("the setup token sets the first operator's credential");

    assert_eq!(
        it.credentials.setup_state().await.expect("the state reads"),
        SetupState::Done,
        "the credential is set, so setup is finished — for ever, and for the deployment as a \
         whole"
    );
    // And the route says so at once: the act that flips the bit drops the
    // cache, or the browser that just did it would be sent back to step one
    // for another five seconds.
    let (status, body) = raw_request(addr, "GET", "/setup/state", &[], b"").await;
    assert_eq!(status, "200");
    assert_eq!(read_lp(&body), b"done", "the wire says done");
}

/// **The upgrade path is pending too, until the credential is set.**
///
/// ADR-0055 decision 2 as amended 2026-09-21 and ADR-0056's consequences: an
/// install from before the binding is adopted on the next start, and the
/// adopted operator walks the same guided path from the same screen. If the
/// state read only the native bootstrap, every upgraded deployment would be
/// shown a sign-in page for an account that has no credential to sign in with.
#[tokio::test]
async fn an_adopted_first_operator_is_pending_until_the_credential_is_set() {
    const TAG: &str = "setup_state_adopted";
    let it = a_fresh_deployment(TAG).await;

    let address = unique("owner@example.org");
    let bootstrap = it
        .operators
        .bootstrap_first_operator(&address, &address)
        .await
        .expect("a first start with no operator mints one");

    // The pre-ADR-0055 shape: the operator row and the install record stay,
    // the binding and the account go — `tests/operators.rs`'s own fixture for
    // the adoption, because that is the state a real upgrade starts from.
    let su = support::superuser_on_isolated(TAG).await;
    // The binding is append-only at every privilege level a trigger can reach
    // (`0019` §A), so removing one is a tier-3 move and the fixture makes it
    // one — `support::tamper` is the helper that says so out loud.
    let removed = support::tamper(
        &su,
        "operator_account_bindings",
        "DELETE FROM operator_account_bindings WHERE operator_id = $1",
        &[&bootstrap.operator_id],
    )
    .await;
    assert_eq!(removed, 1, "the fixture must actually remove the binding");
    su.execute(
        "DELETE FROM accounts WHERE id = $1",
        &[&bootstrap.account_id],
    )
    .await
    .expect("nor an account");
    su.execute(
        "DELETE FROM principals WHERE id = $1",
        &[&bootstrap.account_id],
    )
    .await
    .expect("nor its principal row");

    assert_eq!(
        it.credentials.setup_state().await.expect("the state reads"),
        SetupState::Done,
        "before the adoption runs there is no account at the install address, and the setup \
         screen has nothing to offer"
    );

    let adopted = it
        .operators
        .adopt_first_operator_from_install()
        .await
        .expect("the adoption runs")
        .adopted()
        .expect("an operator with no binding and an install record is adopted");
    let invitation = adopted
        .invitation
        .expect("an adopted operator with no app code gets a setup token");

    assert_eq!(
        it.credentials.setup_state().await.expect("the state reads"),
        SetupState::Pending,
        "the adopted operator now has an account at the install address and no credential"
    );

    it.credentials
        .redeem_setup(
            &it.operators,
            None,
            &support::recovery_code_text(&invitation.token),
            A_REAL_CREDENTIAL,
            "198.51.100.1",
        )
        .await
        .expect("the setup token sets the adopted operator's credential");

    assert_eq!(
        it.credentials.setup_state().await.expect("the state reads"),
        SetupState::Done
    );
}

/// **Concurrent first callers cause one query, not one query each.**
///
/// ADR-0056 decision 1 allows a five-second cache and rests the whole
/// no-rate-limit argument of the ADR-0056 build on it. The 2026-09-22 review
/// read the cache and found it was not single-flight: it was read, missed, and
/// then every caller that had missed went to the pool. The pool has eight
/// connections, the route is unauthenticated, and the answer arrives in
/// milliseconds — so a crowd arriving on a stale answer was a crowd of queries
/// and the cache bounded nothing at the moment it mattered.
///
/// **What is counted is the query and not the request.** `setup_state_queries`
/// exists for this: a statistics view PostgreSQL updates asynchronously would
/// make the test flaky rather than the claim true.
#[tokio::test]
async fn concurrent_first_callers_cause_one_setup_state_query() {
    const TAG: &str = "setup_state_single_flight";
    const CALLERS: usize = 16;
    let it = a_fresh_deployment(TAG).await;
    let deployment = it.deployment().await;

    let address = unique("owner@example.org");
    it.operators
        .bootstrap_first_operator(&address, &address)
        .await
        .expect("a first start with no operator mints one");

    // Nothing has asked yet, so every one of these is a miss.
    let before = credentials::setup_state_queries(&deployment);
    let mut callers = Vec::with_capacity(CALLERS);
    for _ in 0..CALLERS {
        let store = Arc::clone(&it.credentials);
        callers.push(tokio::spawn(async move {
            store.setup_state().await.expect("the state reads")
        }));
    }
    for caller in callers {
        assert_eq!(
            caller.await.expect("the task"),
            SetupState::Pending,
            "every caller gets the answer, whether it ran the query or waited for it"
        );
    }

    assert_eq!(
        credentials::setup_state_queries(&deployment) - before,
        1,
        "{CALLERS} callers arriving together on an empty cache ran more than one query. The \
         first through must do the work and the rest must wait for its answer, or an \
         unauthenticated caller chooses how many of this deployment's connections to take"
    );
}

/// **Concurrent callers arriving on an EXPIRED answer cause one query too.**
///
/// The single-flight test above drives the cold cache, which is the easy half:
/// nothing is remembered, and the gate is taken on the first read. The state a
/// running deployment is actually in is the other one — an answer that was
/// remembered five seconds ago and has just gone stale, with a crowd arriving
/// on it. If the gate only covered the cold path, every fifth second of a
/// deployment's life would be a crowd of queries.
#[tokio::test]
async fn concurrent_callers_on_a_stale_answer_cause_one_setup_state_query() {
    const TAG: &str = "setup_state_stale";
    const CALLERS: usize = 16;
    let it = a_fresh_deployment(TAG).await;
    let deployment = it.deployment().await;

    let address = unique("owner@example.org");
    it.operators
        .bootstrap_first_operator(&address, &address)
        .await
        .expect("a first start with no operator mints one");

    // Warm it, so what follows is an expiry and not a miss.
    it.credentials.setup_state().await.expect("the state reads");
    assert_eq!(
        it.credentials.setup_state().await.expect("the state reads"),
        SetupState::Pending,
        "the second call inside the window is answered from memory"
    );

    // Past the five seconds `credentials::SETUP_STATE_CACHE` allows. Real time,
    // because what expires is a `std::time::Instant` and no test clock moves
    // it.
    tokio::time::sleep(credentials::SETUP_STATE_CACHE + Duration::from_millis(250)).await;

    let before = credentials::setup_state_queries(&deployment);
    let mut callers = Vec::with_capacity(CALLERS);
    for _ in 0..CALLERS {
        let store = Arc::clone(&it.credentials);
        callers.push(tokio::spawn(async move {
            store.setup_state().await.expect("the state reads")
        }));
    }
    for caller in callers {
        assert_eq!(
            caller.await.expect("the task"),
            SetupState::Pending,
            "every caller gets the answer, whether it ran the query or waited for it"
        );
    }

    assert_eq!(
        credentials::setup_state_queries(&deployment) - before,
        1,
        "{CALLERS} callers arriving together on an EXPIRED answer ran more than one query. A \
         gate that only covers the cold cache leaves every window's turnover open"
    );
}

/// **An answer read before the bit moved is not remembered after it moved.**
///
/// The forget/put race, driven at the granularity it happens at. A reader
/// queries; the act that flips the bit commits and calls
/// `credentials::forget_setup_state` — which is exactly what
/// `CredentialStore::redeem_setup` does after its own commit; the reader then
/// stores what it read. Without a guard, the deployment that has just finished
/// setting up answers `pending` for another five seconds, and the browser that
/// finished it is sent back to step one.
///
/// **The pause is a real one and not a test hook**: an `ACCESS EXCLUSIVE` lock
/// on `accounts` held by another transaction blocks the reader's `SELECT`
/// exactly where the race needs it, and the forget lands while it is blocked.
/// What is waited for is the query COUNTER, which the store increments on the
/// line before the query, so the interleaving is observed rather than timed.
#[tokio::test]
async fn an_answer_read_before_the_bit_moved_is_not_remembered_after_it_moved() {
    const TAG: &str = "setup_state_race";
    let it = a_fresh_deployment(TAG).await;
    let deployment = it.deployment().await;

    let address = unique("owner@example.org");
    it.operators
        .bootstrap_first_operator(&address, &address)
        .await
        .expect("a first start with no operator mints one");

    let mut su = support::superuser_on_isolated(TAG).await;
    let blocker = su.transaction().await.expect("begin");
    blocker
        .batch_execute("LOCK TABLE accounts IN ACCESS EXCLUSIVE MODE")
        .await
        .expect("hold the table the state query reads");

    let before = credentials::setup_state_queries(&deployment);
    let store = Arc::clone(&it.credentials);
    let reader = tokio::spawn(async move { store.setup_state().await });

    // Wait until the reader has taken its generation and started its query. The
    // counter moves on the line before the query, so this is the moment the
    // race is about.
    let mut waited = Duration::ZERO;
    while credentials::setup_state_queries(&deployment) == before {
        tokio::time::sleep(Duration::from_millis(20)).await;
        waited += Duration::from_millis(20);
        assert!(
            waited < Duration::from_secs(20),
            "the reader never reached its query"
        );
    }
    tokio::time::sleep(Duration::from_millis(200)).await;

    // The bit moves and the committer forgets, while the reader is inside its
    // query.
    credentials::forget_setup_state(&deployment);

    // Let the reader finish and store what it read.
    drop(blocker);
    reader.await.expect("the task").expect("the state reads");

    let before = credentials::setup_state_queries(&deployment);
    it.credentials.setup_state().await.expect("the state reads");
    assert_eq!(
        credentials::setup_state_queries(&deployment) - before,
        1,
        "the racing answer was remembered anyway, so this deployment would answer with a \
         reading taken before the act that moved the bit — for the whole five seconds the \
         browser that did it is looking at the screen"
    );

    // And the cache still works, so what closed the race was the generation and
    // not a cache that stopped remembering anything.
    let before = credentials::setup_state_queries(&deployment);
    it.credentials.setup_state().await.expect("the state reads");
    assert_eq!(
        credentials::setup_state_queries(&deployment) - before,
        0,
        "an answer nothing raced must still be remembered"
    );
}

/// **`GET /setup/state` charges a budget of its own, and not the sign-in
/// one.**
///
/// The ADR-0056 build exempted the route altogether, which left one thing on
/// this server an unauthenticated caller could drive for nothing. The first fix
/// charged it against the SIGN-IN bucket, and that is what this test now
/// forbids: a page load is not a sign-in attempt, an office behind one address
/// reloads, and the route it would refuse is the one that tells a browser
/// whether this deployment has been set up at all.
///
/// Two claims in one, because they are one fact: the `setup-state:` bucket
/// moves, the plain source bucket does not.
#[tokio::test]
async fn the_state_route_charges_a_bucket_of_its_own_and_not_the_sign_in_one() {
    const TAG: &str = "setup_state_budget";
    let it = a_fresh_deployment(TAG).await;
    let addr = it.surface().await;
    let source = a_source_of_its_own();
    let su = support::superuser_on_isolated(TAG).await;
    let counted = |key: String| {
        let su = &su;
        async move {
            su.query_one(
                "SELECT COALESCE(SUM(attempts), 0)::bigint FROM sign_in_attempts \
                  WHERE bucket_kind = 'source' AND bucket_key = $1",
                &[&key],
            )
            .await
            .expect("read the bucket")
            .get::<_, i64>(0)
        }
    };
    let own = format!("setup-state:{source}");

    assert_eq!(counted(source.clone()).await, 0, "nothing spent yet");
    assert_eq!(counted(own.clone()).await, 0, "nor here");
    let (status, _) = raw_request(
        addr,
        "GET",
        "/setup/state",
        &[("x-forwarded-for", source.clone())],
        b"",
    )
    .await;
    assert_eq!(status, "200");
    assert_eq!(
        counted(own).await,
        1,
        "one unauthenticated read of the deployment's state must cost this source one unit of \
         the state route's own budget"
    );
    assert_eq!(
        counted(source).await,
        0,
        "and NONE of the sign-in budget. A browser reloading the page must not be able to \
         refuse its own office's sign-ins, and a 429 on this route must never be what takes \
         the first-run screen away"
    );
}

/// **A source that spends the state route's budget is answered 429 with
/// `Retry-After`, and its sign-in budget is untouched.**
///
/// The client's half of contract B2 depends on both: it waits the header out
/// (bounded) and asks again rather than falling back to the sign-in door, which
/// would be the wrong door for a deployment that has not been set up. And
/// whatever the state route costs, the person behind that address can still
/// sign in.
///
/// The bucket is seeded to its cap rather than driven to it: what is being
/// tested is the answer at the cap, and a hundred and twenty requests to reach
/// it would test the loop.
#[tokio::test]
async fn a_spent_state_budget_is_429_with_retry_after_and_costs_no_sign_in() {
    const TAG: &str = "setup_state_cap";
    let it = a_fresh_deployment(TAG).await;
    let addr = it.surface().await;
    let source = a_source_of_its_own();
    let su = support::superuser_on_isolated(TAG).await;

    // The current window, computed the way `sessions::window_start` computes
    // it: the floor of now over the fifteen-minute window.
    su.execute(
        "INSERT INTO sign_in_attempts (bucket_kind, bucket_key, window_start, attempts) \
         VALUES ('source', $1, to_timestamp(floor(extract(epoch from now()) / 900) * 900), $2)",
        &[
            &format!("setup-state:{source}"),
            &fathom_server::sessions::SETUP_STATE_MAX_PER_SOURCE,
        ],
    )
    .await
    .expect("seed this source's state budget to its cap");

    let (status, head, _) = raw_request_full(
        addr,
        "GET",
        "/setup/state",
        &[("x-forwarded-for", source.clone())],
        b"",
    )
    .await;
    assert_eq!(
        status, "429",
        "the request past the cap must be refused, or the cap is not one:\n{head}"
    );
    let lower = head.to_ascii_lowercase();
    assert!(
        lower.contains("retry-after:"),
        "a 429 with no Retry-After leaves the client guessing how long to wait, and a client \
         that guesses wrong shows the sign-in door on a deployment that is still \
         pending:\n{head}"
    );
    let seconds: i64 = lower
        .lines()
        .find_map(|line| line.trim().strip_prefix("retry-after:"))
        .and_then(|v| v.trim().parse().ok())
        .expect("Retry-After is a number of seconds");
    assert!(
        seconds > 0 && seconds <= 15 * 60,
        "Retry-After was {seconds} seconds, which is not this window"
    );

    let spent_on_sign_in: i64 = su
        .query_one(
            "SELECT COALESCE(SUM(attempts), 0)::bigint FROM sign_in_attempts \
              WHERE bucket_kind = 'source' AND bucket_key = $1",
            &[&source],
        )
        .await
        .expect("read the sign-in bucket")
        .get(0);
    assert_eq!(
        spent_on_sign_in, 0,
        "a source that has spent its page-load budget must still be able to sign in"
    );
}

/// **Every answer this surface builds says `Cache-Control: no-store`.**
///
/// The setup bit moves exactly once in a deployment's life. A browser or a
/// proxy holding `pending` after it has moved sends the person who just
/// finished setup back to step one of it, and the same header keeps a token's
/// answer out of a shared cache on the way.
#[tokio::test]
async fn the_state_route_says_no_store() {
    const TAG: &str = "setup_state_no_store";
    let it = a_fresh_deployment(TAG).await;
    let addr = it.surface().await;

    let (status, head, _) = raw_request_full(
        addr,
        "GET",
        "/setup/state",
        &[("x-forwarded-for", a_source_of_its_own())],
        b"",
    )
    .await;
    assert_eq!(status, "200");
    assert!(
        head.to_ascii_lowercase()
            .contains("cache-control: no-store"),
        "the answer carries no cache-control: no-store, so a proxy may keep it:\n{head}"
    );
}

// ---------------------------------------------------------------------------
// Decision 1 — the check route
// ---------------------------------------------------------------------------

/// **A live setup token names its address, and spends nothing.**
///
/// ADR-0056 decision 1, step 1: the person pastes the line from the token file
/// and the server says whose setup it opens, so the address is never typed. The
/// owner's ask — *"give an error if the email doesn't match"* — is met by
/// removing the field.
///
/// **The token is still live afterwards**, which is the half that makes this a
/// read: the screen that follows has to spend it.
#[tokio::test]
async fn the_check_names_the_address_and_leaves_the_token_live() {
    const TAG: &str = "setup_check_live";
    let it = a_fresh_deployment(TAG).await;

    let address = unique("owner@example.org");
    let bootstrap = it
        .operators
        .bootstrap_first_operator(&address, &address)
        .await
        .expect("a first start with no operator mints one");
    // What a real client now sends -- security review round 2, item 5: the
    // `op_` line, as typed text, not the 32 raw bytes a client-side decode
    // used to produce.
    let token = support::recovery_code_text(&bootstrap.invitation.token);

    let named = it
        .credentials
        .check_setup(&it.operators, None, &token, "198.51.100.1")
        .await
        .expect("a live setup token names the address it opens");
    assert_eq!(named, address);

    // Over the wire, with the framing the client speaks.
    let addr = it.surface().await;
    let (status, body) = raw_request(
        addr,
        "POST",
        "/enrolment/operator/setup/check",
        &[("x-forwarded-for", a_source_of_its_own())],
        &lp(&token),
    )
    .await;
    assert_eq!(status, "200");
    assert_eq!(read_lp(&body), address.as_bytes());

    // Nothing was spent and nothing was written: the redemption still works,
    // which it could not if the check had marked the row.
    it.credentials
        .redeem_setup(
            &it.operators,
            None,
            &token,
            A_REAL_CREDENTIAL,
            "198.51.100.1",
        )
        .await
        .expect("the check spent nothing, so the setup screen can still finish");
}

/// **The check writes no chain entry.**
///
/// A read that recorded itself would let an unauthenticated caller choose how
/// fast this deployment's sealed audit grows — `0014` §B and `0015` §F are
/// written against exactly that amplifier — and the route is reachable by
/// anybody who can reach the page.
#[tokio::test]
async fn the_check_writes_nothing_to_the_chain() {
    const TAG: &str = "setup_check_silent";
    let it = a_fresh_deployment(TAG).await;

    let address = unique("owner@example.org");
    let bootstrap = it
        .operators
        .bootstrap_first_operator(&address, &address)
        .await
        .expect("a first start with no operator mints one");
    let su = support::superuser_on_isolated(TAG).await;
    let entries = || async {
        su.query_one("SELECT count(*) FROM chain_entries", &[])
            .await
            .expect("count entries")
            .get::<_, i64>(0)
    };

    let token = support::recovery_code_text(&bootstrap.invitation.token);
    let before = entries().await;
    for _ in 0..5 {
        let _ = it
            .credentials
            .check_setup(&it.operators, None, &token, "198.51.100.1")
            .await;
        let _ = it
            .credentials
            .check_setup(&it.operators, None, b"not a token", "198.51.100.1")
            .await;
    }
    assert_eq!(
        entries().await,
        before,
        "ten checks — five good, five rubbish — left the chain exactly as it was"
    );
}

/// **Wrong, spent, expired and garbage are one answer, byte for byte.**
///
/// The same anti-enumeration rule ADR-0055 decision 7 states for the credential
/// routes: a caller must not be able to tell which of the causes refused them.
/// One sentence, one status, the same headers.
///
/// **A token of ANOTHER PURPOSE is the one case not driven here**: minting an
/// account invitation needs a console session, so it is driven where one
/// already exists — `tests/operators.rs`,
/// `a_token_of_another_purpose_does_not_open_the_setup_check`. It arrives at
/// the same `CredentialError::TokenRefused` this test pins the bytes of, and
/// the `operator` purpose cannot be minted at all in this build.
///
/// **The expired case is produced by moving the expiry in the database**, the
/// way `tests/operators.rs`'s own expiry fixture does, because a real token
/// lives for seventy-two hours. That move also breaks the row seal — the seal
/// covers `expires_at` — so what this asserts of that case is precisely what
/// the route promises: whichever check refuses, the caller gets the same bytes.
#[tokio::test]
async fn every_refused_setup_token_gets_the_same_bytes() {
    const TAG: &str = "setup_check_refusals";
    let it = a_fresh_deployment(TAG).await;

    let address = unique("owner@example.org");
    let bootstrap = it
        .operators
        .bootstrap_first_operator(&address, &address)
        .await
        .expect("a first start with no operator mints one");
    let addr = it.surface().await;
    let su = support::superuser_on_isolated(TAG).await;

    // A token that was never issued, one made of nothing, and one whose bytes
    // are not a token's length at all. "Never issued" is the `op_` + hex
    // SHAPE a real recovery code has -- security review round 2, item 5 --
    // so this still exercises the database lookup that finds nothing, not
    // just `parse_recovery_code`'s own shape check.
    let mut answers = Vec::new();
    for (what, token) in [
        ("never issued", support::recovery_code_text(&[9u8; 32])),
        ("empty", Vec::new()),
        ("not token-shaped", b"op_paste-the-whole-line".to_vec()),
    ] {
        answers.push((what.to_string(), check_over_the_wire(addr, &token).await));
    }

    // A spent one: the setup finishes, and the file on the volume is now a
    // dead letter. This is the case a person actually hits.
    let bootstrap_text = support::recovery_code_text(&bootstrap.invitation.token);
    it.credentials
        .redeem_setup(
            &it.operators,
            None,
            &bootstrap_text,
            A_REAL_CREDENTIAL,
            "198.51.100.1",
        )
        .await
        .expect("the setup token sets the credential");
    answers.push((
        "spent".to_string(),
        check_over_the_wire(addr, &bootstrap_text).await,
    ));

    // An expired one: a second token — ADR-0055 decision 8's break-glass code,
    // which is the other way a live `setup` token comes to exist — aged past
    // its life in the database.
    let reissued = it
        .operators
        .recover_operator(&address)
        .await
        .expect("the host can mint a replacement setup code for a bound operator");
    su.execute(
        "UPDATE enrolment_tokens \
            SET issued_at = now() - interval '96 hours', \
                expires_at = now() - interval '1 second' \
          WHERE id = $1",
        &[&reissued.invitation.id],
    )
    .await
    .expect("move the expiry");
    answers.push((
        "expired".to_string(),
        check_over_the_wire(
            addr,
            &support::recovery_code_text(&reissued.invitation.token),
        )
        .await,
    ));

    let (_, first) = answers.first().expect("five of them").clone();
    for (what, answer) in &answers {
        assert_eq!(
            answer, &first,
            "the {what} token was answered differently. Wrong, spent, expired and malformed are \
             one fact from outside, and a caller who can tell them apart can map this \
             deployment's tokens"
        );
    }
    assert_eq!(first.0, "401", "and that one answer is a 401");
    assert_eq!(
        String::from_utf8_lossy(&first.2),
        format!("{}\n", credentials::SETUP_SECRET_REFUSED),
        "ADR-0057 decision 1's one sentence for every refused setup secret, whichever of \
         wrong, spent, expired or malformed caused it"
    );

    // The typed refusal underneath is the one every token path gives.
    let refused = it
        .credentials
        .check_setup(&it.operators, None, b"rubbish", "198.51.100.1")
        .await;
    assert!(
        matches!(refused, Err(CredentialError::TokenRefused)),
        "got {refused:?}"
    );
}

// ---------------------------------------------------------------------------
// ADR-0057 decision 1 — the setup password, in place of the token file
// ---------------------------------------------------------------------------

/// A real setup password, of the shape a person would actually put in
/// `.env`: past the fifteen-character floor, not on the bundled common list.
const A_REAL_SETUP_PASSWORD: &str = "meadow-compass-ferry-eleven";

/// **The right password, inside the window, answers the address and spends
/// once.**
///
/// ADR-0057 decision 1: a match hands the in-memory token to the same check
/// and spend path a recovery code already uses, so the check names the
/// address without spending, and the redemption spends it — once.
#[tokio::test]
async fn the_right_setup_password_inside_the_window_checks_and_spends_once() {
    const TAG: &str = "setup_password_right";
    let it = a_fresh_deployment(TAG).await;

    let address = unique("owner@example.org");
    let bootstrap = it
        .operators
        .bootstrap_first_operator(&address, &address)
        .await
        .expect("a first start with no operator mints one");
    let invitation = it
        .operators
        .issue_setup_token(&bootstrap.operator_id)
        .await
        .expect("main.rs mints a fresh setup token at every start");
    let secret = SetupSecret::new(
        A_REAL_SETUP_PASSWORD,
        invitation.token,
        Instant::now() + Duration::from_secs(3600),
    );

    // A read: the address, and nothing spent.
    let named = it
        .credentials
        .check_setup(
            &it.operators,
            Some(&secret),
            A_REAL_SETUP_PASSWORD.as_bytes(),
            "198.51.100.1",
        )
        .await
        .expect("the right password inside the window names the address");
    assert_eq!(named, address);

    // Over the wire, exactly the field a browser sends: what was typed,
    // unmodified.
    let addr = it.surface_with_setup_secret(Some(secret.clone())).await;
    let (status, body) = raw_request(
        addr,
        "POST",
        "/enrolment/operator/setup/check",
        &[("x-forwarded-for", a_source_of_its_own())],
        &lp(A_REAL_SETUP_PASSWORD.as_bytes()),
    )
    .await;
    assert_eq!(status, "200");
    assert_eq!(read_lp(&body), address.as_bytes());

    // The redemption spends the in-memory token, once.
    it.credentials
        .redeem_setup(
            &it.operators,
            Some(&secret),
            A_REAL_SETUP_PASSWORD.as_bytes(),
            A_REAL_CREDENTIAL,
            "198.51.100.1",
        )
        .await
        .expect("the right password inside the window sets the credential");

    let again = it
        .credentials
        .redeem_setup(
            &it.operators,
            Some(&secret),
            A_REAL_SETUP_PASSWORD.as_bytes(),
            "some-other-real-password-9",
            "198.51.100.1",
        )
        .await;
    assert!(
        matches!(again, Err(CredentialError::TokenRefused)),
        "the in-memory token is single use, exactly as a token file's was: {again:?}"
    );
}

/// **A wrong password is refused exactly like a bad token**: the same status,
/// the same sentence, and no session.
#[tokio::test]
async fn a_wrong_setup_password_is_refused_like_a_bad_token() {
    const TAG: &str = "setup_password_wrong";
    let it = a_fresh_deployment(TAG).await;

    let address = unique("owner@example.org");
    let bootstrap = it
        .operators
        .bootstrap_first_operator(&address, &address)
        .await
        .expect("a first start with no operator mints one");
    let invitation = it
        .operators
        .issue_setup_token(&bootstrap.operator_id)
        .await
        .expect("a fresh setup token");
    let secret = SetupSecret::new(
        A_REAL_SETUP_PASSWORD,
        invitation.token,
        Instant::now() + Duration::from_secs(3600),
    );

    let refused = it
        .credentials
        .check_setup(
            &it.operators,
            Some(&secret),
            b"not-the-right-password-at-all",
            "198.51.100.1",
        )
        .await;
    assert!(
        matches!(refused, Err(CredentialError::TokenRefused)),
        "got {refused:?}"
    );

    let addr = it.surface_with_setup_secret(Some(secret)).await;
    let (status, _headers, body) =
        check_over_the_wire(addr, b"not-the-right-password-at-all").await;
    assert_eq!(status, "401");
    assert_eq!(
        String::from_utf8_lossy(&body),
        format!("{}\n", credentials::SETUP_SECRET_REFUSED)
    );
}

/// **After the window closes, the right password is refused too** — decision
/// 1's *"Open for 30 minutes after the server starts. After that, setup is
/// closed until a restart."* Driven with the window itself, not with a sleep:
/// `SetupSecret::token_for`'s own unit tests in `credentials.rs` pin the exact
/// second; this is the same claim over the wire.
#[tokio::test]
async fn the_setup_password_is_refused_once_its_window_has_closed() {
    const TAG: &str = "setup_password_window";
    let it = a_fresh_deployment(TAG).await;

    let address = unique("owner@example.org");
    let bootstrap = it
        .operators
        .bootstrap_first_operator(&address, &address)
        .await
        .expect("a first start with no operator mints one");
    let invitation = it
        .operators
        .issue_setup_token(&bootstrap.operator_id)
        .await
        .expect("a fresh setup token");
    // A window that closed before this test started: every real `Instant::now()`
    // this call could observe is already past it.
    let secret = SetupSecret::new(
        A_REAL_SETUP_PASSWORD,
        invitation.token,
        Instant::now() - Duration::from_secs(1),
    );

    let refused = it
        .credentials
        .check_setup(
            &it.operators,
            Some(&secret),
            A_REAL_SETUP_PASSWORD.as_bytes(),
            "198.51.100.1",
        )
        .await;
    assert!(
        matches!(refused, Err(CredentialError::TokenRefused)),
        "the window closed, so the right password is refused too: {refused:?}"
    );
}

/// **Setup is closed with no live password at all**: `main.rs` never builds a
/// [`SetupSecret`] when `FATHOM_SETUP_PASSWORD` is unset, too short, or on the
/// bundled common list, so the field's only working shape left is a recovery
/// code.
#[tokio::test]
async fn with_no_setup_secret_a_password_shaped_field_is_refused() {
    const TAG: &str = "setup_password_closed";
    let it = a_fresh_deployment(TAG).await;

    let address = unique("owner@example.org");
    it.operators
        .bootstrap_first_operator(&address, &address)
        .await
        .expect("a first start with no operator mints one");

    // `main.rs` passes `None` for every one of these: unset, too short (under
    // `PASSWORD_MIN`), and a bundled common password — the same policy
    // `credentials::check_password` enforces for a person's own password.
    for candidate in [A_REAL_SETUP_PASSWORD, "short", "aaaaaaaaaaaaaaaaaaaaaaaaaa"] {
        let refused = it
            .credentials
            .check_setup(&it.operators, None, candidate.as_bytes(), "198.51.100.1")
            .await;
        assert!(
            matches!(refused, Err(CredentialError::TokenRefused)),
            "with no setup secret configured, {candidate:?} must be refused: {refused:?}"
        );
    }
}

/// **A recovery code still works, unchanged, with a setup password live
/// beside it.** ADR-0057 decision 1: *"If it has the recovery-code shape ...
/// handle it exactly as today."* The two paths do not interfere.
#[tokio::test]
async fn a_recovery_code_still_works_with_a_setup_password_live() {
    const TAG: &str = "setup_password_recovery_still_works";
    let it = a_fresh_deployment(TAG).await;

    let address = unique("owner@example.org");
    let bootstrap = it
        .operators
        .bootstrap_first_operator(&address, &address)
        .await
        .expect("a first start with no operator mints one");

    // The in-memory setup secret this start would carry, exactly as main.rs
    // builds one.
    let this_starts_token = it
        .operators
        .issue_setup_token(&bootstrap.operator_id)
        .await
        .expect("main.rs mints one at every start");
    let secret = SetupSecret::new(
        A_REAL_SETUP_PASSWORD,
        this_starts_token.token,
        Instant::now() + Duration::from_secs(3600),
    );

    // Break-glass, from the host, beside it — ADR-0055 decision 8's
    // `fathom-server recover-operator`, minted independently.
    let reissued = it
        .operators
        .recover_operator(&address)
        .await
        .expect("the host can mint a recovery code for a bound operator");
    let reissued_text = support::recovery_code_text(&reissued.invitation.token);

    let named = it
        .credentials
        .check_setup(&it.operators, Some(&secret), &reissued_text, "198.51.100.1")
        .await
        .expect("the recovery code still opens the check, password or no password");
    assert_eq!(named, address);

    it.credentials
        .redeem_setup(
            &it.operators,
            Some(&secret),
            &reissued_text,
            A_REAL_CREDENTIAL,
            "198.51.100.1",
        )
        .await
        .expect("the recovery code still redeems");

    // And the setup password's own token is now refused too — not because the
    // recovery redemption above "spent" it (it is a different row), but
    // because `recover_operator` expires every OTHER live `purpose = 'setup'`
    // token for this operator as part of running at all (ADR-0055 decision
    // 8's own rule, kept unchanged). A live setup-password window a
    // `recover-operator` run happens to cross does not survive it, the same
    // as it would not survive a second restart minting a fresh one.
    let after = it
        .credentials
        .check_setup(
            &it.operators,
            Some(&secret),
            A_REAL_SETUP_PASSWORD.as_bytes(),
            "198.51.100.1",
        )
        .await;
    assert!(
        matches!(after, Err(CredentialError::TokenRefused)),
        "recover_operator expires every other live setup token for this operator, so the \
         setup password's own token no longer resolves: {after:?}"
    );
}

// ---------------------------------------------------------------------------
// The security review's two probes, as regression tests
// ---------------------------------------------------------------------------

/// **Two live setup-password tokens for one seat cannot both act.**
///
/// The blocking finding: two interchangeable containers, each minting its own
/// `purpose = 'setup'` token at start, both matched the same
/// `FATHOM_SETUP_PASSWORD`. Finishing setup through the first must leave the
/// second refused, not merely spent-and-then-refused-later — the guard is
/// `AND password_hash IS NULL` on the write itself, so a second live token
/// that is still, on its own terms, unredeemed cannot overwrite the password
/// the first one just set. `redeem_setup_by_token`'s own sweep — spending any
/// setup-class token expires every other live one for the operator — would
/// already refuse the second attempt on its own; this test's real claim is
/// about the account row, so it reads the stored hash directly rather than
/// trusting a refusal alone to mean nothing changed.
#[tokio::test]
async fn a_second_live_setup_token_cannot_overwrite_a_finished_setup() {
    const TAG: &str = "setup_password_two_containers";
    let it = a_fresh_deployment(TAG).await;
    let address = unique("owner@example.org");
    let bootstrap = it
        .operators
        .bootstrap_first_operator(&address, &address)
        .await
        .expect("a first start with no operator mints one");
    let forever = Instant::now() + Duration::from_secs(3600);
    let t_a = it
        .operators
        .issue_setup_token(&bootstrap.operator_id)
        .await
        .expect("container A mints its own token at start");
    let t_b = it
        .operators
        .issue_setup_token(&bootstrap.operator_id)
        .await
        .expect("container B mints its own token at start");
    let a = SetupSecret::new(A_REAL_SETUP_PASSWORD, t_a.token, forever);
    let b = SetupSecret::new(A_REAL_SETUP_PASSWORD, t_b.token, forever);

    it.credentials
        .redeem_setup(
            &it.operators,
            Some(&a),
            A_REAL_SETUP_PASSWORD.as_bytes(),
            A_REAL_CREDENTIAL,
            "198.51.100.1",
        )
        .await
        .expect("the installer finishes through container A");

    let attacker = "attacker-chosen-passphrase-q7";
    let through_b = it
        .credentials
        .redeem_setup(
            &it.operators,
            Some(&b),
            A_REAL_SETUP_PASSWORD.as_bytes(),
            attacker,
            "198.51.100.1",
        )
        .await;
    assert!(
        matches!(through_b, Err(CredentialError::TokenRefused)),
        "container B must be refused once setup is finished: {through_b:?}"
    );

    let su = support::superuser_on_isolated(TAG).await;
    let stored_hash: Option<String> = su
        .query_one(
            "SELECT password_hash FROM accounts WHERE email = $1",
            &[&address],
        )
        .await
        .expect("read the account")
        .get(0);
    let stored_hash = stored_hash.expect("a password is stored");
    assert!(
        credentials::verify_password(&stored_hash, A_REAL_CREDENTIAL),
        "the installer's own password must still be the one that verifies"
    );
    assert!(
        !credentials::verify_password(&stored_hash, attacker),
        "container B's password must never have been written"
    );

    // And the check route, reached through B, must not name the address
    // either — decision 1's guard covers the read as well as the write.
    let checked_through_b = it
        .credentials
        .check_setup(
            &it.operators,
            Some(&b),
            A_REAL_SETUP_PASSWORD.as_bytes(),
            "198.51.100.1",
        )
        .await;
    assert!(
        matches!(checked_through_b, Err(CredentialError::TokenRefused)),
        "the check route must refuse too, once setup is finished: {checked_through_b:?}"
    );
}

/// **A recovery code minted before a restart cannot be beaten to the account
/// row by that restart's own setup password.**
///
/// The second probe: `fathom-server recover-operator` mints a code, the
/// server restarts and mints its own `purpose = 'setup'` token (T) for
/// `FATHOM_SETUP_PASSWORD`, and the installer redeems the recovery code
/// first. T must not still be able to set a different password afterwards.
#[tokio::test]
async fn a_setup_password_cannot_overwrite_a_setup_finished_by_a_recovery_code() {
    const TAG: &str = "setup_password_recovery_first";
    let it = a_fresh_deployment(TAG).await;
    let address = unique("owner@example.org");
    let bootstrap = it
        .operators
        .bootstrap_first_operator(&address, &address)
        .await
        .expect("a first start with no operator mints one");

    // The recovery code, minted first.
    let reissued = it
        .operators
        .recover_operator(&address)
        .await
        .expect("the host can mint a recovery code for a bound operator");
    // The restart: main.rs mints this start's own token.
    let t = it
        .operators
        .issue_setup_token(&bootstrap.operator_id)
        .await
        .expect("main.rs mints one at every start");
    let secret = SetupSecret::new(
        A_REAL_SETUP_PASSWORD,
        t.token,
        Instant::now() + Duration::from_secs(3600),
    );

    it.credentials
        .redeem_setup(
            &it.operators,
            Some(&secret),
            &support::recovery_code_text(&reissued.invitation.token),
            A_REAL_CREDENTIAL,
            "198.51.100.1",
        )
        .await
        .expect("the installer uses the recovery code first");

    let attacker = "attacker-chosen-passphrase-q7";
    let through_t = it
        .credentials
        .redeem_setup(
            &it.operators,
            Some(&secret),
            A_REAL_SETUP_PASSWORD.as_bytes(),
            attacker,
            "198.51.100.1",
        )
        .await;
    assert!(
        matches!(through_t, Err(CredentialError::TokenRefused)),
        "T must be refused once the recovery code has finished setup: {through_t:?}"
    );

    let su = support::superuser_on_isolated(TAG).await;
    let stored_hash: Option<String> = su
        .query_one(
            "SELECT password_hash FROM accounts WHERE email = $1",
            &[&address],
        )
        .await
        .expect("read the account")
        .get(0);
    let stored_hash = stored_hash.expect("a password is stored");
    assert!(
        credentials::verify_password(&stored_hash, A_REAL_CREDENTIAL),
        "the recovery code's own password must still be the one that verifies"
    );
    assert!(
        !credentials::verify_password(&stored_hash, attacker),
        "the setup password must never have overwritten it"
    );
}

/// **The brute-force limit — security review item 4.** Twenty refused setup
/// secrets close the setup password comparison for the rest of this
/// process; a recovery code, which is 256 bits and not a realistic guessing
/// target, is untouched by it.
#[tokio::test]
async fn twenty_refused_setup_secrets_close_the_password_but_not_a_recovery_code() {
    const TAG: &str = "setup_password_brute_force_limit";
    let it = a_fresh_deployment(TAG).await;
    let address = unique("owner@example.org");
    let bootstrap = it
        .operators
        .bootstrap_first_operator(&address, &address)
        .await
        .expect("a first start with no operator mints one");
    let t = it
        .operators
        .issue_setup_token(&bootstrap.operator_id)
        .await
        .expect("main.rs mints one at every start");
    let secret = SetupSecret::new(
        A_REAL_SETUP_PASSWORD,
        t.token,
        Instant::now() + Duration::from_secs(3600),
    );

    for attempt in 0..20 {
        let refused = it
            .credentials
            .check_setup(
                &it.operators,
                Some(&secret),
                b"not-the-right-password-at-all",
                "198.51.100.1",
            )
            .await;
        assert!(
            matches!(refused, Err(CredentialError::TokenRefused)),
            "attempt {attempt}: {refused:?}"
        );
    }

    // The right password, tried for the very first time only after the
    // limit, is refused too: the comparison itself has stopped running, not
    // merely stopped matching this one wrong guess.
    let after_limit = it
        .credentials
        .check_setup(
            &it.operators,
            Some(&secret),
            A_REAL_SETUP_PASSWORD.as_bytes(),
            "198.51.100.1",
        )
        .await;
    assert!(
        matches!(after_limit, Err(CredentialError::TokenRefused)),
        "the setup password must be closed once the limit is reached: {after_limit:?}"
    );

    // A recovery code, minted independently after the limit was reached,
    // still works: the limit closes only the guessable half of setup.
    let reissued = it
        .operators
        .recover_operator(&address)
        .await
        .expect("the host can still mint a recovery code once the limit is reached");
    let named = it
        .credentials
        .check_setup(
            &it.operators,
            Some(&secret),
            &support::recovery_code_text(&reissued.invitation.token),
            "198.51.100.1",
        )
        .await
        .expect("a recovery code must still open the check after the limit is reached");
    assert_eq!(named, address);
}

/// **A matched setup password refunds its budget unit.** ADR-0057 follow-up:
/// the client checks a new password's length and that it matches its
/// confirmation, but not the server's policy, so a policy refusal on a
/// well-known password can repeat past the twenty-attempt limit before it
/// would ever trip a wrong setup password. Each attempt here proves the
/// setup password, so none of them may cost the budget the wrong-password
/// limit protects.
#[tokio::test]
async fn a_password_the_policy_refuses_does_not_spend_the_setup_secret_budget() {
    const TAG: &str = "setup_password_refund_on_match";
    let it = a_fresh_deployment(TAG).await;
    let address = unique("owner@example.org");
    let bootstrap = it
        .operators
        .bootstrap_first_operator(&address, &address)
        .await
        .expect("a first start with no operator mints one");
    let invitation = it
        .operators
        .issue_setup_token(&bootstrap.operator_id)
        .await
        .expect("main.rs mints a fresh setup token at every start");
    let secret = SetupSecret::new(
        A_REAL_SETUP_PASSWORD,
        invitation.token,
        Instant::now() + Duration::from_secs(3600),
    );

    for attempt in 0..25 {
        let refused = it
            .credentials
            .redeem_setup(
                &it.operators,
                Some(&secret),
                A_REAL_SETUP_PASSWORD.as_bytes(),
                "passwordpassword",
                "198.51.100.1",
            )
            .await;
        assert!(
            matches!(refused, Err(CredentialError::PasswordIsCommon)),
            "attempt {attempt}: a right setup password with a common new one must refuse on \
             the password, not on a spent budget: {refused:?}"
        );
    }

    it.credentials
        .redeem_setup(
            &it.operators,
            Some(&secret),
            A_REAL_SETUP_PASSWORD.as_bytes(),
            A_REAL_CREDENTIAL,
            "198.51.100.1",
        )
        .await
        .expect("a good new password still succeeds after 25 policy-refused attempts");
}

/// **A redemption and `recover-operator` do not deadlock.** ADR-0057
/// decision 1's fix round: both now take the site chain's advisory lock
/// before locking the token rows they might expire, so racing on the same
/// operator's tokens serialises instead of deadlocking (PostgreSQL 40P01).
///
/// Ten deployments, each racing its own redemption against its own recovery
/// on real threads, with a swept head start so at least one pair's
/// interleaving lands where both hold one lock and want the other — the
/// shape that reproduced 40P01 on the pre-fix code.
#[tokio::test(flavor = "multi_thread", worker_threads = 8)]
async fn a_redemption_and_a_recovery_do_not_deadlock() {
    const LETTERS: [&str; 10] = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"];
    let mut pairs = Vec::with_capacity(LETTERS.len());
    for (offset, letter) in LETTERS.into_iter().enumerate() {
        let tag = format!("lockorder_{letter}");
        let it = a_fresh_deployment(&tag).await;
        let address = unique("owner@example.org");
        let bootstrap = it
            .operators
            .bootstrap_first_operator(&address, &address)
            .await
            .expect("a first start with no operator mints one");
        let invitation = it
            .operators
            .issue_setup_token(&bootstrap.operator_id)
            .await
            .expect("main.rs mints a fresh setup token at every start");
        let secret = SetupSecret::new(
            A_REAL_SETUP_PASSWORD,
            invitation.token,
            Instant::now() + Duration::from_secs(3600),
        );

        let recovering_operators = Arc::clone(&it.operators);
        let recovery_address = address.clone();
        let recovery = tokio::spawn(async move {
            recovering_operators
                .recover_operator(&recovery_address)
                .await
        });
        // A different head start per pair: the two transactions' step counts
        // differ, so no single delay reliably lands inside the window where
        // both hold one lock and want the other. Sweeping it widens the odds
        // of catching that window in this run.
        tokio::time::sleep(std::time::Duration::from_micros(200 * offset as u64)).await;
        let credentials = Arc::clone(&it.credentials);
        let redeeming_operators = Arc::clone(&it.operators);
        let redemption = tokio::spawn(async move {
            credentials
                .redeem_setup(
                    &redeeming_operators,
                    Some(&secret),
                    A_REAL_SETUP_PASSWORD.as_bytes(),
                    A_REAL_CREDENTIAL,
                    "198.51.100.1",
                )
                .await
        });
        pairs.push((letter, redemption, recovery));
    }

    for (letter, redemption, recovery) in pairs {
        let (redeemed, recovered) = tokio::join!(redemption, recovery);
        let redeemed = redeemed.expect("the redemption task does not panic");
        let recovered = recovered.expect("the recovery task does not panic");

        assert!(
            !is_deadlock_credential(&redeemed),
            "{letter}: the redemption deadlocked against the recovery: {redeemed:?}"
        );
        let recovery_err = recovered.as_ref().err();
        assert!(
            !is_deadlock_operator(&recovered),
            "{letter}: the recovery deadlocked against the redemption: {recovery_err:?}"
        );
    }
}

fn is_deadlock_credential(result: &Result<(), CredentialError>) -> bool {
    matches!(
        result,
        Err(CredentialError::Db(e))
            if e.code() == Some(&tokio_postgres::error::SqlState::T_R_DEADLOCK_DETECTED)
    )
}

fn is_deadlock_operator<T>(result: &Result<T, OperatorError>) -> bool {
    matches!(
        result,
        Err(OperatorError::Db(e))
            if e.code() == Some(&tokio_postgres::error::SqlState::T_R_DEADLOCK_DETECTED)
    )
}

// ---------------------------------------------------------------------------
// The security review's round-2 probes, as regression tests
// ---------------------------------------------------------------------------

/// A hand-rolled `join_all`: every future in `futs` is polled once, in
/// order, on each pass, so every one of them runs up to its own first real
/// `await` before any of them completes.
///
/// **Why this and not `futures::future::join_all`.** The property item A's
/// test below relies on is not merely "these run concurrently" but the exact
/// ORDER their synchronous prefixes run in: [`reserve_setup_secret_attempt`]
/// (`credentials.rs`) is a plain `std::sync::Mutex`, never an `await`, so on
/// the very first poll of each of these futures the reservation for that
/// attempt happens deterministically before any of them reaches a real
/// `await` (the connection pool). Polling index 0 first, then 1, then 2, and
/// so on, on the very first pass, is what makes the reservation order match
/// the array order — which is what turns "sixty concurrent attempts" into a
/// test with a knowable answer rather than a flake.
async fn poll_concurrently<F: std::future::Future>(futs: Vec<F>) -> Vec<F::Output> {
    use std::task::Poll;
    let mut futs: Vec<std::pin::Pin<Box<F>>> = futs.into_iter().map(Box::pin).collect();
    let mut out: Vec<Option<F::Output>> = (0..futs.len()).map(|_| None).collect();
    std::future::poll_fn(|cx| {
        let mut all_ready = true;
        for (i, f) in futs.iter_mut().enumerate() {
            if out[i].is_none() {
                match f.as_mut().poll(cx) {
                    Poll::Ready(v) => out[i] = Some(v),
                    Poll::Pending => all_ready = false,
                }
            }
        }
        if all_ready {
            Poll::Ready(())
        } else {
            Poll::Pending
        }
    })
    .await;
    out.into_iter()
        .map(|o| o.expect("polled to completion"))
        .collect()
}

/// **Security review, round 2, item A: the refusal limit cannot be beaten by
/// concurrency.**
///
/// Verified by the review with sixty concurrent checks against one setup
/// password, fifty-nine wrong and the right one last: every one of the
/// sixty got a live comparison, including the right password, because the
/// budget was read, then compared, then spent, as three separate steps —
/// sixty callers could each read "budget remains" before any of them had
/// finished comparing anything. The fix makes the read and the spend one
/// atomic step (`credentials::reserve_setup_secret_attempt`), so a burst
/// this size can reserve at most twenty attempts between it, however they
/// race.
///
/// This test reproduces the review's exact shape and, thanks to
/// [`poll_concurrently`]'s deterministic first-pass ordering, has a
/// deterministic answer: the twenty wrong guesses at indices 0 through 19
/// take every reservation there is, so the right password — index 59, last
/// in the burst — never gets a comparison at all and is refused along with
/// everything after index 19. Before the fix this exact password, in this
/// exact position, came back `Ok`.
#[tokio::test]
async fn a_burst_of_sixty_cannot_reserve_more_attempts_than_the_limit() {
    const TAG: &str = "setup_password_burst";
    let it = a_fresh_deployment(TAG).await;
    let address = unique("owner@example.org");
    let bootstrap = it
        .operators
        .bootstrap_first_operator(&address, &address)
        .await
        .expect("a first start with no operator mints one");
    let invitation = it
        .operators
        .issue_setup_token(&bootstrap.operator_id)
        .await
        .expect("main.rs mints one at every start");
    let secret = SetupSecret::new(
        A_REAL_SETUP_PASSWORD,
        invitation.token,
        Instant::now() + Duration::from_secs(3600),
    );

    let wrong: Vec<String> = (0..59)
        .map(|i| format!("wrong-guess-number-{i:03}-xyz"))
        .collect();
    let mut candidates: Vec<&[u8]> = wrong.iter().map(|w| w.as_bytes()).collect();
    candidates.push(A_REAL_SETUP_PASSWORD.as_bytes());
    assert_eq!(candidates.len(), 60, "fifty-nine wrong, the right one last");

    let source = "203.0.113.9";
    let futs: Vec<_> = candidates
        .iter()
        .map(|c| {
            it.credentials
                .check_setup(&it.operators, Some(&secret), c, source)
        })
        .collect();
    let results = poll_concurrently(futs).await;

    let right_answer = results.last().expect("sixty results");
    assert!(
        matches!(right_answer, Err(CredentialError::TokenRefused)),
        "the right password, last in a sixty-wide burst, must be refused once twenty attempts \
         ahead of it have already spent the budget: got {right_answer:?}"
    );
    assert!(
        results
            .iter()
            .all(|r| matches!(r, Err(CredentialError::TokenRefused))),
        "every one of the sixty must be refused -- fifty-nine for being wrong and the sixtieth \
         for arriving with no budget left: {results:?}"
    );

    // And with the budget spent, the SAME right password, tried again on its
    // own with nothing racing it, is refused too -- the comparison itself
    // has stopped running, not merely lost the race that one time.
    let after = it
        .credentials
        .check_setup(
            &it.operators,
            Some(&secret),
            A_REAL_SETUP_PASSWORD.as_bytes(),
            source,
        )
        .await;
    assert!(
        matches!(after, Err(CredentialError::TokenRefused)),
        "the limit must stay closed after the burst, not just during it: {after:?}"
    );
}

/// **Security review, round 2, item B: a redemption racing a concurrent
/// sweep does not corrupt the token it loses to.**
///
/// The cause: spending any setup-class token now expires the operator's
/// every other live one (`operators::expire_live_tokens`, ADR-0057 decision
/// 1's fix round). Redeeming the setup password's own token T and redeeming
/// a recovery code R, minted before it, at the same moment, makes each
/// redemption the other's concurrent expirer: T's redemption tries to expire
/// R as "every other live token" while R's redemption is itself in flight,
/// and the reverse. Verified by the review 3 of 3 with `tokio::join!`.
///
/// Exactly one of the two may win. Whichever does not must be refused
/// cleanly — not corrupt the row it raced, and not leave the account with a
/// password that verifies as neither of the two candidates.
#[tokio::test]
async fn a_setup_password_and_a_recovery_code_redeemed_at_once_cannot_corrupt_either_token() {
    const TAG: &str = "setup_password_redemption_race";
    let it = a_fresh_deployment(TAG).await;
    let address = unique("owner@example.org");
    let bootstrap = it
        .operators
        .bootstrap_first_operator(&address, &address)
        .await
        .expect("a first start with no operator mints one");

    // R, minted first -- "a recovery code minted before a restart."
    let reissued = it
        .operators
        .recover_operator(&address)
        .await
        .expect("the host can mint a recovery code for a bound operator");
    // T, the restart's own token.
    let invitation = it
        .operators
        .issue_setup_token(&bootstrap.operator_id)
        .await
        .expect("main.rs mints one at every start");
    let secret = SetupSecret::new(
        A_REAL_SETUP_PASSWORD,
        invitation.token,
        Instant::now() + Duration::from_secs(3600),
    );

    let by_password = "harbour-quill-meadow-ninety";
    let by_recovery = "copper-lantern-orchid-seven";
    let r_text = support::recovery_code_text(&reissued.invitation.token);

    let via_t = it.credentials.redeem_setup(
        &it.operators,
        Some(&secret),
        A_REAL_SETUP_PASSWORD.as_bytes(),
        by_password,
        "192.0.2.3",
    );
    let via_r = it.credentials.redeem_setup(
        &it.operators,
        Some(&secret),
        &r_text,
        by_recovery,
        "192.0.2.4",
    );
    let (t_result, r_result) = tokio::join!(via_t, via_r);

    // Exactly one path won.
    let t_won = t_result.is_ok();
    let r_won = r_result.is_ok();
    assert_ne!(
        t_won, r_won,
        "exactly one of the two concurrent redemptions must succeed, never both and never \
         neither: T {t_result:?}, R {r_result:?}"
    );

    // The stored password is the winner's, and only the winner's.
    let su = support::superuser_on_isolated(TAG).await;
    let stored_hash: Option<String> = su
        .query_one(
            "SELECT password_hash FROM accounts WHERE email = $1",
            &[&address],
        )
        .await
        .expect("read the account")
        .get(0);
    let stored_hash = stored_hash.expect("one of the two redemptions set a password");
    let winner_password = if t_won { by_password } else { by_recovery };
    let loser_password = if t_won { by_recovery } else { by_password };
    assert!(
        credentials::verify_password(&stored_hash, winner_password),
        "the winner's password must be the one stored"
    );
    assert!(
        !credentials::verify_password(&stored_hash, loser_password),
        "the loser's password must never have reached the account, whichever lost"
    );

    // Neither token row was corrupted: reading each back through the store's
    // own check must not come back `Unverifiable` -- a seal that does not
    // match what is actually stored. `Ok` (still live, the loser's own
    // token when the loser's redemption never got as far as spending it) and
    // `EnrolmentRefused` (spent, or expired by the winner's sweep) are both
    // fine; a corrupt seal is the one answer that means this test failed.
    let mut client = it.pool.get().await.expect("a connection");
    let tx = client.transaction().await.expect("a transaction");
    tx.batch_execute(
        "SELECT set_config('app.design_capability', 'no', true); \
         SELECT set_config('app.enrolment_custody', 'yes', true); \
         SELECT set_config('app.operator_custody', 'yes', true);",
    )
    .await
    .expect("the read custodies");
    let t_check = it.operators.check_setup_token(&tx, &invitation.token).await;
    let r_check = it
        .operators
        .check_setup_token(&tx, &reissued.invitation.token)
        .await;
    for (name, result) in [("T", &t_check), ("R", &r_check)] {
        assert!(
            !matches!(result, Err(OperatorError::Unverifiable(_))),
            "{name}'s row seal must still verify after the race, whichever redemption won: \
             {result:?}"
        );
    }
}

/// The check route's whole answer: status, headers and body, so that "the same
/// bytes" is a claim about all three. `Date` moves on its own and is dropped.
async fn check_over_the_wire(
    addr: std::net::SocketAddr,
    token: &[u8],
) -> (String, Vec<String>, Vec<u8>) {
    let (status, head, body) = raw_request_full(
        addr,
        "POST",
        "/enrolment/operator/setup/check",
        &[("x-forwarded-for", a_source_of_its_own())],
        &lp(token),
    )
    .await;
    let mut headers: Vec<String> = head
        .lines()
        .skip(1)
        .map(|l| l.trim().to_ascii_lowercase())
        .filter(|l| !l.is_empty() && !l.starts_with("date:"))
        .collect();
    headers.sort();
    (status, headers, body)
}

// ---------------------------------------------------------------------------
// Speaking HTTP by hand — `tests/sessions.rs`'s helpers, in this binary
// ---------------------------------------------------------------------------

fn lp(bytes: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(bytes.len() + 4);
    out.extend_from_slice(&(bytes.len() as u32).to_le_bytes());
    out.extend_from_slice(bytes);
    out
}

fn read_lp(body: &[u8]) -> &[u8] {
    let (field, rest) = fathom_server::crypto::read_lp(body).expect("a length-prefixed field");
    assert!(rest.is_empty(), "the answer carries exactly one field");
    field
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
