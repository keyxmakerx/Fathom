//! `client/src/engine/protocol.generated.json` — ADR-0052 §1: *"Face and
//! error codes are generated from Rust, never typed twice."*
//!
//! Follows `fathom-workspace/tests/generate_client_vectors.rs`'s own pattern:
//! an `#[ignore]`d one-shot generator that writes the file under the client
//! tree (run explicitly, since `cargo test` must not write there on every
//! run), plus a **non-ignored** test that rebuilds the same bytes in memory
//! and asserts they equal what is checked in — so a new opcode, face or error
//! added without re-running the generator fails loudly here rather than
//! drifting silently into `client/src/engine/protocol.constants.ts`.
//!
//! Every code below is the real Rust symbol, not a copied literal — `as u32`
//! on `fathom_wasm::OP_PASTE` and friends, so a renamed or removed constant is
//! a compile error in this file rather than a silent gap in the JSON. The
//! three-letter STRING name paired with each symbol is the one thing this
//! file types by hand, for the same reason `protocol.constants.ts` humbly
//! admits it does the same on the TypeScript side until something better
//! exists: Rust has no `stringify!` that reaches through a `use` alias to the
//! declaration site, and a proc-macro to read `protocol.rs`'s own source is
//! far more machinery than this file's job justifies.
//!
//! Run the generator with:
//! ```text
//! cargo test -p fathom-wasm --test protocol_generated -- --ignored --nocapture
//! ```

use std::fs;
use std::path::PathBuf;

use fathom_wasm as m;
use fathom_wasm::protocol as p;

/// One entry: wire name, code, and its row's column names in slot order
/// (ADR-0052's own convention for the face rows this module writes — a slot
/// this role leaves unused is named `""`).
struct Entry {
    name: &'static str,
    code: u32,
}

struct FaceEntry {
    name: &'static str,
    code: u32,
    columns: &'static [&'static str],
}

fn opcodes() -> Vec<Entry> {
    vec![
        Entry {
            name: "OP_INIT",
            code: m::OP_INIT,
        },
        Entry {
            name: "OP_QUERY",
            code: m::OP_QUERY,
        },
        Entry {
            name: "OP_ESTATE_DEMO",
            code: m::OP_ESTATE_DEMO,
        },
        Entry {
            name: "OP_INV_ROWS",
            code: m::OP_INV_ROWS,
        },
        Entry {
            name: "OP_ELEMENT",
            code: m::OP_ELEMENT,
        },
        Entry {
            name: "OP_EQUIPMENT",
            code: m::OP_EQUIPMENT,
        },
        Entry {
            name: "OP_PASTE",
            code: m::OP_PASTE,
        },
        Entry {
            name: "OP_EQUIP_ADD",
            code: m::OP_EQUIP_ADD,
        },
        Entry {
            name: "OP_FIELD_SET",
            code: m::OP_FIELD_SET,
        },
        Entry {
            name: "OP_ELEMENT_REMOVE",
            code: m::OP_ELEMENT_REMOVE,
        },
        Entry {
            name: "OP_DIAGRAM",
            code: m::OP_DIAGRAM,
        },
        Entry {
            name: "OP_DICT",
            code: m::OP_DICT,
        },
        Entry {
            name: "OP_PLACE",
            code: m::OP_PLACE,
        },
        Entry {
            name: "OP_RACK_PLACE",
            code: m::OP_RACK_PLACE,
        },
        Entry {
            name: "OP_RACK_ELEVATION",
            code: m::OP_RACK_ELEVATION,
        },
        Entry {
            name: "OP_LINK",
            code: m::OP_LINK,
        },
        Entry {
            name: "OP_FINDINGS",
            code: m::OP_FINDINGS,
        },
        Entry {
            name: "OP_INSIDE",
            code: m::OP_INSIDE,
        },
        Entry {
            name: "OP_CABLE",
            code: m::OP_CABLE,
        },
        Entry {
            name: "OP_LOAD_PLAIN",
            code: m::OP_LOAD_PLAIN,
        },
        Entry {
            name: "OP_EXPORT_PLAIN",
            code: m::OP_EXPORT_PLAIN,
        },
        Entry {
            name: "OP_PASTE_INTO",
            code: m::OP_PASTE_INTO,
        },
    ]
}

