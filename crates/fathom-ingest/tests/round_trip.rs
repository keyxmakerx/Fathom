//! **A second pass over the gate's own output destroys nothing, and the tally
//! must say so** (2026-09-05).
//!
//! A journalled paste stores the REDACTED capture and a replay runs `ingest`
//! over it again. The page compared the drop count of the two runs and, on a
//! same-build export → import of `junos-srx-branch-documented.txt`, told the
//! operator his own file had drifted: 8 at the paste, 7 on the replay. Both
//! numbers were `drops.entries.len()` — a count of gate EDITS, of which a
//! replay makes one per marker (each written over itself) minus one piece of
//! collateral that fires only on the raw text. `DropManifest::destroyed` is
//! the count that is honest on both texts, and this file pins every clause of
//! the account in its doc comment.
//!
//! Nothing here asserts a redaction the gate did not already make. The union
//! rule (`38` §14) is untouched: the capture bytes are asserted identical
//! across the two passes, so what is destroyed has not moved by a byte.

use std::path::{Path, PathBuf};

use fathom_ingest::dict::Dictionary;
use fathom_ingest::redact::RedactLabel;
use fathom_ingest::{ingest, IngestOutput};

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .nth(2)
        .expect("the crate lives two levels under the repo root")
        .to_path_buf()
}

fn dict() -> Dictionary {
    Dictionary::load(&repo_root()).expect("the shipped dictionary loads")
}

fn fixture_text() -> Vec<u8> {
    std::fs::read(
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures/junos-srx-branch-documented.txt"),
    )
    .expect("the branch fixture is checked in")
}

fn run(text: &[u8]) -> IngestOutput {
    ingest(text, &dict()).expect("within the caps")
}

/// The line the fixture's 8th edit sits on, 1-based as an operator reads it.
const COMMUNITY_LINE: u32 = 14;
/// The fixture's PSK, quotes included, exactly as line 112 carries it.
const PSK_LITERAL: &str = "\"$9$EXAMPLEnotARealKey01234\"";

/// On a raw paste the two counts agree — raw text carries no marker to write
/// over. On the gate's own output `destroyed()` is zero while `entries` still
/// holds one self-write per marker, and the capture has not moved by a byte.
#[test]
fn a_second_pass_over_the_gates_own_output_destroys_nothing() {
    let first = run(&fixture_text());
    assert_eq!(
        first.drops.entries.len(),
        8,
        "the fixture's edit count moved"
    );
    assert_eq!(
        first.drops.destroyed(),
        first.drops.entries.len(),
        "a raw paste has no marker to write over, so every edit destroys"
    );
    assert!(first.drops.entries.iter().all(|e| !e.unchanged));

    let second = run(first.capture.text().as_bytes());
    assert_eq!(
        second.capture.text(),
        first.capture.text(),
        "the gate's output is a fixed point of the gate"
    );
    assert_eq!(second.residue.len(), first.residue.len());
    assert_eq!(
        second.drops.destroyed(),
        0,
        "the replay destroyed something in text the gate had already cleaned: {:?}",
        second.drops.entries
    );
    // The mechanism, pinned so the number is understood and not merely
    // observed: seven markers re-fire (the gate does not recognise its own
    // marker as a pre-redaction — `redact::pre_redacted`'s doc comment says
    // why that is left alone) and the eighth slot, collateral on line 14,
    // does not.
    assert_eq!(second.drops.entries.len(), 7);
    assert!(second.drops.entries.iter().all(|e| e.unchanged));
    assert!(second.drops.already_redacted.is_empty());
}

