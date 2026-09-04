//! `OP_PLACE` at the wire (ADR-0035): a hand position is graph data.
//!
//! The browser drive is `docs/80-review/evidence/2026-08-15-hand-placement-drive.mjs`
//! and it is the one that answers the owner's question. This file answers the
//! ones a browser cannot: what the module does with a frame that is wrong, what
//! it does with the same box twice, and whether the picture's own numbers move
//! for a placement and for nothing else.
//!
//! The estate is built through `OP_PASTE`, not by hand, so the display ids these
//! tests post are exactly the ids the page would have.

use fathom_wasm::protocol::{decode_reply, ReplyView, FACE_BOX};
use fathom_wasm::shell::Shell;
use fathom_wasm::{OP_DIAGRAM, OP_PASTE, OP_PLACE};

mod common;

/// 2026-08-08T00:00:00Z. A stored value, like every timestamp in this tree.
const TS: u64 = 1_786_147_200_000;
const ENTROPY: u128 = 0x0000_0000_0000_0000_2026;

const PASTE: &str = "\
set system host-name srx-branch-01
set interfaces ge-0/0/0 unit 0 family inet address 203.0.113.2/30
set interfaces st0 unit 0 family inet address 10.255.0.1/30
set security ike gateway gw-hq address 198.51.100.10
set security ike gateway gw-hq external-interface ge-0/0/0.0
set security ipsec vpn hq-vpn ike gateway gw-hq
set security ipsec vpn hq-vpn bind-interface st0.0
";

/// One drawn box as the page reads it: id, x, y, and slot 7's placed flag.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Box {
    id: String,
    x: i32,
    y: i32,
    placed: bool,
}

fn loaded() -> Shell {
    let mut shell = common::booted_shell();
    let mut f = Vec::new();
    f.extend_from_slice(&TS.to_le_bytes());
    f.extend_from_slice(&ENTROPY.to_le_bytes());
    // Confirm byte (2026-08-21): 0 = refuse on an identity match. This builder
    // predates the 25-byte prefix and was silently eating the paste's first
    // character as the flag.
    f.push(0);
    f.extend_from_slice(PASTE.as_bytes());
    let reply = shell.handle(OP_PASTE, &f);
    assert!(
        matches!(
            decode_reply(&reply).expect("a well-formed reply"),
            ReplyView::FaceRows(_)
        ),
        "the fixture must paste"
    );
    shell
}

/// Every node drawn as itself — no aggregation, so every box stands for one node
/// and every one of them is placeable.
fn draw(shell: &mut Shell) -> Vec<Box> {
    let mut req = vec![0b0001_1111u8];
    req.extend_from_slice(b"*");
    let reply = shell.handle(OP_DIAGRAM, &req);
    let rows = match decode_reply(&reply).expect("a well-formed reply") {
        ReplyView::FaceRows(rows) => rows,
        other => panic!("expected FaceRows, got {other:?}"),
    };
    rows.iter()
        .filter(|r| r.role == FACE_BOX)
        .map(|r| {
            let mut parts = r.strings[7].splitn(4, ' ');
            let _count = parts.next();
            let _interior = parts.next();
            Box {
                id: r.strings[0].clone(),
                x: r.strings[3].parse().expect("a decimal x"),
                y: r.strings[4].parse().expect("a decimal y"),
                placed: parts.next() == Some("1"),
            }
        })
        .collect()
}

/// Every call gets its OWN entropy, and that is the host's contract rather than
/// a convenience for these tests. `fathom_weld::Mint` walks a counter from
/// `(clock, entropy)`, so two ops handed the same pair mint the same provenance
/// ids and the store refuses the second as `ProvenanceIdReused` — which is
/// exactly what it should do, and exactly why `hostEntropy()` is called once per
/// op in the page rather than once per session. Written with a fixed entropy,
/// this helper made every test below fail on the FIRST placement, because the
/// paste that builds the fixture had already spent that base.
fn frame(mode: u8, x: i32, y: i32, id: &str, at: u64, entropy: u128) -> Vec<u8> {
    let mut f = Vec::with_capacity(33 + id.len());
    f.extend_from_slice(&at.to_le_bytes());
    f.extend_from_slice(&entropy.to_le_bytes());
    f.push(mode);
    f.extend_from_slice(&x.to_le_bytes());
    f.extend_from_slice(&y.to_le_bytes());
    f.extend_from_slice(id.as_bytes());
    f
}

