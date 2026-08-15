//! The finder's required chrome, asserted against the bytes the page reads.
//!
//! Turning the finder on ships 98 command entries into a browser, and every one
//! of them carries `reviewed_by: <named human>` — a placeholder, not a person.
//! ADR-0027 §2 settles what to do about that and this file is the enforcement:
//!
//! > *"An entry that has not been run ships with `verified_against: null` and
//! > renders as **unverified** in the UI, in the margin-tab register, on every
//! > result. It is not withheld — withholding is worse — it is labelled."*
//!
//! So the tests below are not about encoding. They are about whether a reply
//! can reach the page **without** the label. Each one closes a route by which
//! the corpus's unreviewed state could become invisible: a row with an empty
//! stamp, a flag that disagrees with the stamp, a summary with no corpus line,
//! or a caption composed in the page instead of read from the entry.

use std::path::{Path, PathBuf};

use fathom_corpus::{CorpusIndex, Section, SourceFile};
use fathom_wasm::protocol::{
    decode_reply, review_line, FinderRowView, ReplyView, ROLE_BELOW, ROLE_SHOWN, ROLE_SUMMARY,
    ROW_UNVERIFIED,
};
use fathom_wasm::shell::Shell;
use fathom_wasm::{OP_INIT, OP_QUERY};

fn workspace_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")
}

/// The same frame the assembler splices — this test lives in the assembler's
/// crate precisely so it can call the shipping path rather than a copy of it.
/// A re-listed corpus here would let the tested frame and the shipped one
/// drift, which is the one thing this file cannot afford to allow.
fn frame(root: &Path) -> Vec<u8> {
    fathom_artifact::corpus::frame(root).expect("the shipped corpus packs and loads")
}

fn booted() -> Shell {
    let mut shell = Shell::new();
    let reply = shell.handle(OP_INIT, &frame(&workspace_root()));
    assert!(
        reply.is_empty(),
        "OP_INIT with the shipped frame succeeds; got {:?}",
        decode_reply(&reply)
    );
    shell
}

fn rows(shell: &mut Shell, query: &str) -> Vec<FinderRowView> {
    match decode_reply(&shell.handle(OP_QUERY, query.as_bytes())).expect("a reply decodes") {
        ReplyView::FinderRows(r) => r,
        other => panic!("expected finder rows for {query:?}, got {other:?}"),
    }
}

/// The route the page takes: the frame the artifact ships really does drive the
/// finder, and the three queries a prior verifier ran still answer.
///
/// The pinned numbers are **record** counts, which is what that verifier
/// reported — one summary record plus the result rows. Measured 2026-08-15 on
/// the shipped corpus: `ipsec` 1 + 21 shown + 5 below, `show security ike`
/// 1 + 25 + 5, `vpn` 1 + 21 + 5. The composition is asserted alongside the
/// total, because a change that moved five rows from `shown` to `below` would
/// leave the total alone and change what the page draws.
#[test]
fn the_shipped_frame_answers_the_three_queries() {
    let mut shell = booted();
    for (query, records, shown, below) in [
        ("ipsec", 27, 21, 5),
        ("show security ike", 31, 25, 5),
        ("vpn", 27, 21, 5),
    ] {
        let hits = rows(&mut shell, query);
        assert_eq!(hits.len(), records, "{query}: records through the frame");
        assert_eq!(
            hits[0].role, ROLE_SUMMARY,
            "{query}: record 0 is the summary"
        );
        assert_eq!(
            hits.iter().filter(|r| r.role == ROLE_SHOWN).count(),
            shown,
            "{query}: rows above the cutoff"
        );
        assert_eq!(
            hits.iter().filter(|r| r.role == ROLE_BELOW).count(),
            below,
            "{query}: near misses (16 §19.5)"
        );
    }
}

