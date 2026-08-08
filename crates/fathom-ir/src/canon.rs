//! The canonical wire form of every bound slot type (WO-05 §4.2).
//!
//! One law, quantified over every implementor:
//! `from_canon(to_canon(v)?)? == v`. The wire is `fathom_canon::Json`, whose
//! byte form is 62 §17.1's canonical JSON; nothing here writes bytes.
//!
//! **Membership is decided by trait first, shape second.** A type
//! implementing [`crate::scalar::Scalar`] wires as a string — the trait's own
//! `canonical()` — whatever its shape, because that text is already the
//! product's one injective form per value (35 §5.1 C8: *"one implementation
//! per job"*). Only types outside the trait are classified structurally, and
//! only within `value`: a field-less unit struct is an empty object, a
//! multi-field struct is an object keyed by its field idents, a hand-written
//! enum is a one-key object (or a bare string where the variant carries no
//! payload). `SecretPlaceholder` — the one registered `Scalar` exemption — is
//! the one hand-authored wire form.
//!
//! Two rules exist because a canonical form with two spellings is not one:
//!
//! - **Re-render equality on read.** A parsed value whose own canonical
//!   rendering differs from the input bytes is refused, not normalised.
//!   `Ulid::decode` is deliberately Crockford-lenient and `Fqdn::parse`
//!   case-folds; without this check a file would change under a round trip.
//! - **Injectivity on write.** WO-01 §9 row 1 records that the scalar laws
//!   hold over parse-reachable values only, and a hand-built value can sit
//!   outside them: `EncryptionAlgorithm::canonical()` returns the empty
//!   string outside its table. Refusing at write fails at the moment the
//!   estate is saved, rather than writing a file that cannot be read back.

use core::any::Any;
use std::collections::{BTreeMap, BTreeSet};

use fathom_canon::Json;

use crate::scalar::{self, Scalar, SecretHint, SecretLabel, SecretPlaceholder};
use crate::value;

