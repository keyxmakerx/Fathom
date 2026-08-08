//! The semantic scalars — one type per `fathom_ir::scalar::*` path bound in
//! `schema/schema.yaml`'s `scalars:` block, carrying 11 §4.3's catalogue
//! (with 62 §3.3–§3.4's additions) as real types.
//!
//! Each implements the [`Scalar`] trait's **canonical half** (WO-01): `parse`
//! from canonical text and `canonical()` back to it, with 11 §4.2's L1c and
//! L3 laws pinned by `tests/scalar_contract.rs`. The per-platform halves —
//! parse over a platform's token table, `emit(plat)`, `validate(ctx)`, and
//! every token table (`group14`, `10g`, Cisco `aabb.ccdd.eeff`, Junos
//! `sha-256`) — land with the platform registry and the emitters, and extend
//! this trait rather than replacing it.
//!
//! `SecretPlaceholder` implements no [`Scalar`]: 11 §4.5 makes construction
//! from arbitrary text impossible, which is invariant 3 expressed in the type
//! system. It is the one registered exemption, and
//! `tests/scalar_contract.rs` classifies it as such.
//!
//! Representation fields are public — validity is `parse`'s contract, so the
//! laws are quantified over parse-reachable values and a hand-built value can
//! sit outside them (WO-01 §9 row 1, §10 item 3). `cargo build` of this crate
//! remains the compile-time half of gate `schema.scalar.unbound` (62 §18.1),
//! driven by the binding inventory in `generated::ir_types`; the test file is
//! the trait-conformance half.
//!
//! Representation notes marked `VERIFY` follow the house rule: nothing
//! underdetermined is guessed silently.

use core::net;

/// 11 §4.2's round-trip contract, canonical half. `parse` is the
/// platform-independent direction; the per-platform methods — parse over a
/// platform's token table, `emit(plat)`, `validate(ctx)` — land with the
/// platform registry and the emitters (WO-01 §8), normalising into this core.
pub trait Scalar: Sized + Clone + Eq + Ord {
    /// The scalar's schema name, exactly as `schema/schema.yaml` spells it.
    const NAME: &'static str;

    /// Canonical text -> value. Accepts the canonical grammar (plus the
    /// row's listed alternates) in WO-01 §4.2; refuses everything else with
    /// a typed reason. Deterministic: no clock, no RNG, no locale.
    fn parse(text: &str) -> Result<Self, ScalarParseError>;

    /// Value -> canonical text — 11 §4.2's `canonical()`: the platform-
    /// independent form used for equality across platforms, for diffing,
    /// and for the deterministic ordering in invariant 9.
    fn canonical(&self) -> String;
}

/// Why canonical text failed to parse. Carries no copy of the input — the
/// caller has it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct ScalarParseError {
    /// `Scalar::NAME` of the refusing type.
    pub scalar: &'static str,
    pub kind: ScalarParseErrorKind,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ScalarParseErrorKind {
    /// The text does not match the scalar's grammar; `expected` names the
    /// grammar in one static phrase.
    Syntax { expected: &'static str },
    /// The grammar matched but a component is outside its permitted range;
    /// `what` names the component. Bounds live in WO-01 §4.2's table and in
    /// the type's doc comment, not in the error.
    Range { what: &'static str },
    /// A charset-validated scalar met a byte outside its set, at this byte
    /// offset.
    Charset { offset: usize },
    /// A prefix carried set host bits — 11 §4.3: "Setting host bits is a
    /// parse error". `IpPrefix` only.
    HostBits,
}

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

/// Inclusive address range (11 §4.3). Canonical `lo-hi`; both ends are the
/// same family and `lo <= hi`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct IpRange {
    pub lo: net::IpAddr,
    pub hi: net::IpAddr,
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

/// Inclusive L4 port range (11 §4.3). Canonical `lo-hi`, `lo <= hi`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct PortRange {
    pub lo: u16,
    pub hi: u16,
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
pub struct Seconds(pub u32);

/// Size in kilobytes — IPsec lifetime units (11 §4.3).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Kilobytes(pub u64);

/// Diffie-Hellman group number, canonical as the number (11 §4.3). The
/// per-platform token tables (`group14`, `group 14`) land with the emitters.
/// The five numbers 11 §4.3 names are the consts below; a `DhGroup` is any
/// 1..=65535 IANA transform-type-4 number, not a closed set (WO-01 §4.2
/// row 15, §12 item 2).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct DhGroup(pub u16);

impl DhGroup {
    /// MODP 1024-bit, IANA group 2 (11 §4.3).
    pub const MODP1024: DhGroup = DhGroup(2);
    /// MODP 1536-bit, IANA group 5 (11 §4.3).
    pub const MODP1536: DhGroup = DhGroup(5);
    /// MODP 2048-bit, IANA group 14 (11 §4.3) — the field card's `group14`.
    pub const MODP2048: DhGroup = DhGroup(14);
    /// 256-bit random ECP, IANA group 19 (11 §4.3).
    pub const ECP256: DhGroup = DhGroup(19);
    /// 384-bit random ECP, IANA group 20 (11 §4.3).
    pub const ECP384: DhGroup = DhGroup(20);
}

/// Cipher family of an [`EncryptionAlgorithm`] (11 §4.3).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum EncFamily {
    Aes,
    TripleDes,
    Des,
}

/// Mode of operation of an [`EncryptionAlgorithm`] (11 §4.3).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum EncMode {
    Cbc,
    Gcm,
}

/// Encryption algorithm, canonical `aes-256-gcm` style (11 §4.3). The `aead`
/// flag is load-bearing: field card side 1 says *"GCM is AEAD, so there is no
/// separate authentication-algorithm"*, which 11 §6.7 makes a schema
/// constraint. `key_bits` is `Some` for the AES family and `None` for
/// (3)DES, whose key size is implied by the family.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct EncryptionAlgorithm {
    pub family: EncFamily,
    pub key_bits: Option<u16>,
    pub mode: EncMode,
    pub aead: bool,
}

