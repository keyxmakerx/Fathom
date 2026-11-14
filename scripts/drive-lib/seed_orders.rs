//! Throwaway seed for `scripts/drive-orders.mjs`: one organisation with two stewards. Ann's
//! KEY COMES FROM HER BROWSER (as in `seed_people.rs`), so what her browser signs verifies; Sam's
//! key is made here, so this seed can create teams and put people on them the way a Steward's
//! browser does (`tests/orders.rs`'s fixtures). Then the order types DIA and the site build, and
//! three orders at different points: one with a job for Ann, one waiting for a sign-off she may
//! give, and one in two lanes. Written and deleted by the drive.

mod support;

use std::io::Write as _;

use fathom_server::authority::{self, Capability, GrantFacts, SoftwareKey};
use fathom_server::chains;
use fathom_server::credentials;
use fathom_server::crypto::Key32;
use fathom_server::grants::{self, Authority, EpochWatch, GenesisGrant};
use fathom_server::keyprovider::KeySource;
use fathom_server::keys::{self, KeyRing};
use fathom_server::orders::{self, TypeRequest};
use fathom_server::repo::{self, AccountId, OrganisationId};
use fathom_server::teams::{self, NewTeam, TeamActRequest};
use fathom_canon::Json;
use std::collections::BTreeMap;

fn now_unix() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64
}

#[allow(dead_code)]
fn hex(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        out.push_str(&format!("{b:02x}"));
    }
    out
}

fn unhex(text: &str) -> Vec<u8> {
    (0..text.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&text[i..i + 2], 16).expect("hex"))
        .collect()
}

#[allow(dead_code)]
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

/// A fresh 32-byte P-256 scalar this process keeps, alongside the
/// `SoftwareKey` built from it — unlike `SoftwareKey::random()`, which never
/// hands the scalar back.
#[allow(dead_code)]
fn fresh_key() -> ([u8; 32], SoftwareKey) {
    let scalar = *Key32::random().expect("OS randomness").expose();
    let key = SoftwareKey::from_bytes(&scalar).expect("a valid P-256 scalar");
    (scalar, key)
}

/// Piece 3's clock, seen at once: due as soon as it is ready, shown to the lead, then handed on.
const OUTAGE: &str = "fathom: order-definition/1
id: outage
name: Outage follow-up
number: OUT
fields:
  - { use: customer-details }
stages:
  - id: look
    name: Look into it
    jobs:
      - id: cause
        name: Find the cause
        team: network-design
        steps: [Cause written down]
        due: 0m
        overdue:
          - { after: 0m, escalate: lead }
          - { after: 0m, reassign: ip-design }
";

