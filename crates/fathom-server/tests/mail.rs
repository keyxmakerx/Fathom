//! The mail outbox against a real database (ADR-0085 decision 7, migration 0079).
//!
//! What it proves:
//! 1. A password reset for an account whose sign-in is an email address writes one sealed mail
//!    in the same transaction as the token; a sign-in name that is not an address writes none.
//!    Neither the address nor the link is anywhere in the row in the clear.
//! 2. The worker's claim opens the body, the link in it is the configured origin's, and a try
//!    that the relay refuses for now waits a minute while a permanent refusal is final and
//!    removes the body.
//! 3. With no mail settings applied, a due mail fails with a sentence a Steward can act on.
//! 4. A Steward's list shows one organisation's mail and no other's.

mod support;

use std::sync::Arc;

use deadpool_postgres::Pool;
use fathom_server::chains;
use fathom_server::credentials::CredentialStore;
use fathom_server::crypto::{hex, now_unix, Key32};
use fathom_server::keys::KeyRing;
use fathom_server::mail::{self, outbox, Mail};
use fathom_server::operators::OperatorStore;
use fathom_server::repo;

const MASTER: [u8; 32] = [21; 32];
const TAG: &str = "mail";

static DEPLOYMENT: tokio::sync::OnceCell<Pool> = tokio::sync::OnceCell::const_new();
static SERIAL: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

fn ring() -> Arc<KeyRing> {
    Arc::new(KeyRing::from_keys(
        Key32::from_bytes(MASTER),
        Key32::from_bytes(support::SITE_CHAIN_MASTER),
    ))
}

async fn deployment() -> Pool {
    DEPLOYMENT
        .get_or_init(|| async {
            let pool = support::isolated_deployment(TAG).await;
            let client = pool.get().await.expect("connection");
            chains::register_deployment(&**client)
                .await
                .expect("stamp the deployment id");
            pool.clone()
        })
        .await
        .clone()
}

