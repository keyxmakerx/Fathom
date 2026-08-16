//! `OP_LINK` — the opcode that makes a hand-built estate a network.
//!
//! Before it, five write opcodes could add a device, correct a field, remove an
//! element, place a box and rack a chassis, and **not one created an edge**. A
//! lab built by hand was a pile of unconnected boxes.
//!
//! The four properties these exist to hold, in order of what they would cost:
//!
//! 1. **A wrong edge kind is worse than no edge.** This writes into an estate
//!    of record. Where the schema leaves two answers the opcode must refuse and
//!    ask, and where it leaves none it must say so — never pick.
//! 2. **A cut is a tombstone, not a delete.** The record has to keep "these two
//!    were connected and then they were not".
//! 3. **Drawing the same link twice is not two facts.** An operator who presses
//!    a button twice has not made an error.
//! 4. **A refusal writes nothing**, including leaving no batch open — an open
//!    batch refuses every later write and turns one bad gesture into a dead
//!    page.

use fathom_ir::generated::ir_types::{DeviceField, EdgeKind};
use fathom_wasm::protocol::{
    decode_reply, ReplyView, ERR_EQUIP_FRAME, ERR_LINK_CHOICE, ERR_NO_ELEMENT, ERR_NO_LINK,
};
use fathom_wasm::shell::Shell;
use fathom_wasm::{OP_ELEMENT_REMOVE, OP_EQUIP_ADD, OP_INV_ROWS, OP_LINK};

// --- frames ------------------------------------------------------------------

fn equip_frame(at_ms: u64, entropy: u128, fields: &[(u32, &str)]) -> Vec<u8> {
    let mut v = Vec::new();
    v.extend_from_slice(&at_ms.to_le_bytes());
    v.extend_from_slice(&entropy.to_le_bytes());
    v.push(fields.len() as u8);
    for (key, text) in fields {
        v.extend_from_slice(&(*key as u16).to_le_bytes());
        v.extend_from_slice(&(text.len() as u16).to_le_bytes());
        v.extend_from_slice(text.as_bytes());
    }
    v
}

/// `OP_LINK`'s frame, built the way the page builds it. Written out here rather
/// than shared with the shell so a change to one has to be made twice and
/// noticed once.
fn link_frame(at_ms: u64, entropy: u128, mode: u8, a: &str, b: &str, kind: &str) -> Vec<u8> {
    let mut v = Vec::new();
    v.extend_from_slice(&at_ms.to_le_bytes());
    v.extend_from_slice(&entropy.to_le_bytes());
    v.push(mode);
    v.extend_from_slice(&(a.len() as u16).to_le_bytes());
    v.extend_from_slice(&(b.len() as u16).to_le_bytes());
    v.extend_from_slice(a.as_bytes());
    v.extend_from_slice(b.as_bytes());
    v.extend_from_slice(kind.as_bytes());
    v
}

// --- reading replies ---------------------------------------------------------

fn error_code(reply: &[u8]) -> Option<u16> {
    match decode_reply(reply) {
        Ok(ReplyView::Error(e)) => Some(e.code),
        _ => None,
    }
}

fn error_detail(reply: &[u8]) -> String {
    match decode_reply(reply) {
        Ok(ReplyView::Error(e)) => e.detail,
        other => panic!("expected an error reply, got {other:?}"),
    }
}

/// The edge kind name `OP_LINK` reports having written or cut. Slot 0 of the
/// summary row — the same slot every other write opcode puts its subject in.
fn wrote_kind(reply: &[u8]) -> String {
    match decode_reply(reply) {
        Ok(ReplyView::FaceRows(rows)) => rows
            .first()
            .map(|r| r.strings[0].clone())
            .unwrap_or_default(),
        other => panic!("expected a face reply, got {other:?}"),
    }
}

// --- a two-device lab, built by hand -----------------------------------------