#[tokio::test]
async fn seed_for_the_orders_drive() {
    let master_spec =
        std::env::var("FATHOM_MASTER_KEY").expect("FATHOM_MASTER_KEY (file:// spec) must be set");
    let chain_spec =
        std::env::var("FATHOM_CHAIN_KEY").expect("FATHOM_CHAIN_KEY (file:// spec) must be set");
    let output_path =
        std::env::var("SEED_OUTPUT").expect("SEED_OUTPUT (a file path to write JSON to)");

    let master_source = KeySource::parse(&master_spec).expect("a valid FATHOM_MASTER_KEY spec");
    let chain_source = KeySource::parse(&chain_spec).expect("a valid FATHOM_CHAIN_KEY spec");
    // `create_if_missing = true`, exactly like `main.rs`'s own startup call —
    // this binary runs BEFORE the real server, so it is the one that mints
    // the two key files the server then loads unchanged.
    let ring = KeyRing::load(&master_source, &chain_source, true)
        .expect("the two key files must load or be creatable");

    let pool = support::migrated_pool().await;

    {
        let client = pool.get().await.expect("connection");
        chains::register_deployment(&**client)
            .await
            .expect("stamp the deployment identity, exactly as main.rs does at startup");
    }

    // ------------------------------------------------------------------
    // The organisation and its steward — `tests/design_api.rs`'s
    // `bootstrap()`, verbatim in shape, except the steward's scalar is kept
    // rather than thrown away.
    // ------------------------------------------------------------------
    let root = SoftwareKey::random().expect("an organisation root keypair");
    let salt = [0x5au8; 16];
    let organisation_id = authority::derive_organisation_id(&root.public_key(), &salt);
    let root_fpr = authority::key_fingerprint(&root.public_key());

    let steward_address =
        std::env::var("SEED_STEWARD_ADDRESS").expect("SEED_STEWARD_ADDRESS (the address Ann signs in as)");
    let steward_public = unhex(
        &std::env::var("SEED_STEWARD_PUBKEY").expect("SEED_STEWARD_PUBKEY (hex SEC1 point from her browser)"),
    );
    let steward_account = repo::create_account(&pool, &steward_address, "Ann Alder")
        .await
        .expect("create the steward's account shell")
        .id;

    let now = now_unix();
    let steward_subject_fpr = authority::key_fingerprint(&steward_public);
    let facts = GrantFacts {
        organisation: &organisation_id,
        root_pubkey_fpr: &root_fpr,
        scope: "",
        subject: &steward_account.to_string(),
        subject_key_fpr: &steward_subject_fpr,
        capability: Capability::Steward,
        granter: None,
        granter_key_fpr: &root_fpr,
        effective_from_unix: now,
        expires_at_unix: now + 365 * 24 * 3600,
        sole_steward_appointment: false,
        auth_epoch: 1,
    };
    let sam_key = SoftwareKey::random().expect("Sam's key");
    let sam_account = repo::create_account(&pool, &unique("sam"), "Sam Okafor")
        .await
        .expect("create Sam")
        .id;
    let sam_fpr = authority::key_fingerprint(&sam_key.public_key());
    let sam_facts = GrantFacts {
        organisation: &organisation_id,
        root_pubkey_fpr: &root_fpr,
        scope: "",
        subject: &sam_account.to_string(),
        subject_key_fpr: &sam_fpr,
        capability: Capability::Steward,
        granter: None,
        granter_key_fpr: &root_fpr,
        effective_from_unix: now,
        expires_at_unix: now + 365 * 24 * 3600,
        sole_steward_appointment: false,
        auth_epoch: 1,
    };
    let sam_request = GenesisGrant {
        subject: sam_account,
        subject_key_fpr: sam_fpr,
        capability: Capability::Steward,
        effective_from_unix: now,
        expires_at_unix: now + 365 * 24 * 3600,
        signature: root.sign(&authority::grant_bytes(&sam_facts)),
    };
    let genesis_request = GenesisGrant {
        subject: steward_account,
        subject_key_fpr: steward_subject_fpr,
        capability: Capability::Steward,
        effective_from_unix: now,
        expires_at_unix: now + 365 * 24 * 3600,
        signature: root.sign(&authority::grant_bytes(&facts)),
    };

    let organisation = {
        let mut client = pool.get().await.expect("connection");
        let tx = client.transaction().await.expect("begin");
        let genesis = grants::bootstrap_organisation(
            &tx,
            &ring,
            steward_account,
            "Northwind Networks",
            &root.public_key(),
            &salt,
            &[genesis_request, sam_request],
        )
        .await
        .expect("genesis");
        tx.commit().await.expect("commit");
        genesis.organisation
    };

    enrol(&pool, &ring, organisation, steward_account, &steward_public).await;
    set_password(&pool, &ring, steward_account, "@@STEWARD_PW@@").await;
    repo::add_member(&pool, organisation, steward_account, sam_account, repo::Role::Member)
        .await
        .expect("Sam is a member");
    enrol(&pool, &ring, organisation, sam_account, &sam_key.public_key()).await;
    let sam = Person { account: sam_account, key: sam_key };

    // Teams, each with a person on it; Ann is on Network design.
    let people = [
        ("order-desk", "Order desk", "Bea Marsh"),
        ("ip-design", "IP design", "Cy Lund"),
        ("network-design", "Network design", "Dee Patel"),
        ("provisioning", "Provisioning", "Eli Novak"),
        ("field", "Field", "Fay Rowe"),
        ("construction", "Construction", "Gus Ortiz"),
        ("order-entry", "Order entry", "Hana Ito"),
        ("order-management", "Order management", "Ivo Brandt"),
    ];
    let mut team_ids: BTreeMap<String, String> = BTreeMap::new();
    let mut members: BTreeMap<String, AccountId> = BTreeMap::new();
    for (slug, name, person) in people {
        let team = team_act(&pool, &ring, organisation, &sam, request(None, teams::ACT_CREATE), Some(&NewTeam { slug: slug.into(), name: name.into() }))
            .await
            .0;
        let who = repo::create_account(&pool, &unique(slug), person).await.expect("account").id;
        repo::add_member(&pool, organisation, steward_account, who, repo::Role::Member).await.expect("member");
        let mut r = request(Some(&team), teams::ACT_MEMBER_ADD);
        r.subject = Some(who.to_string());
        team_act(&pool, &ring, organisation, &sam, r, None).await;
        team_ids.insert(slug.into(), team);
        members.insert(slug.into(), who);
    }
    let mut r = request(Some(&team_ids["network-design"]), teams::ACT_MEMBER_ADD);
    r.subject = Some(steward_account.to_string());
    team_act(&pool, &ring, organisation, &sam, r, None).await;

    // The order types, saved by Sam.
    let set = include_str!("../../../corpus/orders/field-sets/customer-details.yaml").to_string();
    let mut saved = BTreeMap::new();
    for (key, source) in [
        ("dia", include_str!("../../../corpus/orders/dia.yaml")),
        ("site", include_str!("../../../corpus/orders/site-build.yaml")),
        ("outage", OUTAGE),
    ] {
        let req = TypeRequest { id: None, source: source.to_string(), field_sets: vec![set.clone()], teams: BTreeMap::new() };
        let t = as_who(&pool, &ring, organisation, sam_account, |tx, auth| Box::pin(async move { orders::save_type(tx, auth, req).await.map(|t| t.id) })).await;
        saved.insert(key, t);
    }
    let answers = |customer: &str, extra: &[(&str, &str)]| -> BTreeMap<String, Json> {
        let mut m: BTreeMap<String, Json> = [("customer", customer), ("contact_name", "Jo Okafor"), ("site", "Riverside depot")]
            .into_iter()
            .map(|(k, v)| (k.to_string(), Json::Str(v.to_string())))
            .collect();
        for (k, v) in extra {
            m.insert(k.to_string(), Json::Str(v.to_string()));
        }
        m
    };
    let open = |ty: String, a: BTreeMap<String, Json>| {
        let pool = &pool;
        let ring = &ring;
        let bea = members["order-desk"];
        async move { as_who(pool, ring, organisation, bea, |tx, auth| Box::pin(async move { orders::open_order(tx, auth, &ty, a).await.map(|v| v.id) })).await }
    };
    // ADR-0084 decision 18: a design with a plan on edge-rt1's Et49, the port Harbour Clinic's order
    // holds once its port job is done. Built by the client's own commands (`drive-lib/clash_design.test.ts`).
    let clash_line = std::fs::read_to_string(std::env::var("CLASH_DESIGN").expect("CLASH_DESIGN (the clash design's file)")).expect("read CLASH_DESIGN");
    let clash: Vec<&str> = clash_line.trim().split('\t').collect();
    assert_eq!(clash.len(), 5, "CLASH_DESIGN: minor, payload, device, port, plan");
    let text = |i: usize| clash[i].to_string();
    let minor: i32 = clash[0].parse().expect("CLASH_DESIGN's minor");
    let network = repo::create_scope(&pool, organisation, steward_account, None, repo::ScopeKind::Network, &unique("Harbour"))
        .await
        .expect("a site for the clash design")
        .id;
    let design = fathom_server::designs::create_design(&pool, organisation, steward_account, network).await.expect("the clash design");
    fathom_server::designs::write_version(&pool, &ring, organisation, steward_account, design, &unhex(&text(1)), minor)
        .await
        .expect("its first version");
    let edge_port = Json::Obj(
        [("design", design.to_string()), ("device", text(2)), ("port", text(3))]
            .into_iter()
            .map(|(k, v)| (k.to_string(), Json::Str(v)))
            .collect(),
    );
    let w1 = open(saved["dia"].clone(), answers("Riverside Council", &[("bandwidth", "10G")])).await;
    let mut harbour = answers("Harbour Clinic", &[("bandwidth", "1G")]);
    harbour.insert("edge_port".into(), edge_port);
    let w2 = open(saved["dia"].clone(), harbour).await;
    let mut site = answers("Riverside depot build", &[("ship_to", "Riverside depot, Dock Road")]);
    site.insert("racks".into(), Json::Int(2));
    let w3 = open(saved["site"].clone(), site).await;
    let _ = w3;
    // Piece 3: an order whose job is due at once, so the clock has shown it to the lead and handed it
    // to IP design by the time anyone looks.
    let outage: BTreeMap<String, Json> = [("customer", "Quay Street Dental"), ("contact_name", "Rae Moss")]
        .into_iter()
        .map(|(k, v)| (k.to_string(), Json::Str(v.to_string())))
        .collect();
    let w4 = open(saved["outage"].clone(), outage).await;

    // W1: the order desk checks it; Design is under way, and Ann's team has a job.
    finish_job(&pool, &ring, organisation, members["order-desk"], &w1, "check", 3).await;
    act(&pool, &ring, organisation, members["ip-design"], &w1, "pick_up", vec![("job", Json::Str("addresses".into()))]).await;
    // W2: checked, and both Design jobs done by their teams: waiting for a sign-off Ann may give.
    finish_job(&pool, &ring, organisation, members["order-desk"], &w2, "check", 3).await;
    finish_job(&pool, &ring, organisation, members["ip-design"], &w2, "addresses", 0).await;
    finish_job(&pool, &ring, organisation, members["network-design"], &w2, "port", 1).await;

    let plan = text(4);
    let json = format!("{{\"steward\": \"{steward_address}\", \"w1\": \"{w1}\", \"w2\": \"{w2}\", \"w4\": \"{w4}\", \"design\": \"{design}\", \"plan\": \"{plan}\"}}\n");
    let mut file = std::fs::File::create(&output_path).expect("create SEED_OUTPUT");
    file.write_all(json.as_bytes()).expect("write SEED_OUTPUT");
}

