//! The field-bag contract the generated accessors read through.
//!
//! 62 §17.1's `accessors.rs` row asks for "typed fallible field accessors per
//! (kind, field)" — ADR-0007's stated mitigation for fallible field reads,
//! made checkable. The generated side (one function per kind field, in
//! `generated::accessors`) carries the types; this module carries the one
//! trait those functions are generic over, kept minimal on purpose: a bag is
//! anything that can answer "the slot stored under this wire key, if any".

use core::any::Any;

/// A field's stable wire key (`schema/field-keys.yaml`; 62 §2.3, §17.1).
/// Assigned once, append-only, never reused — which is what makes the key,
/// rather than the field name, the right index for a store to answer to.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct FieldKey(pub u32);

/// Why a typed read returned nothing.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum FieldError {
    /// No slot under the key. Partiality is the normal state (11 §9.1) —
    /// this is an answer, not an exception.
    Missing,
    /// A slot exists but holds a different type than the schema declares for
    /// this (kind, field) — a store defect, surfaced instead of masked.
    WrongType,
}

/// The minimal generic bag: some store of dynamically-typed field slots
/// addressed by wire key. The store that eventually implements this owns
/// presence and provenance (`Field<Presence<T>>`, 11 §6.2); the accessors
/// only need the slot.
pub trait FieldBag {
    /// The value slot stored under `key`, if present.
    fn field(&self, key: FieldKey) -> Option<&dyn Any>;
}

/// The one downcasting read every generated accessor shares.
pub fn typed<T: Any, B: FieldBag + ?Sized>(bag: &B, key: FieldKey) -> Result<&T, FieldError> {
    match bag.field(key) {
        None => Err(FieldError::Missing),
        Some(slot) => slot.downcast_ref::<T>().ok_or(FieldError::WrongType),
    }
}
