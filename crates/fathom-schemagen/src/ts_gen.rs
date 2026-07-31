//! Emitter for `schema/generated/ir_types.ts` — the TypeScript mirror for
//! the UI boundary only, never the wire format (62 §17.1). It carries the
//! kind/edge universes, the named-enum token unions, per-kind field name
//! lists and the field-key registry; everything richer (cards, docs,
//! spelling maps, inline enums) is a reading of `schema.json`, deliberately
//! not duplicated here.

use crate::extract::Extracted;
use crate::rust_gen::HEADER;
use std::fmt::Write;

pub fn ir_types_ts(x: &Extracted) -> String {
    let mut o = String::new();
    let _ = writeln!(o, "// {HEADER}.");
    o.push_str("// The UI-boundary mirror only — never the wire format (62 §17.1).\n\n");

    // Kinds and edges.
    o.push_str("/** Node kinds, declaration order (62 §2.3). */\n");
    union(&mut o, "NodeKind", x.kinds.iter().map(|k| k.name.as_str()));
    list(
        &mut o,
        "NODE_KINDS",
        "NodeKind",
        x.kinds.iter().map(|k| k.name.as_str()),
    );
    o.push_str("\n/** Asserted edge kinds, declaration order. */\n");
    union(&mut o, "EdgeKind", x.edges.iter().map(|e| e.name.as_str()));
    list(
        &mut o,
        "EDGE_KINDS",
        "EdgeKind",
        x.edges.iter().map(|e| e.name.as_str()),
    );
    o.push_str("\n/** Derived edge kinds — separate arena, never serialised (62 §11.4). */\n");
    union(
        &mut o,
        "DerivedEdgeKind",
        x.derived_edges.iter().map(|e| e.name.as_str()),
    );
    list(
        &mut o,
        "DERIVED_EDGE_KINDS",
        "DerivedEdgeKind",
        x.derived_edges.iter().map(|e| e.name.as_str()),
    );

    // Named enums: declared tokens. Unknown tokens surface as plain strings
    // (62 §7 rule 2's unknown arm, mirrored as the type's escape hatch).
    o.push_str("\n// Named enums (schema/enums/): declared tokens; an undeclared token is\n");
    o.push_str("// carried as a plain string — the unknown arm's mirror (62 §7 rule 2).\n");
    for e in &x.enums {
        let _ = writeln!(o, "export type {} =", e.rust_name);
        for (i, v) in e.variants.iter().enumerate() {
            let sep = if i + 1 == e.variants.len() { ";" } else { "" };
            let _ = writeln!(o, "  | \"{v}\"{sep}");
        }
        let _ = writeln!(
            o,
            "export const {}_VARIANTS: readonly {}[] = [{}];",
            e.stem.to_ascii_uppercase(),
            e.rust_name,
            e.variants
                .iter()
                .map(|v| format!("\"{v}\""))
                .collect::<Vec<_>>()
                .join(", ")
        );
    }

    // Per-kind field names.
    o.push_str("\n/** Declared field names per kind, declaration order. */\n");
    o.push_str("export const KIND_FIELDS: Readonly<Record<NodeKind, readonly string[]>> = {\n");
    for k in &x.kinds {
        let fields = k
            .fields
            .iter()
            .map(|f| format!("\"{}\"", f.name))
            .collect::<Vec<_>>()
            .join(", ");
        let _ = writeln!(o, "  {}: [{fields}],", k.name);
    }
    o.push_str("};\n");

    // The wire registry.
    o.push_str("\n/** The field-key registry — append-only, keys never reused (62 §17.1). */\n");
    o.push_str("export const FIELD_KEYS: Readonly<Record<string, number>> = {\n");
    for (name, key) in &x.field_keys {
        let _ = writeln!(o, "  \"{name}\": {key},");
    }
    o.push_str("};\n");
    o
}

fn union<'a>(o: &mut String, name: &str, items: impl Iterator<Item = &'a str>) {
    let _ = writeln!(o, "export type {name} =");
    let items: Vec<&str> = items.collect();
    for (i, item) in items.iter().enumerate() {
        let sep = if i + 1 == items.len() { ";" } else { "" };
        let _ = writeln!(o, "  | \"{item}\"{sep}");
    }
}

fn list<'a>(o: &mut String, cname: &str, ty: &str, items: impl Iterator<Item = &'a str>) {
    let _ = writeln!(o, "export const {cname}: readonly {ty}[] = [");
    for item in items {
        let _ = writeln!(o, "  \"{item}\",");
    }
    o.push_str("];\n");
}
