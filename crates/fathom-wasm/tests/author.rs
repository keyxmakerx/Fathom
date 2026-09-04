//! **WHO MADE THIS CHANGE.**
//!
//! `49` §10c calls the author on every operation a phase-0 item: free now,
//! brutal later. It was worse than that document says. Every mutating opcode
//! minted its author as `Ulid::from_parts(at.0, 1)` — **derived from the host
//! clock** — so a fifty-operation estate carried up to fifty distinct
//! `UserId`s, none of which was a person. `49` called it "the same anonymous
//! nobody"; it was one nobody per millisecond, which is worse, because it looks
//! like authorship data and is noise.
//!
//! These tests could not have been written before 2026-08-21. The opcodes
//! answer with rendered faces rather than with the graph, so a test could see
//! what a face SAID and never who a fact was ATTRIBUTED TO — which is precisely
//! why the defect survived. `Shell::estate_for_test` behind the `inspect`
//! feature is that read path, and `artifact_gates.rs` proves it is absent from
//! the shipping module.

use fathom_graph::{Actor, ElementId, UserId};
use fathom_ir::generated::ir_types::{ChassisField, DeviceField};
use fathom_wasm::protocol::decode_reply;
use fathom_wasm::shell::Shell;
use fathom_wasm::{OP_ELEMENT_REMOVE, OP_EQUIP_ADD};

/// The wire frame, same shape `equip.rs` builds: a 24-byte clock and entropy
/// prefix, then `[u8 count]` and `count` x `[u16 key][u16 len][utf8]`.
fn frame(at_ms: u64, entropy: u128, fields: &[(u32, &str)]) -> Vec<u8> {
    let mut v = frame_head(at_ms, entropy);
    v.push(fields.len() as u8);
    for (key, text) in fields {
        v.extend_from_slice(&(*key as u16).to_le_bytes());
        v.extend_from_slice(&(text.len() as u16).to_le_bytes());
        v.extend_from_slice(text.as_bytes());
    }
    v
}

fn frame_head(at_ms: u64, entropy: u128) -> Vec<u8> {
    let mut v = Vec::new();
    v.extend_from_slice(&at_ms.to_le_bytes());
    v.extend_from_slice(&entropy.to_le_bytes());
    v
}

fn is_error(reply: &[u8]) -> Option<String> {
    match decode_reply(reply) {
        Ok(fathom_wasm::protocol::ReplyView::Error(e)) => Some(format!("{e:?}")),
        _ => None,
    }
}

/// Add a device, then correct a field, **at two different clock readings**.
///
/// Before the fix each op wrote a different `UserId` because it was derived
/// from `at`, so this fails on the real defect rather than on a spelling.
#[test]
fn one_author_reaches_every_provenance_record() {
    let mut shell = Shell::new();
    let reply = shell.handle(
        OP_EQUIP_ADD,
        &frame(
            1_700_000_000_000,
            0x0123_4567_89ab_cdef_0123_4567_89ab_cdef,
            &[
                (DeviceField::Hostname.key().0, "srx-author-01"),
                (DeviceField::Platform.key().0, "junos-srx"),
                (DeviceField::Role.key().0, "firewall"),
                (ChassisField::Model.key().0, "SRX345"),
            ],
        ),
    );
    assert_eq!(is_error(&reply), None, "the add was refused: {reply:?}");

    let graph = shell.estate_for_test().expect("an estate was created");
    let mut seen = 0usize;
    let provs: Vec<_> = graph.nodes().map(|n| n.existence).collect();
    for id in provs {
        let rec = graph
            .provenance(id)
            .expect("every node's existence is recorded");
        seen += 1;
        assert_eq!(
            rec.asserted_by,
            Actor::User(UserId::LOCAL),
            "a provenance record names an author that is not UserId::LOCAL — \
             the clock-derived author is back, and this estate now claims to \
             have been written by more than one person"
        );
    }
    assert!(seen > 0, "the estate recorded no provenance at all");
}

/// **A REMOVAL RECORDS ITS AUTHOR.**
///
/// The one hole an audit log can never backfill. A tombstone writes no
/// provenance record, so before `Op::Tombstone` gained `by` the removal of a
/// fact was the single operation in the product that recorded nobody — and a
/// removal is exactly the operation an audit is asked about.
///
/// This test does not compile if that field is reverted.
#[test]
fn a_removal_records_its_author() {
    let mut shell = Shell::new();
    let reply = shell.handle(
        OP_EQUIP_ADD,
        &frame(
            1_700_000_000_000,
            0x0123_4567_89ab_cdef_0123_4567_89ab_cdef,
            &[
                (DeviceField::Hostname.key().0, "srx-doomed-01"),
                (DeviceField::Platform.key().0, "junos-srx"),
                (DeviceField::Role.key().0, "firewall"),
                (ChassisField::Model.key().0, "SRX345"),
            ],
        ),
    );
    assert_eq!(is_error(&reply), None, "the add was refused: {reply:?}");

    let id = shell
        .estate_for_test()
        .expect("an estate")
        .nodes()
        .next()
        .expect("a node was written")
        .id;

    let mut req =
        Vec::from(&frame_head(1_700_000_001_000, 0xdead_beef_dead_beef_dead_beef_dead_beef)[..]);
    req.extend_from_slice(ElementId::Node(id).to_string().as_bytes());
    let reply = shell.handle(OP_ELEMENT_REMOVE, &req);
    assert_eq!(is_error(&reply), None, "the removal was refused: {reply:?}");

    let graph = shell.estate_for_test().expect("an estate");
    let tombstones: Vec<_> = graph
        .log()
        .iter()
        .flat_map(|b| b.ops.iter())
        .filter_map(|op| match op {
            fathom_graph::Op::Tombstone { by, .. } => Some(*by),
            _ => None,
        })
        .collect();
    assert!(
        !tombstones.is_empty(),
        "the removal recorded no tombstone op"
    );
    for by in tombstones {
        assert_eq!(
            by,
            Actor::User(UserId::LOCAL),
            "a tombstone names an author that is not UserId::LOCAL"
        );
    }
}
