//! The IP plan store (ADR-0083): aggregates, prefixes, ranges, addresses,
//! reservations, VRFs, route targets, VLAN groups and VLANs, ASN ranges and
//! ASNs, kept per organisation on the server beside the designs.
//!
//! # What a record is
//!
//! One `plan`-layer kind of `schema/schema.yaml` (`IpamPrefix`, …) and its
//! fields, keyed by field name. Every value is checked by the same canonical
//! parser a design's field is (`fathom_ir`'s `slot_from_canon`), so a prefix
//! with host bits or a VLAN ID of 5000 is refused here exactly as in a design.
//! The store never writes to a design, and nothing in a design writes here
//! (decision 2).
//!
//! # What is stored, and what the database can learn
//!
//! A record's fields are sealed under a key derived from the tenant key with
//! this store's own label ([`IpamKeys`]), as the estate index's rows are
//! (ADR-0079 decision 3). In the clear: the record's id, its kind, its folder
//! (a scope id, as a design's own `scope_id` is) and a version counter. Two
//! keyed hashes go beside it:
//!
//! - **The space of a block**, its VRF and network, for a record in a VRF that
//!   enforces unique space and for anything handed out by next free. A unique
//!   key on it makes a duplicate impossible even if two servers race
//!   (decision 5). The database learns which records share a network.
//! - **The allocation key** of what asked for a block (`W-1042/wan`): the same
//!   key from the same parent gives the same block back; from another parent it
//!   is refused (decision 5).
//!
//! # Next free, once
//!
//! [`allocate`] takes a transaction-level advisory lock on the parent block, so
//! two requests on one parent, from any number of servers, run one after the
//! other; the second sees the first's block and steps past it.
//!
//! # Who may do what (decision 1)
//!
//! Read on a record's folder to see it; Draw on that folder to plan inside it,
//! reserve or release a reservation one holds; Steward to make or change
//! aggregates, VRFs, route targets, VLAN groups and ASN ranges, and to release
//! someone else's reservation. A record with no folder belongs to the
//! organisation, and the organisation-wide grant decides.

use std::collections::{BTreeMap, BTreeSet};
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

use deadpool_postgres::Transaction;
use fathom_canon::Json;
use fathom_ir::bag::FieldKey;
use fathom_ir::generated::accessors::slot_from_canon;
use fathom_ir::generated::ir_types::{NodeKind, FIELD_KEYS};
use fathom_ir::scalar::{self as ir, Scalar};

use crate::authority::Capability;
use crate::chain::EntryType;
use crate::chains;
use crate::crypto::{self, Key32};
use crate::grants::{self, Authority, AuthorityError};
use crate::keys::DataKey;
use crate::repo::ScopeId;

/// How long a reservation is held when the person reserving names no end
/// (decision 3).
pub const DEFAULT_HOLD_DAYS: i64 = 30;

/// The most records one organisation's plan holds. A bound, so one list or one
/// allocation never opens an unbounded number of sealed rows.
pub const MAX_RECORDS: i64 = 100_000;

/// The most addresses next free walks inside one IPv6 block before it stops
/// and says so. An IPv6 /64 has 2^64 addresses; nothing lists them (decision 4).
const V6_ADDRESS_WALK: u32 = 4096;

// ---------------------------------------------------------------------------
// Kinds and their fields, as `schema/schema.yaml` declares them
// ---------------------------------------------------------------------------

/// How many values a field takes, from the schema's `card`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Card {
    One,
    Optional,
    Many,
    OneOrMore,
}

/// One field of a plan kind.
#[derive(Debug)]
pub struct FieldSpec {
    pub name: &'static str,
    pub card: Card,
    /// For an inline enum, its declared tokens: the store refuses anything
    /// else, though the generated enum would carry it as `Unknown`.
    pub tokens: &'static [&'static str],
}

const fn f(name: &'static str, card: Card) -> FieldSpec {
    FieldSpec {
        name,
        card,
        tokens: &[],
    }
}

const fn e(name: &'static str, card: Card, tokens: &'static [&'static str]) -> FieldSpec {
    FieldSpec { name, card, tokens }
}

use Card::{Many, One, OneOrMore, Optional};

/// A plan kind. The clear `kind` column holds [`Kind::token`].
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Kind {
    Vrf,
    RouteTarget,
    Aggregate,
    Prefix,
    Range,
    Address,
    Reservation,
    VlanGroup,
    Vlan,
    AsnRange,
    Asn,
}

impl Kind {
    pub const ALL: [Kind; 11] = [
        Kind::Vrf,
        Kind::RouteTarget,
        Kind::Aggregate,
        Kind::Prefix,
        Kind::Range,
        Kind::Address,
        Kind::Reservation,
        Kind::VlanGroup,
        Kind::Vlan,
        Kind::AsnRange,
        Kind::Asn,
    ];

    pub fn token(self) -> &'static str {
        match self {
            Kind::Vrf => "vrf",
            Kind::RouteTarget => "route_target",
            Kind::Aggregate => "aggregate",
            Kind::Prefix => "prefix",
            Kind::Range => "range",
            Kind::Address => "address",
            Kind::Reservation => "reservation",
            Kind::VlanGroup => "vlan_group",
            Kind::Vlan => "vlan",
            Kind::AsnRange => "asn_range",
            Kind::Asn => "asn",
        }
    }

    pub fn from_token(token: &str) -> Option<Kind> {
        Kind::ALL.into_iter().find(|k| k.token() == token)
    }

    pub fn node_kind(self) -> NodeKind {
        match self {
            Kind::Vrf => NodeKind::IpamVrf,
            Kind::RouteTarget => NodeKind::IpamRouteTarget,
            Kind::Aggregate => NodeKind::IpamAggregate,
            Kind::Prefix => NodeKind::IpamPrefix,
            Kind::Range => NodeKind::IpamRange,
            Kind::Address => NodeKind::IpamAddress,
            Kind::Reservation => NodeKind::IpamReservation,
            Kind::VlanGroup => NodeKind::IpamVlanGroup,
            Kind::Vlan => NodeKind::IpamVlan,
            Kind::AsnRange => NodeKind::IpamAsnRange,
            Kind::Asn => NodeKind::IpamAsn,
        }
    }

    /// The capability on the record's folder that making, changing or deleting
    /// one needs (decision 1). Releasing someone else's reservation needs
    /// Steward too; [`delete`] checks that.
    pub fn to_change(self) -> Capability {
        match self {
            Kind::Vrf | Kind::RouteTarget | Kind::Aggregate | Kind::VlanGroup | Kind::AsnRange => {
                Capability::Steward
            }
            _ => Capability::Draw,
        }
    }

    /// The fields `schema/schema.yaml` declares for this kind, in its order.
    /// `tests::fields_match_the_schema` holds this against the generated schema.
    pub fn fields(self) -> &'static [FieldSpec] {
        const PREFIX_STATUS: &[&str] = &["container", "active", "reserved", "deprecated"];
        const STATUS: &[&str] = &["active", "reserved", "deprecated"];
        const ADDRESS_STATUS: &[&str] = &["active", "reserved", "deprecated", "dhcp", "slaac"];
        const ADDRESS_ROLE: &[&str] = &[
            "loopback",
            "secondary",
            "anycast",
            "vip",
            "vrrp",
            "hsrp",
            "glbp",
            "carp",
        ];
        static VRF: [FieldSpec; 6] = [
            f("name", One),
            f("route_distinguisher", Optional),
            f("enforce_unique", One),
            f("import_targets", Many),
            f("export_targets", Many),
            f("note", Optional),
        ];
        static ROUTE_TARGET: [FieldSpec; 2] = [f("value", One), f("note", Optional)];
        static AGGREGATE: [FieldSpec; 4] = [
            f("prefix", One),
            f("rir", Optional),
            f("folder", Optional),
            f("note", Optional),
        ];
        static PREFIX: [FieldSpec; 9] = [
            f("prefix", One),
            f("vrf", Optional),
            e("status", One, PREFIX_STATUS),
            f("is_pool", One),
            f("mark_utilised", One),
            f("role", Optional),
            f("folder", Optional),
            f("vlan", Optional),
            f("note", Optional),
        ];
        static RANGE: [FieldSpec; 8] = [
            f("range", One),
            f("vrf", Optional),
            e("status", One, STATUS),
            f("populated", One),
            f("mark_utilised", One),
            f("role", Optional),
            f("folder", Optional),
            f("note", Optional),
        ];
        static ADDRESS: [FieldSpec; 9] = [
            f("address", One),
            f("vrf", Optional),
            e("status", One, ADDRESS_STATUS),
            e("role", Optional, ADDRESS_ROLE),
            f("dns_name", Optional),
            f("nat_outside", Optional),
            f("meant_for", Optional),
            f("folder", Optional),
            f("note", Optional),
        ];
        static RESERVATION: [FieldSpec; 14] = [
            f("prefix", Optional),
            f("range", Optional),
            f("address", Optional),
            f("vrf", Optional),
            f("holder", Optional),
            f("work", Optional),
            f("reason", One),
            f("ends", One),
            f("allocation_key", Optional),
            f("parent", Optional),
            f("dns_name", Optional),
            f("nat_outside", Optional),
            f("folder", Optional),
            f("note", Optional),
        ];
        static VLAN_GROUP: [FieldSpec; 4] = [
            f("name", One),
            f("vid_ranges", OneOrMore),
            f("folder", Optional),
            f("note", Optional),
        ];
        static VLAN: [FieldSpec; 7] = [
            f("group", One),
            f("vid", One),
            f("name", One),
            e("status", One, STATUS),
            f("allocation_key", Optional),
            f("folder", Optional),
            f("note", Optional),
        ];
        static ASN_RANGE: [FieldSpec; 6] = [
            f("name", One),
            f("first", One),
            f("last", One),
            f("rir", Optional),
            f("folder", Optional),
            f("note", Optional),
        ];
        static ASN: [FieldSpec; 6] = [
            f("asn", One),
            f("range", Optional),
            f("meant_for", Optional),
            f("allocation_key", Optional),
            f("folder", Optional),
            f("note", Optional),
        ];
        match self {
            Kind::Vrf => &VRF,
            Kind::RouteTarget => &ROUTE_TARGET,
            Kind::Aggregate => &AGGREGATE,
            Kind::Prefix => &PREFIX,
            Kind::Range => &RANGE,
            Kind::Address => &ADDRESS,
            Kind::Reservation => &RESERVATION,
            Kind::VlanGroup => &VLAN_GROUP,
            Kind::Vlan => &VLAN,
            Kind::AsnRange => &ASN_RANGE,
            Kind::Asn => &ASN,
        }
    }
}