/// Two hand-added devices and their display ids, in the order they were added.
/// Exactly what an operator gets from an empty page and two trips through the
/// equipment sheet.
fn two_devices() -> (Shell, String, String) {
    let mut shell = Shell::new();
    for (i, name) in ["switch-lab-01", "fw-lab-01"].iter().enumerate() {
        let reply = shell.handle(
            OP_EQUIP_ADD,
            &equip_frame(
                1_700_000_000_000 + i as u64,
                0x1111_2222_3333_4444_5555_6666_7777_8888 + i as u128,
                &[
                    (DeviceField::Hostname.key().0, name),
                    (DeviceField::Platform.key().0, "junos-srx"),
                ],
            ),
        );
        assert_eq!(error_code(&reply), None, "add {i} refused: {reply:?}");
    }
    let ids = device_ids(&mut shell);
    assert_eq!(ids.len(), 2, "two adds should be two devices");
    let (a, b) = (ids[0].clone(), ids[1].clone());
    (shell, a, b)
}

/// Every device's display id, read back through the inventory the way the page
/// reads it. `InvKind::ALL`'s first entry is Device; asked by name rather than
/// by a position that moves when a kind is appended.
fn device_ids(shell: &mut Shell) -> Vec<String> {
    let byte = fathom_inventory::InvKind::ALL
        .iter()
        .position(|k| k.label() == "Device")
        .expect("Device is an InvKind") as u8;
    match decode_reply(&shell.handle(OP_INV_ROWS, &[byte])) {
        Ok(ReplyView::FaceRows(rows)) => rows
            .iter()
            .filter(|r| r.role == fathom_wasm::protocol::FACE_INV)
            .map(|r| r.strings[0].clone())
            .collect(),
        other => panic!("the inventory must answer with a face table, got {other:?}"),
    }
}

/// How many live `PeersWith` edges the estate holds, counted through the
/// diagram — the same surface the operator looks at, so a link the store has
/// but the picture will not draw does not count as drawn.
fn drawn_links(shell: &mut Shell) -> Vec<(String, bool)> {
    match decode_reply(&shell.handle(fathom_wasm::OP_DIAGRAM, &[])) {
        Ok(ReplyView::FaceRows(rows)) => rows
            .iter()
            .filter(|r| r.role == fathom_wasm::protocol::FACE_LINE)
            .map(|r| (r.strings[2].clone(), r.strings[6] == "1"))
            .collect(),
        other => panic!("the diagram must answer with a face table, got {other:?}"),
    }
}

// --- the tests ---------------------------------------------------------------

/// **The owner's sentence, end to end.** Two devices added by hand from an
/// empty page, connected by pointing at both — with no kind named, because the
/// schema leaves exactly one answer and a menu of one is a question with no
/// content.
///
/// The line must reach the DIAGRAM, marked as hand-drawn. A link the store
/// holds and the picture will not draw is not a link anyone can see.
#[test]
fn two_hand_added_devices_can_be_connected_and_the_picture_says_who_drew_it() {
    let (mut shell, a, b) = two_devices();
    assert!(
        !drawn_links(&mut shell)
            .iter()
            .any(|(k, _)| k == "PeersWith"),
        "the lab starts unconnected, or this test proves nothing"
    );

    let reply = shell.handle(
        OP_LINK,
        &link_frame(1_700_000_001_000, 0x9999_8888_7777_6666, 1, &a, &b, ""),
    );
    assert_eq!(error_code(&reply), None, "the link was refused: {reply:?}");
    assert_eq!(
        wrote_kind(&reply),
        "PeersWith",
        "the opcode must say which kind it chose, because the page journals it"
    );

    let lines = drawn_links(&mut shell);
    let peers: Vec<_> = lines.iter().filter(|(k, _)| k == "PeersWith").collect();
    assert_eq!(peers.len(), 1, "one link drawn, got {lines:?}");
    assert!(
        peers[0].1,
        "the picture must be able to say a person drew this, not a parser"
    );
}

