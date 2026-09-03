//! WO-08 §4.7.2 — the face protocol's two-path parity, its typed refusals and
//! its determinism.
//!
//! All native (the rlib half), mirroring WO-07 §4.6's pattern: one process,
//! the shell path against the directly-called crate. Every byte the browser's
//! reader will see is pinned here, because the reader is hand-authored JS that
//! no compiler checks (§9 item 9).

use fathom_inventory::{
    column_keys, columns, demo_estate, element_page, equipment_page, parse_display_id, rows,
    InvKind,
};
use fathom_ir::generated::ir_types::PhysicalPortField;
use fathom_wasm::protocol::{
    decode_reply, ErrorView, FaceRowView, ReplyView, ERR_BAD_FRAME, ERR_BAD_UTF8,
    ERR_NOT_INITIALISED, ERR_NO_ELEMENT, FACE_FIELD, FACE_HEADER, FACE_IFACE, FACE_INV,
    FACE_INV_KEY, FACE_PORT,
};
use fathom_wasm::shell::Shell;
use fathom_wasm::{OP_ELEMENT, OP_EQUIPMENT, OP_ESTATE_DEMO, OP_FIELD_SET, OP_INV_ROWS};

fn face(reply: &[u8]) -> Vec<FaceRowView> {
    match decode_reply(reply).expect("a well-formed reply") {
        ReplyView::FaceRows(rows) => rows,
        other => panic!("expected FaceRows, got {other:?}"),
    }
}

fn error(reply: &[u8]) -> ErrorView {
    match decode_reply(reply).expect("a well-formed reply") {
        ReplyView::Error(e) => e,
        other => panic!("expected Error, got {other:?}"),
    }
}

fn loaded() -> Shell {
    let mut s = Shell::new();
    assert!(
        s.handle(OP_ESTATE_DEMO, &[]).is_empty(),
        "OP_ESTATE_DEMO replies empty on success"
    );
    s
}

fn kind_byte(k: InvKind) -> u8 {
    InvKind::ALL
        .iter()
        .position(|x| *x == k)
        .expect("a shipped kind") as u8
}

#[test]
fn estate_demo_then_inventory_rows_mirror_the_crate() {
    let mut shell = loaded();
    let g = demo_estate();

    for kind in InvKind::ALL {
        let reply = shell.handle(OP_INV_ROWS, &[kind_byte(kind)]);
        let records = face(&reply);
        let cols = columns(kind);
        let expected = rows(&g, kind);
        // Two chrome records now: the header, then the editable-column keys.
        assert_eq!(records.len(), 2 + expected.len(), "{}", kind.label());

        let head = &records[0];
        assert_eq!(head.role, FACE_HEADER);
        assert_eq!(head.slot_count, 2 + cols.len() as u32);
        assert_eq!(head.strings[0], kind.label());
        for (i, c) in cols.iter().enumerate() {
            assert_eq!(&head.strings[1 + i], c, "column {i}");
        }
        assert_eq!(head.strings[7], "opinions");

        // The key row mirrors the header slot for slot, which is what lets the
        // page read a column's key at the index it read that column's name.
        let keys = &records[1];
        assert_eq!(keys.role, FACE_INV_KEY);
        assert_eq!(keys.slot_count, head.slot_count);
        assert_eq!(
            keys.strings[0],
            "",
            "{}: slot 0 is not a column",
            kind.label()
        );
        for (i, k) in column_keys(kind).iter().enumerate() {
            let want = k.map(|k| k.0.to_string()).unwrap_or_default();
            assert_eq!(keys.strings[1 + i], want, "{} key {i}", kind.label());
        }
        assert_eq!(
            keys.strings[7],
            "",
            "{}: the opinions column is never editable",
            kind.label()
        );

        for (rec, row) in records[2..].iter().zip(expected.iter()) {
            assert_eq!(rec.role, FACE_INV);
            assert_eq!(rec.slot_count, head.slot_count);
            assert_eq!(rec.strings[0], row.id);
            for (i, cell) in row.cells.iter().enumerate() {
                assert_eq!(&rec.strings[1 + i], cell, "cell {i} of {}", row.id);
            }
            // ADR-0041 D5/D7: slot 7 is `<opinions> <hints>`, hints last and
            // possibly empty. `format!` is `encode_inv_reply`'s own packing,
            // pinned here rather than re-derived so the page's split-once
            // reading and this assertion cannot silently drift apart.
            assert_eq!(
                rec.strings[7],
                format!("{} {}", row.opinions, row.hints),
                "slot 7 of {}",
                row.id
            );
        }
    }
}

