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

// ---------------------------------------------------------------------------
// The write path. Everything above this line reads.
// ---------------------------------------------------------------------------

/// Opens a transaction and sets the two settings every policy in
/// `migrations/0002_identity_and_scope.sql` reads -- the same pair
/// `repo::set_tenant_context` sets, spelled out here so these tests exercise
/// the database's own rules rather than the repository layer's.
async fn scoped_tx<'a>(
    client: &'a mut deadpool_postgres::Client,
    tenant: repo::OrganisationId,
    actor: repo::AccountId,
) -> deadpool_postgres::Transaction<'a> {
    let tx = client.transaction().await.expect("begin transaction");
    tx.execute(
        "SELECT set_config('app.tenant_id', $1, true)",
        &[&tenant.to_string()],
    )
    .await
    .expect("set tenant context");
    tx.execute(
        "SELECT set_config('app.account_id', $1, true)",
        &[&actor.to_string()],
    )
    .await
    .expect("set account context");
    tx
}

fn is_rls_refusal(err: &tokio_postgres::Error) -> bool {
    err.code() == Some(&tokio_postgres::error::SqlState::INSUFFICIENT_PRIVILEGE)
}

/// The half `a_tenants_transaction_context_cannot_see_another_tenants_rows`
/// did not cover: **writes**. That test issues only `SELECT`s, so it passed
/// against a policy set under which a transaction scoped to tenant B could
/// `INSERT` a membership granting itself any role in tenant A -- a `FOR ALL`
/// policy with only `USING` has that expression reused as its `WITH CHECK`,
/// and `memberships_isolation`'s `USING` has an `account_id` branch that a
/// write check must not have. Every case below is an attempted cross-tenant
/// write, and every one of them must be refused by the database itself.
#[tokio::test]
async fn a_tenants_transaction_context_cannot_write_another_tenants_rows() {
    let pool = support::migrated_pool().await;

    let owner_a = new_account(&pool, "write-owner-a").await;
    let owner_b = new_account(&pool, "write-owner-b").await;
    let org_a = repo::create_organisation(&pool, owner_a.id, "Write Tenant A")
        .await
        .expect("create org_a");
    let org_b = repo::create_organisation(&pool, owner_b.id, "Write Tenant B")
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

    let mut client = pool.get().await.expect("connection");

    // 1. The privilege escalation itself: B grants B admin of A.
    {
        let tx = scoped_tx(&mut client, org_b.id, owner_b.id).await;
        let err = tx
            .execute(
                "INSERT INTO memberships (account_id, organisation_id, role) \
                 VALUES ($1, $2, 'admin')",
                &[&owner_b.id.to_string(), &org_a.id.to_string()],
            )
            .await
            .expect_err(
                "a transaction scoped to org_b must not be able to insert a membership in org_a",
            );
        assert!(is_rls_refusal(&err), "{err}");
        tx.rollback().await.expect("rollback");
    }

    // 2. A scope planted in the other tenant's tree.
    {
        let tx = scoped_tx(&mut client, org_b.id, owner_b.id).await;
        let planted = fathom_server::ids::new_ulid().to_string();
        let err = tx
            .execute(
                "INSERT INTO scopes (id, organisation_id, parent_scope_id, kind, display_name, \
                 path, depth) VALUES ($1, $2, NULL, 'network', 'planted', $1, 1)",
                &[&planted, &org_a.id.to_string()],
            )
            .await
            .expect_err(
                "a transaction scoped to org_b must not be able to insert a scope in org_a",
            );
        assert!(is_rls_refusal(&err), "{err}");
        tx.rollback().await.expect("rollback");
    }

    // 3. An organisation that is not the one this transaction is scoped to.
    {
        let tx = scoped_tx(&mut client, org_b.id, owner_b.id).await;
        let invented = fathom_server::ids::new_ulid().to_string();
        let err = tx
            .execute(
                "INSERT INTO organisations (id, display_name) VALUES ($1, 'invented')",
                &[&invented],
            )
            .await
            .expect_err("a transaction scoped to org_b must not be able to create org_c");
        assert!(is_rls_refusal(&err), "{err}");
        tx.rollback().await.expect("rollback");
    }

    // 4. An UPDATE of the other tenant's row: hidden by `USING`, so it
    //    matches nothing rather than erroring -- but it must change nothing.
    {
        let tx = scoped_tx(&mut client, org_b.id, owner_b.id).await;
        let changed = tx
            .execute(
                "UPDATE scopes SET display_name = 'pwned' WHERE id = $1",
                &[&scope_a.id.to_string()],
            )
            .await
            .expect("the statement itself succeeds -- RLS matches zero rows");
        assert_eq!(changed, 0, "org_b must not be able to update org_a's scope");
        tx.rollback().await.expect("rollback");
    }

    // 5. The same escalation through UPDATE rather than INSERT, which the
    //    obvious fix does NOT close: an account that really is a member of A,
    //    claiming to act in B, moving its own membership row across the
    //    boundary and promoting itself on the way. A tenant-equality
    //    `WITH CHECK` passes this -- the NEW row's organisation IS this
    //    transaction's tenant -- so what has to stop it is `USING`: the
    //    `account_id` branch is a read rule and must not be reachable by a
    //    write. (Reproduced against a real PostgreSQL before 0003: `UPDATE 1`,
    //    and the row read back as admin of an organisation the account had
    //    never belonged to.)
    {
        let tx = scoped_tx(&mut client, org_b.id, owner_a.id).await;
        let changed = tx
            .execute(
                "UPDATE memberships SET organisation_id = $1, role = 'admin' \
                 WHERE account_id = $2",
                &[&org_b.id.to_string(), &owner_a.id.to_string()],
            )
            .await
            .expect("the statement itself succeeds -- RLS matches zero rows");
        assert_eq!(
            changed, 0,
            "an account must not be able to move its own membership into another tenant"
        );
        tx.rollback().await.expect("rollback");
    }

    drop(client);

    // Tenant B gained nobody.
    let members_b = repo::list_members(&pool, org_b.id, owner_b.id)
        .await
        .expect("list_members org_b");
    assert_eq!(members_b.len(), 1, "{members_b:?}");
    assert_eq!(members_b[0].account_id, owner_b.id);

    // And nothing above left a trace in tenant A.
    let members = repo::list_members(&pool, org_a.id, owner_a.id)
        .await
        .expect("list_members org_a");
    assert_eq!(
        members.len(),
        1,
        "org_a must still have exactly its founding admin: {members:?}"
    );
    let subtree = repo::list_subtree(&pool, org_a.id, owner_a.id, scope_a.id)
        .await
        .expect("list_subtree org_a");
    assert_eq!(subtree.len(), 1);
    assert_eq!(subtree[0].display_name, "A's network");
}