fn field_key(kind: Kind, field: &str) -> Option<FieldKey> {
    let qualified = format!("{}.{field}", kind.node_kind().name());
    FIELD_KEYS
        .iter()
        .find(|(name, _)| *name == qualified)
        .map(|(_, key)| FieldKey(*key))
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/// Why the store refused.
#[derive(Debug)]
pub enum IpamError {
    /// The request's shape or a value is wrong; the text says which, in words a
    /// person can act on.
    Invalid(String),
    /// No such record, or one the caller may not see.
    NotFound,
    /// The record changed since the caller read it.
    Stale,
    /// The same network is already in this space (a VRF that enforces unique
    /// space, or a block handed out by next free).
    Clash,
    /// The allocation key was used before, from another parent.
    KeyUsedElsewhere,
    /// Nothing free of the size asked for.
    Full,
    /// Another record names this one (a VRF its prefixes, a group its VLANs).
    InUse(String),
    /// A permission answer, or an integrity fault in the authority store.
    Authority(AuthorityError),
    Db(tokio_postgres::Error),
    /// A sealed record did not open, or a stored value did not parse.
    Corrupt(&'static str),
}

impl std::fmt::Display for IpamError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            IpamError::Invalid(why) => write!(f, "{why}"),
            IpamError::NotFound => write!(f, "no such record"),
            IpamError::Stale => write!(f, "it changed since you read it"),
            IpamError::Clash => write!(f, "that network is already planned in this space"),
            IpamError::KeyUsedElsewhere => {
                write!(f, "that allocation key was already used from another block")
            }
            IpamError::Full => write!(f, "nothing of that size is free there"),
            IpamError::InUse(why) => write!(f, "{why}"),
            IpamError::Authority(e) => write!(f, "{e}"),
            IpamError::Db(e) => write!(f, "{e}"),
            IpamError::Corrupt(what) => write!(f, "{what} did not read back"),
        }
    }
}

impl From<tokio_postgres::Error> for IpamError {
    fn from(e: tokio_postgres::Error) -> Self {
        IpamError::Db(e)
    }
}

impl From<AuthorityError> for IpamError {
    fn from(e: AuthorityError) -> Self {
        IpamError::Authority(e)
    }
}

fn invalid(why: impl Into<String>) -> IpamError {
    IpamError::Invalid(why.into())
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/// A record's fields, by name, in canonical form. Absent optional fields are
/// left out; a `0..n` field with no values is left out.
pub type Fields = BTreeMap<String, Json>;

/// Check `fields` against `kind`'s declaration and return them canonical.
///
/// Every value goes through the schema's own parser for its key, so the store
/// and a design can never disagree about what a valid prefix is. `null` means
/// absent. A required field must be present; an unknown field name is refused.
pub fn validate(kind: Kind, fields: &Fields) -> Result<Fields, IpamError> {
    let specs = kind.fields();
    for name in fields.keys() {
        if !specs.iter().any(|s| s.name == name) {
            return Err(invalid(format!(
                "{} has no field \"{name}\"",
                kind.node_kind().name()
            )));
        }
    }
    let mut out = Fields::new();
    for spec in specs {
        let value = match fields.get(spec.name) {
            None | Some(Json::Null) => None,
            Some(v) => Some(v),
        };
        let key = field_key(kind, spec.name).ok_or(IpamError::Corrupt("the field-key registry"))?;
        let check_one = |v: &Json| -> Result<(), IpamError> {
            if !spec.tokens.is_empty() {
                return match v {
                    Json::Str(t) if spec.tokens.contains(&t.as_str()) => Ok(()),
                    _ => Err(invalid(format!(
                        "{} must be one of {}",
                        spec.name,
                        spec.tokens.join(", ")
                    ))),
                };
            }
            slot_from_canon(key, v)
                .map(|_| ())
                .map_err(|why| invalid(format!("{} is not valid here: {why:?}", spec.name)))
        };
        match (spec.card, value) {
            (One, None) | (OneOrMore, None) => {
                return Err(invalid(format!("{} is required", spec.name)));
            }
            (Optional, None) | (Many, None) => {}
            (One | Optional, Some(v)) => {
                check_one(v)?;
                out.insert(spec.name.to_string(), v.clone());
            }
            (Many | OneOrMore, Some(Json::Arr(items))) => {
                if items.is_empty() {
                    if spec.card == OneOrMore {
                        return Err(invalid(format!("{} needs at least one value", spec.name)));
                    }
                    continue;
                }
                // A list field's slot is the whole list, so the schema's parser
                // reads it whole.
                let list = Json::Arr(items.clone());
                check_one(&list)?;
                out.insert(spec.name.to_string(), list);
            }
            (Many | OneOrMore, Some(_)) => {
                return Err(invalid(format!("{} is a list", spec.name)));
            }
        }
    }
    check_kind_rules(kind, &out)?;
    Ok(out)
}

/// The rules a field's own type cannot say.
fn check_kind_rules(kind: Kind, fields: &Fields) -> Result<(), IpamError> {
    match kind {
        Kind::Reservation => {
            let held = ["prefix", "range", "address"]
                .iter()
                .filter(|f| fields.contains_key(**f))
                .count();
            if held != 1 {
                return Err(invalid(
                    "a reservation holds exactly one of a prefix, a range or an address",
                ));
            }
            if !fields.contains_key("holder") && !fields.contains_key("work") {
                return Err(invalid(
                    "a reservation is held by a person or by a piece of work",
                ));
            }
        }
        Kind::VlanGroup => {
            let ranges = vid_ranges(fields)?;
            for pair in ranges.windows(2) {
                if pair[1].0 <= pair[0].1 {
                    return Err(invalid("a VLAN group's ranges overlap"));
                }
            }
        }
        Kind::AsnRange => {
            let first = asn_of(fields, "first")?;
            let last = asn_of(fields, "last")?;
            if first > last {
                return Err(invalid("an ASN range's first ASN comes after its last"));
            }
        }
        _ => {}
    }
    Ok(())
}

fn text<'a>(fields: &'a Fields, name: &str) -> Option<&'a str> {
    match fields.get(name) {
        Some(Json::Str(s)) => Some(s.as_str()),
        _ => None,
    }
}

fn texts<'a>(fields: &'a Fields, name: &str) -> Vec<&'a str> {
    match fields.get(name) {
        Some(Json::Arr(items)) => items
            .iter()
            .filter_map(|j| match j {
                Json::Str(s) => Some(s.as_str()),
                _ => None,
            })
            .collect(),
        _ => Vec::new(),
    }
}

fn flag(fields: &Fields, name: &str) -> bool {
    matches!(fields.get(name), Some(Json::Bool(true)))
}

fn parsed<T: Scalar>(fields: &Fields, name: &str) -> Result<Option<T>, IpamError> {
    match text(fields, name) {
        None => Ok(None),
        Some(t) => T::parse(t)
            .map(Some)
            .map_err(|_| IpamError::Corrupt("a stored value")),
    }
}

fn asn_of(fields: &Fields, name: &str) -> Result<u32, IpamError> {
    parsed::<ir::Asn>(fields, name)?
        .map(|a| a.0)
        .ok_or_else(|| invalid(format!("{name} is required")))
}