/// `tests/design_api.rs`'s own `enrol`, verbatim: enrol `key`'s public half
/// for `account` inside `organisation`.
async fn enrol(
    pool: &deadpool_postgres::Pool,
    ring: &KeyRing,
    organisation: fathom_server::repo::OrganisationId,
    account: fathom_server::repo::AccountId,
    public_key: &[u8],
) {
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
    grants::enrol_software_key(&tx, &auth, public_key)
        .await
        .expect("enrol");
    tx.commit().await.expect("commit");
}

/// `tests/credentials.rs`'s own `set_password_directly`, verbatim: a
/// password set without a session, the way `/enrolment/operator/setup` and
/// `/credentials/reset/redeem` do — used only to bootstrap this fixture into
/// the state this proof is actually about. The hash and its seal go in ONE
/// statement, the shape `0025`'s own constraint trigger requires of anything
/// that puts a first credential on a row.
async fn set_password(pool: &deadpool_postgres::Pool, ring: &KeyRing, account: fathom_server::repo::AccountId, password: &str) {
    let hash = credentials::hash_password(password).expect("hash the seed password");
    let mut client = pool.get().await.expect("connection");
    let tx = client.transaction().await.expect("begin");
    tx.execute("SELECT set_config('app.reset_custody', 'yes', true)", &[])
        .await
        .expect("reset custody");
    let account_text = account.to_string();
    let mut next = credentials::read_credentials(&tx, ring, &account_text)
        .await
        .expect("read credentials")
        .expect("the account exists");
    next.password_hash = Some(hash.clone());
    let seal = credentials::seal_for_write(&tx, ring, &account_text, &mut next, None)
        .await
        .expect("seal the credential columns");
    tx.execute(
        "UPDATE accounts SET password_hash = $2, credential_seal = $3,                 credential_row_version = $4, credential_seq = $5           WHERE id = $1",
        &[
            &account_text,
            &hash,
            &seal,
            &next.credential_row_version,
            &next.seq_column(),
        ],
    )
    .await
    .expect("set the password");
    tx.commit().await.expect("commit");
}

