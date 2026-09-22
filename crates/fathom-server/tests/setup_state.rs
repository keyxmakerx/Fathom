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
use std::time::Duration;

use deadpool_postgres::Pool;
use fathom_server::api::{self, CredentialApiState};
use fathom_server::chains;
use fathom_server::client_address::ClientAddress;
use fathom_server::credentials::{self, CredentialError, CredentialStore, SetupState};
use fathom_server::crypto::Key32;
use fathom_server::keys::KeyRing;
use fathom_server::operators::OperatorStore;
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
        serve(api::credential_router(CredentialApiState {
            sessions: Arc::clone(&self.sessions),
            credentials: Arc::clone(&self.credentials),
            operators: Arc::clone(&self.operators),
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
            &bootstrap.invitation.token,
            A_REAL_CREDENTIAL,
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
        .redeem_setup(&it.operators, &invitation.token, A_REAL_CREDENTIAL)
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
    let token = bootstrap.invitation.token.to_vec();

    let named = it
        .credentials
        .check_setup(&it.operators, &token)
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
        .redeem_setup(&it.operators, &token, A_REAL_CREDENTIAL)
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

    let before = entries().await;
    for _ in 0..5 {
        let _ = it
            .credentials
            .check_setup(&it.operators, &bootstrap.invitation.token)
            .await;
        let _ = it
            .credentials
            .check_setup(&it.operators, b"not a token")
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
    // are not a token's length at all.
    let mut answers = Vec::new();
    for (what, token) in [
        ("never issued", vec![9u8; 32]),
        ("empty", Vec::new()),
        ("not token-shaped", b"op_paste-the-whole-line".to_vec()),
    ] {
        answers.push((what.to_string(), check_over_the_wire(addr, &token).await));
    }

    // A spent one: the setup finishes, and the file on the volume is now a
    // dead letter. This is the case a person actually hits.
    it.credentials
        .redeem_setup(
            &it.operators,
            &bootstrap.invitation.token,
            A_REAL_CREDENTIAL,
        )
        .await
        .expect("the setup token sets the credential");
    answers.push((
        "spent".to_string(),
        check_over_the_wire(addr, &bootstrap.invitation.token).await,
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
        check_over_the_wire(addr, &reissued.invitation.token).await,
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
        "setup token refused\n",
        "the sentence names what was refused — a token in a file, not a credential — because a \
         person holding the wrong file has to know which thing to fetch again"
    );

    // The typed refusal underneath is the one every token path gives.
    let refused = it.credentials.check_setup(&it.operators, b"rubbish").await;
    assert!(
        matches!(refused, Err(CredentialError::TokenRefused)),
        "got {refused:?}"
    );
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