/// A VLAN group's ranges, sorted. Each is `lo-hi` inside 1-4094, or one ID.
pub fn vid_ranges(fields: &Fields) -> Result<Vec<(u16, u16)>, IpamError> {
    let mut out = Vec::new();
    for range in texts(fields, "vid_ranges") {
        let (lo, hi) = range.split_once('-').unwrap_or((range, range));
        let lo = ir::VlanId::parse(lo)
            .map_err(|_| invalid(format!("\"{range}\" is not a VLAN range like 100-199")))?;
        let hi = ir::VlanId::parse(hi)
            .map_err(|_| invalid(format!("\"{range}\" is not a VLAN range like 100-199")))?;
        if lo.0 > hi.0 {
            return Err(invalid(format!("\"{range}\" runs backwards")));
        }
        out.push((lo.0, hi.0));
    }
    out.sort_unstable();
    Ok(out)
}

// ---------------------------------------------------------------------------
// Address arithmetic, both families (decision 4)
// ---------------------------------------------------------------------------

/// A stretch of address space in one family: `lo..=hi`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct Span {
    pub v6: bool,
    pub lo: u128,
    pub hi: u128,
}

fn bits(v6: bool) -> u32 {
    if v6 {
        128
    } else {
        32
    }
}

fn to_u128(a: IpAddr) -> (bool, u128) {
    match a {
        IpAddr::V4(v) => (false, u128::from(u32::from(v))),
        IpAddr::V6(v) => (true, u128::from(v)),
    }
}

fn from_u128(v6: bool, n: u128) -> IpAddr {
    if v6 {
        IpAddr::V6(Ipv6Addr::from(n))
    } else {
        IpAddr::V4(Ipv4Addr::from(n as u32))
    }
}

/// The span of a prefix.
pub fn prefix_span(p: &ir::IpPrefix) -> Span {
    let (v6, lo) = to_u128(p.addr);
    let host = bits(v6) - u32::from(p.len);
    let size_less_one = if host == 128 {
        u128::MAX
    } else {
        (1u128 << host) - 1
    };
    Span {
        v6,
        lo,
        hi: lo + size_less_one,
    }
}

fn point(a: IpAddr) -> Span {
    let (v6, n) = to_u128(a);
    Span { v6, lo: n, hi: n }
}

fn range_span(r: &ir::IpRange) -> Span {
    let (v6, lo) = to_u128(r.lo);
    let (_, hi) = to_u128(r.hi);
    Span { v6, lo, hi }
}

/// Merge `spans` (one family) into sorted, non-overlapping spans.
fn merged(mut spans: Vec<Span>) -> Vec<Span> {
    spans.sort_unstable();
    let mut out: Vec<Span> = Vec::with_capacity(spans.len());
    for s in spans {
        match out.last_mut() {
            Some(last) if s.lo <= last.hi.saturating_add(1) => last.hi = last.hi.max(s.hi),
            _ => out.push(s),
        }
    }
    out
}

/// The first prefix of length `len` inside `parent` that overlaps nothing in
/// `taken`, lowest first.
pub fn next_free_prefix(parent: Span, len: u8, taken: &[Span]) -> Option<ir::IpPrefix> {
    let width = bits(parent.v6);
    if u32::from(len) > width {
        return None;
    }
    let host = width - u32::from(len);
    let size_less_one = if host == 128 {
        u128::MAX
    } else {
        (1u128 << host) - 1
    };
    if size_less_one > parent.hi - parent.lo {
        return None;
    }
    let taken = merged(
        taken
            .iter()
            .copied()
            .filter(|t| t.v6 == parent.v6 && t.hi >= parent.lo && t.lo <= parent.hi)
            .collect(),
    );
    let align = |n: u128| -> Option<u128> {
        if size_less_one == u128::MAX {
            return if n == 0 { Some(0) } else { None };
        }
        let rem = n & size_less_one;
        if rem == 0 {
            Some(n)
        } else {
            n.checked_add(size_less_one - rem + 1)
        }
    };
    let mut candidate = align(parent.lo)?;
    let mut i = 0;
    loop {
        let end = candidate.checked_add(size_less_one)?;
        if end > parent.hi {
            return None;
        }
        while i < taken.len() && taken[i].hi < candidate {
            i += 1;
        }
        match taken.get(i) {
            Some(t) if t.lo <= end => candidate = align(t.hi.checked_add(1)?)?,
            _ => {
                return Some(ir::IpPrefix {
                    addr: from_u128(parent.v6, candidate),
                    len,
                })
            }
        }
    }
}

/// The addresses of `parent` that can be handed out: for IPv4 below /31 and
/// not a pool, without the network and broadcast addresses.
pub fn usable(parent: &ir::IpPrefix, is_pool: bool) -> Span {
    let s = prefix_span(parent);
    if !s.v6 && parent.len < 31 && !is_pool {
        Span {
            v6: false,
            lo: s.lo + 1,
            hi: s.hi - 1,
        }
    } else {
        s
    }
}

/// How many addresses `parent` holds and how many of them are usable, as the
/// block panel explains it (decision 7): a /29 is 8 addresses, 6 usable.
pub fn counts(parent: &ir::IpPrefix, is_pool: bool) -> (u128, u128) {
    let all = prefix_span(parent);
    let u = usable(parent, is_pool);
    let size = |s: Span| {
        if s.lo == 0 && s.hi == u128::MAX {
            u128::MAX
        } else {
            s.hi - s.lo + 1
        }
    };
    (size(all), size(u))
}

/// The lowest address in `usable` outside every span of `taken`. For IPv6 the
/// walk stops after [`V6_ADDRESS_WALK`] taken stretches rather than listing a
/// /64 (decision 4).
pub fn next_free_address(usable: Span, taken: &[Span]) -> Option<IpAddr> {
    let taken = merged(
        taken
            .iter()
            .copied()
            .filter(|t| t.v6 == usable.v6 && t.hi >= usable.lo && t.lo <= usable.hi)
            .collect(),
    );
    let mut candidate = usable.lo;
    for (steps, t) in taken.iter().enumerate() {
        if usable.v6 && steps as u32 >= V6_ADDRESS_WALK {
            return None;
        }
        if t.hi < candidate {
            continue;
        }
        if t.lo > candidate {
            break;
        }
        candidate = t.hi.checked_add(1)?;
    }
    (candidate <= usable.hi).then(|| from_u128(usable.v6, candidate))
}

/// The lowest number in `ranges` (sorted, inclusive) not in `taken`.
pub fn next_free_number(ranges: &[(u32, u32)], taken: &BTreeSet<u32>) -> Option<u32> {
    for &(lo, hi) in ranges {
        let mut n = lo;
        for &t in taken.range(lo..=hi) {
            if t > n {
                break;
            }
            n = t.checked_add(1)?;
        }
        if n <= hi {
            return Some(n);
        }
    }
    None
}

// ---------------------------------------------------------------------------
// Where a record sits in address space
// ---------------------------------------------------------------------------

/// The VRF a record's space is in: its `vrf` field, or the global table.
fn vrf_of(fields: &Fields) -> &str {
    text(fields, "vrf").unwrap_or("")
}

/// What a record occupies in address space, if anything.
pub fn span_of(kind: Kind, fields: &Fields) -> Result<Option<Span>, IpamError> {
    Ok(match kind {
        Kind::Aggregate | Kind::Prefix => {
            parsed::<ir::IpPrefix>(fields, "prefix")?.map(|p| prefix_span(&p))
        }
        Kind::Range => parsed::<ir::IpRange>(fields, "range")?.map(|r| range_span(&r)),
        Kind::Address => parsed::<ir::InterfaceAddress>(fields, "address")?.map(|a| point(a.addr)),
        Kind::Reservation => {
            if let Some(p) = parsed::<ir::IpPrefix>(fields, "prefix")? {
                Some(prefix_span(&p))
            } else if let Some(r) = parsed::<ir::IpRange>(fields, "range")? {
                Some(range_span(&r))
            } else {
                parsed::<ir::IpAddr>(fields, "address")?.map(|a| point(a.0))
            }
        }
        _ => None,
    })
}