/// Integrity/authentication algorithm, canonical `hmac-sha-256-128` style
/// (11 §4.3). Must be `Absent` when the encryption algorithm is AEAD. Vendor
/// spellings (Junos `sha-256`) are per-platform token-table work.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum IntegrityAlgorithm {
    HmacMd5_96,
    HmacSha1_96,
    HmacSha256_128,
    HmacSha384_192,
    HmacSha512_256,
}

/// IKE authentication method (11 §4.3). The field card's own P1 line is
/// `authentication-method pre-shared-keys`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum AuthMethod {
    PreSharedKeys,
    RsaSignatures,
    EcdsaSignatures,
}

/// IKE protocol version (11 §4.3). The field card's `version v2-only`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum IkeVersion {
    V1Only,
    V2Only,
    V1OrV2,
}

/// Vendor object name — validated, never normalised; case significant on
/// some platforms, so folding is per-field schema data, never the type's
/// (11 §4.3; 62 §9.1).
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Identifier(pub String);

/// Interface name — the raw vendor token, which wins on emit *"byte-for-byte,
/// always"* (11 §4.6). The parsed lens and the `parsed_then_raw` comparator
/// (11 §4.6) land with the platform registry; this type carries the raw text
/// only, and `canonical()` is that text unchanged.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct InterfaceName(pub String);

/// OS version string, raw (11 §4.7).
///
/// The derived `Ord` is **byte order, not version order**: it exists so the
/// type is storable and deterministically sortable (invariant 9), and it is
/// not a comparator for version predicates. 11 §4.7's per-family comparator
/// arrives with the platform registry; until then no code may read this
/// ordering as "newer than" (WO-01 §12 item 3).
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct OsVersion(pub String);

/// Millisecond instant, milliseconds since the Unix epoch — *"same epoch and
/// precision as ULID"* (11 §4.3). **Not** a `Date` and never implicitly
/// convertible to one (62 §3.3). Canonical text is RFC 3339 UTC with a
/// three-digit fraction; the conversion is pure integer arithmetic and never
/// reads a clock (invariant 9).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Timestamp(pub u64);

/// Fully qualified domain name (11 §4.3).
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Fqdn(pub String);

/// Route distinguisher — 11 §4.3's *"type 0 and type 1 forms"*, one variant
/// each (62 §3.4 gives `RouteTarget` "the same shape"). Canonical
/// `65000:100` (type 0) and `198.51.100.1:100` (type 1). The 4-byte-AS
/// type 2 form is refused; adding it is a catalogue extension (WO-01 §10
/// item 4).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum RouteDistinguisher {
    Type0 { admin: u16, assigned: u32 },
    Type1 { admin: net::Ipv4Addr, assigned: u16 },
}

/// The label of a secret a [`SecretPlaceholder`] stands in for (11 §4.5).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum SecretLabel {
    Psk,
    CertKey,
    SnmpCommunity,
    TacacsKey,
    Password,
}

impl SecretLabel {
    /// The token an emitter renders inside the angle brackets. `<PSK>` is
    /// 11 §4.5's own rendering.
    // VERIFY: the four tokens beyond <PSK> are stated nowhere read; confirm
    // before an emitter renders them into config (WO-01 §10 item 1).
    pub fn token(self) -> &'static str {
        match self {
            SecretLabel::Psk => "PSK",
            SecretLabel::CertKey => "CERT-KEY",
            SecretLabel::SnmpCommunity => "SNMP-COMMUNITY",
            SecretLabel::TacacsKey => "TACACS-KEY",
            SecretLabel::Password => "PASSWORD",
        }
    }
}

/// A pointer to where the human keeps the secret, never a value. Length-capped
/// at 120 bytes (11 §4.5). The field is private so the cap cannot be bypassed.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct SecretHint(String);

