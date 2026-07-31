//! STUB structured-value binding targets — one type per
//! `fathom_ir::value::*` path bound in `schema/schema.yaml`'s `scalars:`
//! block with `structured: true`.
//!
//! **These are stubs.** A structured value type owes no vendor round-trip
//! (62 §3.1 row 3) but does owe a canonical serialisation and a total order;
//! both land with the store. Shapes below follow the rule the house style
//! demands: where a defining document states the shape it is transcribed
//! with its citation, and where none does the type is an empty struct — an
//! invented field would be a defect, a missing one is only a gap. Types
//! whose declaration carries `contains_reference: true` in the schema hold
//! `fathom_id::NodeId`s (11 §6.5's registered exception).

use crate::scalar;

/// MTU value. 11 §4.4 declares `{ bytes, layer }`; the layer discriminant
/// (L2Frame vs L3Payload, a schema constraint per use site) lands with the
/// store — the stub carries bytes only rather than guess the discriminant's
/// shape.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Mtu {
    pub bytes: u32,
}

/// IKE identity — "a tagged union" (62 §3.1 row 3); its variants are stated
/// nowhere read, so the stub declares none.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct IkeId;

/// Peer specification: `Address(IpAddr)` or `Dynamic(IkeId)` — one field
/// with two shapes (62 §20.1, `IkeGateway.peer`).
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum PeerSpec {
    Address(scalar::IpAddr),
    Dynamic(IkeId),
}

/// Dead peer detection settings (11 §6.7). Shape stated nowhere read.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Dpd;

/// Postal address — user-typed structure, no vendor text to round-trip
/// (62 §3.3). Free text inside: 37 §2.2's personal-data channel applies.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct PostalAddress {
    pub lines: Vec<scalar::Text>,
    pub locality: Option<scalar::Text>,
    pub region: Option<scalar::Text>,
    pub postcode: Option<scalar::Text>,
    pub country: Option<scalar::Text>,
}

/// The closed attribute type vocabulary (62 §13.3, transcribed from
/// 19 §4.3). `Decimal` does not exist and may not be added; there is no
/// `SecretPlaceholder` variant and no path to one. Gate
/// `schema.attrtype.drift` — 62 §13.3's table vs this enum — runs as a
/// cargo test in `fathom-schemagen` (tests/attrtype_drift.rs).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum AttrType {
    Bool,
    Integer,
    Text,
    Enum,
    Bandwidth,
    VlanId,
    IpPrefix,
    InterfaceAddress,
    Identifier,
    Date,
}

impl AttrType {
    /// Every variant, declaration order.
    pub const ALL: [AttrType; 10] = [
        AttrType::Bool,
        AttrType::Integer,
        AttrType::Text,
        AttrType::Enum,
        AttrType::Bandwidth,
        AttrType::VlanId,
        AttrType::IpPrefix,
        AttrType::InterfaceAddress,
        AttrType::Identifier,
        AttrType::Date,
    ];

    /// The variant's identifier, exactly as 62 §13.3 spells it.
    pub const fn name(self) -> &'static str {
        match self {
            AttrType::Bool => "Bool",
            AttrType::Integer => "Integer",
            AttrType::Text => "Text",
            AttrType::Enum => "Enum",
            AttrType::Bandwidth => "Bandwidth",
            AttrType::VlanId => "VlanId",
            AttrType::IpPrefix => "IpPrefix",
            AttrType::InterfaceAddress => "InterfaceAddress",
            AttrType::Identifier => "Identifier",
            AttrType::Date => "Date",
        }
    }
}

/// The value slot of `Service.attributes` / `ServiceEndpoint.attributes`:
/// a tagged union over `AttrType` (62 §3.3). Carries its tag in
/// serialisation so a stored value survives its declaration being withdrawn
/// (19 §4.3). `Enum` payloads are per-declaration (`EnumId` from
/// `AttributeDecl.enum_values`, 62 §7 rule 5), stubbed as raw ids.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum AttrValue {
    Bool(bool),
    Integer(i64),
    Text(scalar::Text),
    Enum { enum_id: u32, variant_id: u32 },
    Bandwidth(scalar::Bandwidth),
    VlanId(scalar::VlanId),
    IpPrefix(scalar::IpPrefix),
    InterfaceAddress(scalar::InterfaceAddress),
    Identifier(scalar::Identifier),
    Date(scalar::Date),
}