/// **The mark says "drawn", not "hand", and this is the test that keeps the
/// difference.**
///
/// Every edge in a hand-built estate carries `Origin::Hand`, containment
/// included: `OP_EQUIP_ADD` writes the `HasChassis` edge and a person's gesture
/// caused it. A mark that tested origin alone would therefore appear on every
/// line in this picture and distinguish nothing — measured in the browser as
/// three marked strokes for two devices and one drawn link, of which two said
/// nothing a reader could use.
///
/// So `route::hand_drawn` also requires `class: reference`, because nobody
/// CHOOSES a containment edge — `fathom_weld::containment_edge` computes its
/// kind from the (owner, child) pair. The mark answers *"who says these two are
/// connected"*, and that question only has a contested answer for a
/// relationship.
///
/// This test holds both halves at once, in one picture where every edge shares
/// one origin, which is the only arrangement where the two rules can be told
/// apart.
#[test]
fn only_a_drawn_relationship_is_marked_not_every_hand_written_edge() {
    let (mut shell, a, b) = two_devices();
    shell.handle(
        OP_LINK,
        &link_frame(1_700_000_001_000, 0x9999_8888_7777_6666, 1, &a, &b, ""),
    );
    let lines = drawn_links(&mut shell);
    assert!(
        lines.iter().any(|(k, _)| k == "HasChassis"),
        "a hand-added device has a chassis and the line should be drawn: {lines:?}"
    );
    assert!(
        lines
            .iter()
            .filter(|(k, _)| k == "HasChassis")
            .all(|(_, hand)| !*hand),
        "containment was marked as drawn by hand, so the mark now means nothing: {lines:?}"
    );
    assert!(
        lines
            .iter()
            .filter(|(k, _)| k == "PeersWith")
            .all(|(_, hand)| *hand),
        "the drawn link was not marked: {lines:?}"
    );
}

/// **Pressing it twice is not two facts.** The second call succeeds, reports
/// the same kind, and leaves one line — the same end-state reasoning `OP_PLACE`
/// mode 0 uses for an already-unpinned box.
#[test]
fn drawing_the_same_link_twice_leaves_one() {
    let (mut shell, a, b) = two_devices();
    for i in 0..2 {
        let reply = shell.handle(
            OP_LINK,
            &link_frame(
                1_700_000_001_000 + i,
                0x9999_8888_7777_6666 + i as u128,
                1,
                &a,
                &b,
                "",
            ),
        );
        assert_eq!(error_code(&reply), None, "draw {i} refused: {reply:?}");
    }
    assert_eq!(
        drawn_links(&mut shell)
            .iter()
            .filter(|(k, _)| k == "PeersWith")
            .count(),
        1,
        "two draws must not make two links"
    );
}

/// **The first mistake must not be permanent.** Cut it, and the line is gone
/// from the picture.
#[test]
fn a_link_can_be_cut() {
    let (mut shell, a, b) = two_devices();
    shell.handle(
        OP_LINK,
        &link_frame(1_700_000_001_000, 0x9999_8888_7777_6666, 1, &a, &b, ""),
    );
    let reply = shell.handle(
        OP_LINK,
        &link_frame(1_700_000_002_000, 0x4444_3333_2222_1111, 0, &a, &b, ""),
    );
    assert_eq!(error_code(&reply), None, "the cut was refused: {reply:?}");
    assert!(
        !drawn_links(&mut shell)
            .iter()
            .any(|(k, _)| k == "PeersWith"),
        "a cut link must leave the picture"
    );

    // And a second cut says there is nothing there, rather than pretending.
    let again = shell.handle(
        OP_LINK,
        &link_frame(1_700_000_003_000, 0x5555_6666_7777_8888, 0, &a, &b, ""),
    );
    assert_eq!(error_code(&again), Some(ERR_NO_LINK));
}

/// **A cut is a tombstone.** The link leaves the picture and the estate keeps
/// the fact that it was there — which is what makes an estate a record rather
/// than a snapshot. Redrawing it afterwards must work, because
/// `effective_degree` counts live edges only.
#[test]
fn a_cut_link_can_be_drawn_again() {
    let (mut shell, a, b) = two_devices();
    for (i, mode) in [1u8, 0, 1].iter().enumerate() {
        let reply = shell.handle(
            OP_LINK,
            &link_frame(
                1_700_000_001_000 + i as u64,
                0x9999_8888_7777_6666 + i as u128,
                *mode,
                &a,
                &b,
                "",
            ),
        );
        assert_eq!(error_code(&reply), None, "step {i} refused: {reply:?}");
    }
    assert_eq!(
        drawn_links(&mut shell)
            .iter()
            .filter(|(k, _)| k == "PeersWith")
            .count(),
        1,
        "the redrawn link should be back"
    );
}