impl SecretHint {
    /// The only constructor. Refuses more than 120 bytes (11 §4.5).
    pub fn new(text: &str) -> Result<SecretHint, ScalarParseError> {
        if text.len() > 120 {
            return Err(ScalarParseError {
                scalar: "SecretPlaceholder",
                kind: ScalarParseErrorKind::Range {
                    what: "hint length",
                },
            });
        }
        Ok(SecretHint(text.to_owned()))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// The redaction marker — a secret's *place*, never its value (11 §4.5).
///
/// Invariant 3 in the type system: *"There is no
/// `SecretPlaceholder::from_value`"*. Both fields are private and the only
/// constructors take a label and optional non-recoverable metadata, so there
/// is no path from arbitrary text to a value of this type. It therefore
/// implements no [`Scalar`] — the one registered exemption from the trait
/// (WO-01 §4.4, §12 item 5).
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct SecretPlaceholder {
    label: SecretLabel,
    hint: Option<SecretHint>,
}

impl SecretPlaceholder {
    pub fn new(label: SecretLabel) -> Self {
        SecretPlaceholder { label, hint: None }
    }

    pub fn with_hint(label: SecretLabel, hint: SecretHint) -> Self {
        SecretPlaceholder {
            label,
            hint: Some(hint),
        }
    }

    pub fn label(&self) -> SecretLabel {
        self.label
    }

    pub fn hint(&self) -> Option<&SecretHint> {
        self.hint.as_ref()
    }

    /// The `<LABEL>` form an emitter writes in the value position (11 §4.5:
    /// *"Emits as `pre-shared-key ascii-text "<PSK>""*).
    pub fn placeholder(&self) -> String {
        let mut out = String::with_capacity(self.label.token().len() + 2);
        out.push('<');
        out.push_str(self.label.token());
        out.push('>');
        out
    }
}

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

/// Route target — *"same shape as `RouteDistinguisher`"* (62 §3.4), so the
/// same two variants. Canonical `65000:100`, never with the prefix; parse
/// accepts and strips a leading `target:`. Stores the pair and nothing else;
/// RFC 4360's extended-community semantics are the meaning, not the value.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum RouteTarget {
    Type0 { admin: u16, assigned: u32 },
    Type1 { admin: net::Ipv4Addr, assigned: u16 },
}

/// OSPF area id. VERIFY: representation (dotted-quad vs plain integer
/// canonical form) is stated nowhere read; the 32-bit value is the safe
/// common ground.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct OspfAreaId(pub u32);

// ---------------------------------------------------------------------------
// Private helpers. WO-01 §4.1's numeric grammar, the charset scans and the
// civil-date arithmetic, shared by the impls below. Nothing here is public,
// and nothing here reads a clock, an RNG, an environment variable or a locale
// (invariant 9).
// ---------------------------------------------------------------------------

/// WO-01 §4.1's unsigned grammar, named once so every refusal says the same
/// thing.
const UNSIGNED: &str = "one or more ASCII digits, no sign, no leading zero";
/// WO-01 §4.1's signed grammar. `-0` is refused so canonical stays injective.
const SIGNED: &str = "an optional `-` then one or more ASCII digits, no leading zero, never `-0`";

fn err(scalar: &'static str, kind: ScalarParseErrorKind) -> ScalarParseError {
    ScalarParseError { scalar, kind }
}

fn syntax(expected: &'static str) -> ScalarParseErrorKind {
    ScalarParseErrorKind::Syntax { expected }
}

fn range(what: &'static str) -> ScalarParseErrorKind {
    ScalarParseErrorKind::Range { what }
}

/// The unsigned numeric grammar (WO-01 §4.1). Overflow of `u64` is a `Range`
/// failure; a malformed token is a `Syntax` one.
fn parse_unsigned(text: &str) -> Result<u64, ScalarParseErrorKind> {
    let bytes = text.as_bytes();
    if bytes.is_empty() || !bytes.iter().all(u8::is_ascii_digit) {
        return Err(syntax(UNSIGNED));
    }
    if bytes.len() > 1 && bytes[0] == b'0' {
        return Err(syntax(UNSIGNED));
    }
    text.parse::<u64>().map_err(|_| range("magnitude"))
}

/// The unsigned grammar plus an inclusive upper bound.
fn bounded(text: &str, max: u64, what: &'static str) -> Result<u64, ScalarParseErrorKind> {
    let n = parse_unsigned(text)?;
    if n > max {
        return Err(range(what));
    }
    Ok(n)
}

/// The signed numeric grammar (WO-01 §4.1).
fn parse_signed(text: &str) -> Result<i64, ScalarParseErrorKind> {
    let (negative, digits) = match text.strip_prefix('-') {
        Some(rest) => (true, rest),
        None => (false, text),
    };
    let magnitude = parse_unsigned(digits).map_err(|k| match k {
        ScalarParseErrorKind::Syntax { .. } => syntax(SIGNED),
        other => other,
    })?;
    if negative && magnitude == 0 {
        return Err(syntax(SIGNED));
    }
    if magnitude > i64::MAX as u64 {
        return Err(range("magnitude"));
    }
    let value = magnitude as i64;
    Ok(if negative { -value } else { value })
}

/// A non-empty run of ASCII-graphic bytes, 0x21–0x7E (WO-01 §4.2 row 20).
fn ascii_graphic(text: &str) -> Result<(), ScalarParseErrorKind> {
    if text.is_empty() {
        return Err(syntax("a non-empty ASCII-graphic string"));
    }
    for (offset, byte) in text.bytes().enumerate() {
        if !(0x21..=0x7E).contains(&byte) {
            return Err(ScalarParseErrorKind::Charset { offset });
        }
    }
    Ok(())
}

/// A zero-padded fixed-width decimal field, as RFC 3339 spells one. Unlike
/// [`parse_unsigned`] a leading zero is required, not refused.
fn fixed_digits(bytes: &[u8]) -> Option<u64> {
    if bytes.is_empty() || !bytes.iter().all(u8::is_ascii_digit) {
        return None;
    }
    let mut value = 0u64;
    for byte in bytes {
        value = value * 10 + u64::from(byte - b'0');
    }
    Some(value)
}

/// Proleptic Gregorian: divisible by 4, except by 100 unless by 400.
fn is_leap(year: u64) -> bool {
    year.is_multiple_of(4) && (!year.is_multiple_of(100) || year.is_multiple_of(400))
}

fn days_in_month(year: u64, month: u64) -> u64 {
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 => {
            if is_leap(year) {
                29
            } else {
                28
            }
        }
        _ => 0,
    }
}

// days since 1970-01-01 -> (year, month, day), proleptic Gregorian.
fn civil_from_days(days: u64) -> (u64, u64, u64) {
    let z = days + 719_468;
    let era = z / 146_097;
    let doe = z % 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + if m <= 2 { 1 } else { 0 };
    (y, m, d)
}

// (year, month, day) -> days since 1970-01-01. Caller guarantees year >= 1970.
fn days_from_civil(y: u64, m: u64, d: u64) -> u64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y / 400;
    let yoe = y - era * 400;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// The widest prefix length the address family admits.
fn max_prefix_len(addr: &net::IpAddr) -> u64 {
    match addr {
        net::IpAddr::V4(_) => 32,
        net::IpAddr::V6(_) => 128,
    }
}

/// 11 §4.3: *"Setting host bits is a parse error"* — `IpPrefix` only.
fn has_host_bits(addr: &net::IpAddr, len: u8) -> bool {
    match addr {
        net::IpAddr::V4(a) => {
            let bits = u32::from(*a);
            len < 32 && bits & (u32::MAX >> len) != 0
        }
        net::IpAddr::V6(a) => {
            let bits = u128::from(*a);
            len < 128 && bits & (u128::MAX >> len) != 0
        }
    }
}

/// The two RFC 4364 forms `RouteDistinguisher` and `RouteTarget` share
/// (62 §3.4: *"same shape as `RouteDistinguisher`"*).
enum RdParts {
    Type0 { admin: u16, assigned: u32 },
    Type1 { admin: net::Ipv4Addr, assigned: u16 },
}