/// The text a record's space hash is made of: kind of block, VRF and network.
/// A prefix and the same network as a reservation are one space; an address is
/// its own point, so `10.0.0.0/24` and the address `10.0.0.0` never collide.
pub fn space_text(kind: Kind, fields: &Fields) -> Result<Option<String>, IpamError> {
    let vrf = vrf_of(fields);
    let network = match kind {
        Kind::Prefix | Kind::Aggregate => {
            parsed::<ir::IpPrefix>(fields, "prefix")?.map(|p| format!("net {}", p.canonical()))
        }
        Kind::Range => {
            parsed::<ir::IpRange>(fields, "range")?.map(|r| format!("range {}", r.canonical()))
        }
        Kind::Address => {
            parsed::<ir::InterfaceAddress>(fields, "address")?.map(|a| format!("addr {}", a.addr))
        }
        Kind::Reservation => {
            if let Some(p) = parsed::<ir::IpPrefix>(fields, "prefix")? {
                Some(format!("net {}", p.canonical()))
            } else if let Some(r) = parsed::<ir::IpRange>(fields, "range")? {
                Some(format!("range {}", r.canonical()))
            } else {
                parsed::<ir::IpAddr>(fields, "address")?.map(|a| format!("addr {}", a.0))
            }
        }
        Kind::Vlan => {
            let group = text(fields, "group").unwrap_or("");
            parsed::<ir::VlanId>(fields, "vid")?.map(|v| format!("vlan {group} {}", v.0))
        }
        Kind::Asn => parsed::<ir::Asn>(fields, "asn")?.map(|a| format!("asn {}", a.0)),
        _ => None,
    };
    // An aggregate is always in the global table, whatever it names.
    let vrf = if kind == Kind::Aggregate { "" } else { vrf };
    Ok(network.map(|n| format!("{vrf}|{n}")))
}

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

/// The keys of one organisation's plan store, derived from its tenant key.
pub struct IpamKeys {
    seal: Key32,
    space: Key32,
    allocation: Key32,
    lock: Key32,
    /// The tenant key epoch these came from, stored with each record so a
    /// record sealed under another epoch is refused, never misread.
    epoch: i32,
}

impl IpamKeys {
    /// HKDF-Expand from the tenant key with the store's own label
    /// (`fathom/ip-plan/v1`), so this key opens nothing else and nothing else
    /// opens the store.
    pub fn derive(tenant_key: &DataKey, organisation: &str) -> Self {
        let mut info = b"fathom/ip-plan/v1|".to_vec();
        info.extend_from_slice(organisation.as_bytes());
        let root = crypto::hkdf_expand(&tenant_key.key, &info);
        Self {
            seal: crypto::hkdf_expand(&root, b"seal"),
            space: crypto::hkdf_expand(&root, b"space"),
            allocation: crypto::hkdf_expand(&root, b"allocation"),
            lock: crypto::hkdf_expand(&root, b"lock"),
            epoch: tenant_key.epoch,
        }
    }

    fn space_hash(&self, text: &str) -> Vec<u8> {
        crypto::mac(self.space.expose(), text.as_bytes()).to_vec()
    }

    fn allocation_hash(&self, key: &str) -> Vec<u8> {
        crypto::mac(self.allocation.expose(), key.as_bytes()).to_vec()
    }

    fn lock_id(&self, parent: &str) -> i64 {
        let tag = crypto::mac(self.lock.expose(), parent.as_bytes());
        let mut first = [0u8; 8];
        first.copy_from_slice(&tag[..8]);
        i64::from_le_bytes(first)
    }
}

fn record_aad(organisation: &str, id: &str, kind: Kind, version: i64) -> Vec<u8> {
    let mut aad = b"fathom ip plan record 1".to_vec();
    for part in [organisation, id, kind.token(), &version.to_string()] {
        crypto::lp(&mut aad, part.as_bytes());
    }
    aad
}

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

/// One record as the store holds it.
#[derive(Clone, Debug, PartialEq)]
pub struct Record {
    pub id: String,
    pub kind: Kind,
    pub version: i64,
    pub fields: Fields,
}

impl Record {
    pub fn folder(&self) -> Option<&str> {
        text(&self.fields, "folder")
    }

    /// The record as a route answers it: id, kind, version, fields, and what is
    /// worked out rather than stored (a reservation's lapse, a block's counts).
    pub fn to_json(&self, today: &ir::Date) -> Json {
        let mut m = BTreeMap::new();
        m.insert("id".into(), Json::Str(self.id.clone()));
        m.insert("kind".into(), Json::Str(self.kind.token().into()));
        m.insert("version".into(), Json::Int(self.version));
        m.insert("fields".into(), Json::Obj(self.fields.clone()));
        if self.kind == Kind::Reservation {
            if let Ok(Some(ends)) = parsed::<ir::Date>(&self.fields, "ends") {
                m.insert("lapsed".into(), Json::Bool(ends < *today));
            }
        }
        if matches!(self.kind, Kind::Prefix | Kind::Aggregate) {
            if let Ok(Some(p)) = parsed::<ir::IpPrefix>(&self.fields, "prefix") {
                let (all, usable) = counts(&p, flag(&self.fields, "is_pool"));
                m.insert("addresses".into(), Json::Str(all.to_string()));
                m.insert("usable".into(), Json::Str(usable.to_string()));
            }
        }
        Json::Obj(m)
    }
}

fn open_row(
    keys: &IpamKeys,
    organisation: &str,
    row: &tokio_postgres::Row,
) -> Result<Record, IpamError> {
    let id: String = row.get("id");
    let kind_text: String = row.get("kind");
    let version: i64 = row.get("version");
    let epoch: i32 = row.get("key_epoch");
    let sealed: Vec<u8> = row.get("sealed");
    let nonce: Vec<u8> = row.get("nonce");
    let kind = Kind::from_token(&kind_text).ok_or(IpamError::Corrupt("a record's kind"))?;
    if epoch != keys.epoch {
        return Err(IpamError::Corrupt(
            "a record sealed under another key epoch",
        ));
    }
    let nonce: [u8; crypto::NONCE_LEN] = nonce
        .try_into()
        .map_err(|_| IpamError::Corrupt("a record's nonce"))?;
    let plain = crypto::open(
        &keys.seal,
        &nonce,
        &sealed,
        &record_aad(organisation, &id, kind, version),
    )
    .map_err(|_| IpamError::Corrupt("a sealed record"))?;
    let fields = match Json::parse_canonical(&plain) {
        Ok(Json::Obj(m)) => m,
        _ => return Err(IpamError::Corrupt("a record's fields")),
    };
    Ok(Record {
        id,
        kind,
        version,
        fields,
    })
}

/// Every record in the organisation's plan, opened. The caller filters by
/// what the person may read.
pub async fn all_records(
    tx: &Transaction<'_>,
    keys: &IpamKeys,
    organisation: &str,
) -> Result<Vec<Record>, IpamError> {
    let rows = tx
        .query(
            "SELECT id, kind, version, key_epoch, sealed, nonce FROM ipam_records \
             WHERE organisation_id = $1 ORDER BY id LIMIT $2",
            &[&organisation, &MAX_RECORDS],
        )
        .await?;
    rows.iter()
        .map(|row| open_row(keys, organisation, row))
        .collect()
}

async fn one_record(
    tx: &Transaction<'_>,
    keys: &IpamKeys,
    organisation: &str,
    id: &str,
    for_update: bool,
) -> Result<Record, IpamError> {
    let sql = if for_update {
        "SELECT id, kind, version, key_epoch, sealed, nonce FROM ipam_records \
         WHERE organisation_id = $1 AND id = $2 FOR UPDATE"
    } else {
        "SELECT id, kind, version, key_epoch, sealed, nonce FROM ipam_records \
         WHERE organisation_id = $1 AND id = $2"
    };
    let row = tx
        .query_opt(sql, &[&organisation, &id])
        .await?
        .ok_or(IpamError::NotFound)?;
    open_row(keys, organisation, &row)
}

// ---------------------------------------------------------------------------
// Permissions
// ---------------------------------------------------------------------------

fn scope_of(folder: Option<&str>) -> Result<Option<ScopeId>, IpamError> {
    folder
        .map(|f| {
            f.parse::<ScopeId>()
                .map_err(|_| IpamError::Corrupt("a record's folder"))
        })
        .transpose()
}

/// The folders a person may read, worked out once per request.
pub struct Reader<'a> {
    auth: &'a Authority<'a>,
    verified: grants::VerifiedAuthorityState,
    seen: BTreeMap<Option<String>, bool>,
}

impl<'a> Reader<'a> {
    pub async fn new(tx: &Transaction<'_>, auth: &'a Authority<'a>) -> Result<Self, IpamError> {
        let verified = grants::verify_authority_state(tx, auth).await?;
        Ok(Self {
            auth,
            verified,
            seen: BTreeMap::new(),
        })
    }

    /// Whether the caller holds `needed` on `folder`.
    pub async fn holds(
        &mut self,
        tx: &Transaction<'_>,
        folder: Option<&str>,
        needed: Capability,
    ) -> Result<bool, IpamError> {
        if needed == Capability::Read {
            if let Some(answer) = self.seen.get(&folder.map(str::to_string)) {
                return Ok(*answer);
            }
        }
        let scope = scope_of(folder)?;
        let answer =
            grants::holds_in_verified_state(tx, self.auth, &self.verified, scope, needed).await?;
        if needed == Capability::Read {
            self.seen.insert(folder.map(str::to_string), answer);
        }
        Ok(answer)
    }