/// ADR-0041 D5/D7, pinned end to end: a cell that
/// `fathom_ingest::redact::looks_like_credential` flags is named in slot 7's
/// hints half, at the SAME index the cell itself sits at in slots 1..=6 — and
/// an estate with nothing credential-shaped in it packs an empty hints half,
/// so the common case costs one byte and not a wire shape change.
#[test]
fn a_credential_looking_cell_is_named_in_slot_seven_by_its_own_index() {
    let mut shell = loaded();
    let g = demo_estate();

    // The demo estate carries no credential-shaped text (`opinions_cells_are_all_em_dash`'s
    // sibling claim, `fathom-inventory`'s own `credential_hints` test covers the
    // detector's wiring) — so every row's hints half is empty here, and slot 7
    // is exactly `"— "` for every row of every kind that has any.
    let mut saw_a_row = false;
    for kind in InvKind::ALL {
        let reply = shell.handle(OP_INV_ROWS, &[kind_byte(kind)]);
        let records = face(&reply);
        let expected = rows(&g, kind);
        for (rec, row) in records[2..].iter().zip(expected.iter()) {
            assert_eq!(rec.role, FACE_INV);
            assert_eq!(row.hints, "", "the demo estate names no credential shapes");
            assert_eq!(rec.strings[7], format!("{} ", row.opinions));
            saw_a_row = true;
        }
    }
    assert!(saw_a_row, "the demo estate projected no rows at all");
}

/// `[u64 at][u128 entropy][u32 key][u16 id_len][id][value]` — `OP_FIELD_SET`'s
/// frame, mirrored from `tests/equip.rs`'s `edit_frame` (a separate test
/// binary cannot share it, and it is four lines).
fn edit_frame(at_ms: u64, entropy: u128, key: u32, id: &str, value: &str) -> Vec<u8> {
    let mut v = Vec::new();
    v.extend_from_slice(&at_ms.to_le_bytes());
    v.extend_from_slice(&entropy.to_le_bytes());
    v.extend_from_slice(&key.to_le_bytes());
    v.extend_from_slice(&(id.len() as u16).to_le_bytes());
    v.extend_from_slice(id.as_bytes());
    v.extend_from_slice(value.as_bytes());
    v
}

/// ADR-0041 D1/D5/D7, the positive path: a person types a credential-looking
/// value into a hand-editable cell through `OP_FIELD_SET` — the exact door
/// `2026-09-03-the-gate-is-only-on-the-paste-box.mjs` proved is ungated — and
/// the value is stored EXACTLY as typed (D1: nothing refused, nothing
/// destroyed) while the next `OP_INV_ROWS` reply names that cell in slot 7's
/// hints half.
#[test]
fn a_hand_typed_credential_saves_untouched_and_is_named_in_the_hints() {
    let mut shell = loaded();

    let port_kind = kind_byte(InvKind::PhysicalPort);
    let label_col = columns(InvKind::PhysicalPort)
        .iter()
        .position(|c| *c == "label")
        .expect("PhysicalPort has a label column");

    let pid = {
        let reply = shell.handle(OP_INV_ROWS, &[port_kind]);
        face(&reply)
            .iter()
            .find(|r| r.role == FACE_INV)
            .map(|r| r.strings[0].clone())
            .expect("the demo estate has at least one PhysicalPort")
    };

    const PSK: &str = "IPsec PSK: n3JHwd82ka0ppwiVzLp7YXjLp2Qz3Rt5Uv1Wx2Yz3";
    let reply = shell.handle(
        OP_FIELD_SET,
        &edit_frame(
            1_700_000_000_000,
            0x2026_0903_0000_0000_0000_0000_0000_0001,
            PhysicalPortField::Label.key().0,
            &pid,
            PSK,
        ),
    );
    assert!(
        !matches!(decode_reply(&reply), Ok(ReplyView::Error(_))),
        "the typed value was refused: {:?}",
        decode_reply(&reply)
    );

    let reply = shell.handle(OP_INV_ROWS, &[port_kind]);
    let records = face(&reply);
    let row = records
        .iter()
        .find(|r| r.role == FACE_INV && r.strings[0] == pid)
        .expect("the port row is still there");
    assert_eq!(
        row.strings[1 + label_col],
        PSK,
        "D1: the value is stored EXACTLY as typed, not refused or destroyed"
    );
    let hints = row.strings[7].split_once(' ').map(|(_, h)| h).unwrap_or("");
    assert_eq!(
        hints,
        label_col.to_string(),
        "the label column is named in slot 7's hints half"
    );
}