struct Person {
    account: AccountId,
    key: SoftwareKey,
}

fn request(team: Option<&str>, act: &str) -> TeamActRequest {
    TeamActRequest {
        team: team.map(str::to_string),
        act: act.to_string(),
        subject: None,
        role: None,
        scope: None,
        capability: None,
        undoes: None,
        signer_authority: teams::BY_STEWARD.to_string(),
    }
}

/// Propose, sign with `who`'s key, commit: the browser's round trip (`tests/orders.rs`).
async fn team_act(
    pool: &deadpool_postgres::Pool,
    ring: &KeyRing,
    organisation: OrganisationId,
    who: &Person,
    req: TeamActRequest,
    new_team: Option<&NewTeam>,
) -> (String, String) {
    let mut client = pool.get().await.unwrap();
    let tx = client.transaction().await.unwrap();
    let ctx = repo::open_tenant_context(&tx, organisation, who.account).await.unwrap();
    let tenant_key = keys::tenant_key(&tx, ring, &ctx).await.unwrap();
    let watch = EpochWatch::new();
    let auth = Authority { ring, ctx: &ctx, tenant_key: &tenant_key, watch: &watch };
    let fpr = authority::key_fingerprint(&who.key.public_key());
    let proposal = teams::propose_act(&tx, &auth, &req, new_team, &fpr).await.expect("propose");
    let signature = who.key.sign(&proposal.bytes);
    let id = teams::commit_act(&tx, &auth, &proposal, new_team, &signature).await.expect("commit");
    tx.commit().await.unwrap();
    (proposal.team, id)
}

