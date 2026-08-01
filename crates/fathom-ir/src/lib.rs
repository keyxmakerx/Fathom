//! fathom-ir: the minimal home the generated IR types need to compile.
//!
//! Three layers live here, deliberately separated:
//!
//! - `scalar` / `value` — **stub** binding targets for every entry in
//!   `schema/schema.yaml`'s `scalars:` block (62 §3). The `Scalar` trait
//!   (11 §4.2: `parse`/`emit`/`canonical`/`validate`, three property-tested
//!   laws) does not exist yet; these types exist so the paths the schema
//!   binds resolve, which makes `cargo build` of this crate the compile-time
//!   half of gate `schema.scalar.unbound` (62 §18.1).
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