fn errors() -> Vec<Entry> {
    vec![
        Entry {
            name: "ERR_UNKNOWN_OP",
            code: p::ERR_UNKNOWN_OP as u32,
        },
        Entry {
            name: "ERR_NOT_INITIALISED",
            code: p::ERR_NOT_INITIALISED as u32,
        },
        Entry {
            name: "ERR_CORPUS_LOAD",
            code: p::ERR_CORPUS_LOAD as u32,
        },
        Entry {
            name: "ERR_BAD_FRAME",
            code: p::ERR_BAD_FRAME as u32,
        },
        Entry {
            name: "ERR_BAD_UTF8",
            code: p::ERR_BAD_UTF8 as u32,
        },
        Entry {
            name: "ERR_NO_ELEMENT",
            code: p::ERR_NO_ELEMENT as u32,
        },
        Entry {
            name: "ERR_PASTE_FRAME",
            code: p::ERR_PASTE_FRAME as u32,
        },
        Entry {
            name: "ERR_INGEST_REFUSED",
            code: p::ERR_INGEST_REFUSED as u32,
        },
        Entry {
            name: "ERR_WELD_REFUSED",
            code: p::ERR_WELD_REFUSED as u32,
        },
        Entry {
            name: "ERR_NOTHING_UNDERSTOOD",
            code: p::ERR_NOTHING_UNDERSTOOD as u32,
        },
        Entry {
            name: "ERR_FIELD_VALUE",
            code: p::ERR_FIELD_VALUE as u32,
        },
        Entry {
            name: "ERR_EQUIP_FRAME",
            code: p::ERR_EQUIP_FRAME as u32,
        },
        Entry {
            name: "ERR_EQUIP_STORE",
            code: p::ERR_EQUIP_STORE as u32,
        },
        Entry {
            name: "ERR_NO_DICTIONARY",
            code: p::ERR_NO_DICTIONARY as u32,
        },
        Entry {
            name: "ERR_NO_LINK",
            code: p::ERR_NO_LINK as u32,
        },
        Entry {
            name: "ERR_LINK_CHOICE",
            code: p::ERR_LINK_CHOICE as u32,
        },
        Entry {
            name: "ERR_PASTE_CHOICE",
            code: p::ERR_PASTE_CHOICE as u32,
        },
        Entry {
            name: "ERR_CABLE_COUNT",
            code: p::ERR_CABLE_COUNT as u32,
        },
        Entry {
            name: "ERR_CABLE_END",
            code: p::ERR_CABLE_END as u32,
        },
        Entry {
            name: "ERR_NO_CABLE",
            code: p::ERR_NO_CABLE as u32,
        },
        Entry {
            name: "ERR_PLAIN_REFUSED",
            code: p::ERR_PLAIN_REFUSED as u32,
        },
    ]
}

