//! Text a person typed -> the typed value the schema declares for that field.
//!
//! This is `render.rs`'s table read backwards. `render_set` dispatches on
//! `slot_type(key)`'s `TypeId` to turn a stored value into a string for a cell;
//! `parse_into_slot` dispatches on the same `TypeId` to turn a string from a
//! form back into a stored value. **They belong in the same crate and should be
//! read together** — a type present in one and missing from the other is a
//! field the product can show but not accept, or accept but not show.
//!
//! # Why this is narrow, and why widening it fails the build
//!
//! There is an obvious alternative: the generator already emits
//! `slot_from_canon(key, &Json) -> Box<dyn Any>` covering all 299 field keys,
//! so every field of every kind would be writable with no table here at all.
//! It was built and measured: **+107,857 bytes, taking the module to 934,886
//! against `44` §5.2's 900,000-byte ceiling — a 34,886-byte breach that fails
//! the merge.** The narrow dispatch below measured at a small fraction of that.
//!
//! So the table is deliberately only the scalars an equipment form needs. It is
//! not a stub and it is not laziness; it is the shape that fits the budget, and
//! the reason is written here because the wide version is the natural thing to
//! reach for and would be found only by a CI failure.
//!
//! Adding a type here is one line. Adding all of them is a ceiling decision.

use core::any::{Any, TypeId};

use fathom_ir::bag::FieldKey;
use fathom_ir::generated::accessors::slot_type;
use fathom_ir::generated::ir_types;
use fathom_ir::scalar::{self, Scalar, ScalarParseError, ScalarParseErrorKind};

/// Why a typed value could not be made from what someone typed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AuthorError {
    /// The key is not in `schema/` at all. Unreachable from a generated form;
    /// reachable from a hand-written wire frame, which is why it is typed.
    UnknownKey(FieldKey),
    /// The schema declares a slot type this table does not carry. Distinct from
    /// `UnknownKey` on purpose: this one says *the field is real and the form
    /// may not edit it yet*, which is a product answer, not an error.
    UnsupportedType {
        key: FieldKey,
        declared: &'static str,
    },
    /// The text is not that scalar. Carries the scalar's own refusal.
    Parse(ScalarParseError),
}

impl From<ScalarParseError> for AuthorError {
    fn from(e: ScalarParseError) -> Self {
        AuthorError::Parse(e)
    }
}

/// Parse `text` into the value `key`'s declared slot type, boxed for
/// `Graph::set_field_boxed`.
///
/// Refuses rather than coerces. An empty string is not treated as "no value" —
/// absence is `assert_absent`, which is a different assertion with different
/// provenance rules (`11` §8.5), and silently turning a blank box into one
/// would be the product inventing a closed-world claim the user never made.
pub fn parse_into_slot(key: FieldKey, text: &str) -> Result<Box<dyn Any>, AuthorError> {
    let Some((tid, declared)) = slot_type(key) else {
        return Err(AuthorError::UnknownKey(key));
    };

    // Scalars: `Scalar::parse` is the schema's own grammar, so the accepted
    // spellings here are exactly the ones the parser accepts from a config.
    if tid == TypeId::of::<scalar::Identifier>() {
        return Ok(Box::new(scalar::Identifier::parse(text)?));
    }
    if tid == TypeId::of::<scalar::PlatformId>() {
        return Ok(Box::new(scalar::PlatformId::parse(text)?));
    }
    if tid == TypeId::of::<scalar::OsVersion>() {
        return Ok(Box::new(scalar::OsVersion::parse(text)?));
    }
    if tid == TypeId::of::<scalar::Fqdn>() {
        return Ok(Box::new(scalar::Fqdn::parse(text)?));
    }
    if tid == TypeId::of::<scalar::IpAddr>() {
        return Ok(Box::new(scalar::IpAddr::parse(text)?));
    }
    if tid == TypeId::of::<scalar::Text>() {
        return Ok(Box::new(scalar::Text::parse(text)?));
    }
    if tid == TypeId::of::<scalar::InterfaceName>() {
        return Ok(Box::new(scalar::InterfaceName::parse(text)?));
    }

    // Enums. `from_token` never fails: an unrecognised token becomes the
    // generated `Unknown(String)` arm, which is what makes a new variant a
    // minor bump an old client survives (`62` §16.2). That is right for reading
    // a config written by a newer Fathom, and wrong for a form — a person who
    // types "frewall" wants to be told, not to have it stored verbatim. So the
    // form direction refuses the unknown arm.
    if tid == TypeId::of::<ir_types::DeviceRole>() {
        let v = ir_types::DeviceRole::from_token(text);
        if matches!(v, ir_types::DeviceRole::Unknown(_)) {
            return Err(AuthorError::Parse(ScalarParseError {
                scalar: "DeviceRole",
                kind: ScalarParseErrorKind::Syntax {
                    expected: "firewall, router, switch, load_balancer or other",
                },
            }));
        }
        return Ok(Box::new(v));
    }

    // ADR-0036's two inline placement enums, refusing the unknown arm for the
    // same reason `DeviceRole` does: a person typing "frnt" wants to be told.
    if tid == TypeId::of::<ir_types::MountedInFace>() {
        let v = ir_types::MountedInFace::from_token(text);
        if matches!(v, ir_types::MountedInFace::Unknown(_)) {
            return Err(AuthorError::Parse(ScalarParseError {
                scalar: "MountedInFace",
                kind: ScalarParseErrorKind::Syntax {
                    expected: "front or rear",
                },
            }));
        }
        return Ok(Box::new(v));
    }
    if tid == TypeId::of::<ir_types::RackUnitNumbering>() {
        let v = ir_types::RackUnitNumbering::from_token(text);
        if matches!(v, ir_types::RackUnitNumbering::Unknown(_)) {
            return Err(AuthorError::Parse(ScalarParseError {
                scalar: "RackUnitNumbering",
                kind: ScalarParseErrorKind::Syntax {
                    // Named in full rather than as "the two values", because
                    // ADR-0036 makes this field required with no default and
                    // the error is where most people will first meet it.
                    expected: "ascending (U1 at the floor) or descending (U1 at the top)",
                },
            }));
        }
        return Ok(Box::new(v));
    }

    // Small integers. Parsed with the standard library rather than a scalar,
    // because the schema declares them as bare `u8`/`u16` and `slot_type`
    // reports those primitive `TypeId`s directly.
    if tid == TypeId::of::<u8>() {
        return Ok(Box::new(text.trim().parse::<u8>().map_err(|_| {
            AuthorError::Parse(ScalarParseError {
                scalar: "u8",
                kind: ScalarParseErrorKind::Range { what: "0 to 255" },
            })
        })?));
    }
    if tid == TypeId::of::<u16>() {
        return Ok(Box::new(text.trim().parse::<u16>().map_err(|_| {
            AuthorError::Parse(ScalarParseError {
                scalar: "u16",
                kind: ScalarParseErrorKind::Range { what: "0 to 65535" },
            })
        })?));
    }

    Err(AuthorError::UnsupportedType { key, declared })
}

/// Is this field editable by hand today? The page asks before offering an
/// input, so a field the table cannot take is never presented as one — the
/// alternative is a form that accepts a value and then refuses it.
pub fn is_authorable(key: FieldKey) -> bool {
    parse_into_slot(key, "\u{0}\u{0}unparseable\u{0}\u{0}")
        .err()
        .is_none_or(|e| {
            !matches!(
                e,
                AuthorError::UnsupportedType { .. } | AuthorError::UnknownKey(_)
            )
        })
}
