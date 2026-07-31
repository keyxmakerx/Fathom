//! fathom-schema: parses the `schema/` tree per 62 §2.2's YAML subset and
//! enforces the mechanically-checkable 62 §18 gates. The codegen this crate
//! will eventually feed (62 §17) does not exist yet; the parser and the gates
//! land first so that every schema edit from day one is checked.

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