    async fn require(
        &mut self,
        tx: &Transaction<'_>,
        folder: Option<&str>,
        needed: Capability,
    ) -> Result<(), IpamError> {
        if self.holds(tx, folder, needed).await? {
            Ok(())
        } else {
            Err(IpamError::Authority(AuthorityError::NotAuthorised))
        }
    }
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/// Whether records in `vrf` refuse a duplicate network.
fn enforces_unique(records: &[Record], vrf: &str) -> bool {
    !vrf.is_empty()
        && records
            .iter()
            .any(|r| r.kind == Kind::Vrf && r.id == vrf && flag(&r.fields, "enforce_unique"))
}

/// Check every store id a record names: the VRF is a VRF, a VLAN's group is a
/// group, and so on. A folder must be a folder of this organisation.
async fn check_references(
    tx: &Transaction<'_>,
    organisation: &str,
    records: &[Record],
    kind: Kind,
    fields: &Fields,
) -> Result<(), IpamError> {
    let is = |id: &str, want: Kind| records.iter().any(|r| r.id == id && r.kind == want);
    let single = |name: &str, want: Kind| -> Result<(), IpamError> {
        match text(fields, name) {
            Some(id) if !is(id, want) => Err(invalid(format!(
                "{name} names no {} in this plan",
                want.node_kind().name()
            ))),
            _ => Ok(()),
        }
    };
    single("vrf", Kind::Vrf)?;
    match kind {
        Kind::Vlan => single("group", Kind::VlanGroup)?,
        Kind::Asn => single("range", Kind::AsnRange)?,
        Kind::Vrf => {
            for name in ["import_targets", "export_targets"] {
                for id in texts(fields, name) {
                    if !is(id, Kind::RouteTarget) {
                        return Err(invalid(format!(
                            "{name} names no route target in this plan"
                        )));
                    }
                }
            }
        }
        Kind::Address | Kind::Reservation => {
            if let Some(id) = text(fields, "nat_outside") {
                if !records
                    .iter()
                    .any(|r| r.id == id && matches!(r.kind, Kind::Address | Kind::Reservation))
                {
                    return Err(invalid("nat_outside names no address in this plan"));
                }
            }
        }
        _ => {}
    }
    if let Some(folder) = text(fields, "folder") {
        let found = tx
            .query_opt(
                "SELECT 1 FROM scopes WHERE id = $1 AND organisation_id = $2",
                &[&folder, &organisation],
            )
            .await?;
        if found.is_none() {
            return Err(invalid("folder names no folder in this organisation"));
        }
    }
    Ok(())
}

/// Fill in what a reservation takes by default: the person reserving holds it
/// when no work does, and it ends after [`DEFAULT_HOLD_DAYS`].
fn with_defaults(kind: Kind, mut fields: Fields, actor: &str, today: &ir::Date) -> Fields {
    if kind == Kind::Reservation {
        if !fields.contains_key("holder") && !fields.contains_key("work") {
            fields.insert("holder".into(), Json::Str(actor.to_string()));
        }
        if !fields.contains_key("ends") {
            fields.insert(
                "ends".into(),
                Json::Str(add_days(today, DEFAULT_HOLD_DAYS).canonical()),
            );
        }
    }
    fields
}

async fn record_change(
    tx: &Transaction<'_>,
    auth: &Authority<'_>,
    entry: EntryType,
    record: &Record,
) -> Result<(), IpamError> {
    let mut meta = BTreeMap::new();
    meta.insert("actor".to_string(), Json::Str(auth.ctx.actor().to_string()));
    meta.insert(
        "entry_type".to_string(),
        Json::Str(entry.as_str().to_string()),
    );
    meta.insert(
        "organisation".to_string(),
        Json::Str(auth.ctx.tenant().to_string()),
    );
    meta.insert("record".to_string(), Json::Str(record.id.clone()));
    meta.insert("kind".to_string(), Json::Str(record.kind.token().into()));
    meta.insert("version".to_string(), Json::Int(record.version));
    // The organisation chain's metadata is sealed under the content key
    // (`keys::org_content_key`), so who reserved what, and when, is in the
    // sealed history as a grant is (decision 1).
    if entry != EntryType::IpamRecordDeleted {
        meta.insert("fields".to_string(), Json::Obj(record.fields.clone()));
    }
    chains::append_org(
        tx,
        auth.ring,
        auth.ctx,
        auth.tenant_key,
        entry,
        &Json::Obj(meta).to_canonical_bytes(),
    )
    .await
    .map_err(|e| IpamError::Authority(AuthorityError::Chain(e)))?;
    Ok(())
}

async fn write_row(
    tx: &Transaction<'_>,
    keys: &IpamKeys,
    organisation: &str,
    record: &Record,
    insert: bool,
) -> Result<(), IpamError> {
    let nonce = crypto::random_nonce().map_err(|_| IpamError::Corrupt("the random source"))?;
    let aad = record_aad(organisation, &record.id, record.kind, record.version);
    let sealed = crypto::seal(
        &keys.seal,
        &nonce,
        &Json::Obj(record.fields.clone()).to_canonical_bytes(),
        &aad,
    )
    .map_err(|_| IpamError::Corrupt("sealing a record"))?;
    let folder = record.folder().map(str::to_string);
    if insert {
        tx.execute(
            "INSERT INTO ipam_records \
                 (organisation_id, id, kind, folder_id, version, key_epoch, sealed, nonce) \
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
            &[
                &organisation,
                &record.id,
                &record.kind.token(),
                &folder,
                &record.version,
                &keys.epoch,
                &sealed,
                &nonce.to_vec(),
            ],
        )
        .await?;
    } else {
        tx.execute(
            "UPDATE ipam_records SET folder_id = $3, version = $4, key_epoch = $5, \
                 sealed = $6, nonce = $7, changed_at = now() \
             WHERE organisation_id = $1 AND id = $2",
            &[
                &organisation,
                &record.id,
                &folder,
                &record.version,
                &keys.epoch,
                &sealed,
                &nonce.to_vec(),
            ],
        )
        .await?;
    }
    Ok(())
}

/// Hold the record's space hash when its space refuses duplicates, or always
/// when `allocated`. A clash answers [`IpamError::Clash`].
async fn hold_space(
    tx: &Transaction<'_>,
    keys: &IpamKeys,
    organisation: &str,
    records: &[Record],
    record: &Record,
    allocated: bool,
) -> Result<(), IpamError> {
    tx.execute(
        "DELETE FROM ipam_unique WHERE organisation_id = $1 AND record_id = $2",
        &[&organisation, &record.id],
    )
    .await?;
    let Some(space) = space_text(record.kind, &record.fields)? else {
        return Ok(());
    };
    let unique_vlan_or_asn = matches!(record.kind, Kind::Vlan | Kind::Asn);
    if !(allocated || unique_vlan_or_asn || enforces_unique(records, vrf_of(&record.fields))) {
        return Ok(());
    }
    let hash = keys.space_hash(&space);
    let inserted = tx
        .execute(
            "INSERT INTO ipam_unique (organisation_id, space, record_id) VALUES ($1, $2, $3) \
             ON CONFLICT (organisation_id, space) DO NOTHING",
            &[&organisation, &hash, &record.id],
        )
        .await?;
    if inserted == 0 {
        return Err(IpamError::Clash);
    }
    Ok(())
}

/// Make a record. Returns it with its new id.
pub async fn create(
    tx: &Transaction<'_>,
    auth: &Authority<'_>,
    keys: &IpamKeys,
    kind: Kind,
    fields: &Fields,
    today: &ir::Date,
) -> Result<Record, IpamError> {
    let organisation = auth.ctx.tenant().to_string();
    let fields = with_defaults(kind, fields.clone(), &auth.ctx.actor().to_string(), today);
    let fields = validate(kind, &fields)?;
    let mut reader = Reader::new(tx, auth).await?;
    reader
        .require(tx, text(&fields, "folder"), kind.to_change())
        .await?;
    let records = all_records(tx, keys, &organisation).await?;
    if records.len() as i64 >= MAX_RECORDS {
        return Err(invalid("this organisation's plan is full"));
    }
    check_references(tx, &organisation, &records, kind, &fields).await?;
    check_unique_names(&records, None, kind, &fields)?;
    let record = Record {
        id: crate::ids::new_ulid().to_string(),
        kind,
        version: 1,
        fields,
    };
    write_row(tx, keys, &organisation, &record, true).await?;
    hold_space(tx, keys, &organisation, &records, &record, false).await?;
    record_change(tx, auth, EntryType::IpamRecordCreated, &record).await?;
    Ok(record)
}

/// Names that are unique: a VRF's, a VLAN group's, an ASN range's, and a
/// VLAN's name inside its group; a route target's value.
fn check_unique_names(
    records: &[Record],
    except: Option<&str>,
    kind: Kind,
    fields: &Fields,
) -> Result<(), IpamError> {
    let others = records
        .iter()
        .filter(|r| r.kind == kind && Some(r.id.as_str()) != except);
    let same = |field: &str| {
        let mine = fields.get(field);
        others
            .clone()
            .any(|r| mine.is_some() && r.fields.get(field) == mine)
    };
    let clash = match kind {
        Kind::Vrf | Kind::VlanGroup | Kind::AsnRange => same("name"),
        Kind::RouteTarget => same("value"),
        Kind::Vlan => others.clone().any(|r| {
            r.fields.get("group") == fields.get("group")
                && r.fields.get("name") == fields.get("name")
        }),
        _ => false,
    };
    if clash {
        return Err(invalid(format!(
            "another {} already has that name",
            kind.node_kind().name()
        )));
    }
    Ok(())
}

/// Change a record's fields. `version` is the version the caller read; a
/// record changed since is refused with [`IpamError::Stale`]. The kind never
/// changes.
pub async fn update(
    tx: &Transaction<'_>,
    auth: &Authority<'_>,
    keys: &IpamKeys,
    id: &str,
    version: i64,
    fields: &Fields,
) -> Result<Record, IpamError> {
    let organisation = auth.ctx.tenant().to_string();
    let old = one_record(tx, keys, &organisation, id, true).await?;
    let mut reader = Reader::new(tx, auth).await?;
    if !reader.holds(tx, old.folder(), Capability::Read).await? {
        return Err(IpamError::NotFound);
    }
    reader
        .require(tx, old.folder(), old.kind.to_change())
        .await?;
    if old.version != version {
        return Err(IpamError::Stale);
    }
    let fields = validate(old.kind, fields)?;
    reader
        .require(tx, text(&fields, "folder"), old.kind.to_change())
        .await?;
    if old.kind == Kind::Reservation && !holds_it(auth, &old) {
        reader
            .require(tx, old.folder(), Capability::Steward)
            .await?;
    }
    let records = all_records(tx, keys, &organisation).await?;
    check_references(tx, &organisation, &records, old.kind, &fields).await?;
    check_unique_names(&records, Some(id), old.kind, &fields)?;
    let allocated = text(&old.fields, "allocation_key").is_some();
    let record = Record {
        id: old.id.clone(),
        kind: old.kind,
        version: old.version + 1,
        fields,
    };
    write_row(tx, keys, &organisation, &record, false).await?;
    hold_space(tx, keys, &organisation, &records, &record, allocated).await?;
    record_change(tx, auth, EntryType::IpamRecordChanged, &record).await?;
    Ok(record)
}

fn holds_it(auth: &Authority<'_>, reservation: &Record) -> bool {
    text(&reservation.fields, "holder") == Some(auth.ctx.actor().to_string().as_str())
}

/// Delete a record, or release a reservation. A reservation held by someone
/// else, or by a piece of work, needs Steward on its folder (decision 1). A
/// record another one names is refused with [`IpamError::InUse`].
pub async fn delete(
    tx: &Transaction<'_>,
    auth: &Authority<'_>,
    keys: &IpamKeys,
    id: &str,
) -> Result<Record, IpamError> {
    let organisation = auth.ctx.tenant().to_string();
    let old = one_record(tx, keys, &organisation, id, true).await?;
    let mut reader = Reader::new(tx, auth).await?;
    if !reader.holds(tx, old.folder(), Capability::Read).await? {
        return Err(IpamError::NotFound);
    }
    reader
        .require(tx, old.folder(), old.kind.to_change())
        .await?;
    if old.kind == Kind::Reservation && !holds_it(auth, &old) {
        reader
            .require(tx, old.folder(), Capability::Steward)
            .await?;
    }
    let records = all_records(tx, keys, &organisation).await?;
    if let Some(user) = records.iter().find(|r| r.id != old.id && names(r, &old.id)) {
        return Err(IpamError::InUse(format!(
            "a {} still names it",
            user.kind.node_kind().name()
        )));
    }
    tx.execute(
        "DELETE FROM ipam_records WHERE organisation_id = $1 AND id = $2",
        &[&organisation, &old.id],
    )
    .await?;
    record_change(tx, auth, EntryType::IpamRecordDeleted, &old).await?;
    Ok(old)
}

/// Whether `record` names `id` in one of its store-id fields.
fn names(record: &Record, id: &str) -> bool {
    [
        "vrf",
        "group",
        "range",
        "parent",
        "nat_outside",
        "import_targets",
        "export_targets",
    ]
    .iter()
    .any(|f| match record.fields.get(*f) {
        Some(Json::Str(s)) => s == id && !(*f == "range" && record.kind == Kind::Reservation),
        Some(Json::Arr(items)) => items.iter().any(|j| matches!(j, Json::Str(s) if s == id)),
        _ => false,
    })
}

/// The records the caller may read, optionally of one kind and in one folder.
pub async fn list(
    tx: &Transaction<'_>,
    auth: &Authority<'_>,
    keys: &IpamKeys,
    kind: Option<Kind>,
    folder: Option<&str>,
) -> Result<Vec<Record>, IpamError> {
    let organisation = auth.ctx.tenant().to_string();
    let mut reader = Reader::new(tx, auth).await?;
    let mut out = Vec::new();
    for record in all_records(tx, keys, &organisation).await? {
        if kind.is_some_and(|k| k != record.kind) {
            continue;
        }
        if folder.is_some() && record.folder() != folder {
            continue;
        }
        if reader.holds(tx, record.folder(), Capability::Read).await? {
            out.push(record);
        }
    }
    Ok(out)
}

// ---------------------------------------------------------------------------
// Next free (decision 5)
// ---------------------------------------------------------------------------

/// What to hand out from a parent.
#[derive(Clone, Debug)]
pub enum Want {
    /// A prefix of this length inside a prefix or an aggregate.
    Prefix(u8),
    /// One address inside a prefix, or inside a range.
    Address,
    /// A VLAN ID in a group, with the VLAN's name.
    Vlan(String),
    /// An ASN in a range.
    Asn,
}

/// What a person asks next free for.
#[derive(Clone, Debug)]
pub struct Ask {
    pub parent: String,
    pub want: Want,
    /// What asked: `W-1042/wan`. The same key from the same parent gives the
    /// same answer. Required to hand anything out; a look (`take: false`)
    /// needs none.
    pub key: Option<String>,
    /// For a block or an address: the reservation's reason, holder or work and
    /// end. For a VLAN or ASN: none needed.
    pub hold: Fields,
}

/// What next free answered.
#[derive(Clone, Debug)]
pub enum Answer {
    /// What would be handed out, without holding it.
    Free(String),
    /// The record made for it, or the one the same key made before.
    Taken { record: Record, again: bool },
}

/// The spans a parent's own space already holds, from the plan.
fn taken_in(records: &[Record], parent: &Record, want: &Want) -> Result<Vec<Span>, IpamError> {
    let vrf = vrf_of(&parent.fields);
    let mut out = Vec::new();
    for r in records {
        if r.id == parent.id || (vrf_of(&r.fields) != vrf && r.kind != Kind::Aggregate) {
            continue;
        }
        let counts = match (want, r.kind) {
            // A block is taken by anything inside it.
            (Want::Prefix(_), Kind::Prefix | Kind::Range | Kind::Address | Kind::Reservation) => {
                true
            }
            // An address is taken by an address, a reservation, or a range marked populated.
            (Want::Address, Kind::Address | Kind::Reservation) => true,
            (Want::Address, Kind::Range) => flag(&r.fields, "populated"),
            _ => false,
        };
        if counts {
            if let Some(s) = span_of(r.kind, &r.fields)? {
                out.push(s);
            }
        }
    }
    Ok(out)
}

/// The drawn addresses the estate index holds, so next free skips what is
/// already configured in any design (decision 4). Without their VRF: an
/// address drawn anywhere is skipped in every space, which wastes at worst one
/// address and never hands out one in use.
async fn drawn_addresses(
    tx: &Transaction<'_>,
    tenant_key: &DataKey,
    organisation: &str,
) -> Result<Vec<Span>, IpamError> {
    let index = crate::estate::IndexKeys::derive(tenant_key, organisation);
    let addresses = crate::estate::all_addresses(tx, &index, organisation)
        .await
        .map_err(|_| IpamError::Corrupt("the estate index"))?;
    Ok(addresses
        .iter()
        .filter_map(|a| a.parse::<IpAddr>().ok())
        .map(point)
        .collect())
}

/// Find, and unless `take` is false hand out, the next free block, address,
/// VLAN ID or ASN inside `ask.parent`.
///
/// Under a transaction-level advisory lock on the parent, so two requests on
/// one parent never see the same free space. A repeat of an allocation key
/// returns what it was given before.
pub async fn allocate(
    tx: &Transaction<'_>,
    auth: &Authority<'_>,
    keys: &IpamKeys,
    ask: &Ask,
    take: bool,
    today: &ir::Date,
) -> Result<Answer, IpamError> {
    let organisation = auth.ctx.tenant().to_string();
    let mut reader = Reader::new(tx, auth).await?;
    let parent = one_record(tx, keys, &organisation, &ask.parent, false).await?;
    if !reader.holds(tx, parent.folder(), Capability::Read).await? {
        return Err(IpamError::NotFound);
    }
    if !take {
        let records = all_records(tx, keys, &organisation).await?;
        let drawn = drawn_addresses(tx, auth.tenant_key, &organisation).await?;
        return free_in(&records, &parent, &ask.want, &drawn).map(Answer::Free);
    }
    reader
        .require(tx, parent.folder(), Capability::Draw)
        .await?;
    let key = match ask.key.as_deref().map(str::trim) {
        Some(k) if !k.is_empty() && k.chars().count() <= 200 => k.to_string(),
        _ => {
            return Err(invalid(
                "an allocation needs a key saying what asked, such as W-1042/wan",
            ))
        }
    };

    // One request at a time on this parent, from any server.
    tx.execute(
        "SELECT pg_advisory_xact_lock($1)",
        &[&keys.lock_id(&format!("{organisation}|{}", parent.id))],
    )
    .await?;

    let key_hash = keys.allocation_hash(&key);
    if let Some(row) = tx
        .query_opt(
            "SELECT record_id, parent_id FROM ipam_allocations \
             WHERE organisation_id = $1 AND key = $2",
            &[&organisation, &key_hash],
        )
        .await?
    {
        let record_id: String = row.get(0);
        let parent_id: String = row.get(1);
        if parent_id != parent.id {
            return Err(IpamError::KeyUsedElsewhere);
        }
        let record = one_record(tx, keys, &organisation, &record_id, false).await?;
        return Ok(Answer::Taken {
            record,
            again: true,
        });
    }

    let records = all_records(tx, keys, &organisation).await?;
    let drawn = drawn_addresses(tx, auth.tenant_key, &organisation).await?;
    let free = free_in(&records, &parent, &ask.want, &drawn)?;
    let folder = text(&ask.hold, "folder")
        .map(str::to_string)
        .or_else(|| parent.folder().map(str::to_string));
    let mut fields = Fields::new();
    let kind = match &ask.want {
        Want::Prefix(_) | Want::Address => {
            for (k, v) in &ask.hold {
                fields.insert(k.clone(), v.clone());
            }
            let slot = if matches!(ask.want, Want::Prefix(_)) {
                "prefix"
            } else {
                "address"
            };
            fields.insert(slot.into(), Json::Str(free));
            if let Some(vrf) = text(&parent.fields, "vrf") {
                fields.insert("vrf".into(), Json::Str(vrf.into()));
            }
            fields.insert("parent".into(), Json::Str(parent.id.clone()));
            Kind::Reservation
        }
        Want::Vlan(name) => {
            fields.insert("group".into(), Json::Str(parent.id.clone()));
            fields.insert("vid".into(), Json::Str(free));
            fields.insert("name".into(), Json::Str(name.clone()));
            fields.insert("status".into(), Json::Str("reserved".into()));
            Kind::Vlan
        }
        Want::Asn => {
            fields.insert("asn".into(), Json::Str(free));
            fields.insert("range".into(), Json::Str(parent.id.clone()));
            if let Some(meant) = text(&ask.hold, "meant_for") {
                fields.insert("meant_for".into(), Json::Str(meant.into()));
            }
            Kind::Asn
        }
    };
    fields.insert("allocation_key".into(), Json::Str(key));
    match folder {
        Some(f) => fields.insert("folder".into(), Json::Str(f)),
        None => fields.remove("folder"),
    };
    let fields = with_defaults(kind, fields, &auth.ctx.actor().to_string(), today);
    let fields = validate(kind, &fields)?;
    reader
        .require(tx, text(&fields, "folder"), Capability::Draw)
        .await?;
    let record = Record {
        id: crate::ids::new_ulid().to_string(),
        kind,
        version: 1,
        fields,
    };
    write_row(tx, keys, &organisation, &record, true).await?;
    hold_space(tx, keys, &organisation, &records, &record, true).await?;
    let inserted = tx
        .execute(
            "INSERT INTO ipam_allocations (organisation_id, key, record_id, parent_id) \
             VALUES ($1, $2, $3, $4) ON CONFLICT (organisation_id, key) DO NOTHING",
            &[&organisation, &key_hash, &record.id, &parent.id],
        )
        .await?;
    if inserted == 0 {
        // The same key, from another parent, committed while this one ran.
        return Err(IpamError::KeyUsedElsewhere);
    }
    record_change(tx, auth, EntryType::IpamRecordCreated, &record).await?;
    Ok(Answer::Taken {
        record,
        again: false,
    })
}

/// The next free thing in `parent`, as canonical text, without holding it.
pub fn free_in(
    records: &[Record],
    parent: &Record,
    want: &Want,
    drawn: &[Span],
) -> Result<String, IpamError> {
    match (want, parent.kind) {
        (Want::Prefix(len), Kind::Prefix | Kind::Aggregate) => {
            let p = parsed::<ir::IpPrefix>(&parent.fields, "prefix")?
                .ok_or(IpamError::Corrupt("a parent's prefix"))?;
            if *len <= p.len {
                return Err(invalid(format!(
                    "a /{len} does not fit inside a /{}",
                    p.len
                )));
            }
            let mut taken = taken_in(records, parent, want)?;
            taken.extend_from_slice(drawn);
            next_free_prefix(prefix_span(&p), *len, &taken)
                .map(|n| n.canonical())
                .ok_or(IpamError::Full)
        }
        (Want::Address, Kind::Prefix | Kind::Range) => {
            let space = if parent.kind == Kind::Prefix {
                let p = parsed::<ir::IpPrefix>(&parent.fields, "prefix")?
                    .ok_or(IpamError::Corrupt("a parent's prefix"))?;
                usable(&p, flag(&parent.fields, "is_pool"))
            } else {
                parsed::<ir::IpRange>(&parent.fields, "range")?
                    .map(|r| range_span(&r))
                    .ok_or(IpamError::Corrupt("a parent's range"))?
            };
            let mut taken = taken_in(records, parent, want)?;
            taken.extend_from_slice(drawn);
            next_free_address(space, &taken)
                .map(|a| a.to_string())
                .ok_or(IpamError::Full)
        }
        (Want::Vlan(_), Kind::VlanGroup) => {
            let ranges: Vec<(u32, u32)> = vid_ranges(&parent.fields)?
                .into_iter()
                .map(|(lo, hi)| (u32::from(lo), u32::from(hi)))
                .collect();
            let mut taken = BTreeSet::new();
            for r in records
                .iter()
                .filter(|r| r.kind == Kind::Vlan && text(&r.fields, "group") == Some(&parent.id))
            {
                if let Some(v) = parsed::<ir::VlanId>(&r.fields, "vid")? {
                    taken.insert(u32::from(v.0));
                }
            }
            next_free_number(&ranges, &taken)
                .map(|n| n.to_string())
                .ok_or(IpamError::Full)
        }
        (Want::Asn, Kind::AsnRange) => {
            let range = (
                asn_of(&parent.fields, "first")?,
                asn_of(&parent.fields, "last")?,
            );
            let mut taken = BTreeSet::new();
            for r in records.iter().filter(|r| r.kind == Kind::Asn) {
                if let Some(a) = parsed::<ir::Asn>(&r.fields, "asn")? {
                    taken.insert(a.0);
                }
            }
            next_free_number(&[range], &taken)
                .map(|n| n.to_string())
                .ok_or(IpamError::Full)
        }
        _ => Err(invalid(format!(
            "a {} does not hand that out",
            parent.kind.node_kind().name()
        ))),
    }
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

/// Today's date in UTC.
pub fn today() -> ir::Date {
    date_from_days(crypto::now_unix().div_euclid(86_400))
}

fn add_days(d: &ir::Date, n: i64) -> ir::Date {
    date_from_days(days_from_date(d) + n)
}

/// Days since 1970-01-01 to a civil date (Howard Hinnant's `civil_from_days`).
fn date_from_days(z: i64) -> ir::Date {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    ir::Date {
        year: y as u16,
        month: m as u8,
        day: d as u8,
    }
}

/// A civil date to days since 1970-01-01 (Howard Hinnant's `days_from_civil`).
fn days_from_date(d: &ir::Date) -> i64 {
    let (m, day) = (i64::from(d.month), i64::from(d.day));
    let y = i64::from(d.year) - i64::from(m <= 2);
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = if m > 2 { m - 3 } else { m + 9 };
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(text: &str) -> ir::IpPrefix {
        ir::IpPrefix::parse(text).unwrap()
    }

    fn obj(pairs: &[(&str, Json)]) -> Fields {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.clone()))
            .collect()
    }