/// Why a value did not make it onto, or off, the wire.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CanonError {
    /// The field key is not in the registry.
    UnknownKey { key: u32 },
    /// The erased value is not the type the registry declares for the key.
    WrongType { key: u32, declared: &'static str },
    /// A `u64` above `i64::MAX` on write — never wrapped, never stringified.
    IntOutOfRange,
    /// Parse-then-re-render disagreed with the input: a second spelling.
    NonCanonicalSpelling,
    /// Set members are not strictly ascending.
    NonCanonicalOrder,
    /// A hand-written enum's tag names no variant.
    UnknownVariant { token: String },
    /// Wrong `Json` shape for the slot.
    Shape { expected: &'static str },
}

/// The wire form of one slot value.
pub trait CanonicalValue: Sized {
    fn to_canon(&self) -> Result<Json, CanonError>;
    fn from_canon(j: &Json) -> Result<Self, CanonError>;
}

/// Map keys must render as JSON object keys. Implemented for exactly the two
/// registry key types: [`scalar::Identifier`] (through the same `Scalar` pair
/// as every other scalar, so a key spelling and a value spelling cannot
/// diverge) and the generated `Family` (its `token()`, parsed by
/// `from_token`; that impl is generated).
pub trait CanonKey: Sized + Ord {
    fn to_key(&self) -> Result<String, CanonError>;
    fn from_key(k: &str) -> Result<Self, CanonError>;
}

// ---------------------------------------------------------------------------
// The generated dispatch's two halves. `pub(crate)`: the public entry points
// are `generated::accessors::slot_to_canon` / `slot_from_canon`, which are
// exhaustive matches over the registry and call these.

pub(crate) fn slot_to<T: CanonicalValue + Any>(
    key: u32,
    declared: &'static str,
    value: &dyn Any,
) -> Result<Json, CanonError> {
    match value.downcast_ref::<T>() {
        Some(v) => v.to_canon(),
        None => Err(CanonError::WrongType { key, declared }),
    }
}

pub(crate) fn slot_from<T: CanonicalValue + Any>(j: &Json) -> Result<Box<dyn Any>, CanonError> {
    Ok(Box::new(T::from_canon(j)?))
}

// ---------------------------------------------------------------------------
// Rule 1 — bool.

impl CanonicalValue for bool {
    fn to_canon(&self) -> Result<Json, CanonError> {
        Ok(Json::Bool(*self))
    }
    fn from_canon(j: &Json) -> Result<Self, CanonError> {
        match j {
            Json::Bool(b) => Ok(*b),
            _ => Err(CanonError::Shape {
                expected: "a JSON boolean",
            }),
        }
    }
}

// ---------------------------------------------------------------------------
// Rule 2 — bare primitive integers. Every *newtype* over an integer is rule 13.
//
// No slot binds a bare `u64`, `i64` or `i32` today; the guard is written ahead
// of the first binding rather than behind it (WO-05 §9 row 8).

macro_rules! int_canon {
    ($($t:ty => $expected:literal),* $(,)?) => { $(
        impl CanonicalValue for $t {
            fn to_canon(&self) -> Result<Json, CanonError> {
                match i64::try_from(*self) {
                    Ok(i) => Ok(Json::Int(i)),
                    Err(_) => Err(CanonError::IntOutOfRange),
                }
            }
            fn from_canon(j: &Json) -> Result<Self, CanonError> {
                match j {
                    Json::Int(i) => <$t>::try_from(*i).map_err(|_| CanonError::Shape {
                        expected: $expected,
                    }),
                    _ => Err(CanonError::Shape { expected: $expected }),
                }
            }
        }
    )* };
}

int_canon! {
    u8 => "an integer in 0..=255",
    u16 => "an integer in 0..=65535",
    u32 => "an integer in 0..=4294967295",
    u64 => "a non-negative integer no greater than i64::MAX",
    i32 => "an integer in -2147483648..=2147483647",
    i64 => "a JSON integer",
}

// ---------------------------------------------------------------------------
// Rule 11 — the field-embedded reference ids.
//
// `Ulid::decode` accepts Crockford aliases (case-insensitive, `I`/`L` -> 1,
// `O` -> 0), so decoding alone would silently normalise a hand-edited file.
// Re-render equality is what makes one spelling per value true.

fn ulid_to_canon(u: fathom_id::Ulid) -> Json {
    Json::Str(u.encode())
}

fn ulid_from_canon(j: &Json) -> Result<fathom_id::Ulid, CanonError> {
    let text = expect_str(j, "a 26-character ULID string")?;
    let decoded = fathom_id::Ulid::decode(text).map_err(|_| CanonError::Shape {
        expected: "a 26-character ULID string",
    })?;
    if decoded.encode() != text {
        return Err(CanonError::NonCanonicalSpelling);
    }
    Ok(decoded)
}

impl CanonicalValue for fathom_id::NodeId {
    fn to_canon(&self) -> Result<Json, CanonError> {
        Ok(ulid_to_canon(self.0))
    }
    fn from_canon(j: &Json) -> Result<Self, CanonError> {
        Ok(fathom_id::NodeId(ulid_from_canon(j)?))
    }
}

impl CanonicalValue for fathom_id::EdgeId {
    fn to_canon(&self) -> Result<Json, CanonError> {
        Ok(ulid_to_canon(self.0))
    }
    fn from_canon(j: &Json) -> Result<Self, CanonError> {
        Ok(fathom_id::EdgeId(ulid_from_canon(j)?))
    }
}

// ---------------------------------------------------------------------------
// Rule 12 — collections. Order is data for `Vec`; for `BTreeSet` it is a
// consequence of `Ord`, so a non-ascending array is refused rather than
// silently re-sorted (which would break byte-identity on re-emission).

impl<T: CanonicalValue> CanonicalValue for Vec<T> {
    fn to_canon(&self) -> Result<Json, CanonError> {
        let mut out = Vec::with_capacity(self.len());
        for item in self {
            out.push(item.to_canon()?);
        }
        Ok(Json::Arr(out))
    }
    fn from_canon(j: &Json) -> Result<Self, CanonError> {
        let items = match j {
            Json::Arr(items) => items,
            _ => {
                return Err(CanonError::Shape {
                    expected: "a JSON array",
                })
            }
        };
        let mut out = Vec::with_capacity(items.len());
        for item in items {
            out.push(T::from_canon(item)?);
        }
        Ok(out)
    }
}

impl<T: CanonicalValue + Ord> CanonicalValue for BTreeSet<T> {
    fn to_canon(&self) -> Result<Json, CanonError> {
        let mut out = Vec::with_capacity(self.len());
        for item in self {
            out.push(item.to_canon()?);
        }
        Ok(Json::Arr(out))
    }
    fn from_canon(j: &Json) -> Result<Self, CanonError> {
        let items = match j {
            Json::Arr(items) => items,
            _ => {
                return Err(CanonError::Shape {
                    expected: "a JSON array",
                })
            }
        };
        let mut parsed: Vec<T> = Vec::with_capacity(items.len());
        for item in items {
            parsed.push(T::from_canon(item)?);
        }
        // Strictly ascending, or the set would re-emit in a different order
        // than it was read and byte-identity would be a lie.
        if parsed.windows(2).any(|w| w[0] >= w[1]) {
            return Err(CanonError::NonCanonicalOrder);
        }
        Ok(parsed.into_iter().collect())
    }
}

impl<K: CanonKey, V: CanonicalValue> CanonicalValue for BTreeMap<K, V> {
    fn to_canon(&self) -> Result<Json, CanonError> {
        let mut out = BTreeMap::new();
        for (k, v) in self {
            out.insert(k.to_key()?, v.to_canon()?);
        }
        Ok(Json::Obj(out))
    }
    fn from_canon(j: &Json) -> Result<Self, CanonError> {
        let entries = match j {
            Json::Obj(m) => m,
            _ => {
                return Err(CanonError::Shape {
                    expected: "a JSON object",
                })
            }
        };
        let mut out = BTreeMap::new();
        for (k, v) in entries {
            out.insert(K::from_key(k)?, V::from_canon(v)?);
        }
        Ok(out)
    }
}

// ---------------------------------------------------------------------------
// Rule 13 — every `Scalar` implementor. The wire *is* `canonical()`.

fn scalar_to_canon<T: Scalar>(v: &T) -> Result<Json, CanonError> {
    let text = v.canonical();
    // The write-side injectivity check. Required, not belt-and-braces: a value
    // outside its type's parse-reachable set renders text that reads back as a
    // different value, or as nothing at all.
    match T::parse(&text) {
        Ok(back) if back == *v => Ok(Json::Str(text)),
        _ => Err(CanonError::NonCanonicalSpelling),
    }
}

fn scalar_from_canon<T: Scalar>(j: &Json) -> Result<T, CanonError> {
    let text = expect_str(j, "a canonical scalar string")?;
    // A parse refusal and a re-render mismatch are the same fact: the byte
    // string is not the canonical spelling of any value of this type.
    let v = T::parse(text).map_err(|_| CanonError::NonCanonicalSpelling)?;
    if v.canonical() != text {
        return Err(CanonError::NonCanonicalSpelling);
    }
    Ok(v)
}

macro_rules! scalar_canon {
    ($($t:ty),* $(,)?) => { $(
        impl CanonicalValue for $t {
            fn to_canon(&self) -> Result<Json, CanonError> {
                scalar_to_canon(self)
            }
            fn from_canon(j: &Json) -> Result<Self, CanonError> {
                scalar_from_canon(j)
            }
        }
    )* };
}

// The 35 `Scalar` implementations, in `scalar.rs`'s own row order.
scalar_canon! {
    scalar::Ip4Addr,
    scalar::Ip6Addr,
    scalar::IpAddr,
    scalar::IpPrefix,
    scalar::InterfaceAddress,
    scalar::IpRange,
    scalar::MacAddress,
    scalar::IpProtocol,
    scalar::L4Port,
    scalar::PortRange,
    scalar::VlanId,
    scalar::Asn,
    scalar::Seconds,
    scalar::Kilobytes,
    scalar::DhGroup,
    scalar::EncryptionAlgorithm,
    scalar::IntegrityAlgorithm,
    scalar::AuthMethod,
    scalar::IkeVersion,
    scalar::Identifier,
    scalar::InterfaceName,
    scalar::OsVersion,
    scalar::Timestamp,
    scalar::Fqdn,
    scalar::RouteDistinguisher,
    scalar::Text,
    scalar::Date,
    scalar::LatLon,
    scalar::Clli,
    scalar::Bandwidth,
    scalar::TzName,
    scalar::PlatformId,
    scalar::InferenceRuleId,
    scalar::RouteTarget,
    scalar::OspfAreaId,
}

impl CanonKey for scalar::Identifier {
    fn to_key(&self) -> Result<String, CanonError> {
        match scalar_to_canon(self)? {
            Json::Str(s) => Ok(s),
            _ => unreachable!("scalar_to_canon returns Str"),
        }
    }
    fn from_key(k: &str) -> Result<Self, CanonError> {
        scalar_from_canon(&Json::Str(k.to_owned()))
    }
}

// ---------------------------------------------------------------------------
// Rule 14 — `SecretPlaceholder`, the one registered `Scalar` exemption.
//
// The wire tokens below are **this format's**, deliberately not
// `SecretLabel::token()`: `token()` is the emit rendering, four of whose five
// values carry a live VERIFY in `scalar.rs`, and a stored format welded to a
// string expected to change would make every existing file unreadable the day
// that VERIFY resolves.
//
// Invariant 3 is not engaged: the type holds no credential by construction
// (`scalar.rs`: *"There is no `SecretPlaceholder::from_value`"*), both fields
// are private, and the read path reconstructs only through `new`/`with_hint`.
// The `label` is a category already emitted into config as `<PSK>`; the `hint`
// is the operator's own note of where the real secret lives, and dropping it
// would be silent loss of the field most likely to matter to whoever is
// recovering an estate.

const SECRET_LABEL_TOKENS: [(SecretLabel, &str); 5] = [
    (SecretLabel::Psk, "psk"),
    (SecretLabel::CertKey, "cert-key"),
    (SecretLabel::SnmpCommunity, "snmp-community"),
    (SecretLabel::TacacsKey, "tacacs-key"),
    (SecretLabel::Password, "password"),
];

/// The wire token for a label. Public to nobody: the format is this module's.
pub(crate) fn secret_label_token(label: SecretLabel) -> &'static str {
    SECRET_LABEL_TOKENS
        .iter()
        .find(|(l, _)| *l == label)
        .map(|(_, t)| *t)
        .expect("the table covers every variant")
}