/// One row's column names, `""` where a slot this role does not use. Two
/// roles — `FACE_HEADER` and `FACE_FIELD` — carry more than one shape
/// depending on which encoder called them (the inventory header vs. the
/// element/equipment header, for instance); the columns given here are the
/// PRIMARY shape (`encode_inv_reply`'s and `write_element`'s own), noted so a
/// reader does not take them as the only one.
fn faces() -> Vec<FaceEntry> {
    vec![
        FaceEntry {
            name: "FACE_HEADER",
            code: p::FACE_HEADER as u32,
            columns: &[
                "kind_label",
                "column_1",
                "column_2",
                "column_3",
                "column_4",
                "column_5",
                "column_6",
                "opinions",
            ],
        },
        FaceEntry {
            name: "FACE_INV",
            code: p::FACE_INV as u32,
            columns: &[
                "id",
                "cell_1",
                "cell_2",
                "cell_3",
                "cell_4",
                "cell_5",
                "cell_6",
                "opinions_hints",
            ],
        },
        FaceEntry {
            name: "FACE_FIELD",
            code: p::FACE_FIELD as u32,
            columns: &[
                "name",
                "value",
                "provenance",
                "key",
                "editable",
                "hint",
                "",
                "",
            ],
        },
        FaceEntry {
            name: "FACE_PORT",
            code: p::FACE_PORT as u32,
            columns: &[
                "id",
                "label",
                "chassis",
                "connector",
                "service",
                "cable",
                "far_device",
                "",
            ],
        },
        FaceEntry {
            name: "FACE_IFACE",
            code: p::FACE_IFACE as u32,
            columns: &["id", "name", "kind_word", "ports", "", "", "", ""],
        },
        FaceEntry {
            name: "FACE_PASTE",
            code: p::FACE_PASTE as u32,
            columns: &[
                "nodes",
                "edges",
                "residue_lines",
                "secrets_redacted",
                "unresolved",
                "device_id",
                "hostname",
                "platform",
            ],
        },
        FaceEntry {
            name: "FACE_RESIDUE",
            code: p::FACE_RESIDUE as u32,
            columns: &["line_number", "line_text", "reason", "", "", "", "", ""],
        },
        FaceEntry {
            name: "FACE_UNRESOLVED",
            code: p::FACE_UNRESOLVED as u32,
            columns: &["named", "edge_kind", "line_number", "", "", "", "", ""],
        },
        FaceEntry {
            name: "FACE_CAPTURE",
            code: p::FACE_CAPTURE as u32,
            columns: &["text", "", "", "", "", "", "", ""],
        },
        FaceEntry {
            name: "FACE_BOX",
            code: p::FACE_BOX as u32,
            columns: &["id", "kind", "label", "x", "y", "w", "h", "aggregation"],
        },
        FaceEntry {
            name: "FACE_LINE",
            code: p::FACE_LINE as u32,
            columns: &[
                "from_id",
                "to_id",
                "edge_kind",
                "containment",
                "points",
                "members",
                "hand",
                "cable",
            ],
        },
        FaceEntry {
            name: "FACE_CANVAS",
            code: p::FACE_CANVAS as u32,
            columns: &[
                "width",
                "height",
                "mask",
                "hidden_boxes",
                "hidden_lines",
                "untabled_boxes",
                "",
                "",
            ],
        },
        FaceEntry {
            name: "FACE_RACK",
            code: p::FACE_RACK as u32,
            columns: &[
                "id",
                "label",
                "height_u",
                "numbering",
                "ascending",
                "",
                "",
                "",
            ],
        },
        FaceEntry {
            name: "FACE_RACK_SLOT",
            code: p::FACE_RACK_SLOT as u32,
            columns: &[
                "id",
                "device",
                "chassis",
                "position_u",
                "height_u",
                "face",
                "overflow",
                "",
            ],
        },
        FaceEntry {
            name: "FACE_RACK_CLASH",
            code: p::FACE_RACK_CLASH as u32,
            columns: &["chassis_a", "chassis_b", "", "", "", "", "", ""],
        },
        FaceEntry {
            name: "FACE_SHAPE",
            code: p::FACE_SHAPE as u32,
            columns: &["shape_hex", "", "", "", "", "", "", ""],
        },
        FaceEntry {
            name: "FACE_GAP_HEAD",
            code: p::FACE_GAP_HEAD as u32,
            columns: &[
                "gap_groups",
                "unstated_facts",
                "checked",
                "kinds_present",
                "kinds_empty",
                "",
                "",
                "",
            ],
        },
        FaceEntry {
            name: "FACE_GAP",
            code: p::FACE_GAP as u32,
            columns: &[
                "kind_word",
                "field",
                "missing",
                "population",
                "examples_carried",
                "sentence",
                "authorable",
                "",
            ],
        },
        FaceEntry {
            name: "FACE_GAP_ITEM",
            code: p::FACE_GAP_ITEM as u32,
            columns: &["id", "name", "kind_word", "group_index", "", "", "", ""],
        },
        FaceEntry {
            name: "FACE_GAP_EMPTY",
            code: p::FACE_GAP_EMPTY as u32,
            columns: &["kind_word", "required_fields", "", "", "", "", "", ""],
        },
        FaceEntry {
            name: "FACE_INSIDE",
            code: p::FACE_INSIDE as u32,
            columns: &[
                "device_id",
                "hostname",
                "interfaces",
                "units",
                "zones",
                "policy_sets",
                "policies",
                "routes_tunnels_unzoned",
            ],
        },
        FaceEntry {
            name: "FACE_IN_IFACE",
            code: p::FACE_IN_IFACE as u32,
            columns: &["id", "name", "kind_word", "unit_count", "", "", "", ""],
        },
        FaceEntry {
            name: "FACE_IN_UNIT",
            code: p::FACE_IN_UNIT as u32,
            columns: &[
                "id",
                "interface_id",
                "label",
                "addresses",
                "zone_id",
                "zone_name",
                "tunnel",
                "",
            ],
        },
        FaceEntry {
            name: "FACE_IN_ZONE",
            code: p::FACE_IN_ZONE as u32,
            columns: &["id", "name", "members", "", "", "", "", ""],
        },
        FaceEntry {
            name: "FACE_IN_SET",
            code: p::FACE_IN_SET as u32,
            columns: &["id", "scope", "policy_count", "", "", "", "", ""],
        },
        FaceEntry {
            name: "FACE_IN_POLICY",
            code: p::FACE_IN_POLICY as u32,
            columns: &[
                "id",
                "set_id",
                "ordinal",
                "name",
                "action",
                "enabled",
                "description",
                "",
            ],
        },
        FaceEntry {
            name: "FACE_IN_ROUTE",
            code: p::FACE_IN_ROUTE as u32,
            columns: &["id", "name", "", "", "", "", "", ""],
        },
        FaceEntry {
            name: "FACE_IN_PROTO",
            code: p::FACE_IN_PROTO as u32,
            columns: &[
                "id",
                "instance_id",
                "protocol",
                "adjacencies",
                "",
                "",
                "",
                "",
            ],
        },
        FaceEntry {
            name: "FACE_IN_TUNNEL",
            code: p::FACE_IN_TUNNEL as u32,
            columns: &["id", "name", "unit", "", "", "", "", ""],
        },
        FaceEntry {
            name: "FACE_INV_KEY",
            code: p::FACE_INV_KEY as u32,
            columns: &["", "key_1", "key_2", "key_3", "key_4", "key_5", "key_6", ""],
        },
        // ADR-0052 §2's two new faces. `FACE_PASTE_LINE`, not `FACE_LINE` —
        // code 10 above already carries that name for the diagram's routed
        // line; the wire's own flat name space (one JSON object, "faces")
        // forces the same distinct name here.
        FaceEntry {
            name: "FACE_PASTE_LINE",
            code: p::FACE_PASTE_LINE as u32,
            columns: &[
                "ordinal",
                "outcome",
                "byte_start",
                "byte_end",
                "node_id",
                "fields",
                "reason",
                "",
            ],
        },
        FaceEntry {
            name: "FACE_DROP",
            code: p::FACE_DROP as u32,
            columns: &[
                "ordinal",
                "marker_start",
                "marker_end",
                "label",
                "detectors",
                "",
                "",
                "",
            ],
        },
    ]
}

