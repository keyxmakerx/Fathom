//! STUB semantic-scalar binding targets — one type per `fathom_ir::scalar::*`
//! path bound in `schema/schema.yaml`'s `scalars:` block.
//!
//! **These are stubs.** The `Scalar` trait (11 §4.2: `parse` / `emit` /
//! `canonical` / `validate`, three property-tested laws, per-platform token
//! tables) does not exist yet; no type here parses or emits anything. Each
//! carries the representation its defining document states where one is
//! stated (62 §3.3–§3.4, 11 §4.3) and nothing it does not. They exist so
//! that the paths the schema binds resolve — `cargo build` of this crate is
//! the compile-time half of gate `schema.scalar.unbound` (62 §18.1), driven
//! by the binding inventory in `generated::ir_types`.
//!
//! Representation notes marked `VERIFY` follow the house rule: nothing
//! underdetermined is guessed silently.

use core::net;

/// IPv4 address (11 §4.3).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Ip4Addr(pub net::Ipv4Addr);

/// IPv6 address (11 §4.3).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Ip6Addr(pub net::Ipv6Addr);

/// Either-family IP address (11 §4.3).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct IpAddr(pub net::IpAddr);

/// Network prefix — host bits zeroed in canonical form (11 §4.3).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct IpPrefix {
    pub addr: net::IpAddr,
    pub len: u8,
}

/// Interface address — an address *on* a prefix, host bits kept. Never an
/// `IpPrefix`: 11 §4.3 calls the conflation "the most common modelling bug
/// in this domain", and 62 §13.3 refuses to map it onto `Prefix` for rules.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct InterfaceAddress {
    pub addr: net::IpAddr,
    pub prefix_len: u8,
}

/// Inclusive address range (11 §4.3).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct IpRange {
    pub start: net::IpAddr,
    pub end: net::IpAddr,
}

/// 48-bit MAC address (11 §4.3).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct MacAddress(pub [u8; 6]);

/// IP protocol number (11 §4.3).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct IpProtocol(pub u8);

/// L4 port (11 §4.3).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct L4Port(pub u16);

/// Inclusive L4 port range (11 §4.3).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct PortRange {
    pub start: u16,
    pub end: u16,
}

/// 802.1Q VLAN id (11 §4.3).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct VlanId(pub u16);

/// Autonomous system number, 4-byte capable (11 §4.3).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Asn(pub u32);

/// Duration in whole seconds. Per-field range constraints live in the
/// schema, not here (62 §3.2, the `Seconds` row's rule).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Seconds(pub u64);

/// Size in kilobytes — IPsec lifetime units (11 §4.3).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Kilobytes(pub u64);

/// Diffie-Hellman group number. The per-platform token tables are the
/// scalar impl's, when it exists (11 §4.3; 62 §3.4 cites it as the model).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct DhGroup(pub u16);

/// Encryption algorithm token, canonical spelling (11 §4.3).
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct EncryptionAlgorithm(pub String);

/// Integrity/authentication algorithm token, canonical spelling (11 §4.3).
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct IntegrityAlgorithm(pub String);

/// IKE authentication method token (11 §4.3).
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct AuthMethod(pub String);

/// IKE protocol version (11 §4.3).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct IkeVersion(pub u8);

/// Vendor object name — validated, never normalised; case significant on
/// some platforms, so folding is per-field schema data, never the type's
/// (11 §4.3; 62 §9.1).
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Identifier(pub String);

/// Interface name. The parsed/raw split and the `parsed_then_raw`
/// comparator (11 §4.6) land with the scalar impl; the stub carries the raw
/// text only.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct InterfaceName(pub String);

/// OS version string; per-family comparators resolve in code (11 §4.7).
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct OsVersion(pub String);

/// Millisecond instant (11 §4.3). **Not** a `Date` and never implicitly
/// convertible to one (62 §3.3).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Timestamp(pub i64);

/// Fully qualified domain name (11 §4.3).
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Fqdn(pub String);

/// Route distinguisher, `{ admin, assigned }` (11 §4.3; 62 §3.4 gives
/// `RouteTarget` "the same shape"). Canonical `65000:100`.
/// VERIFY: admin may also be IPv4-based per RFC 4364 type 1 — the variant
/// split lands with the scalar impl.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct RouteDistinguisher {
    pub admin: u32,
    pub assigned: u32,
}

/// The redaction marker — a secret's *place*, never its value (11 §4.5).
/// Deliberately carries nothing.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct SecretPlaceholder;

/// Free text. The one free-string scalar; 37 §2.2's personal-data channel
/// applies wherever it appears.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Text(pub String);

/// Calendar date, proleptic Gregorian, no timezone, no time (62 §3.3).
/// Stored, rendered, sorted, exported — **never compared against a clock**
/// (75 §3.8).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Date {
    pub year: u16,
    pub month: u8,
    pub day: u8,
}

/// Fixed-point coordinates, degrees × 10⁷ (62 §3.3). Exactly representable,
/// byte-identical across platforms; stored and rendered, never computed
/// with — no distance function ships.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct LatLon {
    pub lat_e7: i32,
    pub lon_e7: i32,
}

/// CLLI code, charset `A–Z0–9`, upper case (62 §3.3). Charset and length
/// checks only — no registry validation, the workspace is offline.
/// VERIFY: accepted lengths (8-character site prefix vs 11-character full
/// code) — 62 §3.3's own marker, carried.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Clli(pub String);

/// Bandwidth in **bits per second**, `u64`, never a float (62 §3.4).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Bandwidth(pub u64);

/// IANA tz identifier, stored as written, case-sensitive; membership
/// validation against a pinned tzdb list lands with the impl. Never
/// evaluated against a clock (62 §3.4).
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct TzName(pub String);

/// Platform id — a foreign key into `schema/platforms.yaml` (62 §3.4, §14).
/// Constructing one from a token not in the registry is the constructing
/// layer's validation error.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct PlatformId(pub String);

/// Dotted id in the closed first-party `infer.*` namespace, validated at
/// build against the registered inference-pass list (62 §3.4). Users cannot
/// add passes (11 §9.5).
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct InferenceRuleId(pub String);

/// Route target, `{ admin, assigned }`, canonical `65000:100`; parse accepts
/// and strips the `target:` prefix (62 §3.4). Stores the pair and nothing
/// else.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct RouteTarget {
    pub admin: u32,
    pub assigned: u32,
}

/// OSPF area id. VERIFY: representation (dotted-quad vs plain integer
/// canonical form) is stated nowhere read; the 32-bit value is the safe
/// common ground.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct OspfAreaId(pub u32);
