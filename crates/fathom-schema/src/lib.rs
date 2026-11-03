//! fathom-schema: parses the `schema/` tree per §2.2's YAML subset and
//! enforces the mechanically-checkable §18 gates. `fathom-schemagen` builds
//! the generated code from the model this crate checks.
//!
//! This crate was built from the schema spec, docs/archive/60-content/62-schema-spec.md;
//! a bare §N in its comments is a section of that spec. "11 §N" is the IR schema
//! (docs/archive/10-core/11-ir-schema.md) and "19" the physical and service model
//! (docs/archive/10-core/19-service-and-physical-model.md). All three are history now.

#![forbid(unsafe_code)]

pub mod gates;
pub mod model;
pub mod subset;
pub mod value;

pub use gates::{Finding, Severity};
pub use model::SchemaTree;

use std::path::Path;

/// Load a schema tree and run every implemented gate.
pub fn check(root: &Path) -> Result<(SchemaTree, Vec<Finding>), model::LoadError> {
    let tree = SchemaTree::load(root)?;
    let findings = gates::run(&tree);
    Ok((tree, findings))
}