impl AttrValue {
    /// The tag a value carries. The exhaustive match is deliberate: adding
    /// an `AttrType` variant without its `AttrValue` twin (or vice versa)
    /// fails compilation here, keeping the pair welded.
    pub const fn attr_type(&self) -> AttrType {
        match self {
            AttrValue::Bool(_) => AttrType::Bool,
            AttrValue::Integer(_) => AttrType::Integer,
            AttrValue::Text(_) => AttrType::Text,
            AttrValue::Enum { .. } => AttrType::Enum,
            AttrValue::Bandwidth(_) => AttrType::Bandwidth,
            AttrValue::VlanId(_) => AttrType::VlanId,
            AttrValue::IpPrefix(_) => AttrType::IpPrefix,
            AttrValue::InterfaceAddress(_) => AttrType::InterfaceAddress,
            AttrValue::Identifier(_) => AttrType::Identifier,
            AttrValue::Date(_) => AttrType::Date,
        }
    }
}

/// Naming-scheme conformance, `{ state: enum(conformance_state), reason:
/// Text? }` (19 §8.3 via 62 §11.2). Derived-only; never serialised.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct NameConformance {
    pub state: crate::generated::ir_types::ConformanceState,
    pub reason: Option<scalar::Text>,
}

/// Static-route next hop: "Address / Interface(NodeId -> LogicalUnit) /
/// Discard / Reject / NextTable" (11 §6.5, transcribed from the shipped
/// tree's `StaticRoute.next_hop` doc). The `NodeId` is the registered
/// exception. VERIFY: the `NextTable` payload's type is stated nowhere read.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum NextHop {
    Address(scalar::IpAddr),
    Interface(fathom_id::NodeId),
    Discard,
    Reject,
    NextTable(scalar::Identifier),
}

/// Qualified next hop, `(NextHop, preference, metric)` (11 §6.5,
/// `StaticRoute.qualified`). VERIFY: the integer widths are stated nowhere
/// read.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct QualifiedNextHop {
    pub next_hop: NextHop,
    pub preference: Option<u32>,
    pub metric: Option<u32>,
}

/// Redundancy-group node priority, `(member_index, u8)` (11 §6.3,
/// `RedundancyGroup.node_priority`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct NodePriority {
    pub member_index: u8,
    pub priority: u8,
}

/// OSPF area block (11 §6.5). Shape stated nowhere read.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct OspfArea;

/// Security-policy scope — carries zone/unit `NodeId`s, registered like
/// `NextHop` (11 §6.6). Shape stated nowhere read.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct PolicyScope;

/// Address-object value (11 §6.6). Shape stated nowhere read.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct AddressValue;

/// L4 match specification (11 §6.6). Shape stated nowhere read.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct L4Spec;

/// NAT rule scope — Zone/Interface/RoutingInstance `NodeId`s (11 §6.6).
/// Shape stated nowhere read.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct NatScope;

/// NAT action (11 §6.6). Shape stated nowhere read.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct NatAction;

/// VPN monitor settings — `source_interface: NodeId` (11 §6.7). Shape
/// stated nowhere read.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct VpnMonitor;

/// Physical port position on a panel (19 §3.3). Shape stated nowhere read.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct PortPosition;

/// Transceiver description (19 §3.3). Shape stated nowhere read.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Transceiver;

/// Optical split ratio (19 §3.5). Shape stated nowhere read.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct SplitRatio;

/// Service endpoint cardinality, `{ min: u8, max: Option<u8> }` (19 §4.3;
/// DIA 1..1, E-Line 2..2, E-LAN 2..n).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct EndpointCardinality {
    pub min: u8,
    pub max: Option<u8>,
}

/// A `ServiceType` attribute declaration (19 §4.3): key, label,
/// `value_type: AttrType`, `enum_values`, `required`, `withdrawn` — the
/// closed grammar's row. Stub declares no fields until the type-set import
/// lands; the closed `AttrType` vocabulary it types against is above.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct AttributeDecl;

/// A field path — the L3 completeness profile's element (11 §9.1 via
/// `ServiceType.completeness`). Shape stated nowhere read.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct FieldPath;

/// Path-segment resolution (19 §6.6). Derived-only; never serialised
/// (62 §11). Shape stated nowhere read.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Resolution;

/// Syslog host: `IpAddr | Fqdn` (11 §6.8), a union 62 §4.3's type grammar
/// cannot spell — "a tagged structured value in the PeerSpec shape is
/// assumed" per the shipped tree's own VERIFY marker, carried here.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum SyslogHost {
    Address(scalar::IpAddr),
    Fqdn(scalar::Fqdn),
}
