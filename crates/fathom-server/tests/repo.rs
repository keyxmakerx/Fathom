//! The repository layer, against a real PostgreSQL (`tests/support`).
//!
//! Covers the brief's deliverable 5: creating an organisation, creating
//! scopes under it, moving a subtree, listing a subtree by prefix, and the
//! isolation deliverable 3 asks for -- proved against the database, not
//! assumed from reading the policy.

mod support;

use fathom_server::repo::{self, RepoError, Role, ScopeKind};

async fn new_account(pool: &deadpool_postgres::Pool, label: &str) -> repo::Account {
    // A fresh, unique email per call so parallel tests sharing one database
    // never collide on the `accounts.email` uniqueness constraint.
    let unique = fathom_server::ids::new_ulid();
    repo::create_account(pool, &format!("{label}-{unique}@example.test"), label)
        .await
        .expect("create_account")
}

#[tokio::test]
async fn creating_an_organisation_makes_the_creator_an_admin() {
    let pool = support::migrated_pool().await;
    let owner = new_account(&pool, "owner").await;

    let org = repo::create_organisation(&pool, owner.id, "Acme Networks")
        .await
        .expect("create_organisation");

    let orgs = repo::list_organisations_for_account(&pool, owner.id)
        .await
        .expect("list_organisations_for_account");
    assert!(orgs
        .iter()
        .any(|o| o.id == org.id && o.display_name == "Acme Networks"));

    let members = repo::list_members(&pool, org.id, owner.id)
        .await
        .expect("list_members");
    assert_eq!(members.len(), 1);
    assert_eq!(members[0].account_id, owner.id);
    assert_eq!(members[0].role, Role::Admin);
}

#[tokio::test]
async fn a_member_can_be_added_by_an_existing_member() {
    let pool = support::migrated_pool().await;
    let owner = new_account(&pool, "owner").await;
    let colleague = new_account(&pool, "colleague").await;
    let org = repo::create_organisation(&pool, owner.id, "Two People Ltd")
        .await
        .expect("create_organisation");

    let membership = repo::add_member(&pool, org.id, owner.id, colleague.id, Role::Member)
        .await
        .expect("add_member");
    assert_eq!(membership.role, Role::Member);

    let members = repo::list_members(&pool, org.id, owner.id)
        .await
        .expect("list_members");
    assert_eq!(members.len(), 2);
    assert!(members
        .iter()
        .any(|m| m.account_id == colleague.id && m.role == Role::Member));
}

#[tokio::test]
async fn a_stranger_may_not_add_members_to_an_organisation_they_do_not_belong_to() {
    let pool = support::migrated_pool().await;
    let owner = new_account(&pool, "owner").await;
    let stranger = new_account(&pool, "stranger").await;
    let victim = new_account(&pool, "victim").await;
    let org = repo::create_organisation(&pool, owner.id, "Isolated Co")
        .await
        .expect("create_organisation");

    let err = repo::add_member(&pool, org.id, stranger.id, victim.id, Role::Member)
        .await
        .expect_err("a non-member must not be able to add members");
    assert!(matches!(err, RepoError::NotAMember), "{err}");
}

#[tokio::test]
async fn scopes_nest_three_levels_deep_and_list_by_prefix() {
    let pool = support::migrated_pool().await;
    let owner = new_account(&pool, "owner").await;
    let org = repo::create_organisation(&pool, owner.id, "Three Levels Inc")
        .await
        .expect("create_organisation");

    let network = repo::create_scope(
        &pool,
        org.id,
        owner.id,
        None,
        ScopeKind::Network,
        "Core network",
    )
    .await
    .expect("create network");
    let building = repo::create_scope(
        &pool,
        org.id,
        owner.id,
        Some(network.id),
        ScopeKind::Building,
        "Building A",
    )
    .await
    .expect("create building");
    let rack = repo::create_scope(
        &pool,
        org.id,
        owner.id,
        Some(building.id),
        ScopeKind::Rack,
        "Rack 1",
    )
    .await
    .expect("create rack");

    // The path is opaque ids, dot-separated, root first -- never a name.
    assert_eq!(network.path, network.id.to_string());
    assert_eq!(building.path, format!("{}.{}", network.id, building.id));
    assert_eq!(
        rack.path,
        format!("{}.{}.{}", network.id, building.id, rack.id)
    );
    assert!(
        !rack.path.contains("Rack"),
        "the path must never carry a name: {}",
        rack.path
    );

    let subtree = repo::list_subtree(&pool, org.id, owner.id, network.id)
        .await
        .expect("list_subtree");
    let ids: Vec<_> = subtree.iter().map(|s| s.id).collect();
    assert_eq!(
        ids,
        vec![network.id, building.id, rack.id],
        "root-first, path order"
    );

    // Listing from the middle of the tree returns only that subtree.
    let from_building = repo::list_subtree(&pool, org.id, owner.id, building.id)
        .await
        .expect("list_subtree from building");
    assert_eq!(
        from_building.iter().map(|s| s.id).collect::<Vec<_>>(),
        vec![building.id, rack.id]
    );
}