/// The one sentence the key row exists to make true, pinned on the kind an
/// operator meets first: **the columns a cell editor is offered over are the
/// device's own typeable fields, and `premises` is not one of them.**
///
/// `premises` is the case that matters. It is a traversal — Device -> Site ->
/// Premises `label` — so it renders like every other cell and has nowhere to
/// write, and a page that decided editability by looking at the column NAME
/// would offer it. Named here rather than left to the generic loop above,
/// because a loop that compares two derivations of the same table would still
/// pass if both were wrong.
#[test]
fn the_device_row_set_offers_its_own_fields_and_not_the_walk() {
    let mut shell = loaded();
    let records = face(&shell.handle(OP_INV_ROWS, &[kind_byte(InvKind::Device)]));
    let head = &records[0];
    let keys = &records[1];
    assert_eq!(keys.role, FACE_INV_KEY);

    let offered: Vec<&str> = (0..columns(InvKind::Device).len())
        .filter(|i| !keys.strings[1 + i].is_empty())
        .map(|i| head.strings[1 + i].as_str())
        .collect();
    assert_eq!(
        offered,
        ["hostname", "platform", "os_version", "role"],
        "the editable Device columns"
    );
}

#[test]
fn element_and_equipment_replies_mirror_the_crate() {
    let mut shell = loaded();
    let g = demo_estate();

    for kind in InvKind::ALL {
        for row in rows(&g, kind) {
            let node = match parse_display_id(&g, &row.id).expect("a resolvable id") {
                fathom_graph::ElementId::Node(n) => n,
                fathom_graph::ElementId::Edge(e) => panic!("{e} is an edge"),
            };
            let page = element_page(&g, node).expect("a live node has a page");
            let records = face(&shell.handle(OP_ELEMENT, row.id.as_bytes()));
            assert_eq!(records.len(), 1 + page.fields.len(), "{}", row.id);

            let head = &records[0];
            assert_eq!(head.role, FACE_HEADER);
            assert_eq!(head.slot_count, 4);
            assert_eq!(head.strings[0], page.kind_word);
            assert_eq!(head.strings[1], page.name);
            assert_eq!(head.strings[2], page.id);
            assert_eq!(head.strings[3], page.context.clone().unwrap_or_default());

            for (rec, f) in records[1..].iter().zip(page.fields.iter()) {
                assert_eq!(rec.role, FACE_FIELD);
                // Five since 2026-08-11. Slots 3 and 4 -- the field's wire key
                // and whether its type can be typed in -- were added so the page
                // can offer an editor without keeping a name-to-key table of its
                // own. A table like that in JavaScript is how a form ends up
                // writing one field into another's slot, and it would be
                // unpinned by anything.
                assert_eq!(rec.slot_count, 5);
                assert_eq!(rec.strings[0], f.name);
                assert_eq!(rec.strings[1], f.value);
                assert_eq!(rec.strings[2], f.provenance);
                assert_eq!(rec.strings[3], f.key.0.to_string());
                assert_eq!(rec.strings[4], if f.editable { "1" } else { "" });
            }
        }
    }

    // The equipment page of srx-a, slot for slot.
    let srx = rows(&g, InvKind::Device)
        .into_iter()
        .find(|r| r.cells[0] == "srx-a")
        .expect("srx-a is in the estate");
    let node = match parse_display_id(&g, &srx.id).expect("a resolvable id") {
        fathom_graph::ElementId::Node(n) => n,
        fathom_graph::ElementId::Edge(e) => panic!("{e} is an edge"),
    };
    let page = equipment_page(&g, node).expect("srx-a has an equipment page");
    let records = face(&shell.handle(OP_EQUIPMENT, srx.id.as_bytes()));
    assert_eq!(
        records.len(),
        1 + page.element.fields.len() + page.ports.len() + page.interfaces.len()
    );
    assert_eq!(page.ports.len(), 4);
    assert_eq!(page.interfaces.len(), 6);

    let ports = &records[1 + page.element.fields.len()..][..page.ports.len()];
    for (rec, p) in ports.iter().zip(page.ports.iter()) {
        assert_eq!(rec.role, FACE_PORT);
        assert_eq!(rec.slot_count, 7);
        assert_eq!(rec.strings[0], p.id);
        assert_eq!(rec.strings[1], p.label);
        assert_eq!(rec.strings[2], p.chassis);
        assert_eq!(rec.strings[3], p.connector);
        assert_eq!(rec.strings[4], p.service);
        match &p.cabled {
            Some(c) => {
                assert_eq!(rec.strings[5], c.text);
                assert_eq!(rec.strings[6], c.far_device);
            }
            None => {
                assert_eq!(rec.strings[5], "—");
                assert_eq!(rec.strings[6], "");
            }
        }
    }

    let ifaces = &records[1 + page.element.fields.len() + page.ports.len()..];
    for (rec, i) in ifaces.iter().zip(page.interfaces.iter()) {
        assert_eq!(rec.role, FACE_IFACE);
        assert_eq!(rec.slot_count, 4);
        assert_eq!(rec.strings[0], i.id);
        assert_eq!(rec.strings[1], i.name);
        assert_eq!(rec.strings[2], i.kind_word);
        assert_eq!(rec.strings[3], i.ports);
    }

    // Bramble reaches no device: the empty state, never an error.
    let bramble = rows(&g, InvKind::Premises)
        .into_iter()
        .find(|r| r.cells[0] == "Bramble Logistics HQ")
        .expect("Bramble is in the estate");
    let reply = shell.handle(OP_EQUIPMENT, bramble.id.as_bytes());
    assert!(face(&reply).is_empty(), "record_count == 0");
}

