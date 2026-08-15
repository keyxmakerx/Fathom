//! Aggregation at the wire, against the paste that broke it.
//!
//! The page's decoder is hand-authored JavaScript that no compiler checks, so
//! every byte it will read is pinned on this side. `diagram_layers.rs` does that
//! for `56` §4's mask; this does it for `59`'s collapse — what slot 7 of a
//! `FACE_BOX` says, and the one thing a reviewer drove into a refusal in
//! Chromium:
//!
//! > *"Two clicks (open the LogicalUnit group, then its `#6` residual) and the
//! > DOM reads … `data-post   agg:logical-unit:01M0…#12`  <-- not an element id.
//! > Clicking it puts this in the Meaning column: 'the module refused: code 6'."*
//!
//! **Thirteen units is the fixture, and the number is the point.** A run whose
//! length is `1 mod WINDOW` leaves a trailing residual holding exactly one
//! member; a run of ten, which is what the previous test fixture used, never
//! does.

use fathom_wasm::protocol::{decode_reply, ReplyView, FACE_BOX};
use fathom_wasm::shell::Shell;
use fathom_wasm::{OP_DIAGRAM, OP_ELEMENT, OP_PASTE};

mod common;

/// 2026-08-08T00:00:00Z. A stored value, like every timestamp in this tree.
const TS: u64 = 1_786_147_200_000;
const ENTROPY: u128 = 0x0000_0000_0000_0000_2026;
/// `59` §3.1's threshold and `59` §3.7's window, both six.
const WINDOW: usize = 6;
const UNITS: usize = 13;

fn frame(text: &str) -> Vec<u8> {
    let mut f = Vec::with_capacity(24 + text.len());
    f.extend_from_slice(&TS.to_le_bytes());
    f.extend_from_slice(&ENTROPY.to_le_bytes());
    f.extend_from_slice(text.as_bytes());
    f
}

fn hub(units: usize) -> String {
    let mut s = String::from("set system host-name srx-hub-01\n");
    for i in 0..units {
        s.push_str(&format!(
            "set interfaces st0 unit {i} family inet address 10.255.{i}.1/30\n"
        ));
    }
    s
}

/// One drawn box, as the page reads it: the display id, the label, and slot 7's
/// `<count> <interior> <placed> <group key>`.
///
/// `placed` joined the slot with ADR-0035 and sits BEFORE the group key, not
/// after it: the key is the only token here that can be empty, so a token
/// appended after it would be unreadable on an ungrouped box.
struct Box {
    id: String,
    label: String,
    count: usize,
    interior: u32,
    placed: bool,
    group: String,
}

fn draw(shell: &mut Shell, request: &str) -> Vec<Box> {
    let mut req = vec![0b0001_1111u8];
    req.extend_from_slice(request.as_bytes());
    let reply = shell.handle(OP_DIAGRAM, &req);
    let rows = match decode_reply(&reply).expect("a well-formed reply") {
        ReplyView::FaceRows(rows) => rows,
        other => panic!("expected FaceRows, got {other:?}"),
    };
    rows.iter()
        .filter(|r| r.role == FACE_BOX)
        .map(|r| {
            assert_eq!(r.slot_count, 8, "a box row carries eight slots");
            let mut parts = r.strings[7].splitn(4, ' ');
            Box {
                id: r.strings[0].clone(),
                label: r.strings[2].clone(),
                count: parts
                    .next()
                    .unwrap_or("1")
                    .parse()
                    .expect("a decimal count"),
                interior: parts.next().unwrap_or("0").parse().expect("a decimal"),
                placed: parts.next().unwrap_or("0") == "1",
                group: parts.next().unwrap_or("").to_owned(),
            }
        })
        .collect()
}

fn loaded() -> Shell {
    let mut shell = common::booted_shell();
    let reply = shell.handle(OP_PASTE, &frame(&hub(UNITS)));
    assert!(
        matches!(
            decode_reply(&reply).expect("a well-formed reply"),
            ReplyView::FaceRows(_)
        ),
        "the fixture must paste"
    );
    shell
}