/// `accounts` carried no row-level security at all, on the argument that
/// nothing lets a transaction discover an account id it is not entitled to.
/// The exposure does not need id discovery: an unfiltered `SELECT` returns
/// every email address in the estate to any tenant's transaction.
#[tokio::test]
async fn another_tenants_accounts_are_not_readable() {
    let pool = support::migrated_pool().await;

    let owner_a = new_account(&pool, "accounts-owner-a").await;
    let owner_b = new_account(&pool, "accounts-owner-b").await;
    let org_b = repo::create_organisation(&pool, owner_b.id, "Accounts Tenant B")
        .await
        .expect("create org_b");

    let mut client = pool.get().await.expect("connection");
    let tx = scoped_tx(&mut client, org_b.id, owner_b.id).await;

    // Named outright, which is the strongest form of the question.
    let rows = tx
        .query(
            "SELECT email FROM accounts WHERE id = $1",
            &[&owner_a.id.to_string()],
        )
        .await
        .expect("the query itself succeeds -- RLS returns zero rows, not an error");
    assert!(
        rows.is_empty(),
        "a transaction scoped to org_b must not be able to read an account outside it"
    );

    // ...and the shape that needs no id at all.
    let rows = tx
        .query("SELECT id, email FROM accounts", &[])
        .await
        .expect("query succeeds");
    let ids: Vec<String> = rows.iter().map(|r| r.get::<_, String>(0)).collect();
    assert!(
        !ids.contains(&owner_a.id.to_string()),
        "an unfiltered SELECT over accounts must not hand org_b an account outside it: {ids:?}"
    );

    tx.rollback().await.expect("rollback");
}

/// A plain member could add anyone at any role, including admin -- the
/// function gated on membership and never on [`Role::Admin`].
#[tokio::test]
async fn a_plain_member_may_not_add_members() {
    let pool = support::migrated_pool().await;
    let owner = new_account(&pool, "owner").await;
    let colleague = new_account(&pool, "colleague").await;
    let outsider = new_account(&pool, "outsider").await;
    let org = repo::create_organisation(&pool, owner.id, "Admins Only Ltd")
        .await
        .expect("create_organisation");
    repo::add_member(&pool, org.id, owner.id, colleague.id, Role::Member)
        .await
        .expect("the founding admin may add a member");

    let err = repo::add_member(&pool, org.id, colleague.id, outsider.id, Role::Member)
        .await
        .expect_err("a plain member must not be able to add members");
    assert!(matches!(err, RepoError::NotAnAdmin), "{err}");

    // ...and least of all promote itself or anyone else to admin.
    let err = repo::add_member(&pool, org.id, colleague.id, outsider.id, Role::Admin)
        .await
        .expect_err("a plain member must not be able to add an admin");
    assert!(matches!(err, RepoError::NotAnAdmin), "{err}");

    let members = repo::list_members(&pool, org.id, owner.id)
        .await
        .expect("list_members");
    assert_eq!(members.len(), 2, "{members:?}");
}