fn parse_rd_parts(text: &str) -> Result<RdParts, ScalarParseErrorKind> {
    const SHAPE: &str = "<administrator>:<assigned-number>";
    let (admin, assigned) = text.split_once(':').ok_or_else(|| syntax(SHAPE))?;
    if admin.contains('.') {
        let admin: net::Ipv4Addr = admin.parse().map_err(|_| syntax(SHAPE))?;
        let assigned = bounded(assigned, 65_535, "assigned number")? as u16;
        Ok(RdParts::Type1 { admin, assigned })
    } else {
        let admin = bounded(admin, 65_535, "administrator field")? as u16;
        let assigned = bounded(assigned, u64::from(u32::MAX), "assigned number")? as u32;
        Ok(RdParts::Type0 { admin, assigned })
    }
}

/// The eight canonical `EncryptionAlgorithm` tokens (WO-01 §4.2 row 16): the
/// forms the SRX field card uses plus their family/key-size/mode siblings.
/// Extending the table is an ordinary code-and-test change, never an
/// execution session's judgement call.
const ENC_TABLE: &[(&str, EncFamily, Option<u16>, EncMode)] = &[
    ("aes-128-cbc", EncFamily::Aes, Some(128), EncMode::Cbc),
    ("aes-192-cbc", EncFamily::Aes, Some(192), EncMode::Cbc),
    ("aes-256-cbc", EncFamily::Aes, Some(256), EncMode::Cbc),
    ("aes-128-gcm", EncFamily::Aes, Some(128), EncMode::Gcm),
    ("aes-192-gcm", EncFamily::Aes, Some(192), EncMode::Gcm),
    ("aes-256-gcm", EncFamily::Aes, Some(256), EncMode::Gcm),
    ("3des-cbc", EncFamily::TripleDes, None, EncMode::Cbc),
    ("des-cbc", EncFamily::Des, None, EncMode::Cbc),
];

// ---------------------------------------------------------------------------
// The 35 `Scalar` implementations, in WO-01 §4.2 part A's row order.
// `SecretPlaceholder` (row 26) implements no `Scalar` — 11 §4.5.
// ---------------------------------------------------------------------------

impl Scalar for Ip4Addr {
    const NAME: &'static str = "Ip4Addr";

    fn parse(text: &str) -> Result<Self, ScalarParseError> {
        text.parse::<net::Ipv4Addr>()
            .map(Ip4Addr)
            .map_err(|_| err(Self::NAME, syntax("a dotted-quad IPv4 address")))
    }

    fn canonical(&self) -> String {
        self.0.to_string()
    }
}

impl Scalar for Ip6Addr {
    const NAME: &'static str = "Ip6Addr";

    fn parse(text: &str) -> Result<Self, ScalarParseError> {
        text.parse::<net::Ipv6Addr>()
            .map(Ip6Addr)
            .map_err(|_| err(Self::NAME, syntax("an RFC 4291 IPv6 address")))
    }

    fn canonical(&self) -> String {
        self.0.to_string()
    }
}

impl Scalar for IpAddr {
    const NAME: &'static str = "IpAddr";

    fn parse(text: &str) -> Result<Self, ScalarParseError> {
        text.parse::<net::IpAddr>()
            .map(IpAddr)
            .map_err(|_| err(Self::NAME, syntax("an IPv4 or IPv6 address")))
    }

    fn canonical(&self) -> String {
        self.0.to_string()
    }
}

impl Scalar for IpPrefix {
    const NAME: &'static str = "IpPrefix";

    fn parse(text: &str) -> Result<Self, ScalarParseError> {
        const SHAPE: &str = "<address>/<prefix-length>";
        let (addr, len) = text
            .split_once('/')
            .ok_or_else(|| err(Self::NAME, syntax(SHAPE)))?;
        let addr: net::IpAddr = addr.parse().map_err(|_| err(Self::NAME, syntax(SHAPE)))?;
        let len = bounded(len, max_prefix_len(&addr), "prefix length")
            .map_err(|k| err(Self::NAME, k))? as u8;
        if has_host_bits(&addr, len) {
            return Err(err(Self::NAME, ScalarParseErrorKind::HostBits));
        }
        Ok(IpPrefix { addr, len })
    }

    fn canonical(&self) -> String {
        let (addr, len) = (self.addr, self.len);
        format!("{addr}/{len}")
    }
}

impl Scalar for InterfaceAddress {
    const NAME: &'static str = "InterfaceAddress";

    fn parse(text: &str) -> Result<Self, ScalarParseError> {
        const SHAPE: &str = "<address>/<prefix-length>";
        let (addr, len) = text
            .split_once('/')
            .ok_or_else(|| err(Self::NAME, syntax(SHAPE)))?;
        let addr: net::IpAddr = addr.parse().map_err(|_| err(Self::NAME, syntax(SHAPE)))?;
        let prefix_len = bounded(len, max_prefix_len(&addr), "prefix length")
            .map_err(|k| err(Self::NAME, k))? as u8;
        Ok(InterfaceAddress { addr, prefix_len })
    }

    fn canonical(&self) -> String {
        let (addr, len) = (self.addr, self.prefix_len);
        format!("{addr}/{len}")
    }
}

impl Scalar for IpRange {
    const NAME: &'static str = "IpRange";

    fn parse(text: &str) -> Result<Self, ScalarParseError> {
        const SHAPE: &str = "<low-address>-<high-address>";
        let (lo, hi) = text
            .split_once('-')
            .ok_or_else(|| err(Self::NAME, syntax(SHAPE)))?;
        let lo: net::IpAddr = lo.parse().map_err(|_| err(Self::NAME, syntax(SHAPE)))?;
        let hi: net::IpAddr = hi.parse().map_err(|_| err(Self::NAME, syntax(SHAPE)))?;
        if lo.is_ipv4() != hi.is_ipv4() {
            return Err(err(
                Self::NAME,
                syntax("both ends in the same address family"),
            ));
        }
        if lo > hi {
            return Err(err(Self::NAME, range("range order")));
        }
        Ok(IpRange { lo, hi })
    }

