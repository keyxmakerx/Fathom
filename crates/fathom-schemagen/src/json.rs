//! Tree → canonical JSON, for the blocks `schema.json` carries verbatim.
//!
//! The canonical form itself — the [`Json`] type and its byte emitter — moved
//! to `fathom-canon` (WO-05 §4.1): 35 §5.1 C8 asks for *"one implementation
//! per job"*, and the workspace face needs the same bytes. This module keeps
//! the one thing that cannot move, because it reads
//! `fathom_schema::value::Node`: the tree conversion.
//!
//! Floats are structurally excluded from the IR (11 §14.1, 12 §3.4), but the
//! tree itself carries them in one place — `matching:`, the residue-guard
//! constants (11 §10.4) — and `schema.json` transcribes every tree block so
//! the bump checker (62 §16.4) can classify every diff. The canonical float
//! form is Rust's shortest round-trip decimal (`f64` `Display`): a pure,
//! platform-independent function of the parsed value, which is itself a pure
//! function of the tree's bytes (the subset parser admits only simple
//! `digits.digits` literals). Non-finite values refuse at conversion — they
//! have no JSON spelling and no way into a parsed tree.

pub use fathom_canon::Json;

use fathom_schema::value::{Node, Value};
use std::collections::BTreeMap;

/// Generic parsed-tree → JSON conversion for the blocks `schema.json`
/// carries verbatim. Sequences keep declaration order (order is data,
/// 62 §2.3); maps sort (canonical form). Duplicate keys and floats refuse.
pub fn from_node(node: &Node, context: &str) -> Result<Json, String> {
    match &node.value {
        Value::Null => Ok(Json::Null),
        Value::Bool(b) => Ok(Json::Bool(*b)),
        Value::Int(i) => Ok(Json::Int(*i)),
        Value::Float(f) => {
            if f.is_finite() {
                Ok(Json::Float(*f))
            } else {
                Err(format!(
                    "{context}:{}: non-finite float has no JSON spelling",
                    node.line
                ))
            }
        }
        Value::Str(s) => Ok(Json::Str(s.clone())),
        Value::Seq(items) => {
            let mut out = Vec::with_capacity(items.len());
            for item in items {
                out.push(from_node(item, context)?);
            }
            Ok(Json::Arr(out))
        }
        Value::Map(entries) => {
            let mut out = BTreeMap::new();
            for (k, v) in entries {
                let converted = from_node(v, context)?;
                if out.insert(k.clone(), converted).is_some() {
                    return Err(format!(
                        "{context}:{}: duplicate key `{k}` cannot canonicalise",
                        node.line
                    ));
                }
            }
            Ok(Json::Obj(out))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finite_floats_carry_shortest_round_trip() {
        // The shipped tree's two float sites (matching: residue guard).
        for (f, want) in [(0.75, "0.75\n"), (0.15, "0.15\n")] {
            let n = Node::new(Value::Float(f), 7);
            let j = from_node(&n, "t").expect("finite floats convert");
            assert_eq!(std::str::from_utf8(&j.to_canonical_bytes()).unwrap(), want);
        }
    }

    #[test]
    fn non_finite_floats_refuse() {
        for f in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
            let n = Node::new(Value::Float(f), 7);
            assert!(from_node(&n, "t").is_err(), "{f} must refuse");
        }
    }
}