impl CanonicalValue for SecretPlaceholder {
    fn to_canon(&self) -> Result<Json, CanonError> {
        let mut m = BTreeMap::new();
        m.insert(
            "label".to_owned(),
            Json::Str(secret_label_token(self.label()).to_owned()),
        );
        if let Some(h) = self.hint() {
            m.insert("hint".to_owned(), Json::Str(h.as_str().to_owned()));
        }
        Ok(Json::Obj(m))
    }

    fn from_canon(j: &Json) -> Result<Self, CanonError> {
        let m = expect_obj(j, "a secret placeholder object")?;
        known_keys(m, &["hint", "label"])?;
        let label_text = expect_str(
            m.get("label").ok_or(CanonError::Shape {
                expected: "a `label` key",
            })?,
            "a secret label token",
        )?;
        let label = SECRET_LABEL_TOKENS
            .iter()
            .find(|(_, t)| *t == label_text)
            .map(|(l, _)| *l)
            .ok_or_else(|| CanonError::UnknownVariant {
                token: label_text.to_owned(),
            })?;
        match m.get("hint") {
            None => Ok(SecretPlaceholder::new(label)),
            Some(h) => {
                let text = expect_str(h, "a hint string")?;
                // The 120-byte cap is re-enforced on read: the constructor is
                // the only path in, here as everywhere.
                let hint = SecretHint::new(text).map_err(|_| CanonError::Shape {
                    expected: "a hint of at most 120 bytes",
                })?;
                Ok(SecretPlaceholder::with_hint(label, hint))
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Shared shape helpers.

fn expect_str<'a>(j: &'a Json, expected: &'static str) -> Result<&'a str, CanonError> {
    match j {
        Json::Str(s) => Ok(s),
        _ => Err(CanonError::Shape { expected }),
    }
}

fn expect_obj<'a>(
    j: &'a Json,
    expected: &'static str,
) -> Result<&'a BTreeMap<String, Json>, CanonError> {
    match j {
        Json::Obj(m) => Ok(m),
        _ => Err(CanonError::Shape { expected }),
    }
}

/// Every present key must be one this shape declares. An unknown key is a
/// hand edit that would be dropped on the next write, so it is refused.
fn known_keys(m: &BTreeMap<String, Json>, allowed: &[&'static str]) -> Result<(), CanonError> {
    for k in m.keys() {
        if !allowed.contains(&k.as_str()) {
            return Err(CanonError::Shape {
                expected: "only the declared keys",
            });
        }
    }
    Ok(())
}

fn required<'a>(m: &'a BTreeMap<String, Json>, key: &'static str) -> Result<&'a Json, CanonError> {
    m.get(key).ok_or(CanonError::Shape { expected: key })
}

fn optional<T: CanonicalValue>(
    m: &BTreeMap<String, Json>,
    key: &str,
) -> Result<Option<T>, CanonError> {
    match m.get(key) {
        None => Ok(None),
        Some(j) => Ok(Some(T::from_canon(j)?)),
    }
}

/// Insert an `Option` field only when it is `Some`: omission is the one
/// spelling of absence, and `null` never appears on this wire.
fn put_opt<T: CanonicalValue>(
    m: &mut BTreeMap<String, Json>,
    key: &str,
    v: &Option<T>,
) -> Result<(), CanonError> {
    if let Some(v) = v {
        m.insert(key.to_owned(), v.to_canon()?);
    }
    Ok(())
}

/// A one-key object: the wire form of a payload-carrying enum variant.
fn tagged(tag: &str, payload: Json) -> Json {
    let mut m = BTreeMap::new();
    m.insert(tag.to_owned(), payload);
    Json::Obj(m)
}

/// The tag and payload of a one-key object.
fn untag<'a>(j: &'a Json, expected: &'static str) -> Result<(&'a str, &'a Json), CanonError> {
    let m = expect_obj(j, expected)?;
    if m.len() != 1 {
        return Err(CanonError::Shape { expected });
    }
    let (k, v) = m.iter().next().expect("length checked");
    Ok((k.as_str(), v))
}

// ---------------------------------------------------------------------------
// Rule 8 — the field-less structs in `value`. A type with no fields has
// nothing to lose on the wire; the moment one grows a field it leaves this
// rule.

macro_rules! unit_canon {
    ($($t:ty),* $(,)?) => { $(
        impl CanonicalValue for $t {
            fn to_canon(&self) -> Result<Json, CanonError> {
                Ok(Json::Obj(BTreeMap::new()))
            }
            fn from_canon(j: &Json) -> Result<Self, CanonError> {
                let m = expect_obj(j, "an empty JSON object")?;
                if m.is_empty() {
                    Ok(Self)
                } else {
                    Err(CanonError::Shape { expected: "an empty JSON object" })
                }
            }
        }
    )* };
}

unit_canon! {
    value::IkeId,
    value::Dpd,
    value::OspfArea,
    value::PolicyScope,
    value::AddressValue,
    value::L4Spec,
    value::NatScope,
    value::NatAction,
    value::VpnMonitor,
    value::PortPosition,
    value::Transceiver,
    value::SplitRatio,
    value::AttributeDecl,
    value::FieldPath,
    value::Resolution,
}

// ---------------------------------------------------------------------------
// Rule 6 — the multi-field structs in `value`.

impl CanonicalValue for value::Mtu {
    fn to_canon(&self) -> Result<Json, CanonError> {
        let mut m = BTreeMap::new();
        m.insert("bytes".to_owned(), self.bytes.to_canon()?);
        Ok(Json::Obj(m))
    }
    fn from_canon(j: &Json) -> Result<Self, CanonError> {
        let m = expect_obj(j, "an Mtu object")?;
        known_keys(m, &["bytes"])?;
        Ok(value::Mtu {
            bytes: u32::from_canon(required(m, "bytes")?)?,
        })
    }
}

impl CanonicalValue for value::PostalAddress {
    fn to_canon(&self) -> Result<Json, CanonError> {
        let mut m = BTreeMap::new();
        m.insert("lines".to_owned(), self.lines.to_canon()?);
        put_opt(&mut m, "locality", &self.locality)?;
        put_opt(&mut m, "region", &self.region)?;
        put_opt(&mut m, "postcode", &self.postcode)?;
        put_opt(&mut m, "country", &self.country)?;
        Ok(Json::Obj(m))
    }
    fn from_canon(j: &Json) -> Result<Self, CanonError> {
        let m = expect_obj(j, "a PostalAddress object")?;
        known_keys(m, &["country", "lines", "locality", "postcode", "region"])?;
        Ok(value::PostalAddress {
            lines: Vec::from_canon(required(m, "lines")?)?,
            locality: optional(m, "locality")?,
            region: optional(m, "region")?,
            postcode: optional(m, "postcode")?,
            country: optional(m, "country")?,
        })
    }
}

impl CanonicalValue for value::NameConformance {
    fn to_canon(&self) -> Result<Json, CanonError> {
        let mut m = BTreeMap::new();
        m.insert("state".to_owned(), self.state.to_canon()?);
        put_opt(&mut m, "reason", &self.reason)?;
        Ok(Json::Obj(m))
    }
    fn from_canon(j: &Json) -> Result<Self, CanonError> {
        let m = expect_obj(j, "a NameConformance object")?;
        known_keys(m, &["reason", "state"])?;
        Ok(value::NameConformance {
            state: crate::generated::ir_types::ConformanceState::from_canon(required(m, "state")?)?,
            reason: optional(m, "reason")?,
        })
    }
}

impl CanonicalValue for value::QualifiedNextHop {
    fn to_canon(&self) -> Result<Json, CanonError> {
        let mut m = BTreeMap::new();
        m.insert("next_hop".to_owned(), self.next_hop.to_canon()?);
        put_opt(&mut m, "preference", &self.preference)?;
        put_opt(&mut m, "metric", &self.metric)?;
        Ok(Json::Obj(m))
    }
    fn from_canon(j: &Json) -> Result<Self, CanonError> {
        let m = expect_obj(j, "a QualifiedNextHop object")?;
        known_keys(m, &["metric", "next_hop", "preference"])?;
        Ok(value::QualifiedNextHop {
            next_hop: value::NextHop::from_canon(required(m, "next_hop")?)?,
            preference: optional(m, "preference")?,
            metric: optional(m, "metric")?,
        })
    }
}

impl CanonicalValue for value::NodePriority {
    fn to_canon(&self) -> Result<Json, CanonError> {
        let mut m = BTreeMap::new();
        m.insert("member_index".to_owned(), self.member_index.to_canon()?);
        m.insert("priority".to_owned(), self.priority.to_canon()?);
        Ok(Json::Obj(m))
    }
    fn from_canon(j: &Json) -> Result<Self, CanonError> {
        let m = expect_obj(j, "a NodePriority object")?;
        known_keys(m, &["member_index", "priority"])?;
        Ok(value::NodePriority {
            member_index: u8::from_canon(required(m, "member_index")?)?,
            priority: u8::from_canon(required(m, "priority")?)?,
        })
    }
}

impl CanonicalValue for value::EndpointCardinality {
    fn to_canon(&self) -> Result<Json, CanonError> {
        let mut m = BTreeMap::new();
        m.insert("min".to_owned(), self.min.to_canon()?);
        put_opt(&mut m, "max", &self.max)?;
        Ok(Json::Obj(m))
    }
    fn from_canon(j: &Json) -> Result<Self, CanonError> {
        let m = expect_obj(j, "an EndpointCardinality object")?;
        known_keys(m, &["max", "min"])?;
        Ok(value::EndpointCardinality {
            min: u8::from_canon(required(m, "min")?)?,
            max: optional(m, "max")?,
        })
    }
}

// ---------------------------------------------------------------------------
// Rule 9 — the hand-written enums in `value`. `AttrType` is `AttrValue`'s tag,
// welded to it by an exhaustive match, and has no independent wire form.

impl CanonicalValue for value::PeerSpec {
    fn to_canon(&self) -> Result<Json, CanonError> {
        Ok(match self {
            value::PeerSpec::Address(a) => tagged("address", a.to_canon()?),
            value::PeerSpec::Dynamic(i) => tagged("dynamic", i.to_canon()?),
        })
    }
    fn from_canon(j: &Json) -> Result<Self, CanonError> {
        let (tag, payload) = untag(j, "a one-key PeerSpec object")?;
        match tag {
            "address" => Ok(value::PeerSpec::Address(scalar::IpAddr::from_canon(
                payload,
            )?)),
            "dynamic" => Ok(value::PeerSpec::Dynamic(value::IkeId::from_canon(payload)?)),
            other => Err(CanonError::UnknownVariant {
                token: other.to_owned(),
            }),
        }
    }
}

impl CanonicalValue for value::AttrValue {
    fn to_canon(&self) -> Result<Json, CanonError> {
        Ok(match self {
            value::AttrValue::Bool(b) => tagged("bool", b.to_canon()?),
            value::AttrValue::Integer(i) => tagged("integer", i.to_canon()?),
            value::AttrValue::Text(t) => tagged("text", t.to_canon()?),
            value::AttrValue::Enum {
                enum_id,
                variant_id,
            } => {
                let mut inner = BTreeMap::new();
                inner.insert("enum_id".to_owned(), enum_id.to_canon()?);
                inner.insert("variant_id".to_owned(), variant_id.to_canon()?);
                tagged("enum", Json::Obj(inner))
            }
            value::AttrValue::Bandwidth(b) => tagged("bandwidth", b.to_canon()?),
            value::AttrValue::VlanId(v) => tagged("vlan_id", v.to_canon()?),
            value::AttrValue::IpPrefix(p) => tagged("ip_prefix", p.to_canon()?),
            value::AttrValue::InterfaceAddress(a) => tagged("interface_address", a.to_canon()?),
            value::AttrValue::Identifier(i) => tagged("identifier", i.to_canon()?),
            value::AttrValue::Date(d) => tagged("date", d.to_canon()?),
        })
    }
    fn from_canon(j: &Json) -> Result<Self, CanonError> {
        let (tag, payload) = untag(j, "a one-key AttrValue object")?;
        match tag {
            "bool" => Ok(value::AttrValue::Bool(bool::from_canon(payload)?)),
            "integer" => Ok(value::AttrValue::Integer(i64::from_canon(payload)?)),
            "text" => Ok(value::AttrValue::Text(scalar::Text::from_canon(payload)?)),
            "enum" => {
                let m = expect_obj(payload, "an AttrValue::Enum payload")?;
                known_keys(m, &["enum_id", "variant_id"])?;
                Ok(value::AttrValue::Enum {
                    enum_id: u32::from_canon(required(m, "enum_id")?)?,
                    variant_id: u32::from_canon(required(m, "variant_id")?)?,
                })
            }
            "bandwidth" => Ok(value::AttrValue::Bandwidth(scalar::Bandwidth::from_canon(
                payload,
            )?)),
            "vlan_id" => Ok(value::AttrValue::VlanId(scalar::VlanId::from_canon(
                payload,
            )?)),
            "ip_prefix" => Ok(value::AttrValue::IpPrefix(scalar::IpPrefix::from_canon(
                payload,
            )?)),
            "interface_address" => Ok(value::AttrValue::InterfaceAddress(
                scalar::InterfaceAddress::from_canon(payload)?,
            )),
            "identifier" => Ok(value::AttrValue::Identifier(
                scalar::Identifier::from_canon(payload)?,
            )),
            "date" => Ok(value::AttrValue::Date(scalar::Date::from_canon(payload)?)),
            other => Err(CanonError::UnknownVariant {
                token: other.to_owned(),
            }),
        }
    }
}

impl CanonicalValue for value::NextHop {
    fn to_canon(&self) -> Result<Json, CanonError> {
        Ok(match self {
            value::NextHop::Address(a) => tagged("address", a.to_canon()?),
            value::NextHop::Interface(n) => tagged("interface", n.to_canon()?),
            value::NextHop::Discard => Json::Str("discard".to_owned()),
            value::NextHop::Reject => Json::Str("reject".to_owned()),
            value::NextHop::NextTable(t) => tagged("next_table", t.to_canon()?),
        })
    }
    fn from_canon(j: &Json) -> Result<Self, CanonError> {
        if let Json::Str(s) = j {
            return match s.as_str() {
                "discard" => Ok(value::NextHop::Discard),
                "reject" => Ok(value::NextHop::Reject),
                other => Err(CanonError::UnknownVariant {
                    token: other.to_owned(),
                }),
            };
        }
        let (tag, payload) = untag(j, "a one-key NextHop object")?;
        match tag {
            "address" => Ok(value::NextHop::Address(scalar::IpAddr::from_canon(
                payload,
            )?)),
            "interface" => Ok(value::NextHop::Interface(fathom_id::NodeId::from_canon(
                payload,
            )?)),
            "next_table" => Ok(value::NextHop::NextTable(scalar::Identifier::from_canon(
                payload,
            )?)),
            other => Err(CanonError::UnknownVariant {
                token: other.to_owned(),
            }),
        }
    }
}

impl CanonicalValue for value::SyslogHost {
    fn to_canon(&self) -> Result<Json, CanonError> {
        Ok(match self {
            value::SyslogHost::Address(a) => tagged("address", a.to_canon()?),
            value::SyslogHost::Fqdn(f) => tagged("fqdn", f.to_canon()?),
        })
    }
    fn from_canon(j: &Json) -> Result<Self, CanonError> {
        let (tag, payload) = untag(j, "a one-key SyslogHost object")?;
        match tag {
            "address" => Ok(value::SyslogHost::Address(scalar::IpAddr::from_canon(
                payload,
            )?)),
            "fqdn" => Ok(value::SyslogHost::Fqdn(scalar::Fqdn::from_canon(payload)?)),
            other => Err(CanonError::UnknownVariant {
                token: other.to_owned(),
            }),
        }
    }
}