    fn canonical(&self) -> String {
        let (lo, hi) = (self.lo, self.hi);
        format!("{lo}-{hi}")
    }
}

impl Scalar for MacAddress {
    const NAME: &'static str = "MacAddress";

    fn parse(text: &str) -> Result<Self, ScalarParseError> {
        const SHAPE: &str = "six colon-separated pairs of hex digits";
        let groups: Vec<&str> = text.split(':').collect();
        if groups.len() != 6 {
            return Err(err(Self::NAME, syntax(SHAPE)));
        }
        let mut octets = [0u8; 6];
        for (slot, group) in octets.iter_mut().zip(groups) {
            let bytes = group.as_bytes();
            if bytes.len() != 2 || !bytes.iter().all(u8::is_ascii_hexdigit) {
                return Err(err(Self::NAME, syntax(SHAPE)));
            }
            *slot = u8::from_str_radix(group, 16).map_err(|_| err(Self::NAME, syntax(SHAPE)))?;
        }
        Ok(MacAddress(octets))
    }

    fn canonical(&self) -> String {
        let o = self.0;
        format!(
            "{:02x}:{:02x}:{:02x}:{:02x}:{:02x}:{:02x}",
            o[0], o[1], o[2], o[3], o[4], o[5]
        )
    }
}

impl Scalar for IpProtocol {
    const NAME: &'static str = "IpProtocol";

    fn parse(text: &str) -> Result<Self, ScalarParseError> {
        let n = bounded(text, 255, "protocol number").map_err(|k| err(Self::NAME, k))?;
        Ok(IpProtocol(n as u8))
    }

    fn canonical(&self) -> String {
        self.0.to_string()
    }
}

impl Scalar for L4Port {
    const NAME: &'static str = "L4Port";

    fn parse(text: &str) -> Result<Self, ScalarParseError> {
        let n = bounded(text, 65_535, "port number").map_err(|k| err(Self::NAME, k))?;
        Ok(L4Port(n as u16))
    }

    fn canonical(&self) -> String {
        self.0.to_string()
    }
}

impl Scalar for PortRange {
    const NAME: &'static str = "PortRange";

    fn parse(text: &str) -> Result<Self, ScalarParseError> {
        const SHAPE: &str = "<low-port>-<high-port>";
        let (lo, hi) = text
            .split_once('-')
            .ok_or_else(|| err(Self::NAME, syntax(SHAPE)))?;
        let lo = bounded(lo, 65_535, "port number").map_err(|k| err(Self::NAME, k))? as u16;
        let hi = bounded(hi, 65_535, "port number").map_err(|k| err(Self::NAME, k))? as u16;
        if lo > hi {
            return Err(err(Self::NAME, range("range order")));
        }
        Ok(PortRange { lo, hi })
    }

    fn canonical(&self) -> String {
        let (lo, hi) = (self.lo, self.hi);
        format!("{lo}-{hi}")
    }
}

impl Scalar for VlanId {
    const NAME: &'static str = "VlanId";

    fn parse(text: &str) -> Result<Self, ScalarParseError> {
        let n = parse_unsigned(text).map_err(|k| err(Self::NAME, k))?;
        if !(1..=4094).contains(&n) {
            return Err(err(Self::NAME, range("vlan id")));
        }
        Ok(VlanId(n as u16))
    }

    fn canonical(&self) -> String {
        self.0.to_string()
    }
}

impl Scalar for Asn {
    const NAME: &'static str = "Asn";

    fn parse(text: &str) -> Result<Self, ScalarParseError> {
        if let Some((high, low)) = text.split_once('.') {
            let high = bounded(high, 65_535, "asdot high half").map_err(|k| err(Self::NAME, k))?;
            let low = bounded(low, 65_535, "asdot low half").map_err(|k| err(Self::NAME, k))?;
            Ok(Asn((high * 65_536 + low) as u32))
        } else {
            let n = bounded(text, u64::from(u32::MAX), "asn").map_err(|k| err(Self::NAME, k))?;
            Ok(Asn(n as u32))
        }
    }

    fn canonical(&self) -> String {
        self.0.to_string()
    }
}

impl Scalar for Seconds {
    const NAME: &'static str = "Seconds";

    fn parse(text: &str) -> Result<Self, ScalarParseError> {
        let n = bounded(text, u64::from(u32::MAX), "seconds").map_err(|k| err(Self::NAME, k))?;
        Ok(Seconds(n as u32))
    }

    fn canonical(&self) -> String {
        self.0.to_string()
    }
}

impl Scalar for Kilobytes {
    const NAME: &'static str = "Kilobytes";

    fn parse(text: &str) -> Result<Self, ScalarParseError> {
        parse_unsigned(text)
            .map(Kilobytes)
            .map_err(|k| err(Self::NAME, k))
    }

    fn canonical(&self) -> String {
        self.0.to_string()
    }
}

impl Scalar for DhGroup {
    const NAME: &'static str = "DhGroup";

    fn parse(text: &str) -> Result<Self, ScalarParseError> {
        let n = parse_unsigned(text).map_err(|k| err(Self::NAME, k))?;
        if !(1..=65_535).contains(&n) {
            return Err(err(Self::NAME, range("group number")));
        }
        Ok(DhGroup(n as u16))
    }

    fn canonical(&self) -> String {
        self.0.to_string()
    }
}

impl Scalar for EncryptionAlgorithm {
    const NAME: &'static str = "EncryptionAlgorithm";

    fn parse(text: &str) -> Result<Self, ScalarParseError> {
        for &(token, family, key_bits, mode) in ENC_TABLE {
            if token == text {
                return Ok(EncryptionAlgorithm {
                    family,
                    key_bits,
                    mode,
                    aead: matches!(mode, EncMode::Gcm),
                });
            }
        }
        Err(err(
            Self::NAME,
            syntax("one of WO-01 §4.2 row 16's eight canonical tokens"),
        ))
    }

