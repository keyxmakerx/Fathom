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
//!
//! # What changed on 2026-08-15, and why two of these tests are inverted
//!
//! The ADR the file quotes keys `unverified` on a **bench run**, and the first
//! version of this file keyed it on `reviewed_by`. The two come apart on a
//! scheduled action: the named expert review of `corpus/` is on the owner's
//! blocking list, and completing it would have cleared the label on all 98
//! entries with none of them ever run on hardware. `is_unverified` now reads
//! `verified_on` (61 §3.1), and the two tests at the bottom of this file are
//! the canaries for that — one drives a corpus that HAS been run and requires
//! the label to come off, the other drives a corpus that has been reviewed and
//! requires the label to stay on. Both fail against the predicate they replaced.

use std::path::{Path, PathBuf};

use fathom_corpus::{CorpusIndex, Section, SourceFile};
use fathom_wasm::protocol::{
    decode_reply, pack_corpus, review_line, FinderRowView, ReplyView, ROLE_BELOW, ROLE_SHOWN,
    ROLE_SUMMARY, ROW_UNVERIFIED,
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
    boot_frame(&frame(&workspace_root()))
}

fn boot_frame(frame: &[u8]) -> Shell {
    let mut shell = Shell::new();
    let reply = shell.handle(OP_INIT, frame);
    assert!(
        reply.is_empty(),
        "OP_INIT succeeds; got {:?}",
        decode_reply(&reply)
    );
    shell
}

/// Boot a shell over the shipped corpus with the **command bundle** rewritten
/// by `edit`. The explainer and rule bundles are passed through untouched, so
/// the corpus still cross-references and still loads; only the entries the
/// finder ranks are altered.
///
/// This edits YAML text rather than constructing an `Entry` by hand on purpose:
/// the route under test is the loader's, and a hand-built `Entry` would skip
/// exactly the parsing step whose absence caused the defect these tests exist
/// for.
fn booted_with_commands(edit: impl Fn(&str) -> String) -> Shell {
    boot_frame(&pack_corpus(&edited_sources(&edit)))
}

fn edited_sources(edit: &impl Fn(&str) -> String) -> Vec<SourceFile> {
    let mut files = sources();
    for f in files.iter_mut() {
        if f.section == Section::Commands {
            f.source = edit(&f.source);
        }
    }
    files
}

/// Every entry in the seed bundle carries `reviewed_on: 2026-07-28` and no
/// `verified_on`. This inserts one — the shape 61 §3.1 declares, a flow table of
/// `{ platform, version }` — after each review date, which is where the spec's
/// own worked entries (61 §15.1) put it.
fn ran_it_on_a_box(source: &str) -> String {
    source.replace(
        "\n  reviewed_on: 2026-07-28\n",
        "\n  reviewed_on: 2026-07-28\n  verified_on: { platform: junos-srx, version: \"21.4R3\" }\n",
    )
}

