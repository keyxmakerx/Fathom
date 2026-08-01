//! The golden harness: 16 §9.6's query set at seed scale, plus the
//! determinism invariant — identical corpus + identical query ⇒ identical
//! ranked list, asserted across two independent engine constructions on
//! every golden query (the full list, not the top-3).

use std::path::PathBuf;

use fathom_corpus::model::Risk;
use fathom_corpus::CorpusIndex;
use fathom_find::{Finder, SearchResult};

fn corpus_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .join("corpus")
}

#[derive(Debug, Default)]
struct Case {
    q: String,
    top3: Vec<String>,
    reverse: Option<String>,
    absent: Vec<String>,
    below_readonly: Vec<String>,
    notrank1: Option<String>,
    broad: bool,
}

fn parse_cases(text: &str) -> Vec<Case> {
    let mut cases = Vec::new();
    let mut cur: Option<Case> = None;
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if let Some(q) = line.strip_prefix("q: ") {
            if let Some(done) = cur.take() {
                cases.push(done);
            }
            cur = Some(Case {
                q: q.to_owned(),
                ..Case::default()
            });
            continue;
        }
        let case = cur.as_mut().expect("directive before first q:");
        if let Some(v) = line.strip_prefix("top3: ") {
            case.top3 = v.split('|').map(|s| s.trim().to_owned()).collect();
        } else if let Some(v) = line.strip_prefix("reverse: ") {
            case.reverse = Some(v.trim().to_owned());
        } else if let Some(v) = line.strip_prefix("absent: ") {
            case.absent = v.split_whitespace().map(|s| s.to_owned()).collect();
        } else if let Some(v) = line.strip_prefix("below_readonly: ") {
            case.below_readonly = v.split_whitespace().map(|s| s.to_owned()).collect();
        } else if let Some(v) = line.strip_prefix("notrank1: ") {
            case.notrank1 = Some(v.trim().to_owned());
        } else if line == "broad: yes" {
            case.broad = true;
        } else {
            panic!("unknown golden directive: {line}");
        }
    }
    if let Some(done) = cur.take() {
        cases.push(done);
    }
    cases
}

/// The full ranked list (shown and below-cutoff rows), as one canonical
/// string — the byte-identity surface for the determinism assertion.
fn dump(finder: &Finder, result: &SearchResult) -> String {
    let mut s = String::new();
    for r in result.shown.iter().chain(result.below.iter()) {
        s.push_str(&format!(
            "{} {}\n",
            finder.index.entry(r.entry).id,
            r.score_milli
        ));
    }
    s
}

#[test]
fn golden_queries() {
    let text = include_str!("golden.txt");
    let cases = parse_cases(text);
    assert!(cases.len() >= 19, "the golden set stays meaningfully sized");

    // Two engines, independently constructed from disk.
    let finder_a = Finder::new(CorpusIndex::load(&corpus_root()).expect("corpus loads"));
    let finder_b = Finder::new(CorpusIndex::load(&corpus_root()).expect("corpus loads"));

    for case in &cases {
        let ra = finder_a.search(&case.q);
        let rb = finder_b.search(&case.q);
        // Determinism: the FULL ranked list is byte-identical across two
        // engine constructions, and across repeated searches on one engine.
        assert_eq!(
            dump(&finder_a, &ra),
            dump(&finder_b, &rb),
            "ranked list differs across engine constructions for {:?}",
            case.q
        );
        let ra2 = finder_a.search(&case.q);
        assert_eq!(
            dump(&finder_a, &ra),
            dump(&finder_a, &ra2),
            "ranked list differs across repeated searches for {:?}",
            case.q
        );

        let shown_ids: Vec<&str> = ra
            .shown
            .iter()
            .map(|r| finder_a.index.entry(r.entry).id.as_str())
            .collect();

        // Expected top-N, in order.
        for (i, want) in case.top3.iter().enumerate() {
            assert_eq!(
                shown_ids.get(i).copied(),
                Some(want.as_str()),
                "{:?}: rank {} — got {:?}",
                case.q,
                i + 1,
                &shown_ids[..shown_ids.len().min(5)]
            );
        }

        if let Some(want) = &case.notrank1 {
            assert_ne!(
                shown_ids.first().copied(),
                Some(want.as_str()),
                "{:?}: {want} must not be rank 1",
                case.q
            );
        }
        for id in &case.absent {
            assert!(
                !shown_ids.contains(&id.as_str()),
                "{:?}: {id} must not be shown (got {shown_ids:?})",
                case.q
            );
        }
        // Each listed id is absent, or ranks below every shown ReadOnly row.
        if !case.below_readonly.is_empty() {
            let last_readonly = ra
                .shown
                .iter()
                .rposition(|r| finder_a.index.meta[r.entry as usize].risk == Risk::ReadOnly);
            for id in &case.below_readonly {
                if let Some(pos) = shown_ids.iter().position(|s| s == id) {
                    assert!(
                        last_readonly.is_none_or(|lr| pos > lr),
                        "{:?}: {id} (rank {}) must sit below every ReadOnly result",
                        case.q,
                        pos + 1
                    );
                }
            }
        }
        if let Some(want) = &case.reverse {
            let rev = ra
                .reverse
                .as_ref()
                .unwrap_or_else(|| panic!("{:?}: reverse shape did not fire", case.q));
            assert!(rev.full, "{:?}: reverse match must be full-depth", case.q);
            assert_eq!(
                &finder_a.index.entry(rev.entry).id,
                want,
                "{:?}: reverse resolved to the wrong entry",
                case.q
            );
        }
        if case.broad {
            assert!(
                ra.ladder_group_trigger,
                "{:?}: §3.4 breadth resolution must fire",
                case.q
            );
        }
    }
}

/// 16 §22 failure 4's named regression, pinned forever: `ike` must never
/// fuzz into `ipsec`.
#[test]
fn ike_never_fuzzes_to_ipsec() {
    let jw = fathom_find::syntax::jaro_winkler("ike", "ipsec");
    assert!(
        jw < 0.86,
        "ike/ipsec JW {jw} would cross the accept threshold"
    );
    // And the length guard alone already excludes it: fuzzy needs ≥4 chars.
    assert!("ike".len() < 4);
}

/// The flagship's Disruptive floor, asserted directly against the engine:
/// on the diagnostic query, no Disruptive entry may outrank any ReadOnly
/// entry (F7 — the risk prior is a safety control).
#[test]
fn diagnostic_query_never_ranks_disruptive_above_readonly() {
    let finder = Finder::new(CorpusIndex::load(&corpus_root()).unwrap());
    for q in [
        "check if a tunnel is up",
        "is the tunnel up",
        "why is the tunnel down",
    ] {
        let r = finder.search(q);
        let mut seen_disruptive = false;
        for row in &r.shown {
            match finder.index.meta[row.entry as usize].risk {
                Risk::Disruptive => seen_disruptive = true,
                Risk::ReadOnly => assert!(
                    !seen_disruptive,
                    "{q:?}: a ReadOnly answer ranked below a Disruptive one"
                ),
                Risk::ChangesConfig => {}
            }
        }
    }
}