/// **The defect, at the wire.** Walk the window forward until one member is
/// left over, then check that the box standing for it is the member — an id
/// `OP_ELEMENT` accepts, no group key, no cardinal — and that `OP_ELEMENT`
/// really does accept it.
#[test]
fn a_one_member_residual_posts_an_element_id_the_module_accepts() {
    let mut shell = loaded();

    let folded = draw(&mut shell, "");
    let fan = folded
        .iter()
        .find(|b| b.count == UNITS && b.label.starts_with("st0.0–"))
        .expect("thirteen units collapse into one box");
    let key = fan.group.split('#').next().unwrap_or_default().to_owned();

    // 13 members, a window of 6: opening at 6 leaves members 6..12 in the
    // window and member 12 alone in the trailing residual.
    let open = draw(&mut shell, &format!("{key}#{}", UNITS - WINDOW - 1));
    let last = open
        .iter()
        .find(|b| b.label == format!("st0.{}", UNITS - 1))
        .expect("the last member is drawn");

    assert_eq!(last.count, 1, "it stands for itself alone");
    assert!(
        !last.id.starts_with("agg:"),
        "a box standing for one node must not carry a group key as its id: {:?}",
        last.id
    );
    assert_eq!(last.group, key, "it still names the group it belongs to");

    // The refusal the reviewer saw was `OP_ELEMENT` rejecting that id. Post it.
    let reply = shell.handle(OP_ELEMENT, last.id.as_bytes());
    match decode_reply(&reply).expect("a well-formed reply") {
        ReplyView::FaceRows(rows) => assert!(!rows.is_empty(), "an element page"),
        ReplyView::Error(e) => panic!(
            "OP_ELEMENT refused the id the diagram posted: code {} · {}",
            e.code, e.detail
        ),
        other => panic!("expected FaceRows, got {other:?}"),
    }

    // And nowhere in that picture does a count of one sit beside a group-key id.
    for b in &open {
        assert!(
            !(b.count == 1 && b.id.starts_with("agg:")),
            "{:?} is one node with a group key for an id",
            b.label
        );
    }
}

/// Slot 7's four fields, and the rule the page's `.split(' ')` depends on: a
/// group key never contains a space.
#[test]
fn slot_seven_carries_the_count_the_interior_and_the_group() {
    let mut shell = loaded();
    let folded = draw(&mut shell, "");

    let stood: usize = folded.iter().map(|b| b.count).sum();
    assert!(stood > folded.len(), "something collapsed");
    for b in &folded {
        assert!(b.count >= 1, "every box stands for at least one node");
        assert!(
            !b.group.contains(' '),
            "a group key holds no space: {:?}",
            b.group
        );
        if b.count > 1 {
            assert!(!b.group.is_empty(), "a collapsed box names its group");
            assert!(b.label.contains('–'), "and prints a named range");
        }
        assert_eq!(b.interior, 0, "no fan edge is hidden inside a box here");
        assert!(
            !b.placed,
            "nothing in this fixture was placed by hand, so every box is computed"
        );
    }
}

/// **X6 at the wire.** No reachable expansion draws more boxes than `*` does.
#[test]
fn no_walk_of_the_window_draws_more_than_every_one_drawn() {
    let mut shell = loaded();
    let ceiling = draw(&mut shell, "*").len();
    let folded = draw(&mut shell, "");
    let keys: Vec<String> = folded
        .iter()
        .filter(|b| b.count > 1)
        .map(|b| b.group.split('#').next().unwrap_or_default().to_owned())
        .collect();

    for at in 0..=UNITS {
        let req: Vec<String> = keys.iter().map(|k| format!("{k}#{at}")).collect();
        let drawn = draw(&mut shell, &req.join("\n")).len();
        assert!(
            drawn <= ceiling,
            "every group open at {at} draws {drawn} boxes against {ceiling}"
        );
    }
}

/// Invariant 9 at the wire: the same view twice is the same bytes, and the
/// order the page lists open groups in does not reach the module.
#[test]
fn the_same_view_encodes_identically() {
    let mut shell = loaded();
    let folded = draw(&mut shell, "");
    let keys: Vec<String> = folded
        .iter()
        .filter(|b| b.count > 1)
        .map(|b| b.group.split('#').next().unwrap_or_default().to_owned())
        .collect();
    assert!(keys.len() >= 2, "the fixture has two groups to reorder");

    let mut req = vec![0b0001_1111u8];
    req.extend_from_slice(format!("{}#0\n{}#0", keys[0], keys[1]).as_bytes());
    let mut swapped = vec![0b0001_1111u8];
    swapped.extend_from_slice(format!("{}#0\n{}#0", keys[1], keys[0]).as_bytes());

    assert_eq!(
        shell.handle(OP_DIAGRAM, &req),
        shell.handle(OP_DIAGRAM, &req),
        "two identical requests"
    );
    assert_eq!(
        shell.handle(OP_DIAGRAM, &req),
        shell.handle(OP_DIAGRAM, &swapped),
        "the order the page lists two open groups in must not change the picture"
    );
}