/// A counter standing in for the host's CSPRNG: deterministic, so these tests
/// are (invariant 9 binds the module, never the host), and distinct per call,
/// which is what a real host guarantees.
fn fresh() -> u128 {
    use std::sync::atomic::{AtomicU64, Ordering};
    static N: AtomicU64 = AtomicU64::new(0);
    ENTROPY + u128::from(N.fetch_add(1, Ordering::Relaxed) + 1) * 0x1_0000_0000
}

fn place(shell: &mut Shell, id: &str, x: i32, y: i32, at: u64) -> Result<(), String> {
    outcome(shell.handle(OP_PLACE, &frame(1, x, y, id, at, fresh())))
}

fn free(shell: &mut Shell, id: &str, at: u64) -> Result<(), String> {
    outcome(shell.handle(OP_PLACE, &frame(0, 0, 0, id, at, fresh())))
}

fn outcome(reply: Vec<u8>) -> Result<(), String> {
    match decode_reply(&reply).expect("a well-formed reply") {
        ReplyView::FaceRows(_) => Ok(()),
        ReplyView::Error(e) => Err(format!("code {} · {}", e.code, e.detail)),
        other => panic!("expected FaceRows or Error, got {other:?}"),
    }
}

/// The whole feature in one assertion: a placement moves the box it names to the
/// coordinate it carries, marks it, and moves nothing else.
///
/// "Moves nothing else" is the property `56` §3.5 spends a table row on — *"I
/// moved one box and the whole picture rearranged"* — and it holds here by
/// construction rather than by care: the rank walk, the crossing reduction and
/// the row assignment all run untouched and the override is applied after them.
#[test]
fn one_placement_moves_one_box_and_marks_it() {
    let mut shell = loaded();
    let before = draw(&mut shell);
    let subject = before.first().expect("something was drawn").clone();
    assert!(!subject.placed, "a fresh paste places nothing by hand");

    place(&mut shell, &subject.id, 640, 480, TS).expect("the placement is accepted");
    let after = draw(&mut shell);

    let moved = after
        .iter()
        .find(|b| b.id == subject.id)
        .expect("the box is still drawn");
    assert_eq!((moved.x, moved.y), (640, 480), "it went where it was put");
    assert!(moved.placed, "and it says it was placed by hand");

    for b in &before {
        if b.id == subject.id {
            continue;
        }
        let now = after
            .iter()
            .find(|o| o.id == b.id)
            .expect("every other box is still drawn");
        assert_eq!(
            (now.x, now.y),
            (b.x, b.y),
            "{} moved when {} was placed",
            b.id,
            subject.id
        );
        assert!(
            !now.placed,
            "{} was marked placed and nobody placed it",
            b.id
        );
    }
}

/// `56` §3.5's 4 px grid, applied in the core so every host agrees. The page
/// sends whatever the pointer produced; the module rounds it.
///
/// **Asserted RELATIVE to an unplaced box, not against the drawn coordinate.**
/// Snapping is a fact about the stored position; where that position ends up on
/// the canvas is a separate question, because a placement at a negative
/// coordinate translates the whole picture so that every box stays inside the
/// canvas (see `every_box_is_inside_the_canvas_however_far_it_is_dragged` and
/// `lay_out`'s extent block). Before that translation existed the two questions
/// had the same answer and this test could conflate them; it can no longer, and
/// the delta between two boxes is the quantity that is invariant under a
/// translation and therefore the one that actually pins the grid.
#[test]
fn a_position_lands_on_the_four_pixel_grid() {
    let mut shell = loaded();
    let boxes = draw(&mut shell);
    let id = boxes.first().expect("a box").id.clone();
    let anchor_id = boxes
        .iter()
        .find(|b| b.id != id)
        .expect("a second box to measure against")
        .id
        .clone();

    let mut seen: Vec<(i32, (i32, i32))> = Vec::new();
    for (sent, want) in [(1, 0), (2, 4), (3, 4), (-1, 0), (-2, 0), (-3, -4), (-6, -4)] {
        place(&mut shell, &id, sent, sent, TS).expect("accepted");
        let drawn = draw(&mut shell);
        let b = drawn.iter().find(|b| b.id == id).expect("drawn");
        let anchor = drawn
            .iter()
            .find(|b| b.id == anchor_id)
            .expect("the anchor is still drawn");
        seen.push((want, (b.x - anchor.x, b.y - anchor.y)));
    }

    // Two inputs that snap to the same value must sit at the same offset, and
    // inputs that snap to different values must differ by exactly that
    // difference. Together those two properties are the grid.
    for (wa, oa) in &seen {
        for (wb, ob) in &seen {
            assert_eq!(
                (oa.0 - ob.0, oa.1 - ob.1),
                (wa - wb, wa - wb),
                "snapped {wa} and {wb} are {} and {} apart on the canvas",
                oa.0 - ob.0,
                oa.1 - ob.1
            );
        }
    }
}

