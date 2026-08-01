//! The canonical JSON emitter — hand-written, dependency-free, and small,
//! because the canonical form (62 §17.1) is a byte contract: object keys
//! sorted (`BTreeMap` *is* the sort), no insignificant whitespace, LF-free
//! single line plus one trailing newline, UTF-8. Escaping is RFC 8259's
//! minimum: `"`, `\`, and control characters; non-ASCII is emitted as raw
//! UTF-8, never `\u`-escaped — one spelling per string, deterministically.
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

use fathom_schema::value::{Node, Value};
use std::collections::BTreeMap;

#[derive(Debug, Clone, PartialEq)]
pub enum Json {
    Null,
    Bool(bool),
    Int(i64),
    /// Finite by construction: `from_node` (the only tree-conversion path)
    /// refuses non-finite values, and nothing else builds this variant.
    Float(f64),
    Str(String),
    Arr(Vec<Json>),
    Obj(BTreeMap<String, Json>),
}

impl Json {
    /// Canonical bytes: minified, sorted, one trailing newline.
    pub fn to_canonical_bytes(&self) -> Vec<u8> {
        let mut out = String::new();
        emit(self, &mut out);
        out.push('\n');
        out.into_bytes()
    }
}

fn emit(j: &Json, out: &mut String) {
    match j {
        Json::Null => out.push_str("null"),
        Json::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Json::Int(i) => out.push_str(&i.to_string()),
        Json::Float(f) => {
            // Shortest round-trip decimal; `Display` never uses exponent
            // notation, so the output is always a valid JSON number.
            debug_assert!(f.is_finite(), "non-finite floats refuse at from_node");
            out.push_str(&f.to_string());
        }
        Json::Str(s) => emit_str(s, out),
        Json::Arr(items) => {
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                emit(item, out);
            }
            out.push(']');
        }
        Json::Obj(map) => {
            out.push('{');
            for (i, (k, v)) in map.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                emit_str(k, out);
                out.push(':');
                emit(v, out);
            }
            out.push('}');
        }
    }
}

fn emit_str(s: &str, out: &mut String) {
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            '\u{08}' => out.push_str("\\b"),
            '\u{0c}' => out.push_str("\\f"),
            c if (c as u32) < 0x20 => {
                out.push_str(&format!("\\u{:04x}", c as u32));
            }
            c => out.push(c),
        }
    }
    out.push('"');
}

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

    fn s(v: &str) -> Json {
        Json::Str(v.to_owned())
    }

    #[test]
    fn objects_sort_and_minify() {
        let mut m = BTreeMap::new();
        m.insert("b".to_owned(), Json::Int(2));
        m.insert(
            "a".to_owned(),
            Json::Arr(vec![Json::Bool(true), Json::Null]),
        );
        let bytes = Json::Obj(m).to_canonical_bytes();
        assert_eq!(bytes, b"{\"a\":[true,null],\"b\":2}\n");
    }

    #[test]
    fn escaping_is_rfc_8259_minimal() {
        let bytes = s("a\"b\\c\nd\u{1}e — ✓").to_canonical_bytes();
        assert_eq!(
            std::str::from_utf8(&bytes).unwrap(),
            "\"a\\\"b\\\\c\\nd\\u0001e — ✓\"\n"
        );
    }

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