    /// Values outside [`ENC_TABLE`] are not parse-reachable (the public fields
    /// admit them; WO-01 §9 row 1 records that hole) and canonicalise to the
    /// empty string rather than to an invented token.
    fn canonical(&self) -> String {
        for &(token, family, key_bits, mode) in ENC_TABLE {
            if family == self.family && key_bits == self.key_bits && mode == self.mode {
                return token.to_owned();
            }
        }
        String::new()
    }
}

impl Scalar for IntegrityAlgorithm {
    const NAME: &'static str = "IntegrityAlgorithm";

    fn parse(text: &str) -> Result<Self, ScalarParseError> {
        match text {
            "hmac-md5-96" => Ok(IntegrityAlgorithm::HmacMd5_96),
            "hmac-sha1-96" => Ok(IntegrityAlgorithm::HmacSha1_96),
            "hmac-sha-256-128" => Ok(IntegrityAlgorithm::HmacSha256_128),
            "hmac-sha-384-192" => Ok(IntegrityAlgorithm::HmacSha384_192),
            "hmac-sha-512-256" => Ok(IntegrityAlgorithm::HmacSha512_256),
            _ => Err(err(
                Self::NAME,
                syntax("a canonical `hmac-sha-256-128`-style token"),
            )),
        }
    }

    fn canonical(&self) -> String {
        match self {
            IntegrityAlgorithm::HmacMd5_96 => "hmac-md5-96",
            IntegrityAlgorithm::HmacSha1_96 => "hmac-sha1-96",
            IntegrityAlgorithm::HmacSha256_128 => "hmac-sha-256-128",
            IntegrityAlgorithm::HmacSha384_192 => "hmac-sha-384-192",
            IntegrityAlgorithm::HmacSha512_256 => "hmac-sha-512-256",
        }
        .to_owned()
    }
}

impl Scalar for AuthMethod {
    const NAME: &'static str = "AuthMethod";

    fn parse(text: &str) -> Result<Self, ScalarParseError> {
        match text {
            "pre-shared-keys" => Ok(AuthMethod::PreSharedKeys),
            "rsa-signatures" => Ok(AuthMethod::RsaSignatures),
            "ecdsa-signatures" => Ok(AuthMethod::EcdsaSignatures),
            _ => Err(err(
                Self::NAME,
                syntax("`pre-shared-keys`, `rsa-signatures` or `ecdsa-signatures`"),
            )),
        }
    }

    fn canonical(&self) -> String {
        match self {
            AuthMethod::PreSharedKeys => "pre-shared-keys",
            AuthMethod::RsaSignatures => "rsa-signatures",
            AuthMethod::EcdsaSignatures => "ecdsa-signatures",
        }
        .to_owned()
    }
}

impl Scalar for IkeVersion {
    const NAME: &'static str = "IkeVersion";

    fn parse(text: &str) -> Result<Self, ScalarParseError> {
        match text {
            "v1-only" => Ok(IkeVersion::V1Only),
            "v2-only" => Ok(IkeVersion::V2Only),
            "v1-or-v2" => Ok(IkeVersion::V1OrV2),
            _ => Err(err(
                Self::NAME,
                syntax("`v1-only`, `v2-only` or `v1-or-v2`"),
            )),
        }
    }

    fn canonical(&self) -> String {
        match self {
            IkeVersion::V1Only => "v1-only",
            IkeVersion::V2Only => "v2-only",
            IkeVersion::V1OrV2 => "v1-or-v2",
        }
        .to_owned()
    }
}

impl Scalar for Identifier {
    const NAME: &'static str = "Identifier";

    fn parse(text: &str) -> Result<Self, ScalarParseError> {
        ascii_graphic(text).map_err(|k| err(Self::NAME, k))?;
        Ok(Identifier(text.to_owned()))
    }

    fn canonical(&self) -> String {
        self.0.clone()
    }
}

impl Scalar for InterfaceName {
    const NAME: &'static str = "InterfaceName";

    fn parse(text: &str) -> Result<Self, ScalarParseError> {
        ascii_graphic(text).map_err(|k| err(Self::NAME, k))?;
        Ok(InterfaceName(text.to_owned()))
    }

    fn canonical(&self) -> String {
        self.0.clone()
    }
}

impl Scalar for OsVersion {
    const NAME: &'static str = "OsVersion";

    fn parse(text: &str) -> Result<Self, ScalarParseError> {
        ascii_graphic(text).map_err(|k| err(Self::NAME, k))?;
        Ok(OsVersion(text.to_owned()))
    }

    fn canonical(&self) -> String {
        self.0.clone()
    }
}

impl Scalar for Timestamp {
    const NAME: &'static str = "Timestamp";

    fn parse(text: &str) -> Result<Self, ScalarParseError> {
        const SHAPE: &str = "RFC 3339 UTC `YYYY-MM-DDThh:mm:ss[.mmm]Z`";
        let bytes = text.as_bytes();
        let fraction = match bytes.len() {
            20 if bytes[19] == b'Z' => 0,
            24 if bytes[19] == b'.' && bytes[23] == b'Z' => {
                fixed_digits(&bytes[20..23]).ok_or_else(|| err(Self::NAME, syntax(SHAPE)))?
            }
            _ => return Err(err(Self::NAME, syntax(SHAPE))),
        };
        if bytes[4] != b'-'
            || bytes[7] != b'-'
            || bytes[10] != b'T'
            || bytes[13] != b':'
            || bytes[16] != b':'
        {
            return Err(err(Self::NAME, syntax(SHAPE)));
        }
        let field = |lo: usize, hi: usize| {
            fixed_digits(&bytes[lo..hi]).ok_or_else(|| err(Self::NAME, syntax(SHAPE)))
        };
        let (year, month, day) = (field(0, 4)?, field(5, 7)?, field(8, 10)?);
        let (hour, minute, second) = (field(11, 13)?, field(14, 16)?, field(17, 19)?);
        if !(1970..=9999).contains(&year) {
            return Err(err(Self::NAME, range("year")));
        }
        if !(1..=12).contains(&month) {
            return Err(err(Self::NAME, range("month")));
        }
        if day < 1 || day > days_in_month(year, month) {
            return Err(err(Self::NAME, range("day")));
        }
        if hour > 23 {
            return Err(err(Self::NAME, range("hour")));
        }
        if minute > 59 {
            return Err(err(Self::NAME, range("minute")));
        }
        // 60 is refused: there is no deterministic leap-second map.
        if second > 59 {
            return Err(err(Self::NAME, range("second")));
        }
        let days = days_from_civil(year, month, day);
        let seconds = days * 86_400 + hour * 3_600 + minute * 60 + second;
        Ok(Timestamp(seconds * 1_000 + fraction))
    }