/// The owner's queued action: the placeholder becomes a person. Nothing else
/// about the corpus changes — in particular no box is involved.
fn named_the_reviewer(source: &str) -> String {
    source.replace("<named human>", "K. Okafor")
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
///
/// It carries BOTH counts, and the reason is the defect this file was rewritten
/// for: one number that could reach zero from either direction is a number that
/// stops sounding when the wrong half is fixed.
#[test]
fn the_summary_carries_the_corpus_review_line() {
    let mut shell = booted();
    let hits = rows(&mut shell, "ipsec");
    let line = &hits[0].strings[5];
    assert!(
        line.contains("98 command entries")
            && line.contains("98 unverified")
            && line.contains("98 with no named reviewer"),
        "the summary's review line reads {line:?}"
    );

    // It is a count and not a sentence: a corpus with both facts satisfied must
    // stop sounding the alarm, or nobody will believe it when it does. Note
    // BOTH edits are applied here — either one alone is asserted below.
    let index = CorpusIndex::from_sources(&edited_sources(&|s: &str| {
        named_the_reviewer(&ran_it_on_a_box(s))
    }))
    .expect("the edited corpus still loads");
    let line = review_line(&index);
    assert!(
        !line.contains("unverified")
            && line.contains("every one run on a box and reviewed by a named human"),
        "with every entry run and reviewed the line reads {line:?}"
    );
}

/// CANARY 1 — a bench run, and nothing else, takes the label off.
///
/// 61 §3.1: *"`verified_on` … the box the author actually ran this on. Absent ⇒
/// the entry renders an `unverified` margin tab."* This drives a corpus where
/// it is present, and requires the flag, the stamp and the corpus line all to
/// change together. `reviewed_by` is left as the `<named human>` placeholder
/// throughout, so a predicate keyed on the reviewer cannot pass this: it would
/// leave every row flagged.
#[test]
fn a_bench_run_clears_the_unverified_label() {
    let mut shell = booted_with_commands(ran_it_on_a_box);
    let mut checked = 0;
    for query in ["ipsec", "show security ike", "vpn"] {
        let hits = rows(&mut shell, query);
        assert!(
            !hits[0].strings[5].contains("unverified"),
            "the review line still calls a run corpus unverified: {:?}",
            hits[0].strings[5]
        );
        // The reviewer is still a placeholder, so invariant 10's half of the
        // line must still be sounding. This is what stops the fix from being
        // "swap which fact we suppress".
        assert!(
            hits[0].strings[5].contains("no named reviewer"),
            "invariant 10's count went missing: {:?}",
            hits[0].strings[5]
        );
        for r in hits {
            if r.role != ROLE_SHOWN && r.role != ROLE_BELOW {
                continue;
            }
            assert_eq!(
                r.flags & ROW_UNVERIFIED,
                0,
                "{}: run on a box and still flagged unverified",
                r.strings[1]
            );
            assert!(
                !r.strings[5].contains("unverified"),
                "{}: stamp reads {:?}",
                r.strings[1],
                r.strings[5]
            );
            // ADR-0027 §3's facts come from `verified_on`, not from the entry's
            // own platform/versions: the box and the train are named here.
            assert!(
                r.strings[5].starts_with("junos-srx 21.4R3 · verified on a box"),
                "{}: stamp reads {:?}",
                r.strings[1],
                r.strings[5]
            );
            // AND THE ROW SAYS WHAT THE CORPUS LINE SAYS. This fixture is run on
            // a box with `reviewed_by` still a placeholder — the ordering
            // ADR-0027 §5 contemplates, conformance lab before expert review —
            // so the row must sound invariant 10 exactly as the summary does.
            //
            // The assertion this replaces pinned
            //     `… · verified · reviewed 2026-07-28 by <named human>`
            // which is the placeholder rendered as though it were a person,
            // introduced by the word `verified` and a date. The canary was
            // holding the defect in place rather than catching it, which is the
            // worst thing a canary can do: it makes the wrong behaviour load
            // bearing.
            assert!(
                r.strings[5].contains("NO NAMED REVIEWER (invariant 10)"),
                "{}: run on a box, reviewer still a placeholder, and the stamp \
                 does not say so: {:?}",
                r.strings[1],
                r.strings[5]
            );
            assert!(
                !r.strings[5].contains('<'),
                "{}: an invariant-10 placeholder reached a rendered stamp: {:?}",
                r.strings[1],
                r.strings[5]
            );
            checked += 1;
        }
    }
    assert!(checked > 50, "the sweep saw {checked} rows, too few");
}

/// CANARY 2 — naming the reviewer does NOT take the label off.
///
/// This is the failure the predicate was rewritten to prevent, driven directly.
/// The named expert review of `corpus/` is on CLAUDE.md's owner-blocking list;
/// when it lands, `reviewed_by` becomes a person on all 98 entries and not one
/// of them will have been near a box. Every row must still be stamped
/// unverified, and the corpus line must still say so.
#[test]
fn naming_the_reviewer_does_not_clear_the_unverified_label() {
    let mut shell = booted_with_commands(named_the_reviewer);
    let mut checked = 0;
    for query in ["ipsec", "show security ike", "vpn"] {
        let hits = rows(&mut shell, query);
        assert!(
            hits[0].strings[5].contains("98 unverified"),
            "a reviewed-but-unrun corpus stopped sounding the alarm: {:?}",
            hits[0].strings[5]
        );
        assert!(
            !hits[0].strings[5].contains("no named reviewer"),
            "invariant 10's count did not clear once every entry was reviewed: {:?}",
            hits[0].strings[5]
        );
        for r in hits {
            if r.role != ROLE_SHOWN && r.role != ROLE_BELOW {
                continue;
            }
            assert_ne!(
                r.flags & ROW_UNVERIFIED,
                0,
                "{}: reviewed, never run, and the flag came off",
                r.strings[1]
            );
            // The stamp says both things: still unverified, and now attributable.
            assert_eq!(
                r.strings[5],
                "junos-srx · unverified — not run on a box · reviewed 2026-07-28 by K. Okafor",
                "{}: stamp",
                r.strings[1]
            );
            checked += 1;
        }
    }
    assert!(checked > 50, "the sweep saw {checked} rows, too few");
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