/// ADR-0027 §3: the stamp is chrome, on **every** result row. A row with an
/// empty stamp slot is a row the page would render bare, and a bare row reads
/// as a verified one — that being the whole reason the ADR exists.
#[test]
fn every_result_row_carries_a_verification_stamp() {
    let mut shell = booted();
    for query in ["ipsec", "show security ike", "vpn", "clear", "mtu"] {
        for r in rows(&mut shell, query) {
            if r.role != ROLE_SHOWN && r.role != ROLE_BELOW {
                continue;
            }
            assert!(
                !r.strings[5].is_empty(),
                "{query}: {} has an empty stamp slot",
                r.strings[1]
            );
            assert!(
                r.strings[5].starts_with("junos-srx"),
                "{query}: {} names its platform: {:?}",
                r.strings[1],
                r.strings[5]
            );
        }
    }
}

/// The whole seed corpus is unreviewed, so the flag and the stamp must both say
/// so on every row — and must say the *same* thing. A flag that disagreed with
/// the text is worse than either alone: the page styles from the flag and the
/// reader reads the text.
#[test]
fn the_unverified_flag_and_the_stamp_agree() {
    let mut shell = booted();
    let mut checked = 0;
    for query in [
        "ipsec",
        "show security ike",
        "vpn",
        "commit",
        "traceoptions",
    ] {
        for r in rows(&mut shell, query) {
            if r.role != ROLE_SHOWN && r.role != ROLE_BELOW {
                continue;
            }
            let flagged = r.flags & ROW_UNVERIFIED != 0;
            let said = r.strings[5].contains("unverified");
            assert_eq!(
                flagged, said,
                "{}: flag says {flagged}, stamp says {:?}",
                r.strings[1], r.strings[5]
            );
            assert!(
                flagged,
                "{}: the seed corpus has no reviewed entry; this row claims one",
                r.strings[1]
            );
            checked += 1;
        }
    }
    assert!(
        checked > 50,
        "the sweep saw {checked} rows, which is too few"
    );
}

/// The corpus-level line rides the summary record, so there is no ordering in
/// which the page has rows on screen and does not have the count.
#[test]
fn the_summary_carries_the_corpus_review_line() {
    let mut shell = booted();
    let hits = rows(&mut shell, "ipsec");
    let line = &hits[0].strings[5];
    assert!(
        line.contains("98 of 98") && line.contains("unverified"),
        "the summary's review line reads {line:?}"
    );

    // And it is a count, not a sentence: a reviewed corpus must stop sounding
    // the alarm, or nobody will believe it when it does.
    let mut reviewed = sources();
    for f in reviewed.iter_mut() {
        if f.section == Section::Commands {
            f.source = f.source.replace("<named human>", "K. Okafor");
        }
    }
    let index = CorpusIndex::from_sources(&reviewed).expect("the edited corpus still loads");
    let line = review_line(&index);
    assert!(
        !line.contains("unverified") && line.contains("every one reviewed"),
        "with every entry reviewed the line reads {line:?}"
    );
}

/// ADR-0011: the caption may be overridden per entry. The seed corpus contains
/// exactly one override, and it is the reason the caption is sent rather than
/// held in the page as an array of three.
#[test]
fn the_risk_caption_is_the_entrys_own() {
    let mut shell = booted();
    let mut seen_override = false;
    let mut seen_default = false;
    for query in ["clear security ike", "commit", "ipsec", "request"] {
        for r in rows(&mut shell, query) {
            if r.role != ROLE_SHOWN && r.role != ROLE_BELOW {
                continue;
            }
            assert!(!r.strings[6].is_empty(), "{}: no caption", r.strings[1]);
            if r.strings[6] == "CHANGES STATE — NOT REVERSIBLE BY COMMIT" {
                seen_override = true;
            }
            if r.strings[6] == "READ-ONLY — SAFE ON PRODUCTION" {
                seen_default = true;
            }
        }
    }
    assert!(seen_default, "no row carried a default caption");
    assert!(
        seen_override,
        "the corpus's one risk_caption_override never reached a row"
    );
}

fn sources() -> Vec<SourceFile> {
    fathom_artifact::corpus::sources(&workspace_root()).expect("the corpus lists")
}
