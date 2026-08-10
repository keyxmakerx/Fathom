//! WO-08 §4.7.2 — the face protocol's two-path parity, its typed refusals and
//! its determinism.
//!
//! All native (the rlib half), mirroring WO-07 §4.6's pattern: one process,
//! the shell path against the directly-called crate. Every byte the browser's
//! reader will see is pinned here, because the reader is hand-authored JS that
//! no compiler checks (§9 item 9).

use fathom_inventory::{
    columns, demo_estate, element_page, equipment_page, parse_display_id, rows, InvKind,
};
use fathom_wasm::protocol::{
    decode_reply, ErrorView, FaceRowView, ReplyView, ERR_BAD_FRAME, ERR_BAD_UTF8,
    ERR_NOT_INITIALISED, ERR_NO_ELEMENT, FACE_FIELD, FACE_HEADER, FACE_IFACE, FACE_INV, FACE_PORT,
};
use fathom_wasm::shell::Shell;
use fathom_wasm::{OP_ELEMENT, OP_EQUIPMENT, OP_ESTATE_DEMO, OP_INV_ROWS};

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
        assert_eq!(records.len(), 1 + expected.len(), "{}", kind.label());

        let head = &records[0];
        assert_eq!(head.role, FACE_HEADER);
        assert_eq!(head.slot_count, 2 + cols.len() as u32);
        assert_eq!(head.strings[0], kind.label());
        for (i, c) in cols.iter().enumerate() {
            assert_eq!(&head.strings[1 + i], c, "column {i}");
        }
        assert_eq!(head.strings[7], "opinions");

        for (rec, row) in records[1..].iter().zip(expected.iter()) {
            assert_eq!(rec.role, FACE_INV);
            assert_eq!(rec.slot_count, head.slot_count);
            assert_eq!(rec.strings[0], row.id);
            for (i, cell) in row.cells.iter().enumerate() {
                assert_eq!(&rec.strings[1 + i], cell, "cell {i} of {}", row.id);
            }
            assert_eq!(rec.strings[7], row.opinions);
        }
    }
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
                assert_eq!(rec.slot_count, 3);
                assert_eq!(rec.strings[0], f.name);
                assert_eq!(rec.strings[1], f.value);
                assert_eq!(rec.strings[2], f.provenance);
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