async fn deployment_id(pool: &Pool) -> String {
    let client = pool.get().await.expect("connection");
    chains::deployment_id(&**client).await.expect("stamped")
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

fn the_mail() -> Arc<Mail> {
    Arc::new(Mail::new(
        Some("https://fathom.example.org".into()),
        mail::tls(),
    ))
}

async fn rows_for(pool: &Pool, needle: &str) -> Vec<(String, String, Option<Vec<u8>>, Vec<u8>)> {
    let su = support::superuser_on_isolated(TAG).await;
    let _ = pool;
    su.query(
        "SELECT id, state, body_ct, summary_ct FROM mail_outbox WHERE id = $1 OR $1 = ''",
        &[&needle],
    )
    .await
    .expect("read the outbox as the superuser")
    .into_iter()
    .map(|r| (r.get(0), r.get(1), r.get(2), r.get(3)))
    .collect()
}

#[tokio::test]
async fn a_reset_writes_one_sealed_mail_and_the_worker_handles_its_answers() {
    let _serial = SERIAL.lock().await;
    let pool = deployment().await;
    let ring = ring();
    let creds = CredentialStore::new(pool.clone(), Arc::clone(&ring), deployment_id(&pool).await)
        .with_mail(the_mail());

    let before = rows_for(&pool, "").await.len();

    // A sign-in name that is not an address: a token, and no mail.
    let name = unique("signin");
    repo::create_account(&pool, &name, "No Address")
        .await
        .expect("account");
    creds
        .issue_reset_token(&name, "198.51.100.1")
        .await
        .expect("issue")
        .expect("the name belongs to an account");
    assert_eq!(
        rows_for(&pool, "").await.len(),
        before,
        "no address, no mail"
    );

    // An address: one mail, sealed.
    let address = format!("{}@example.org", unique("sam"));
    repo::create_account(&pool, &address, "Sam")
        .await
        .expect("account");
    let token = creds
        .issue_reset_token(&address, "198.51.100.1")
        .await
        .expect("issue")
        .expect("the address belongs to an account");
    let rows = rows_for(&pool, "").await;
    assert_eq!(rows.len(), before + 1, "one mail with the token");
    let su = support::superuser_on_isolated(TAG).await;
    let dump: String = su
        .query_one("SELECT string_agg(t::text, '|') FROM mail_outbox t", &[])
        .await
        .expect("dump")
        .get(0);
    assert!(!dump.contains(&address), "the address is sealed");
    assert!(!dump.contains(&hex(&token)), "the link is sealed");
    assert!(
        !dump.contains(&hex(hex(&token).as_bytes())),
        "the link is sealed, as bytea too"
    );

    // The worker's claim opens it, with the configured origin's link.
    let due = outbox::claim_due(&pool, &ring, 50).await.expect("claim");
    let ours = due
        .iter()
        .find(|d| d.to == address)
        .expect("our mail is due");
    assert!(ours.text.contains(&format!(
        "https://fathom.example.org/#reset={}",
        hex(&token)
    )));
    assert_eq!(ours.subject, "Reset your Fathom password");
    // Claimed means held: a second claim does not see it.
    let again = outbox::claim_due(&pool, &ring, 50)
        .await
        .expect("claim again");
    assert!(
        again.iter().all(|d| d.id != ours.id),
        "a claimed mail is held"
    );

    // A refusal for now waits a minute and keeps the body.
    outbox::finish(
        &pool,
        &ours.id,
        ours.attempts,
        outbox::Outcome::Refused {
            reply: "451 4.3.0 try later".into(),
            permanent: false,
        },
    )
    .await
    .expect("record");
    let row = su
        .query_one(
            "SELECT state, attempts, body_ct IS NOT NULL, \
                    EXTRACT(EPOCH FROM next_attempt_at)::bigint, last_reply \
               FROM mail_outbox WHERE id = $1",
            &[&ours.id],
        )
        .await
        .expect("row");
    assert_eq!(row.get::<_, String>(0), "queued");
    assert_eq!(row.get::<_, i32>(1), 1);
    assert!(row.get::<_, bool>(2));
    let wait = row.get::<_, i64>(3) - now_unix();
    assert!(
        (50..=70).contains(&wait),
        "the first retry is a minute out, not {wait}s"
    );
    assert_eq!(row.get::<_, String>(4), "451 4.3.0 try later");

    // A permanent refusal is final and the body goes.
    outbox::finish(
        &pool,
        &ours.id,
        1,
        outbox::Outcome::Refused {
            reply: "550 5.1.1 no such user".into(),
            permanent: true,
        },
    )
    .await
    .expect("record");
    let rows = rows_for(&pool, &ours.id).await;
    assert_eq!(rows[0].1, "failed");
    assert!(rows[0].2.is_none(), "a finished mail keeps no body");
    drop(due);
}

#[tokio::test]
async fn with_no_settings_applied_a_due_mail_fails_and_says_why() {
    let _serial = SERIAL.lock().await;
    let pool = deployment().await;
    let ring = ring();
    let operators = OperatorStore::new(pool.clone(), Arc::clone(&ring), deployment_id(&pool).await);

    let mut client = pool.get().await.expect("connection");
    let tx = client.transaction().await.expect("begin");
    let draft = mail::reset_draft(
        "pat@example.org",
        "https://f.example/#reset=00",
        now_unix() + 3600,
        24,
    );
    let id = outbox::enqueue(&tx, &ring, &draft).await.expect("enqueue");
    tx.commit().await.expect("commit");

    mail::tick(&pool, &ring, &operators, &mail::tls())
        .await
        .expect("a pass");
    let su = support::superuser_on_isolated(TAG).await;
    let row = su
        .query_one(
            "SELECT state, last_reply, body_ct IS NULL FROM mail_outbox WHERE id = $1",
            &[&id],
        )
        .await
        .expect("row");
    assert_eq!(row.get::<_, String>(0), "failed");
    assert!(row.get::<_, String>(1).contains("not set up"));
    assert!(row.get::<_, bool>(2));
}

#[tokio::test]
async fn a_list_shows_one_organisations_mail_only() {
    let _serial = SERIAL.lock().await;
    let pool = deployment().await;
    let ring = ring();
    let owner = repo::create_account(&pool, &unique("owner"), "Owner")
        .await
        .expect("account");
    let ours = repo::create_organisation(&pool, owner.id, "Ours")
        .await
        .expect("org");
    let theirs = repo::create_organisation(&pool, owner.id, "Theirs")
        .await
        .expect("org");

    let mut client = pool.get().await.expect("connection");
    let tx = client.transaction().await.expect("begin");
    for (org, who) in [(&ours, "Sam"), (&theirs, "Kit")] {
        let draft = mail::invitation_draft(
            &org.id.to_string(),
            "Org",
            who,
            "x@example.org",
            "https://f.example/invite#inv_00",
            now_unix() + 3600,
        );
        outbox::enqueue(&tx, &ring, &draft).await.expect("enqueue");
    }
    let listed = outbox::list_for_organisation(&tx, &ring, &ours.id.to_string(), 100)
        .await
        .expect("list");
    tx.commit().await.expect("commit");
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].what, "Invitation for Sam");
    assert_eq!(listed[0].to, "x@example.org");
    assert_eq!(listed[0].state, "queued");
}

#[tokio::test]
async fn without_custody_the_outbox_shows_nothing() {
    let _serial = SERIAL.lock().await;
    let pool = deployment().await;
    let client = pool.get().await.expect("connection");
    let n: i64 = client
        .query_one("SELECT count(*) FROM mail_outbox", &[])
        .await
        .expect("count")
        .get(0);
    assert_eq!(
        n, 0,
        "the runtime role sees no mail without app.mail_custody"
    );
}