// ---------------------------------------------------------------------------
// Two transactions at once. `path` and `parent_scope_id` are two spellings of
// the same fact, and nothing in the schema forces them to agree -- so the only
// thing that keeps them agreeing is how the repository layer reads before it
// writes.
// ---------------------------------------------------------------------------

/// The subtree rewrite, spelled out here rather than called through
/// `repo::move_subtree`, so a test can hold it open mid-flight -- which is
/// the whole point of the two tests below.
async fn raw_move(
    tx: &deadpool_postgres::Transaction<'_>,
    tenant: repo::OrganisationId,
    node: repo::ScopeId,
    old_path: &str,
    new_path: &str,
    new_parent: Option<repo::ScopeId>,
) {
    let changed = tx
        .execute(
            "UPDATE scopes \
             SET path = $1 || substring(path from char_length($2) + 1), \
                 parent_scope_id = CASE WHEN id = $3 THEN $4 ELSE parent_scope_id END \
             WHERE organisation_id = $5 AND (path = $2 OR path LIKE $2 || '.%')",
            &[
                &new_path,
                &old_path,
                &node.to_string(),
                &new_parent.map(|p| p.to_string()),
                &tenant.to_string(),
            ],
        )
        .await
        .expect("the raw move itself must succeed");
    assert!(changed > 0, "the raw move matched nothing");
}

async fn scope_by_id(
    pool: &deadpool_postgres::Pool,
    tenant: repo::OrganisationId,
    actor: repo::AccountId,
    id: repo::ScopeId,
) -> repo::Scope {
    repo::list_subtree(pool, tenant, actor, id)
        .await
        .expect("list_subtree")
        .into_iter()
        .next()
        .expect("the scope itself is the first row of its own subtree")
}

/// `create_scope` read the parent's path with no row lock, at READ
/// COMMITTED, and built the child's path from it. A `move_subtree` of that
/// parent committing in between left a row whose `path` and
/// `parent_scope_id` disagreed forever: no constraint catches it and no
/// later operation repairs it.
#[tokio::test]
async fn a_child_created_while_its_parent_moves_agrees_with_that_parent() {
    let pool = support::migrated_pool().await;
    let owner = new_account(&pool, "owner").await;
    let org = repo::create_organisation(&pool, owner.id, "Racing Creators Ltd")
        .await
        .expect("create_organisation");

    let n1 = repo::create_scope(&pool, org.id, owner.id, None, ScopeKind::Network, "Net 1")
        .await
        .expect("n1");
    let n2 = repo::create_scope(&pool, org.id, owner.id, None, ScopeKind::Network, "Net 2")
        .await
        .expect("n2");
    let building = repo::create_scope(
        &pool,
        org.id,
        owner.id,
        Some(n1.id),
        ScopeKind::Building,
        "Building",
    )
    .await
    .expect("building");

    // The other transaction: move the building from n1 to n2, and hold it
    // open, uncommitted.
    let mut holder = pool.get().await.expect("connection");
    let other = scoped_tx(&mut holder, org.id, owner.id).await;
    let moved_building_path = format!("{}.{}", n2.id, building.id);
    raw_move(
        &other,
        org.id,
        building.id,
        &building.path,
        &moved_building_path,
        Some(n2.id),
    )
    .await;

    // Meanwhile: create a rack under that same building.
    let creating = {
        let pool = pool.clone();
        let (org_id, owner_id, building_id) = (org.id, owner.id, building.id);
        tokio::spawn(async move {
            repo::create_scope(
                &pool,
                org_id,
                owner_id,
                Some(building_id),
                ScopeKind::Rack,
                "Rack",
            )
            .await
        })
    };

    // Long enough for the creating transaction to have read the parent --
    // which is exactly the window the bug lived in.
    tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    other.commit().await.expect("commit the move");
    drop(holder);

    let rack = creating
        .await
        .expect("the creating task must not panic")
        .expect("create_scope");

    let building_now = scope_by_id(&pool, org.id, owner.id, building.id).await;
    let rack_now = scope_by_id(&pool, org.id, owner.id, rack.id).await;
    assert_eq!(building_now.path, moved_building_path);
    assert_eq!(
        rack_now.parent_scope_id,
        Some(building.id),
        "the rack's parent link"
    );
    assert_eq!(
        rack_now.path,
        format!("{}.{}", building_now.path, rack.id),
        "the rack's path must be its parent's path plus its own id -- `path` and \
         `parent_scope_id` are two spellings of the same fact and must not disagree"
    );
    // ...and the returned row must say the same thing the stored one does.
    assert_eq!(rack.path, rack_now.path);
}

