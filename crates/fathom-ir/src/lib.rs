//! fathom-ir: the minimal home the generated IR types need to compile.
//!
//! Three layers live here, deliberately separated:
//!
//! - `scalar` — the semantic scalars (11 §4.3's catalogue as bound by
//!   `schema/schema.yaml`), each implementing the `Scalar` trait's canonical
//!   half (WO-01); the per-platform halves land with the emitters.
//!   `SecretPlaceholder` implements no `Scalar` (11 §4.5).
//! - `value` — **stub** binding targets for the structured value types
//!   (62 §3.1 row 3): canonical serialisation and total order land with the
//!   store.
//! - `bag` — the handwritten field-bag contract the generated accessors read
//!   through (62 §17.1's "typed fallible accessors", ADR-0007's mitigation).
//! - `generated` — code written by `fathom-schemagen` from the `schema/`
//!   tree, checked in, and pinned current by that crate's tests
//!   (`schema.codegen.stale` / `schema.codegen.nondeterministic` as cargo
//!   tests).

#![forbid(unsafe_code)]

pub mod bag;
pub mod generated;
pub mod scalar;
pub mod value;
