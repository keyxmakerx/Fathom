//! **A same-build round trip is not a drift** — through the wire, the way the
//! page replays a saved paste (2026-09-05).
//!
//! `importJournal` pastes the redacted capture back through `OP_PASTE`, and
//! the page reads the summary row's fourth slot as *secrets removed*. It was
//! `drops.entries.len()`, and over the fixture's own redacted capture that is
//! 7 where the paste said 8 (`fathom-ingest/tests/round_trip.rs` says which
//! and why), so the page reported drift on a file nothing had touched. The
//! slot is now what the run DESTROYED: 8 on the raw paste, 0 on its own
//! output, and exactly the number of plaintext values the saved text still
//! held when the gate has learned since.
//!
//! Red on 0733288 (`"7"` in the second slot); green after.

mod common;

use fathom_wasm::protocol::{decode_reply, FaceRowView, ReplyView, FACE_CAPTURE, FACE_SHAPE};
use fathom_wasm::OP_PASTE;

/// 2026-08-08T00:00:00Z, a stored value like every timestamp in this tree.
const TS: u64 = 1_786_147_200_000;
const ENTROPY: u128 = 0x0000_0000_0000_0000_2026;
const PSK_LITERAL: &str = "\"$9$EXAMPLEnotARealKey01234\"";

/// A paste frame with the CONFIRM byte set, as every replayed paste carries it.
fn frame(text: &[u8]) -> Vec<u8> {
    let mut f = Vec::with_capacity(25 + text.len());
    f.extend_from_slice(&TS.to_le_bytes());
    f.extend_from_slice(&ENTROPY.to_le_bytes());
    f.push(1);
    f.extend_from_slice(text);
    f
}

fn face(reply: &[u8]) -> Vec<FaceRowView> {
    match decode_reply(reply).expect("a well-formed reply") {
        ReplyView::FaceRows(rows) => rows,
        other => panic!("expected FaceRows, got {other:?}"),
    }
}

struct Pasted {
    /// nodes · edges · residue · secrets · unresolved.
    summary: [String; 5],
    capture: String,
    shape: String,
}

/// One paste into a fresh shell — the same starting point `wasmReset` gives
/// an import.
fn paste(text: &[u8]) -> Pasted {
    let mut shell = common::booted_shell();
    let rows = face(&shell.handle(OP_PASTE, &frame(text)));
    let s = &rows[0].strings;
    let slot = |role: u8| -> String {
        rows.iter()
            .find(|r| r.role == role)
            .unwrap_or_else(|| panic!("no row with role {role}"))
            .strings[0]
            .clone()
    };
    Pasted {
        summary: [
            s[0].clone(),
            s[1].clone(),
            s[2].clone(),
            s[3].clone(),
            s[4].clone(),
        ],
        capture: slot(FACE_CAPTURE),
        shape: slot(FACE_SHAPE),
    }
}

fn fixture() -> Vec<u8> {
    std::fs::read(
        common::repo_root()
            .join("crates/fathom-ingest/tests/fixtures/junos-srx-branch-documented.txt"),
    )
    .expect("the branch fixture is checked in")
}

#[test]
fn replaying_a_pastes_own_capture_reports_zero_secrets_and_the_same_estate() {
    let first = paste(&fixture());
    assert_eq!(
        first.summary[3], "8",
        "the paste's own count moved: {:?}",
        first.summary
    );

    let replay = paste(first.capture.as_bytes());
    assert_eq!(
        replay.shape, first.shape,
        "the digest must not move on a round trip"
    );
    assert_eq!(replay.summary[0], first.summary[0], "nodes");
    assert_eq!(replay.summary[1], first.summary[1], "edges");
    assert_eq!(replay.summary[2], first.summary[2], "residue");
    assert_eq!(replay.summary[4], first.summary[4], "unresolved");
    assert_eq!(
        replay.capture, first.capture,
        "the capture is a fixed point"
    );
    assert_eq!(
        replay.summary[3], "0",
        "a replay of redacted text destroyed nothing, and the wire must say so"
    );
}

/// The PSK put back by hand: the slot was a self-writing marker and is now
/// the one real destruction, so the OLD slot read "7" here too — the same as
/// a clean round trip — and the page could not tell the two files apart.
#[test]
fn a_credential_the_saved_file_still_holds_is_counted_on_the_replay() {
    let first = paste(&fixture());
    let leaked = first.capture.replacen("<REDACTED:psk>", PSK_LITERAL, 1);
    assert_ne!(leaked, first.capture);

    let replay = paste(leaked.as_bytes());
    assert_eq!(
        replay.shape, first.shape,
        "a placeholder is a placeholder either way"
    );
    assert_eq!(replay.summary[3], "1", "{:?}", replay.summary);
    assert_eq!(
        replay.capture, first.capture,
        "and the export from here is clean again"
    );
}

/// A shape-caught value on a residue line: nothing else moves, and the OLD
/// slot read "8" here — equal to the paste's own — so the page said nothing
/// over a file holding a credential. This is the blind case.
#[test]
fn a_value_on_a_residue_line_is_counted_where_the_old_count_was_equal() {
    let first = paste(&fixture());
    let target = "set applications application ssh-alt protocol tcp";
    let blob = "QUJDREVGR0hJSktMTU5PUFFSU1RVVg==";
    let leaked = first
        .capture
        .replacen(target, &format!("{target} {blob}"), 1);
    assert_ne!(leaked, first.capture);

    let replay = paste(leaked.as_bytes());
    assert_eq!(replay.shape, first.shape, "an unmapped line binds nothing");
    assert_eq!(
        replay.summary[2], first.summary[2],
        "still residue, still one line"
    );
    assert_eq!(replay.summary[3], "1", "{:?}", replay.summary);
    assert!(!replay.capture.contains(blob));
}