type Boxed<'a, T> = std::pin::Pin<Box<dyn std::future::Future<Output = Result<T, orders::OrderError>> + 'a>>;

async fn as_who<T>(
    pool: &deadpool_postgres::Pool,
    ring: &KeyRing,
    organisation: OrganisationId,
    who: AccountId,
    f: impl for<'a> FnOnce(&'a deadpool_postgres::Transaction<'a>, &'a Authority<'a>) -> Boxed<'a, T>,
) -> T {
    let mut client = pool.get().await.unwrap();
    let tx = client.transaction().await.unwrap();
    let ctx = repo::open_tenant_context(&tx, organisation, who).await.unwrap();
    let tenant_key = keys::tenant_key(&tx, ring, &ctx).await.unwrap();
    let watch = EpochWatch::new();
    let auth = Authority { ring, ctx: &ctx, tenant_key: &tenant_key, watch: &watch };
    let out = match f(&tx, &auth).await {
        Ok(v) => v,
        Err(e) => panic!("{e:?}"),
    };
    tx.commit().await.unwrap();
    out
}

async fn act(pool: &deadpool_postgres::Pool, ring: &KeyRing, organisation: OrganisationId, who: AccountId, order: &str, word: &str, keys: Vec<(&str, Json)>) {
    let body: BTreeMap<String, Json> = keys.into_iter().map(|(k, v)| (k.to_string(), v)).collect();
    let order = order.to_string();
    let word = word.to_string();
    as_who(pool, ring, organisation, who, |tx, auth| Box::pin(async move { orders::act(tx, auth, &order, &word, body).await.map(|_| ()) })).await;
}

async fn finish_job(pool: &deadpool_postgres::Pool, ring: &KeyRing, organisation: OrganisationId, who: AccountId, order: &str, job: &str, steps: i64) {
    act(pool, ring, organisation, who, order, "pick_up", vec![("job", Json::Str(job.into()))]).await;
    for step in 0..steps {
        act(pool, ring, organisation, who, order, "tick", vec![("job", Json::Str(job.into())), ("step", Json::Int(step)), ("done", Json::Bool(true))]).await;
    }
    act(pool, ring, organisation, who, order, "finish", vec![("job", Json::Str(job.into()))]).await;
}