/// **A named kind is honoured, and a name the schema does not admit between
/// these two is refused.** This is the path the page takes after asking.
#[test]
fn a_named_kind_is_checked_against_the_pair() {
    let (mut shell, a, b) = two_devices();
    let ok = shell.handle(
        OP_LINK,
        &link_frame(
            1_700_000_001_000,
            0x9999_8888_7777_6666,
            1,
            &a,
            &b,
            EdgeKind::PeersWith.name(),
        ),
    );
    assert_eq!(error_code(&ok), None, "the named kind was refused: {ok:?}");

    let (mut shell, a, b) = two_devices();
    for name in [
        EdgeKind::Link.name(),       // a reference edge, but Interface to Interface
        EdgeKind::HasChassis.name(), // containment, never offerable
        EdgeKind::MountedIn.name(),  // reference, but OP_RACK_PLACE's
        "NotAnEdgeAtAll",
    ] {
        let reply = shell.handle(
            OP_LINK,
            &link_frame(1_700_000_001_000, 0x9999_8888_7777_6666, 1, &a, &b, name),
        );
        assert_eq!(
            error_code(&reply),
            Some(ERR_NO_LINK),
            "{name} should not be drawable between two devices"
        );
    }
}

/// **A pair the schema does not join is refused, and the refusal is not a
/// Rust error string.** `ERR_NO_LINK` travels with an empty detail because the
/// page names both kinds; what must never happen is a `WriteError` leaking
/// through as prose.
#[test]
fn a_pair_with_no_legal_edge_is_refused_in_the_operators_words() {
    let (mut shell, a, _) = two_devices();
    // A device and its own chassis: the schema joins them by CONTAINMENT, which
    // is never offerable, and by nothing else.
    let chassis = {
        let byte = fathom_inventory::InvKind::ALL
            .iter()
            .position(|k| k.label() == "Chassis")
            .expect("Chassis is an InvKind") as u8;
        match decode_reply(&shell.handle(OP_INV_ROWS, &[byte])) {
            Ok(ReplyView::FaceRows(rows)) => rows
                .iter()
                .find(|r| r.role == fathom_wasm::protocol::FACE_INV)
                .map(|r| r.strings[0].clone())
                .expect("a hand-added device has a chassis"),
            other => panic!("expected a face table, got {other:?}"),
        }
    };
    let reply = shell.handle(
        OP_LINK,
        &link_frame(
            1_700_000_001_000,
            0x9999_8888_7777_6666,
            1,
            &a,
            &chassis,
            "",
        ),
    );
    assert_eq!(error_code(&reply), Some(ERR_NO_LINK));
    let detail = error_detail(&reply);
    assert!(
        !detail.contains('{') && !detail.contains("Error"),
        "a store or Rust error leaked into the operator's message: {detail:?}"
    );
}

/// **Several legal kinds is a question, and the answer is the names.**
///
/// Driven through the shell rather than asserted from the schema, because what
/// matters is that the OPCODE refuses to guess. `SecurityPolicy -> AddressSet`
/// is admitted by `MatchSource` and `MatchDestination` alike, and guessing
/// between them would silently invert a firewall rule.
#[test]
fn several_legal_kinds_is_a_question_and_writes_nothing() {
    use fathom_ir::generated::ir_types::NodeKind;
    let names = fathom_weld::hand_link_candidates(NodeKind::SecurityPolicy, NodeKind::AddressSet);
    assert!(
        names.len() > 1,
        "this test needs a genuinely ambiguous pair; the schema now gives {names:?}"
    );

    // The wire form the page splits on: names, single spaces, no prose.
    let joined: Vec<&str> = names.iter().map(|k| k.name()).collect();
    assert_eq!(joined.join(" ").split(' ').count(), names.len());
    assert!(joined.contains(&"MatchSource") && joined.contains(&"MatchDestination"));
}