#[test]
fn face_error_replies_are_typed() {
    let mut cold = Shell::new();
    assert_eq!(
        error(&cold.handle(OP_INV_ROWS, &[0])).code,
        ERR_NOT_INITIALISED
    );

    let mut shell = loaded();
    // One past the last declared kind, derived rather than written: this line
    // said `[3]` until 2026-08-10, when the strip grew from three kinds to nine
    // and byte 3 became `Interface`. A literal here does not fail when the enum
    // grows — it silently stops testing the refusal and starts testing a kind.
    let past_the_end = u8::try_from(InvKind::ALL.len()).expect("fewer than 256 kinds");
    assert_eq!(
        error(&shell.handle(OP_INV_ROWS, &[past_the_end])).code,
        ERR_BAD_FRAME
    );
    assert_eq!(error(&shell.handle(OP_INV_ROWS, &[])).code, ERR_BAD_FRAME);
    assert_eq!(
        error(&shell.handle(OP_ESTATE_DEMO, b"x")).code,
        ERR_BAD_FRAME
    );

    // A well-formed display id whose ULID is not in the estate: srx-a's, with
    // its last Crockford digit moved to `Z` (31) — a `k` §4.8 never uses.
    let g = demo_estate();
    let srx = rows(&g, InvKind::Device)
        .into_iter()
        .find(|r| r.cells[0] == "srx-a")
        .expect("srx-a is in the estate");
    let mut chars: Vec<char> = srx.id.chars().collect();
    *chars.last_mut().expect("a non-empty id") = 'Z';
    let absent: String = chars.into_iter().collect();
    let e = error(&shell.handle(OP_ELEMENT, absent.as_bytes()));
    assert_eq!(e.code, ERR_NO_ELEMENT);
    assert_eq!(e.detail, absent);

    assert_eq!(
        error(&shell.handle(OP_ELEMENT, &[0xff, 0xfe])).code,
        ERR_BAD_UTF8
    );
}