    fn canonical(&self) -> String {
        let (days, rest) = (self.0 / 86_400_000, self.0 % 86_400_000);
        let (year, month, day) = civil_from_days(days);
        let hour = rest / 3_600_000;
        let minute = rest / 60_000 % 60;
        let second = rest / 1_000 % 60;
        let fraction = rest % 1_000;
        format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.{fraction:03}Z")
    }
}

impl Scalar for Fqdn {
    const NAME: &'static str = "Fqdn";

    fn parse(text: &str) -> Result<Self, ScalarParseError> {
        for (offset, byte) in text.bytes().enumerate() {
            if !byte.is_ascii() {
                return Err(err(Self::NAME, ScalarParseErrorKind::Charset { offset }));
            }
        }
        let body = text.strip_suffix('.').unwrap_or(text);
        if body.is_empty() {
            return Err(err(Self::NAME, syntax("at least one label")));
        }
        let folded = body.to_ascii_lowercase();
        let mut offset = 0usize;
        for label in folded.split('.') {
            let bytes = label.as_bytes();
            if bytes.is_empty() {
                return Err(err(Self::NAME, syntax("dot-separated non-empty labels")));
            }
            if bytes.len() > 63 {
                return Err(err(Self::NAME, range("label length")));
            }
            if bytes[0] == b'-' || bytes[bytes.len() - 1] == b'-' {
                return Err(err(
                    Self::NAME,
                    syntax("labels with no leading or trailing hyphen"),
                ));
            }
            for (index, byte) in bytes.iter().enumerate() {
                if !(byte.is_ascii_lowercase() || byte.is_ascii_digit() || *byte == b'-') {
                    return Err(err(
                        Self::NAME,
                        ScalarParseErrorKind::Charset {
                            offset: offset + index,
                        },
                    ));
                }
            }
            offset += label.len() + 1;
        }
        if folded.len() > 253 {
            return Err(err(Self::NAME, range("total length")));
        }
        Ok(Fqdn(folded))
    }

    fn canonical(&self) -> String {
        self.0.clone()
    }
}

impl Scalar for RouteDistinguisher {
    const NAME: &'static str = "RouteDistinguisher";

    fn parse(text: &str) -> Result<Self, ScalarParseError> {
        match parse_rd_parts(text).map_err(|k| err(Self::NAME, k))? {
            RdParts::Type0 { admin, assigned } => Ok(RouteDistinguisher::Type0 { admin, assigned }),
            RdParts::Type1 { admin, assigned } => Ok(RouteDistinguisher::Type1 { admin, assigned }),
        }
    }

    fn canonical(&self) -> String {
        match self {
            RouteDistinguisher::Type0 { admin, assigned } => format!("{admin}:{assigned}"),
            RouteDistinguisher::Type1 { admin, assigned } => format!("{admin}:{assigned}"),
        }
    }
}

impl Scalar for Text {
    const NAME: &'static str = "Text";

    /// The one free-string scalar (11 §4.3): every input is accepted, so no
    /// refusing case exists.
    fn parse(text: &str) -> Result<Self, ScalarParseError> {
        Ok(Text(text.to_owned()))
    }

    fn canonical(&self) -> String {
        self.0.clone()
    }
}

impl Scalar for Date {
    const NAME: &'static str = "Date";

    fn parse(text: &str) -> Result<Self, ScalarParseError> {
        const SHAPE: &str = "`YYYY-MM-DD`, zero-padded";
        let bytes = text.as_bytes();
        if bytes.len() != 10 || bytes[4] != b'-' || bytes[7] != b'-' {
            return Err(err(Self::NAME, syntax(SHAPE)));
        }
        let field = |lo: usize, hi: usize| {
            fixed_digits(&bytes[lo..hi]).ok_or_else(|| err(Self::NAME, syntax(SHAPE)))
        };
        let (year, month, day) = (field(0, 4)?, field(5, 7)?, field(8, 10)?);
        if !(1..=9999).contains(&year) {
            return Err(err(Self::NAME, range("year")));
        }
        if !(1..=12).contains(&month) {
            return Err(err(Self::NAME, range("month")));
        }
        if day < 1 || day > days_in_month(year, month) {
            return Err(err(Self::NAME, range("day")));
        }
        Ok(Date {
            year: year as u16,
            month: month as u8,
            day: day as u8,
        })
    }

    fn canonical(&self) -> String {
        let (year, month, day) = (self.year, self.month, self.day);
        format!("{year:04}-{month:02}-{day:02}")
    }
}

impl Scalar for LatLon {
    const NAME: &'static str = "LatLon";

    fn parse(text: &str) -> Result<Self, ScalarParseError> {
        const SHAPE: &str = "<lat_e7>/<lon_e7>";
        let (lat, lon) = text
            .split_once('/')
            .ok_or_else(|| err(Self::NAME, syntax(SHAPE)))?;
        let lat = parse_signed(lat).map_err(|k| err(Self::NAME, k))?;
        let lon = parse_signed(lon).map_err(|k| err(Self::NAME, k))?;
        if !(-900_000_000..=900_000_000).contains(&lat) {
            return Err(err(Self::NAME, range("latitude")));
        }
        if !(-1_800_000_000..=1_800_000_000).contains(&lon) {
            return Err(err(Self::NAME, range("longitude")));
        }
        Ok(LatLon {
            lat_e7: lat as i32,
            lon_e7: lon as i32,
        })
    }