fn json_string(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            _ => out.push(c),
        }
    }
    out.push('"');
    out
}

fn entries_object(entries: &[Entry], indent: &str) -> String {
    let mut out = String::from("{\n");
    for (i, e) in entries.iter().enumerate() {
        out.push_str(indent);
        out.push_str("  ");
        out.push_str(&json_string(e.name));
        out.push_str(": ");
        out.push_str(&e.code.to_string());
        if i + 1 < entries.len() {
            out.push(',');
        }
        out.push('\n');
    }
    out.push_str(indent);
    out.push('}');
    out
}

fn face_numbers_object(entries: &[FaceEntry], indent: &str) -> String {
    let plain: Vec<Entry> = entries
        .iter()
        .map(|f| Entry {
            name: f.name,
            code: f.code,
        })
        .collect();
    entries_object(&plain, indent)
}

fn face_columns_object(entries: &[FaceEntry], indent: &str) -> String {
    let mut out = String::from("{\n");
    for (i, e) in entries.iter().enumerate() {
        out.push_str(indent);
        out.push_str("  ");
        out.push_str(&json_string(e.name));
        out.push_str(": [");
        for (j, col) in e.columns.iter().enumerate() {
            if j > 0 {
                out.push_str(", ");
            }
            out.push_str(&json_string(col));
        }
        out.push(']');
        if i + 1 < entries.len() {
            out.push(',');
        }
        out.push('\n');
    }
    out.push_str(indent);
    out.push('}');
    out
}