/// **Six columns is the wire's limit, and it is not enforced anywhere else.**
///
/// `protocol::FACE_SLOTS` is 8: slot 0 carries the row id (or the kind label on
/// the header record), slot 7 carries the opinions header, and the columns sit
/// between. `encode_inv_reply` writes `slot_count = 2 + columns.len()` and then
/// hands `face_slots` a list it truncates with `.take(FACE_SLOTS)`.
///
/// **What a seventh column actually costs is the OPINIONS slot, not the
/// column.** Read the encoder rather than assumed: with seven columns
/// `header_slots` is already eight long when the pad loop's `len < FACE_SLOTS -
/// 1` test is reached, so the loop adds nothing, `push("opinions")` makes nine,
/// and `.take(8)` discards the LAST element. The seventh column survives — into
/// slot 7, which is the slot the page reads the opinions text out of. So the
/// failure is not a missing column, it is a column's value rendered as the row's
/// opinions, and `slot_count` claiming 9 while eight slots exist.
///
/// An earlier version of this comment said the seventh column was the casualty.
/// It was wrong, and the assertion below was right anyway, which is exactly the
/// combination that survives review: the numbers held while the story did not.
///
/// Found 2026-08-15 while adding `SecurityPolicy`, whose natural column list
/// was eight. Pinned rather than fixed: widening the record is a protocol
/// change that touches every face and the hand-authored reader, which is
/// owner/planning work. What this test buys is that the next kind to want a
/// seventh column gets a red test naming the reason instead of a broken table.
#[test]
fn no_row_set_exceeds_the_face_record() {
    for kind in InvKind::ALL {
        let n = columns(kind).len();
        assert!(
            n <= 6,
            "{} declares {n} columns; the face record carries 6 between the id \
             and the opinions header, and the surplus is dropped in silence",
            kind.label()
        );
    }
}

/// Every kind's header record carries its declared columns, and the opinions
/// header lands in the slot the page reads it from. The assertion above is the
/// cause; this is the symptom it prevents.
#[test]
fn every_kind_header_carries_its_columns_and_the_opinions_slot() {
    let mut shell = loaded();
    for kind in InvKind::ALL {
        let reply = face(&shell.handle(OP_INV_ROWS, &[kind_byte(kind)]));
        let head = reply.first().expect("a header record");
        assert_eq!(head.role, FACE_HEADER);
        let cols = columns(kind);
        assert_eq!(head.slot_count as usize, 2 + cols.len(), "{}", kind.label());
        assert_eq!(head.strings[0], kind.label());
        for (i, name) in cols.iter().enumerate() {
            assert_eq!(&head.strings[1 + i], name, "{} column {i}", kind.label());
        }
        assert_eq!(
            head.strings[7],
            "opinions",
            "{}: the opinions header must survive",
            kind.label()
        );
    }
}

#[test]
fn face_reply_encoding_is_deterministic() {
    let mut a = loaded();
    let mut b = loaded();
    let g = demo_estate();

    assert_eq!(a.handle(OP_ESTATE_DEMO, &[]), b.handle(OP_ESTATE_DEMO, &[]));
    for kind in InvKind::ALL {
        let req = [kind_byte(kind)];
        assert_eq!(a.handle(OP_INV_ROWS, &req), b.handle(OP_INV_ROWS, &req));
        for row in rows(&g, kind) {
            let id = row.id.as_bytes();
            assert_eq!(a.handle(OP_ELEMENT, id), b.handle(OP_ELEMENT, id));
            assert_eq!(a.handle(OP_EQUIPMENT, id), b.handle(OP_EQUIPMENT, id));
        }
    }
}