    fn s(v: &str) -> Json {
        Json::Str(v.into())
    }

    /// The table above is a copy of `schema/schema.yaml`'s plan layer. This
    /// holds it against the schema itself, read by the schema crate's own
    /// parser: same kinds, same fields in the same order, same cardinality,
    /// same enum tokens.
    #[test]
    fn fields_match_the_schema() {
        let source = std::fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../schema/schema.yaml"
        ))
        .unwrap();
        let root = fathom_schema::subset::parse(&source).unwrap();
        let kinds = root.get("kinds").and_then(|k| k.as_seq()).unwrap();
        let mut plan = Vec::new();
        for k in kinds {
            if k.get("layer").and_then(|l| l.as_str()) != Some("plan") {
                continue;
            }
            let name = k.get("kind").and_then(|n| n.as_str()).unwrap().to_string();
            let kind = Kind::ALL
                .into_iter()
                .find(|x| x.node_kind().name() == name)
                .unwrap_or_else(|| panic!("{name} has no Kind"));
            let fields = k.get("fields").and_then(|f| f.as_seq()).unwrap();
            let ours = kind.fields();
            assert_eq!(fields.len(), ours.len(), "{name}: field count");
            for (theirs, mine) in fields.iter().zip(ours) {
                let get = |key: &str| theirs.get(key).and_then(|v| v.as_str()).unwrap_or("");
                assert_eq!(get("name"), mine.name, "{name}");
                let card = match mine.card {
                    One => "1",
                    Optional => "0..1",
                    Many => "0..n",
                    OneOrMore => "1..n",
                };
                assert_eq!(get("card"), card, "{name}.{}", mine.name);
                let ty = get("type");
                if mine.tokens.is_empty() {
                    assert!(!ty.starts_with("enum"), "{name}.{} is an enum", mine.name);
                } else {
                    let declared: Vec<&str> = ty
                        .trim_start_matches("enum")
                        .trim()
                        .trim_start_matches('{')
                        .trim_end_matches('}')
                        .split(',')
                        .map(str::trim)
                        .collect();
                    assert_eq!(declared, mine.tokens, "{name}.{}", mine.name);
                }
                assert!(field_key(kind, mine.name).is_some());
            }
            plan.push(name);
        }
        assert_eq!(plan.len(), Kind::ALL.len(), "every plan kind has a Kind");
    }

    #[test]
    fn a_prefix_with_host_bits_or_a_wrong_status_is_refused() {
        let ok = obj(&[
            ("prefix", s("10.0.0.0/24")),
            ("status", s("active")),
            ("is_pool", Json::Bool(false)),
            ("mark_utilised", Json::Bool(false)),
        ]);
        assert!(validate(Kind::Prefix, &ok).is_ok());
        let mut host_bits = ok.clone();
        host_bits.insert("prefix".into(), s("10.0.0.1/24"));
        assert!(matches!(
            validate(Kind::Prefix, &host_bits),
            Err(IpamError::Invalid(_))
        ));
        let mut status = ok.clone();
        status.insert("status".into(), s("whatever"));
        assert!(validate(Kind::Prefix, &status).is_err());
        let mut unknown = ok.clone();
        unknown.insert("colour".into(), s("red"));
        assert!(validate(Kind::Prefix, &unknown).is_err());
        let mut missing = ok;
        missing.remove("status");
        assert!(validate(Kind::Prefix, &missing).is_err());
    }

    #[test]
    fn ipv6_prefixes_read_like_ipv4() {
        let ok = obj(&[
            ("prefix", s("2001:db8::/48")),
            ("status", s("container")),
            ("is_pool", Json::Bool(false)),
            ("mark_utilised", Json::Bool(false)),
        ]);
        assert!(validate(Kind::Prefix, &ok).is_ok());
    }

    #[test]
    fn a_reservation_holds_exactly_one_thing() {
        let base = obj(&[
            ("reason", s("WAN for the new site")),
            ("ends", s("2026-12-02")),
            ("work", s("W-1042")),
        ]);
        assert!(validate(Kind::Reservation, &base).is_err());
        let mut one = base.clone();
        one.insert("prefix".into(), s("192.0.2.0/29"));
        assert!(validate(Kind::Reservation, &one).is_ok());
        let mut two = one.clone();
        two.insert("address".into(), s("192.0.2.9"));
        assert!(validate(Kind::Reservation, &two).is_err());
    }

    #[test]
    fn next_free_prefix_steps_past_what_is_taken() {
        let parent = prefix_span(&p("10.0.0.0/24"));
        let taken = [
            prefix_span(&p("10.0.0.0/29")),
            point("10.0.0.9".parse().unwrap()),
        ];
        assert_eq!(
            next_free_prefix(parent, 29, &taken).unwrap().canonical(),
            "10.0.0.16/29"
        );
        assert_eq!(
            next_free_prefix(parent, 30, &taken).unwrap().canonical(),
            "10.0.0.12/30"
        );
        assert!(next_free_prefix(parent, 24, &[]).is_some());
        assert!(next_free_prefix(parent, 24, &taken).is_none());
        assert!(next_free_prefix(parent, 23, &[]).is_none());
    }

    #[test]
    fn next_free_prefix_in_ipv6_hands_out_a_64_from_a_48() {
        let parent = prefix_span(&p("2001:db8:1::/48"));
        let taken = [prefix_span(&p("2001:db8:1::/64"))];
        assert_eq!(
            next_free_prefix(parent, 64, &taken).unwrap().canonical(),
            "2001:db8:1:1::/64"
        );
        let all = prefix_span(&p("::/0"));
        assert_eq!(next_free_prefix(all, 0, &[]).unwrap().canonical(), "::/0");
    }

    #[test]
    fn a_29_is_eight_addresses_six_usable() {
        assert_eq!(counts(&p("192.0.2.0/29"), false), (8, 6));
        assert_eq!(counts(&p("192.0.2.0/29"), true), (8, 8));
        assert_eq!(counts(&p("192.0.2.0/31"), false), (2, 2));
        assert_eq!(counts(&p("2001:db8::/126"), false), (4, 4));
    }

    #[test]
    fn next_free_address_skips_network_broadcast_and_taken() {
        let u = usable(&p("192.0.2.0/29"), false);
        let taken = [
            point("192.0.2.1".parse().unwrap()),
            point("192.0.2.2".parse().unwrap()),
        ];
        assert_eq!(
            next_free_address(u, &taken).unwrap().to_string(),
            "192.0.2.3"
        );
        let full: Vec<Span> = (1..=6)
            .map(|n| point(format!("192.0.2.{n}").parse().unwrap()))
            .collect();
        assert!(next_free_address(u, &full).is_none());
        let v6 = usable(&p("2001:db8::/64"), false);
        assert_eq!(
            next_free_address(v6, &[]).unwrap().to_string(),
            "2001:db8::"
        );
    }

    #[test]
    fn next_free_number_walks_ranges_in_order() {
        let taken: BTreeSet<u32> = [100, 101, 103].into_iter().collect();
        assert_eq!(next_free_number(&[(100, 103)], &taken), Some(102));
        let full: BTreeSet<u32> = (100..=103).collect();
        assert_eq!(
            next_free_number(&[(100, 103), (200, 299)], &full),
            Some(200)
        );
        assert_eq!(next_free_number(&[(100, 103)], &full), None);
    }

    #[test]
    fn vlan_ranges_must_not_overlap() {
        let ok = obj(&[
            ("name", s("Campus")),
            ("vid_ranges", Json::Arr(vec![s("100-199"), s("300")])),
        ]);
        let checked = validate(Kind::VlanGroup, &ok);
        assert!(checked.is_ok(), "{checked:?}");
        let bad = obj(&[
            ("name", s("Campus")),
            ("vid_ranges", Json::Arr(vec![s("100-199"), s("150-160")])),
        ]);
        assert!(validate(Kind::VlanGroup, &bad).is_err());
        let backwards = obj(&[
            ("name", s("Campus")),
            ("vid_ranges", Json::Arr(vec![s("200-100")])),
        ]);
        assert!(validate(Kind::VlanGroup, &backwards).is_err());
    }

    #[test]
    fn dates_round_trip() {
        let d = ir::Date::parse("2026-11-02").unwrap();
        assert_eq!(add_days(&d, 30).canonical(), "2026-12-02");
        assert_eq!(add_days(&d, 0), d);
        let leap = ir::Date::parse("2028-02-28").unwrap();
        assert_eq!(add_days(&leap, 1).canonical(), "2028-02-29");
        assert_eq!(date_from_days(0).canonical(), "1970-01-01");
    }

    #[test]
    fn the_space_of_a_prefix_and_its_reservation_is_one() {
        let prefix = obj(&[("prefix", s("10.0.0.0/29")), ("vrf", s("V"))]);
        let held = obj(&[("prefix", s("10.0.0.0/29")), ("vrf", s("V"))]);
        let addr = obj(&[("address", s("10.0.0.0/29")), ("vrf", s("V"))]);
        assert_eq!(
            space_text(Kind::Prefix, &prefix).unwrap(),
            space_text(Kind::Reservation, &held).unwrap()
        );
        assert_ne!(
            space_text(Kind::Prefix, &prefix).unwrap(),
            space_text(Kind::Address, &addr).unwrap()
        );
    }
}
