//! `OP_DIAGRAM`'s mask byte, at the wire.
//!
//! The page's decoder is hand-authored JavaScript that no compiler checks, so
//! every byte it will read is pinned on this side. These tests are the wire
//! contract for `56` §4's layer toggles: what one byte means, what zero bytes
//! mean, what a bad byte gets back, and — the one that matters — that no mask
//! moves a box.

use fathom_wasm::protocol::{
    decode_reply, ErrorView, FaceRowView, ReplyView, ERR_BAD_FRAME, ERR_NOT_INITIALISED, FACE_BOX,
    FACE_CANVAS, FACE_LINE,
};
use fathom_wasm::shell::Shell;
use fathom_wasm::{OP_DIAGRAM, OP_ESTATE_DEMO};

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
    assert!(s.handle(OP_ESTATE_DEMO, &[]).is_empty());
    s
}

struct Picture {
    canvas: FaceRowView,
    boxes: Vec<FaceRowView>,
    lines: Vec<FaceRowView>,
}

fn picture(shell: &mut Shell, req: &[u8]) -> Picture {
    let rows = face(&shell.handle(OP_DIAGRAM, req));
    let canvas = rows
        .iter()
        .find(|r| r.role == FACE_CANVAS)
        .expect("one canvas row")
        .clone();
    Picture {
        boxes: rows
            .iter()
            .filter(|r| r.role == FACE_BOX)
            .cloned()
            .collect(),
        lines: rows
            .iter()
            .filter(|r| r.role == FACE_LINE)
            .cloned()
            .collect(),
        canvas,
    }
}

/// **`56` §3.6 at the wire.** Over all 31 non-empty masks the canvas is
/// byte-identical and every surviving box keeps its four coordinates. A page
/// that redraws on a toggle therefore paints the same viewBox and the same
/// geometry, which is the whole property.
#[test]
fn no_mask_moves_a_box_or_changes_the_canvas() {
    let mut shell = loaded();
    let all = picture(&mut shell, &[0b0001_1111]);

    for bits in 1u8..=0b0001_1111 {
        let p = picture(&mut shell, &[bits]);
        assert_eq!(
            (p.canvas.strings[0].as_str(), p.canvas.strings[1].as_str()),
            (
                all.canvas.strings[0].as_str(),
                all.canvas.strings[1].as_str()
            ),
            "mask {bits:05b} changed the canvas"
        );
        for b in &p.boxes {
            let was = all
                .boxes
                .iter()
                .find(|x| x.strings[0] == b.strings[0])
                .expect("a masked box that the all-layers picture does not have");
            assert_eq!(
                b.strings, was.strings,
                "mask {bits:05b} moved {}",
                b.strings[2]
            );
        }
    }
}

/// The reply says which mask produced it, and how much it hid. A picture and
/// its toggles cannot disagree if the picture carries the answer.
#[test]
fn the_canvas_row_reports_the_mask_and_what_it_hid() {
    let mut shell = loaded();

    let all = picture(&mut shell, &[0b0001_1111]);
    assert_eq!(all.canvas.slot_count, 6, "a masked reply carries six slots");
    assert_eq!(all.canvas.strings[2], "31", "the mask travels as a decimal");

    let phy = picture(&mut shell, &[0b0000_0001]);
    assert_eq!(phy.canvas.strings[2], "1");
    let hidden: usize = phy.canvas.strings[3].parse().expect("a decimal count");
    assert_eq!(
        hidden + phy.boxes.len(),
        all.boxes.len()
            + all.canvas.strings[3]
                .parse::<usize>()
                .expect("a decimal count"),
        "hidden + drawn must account for every box in the union layout"
    );
    assert!(
        phy.boxes.len() < all.boxes.len(),
        "the physical layer alone must draw less than all five"
    );
    assert!(hidden > 0, "and it must say so");
}

/// No mask at all is the union scene, unprojected — the request every caller
/// made before layers existed, answered exactly as before.
#[test]
fn no_mask_byte_is_the_unprojected_union() {
    let mut shell = loaded();
    let bare = picture(&mut shell, &[]);
    assert_eq!(bare.canvas.slot_count, 2, "no mask, no mask slots");
    assert_eq!(
        bare.canvas.strings[2], "",
        "slot 2 empty means no layer projection"
    );

    // All five bits is a projection through 56 §4.1 and is a DIFFERENT request:
    // that table draws AddressObject and Application nowhere. The two replies
    // may therefore differ, and the unprojected one is never the smaller.
    let all = picture(&mut shell, &[0b0001_1111]);
    assert!(all.boxes.len() <= bare.boxes.len());
}

/// All five toggles off draws nothing, keeps the canvas, and is not an error.
/// The page must be able to reach that state; a refusal would make it the
/// page's job to prevent it.
#[test]
fn the_empty_mask_is_legal_and_draws_nothing() {
    let mut shell = loaded();
    let none = picture(&mut shell, &[0]);
    assert!(none.boxes.is_empty() && none.lines.is_empty());
    assert_eq!(none.canvas.strings[2], "0");

    let all = picture(&mut shell, &[0b0001_1111]);
    assert_eq!(
        (
            none.canvas.strings[0].as_str(),
            none.canvas.strings[1].as_str()
        ),
        (
            all.canvas.strings[0].as_str(),
            all.canvas.strings[1].as_str()
        ),
        "an empty mask still keeps the union's extent"
    );
    assert_eq!(none.canvas.strings[3], all.boxes.len().to_string());
}

/// A bit that is not a layer is refused by number rather than masked off. A
/// page sending 0xFF has a defect, and a picture that quietly disagreed with
/// its own toggles would hide it.
#[test]
fn a_bit_above_the_five_is_refused() {
    let mut shell = loaded();
    for bad in [0b0010_0000u8, 0b0100_0000, 0xFF] {
        let e = error(&shell.handle(OP_DIAGRAM, &[bad]));
        assert_eq!(e.code, ERR_BAD_FRAME, "{bad:#010b}");
        assert!(e.detail.contains("layer mask"), "{}", e.detail);
    }
    let e = error(&shell.handle(OP_DIAGRAM, &[1, 2]));
    assert_eq!(e.code, ERR_BAD_FRAME);

    let e = error(&Shell::new().handle(OP_DIAGRAM, &[0b0001_1111]));
    assert_eq!(e.code, ERR_NOT_INITIALISED, "a mask is not an estate");
}

/// Invariant 9 at the wire: the same mask twice is the same bytes.
#[test]
fn the_same_mask_encodes_identically() {
    let mut shell = loaded();
    for bits in 0u8..=0b0001_1111 {
        assert_eq!(
            shell.handle(OP_DIAGRAM, &[bits]),
            shell.handle(OP_DIAGRAM, &[bits]),
            "mask {bits:05b} encoded two ways"
        );
    }
}
