//! The repository layer: accounts, organisations, membership, and the scope
//! hierarchy (`organisation -> network -> building -> rack`).
//!
//! `docs/PHASE-2-STORAGE-DESIGN.md` §1 calls this half "Identity" and
//! "Structure" -- low sensitivity, must be queryable -- as distinct from
//! "Designs" and "Vault", which sit behind the master key. **That boundary is
//! no longer an open question**: ADR-0043 answered A1 and the hierarchy is
//! built in `keys` and `designs`. Nothing in *this* file writes a design
//! payload, a credential or a wrapped key; what it now also provides is
//! [`TenantContext`], the pinned tenant those modules take instead of a bare
//! organisation id (§4: *"never taken from the row being read"*).
//!
//! # Tenant isolation, done twice
//!
//! `docs/PHASE-2-STORAGE-DESIGN.md` §7: row-level security **and**
//! application filtering, neither alone. Every function that touches
//! `organisations`, `memberships` or `scopes` opens its own transaction,
//! calls [`authorise`] -- which sets two transaction-scoped settings, per
//! `src/db.rs`'s standing rule that nothing may depend on which pooled
//! connection a request gets -- and *also* names the tenant explicitly in
//! every `WHERE` clause. RLS is the backstop for the day one of those clauses
//! is missing; it is deliberately not the only thing standing between two
//! tenants' rows.
//!
//! ## What that second layer is, and what it is not
//!
//! **Both layers rest on a `tenant` and an `actor` this module is handed.
//! There is no authentication layer yet** (`docs/OPEN-QUESTIONS.md` B1-B9,
//! C2), so whoever calls these functions is trusted, by construction, to say
//! truthfully which account is acting. Nothing below changes that, and this
//! file must not be read as if something did.
//!
//! What [`authorise`] does buy, and the reason the order of its three steps
//! is not arbitrary: `app.tenant_id` is set **after** the membership row has
//! been found, never before. So the setting every policy reads is not a
//! restatement of the caller's own argument -- it is a value the database
//! agreed to, because a real membership row was read back under the acting
//! account's own identity first. That read is itself policy-governed:
//! `memberships_readable` (migration 0003) shows an account its own rows in
//! any organisation, which is exactly the branch this needs and exactly the
//! branch no write may use. A caller naming a tenant it has no membership in
//! never opens a tenant context at all.
//!
//! So RLS is an independent filter against *the clause that goes missing*,
//! which is the failure §7 names. It is not, and must not be described as, a
//! defence against a caller that lies about who is acting. That defence is
//! authentication, and it does not exist yet.

use core::fmt;
use core::str::FromStr;

use deadpool_postgres::{Pool, PoolError, Transaction};
use tokio_postgres::Row;

use fathom_id::{DecodeError, Ulid};

use crate::ids::new_ulid;

// ---------------------------------------------------------------------------
// Identifiers
// ---------------------------------------------------------------------------

macro_rules! ulid_id {
    ($(#[$doc:meta])* $name:ident) => {
        $(#[$doc])*
        #[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
        pub struct $name(pub Ulid);

        impl $name {
            // `pub(crate)`, not private: `designs` mints a `DesignId` and
            // must not reach past this macro to `ids::new_ulid` to do it --
            // every id in this server is minted in exactly one place.
            pub(crate) fn new() -> Self {
                Self(new_ulid())
            }
        }

        impl fmt::Display for $name {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                self.0.fmt(f)
            }
        }

        impl fmt::Debug for $name {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                write!(f, "{}({})", stringify!($name), self.0)
            }
        }

        impl FromStr for $name {
            type Err = DecodeError;
            fn from_str(s: &str) -> Result<Self, Self::Err> {
                Ok(Self(Ulid::decode(s)?))
            }
        }
    };
}

ulid_id!(
    /// An account's id. Opaque; never a login name.
    AccountId
);
ulid_id!(
    /// An organisation's id -- the tenant boundary everything else hangs off.
    OrganisationId
);
ulid_id!(
    /// A scope node's id -- one row in the `organisation -> network ->
    /// building -> rack` hierarchy.
    ScopeId
);
ulid_id!(
    /// A design's id. Opaque, and the ONLY way a design is addressed
    /// server-side: `migrations/0007_key_hierarchy_and_designs.sql` gives
    /// `designs` no name column at all, because a plaintext one would be the
    /// side door `docs/PHASE-2-STORAGE-DESIGN.md` §11.3 cost 3 names.
    DesignId
);

