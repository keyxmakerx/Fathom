//! The repository layer: accounts, organisations, membership, and the scope
//! hierarchy (`organisation -> network -> building -> rack`).
//!
//! Low-sensitivity, queryable data (`docs/PHASE-2-STORAGE-DESIGN.md` §1). Nothing
//! here writes a design payload, credential or wrapped key. It also provides
//! [`TenantContext`], the pinned tenant that `keys` and `designs` take instead of a
//! bare organisation id (§4).
//!
//! # Tenant isolation, done twice
//!
//! §7: row-level security **and** application filtering. Every function touching
//! `organisations`, `memberships` or `scopes` opens its own transaction, calls
//! [`authorise`] (two transaction-scoped settings, per `src/db.rs`: nothing may
//! depend on which pooled connection a request gets), and also names the tenant in
//! every `WHERE`. RLS backstops a missing clause; it is not the only barrier.
//!
//! ## What the second layer is not
//!
//! Both layers rest on a `tenant` and `actor` this module is handed. There is no
//! authentication layer here (`docs/OPEN-QUESTIONS.md` B1-B9, C2), so callers are
//! trusted to name the acting account truthfully.
//!
//! [`authorise`] sets `app.tenant_id` only **after** a membership row is read back
//! under the acting account's own identity (`memberships_readable`, migration
//! 0003), so the setting is a value the database agreed to, not a copy of the
//! caller's argument. RLS thus filters *the clause that goes missing* (§7); it does
//! not defend against a caller that lies about who is acting. That is
//! authentication's job.

use core::fmt;
use core::str::FromStr;

use deadpool_postgres::{Pool, PoolError, Transaction};
use tokio_postgres::Row;

use fathom_id::{DecodeError, Ulid};

use crate::ids::new_ulid;

// ---- Identifiers ----