/// `move_subtree` re-matched a path read earlier with no row lock and no
/// rowcount check, so a concurrent move of an ancestor made the `UPDATE`
/// match zero rows and the function **return `Ok(())` having done nothing**.
/// A silent no-op success is the worst of the outcomes here: the caller is
/// told the estate of record was changed when it was not.
#[tokio::test]
async fn a_move_whose_ancestor_moves_underneath_it_does_not_silently_do_nothing() {
    let pool = support::migrated_pool().await;
    let owner = new_account(&pool, "owner").await;
    let org = repo::create_organisation(&pool, owner.id, "Racing Movers Ltd")
        .await
        .expect("create_organisation");

    let n1 = repo::create_scope(&pool, org.id, owner.id, None, ScopeKind::Network, "Net 1")
        .await
        .expect("n1");
    let n2 = repo::create_scope(&pool, org.id, owner.id, None, ScopeKind::Network, "Net 2")
        .await
        .expect("n2");
    let b1 = repo::create_scope(
        &pool,
        org.id,
        owner.id,
        Some(n1.id),
        ScopeKind::Building,
        "Building 1",
    )
    .await
    .expect("b1");
    let b2 = repo::create_scope(
        &pool,
        org.id,
        owner.id,
        Some(n2.id),
        ScopeKind::Building,
        "Building 2",
    )
    .await
    .expect("b2");
    let rack = repo::create_scope(
        &pool,
        org.id,
        owner.id,
        Some(b1.id),
        ScopeKind::Rack,
        "Rack",
    )
    .await
    .expect("rack");

    // The other transaction: move the rack's own parent out from under it,
    // held open and uncommitted.
    let mut holder = pool.get().await.expect("connection");
    let other = scoped_tx(&mut holder, org.id, owner.id).await;
    let b1_new_path = format!("{}.{}", n2.id, b1.id);
    raw_move(&other, org.id, b1.id, &b1.path, &b1_new_path, Some(n2.id)).await;

    // Meanwhile: move the rack from b1 to b2.
    let moving = {
        let pool = pool.clone();
        let (org_id, owner_id, rack_id, b2_id) = (org.id, owner.id, rack.id, b2.id);
        tokio::spawn(async move {
            repo::move_subtree(&pool, org_id, owner_id, rack_id, Some(b2_id)).await
        })
    };

    tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    other.commit().await.expect("commit the ancestor move");
    drop(holder);

    let outcome = moving.await.expect("the moving task must not panic");
    let rack_now = scope_by_id(&pool, org.id, owner.id, rack.id).await;

    match outcome {
        Ok(()) => {
            // A success must mean it happened.
            assert_eq!(
                rack_now.parent_scope_id,
                Some(b2.id),
                "move_subtree returned Ok, so the rack must actually be under b2"
            );
            assert_eq!(rack_now.path, format!("{}.{}", b2.path, rack.id));
        }
        // Refusing loudly is an acceptable outcome; doing nothing quietly is
        // not. A rowcount check must be what turns the latter into the
        // former, so the error must not be a silent success.
        Err(e) => {
            assert!(
                matches!(
                    e,
                    RepoError::ConcurrentModification | RepoError::NoSuchScope
                ),
                "{e}"
            );
            assert_eq!(rack_now.parent_scope_id, Some(b1.id));
            assert_eq!(rack_now.path, format!("{b1_new_path}.{}", rack.id));
        }
    }
}

// ---------------------------------------------------------------------------
// The shape of the rules, not one instance of them.
// ---------------------------------------------------------------------------

/// One row of `pg_policies`, reduced to the two facts that matter here.
#[derive(Debug, PartialEq, Eq)]
struct PolicyShape {
    table: String,
    name: String,
    /// `ALL`, `SELECT`, `INSERT`, `UPDATE` or `DELETE`.
    cmd: String,
    has_check: bool,
}