// ---------------------------------------------------------------------------
// Small enums
// ---------------------------------------------------------------------------

/// Deliberately minimal (brief: "enough to distinguish who may administer an
/// organisation from who may use it; the full permission model is not this
/// task").
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Role {
    Admin,
    Member,
}

impl Role {
    fn as_str(self) -> &'static str {
        match self {
            Self::Admin => "admin",
            Self::Member => "member",
        }
    }

    fn parse(s: &str) -> Option<Self> {
        match s {
            "admin" => Some(Self::Admin),
            "member" => Some(Self::Member),
            _ => None,
        }
    }
}

/// The three levels the scope hierarchy holds beneath an organisation
/// (`docs/PHASE-2-STORAGE-DESIGN.md` §2).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum ScopeKind {
    Network,
    Building,
    Rack,
}

impl ScopeKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::Network => "network",
            Self::Building => "building",
            Self::Rack => "rack",
        }
    }

    fn parse(s: &str) -> Option<Self> {
        match s {
            "network" => Some(Self::Network),
            "building" => Some(Self::Building),
            "rack" => Some(Self::Rack),
            _ => None,
        }
    }

    /// What kind the parent of a scope of this kind must be. `None` means "no
    /// parent at all" -- only a network may be a root.
    fn expected_parent_kind(self) -> Option<Self> {
        match self {
            Self::Network => None,
            Self::Building => Some(Self::Network),
            Self::Rack => Some(Self::Building),
        }
    }

    fn depth(self) -> i16 {
        match self {
            Self::Network => 1,
            Self::Building => 2,
            Self::Rack => 3,
        }
    }
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Account {
    pub id: AccountId,
    pub email: String,
    pub display_name: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Organisation {
    pub id: OrganisationId,
    pub display_name: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Membership {
    pub account_id: AccountId,
    pub organisation_id: OrganisationId,
    pub role: Role,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Scope {
    pub id: ScopeId,
    pub organisation_id: OrganisationId,
    pub parent_scope_id: Option<ScopeId>,
    pub kind: ScopeKind,
    pub display_name: String,
    /// The materialised path: opaque scope ids, dot-separated, root first,
    /// ending in `id`. Never a name -- see the migration's header.
    pub path: String,
    pub depth: i16,
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

#[derive(Debug)]
pub enum RepoError {
    Pool(PoolError),
    Db(tokio_postgres::Error),
    NoSuchParent,
    NoSuchScope,
    /// The acting account is not a member of the tenant it is trying to act
    /// in. Application-layer filtering, on top of the RLS that would also
    /// have hidden the rows -- §7's "both, neither alone".
    NotAMember,
    /// The acting account is a member, but the operation is one only an
    /// administrator of the organisation may perform.
    NotAnAdmin,
    /// A row this transaction read and then wrote was changed underneath it
    /// by another transaction, and the write matched nothing as a result.
    /// **Returned rather than `Ok(())`**: a caller told an estate-of-record
    /// change succeeded when it did not is worse than a caller told to retry.
    ConcurrentModification,
    /// A scope of this kind may not sit under a parent of the kind given (or
    /// under no parent at all, if `expected` is `None`).
    WrongKindForParent {
        expected: Option<ScopeKind>,
    },
    /// Moving a scope under itself or one of its own descendants.
    WouldCreateCycle,
    /// A row this process itself wrote could not be read back as what it is
    /// supposed to be. Should be unreachable given the migration's `CHECK`
    /// constraints; kept explicit rather than panicking on a row decode.
    Corrupt(&'static str),
}

impl From<PoolError> for RepoError {
    fn from(e: PoolError) -> Self {
        Self::Pool(e)
    }
}

impl From<tokio_postgres::Error> for RepoError {
    fn from(e: tokio_postgres::Error) -> Self {
        Self::Db(e)
    }
}

impl fmt::Display for RepoError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Pool(_) => f.write_str("could not get a database connection"),
            Self::Db(e) => write!(f, "database error: {e}"),
            Self::NoSuchParent => {
                f.write_str("the given parent scope does not exist in this organisation")
            }
            Self::NoSuchScope => f.write_str("no such scope in this organisation"),
            Self::NotAMember => {
                f.write_str("the acting account is not a member of this organisation")
            }
            Self::NotAnAdmin => {
                f.write_str("only an administrator of this organisation may do that")
            }
            Self::ConcurrentModification => f.write_str(
                "another transaction changed this part of the hierarchy while this one was \
                 working on it; nothing was changed. Read it again and retry.",
            ),
            Self::WrongKindForParent { expected: None } => {
                f.write_str("this kind of scope may not have a parent")
            }
            Self::WrongKindForParent { expected: Some(k) } => {
                write!(
                    f,
                    "this kind of scope must sit directly under a {}",
                    k.as_str()
                )
            }
            Self::WouldCreateCycle => {
                f.write_str("that move would put a scope under itself or its own descendant")
            }
            Self::Corrupt(what) => write!(f, "a stored {what} did not decode as one"),
        }
    }
}

impl std::error::Error for RepoError {}

// ---------------------------------------------------------------------------
// Tenant context -- see the module doc and `migrations/0002_identity_and_scope.sql`.
// ---------------------------------------------------------------------------

/// Sets the two transaction-local settings every RLS policy in
/// `0002_identity_and_scope.sql` and `0003_write_side_isolation.sql` reads.
///
/// **Only [`create_organisation`] may use this.** Everything else goes
/// through [`authorise`], which will not open a tenant context until a
/// membership row says it may. Creating an organisation is the one case where
/// no such row can exist yet -- the organisation being contextualised does
/// not exist until this transaction creates it -- so the check [`authorise`]
/// makes has nothing to read.
///
/// **`SELECT set_config(name, value, true)`, never `SET LOCAL name = value`.**
/// The two are equivalent for the third argument `true` (`is_local`), but
/// `set_config` is a plain function call, so it can bind `$1`/`$2` as query
/// parameters. `SET` cannot take a bound parameter in its value position --
/// only a literal -- and building that literal by formatting a string into
/// SQL is exactly the injection shape this project avoids everywhere else. As
/// a function call, `is_local = true` scopes the setting to the current
/// transaction; it is gone the instant that transaction ends, commit or
/// rollback, and never visible to whatever request the pool hands this
/// connection to next.
async fn set_tenant_context(
    tx: &Transaction<'_>,
    tenant: OrganisationId,
    actor: Option<AccountId>,
) -> Result<(), RepoError> {
    tx.execute(
        "SELECT set_config('app.tenant_id', $1, true)",
        &[&tenant.to_string()],
    )
    .await?;
    tx.execute(
        "SELECT set_config('app.account_id', $1, true)",
        &[&actor.map(|a| a.to_string()).unwrap_or_default()],
    )
    .await?;
    Ok(())
}

/// Application-layer half of §7's "both, neither alone", and the thing that
/// makes the other half mean something: confirm the acting account really
/// holds a membership row in this tenant, and only then open the tenant
/// context the policies read.
///
/// **The order is the point.** Setting `app.tenant_id` first would make the
/// policies' view of the world a copy of the caller's own argument -- see the
/// module doc. Instead:
///
/// 1. `app.account_id` is set, and nothing else. The only rows visible now
///    are the ones `memberships_readable` shows an account about itself.
/// 2. The membership is read *through* that policy. No row, no context.
/// 3. `app.tenant_id` is set, from a tenant a stored row just vouched for.
///
/// Returns the role, so a caller that needs more than membership -- see
/// [`add_member`] -- can ask for it without a second query.
async fn authorise(
    tx: &Transaction<'_>,
    tenant: OrganisationId,
    actor: AccountId,
) -> Result<Role, RepoError> {
    tx.execute(
        "SELECT set_config('app.account_id', $1, true)",
        &[&actor.to_string()],
    )
    .await?;

    let row = tx
        .query_opt(
            "SELECT role FROM memberships WHERE organisation_id = $1 AND account_id = $2",
            &[&tenant.to_string(), &actor.to_string()],
        )
        .await?
        .ok_or(RepoError::NotAMember)?;
    let role_str: String = row.get(0);
    let role = Role::parse(&role_str).ok_or(RepoError::Corrupt("membership role"))?;

    tx.execute(
        "SELECT set_config('app.tenant_id', $1, true)",
        &[&tenant.to_string()],
    )
    .await?;
    Ok(role)
}

/// **The pinned tenant.** `docs/PHASE-2-STORAGE-DESIGN.md` §4: *"the tenant
/// key is pinned from the authenticated request context for the request's
/// lifetime, and never taken from the row being read. This is what actually
/// preserves cross-tenant separation."*
///
/// That sentence is a rule about code, so it is made into a type. Nothing
/// outside this module can build one — the fields are private and
/// [`open_tenant_context`] is the only constructor — and everything in `keys`
/// and `designs` takes one instead of an `OrganisationId`. There is therefore
/// no signature anywhere in the key hierarchy that could be handed an
/// organisation id read out of a row.
#[derive(Clone, Copy, Debug)]
pub struct TenantContext {
    tenant: OrganisationId,
    actor: AccountId,
    role: Role,
}

impl TenantContext {
    /// The organisation every query in this transaction is scoped to.
    pub fn tenant(&self) -> OrganisationId {
        self.tenant
    }

    /// The account the caller said is acting. See the module doc: there is no
    /// authentication layer yet, and this is not a defence against a caller
    /// that lies about that.
    pub fn actor(&self) -> AccountId {
        self.actor
    }

    /// The acting account's role in this organisation.
    pub fn role(&self) -> Role {
        self.role
    }
}

/// Open a tenant context: [`authorise`], then the design capability, then a
/// value the key hierarchy will accept.
///
/// **`app.design_capability` is set from a verified authorisation and nothing
/// else** (`docs/PHASE-2-ADMIN-AND-AUDIT-DESIGN.md` §11.1). It is set to `no`
/// *before* anything is examined, so a code path that returns early, panics or
/// simply forgets leaves the setting at a refusal — the empty string is
/// already a refusal too, so the failure direction is closed either way. Only
/// a membership row read back through the database's own policy turns it into
/// `yes`, and `design_payload`'s policies in
/// `migrations/0007_key_hierarchy_and_designs.sql` require that exact string.
///
/// **What this capability means today, stated so it is not over-read:**
/// membership of the organisation, and nothing finer. Scope grants
/// (`docs/PHASE-2-ADMIN-AND-AUDIT-DESIGN.md`'s `0005 authority`) do not exist
/// yet; when they do, the narrower check goes here, at this one line, and
/// every query written against `design_payload` in the meantime inherits it
/// without being edited.
pub async fn open_tenant_context(
    tx: &Transaction<'_>,
    tenant: OrganisationId,
    actor: AccountId,
) -> Result<TenantContext, RepoError> {
    tx.execute(
        "SELECT set_config('app.design_capability', 'no', true)",
        &[],
    )
    .await?;

    let role = authorise(tx, tenant, actor).await?;

    tx.execute(
        "SELECT set_config('app.design_capability', 'yes', true)",
        &[],
    )
    .await?;

    Ok(TenantContext {
        tenant,
        actor,
        role,
    })
}

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

/// Creates an account. Not tenant-scoped -- an account belongs to zero or
/// more organisations through [`Membership`], not to one.
///
/// **Two rows, one transaction, and the order is fixed by a foreign key.**
/// `migrations/0004_principals.sql` makes every account a *steward* principal
/// through a composite key onto `principals (id, kind)` whose `kind` half is
/// a generated constant, so the principal row must exist before the account
/// row can. That is the fence that makes an operator id unrepresentable in a
/// membership; the cost is this transaction, and it is the whole cost.
pub async fn create_account(
    pool: &Pool,
    email: &str,
    display_name: &str,
) -> Result<Account, RepoError> {
    let mut client = pool.get().await?;
    let tx = client.transaction().await?;
    let id = AccountId::new();
    tx.execute(
        "INSERT INTO principals (id, kind) VALUES ($1, 'steward')",
        &[&id.to_string()],
    )
    .await?;
    tx.execute(
        "INSERT INTO accounts (id, email, display_name) VALUES ($1, $2, $3)",
        &[&id.to_string(), &email, &display_name],
    )
    .await?;
    tx.commit().await?;
    Ok(Account {
        id,
        email: email.to_string(),
        display_name: display_name.to_string(),
    })
}

// ---------------------------------------------------------------------------
// Organisations and membership
// ---------------------------------------------------------------------------

/// Creates an organisation and makes `creator` its first admin, in one
/// transaction. The new organisation's own id is the tenant context this
/// transaction sets -- there is nothing else it could be, since the row does
/// not exist until this transaction creates it.
pub async fn create_organisation(
    pool: &Pool,
    creator: AccountId,
    display_name: &str,
) -> Result<Organisation, RepoError> {
    let mut client = pool.get().await?;
    let tx = client.transaction().await?;
    let id = OrganisationId::new();
    set_tenant_context(&tx, id, Some(creator)).await?;

    tx.execute(
        "INSERT INTO organisations (id, display_name) VALUES ($1, $2)",
        &[&id.to_string(), &display_name],
    )
    .await?;
    tx.execute(
        "INSERT INTO memberships (account_id, organisation_id, role) VALUES ($1, $2, $3)",
        &[&creator.to_string(), &id.to_string(), &Role::Admin.as_str()],
    )
    .await?;

    tx.commit().await?;
    Ok(Organisation {
        id,
        display_name: display_name.to_string(),
    })
}

/// Adds `member` to `tenant` with `role`.
///
/// **`actor` must be an admin of `tenant`, not merely a member.** This gated
/// only on membership until 2026-09-12, which meant any plain member could
/// add anyone at any role -- including admin, including itself a second time
/// were the primary key not in the way. The two roles exist precisely to
/// "distinguish who may administer an organisation from who may use it"
/// (the brief), and adding members is administering one.
///
/// Row-level security cannot supply this half: the `memberships` policies
/// separate one tenant from another, and this is a question about two
/// accounts inside the *same* tenant. It is an application-layer check by
/// nature, which is why it is written here and stated plainly rather than
/// assumed to be covered.
pub async fn add_member(
    pool: &Pool,
    tenant: OrganisationId,
    actor: AccountId,
    member: AccountId,
    role: Role,
) -> Result<Membership, RepoError> {
    let mut client = pool.get().await?;
    let tx = client.transaction().await?;
    if authorise(&tx, tenant, actor).await? != Role::Admin {
        return Err(RepoError::NotAnAdmin);
    }

    tx.execute(
        "INSERT INTO memberships (account_id, organisation_id, role) VALUES ($1, $2, $3)",
        &[&member.to_string(), &tenant.to_string(), &role.as_str()],
    )
    .await?;

    tx.commit().await?;
    Ok(Membership {
        account_id: member,
        organisation_id: tenant,
        role,
    })
}

/// Every member of `tenant`, for an `actor` who already belongs to it.
pub async fn list_members(
    pool: &Pool,
    tenant: OrganisationId,
    actor: AccountId,
) -> Result<Vec<Membership>, RepoError> {
    let mut client = pool.get().await?;
    let tx = client.transaction().await?;
    authorise(&tx, tenant, actor).await?;

    let rows = tx
        .query(
            "SELECT account_id, organisation_id, role FROM memberships \
             WHERE organisation_id = $1 ORDER BY account_id",
            &[&tenant.to_string()],
        )
        .await?;
    tx.commit().await?;

    rows.iter()
        .map(|row| {
            let account_id: String = row.get(0);
            let organisation_id: String = row.get(1);
            let role: String = row.get(2);
            Ok(Membership {
                account_id: account_id
                    .parse()
                    .map_err(|_| RepoError::Corrupt("account id"))?,
                organisation_id: organisation_id
                    .parse()
                    .map_err(|_| RepoError::Corrupt("organisation id"))?,
                role: Role::parse(&role).ok_or(RepoError::Corrupt("membership role"))?,
            })
        })
        .collect()
}

/// Every organisation `account` belongs to. Deliberately does **not** set a
/// tenant context -- there is no single tenant to set before the caller knows
/// which organisations it has. This is the query the `organisations` and
/// `memberships` RLS policies' `account_id` branch exists for.
pub async fn list_organisations_for_account(
    pool: &Pool,
    account: AccountId,
) -> Result<Vec<Organisation>, RepoError> {
    let mut client = pool.get().await?;
    let tx = client.transaction().await?;
    tx.execute(
        "SELECT set_config('app.account_id', $1, true)",
        &[&account.to_string()],
    )
    .await?;

    let rows = tx
        .query(
            "SELECT o.id, o.display_name FROM organisations o \
             JOIN memberships m ON m.organisation_id = o.id \
             WHERE m.account_id = $1 \
             ORDER BY o.id",
            &[&account.to_string()],
        )
        .await?;
    tx.commit().await?;

    rows.iter()
        .map(|row| {
            let id: String = row.get(0);
            Ok(Organisation {
                id: id
                    .parse()
                    .map_err(|_| RepoError::Corrupt("organisation id"))?,
                display_name: row.get(1),
            })
        })
        .collect()
}

// ---------------------------------------------------------------------------
// Scopes
// ---------------------------------------------------------------------------

/// What a create/move operation needs to know about a prospective parent.
/// Deliberately carries no `depth`: in this fixed three-level hierarchy depth
/// is a pure function of `kind` (enforced by the migration's own `CHECK`),
/// so a move never has to recompute it, only the path.
struct ParentInfo {
    path: String,
    kind: Option<ScopeKind>,
}

/// Reads a prospective parent **and holds it still**.
///
/// # Why `FOR SHARE` and not a plain `SELECT`
///
/// The caller is about to build a path out of `path`, so between reading it
/// and writing the row that embeds it, that text must not change. At READ
/// COMMITTED -- the default, and what this connection uses -- an unlocked
/// read sees the last committed version and nothing stops a `move_subtree`
/// of this very row committing a microsecond later. The child then stores a
/// path built from a prefix that no longer exists, `path` and
/// `parent_scope_id` disagree, and **no constraint catches it and no later
/// operation repairs it**. Reproduced against a real PostgreSQL 2026-09-12;
/// `tests/repo.rs` interleaves the two transactions that produce it.
///
/// `FOR SHARE` is the exact amount of lock that fixes it: every path change
/// to a row is an `UPDATE` of that row, and `FOR SHARE` conflicts with an
/// `UPDATE` while still letting two children be created under one parent at
/// the same time. (A plain `SELECT`'s implicit `FOR KEY SHARE` -- what the
/// foreign key on `parent_scope_id` takes -- is NOT enough: PostgreSQL's
/// `UPDATE` of a non-key column takes `FOR NO KEY UPDATE`, which does not
/// conflict with it. That is precisely how the bug got in.)
async fn fetch_scope_for_parent(
    tx: &Transaction<'_>,
    tenant: OrganisationId,
    id: ScopeId,
) -> Result<ParentInfo, RepoError> {
    let row = tx
        .query_opt(
            "SELECT path, kind FROM scopes WHERE id = $1 AND organisation_id = $2 FOR SHARE",
            &[&id.to_string(), &tenant.to_string()],
        )
        .await?
        .ok_or(RepoError::NoSuchParent)?;
    let kind_str: String = row.get(1);
    Ok(ParentInfo {
        path: row.get(0),
        kind: ScopeKind::parse(&kind_str),
    })
}

fn row_to_scope(row: &Row) -> Result<Scope, RepoError> {
    let id: String = row.get(0);
    let organisation_id: String = row.get(1);
    let parent_scope_id: Option<String> = row.get(2);
    let kind: String = row.get(3);

    Ok(Scope {
        id: id.parse().map_err(|_| RepoError::Corrupt("scope id"))?,
        organisation_id: organisation_id
            .parse()
            .map_err(|_| RepoError::Corrupt("organisation id"))?,
        parent_scope_id: parent_scope_id
            .map(|s| s.parse())
            .transpose()
            .map_err(|_| RepoError::Corrupt("parent scope id"))?,
        kind: ScopeKind::parse(&kind).ok_or(RepoError::Corrupt("scope kind"))?,
        display_name: row.get(4),
        path: row.get(5),
        depth: row.get(6),
    })
}

/// Creates one scope node under `parent` (or as a new root network, if
/// `parent` is `None`), computing its materialised path from the parent's --
/// never from either row's `display_name`.
pub async fn create_scope(
    pool: &Pool,
    tenant: OrganisationId,
    actor: AccountId,
    parent: Option<ScopeId>,
    kind: ScopeKind,
    display_name: &str,
) -> Result<Scope, RepoError> {
    let mut client = pool.get().await?;
    let tx = client.transaction().await?;
    authorise(&tx, tenant, actor).await?;

    let parent_info = match parent {
        Some(p) => Some(fetch_scope_for_parent(&tx, tenant, p).await?),
        None => None,
    };

    let expected = kind.expected_parent_kind();
    let actual = parent_info.as_ref().and_then(|p| p.kind);
    if expected != actual {
        return Err(RepoError::WrongKindForParent { expected });
    }

    let id = ScopeId::new();
    let path = match &parent_info {
        Some(p) => format!("{}.{id}", p.path),
        None => id.to_string(),
    };
    let depth = kind.depth();

    tx.execute(
        "INSERT INTO scopes (id, organisation_id, parent_scope_id, kind, display_name, path, depth) \
         VALUES ($1, $2, $3, $4, $5, $6, $7)",
        &[
            &id.to_string(),
            &tenant.to_string(),
            &parent.map(|p| p.to_string()),
            &kind.as_str(),
            &display_name,
            &path,
            &depth,
        ],
    )
    .await?;

    tx.commit().await?;
    Ok(Scope {
        id,
        organisation_id: tenant,
        parent_scope_id: parent,
        kind,
        display_name: display_name.to_string(),
        path,
        depth,
    })
}

/// Lists `root` and every descendant, by a single prefix match over `path`
/// (`docs/PHASE-2-STORAGE-DESIGN.md` §2).
pub async fn list_subtree(
    pool: &Pool,
    tenant: OrganisationId,
    actor: AccountId,
    root: ScopeId,
) -> Result<Vec<Scope>, RepoError> {
    let mut client = pool.get().await?;
    let tx = client.transaction().await?;
    authorise(&tx, tenant, actor).await?;

    let root_row = tx
        .query_opt(
            "SELECT path FROM scopes WHERE id = $1 AND organisation_id = $2",
            &[&root.to_string(), &tenant.to_string()],
        )
        .await?
        .ok_or(RepoError::NoSuchScope)?;
    let root_path: String = root_row.get(0);

    let rows = tx
        .query(
            "SELECT id, organisation_id, parent_scope_id, kind, display_name, path, depth \
             FROM scopes \
             WHERE organisation_id = $1 AND (path = $2 OR path LIKE $2 || '.%') \
             ORDER BY path",
            &[&tenant.to_string(), &root_path],
        )
        .await?;

    tx.commit().await?;
    rows.iter().map(row_to_scope).collect()
}

/// Moves `scope_id` (and, since its path is a prefix of all of theirs, every
/// descendant) under `new_parent`. `docs/PHASE-2-STORAGE-DESIGN.md` §2:
/// "moving a subtree rewrites every descendant's path" -- this is that
/// rewrite, done as one statement over opaque ids.
pub async fn move_subtree(
    pool: &Pool,
    tenant: OrganisationId,
    actor: AccountId,
    scope_id: ScopeId,
    new_parent: Option<ScopeId>,
) -> Result<(), RepoError> {
    let mut client = pool.get().await?;
    let tx = client.transaction().await?;
    authorise(&tx, tenant, actor).await?;

    // `FOR UPDATE`, and the whole correctness of this function rests on it.
    // The `UPDATE` at the end re-matches this row by the path text read
    // here. Every operation that can change that text is an `UPDATE` of this
    // same row -- a move of ANY ancestor rewrites its descendants, this row
    // among them -- so locking it is what makes read-then-write safe without
    // raising the isolation level. Under READ COMMITTED a blocked
    // `SELECT ... FOR UPDATE` re-reads the committed version once the other
    // transaction ends, so what comes back here is the current path, never a
    // stale one.
    //
    // Without it: a concurrent ancestor move made the final `UPDATE` match
    // zero rows, and this function **returned `Ok(())` having done nothing**
    // -- a caller told the estate of record changed when it had not.
    // Reproduced against a real PostgreSQL 2026-09-12.
    //
    // Two moves racing can now deadlock instead (each holding a row the
    // other wants). PostgreSQL detects that and aborts one with an error,
    // which surfaces as `RepoError::Db`: a loud failure the caller can
    // retry, which is the outcome a silent one was traded for.
    let node = tx
        .query_opt(
            "SELECT kind, path FROM scopes WHERE id = $1 AND organisation_id = $2 FOR UPDATE",
            &[&scope_id.to_string(), &tenant.to_string()],
        )
        .await?
        .ok_or(RepoError::NoSuchScope)?;
    let node_kind_str: String = node.get(0);
    let node_kind = ScopeKind::parse(&node_kind_str).ok_or(RepoError::Corrupt("scope kind"))?;
    let old_path: String = node.get(1);

    if let Some(p) = new_parent {
        if p == scope_id {
            return Err(RepoError::WouldCreateCycle);
        }
    }

    let parent_info = match new_parent {
        Some(p) => Some(fetch_scope_for_parent(&tx, tenant, p).await?),
        None => None,
    };

    let expected = node_kind.expected_parent_kind();
    let actual = parent_info.as_ref().and_then(|p| p.kind);
    if expected != actual {
        return Err(RepoError::WrongKindForParent { expected });
    }

    // Given the fixed depth-per-kind mapping the `WrongKindForParent` check
    // above already enforces, a genuine cycle cannot occur today: a scope may
    // only be parented to the one kind strictly above it, so nothing can ever
    // become its own ancestor. Kept anyway, because
    // `docs/PHASE-2-STORAGE-DESIGN.md` §2 flags variable-depth scopes as a
    // likely future change, and this check must not silently start passing
    // bad input the day that mapping stops being fixed.
    if let Some(p) = &parent_info {
        if p.path == old_path || p.path.starts_with(&format!("{old_path}.")) {
            return Err(RepoError::WouldCreateCycle);
        }
    }

    let new_path = match &parent_info {
        Some(p) => format!("{}.{scope_id}", p.path),
        None => scope_id.to_string(),
    };

    // One statement covers `scope_id` and every descendant: both match
    // `path = old_path OR path LIKE old_path || '.%'`. `substring` keeps
    // whatever text followed the old prefix (empty, for the node itself; the
    // rest of the path, for a descendant) and reattaches it to the new
    // prefix. `depth` is untouched: it is a pure function of `kind`
    // (network=1, building=2, rack=3, enforced by the migration's `CHECK`),
    // and a move never changes any row's `kind`, only where it sits.
    let changed = tx
        .execute(
            "UPDATE scopes \
             SET path = $1 || substring(path from char_length($2) + 1), \
                 parent_scope_id = CASE WHEN id = $3 THEN $4 ELSE parent_scope_id END \
             WHERE organisation_id = $5 AND (path = $2 OR path LIKE $2 || '.%')",
            &[
                &new_path,
                &old_path,
                &scope_id.to_string(),
                &new_parent.map(|p| p.to_string()),
                &tenant.to_string(),
            ],
        )
        .await?;

    // The row lock above should make this unreachable: this statement must
    // match at least the node itself, whose path was read under that lock.
    // Kept because the alternative to checking is returning `Ok(())` for a
    // write that did nothing, and that is the failure this function actually
    // had. A guard that never fires costs one integer comparison; the bug it
    // guards against cost a silently unmoved subtree.
    if changed == 0 {
        return Err(RepoError::ConcurrentModification);
    }

    tx.commit().await?;
    Ok(())
}