macro_rules! ulid_id {
    ($(#[$doc:meta])* $name:ident) => {
        $(#[$doc])*
        #[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
        pub struct $name(pub Ulid);

        impl $name {
            // `pub(crate)`: `designs` mints a `DesignId` through this macro, so every id in
            // the server is minted in one place.
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
    /// An organisation's id: the tenant boundary.
    OrganisationId
);
ulid_id!(
    /// A scope node's id: one row in the `organisation -> network -> building -> rack`
    /// hierarchy.
    ScopeId
);
ulid_id!(
    /// A design's id. Opaque, and the only way a design is addressed server-side:
    /// `designs` has no name column, since a plaintext one would be the side door
    /// `docs/PHASE-2-STORAGE-DESIGN.md` §11.3 cost 3 names.
    DesignId
);

ulid_id!(
    /// A staged firmware image's id (ADR-0045, migration `0017`).
    ///
    /// **This id is also the file's name on disk.** A ULID is 26 Crockford base32
    /// characters, so it holds no separator, dot or `..`. `firmware::storage_name`
    /// re-validates that alphabet before joining it to a directory, and `0017`'s
    /// `CHECK` says the same.
    FirmwareImageId
);

// ---- Small enums ----

/// Deliberately minimal: enough to tell who may administer an organisation from
/// who may use it.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Role {
    Admin,
    Member,
}

impl Role {
    pub(crate) fn as_str(self) -> &'static str {
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

/// The three levels beneath an organisation (`docs/PHASE-2-STORAGE-DESIGN.md` §2).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum ScopeKind {
    Network,
    Building,
    Rack,
}

impl ScopeKind {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Network => "network",
            Self::Building => "building",
            Self::Rack => "rack",
        }
    }

    pub(crate) fn parse(s: &str) -> Option<Self> {
        match s {
            "network" => Some(Self::Network),
            "building" => Some(Self::Building),
            "rack" => Some(Self::Rack),
            _ => None,
        }
    }

    /// The kind a parent of this kind must have. `None` means no parent: only a
    /// network may be a root.
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

// ---- Rows ----

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
    /// The materialised path: opaque scope ids, dot-separated, root first, ending in
    /// `id`. Never a name.
    pub path: String,
    pub depth: i16,
}

// ---- Errors ----

#[derive(Debug)]
pub enum RepoError {
    Pool(PoolError),
    Db(tokio_postgres::Error),
    NoSuchParent,
    NoSuchScope,
    /// The acting account is not a member of the tenant. Application-layer filtering
    /// on top of RLS (§7).
    NotAMember,
    /// A member, but the operation needs an administrator.
    NotAnAdmin,
    /// A row this transaction read and then wrote was changed by another transaction,
    /// and the write matched nothing. **Returned rather than `Ok(())`**: reporting
    /// success for an estate-of-record change that did not happen is worse than
    /// asking for a retry.
    ConcurrentModification,
    /// A scope of this kind may not sit under a parent of the kind given (or under no
    /// parent, if `expected` is `None`).
    WrongKindForParent {
        expected: Option<ScopeKind>,
    },
    /// Moving a scope under itself or one of its descendants.
    WouldCreateCycle,
    /// A row this process wrote could not be read back as what it should be. Should
    /// be unreachable given the migration's `CHECK`s; explicit rather than a panic.
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

// ---- Tenant context (module doc; `migrations/0002_identity_and_scope.sql`) ----

/// Sets the two transaction-local settings every RLS policy in `0002` and `0003`
/// reads.
///
/// **Only [`create_organisation`] may use this**: everything else goes through
/// [`authorise`], and a new organisation has no membership row yet.
///
/// **`SELECT set_config(name, value, true)`, never `SET LOCAL`.** `set_config` binds
/// `$1`/`$2` as parameters, while `SET` takes only a literal (formatting one into
/// SQL is the injection shape this project avoids). `is_local = true` drops the
/// setting at commit or rollback, so it never leaks to the next request on the
/// connection.
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

/// The application-layer half of §7: confirm the acting account holds a membership
/// row in this tenant, and only then open the tenant context.
///
/// **The order is the point**: setting `app.tenant_id` first would make the
/// policies' view a copy of the caller's argument.
///
/// 1. Set `app.account_id` only; `memberships_readable` then shows an account just
///    its own rows.
/// 2. Read the membership *through* that policy. No row, no context.
/// 3. Set `app.tenant_id`, from a tenant a stored row just vouched for.
///
/// Returns the role, so [`add_member`] needs no second query.
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

/// **The pinned tenant.** §4: *"the tenant key is pinned from the authenticated
/// request context for the request's lifetime, and never taken from the row being
/// read."* Made a type: fields are private, [`open_tenant_context`] is the only
/// constructor, and `keys` and `designs` take one instead of an `OrganisationId`,
/// so no signature in the key hierarchy can be handed an id read out of a row.
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

    /// The account the caller said is acting. Not a defence against a caller that
    /// lies about that (module doc).
    pub fn actor(&self) -> AccountId {
        self.actor
    }

    /// The acting account's role in this organisation.
    pub fn role(&self) -> Role {
        self.role
    }
}

/// Open a tenant context: [`authorise`], then the design capability, then a value
/// the key hierarchy will accept.
///
/// **`app.design_capability` is set from a verified authorisation and nothing
/// else** (`docs/PHASE-2-ADMIN-AND-AUDIT-DESIGN.md` §11.1). It is set to `no` first,
/// so an early return, panic or omission leaves a refusal (empty refuses too). Only
/// a membership row read back through the database's own policy turns it into
/// `yes`, and `design_payload`'s policies
/// (`migrations/0007_key_hierarchy_and_designs.sql`) require that exact string.
///
/// Today it means organisation membership and nothing finer. When scope grants
/// exist, the narrower check goes here and every `design_payload` query inherits it.
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

// ---- The one context not built from a membership row ----

/// Turn on `app.key_custody` for the rest of this transaction, so `tenant_keys` can
/// be **enumerated** deployment-wide.
///
/// Reasoning: `migrations/0010_entry_type_belongs_to_kind.sql` §F (which calls this
/// `repo::open_key_custody_context`). One active master key per database makes a
/// re-wrap deployment-wide, and re-wrapping only some tenants would leave the rest
/// openable under neither key. Every key table is `FORCE ROW LEVEL SECURITY` keyed
/// on `app.tenant_id`, which with no tenant set silently returns zero rows.
///
/// **The only caller is `keys::rewrap_master_key`**, unreachable from any request
/// path; the policy is `FOR SELECT` on one table.
///
/// **This is not a second way to read designs**: it unlocks `tenant_keys` only (each
/// row a wrapped key whose wrapping key is not in this database), and
/// `app.design_capability` stays at its refusal.
pub(crate) async fn enter_key_custody(tx: &Transaction<'_>) -> Result<(), RepoError> {
    tx.execute(
        "SELECT set_config('app.design_capability', 'no', true)",
        &[],
    )
    .await?;
    tx.execute("SELECT set_config('app.key_custody', 'yes', true)", &[])
        .await?;
    Ok(())
}

/// Point the tenant-scoped policies at one organisation for **§1.1's operator
/// suspend verb**, which has no membership to open a context from.
///
/// `grants::suspend_grant_by_operator` is the only caller; the argument for the
/// crossing is on `keys::tenant_key_for`. `app.design_capability` is set to its
/// refusal FIRST and never to anything else on this path, so an operator
/// transaction naming a tenant still reaches no design payload (§1.3's
/// sightlessness).
pub(crate) async fn enter_operator_tenant_scope(
    tx: &Transaction<'_>,
    tenant: &str,
) -> Result<(), RepoError> {
    tx.execute(
        "SELECT set_config('app.design_capability', 'no', true)",
        &[],
    )
    .await?;
    set_custody_tenant(tx, tenant).await
}

/// Point the tenant-scoped policies at one organisation during a deployment-wide
/// key custody change.
///
/// No membership exists to check, so this is a separate function, not a flag on
/// [`open_tenant_context`]. A re-wrap is an operator act; borrowing a steward's
/// identity to sign the entry would put a false actor in the one record that must
/// not contain any. The organisation id comes from [`enter_key_custody`]'s
/// enumeration in the same transaction, never a request. `app.account_id` is set to
/// the empty string, which every policy treats as a refusal.
pub(crate) async fn set_custody_tenant(
    tx: &Transaction<'_>,
    tenant: &str,
) -> Result<(), RepoError> {
    tx.execute("SELECT set_config('app.account_id', '', true)", &[])
        .await?;
    tx.execute("SELECT set_config('app.tenant_id', $1, true)", &[&tenant])
        .await?;
    Ok(())
}

// ---- Accounts ----

/// Creates an account. Not tenant-scoped: it belongs to organisations through
/// [`Membership`].
///
/// **Two rows, one transaction, in a foreign-key order.**
/// `migrations/0004_principals.sql` makes every account a *steward* principal via a
/// composite key onto `principals (id, kind)` with a generated `kind`, so the
/// principal row comes first. That fence makes an operator id unrepresentable in a
/// membership.
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

// ---- Organisations and membership ----

/// Creates an organisation and makes `creator` its first admin, in one
/// transaction. The new organisation's own id is the tenant context set.
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

/// The half of [`create_organisation`] taking an **id and an open transaction**, for
/// `grants::bootstrap_organisation`.
///
/// `docs/PHASE-2-ADMIN-AND-AUDIT-DESIGN.md` §6.1 derives an organisation's id from
/// its root public key and a salt, so genesis cannot use [`OrganisationId::new`],
/// and needs one transaction: root row, genesis grants, chain entries and authority
/// head all commit with this row or none do.
///
/// `pub(crate)`. What keeps it honest is elsewhere: `grants::authorise_account`
/// recomputes the id from `organisation_roots` at every authorisation and refuses a
/// mismatch with `authority::derive_organisation_id` (§3.4 step 5).
pub(crate) async fn create_organisation_in(
    tx: &Transaction<'_>,
    id: OrganisationId,
    creator: AccountId,
    display_name: &str,
) -> Result<(), RepoError> {
    set_tenant_context(tx, id, Some(creator)).await?;
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
    Ok(())
}

/// Adds `member` to `tenant` with `role`.
///
/// **`actor` must be an admin of `tenant`, not merely a member**, or any member
/// could add anyone at any role. RLS cannot supply this: its policies separate
/// tenants, and this question is about two accounts inside one. It is an
/// application-layer check.
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

/// ADR-0057 decision 8: confirms `actor` administers `tenant`. `Err(NotAnAdmin)`
/// for a plain member, `Err(NotAMember)` for nobody. `actor` stays text:
/// `tests/sessions.rs` refuses any route that constructs an `AccountId` except
/// through a verified session.
pub async fn require_admin(
    pool: &Pool,
    tenant: OrganisationId,
    actor: &str,
) -> Result<(), RepoError> {
    let actor: AccountId = actor
        .parse()
        .map_err(|_| RepoError::Corrupt("account id"))?;
    let mut client = pool.get().await?;
    let tx = client.transaction().await?;
    let role = authorise(&tx, tenant, actor).await?;
    tx.commit().await?;
    if role != Role::Admin {
        return Err(RepoError::NotAnAdmin);
    }
    Ok(())
}

/// As [`require_admin`], and confirms `target` belongs to `tenant`, read through
/// `authorise`'s own opened `memberships` rows. Returns the CANONICAL target id:
/// `Ulid::decode` accepts lowercase, but later session acts filter on the stored
/// canonical form, so raw caller text in another case would match no row.
pub async fn require_admin_over_member(
    pool: &Pool,
    tenant: OrganisationId,
    actor: &str,
    target: &str,
) -> Result<String, RepoError> {
    let actor: AccountId = actor
        .parse()
        .map_err(|_| RepoError::Corrupt("account id"))?;
    let target: AccountId = target
        .parse()
        .map_err(|_| RepoError::Corrupt("account id"))?;
    let mut client = pool.get().await?;
    let tx = client.transaction().await?;
    if authorise(&tx, tenant, actor).await? != Role::Admin {
        return Err(RepoError::NotAnAdmin);
    }
    let exists = tx
        .query_opt(
            "SELECT 1 FROM memberships WHERE organisation_id = $1 AND account_id = $2",
            &[&tenant.to_string(), &target.to_string()],
        )
        .await?
        .is_some();
    tx.commit().await?;
    if !exists {
        return Err(RepoError::NotAMember);
    }
    Ok(target.to_string())
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

/// The transaction half of [`list_organisations_for_account`], for `design_api`'s
/// `GET /organisations`, which already has a verified session's transaction.
/// `pub(crate)`. Sets `app.account_id` only, as the wrapper does (see there). One
/// copy of the SQL.
///
/// Each organisation carries `account`'s own [`Role`], so the home screen offers its
/// Organisation tab only to those who may administer it (ADR-0060 decision 7): a
/// display hint, not an authorisation.
pub(crate) async fn list_organisations_for_account_in(
    tx: &Transaction<'_>,
    account: AccountId,
) -> Result<Vec<(Organisation, Role)>, RepoError> {
    tx.execute(
        "SELECT set_config('app.account_id', $1, true)",
        &[&account.to_string()],
    )
    .await?;

    let rows = tx
        .query(
            "SELECT o.id, o.display_name, m.role FROM organisations o \
             JOIN memberships m ON m.organisation_id = o.id \
             WHERE m.account_id = $1 \
             ORDER BY o.id",
            &[&account.to_string()],
        )
        .await?;

    rows.iter()
        .map(|row| {
            let id: String = row.get(0);
            let role: String = row.get(2);
            Ok((
                Organisation {
                    id: id
                        .parse()
                        .map_err(|_| RepoError::Corrupt("organisation id"))?,
                    display_name: row.get(1),
                },
                Role::parse(&role).ok_or(RepoError::Corrupt("membership role"))?,
            ))
        })
        .collect()
}

/// Every organisation `account` belongs to. Deliberately sets **no** tenant
/// context: there is no single tenant before the caller knows its organisations.
/// This is what the `account_id` branch of the `organisations` and `memberships`
/// RLS policies exists for.
pub async fn list_organisations_for_account(
    pool: &Pool,
    account: AccountId,
) -> Result<Vec<Organisation>, RepoError> {
    let mut client = pool.get().await?;
    let tx = client.transaction().await?;
    let organisations = list_organisations_for_account_in(&tx, account).await?;
    tx.commit().await?;
    Ok(organisations.into_iter().map(|(o, _)| o).collect())
}

// ---- Scopes ----

/// What a create/move needs to know about a prospective parent. Carries no
/// `depth`: in this fixed hierarchy depth is a function of `kind` (migration
/// `CHECK`), so a move recomputes only the path.
struct ParentInfo {
    path: String,
    kind: Option<ScopeKind>,
}

/// Reads a prospective parent **and holds it still**.
///
/// # Why `FOR SHARE` and not a plain `SELECT`
///
/// The caller builds a path from `path`, which must not change between reading it
/// and writing the row that embeds it. At READ COMMITTED an unlocked read lets a
/// `move_subtree` of this row commit in between; the child then stores a stale
/// prefix, `path` and `parent_scope_id` disagree, and **no constraint catches it
/// and nothing repairs it** (`tests/repo.rs` interleaves the transactions).
///
/// `FOR SHARE` conflicts with the `UPDATE` every path change is, yet lets two
/// children be created under one parent concurrently. A plain `SELECT`'s implicit
/// `FOR KEY SHARE` (from the `parent_scope_id` foreign key) is NOT enough: an
/// `UPDATE` of a non-key column takes `FOR NO KEY UPDATE`, which does not conflict.
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

/// Creates one scope node under `parent` (or a new root network if `None`),
/// computing its materialised path from the parent's, never from a
/// `display_name`.
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
    let scope = create_scope_in_tx(&tx, tenant, parent, kind, display_name).await?;
    tx.commit().await?;
    Ok(scope)
}

/// The insert half of [`create_scope`], in a transaction the caller has open.
///
/// `design_api`'s scope-creation route (`docs/PHASE-2-ADMIN-AND-AUDIT-DESIGN.md`
/// §6.4) authorises the *steward* capability itself through
/// `grants::authorise_account` against the parent scope (or the organisation, for
/// a new root network). That is stronger than [`create_scope`]'s plain membership
/// check, and a second transaction here would loosen it. `pub(crate)`.
pub(crate) async fn create_scope_in_tx(
    tx: &Transaction<'_>,
    tenant: OrganisationId,
    parent: Option<ScopeId>,
    kind: ScopeKind,
    display_name: &str,
) -> Result<Scope, RepoError> {
    let parent_info = match parent {
        Some(p) => Some(fetch_scope_for_parent(tx, tenant, p).await?),
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

/// Lists `root` and every descendant by one prefix match over `path`
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

/// Moves `scope_id` and, since its path is a prefix of theirs, every descendant
/// under `new_parent`: one statement over opaque ids
/// (`docs/PHASE-2-STORAGE-DESIGN.md` §2).
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

    // `FOR UPDATE`; this function's correctness rests on it. The final `UPDATE`
    // re-matches this row by the path text read here, and any change to that text is
    // an `UPDATE` of this row (a move of ANY ancestor rewrites its descendants). Under
    // READ COMMITTED a blocked `SELECT ... FOR UPDATE` re-reads the committed version,
    // so the path is current. Without it a concurrent ancestor move made the `UPDATE`
    // match zero rows and this **returned `Ok(())` having done nothing**.
    //
    // Two racing moves can deadlock; PostgreSQL aborts one as `RepoError::Db`, a loud
    // failure the caller can retry.
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

    // A genuine cycle cannot occur today: the `WrongKindForParent` check above means
    // a scope is only parented to the kind strictly above it. Kept because
    // `docs/PHASE-2-STORAGE-DESIGN.md` §2 flags variable-depth scopes as a likely
    // change, and this must not start passing bad input then.
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
    // `path = old_path OR path LIKE old_path || '.%'`. `substring` keeps the text
    // after the old prefix and reattaches it to the new one. `depth` is untouched: it
    // is a function of `kind` (network=1, building=2, rack=3, migration `CHECK`),
    // and a move never changes `kind`.
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

    // The row lock should make this unreachable: the statement must match at least
    // the node itself. Kept because the alternative is returning `Ok(())` for a
    // write that did nothing.
    if changed == 0 {
        return Err(RepoError::ConcurrentModification);
    }

    tx.commit().await?;
    Ok(())
}