#[tokio::test]
async fn a_scope_must_sit_under_the_kind_directly_above_it() {
    let pool = support::migrated_pool().await;
    let owner = new_account(&pool, "owner").await;
    let org = repo::create_organisation(&pool, owner.id, "Kind Rules Ltd")
        .await
        .expect("create_organisation");
    let network = repo::create_scope(&pool, org.id, owner.id, None, ScopeKind::Network, "Net")
        .await
        .expect("create network");

    // A rack cannot sit directly under a network -- it must be under a
    // building.
    let err = repo::create_scope(
        &pool,
        org.id,
        owner.id,
        Some(network.id),
        ScopeKind::Rack,
        "Rack",
    )
    .await
    .expect_err("a rack directly under a network must be refused");
    assert!(
        matches!(
            err,
            RepoError::WrongKindForParent {
                expected: Some(ScopeKind::Building)
            }
        ),
        "{err}"
    );

    // A second network cannot be created under an existing one -- a network
    // is always a root.
    let err = repo::create_scope(
        &pool,
        org.id,
        owner.id,
        Some(network.id),
        ScopeKind::Network,
        "Net 2",
    )
    .await
    .expect_err("a network must not have a parent");
    assert!(
        matches!(err, RepoError::WrongKindForParent { expected: None }),
        "{err}"
    );
}

#[tokio::test]
async fn a_missing_parent_is_reported_rather_than_silently_creating_a_root() {
    let pool = support::migrated_pool().await;
    let owner = new_account(&pool, "owner").await;
    let org = repo::create_organisation(&pool, owner.id, "No Such Parent LLC")
        .await
        .expect("create_organisation");

    let bogus_parent = repo::ScopeId(fathom_server::ids::new_ulid());
    let err = repo::create_scope(
        &pool,
        org.id,
        owner.id,
        Some(bogus_parent),
        ScopeKind::Building,
        "Orphan",
    )
    .await
    .expect_err("a parent id that does not exist must be refused");
    assert!(matches!(err, RepoError::NoSuchParent), "{err}");
}

#[tokio::test]
async fn moving_a_subtree_rewrites_every_descendants_path() {
    let pool = support::migrated_pool().await;
    let owner = new_account(&pool, "owner").await;
    let org = repo::create_organisation(&pool, owner.id, "Movers Inc")
        .await
        .expect("create_organisation");

    let old_network = repo::create_scope(
        &pool,
        org.id,
        owner.id,
        None,
        ScopeKind::Network,
        "Old site",
    )
    .await
    .expect("old network");
    let new_network = repo::create_scope(
        &pool,
        org.id,
        owner.id,
        None,
        ScopeKind::Network,
        "New site",
    )
    .await
    .expect("new network");
    let building = repo::create_scope(
        &pool,
        org.id,
        owner.id,
        Some(old_network.id),
        ScopeKind::Building,
        "Building",
    )
    .await
    .expect("building");
    let rack = repo::create_scope(
        &pool,
        org.id,
        owner.id,
        Some(building.id),
        ScopeKind::Rack,
        "Rack",
    )
    .await
    .expect("rack");

    repo::move_subtree(&pool, org.id, owner.id, building.id, Some(new_network.id))
        .await
        .expect("move_subtree");

    let moved = repo::list_subtree(&pool, org.id, owner.id, new_network.id)
        .await
        .expect("list_subtree new_network");
    assert_eq!(
        moved.iter().map(|s| s.id).collect::<Vec<_>>(),
        vec![new_network.id, building.id, rack.id]
    );
    let moved_building = moved.iter().find(|s| s.id == building.id).unwrap();
    let moved_rack = moved.iter().find(|s| s.id == rack.id).unwrap();
    assert_eq!(
        moved_building.path,
        format!("{}.{}", new_network.id, building.id)
    );
    assert_eq!(
        moved_rack.path,
        format!("{}.{}.{}", new_network.id, building.id, rack.id)
    );
    assert_eq!(moved_building.parent_scope_id, Some(new_network.id));
    // The rack's own parent link (to `building`) never changes -- only the
    // path text does, since the rack is a descendant, not the moved node.
    assert_eq!(moved_rack.parent_scope_id, Some(building.id));

    // The old network no longer has anything under it.
    let left_behind = repo::list_subtree(&pool, org.id, owner.id, old_network.id)
        .await
        .expect("list_subtree old_network");
    assert_eq!(
        left_behind.iter().map(|s| s.id).collect::<Vec<_>>(),
        vec![old_network.id]
    );
}