/// The rule: **a policy that governs a write must say what a written row may
/// look like.** A `FOR ALL` (or `FOR INSERT`/`FOR UPDATE`) policy with no
/// `WITH CHECK` does not escape the rule -- PostgreSQL fills the gap by
/// reusing the `USING` expression, and a read rule is not a write rule. That
/// reuse is exactly how a transaction scoped to one tenant could insert
/// itself a membership in another.
///
/// Returns the offending policies, so the failure names them.
fn policies_governing_writes_without_a_check(policies: &[PolicyShape]) -> Vec<&PolicyShape> {
    policies
        .iter()
        .filter(|p| matches!(p.cmd.as_str(), "ALL" | "INSERT" | "UPDATE") && !p.has_check)
        .collect()
}

#[test]
fn the_policy_rule_catches_the_shape_it_is_looking_for() {
    // A test that only ever passes is not evidence. These are the two shapes
    // migration 0002 actually shipped: one that was the privilege
    // escalation, and one that was merely implicit.
    let bad = vec![
        PolicyShape {
            table: "memberships".into(),
            name: "memberships_isolation".into(),
            cmd: "ALL".into(),
            has_check: false,
        },
        PolicyShape {
            table: "scopes".into(),
            name: "scopes_isolation".into(),
            cmd: "ALL".into(),
            has_check: false,
        },
    ];
    assert_eq!(policies_governing_writes_without_a_check(&bad).len(), 2);

    // ...and does not fire on a read rule, which is allowed to have no write
    // check precisely because it governs no write.
    let good = vec![
        PolicyShape {
            table: "memberships".into(),
            name: "memberships_readable".into(),
            cmd: "SELECT".into(),
            has_check: false,
        },
        PolicyShape {
            table: "memberships".into(),
            name: "memberships_deletable".into(),
            cmd: "DELETE".into(),
            has_check: false,
        },
        PolicyShape {
            table: "scopes".into(),
            name: "scopes_isolation".into(),
            cmd: "ALL".into(),
            has_check: true,
        },
    ];
    assert!(policies_governing_writes_without_a_check(&good).is_empty());
}

/// Every tenant-scoped table must have row-level security enabled **and
/// forced** (without `FORCE`, the role that owns the tables -- the role
/// migrations run as -- is exempt from its own policies), and no policy on
/// any of them may govern a write without saying what a written row may look
/// like. Read off the real database, so a policy added by a later migration
/// is held to the same rule without anyone remembering to come back here.
#[tokio::test]
async fn every_tenant_table_forces_row_security_and_checks_its_writes() {
    const TENANT_TABLES: &[&str] = &["accounts", "organisations", "memberships", "scopes"];

    let pool = support::migrated_pool().await;
    let client = pool.get().await.expect("connection");

    let rows = client
        .query(
            "SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class \
             WHERE relname = ANY($1) AND relnamespace = 'public'::regnamespace",
            &[&TENANT_TABLES],
        )
        .await
        .expect("read pg_class");
    assert_eq!(rows.len(), TENANT_TABLES.len(), "a table is missing");
    for row in &rows {
        let name: String = row.get(0);
        assert!(row.get::<_, bool>(1), "{name} does not have RLS enabled");
        assert!(row.get::<_, bool>(2), "{name} does not FORCE RLS");
    }

    let rows = client
        .query(
            "SELECT tablename, policyname, cmd, with_check IS NOT NULL FROM pg_policies \
             WHERE schemaname = 'public' AND tablename = ANY($1)",
            &[&TENANT_TABLES],
        )
        .await
        .expect("read pg_policies");
    let policies: Vec<PolicyShape> = rows
        .iter()
        .map(|r| PolicyShape {
            table: r.get(0),
            name: r.get(1),
            cmd: r.get(2),
            has_check: r.get(3),
        })
        .collect();
    assert!(
        !policies.is_empty(),
        "no policies at all is not a passing state"
    );

    let offenders = policies_governing_writes_without_a_check(&policies);
    assert!(
        offenders.is_empty(),
        "these policies govern a write and state no WITH CHECK, so PostgreSQL will reuse their \
         USING expression as the write rule: {offenders:?}"
    );

    // Every one of those tables must be reachable for reading at all --
    // a table with no SELECT-capable policy is isolated by accident rather
    // than by design, and the next person to notice will "fix" it by
    // loosening something.
    for table in TENANT_TABLES {
        assert!(
            policies
                .iter()
                .any(|p| p.table == *table && matches!(p.cmd.as_str(), "ALL" | "SELECT")),
            "{table} has no policy that permits reading it"
        );
    }
}