    fn canonical(&self) -> String {
        let (lat, lon) = (self.lat_e7, self.lon_e7);
        format!("{lat}/{lon}")
    }
}

impl Scalar for Clli {
    const NAME: &'static str = "Clli";

    fn parse(text: &str) -> Result<Self, ScalarParseError> {
        if !matches!(text.len(), 8 | 11) {
            return Err(err(Self::NAME, range("code length")));
        }
        for (offset, byte) in text.bytes().enumerate() {
            if !(byte.is_ascii_uppercase() || byte.is_ascii_digit()) {
                return Err(err(Self::NAME, ScalarParseErrorKind::Charset { offset }));
            }
        }
        Ok(Clli(text.to_owned()))
    }

    fn canonical(&self) -> String {
        self.0.clone()
    }
}

impl Scalar for Bandwidth {
    const NAME: &'static str = "Bandwidth";

    fn parse(text: &str) -> Result<Self, ScalarParseError> {
        parse_unsigned(text)
            .map(Bandwidth)
            .map_err(|k| err(Self::NAME, k))
    }

    fn canonical(&self) -> String {
        self.0.to_string()
    }
}

impl Scalar for TzName {
    const NAME: &'static str = "TzName";

    fn parse(text: &str) -> Result<Self, ScalarParseError> {
        if text.is_empty() {
            return Err(err(Self::NAME, syntax("at least one segment")));
        }
        let mut offset = 0usize;
        for segment in text.split('/') {
            if segment.is_empty() {
                return Err(err(Self::NAME, syntax("`/`-separated non-empty segments")));
            }
            for (index, byte) in segment.bytes().enumerate() {
                if !(byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'+' | b'-')) {
                    return Err(err(
                        Self::NAME,
                        ScalarParseErrorKind::Charset {
                            offset: offset + index,
                        },
                    ));
                }
            }
            offset += segment.len() + 1;
        }
        Ok(TzName(text.to_owned()))
    }

    fn canonical(&self) -> String {
        self.0.clone()
    }
}

impl Scalar for PlatformId {
    const NAME: &'static str = "PlatformId";

    fn parse(text: &str) -> Result<Self, ScalarParseError> {
        let bytes = text.as_bytes();
        if bytes.is_empty() {
            return Err(err(Self::NAME, syntax("a non-empty lowercase token")));
        }
        for (offset, byte) in bytes.iter().enumerate() {
            let ok = byte.is_ascii_lowercase() || byte.is_ascii_digit() || *byte == b'-';
            if !ok || (offset == 0 && !byte.is_ascii_lowercase()) {
                return Err(err(Self::NAME, ScalarParseErrorKind::Charset { offset }));
            }
        }
        if bytes[bytes.len() - 1] == b'-' {
            return Err(err(Self::NAME, syntax("no trailing hyphen")));
        }
        Ok(PlatformId(text.to_owned()))
    }

    fn canonical(&self) -> String {
        self.0.clone()
    }
}

impl Scalar for InferenceRuleId {
    const NAME: &'static str = "InferenceRuleId";

    fn parse(text: &str) -> Result<Self, ScalarParseError> {
        const PREFIX: &str = "infer.";
        let rest = text.strip_prefix(PREFIX).ok_or_else(|| {
            err(
                Self::NAME,
                syntax("`infer.` and at least one further segment"),
            )
        })?;
        if rest.is_empty() {
            return Err(err(
                Self::NAME,
                syntax("`infer.` and at least one further segment"),
            ));
        }
        let mut offset = PREFIX.len();
        for segment in rest.split('.') {
            let bytes = segment.as_bytes();
            if bytes.is_empty() {
                return Err(err(Self::NAME, syntax("dot-separated non-empty segments")));
            }
            if bytes[0] == b'-' || bytes[bytes.len() - 1] == b'-' {
                return Err(err(
                    Self::NAME,
                    syntax("segments with no leading or trailing hyphen"),
                ));
            }
            for (index, byte) in bytes.iter().enumerate() {
                if !(byte.is_ascii_lowercase() || byte.is_ascii_digit() || *byte == b'-') {
                    return Err(err(
                        Self::NAME,
                        ScalarParseErrorKind::Charset {
                            offset: offset + index,
                        },
                    ));
                }
            }
            offset += segment.len() + 1;
        }
        Ok(InferenceRuleId(text.to_owned()))
    }

    fn canonical(&self) -> String {
        self.0.clone()
    }
}

impl Scalar for RouteTarget {
    const NAME: &'static str = "RouteTarget";

    fn parse(text: &str) -> Result<Self, ScalarParseError> {
        let body = text.strip_prefix("target:").unwrap_or(text);
        match parse_rd_parts(body).map_err(|k| err(Self::NAME, k))? {
            RdParts::Type0 { admin, assigned } => Ok(RouteTarget::Type0 { admin, assigned }),
            RdParts::Type1 { admin, assigned } => Ok(RouteTarget::Type1 { admin, assigned }),
        }
    }

    fn canonical(&self) -> String {
        match self {
            RouteTarget::Type0 { admin, assigned } => format!("{admin}:{assigned}"),
            RouteTarget::Type1 { admin, assigned } => format!("{admin}:{assigned}"),
        }
    }
}

impl Scalar for OspfAreaId {
    const NAME: &'static str = "OspfAreaId";

    fn parse(text: &str) -> Result<Self, ScalarParseError> {
        if text.contains('.') {
            let addr: net::Ipv4Addr = text
                .parse()
                .map_err(|_| err(Self::NAME, syntax("a dotted-quad area id")))?;
            Ok(OspfAreaId(u32::from(addr)))
        } else {
            let n =
                bounded(text, u64::from(u32::MAX), "area id").map_err(|k| err(Self::NAME, k))?;
            Ok(OspfAreaId(n as u32))
        }
    }

    fn canonical(&self) -> String {
        net::Ipv4Addr::from(self.0).to_string()
    }
}