/// The whole file, deterministically, sorted by declaration order (this
/// function's own — not `Ord`, so re-running never reshuffles a diff).
fn generated_json() -> String {
    let ops = opcodes();
    let errs = errors();
    let fcs = faces();
    format!(
        "{{\n  \"opcodes\": {},\n  \"faces\": {},\n  \"faceColumns\": {},\n  \"errors\": {}\n}}\n",
        entries_object(&ops, "  "),
        face_numbers_object(&fcs, "  "),
        face_columns_object(&fcs, "  "),
        entries_object(&errs, "  "),
    )
}

fn generated_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../client/src/engine/protocol.generated.json")
}

/// The one-shot generator, `write_client_vectors`'s own pattern: `#[ignore]`
/// because it writes under the client tree, which `cargo test` must not do
/// on every run.
#[test]
#[ignore = "writes client/src/engine/protocol.generated.json -- run explicitly, see this file's module doc"]
fn write_protocol_generated_json() {
    let path = generated_path();
    let json = generated_json();
    fs::write(&path, json.as_bytes())
        .unwrap_or_else(|e| panic!("could not write {}: {e}", path.display()));
    println!("wrote {} ({} bytes)", path.display(), json.len());
}

/// Not ignored: fails loudly the moment the checked-in file stops matching
/// what today's Rust source would generate — a new opcode, face or error
/// added without re-running the generator above.
#[test]
fn protocol_generated_json_is_current() {
    let path = generated_path();
    let on_disk = fs::read_to_string(&path).unwrap_or_else(|e| {
        panic!(
            "{} does not exist or is unreadable ({e}) -- run \
             `cargo test -p fathom-wasm --test protocol_generated -- --ignored --nocapture` \
             once to create it",
            path.display()
        )
    });
    let fresh = generated_json();
    assert_eq!(
        on_disk, fresh,
        "client/src/engine/protocol.generated.json is stale -- re-run \
         `cargo test -p fathom-wasm --test protocol_generated -- --ignored --nocapture`"
    );
}

/// Every declared opcode/face/error constant appears exactly once in its
/// table — catches an entry added to `lib.rs`/`protocol.rs` and forgotten
/// here, which the "is current" test above cannot see on its own (it only
/// compares this file's own output against the disk, not against the crate's
/// full constant set).
#[test]
fn every_table_has_no_duplicate_codes() {
    for (label, codes) in [
        (
            "opcodes",
            opcodes().iter().map(|e| e.code).collect::<Vec<_>>(),
        ),
        (
            "errors",
            errors().iter().map(|e| e.code).collect::<Vec<_>>(),
        ),
        ("faces", faces().iter().map(|e| e.code).collect::<Vec<_>>()),
    ] {
        let mut sorted = codes.clone();
        sorted.sort_unstable();
        sorted.dedup();
        assert_eq!(
            sorted.len(),
            codes.len(),
            "{label} table has a duplicate code: {codes:?}"
        );
    }
}