/// WHICH edit does not re-fire, and WHY. `set snmp community
/// EXAMPLE-READ-ONLY-COMMUNITY authorization read-only` yields three edits on
/// raw text: the community itself, then `authorization` and `read-only` as
/// `Unknown` collateral from `raw_walk`'s two-token lookback — and `read-only`
/// only because the synthetic VALUE carries the component `community`. Once
/// the value is `<REDACTED:snmp-community>` that slot does not fire; its
/// marker is already there, so nothing is lost.
#[test]
fn the_eighth_edit_is_collateral_behind_a_value_that_names_a_secret_word() {
    let first = run(&fixture_text());
    let on_line = |out: &IngestOutput| -> Vec<RedactLabel> {
        out.drops
            .entries
            .iter()
            .filter(|e| e.ordinal.0 + 1 == COMMUNITY_LINE)
            .map(|e| e.label)
            .collect()
    };
    assert_eq!(
        on_line(&first),
        [
            RedactLabel::SnmpCommunity,
            RedactLabel::Unknown,
            RedactLabel::Unknown
        ]
    );
    let redacted_line = first
        .capture
        .text()
        .lines()
        .nth(COMMUNITY_LINE as usize - 1)
        .expect("line 14 is in the capture");
    assert_eq!(
        redacted_line,
        "set snmp community <REDACTED:snmp-community> <REDACTED:unknown> <REDACTED:unknown>"
    );

    let second = run(first.capture.text().as_bytes());
    assert_eq!(
        on_line(&second),
        [RedactLabel::SnmpCommunity, RedactLabel::Unknown],
        "the collateral slot re-fired, or a marker stopped re-firing — either way the \
         account in DropManifest::destroyed is out of date"
    );
    assert_eq!(
        second
            .capture
            .text()
            .lines()
            .nth(COMMUNITY_LINE as usize - 1)
            .expect("line 14 is in the capture"),
        redacted_line,
        "the slot that did not re-fire still holds its marker"
    );

    // The same statement with a value that does NOT carry a secret word as a
    // component destroys two tokens, not three — the difference IS the value.
    let with = run(b"set snmp community EXAMPLE-READ-ONLY-COMMUNITY authorization read-only\n");
    let without = run(b"set snmp community EXAMPLE-READ-ONLY authorization read-only\n");
    assert_eq!(with.drops.destroyed(), 3);
    assert_eq!(without.drops.destroyed(), 2);
    assert_eq!(
        without.capture.text().trim_end(),
        "set snmp community <REDACTED:snmp-community> <REDACTED:unknown> read-only"
    );
}

/// Put the PSK back into the saved capture by hand — byte for byte what a
/// file from a build that let it through would hold — and replay: the gate
/// destroys it and `destroyed()` says 1. `entries.len()` says 7, the SAME
/// number a clean round trip gives, because the PSK's slot was one of the
/// seven self-writing markers and is now the one real destruction. A page
/// comparing edit counts could not tell this file from a clean one: same
/// sentence, same numbers, over a file that holds a credential.
#[test]
fn a_credential_put_back_into_a_saved_capture_is_destroyed_and_counted_as_one() {
    let first = run(&fixture_text());
    let clean = first.capture.text().to_owned();
    assert!(!clean.contains(PSK_LITERAL));
    assert_eq!(clean.matches("<REDACTED:psk>").count(), 1);
    let leaked = clean.replacen("<REDACTED:psk>", PSK_LITERAL, 1);
    assert!(leaked.contains(PSK_LITERAL));

    let replay = run(leaked.as_bytes());
    assert_eq!(replay.drops.destroyed(), 1, "{:?}", replay.drops.entries);
    assert_eq!(
        replay.drops.entries.len(),
        run(clean.as_bytes()).drops.entries.len(),
        "the edit count is the SAME as a clean round trip's — which is why a count \
         comparison could not tell the two files apart"
    );
    assert_eq!(
        replay.capture.text(),
        clean,
        "destroying the leaked value gives back the clean capture"
    );
    let real = replay
        .drops
        .entries
        .iter()
        .filter(|e| !e.unchanged)
        .collect::<Vec<_>>();
    assert_eq!(real.len(), 1);
    assert_eq!(real[0].label, RedactLabel::Psk);
    assert_eq!(real[0].ordinal.0 + 1, 112);
}

/// The case the old comparison was BLIND to. A value the gate catches by
/// shape, sitting on a line the parser does not bind — what an older build
/// with one detector fewer would have left in the residue verbatim. The
/// digest does not move (an unmapped line binds nothing) and the residue
/// count does not move (it was residue either way); the only thing that
/// moves is one plaintext token becoming a marker. `entries.len()` reads
/// 7 + 1 = 8 — the paste's own number — so a count comparison said *no
/// change* over a file holding a credential. `destroyed()` reads 1.
#[test]
fn a_value_in_a_residue_line_that_todays_gate_catches_is_counted_where_a_count_diff_was_silent() {
    let first = run(&fixture_text());
    let clean = first.capture.text().to_owned();
    let target = "set applications application ssh-alt protocol tcp";
    assert_eq!(
        clean.matches(target).count(),
        1,
        "the residue line this test leans on moved"
    );
    let blob = "QUJDREVGR0hJSktMTU5PUFFSU1RVVg==";
    let leaked = clean.replacen(target, &format!("{target} {blob}"), 1);

    let replay = run(leaked.as_bytes());
    assert_eq!(
        replay.residue.len(),
        first.residue.len(),
        "still one residue line"
    );
    assert_eq!(
        replay.drops.entries.len(),
        first.drops.entries.len(),
        "edit counts EQUAL the paste's own — the silence the old check kept"
    );
    assert_eq!(replay.drops.destroyed(), 1, "{:?}", replay.drops.entries);
    assert!(
        !replay.capture.text().contains(blob),
        "the blob was destroyed"
    );
    assert!(replay
        .capture
        .text()
        .contains(&format!("{target} <REDACTED:unknown>")));
}