/// Moving a placed box is a SUPERSESSION, not a second pin.
///
/// `HasLayoutPin` is `out: "0..1"`, so a second pin would be refused by the
/// store — which is the point. The visible half is that the box ends up at the
/// second position and not the first, and that the estate holds one pin.
#[test]
fn moving_a_placed_box_supersedes_rather_than_pinning_twice() {
    let mut shell = loaded();
    let id = draw(&mut shell).first().expect("a box").id.clone();
    place(&mut shell, &id, 100, 100, TS).expect("first placement");
    place(&mut shell, &id, 300, 200, TS + 1).expect("second placement");
    let b = draw(&mut shell)
        .into_iter()
        .find(|b| b.id == id)
        .expect("drawn");
    assert_eq!((b.x, b.y), (300, 200), "the second placement wins");
    assert!(b.placed);
}

/// Two placements in the SAME MILLISECOND, with the fresh entropy a real host
/// supplies. Dragging is a stream of gestures and this is ordinary, not exotic.
///
/// It is the exact shape of the bug the clock-plus-discriminator id pattern
/// produced in `OP_FIELD_SET`: `Ulid::from_parts(at.0, 2)` ignores the entropy
/// entirely, so two ops in one millisecond mint the same `BatchId` **however
/// good the host's randomness is**, and the store refuses the second as reused.
/// `place` takes its batch and provenance off the `Mint`, which walks a counter
/// from the entropy, so this passes — and it would fail on the pattern the paste
/// path still uses, where a fresh graph makes the collision unreachable.
#[test]
fn two_placements_in_one_millisecond_both_land() {
    let mut shell = loaded();
    let boxes = draw(&mut shell);
    let a = boxes.first().expect("a box").id.clone();
    let b = boxes.get(1).expect("a second box").id.clone();
    place(&mut shell, &a, 500, 40, TS).expect("the first placement");
    place(&mut shell, &b, 500, 200, TS).expect("the second placement in the same ms");
    let after = draw(&mut shell);
    assert!(after.iter().any(|x| x.id == a && x.placed && x.x == 500));
    assert!(after.iter().any(|x| x.id == b && x.placed && x.y == 200));
}

/// Putting it back under computed layout, and the fact that pressing it twice is
/// not an error. The end state is what the action promises, and an operator who
/// presses it again has not made a mistake.
#[test]
fn releasing_restores_the_computed_position_and_is_idempotent() {
    let mut shell = loaded();
    let before = draw(&mut shell);
    let subject = before.first().expect("a box").clone();

    place(&mut shell, &subject.id, 900, 900, TS).expect("placed");
    free(&mut shell, &subject.id, TS + 1).expect("released");
    let after = draw(&mut shell);
    assert_eq!(after, before, "the whole picture is back where it started");

    free(&mut shell, &subject.id, TS + 2).expect("releasing an unplaced box is not an error");
    assert_eq!(draw(&mut shell), before, "and it changed nothing");
}

/// The canvas grows to hold a box dragged past the grid, or the page draws it
/// into a viewBox that does not know it moved and the operator loses it.
#[test]
fn the_canvas_grows_to_hold_a_box_dragged_outside_it() {
    let mut shell = loaded();
    let id = draw(&mut shell).first().expect("a box").id.clone();
    let extent = |s: &mut Shell| -> (i32, i32) {
        let mut req = vec![0b0001_1111u8];
        req.extend_from_slice(b"*");
        match decode_reply(&s.handle(OP_DIAGRAM, &req)).expect("a reply") {
            ReplyView::FaceRows(rows) => {
                let c = rows.iter().find(|r| r.role == 11).expect("the canvas row");
                (
                    c.strings[0].parse().expect("width"),
                    c.strings[1].parse().expect("height"),
                )
            }
            other => panic!("{other:?}"),
        }
    };
    let (w0, h0) = extent(&mut shell);
    place(&mut shell, &id, w0 + 400, h0 + 300, TS).expect("placed well outside");
    let (w1, h1) = extent(&mut shell);
    assert!(w1 > w0 && h1 > h0, "{w0}x{h0} did not grow to hold the box");
    assert!(w1 >= w0 + 400 && h1 >= h0 + 300, "{w1}x{h1} is too small");
}