#[tokio::test]
async fn a_scope_cannot_be_moved_under_itself() {
    let pool = support::migrated_pool().await;
    let owner = new_account(&pool, "owner").await;
    let org = repo::create_organisation(&pool, owner.id, "Cycles Ltd")
        .await
        .expect("create_organisation");
    let network = repo::create_scope(&pool, org.id, owner.id, None, ScopeKind::Network, "Net")
        .await
        .expect("network");

    let err = repo::move_subtree(&pool, org.id, owner.id, network.id, Some(network.id))
        .await
        .expect_err("moving a scope under itself must be refused");
    assert!(matches!(err, RepoError::WouldCreateCycle), "{err}");
}

/// Deliverable 3: prove tenant isolation against the real database, the way
/// the brief asks -- including the case where the *application* query is the
/// one that forgets to filter by tenant, so what actually stops the read is
/// row-level security, not the `WHERE` clause.
#[tokio::test]
async fn a_tenants_transaction_context_cannot_see_another_tenants_rows() {
    let pool = support::migrated_pool().await;

    let owner_a = new_account(&pool, "owner-a").await;
    let owner_b = new_account(&pool, "owner-b").await;
    let org_a = repo::create_organisation(&pool, owner_a.id, "Tenant A")
        .await
        .expect("create org_a");
    let org_b = repo::create_organisation(&pool, owner_b.id, "Tenant B")
        .await
        .expect("create org_b");

    let scope_a = repo::create_scope(
        &pool,
        org_a.id,
        owner_a.id,
        None,
        ScopeKind::Network,
        "A's network",
    )
    .await
    .expect("create scope in org_a");

    // The repository layer's own application filtering already refuses this
    // (org_b's context can't even name org_a's scope -- `NoSuchScope`, since
    // the query is filtered by `organisation_id = $tenant`).
    let err = repo::list_subtree(&pool, org_b.id, owner_b.id, scope_a.id)
        .await
        .expect_err("org_b must not be able to read org_a's scope through the repository layer");
    assert!(matches!(err, RepoError::NoSuchScope), "{err}");

    // Now prove the OTHER layer independently: a raw query, run inside a
    // transaction scoped to org_b, that does not filter by
    // `organisation_id` at all -- the shape of query a future bug could
    // write. Row-level security must be what stops it, not this test's own
    // `WHERE` clause.
    let mut client = pool.get().await.expect("connection");
    let tx = client.transaction().await.expect("begin transaction");
    tx.execute(
        "SELECT set_config('app.tenant_id', $1, true)",
        &[&org_b.id.to_string()],
    )
    .await
    .expect("set tenant context");
    tx.execute(
        "SELECT set_config('app.account_id', $1, true)",
        &[&owner_b.id.to_string()],
    )
    .await
    .expect("set account context");

    let rows = tx
        .query(
            "SELECT id FROM scopes WHERE id = $1",
            &[&scope_a.id.to_string()],
        )
        .await
        .expect("the query itself must succeed -- RLS returns zero rows, not an error");
    assert!(
        rows.is_empty(),
        "a transaction scoped to org_b must see zero rows for org_a's scope, even from a query \
         that forgot to filter by organisation_id -- row-level security must supply that filter \
         on its own"
    );

    // And the membership table, the same way: ask for org_a's admin row by
    // its own real id while scoped to org_b.
    let rows = tx
        .query(
            "SELECT account_id FROM memberships WHERE organisation_id = $1",
            &[&org_a.id.to_string()],
        )
        .await
        .expect("query succeeds");
    assert!(
        rows.is_empty(),
        "a transaction scoped to org_b must not see org_a's memberships even when explicitly \
         asked for org_a's id"
    );

    tx.rollback().await.expect("rollback");
}

/// The trap named in `src/db.rs`: a session-level `SET` would leak a
/// tenant's context onto whichever request the pool next hands the same
/// connection to. `SET LOCAL` (via `set_config(..., true)`) must not survive
/// past the transaction that set it.
#[tokio::test]
async fn the_tenant_context_does_not_survive_past_its_transaction() {
    let pool = support::migrated_pool().await;
    let owner = new_account(&pool, "owner").await;
    let org = repo::create_organisation(&pool, owner.id, "Scoped Co")
        .await
        .expect("create_organisation");

    let mut client = pool.get().await.expect("connection");
    {
        let tx = client.transaction().await.expect("begin");
        tx.execute(
            "SELECT set_config('app.tenant_id', $1, true)",
            &[&org.id.to_string()],
        )
        .await
        .expect("set tenant context");
        tx.commit().await.expect("commit");
    }

    // A fresh transaction on the SAME underlying connection: if `SET LOCAL`
    // had leaked, `current_setting` would still return `org.id` here.
    let tx = client
        .transaction()
        .await
        .expect("begin second transaction");
    let row = tx
        .query_one("SELECT current_setting('app.tenant_id', true)", &[])
        .await
        .expect("read current_setting");
    let value: Option<String> = row.get(0);
    assert_ne!(
        value.as_deref(),
        Some(org.id.to_string().as_str()),
        "the tenant context must not survive into a new transaction on the same connection"
    );
    tx.rollback().await.expect("rollback");
}