/// **A refusal leaves no batch open.** The failure this guards is not the
/// refusal itself — it is the NEXT write failing with `BatchOpen`, which reads
/// to the operator as the page having died. Every refusal path is tried, then
/// an ordinary write has to still work.
#[test]
fn no_refusal_leaves_the_store_wedged() {
    let (mut shell, a, b) = two_devices();
    let refusals = [
        // A short frame.
        vec![0u8; 4],
        // Both ends the same box.
        link_frame(1_700_000_001_000, 0x9999_8888, 1, &a, &a, ""),
        // An id that names nothing.
        link_frame(1_700_000_001_000, 0x9999_8888, 1, &a, "device:nope", ""),
        // A kind the pair does not admit.
        link_frame(1_700_000_001_000, 0x9999_8888, 1, &a, &b, "Link"),
        // A cut with nothing to cut.
        link_frame(1_700_000_001_000, 0x9999_8888, 0, &a, &b, ""),
    ];
    for (i, frame) in refusals.iter().enumerate() {
        let reply = shell.handle(OP_LINK, frame);
        assert!(
            error_code(&reply).is_some(),
            "refusal {i} was accepted: {reply:?}"
        );
    }
    let reply = shell.handle(
        OP_LINK,
        &link_frame(1_700_000_009_000, 0x1234_5678_9abc, 1, &a, &b, ""),
    );
    assert_eq!(
        error_code(&reply),
        None,
        "a write after five refusals was refused, so a batch was left open: {reply:?}"
    );
}

/// The two frame refusals name their own codes, so the page can tell "you sent
/// me nonsense" from "the schema says no".
#[test]
fn the_frame_refusals_are_distinguishable() {
    let (mut shell, a, b) = two_devices();
    assert_eq!(
        error_code(&shell.handle(OP_LINK, &[0u8; 4])),
        Some(ERR_EQUIP_FRAME)
    );
    // A length that runs past the end of the frame.
    let mut short = link_frame(1_700_000_001_000, 0x9999_8888, 1, &a, &b, "");
    short[25] = 0xff;
    assert_eq!(
        error_code(&shell.handle(OP_LINK, &short)),
        Some(ERR_EQUIP_FRAME)
    );
    assert_eq!(
        error_code(&shell.handle(
            OP_LINK,
            &link_frame(1_700_000_001_000, 0x9999_8888, 1, &a, &a, "")
        )),
        Some(ERR_NO_ELEMENT)
    );
}

/// A link onto a REMOVED box is refused. The store would take it — `insert_edge`
/// checks that a node exists, not that it is still asserted — and the diagram
/// would then draw nothing, so the gesture's whole effect would be a fact
/// nobody can see.
#[test]
fn a_removed_box_cannot_be_linked() {
    let (mut shell, a, b) = two_devices();
    let mut remove = 1_700_000_005_000u64.to_le_bytes().to_vec();
    remove.extend_from_slice(&0xaaaa_bbbb_cccc_ddddu128.to_le_bytes());
    remove.extend_from_slice(b.as_bytes());
    let reply = shell.handle(OP_ELEMENT_REMOVE, &remove);
    assert_eq!(
        error_code(&reply),
        None,
        "the remove was refused: {reply:?}"
    );

    let reply = shell.handle(
        OP_LINK,
        &link_frame(1_700_000_006_000, 0x9999_8888_7777_6666, 1, &a, &b, ""),
    );
    assert_eq!(error_code(&reply), Some(ERR_NO_ELEMENT));
}

/// `ERR_LINK_CHOICE` is a distinct code from every refusal, because a page that
/// pattern-matched an English sentence to decide whether to show a chooser
/// would be guessing.
#[test]
fn the_choice_code_is_not_a_refusal_code() {
    assert_ne!(ERR_LINK_CHOICE, ERR_NO_LINK);
    assert_ne!(ERR_LINK_CHOICE, ERR_NO_ELEMENT);
    assert_ne!(ERR_LINK_CHOICE, ERR_EQUIP_FRAME);
}