/// **AND THE OTHER DIRECTION, WHICH IS THE ONE THAT WAS BROKEN.**
///
/// The test above probes `(w0 + 400, h0 + 300)` — right and down — and passed
/// while a box dragged LEFT or UP was drawn outside the canvas entirely, could
/// not be brought back by `z`, and survived an export and an import as a stored
/// fact the picture refused to show. Worse than the clamp `schema.yaml` rejected
/// on the grounds that a clamp is invisible: this was invisible AND lossy.
///
/// One ordinary leftward drag reaches it. A rank-0 box sits at `x = MARGIN`,
/// which is 24.
///
/// The property asserted is not "the canvas grew" — a translation does not grow
/// it in that direction — but the one that actually matters: **every box lies
/// inside the canvas.** That holds for both signs and for a box that is dragged
/// out on one axis and not the other, which is the case a pair of one-axis
/// tests would miss between them.
#[test]
fn every_box_is_inside_the_canvas_however_far_it_is_dragged() {
    for (dx, dy) in [
        (-900i32, -700i32),
        (-900, 700),
        (900, -700),
        (-4000, 0),
        (0, -4000),
    ] {
        let mut shell = loaded();
        let id = draw(&mut shell).first().expect("a box").id.clone();
        place(&mut shell, &id, dx, dy, TS).expect("placed outside the grid");

        let mut req = vec![0b0001_1111u8];
        req.extend_from_slice(b"*");
        let rows = match decode_reply(&shell.handle(OP_DIAGRAM, &req)).expect("a reply") {
            ReplyView::FaceRows(rows) => rows,
            other => panic!("{other:?}"),
        };
        let canvas = rows.iter().find(|r| r.role == 11).expect("the canvas row");
        let (w, h): (i32, i32) = (
            canvas.strings[0].parse().expect("width"),
            canvas.strings[1].parse().expect("height"),
        );
        for r in rows.iter().filter(|r| r.role == 9) {
            let p = |i: usize| -> i32 { r.strings[i].parse().expect("a coordinate") };
            let (x, y, bw, bh) = (p(3), p(4), p(5), p(6));
            assert!(
                x >= 0 && y >= 0 && x + bw <= w && y + bh <= h,
                "placed at ({dx},{dy}): box `{}` at {x},{y} {bw}x{bh} is outside \
                 the {w}x{h} canvas, so the picture cannot draw a placement the \
                 record still holds",
                r.strings[2]
            );
        }
    }
}

/// Refusals. Every one of these leaves the estate exactly as it was — a page
/// defect must not become a half-written record.
#[test]
fn a_bad_placement_is_refused_and_changes_nothing() {
    let mut shell = loaded();
    let before = draw(&mut shell);

    let short = shell.handle(OP_PLACE, &[0u8; 20]);
    assert!(outcome(short).is_err(), "a truncated frame is refused");

    let unknown = place(&mut shell, "device:NOTAREALULID0000000000", 8, 8, TS);
    assert!(unknown.is_err(), "an id naming nothing is refused");

    // A group key is not an element id, and `59`'s aggregation produces them.
    let group = place(&mut shell, "agg:logical-unit:01M0#6", 8, 8, TS);
    assert!(group.is_err(), "a group key is refused");

    assert_eq!(draw(&mut shell), before, "a refusal moved something");
}

/// Placing before anything is loaded. The page cannot reach this — the diagram
/// view is a placeholder until an estate exists — but a frame is a frame and the
/// module answers rather than panicking.
#[test]
fn placing_with_no_estate_is_a_typed_refusal() {
    let mut shell = common::booted_shell();
    assert!(place(&mut shell, "device:01M0", 8, 8, TS).is_err());
}
