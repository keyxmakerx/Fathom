//! Parity and refusals: the shell path and the native path must agree row for
//! row, and every failure must arrive as a typed error record rather than a
//! trap (41 §3.9).
//!
//! This is X0.5's property (71 §3.6) at slice-one strength — one process, two
//! code paths. The cross-target execution form needs 45's browser harness and
//! is WO-07 §8's.

use std::path::PathBuf;

use fathom_corpus::{CorpusIndex, Section, SourceFile};
use fathom_find::{Finder, Ranked, SearchResult, CONFIDENT_MILLI};
use fathom_wasm::protocol::{
    decode_reply, encode_error, pack_corpus, FinderRowView, ReplyView, ERR_BAD_FRAME, ERR_BAD_UTF8,
    ERR_CORPUS_LOAD, ERR_NOT_INITIALISED, ERR_UNKNOWN_OP, KIND_ERROR, ROLE_BELOW, ROLE_SHOWN,
    ROLE_SUMMARY,
};
use fathom_wasm::shell::Shell;
use fathom_wasm::{OP_INIT, OP_QUERY};

fn workspace_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")
}

fn corpus_root() -> PathBuf {
    workspace_root().join("corpus")
}

/// The seed corpus as bare-named sources: the per-directory `*.yaml` listing,
/// sorted, with the file name only — the shell prefixes the section.
fn bare_sources() -> Vec<SourceFile> {
    let root = corpus_root();
    let mut out = Vec::new();
    for (section, dir) in [
        (Section::Commands, "commands"),
        (Section::Explainers, "explainers"),
        (Section::Rules, "rules"),
    ] {
        let mut paths: Vec<PathBuf> = std::fs::read_dir(root.join(dir))
            .expect("corpus subdirectory must exist")
            .map(|e| e.expect("readable dir entry").path())
            .filter(|p| p.extension().and_then(|e| e.to_str()) == Some("yaml"))
            .collect();
        paths.sort();
        for path in paths {
            out.push(SourceFile {
                section,
                name: path
                    .file_name()
                    .expect("a file name")
                    .to_string_lossy()
                    .into_owned(),
                source: std::fs::read_to_string(&path).expect("readable bundle"),
            });
        }
    }
    out
}

fn initialised_shell() -> Shell {
    let mut shell = Shell::new();
    let frame = pack_corpus(&bare_sources());
    let reply = shell.handle(OP_INIT, &frame);
    assert!(
        reply.is_empty(),
        "OP_INIT succeeds with the empty reply; got {:?}",
        decode_reply(&reply)
    );
    shell
}

fn error_code(reply: &[u8]) -> u16 {
    match decode_reply(reply).expect("a reply must decode") {
        ReplyView::Error(e) => e.code,
        other => panic!("expected an error record, got {other:?}"),
    }
}

fn error_detail(reply: &[u8]) -> String {
    match decode_reply(reply).expect("a reply must decode") {
        ReplyView::Error(e) => e.detail,
        other => panic!("expected an error record, got {other:?}"),
    }
}

fn milli(v: f64) -> i32 {
    (v * 1000.0).round() as i32
}

/// The rows of the native `SearchResult`, checked field by field against the
/// records the shell packed.
fn assert_rows_match(
    query: &str,
    role: u8,
    native: &[Ranked],
    packed: &[&FinderRowView],
    idx: &CorpusIndex,
) {
    assert_eq!(
        packed.len(),
        native.len(),
        "{query}: role {role} record count"
    );
    for (r, view) in native.iter().zip(packed.iter()) {
        let e = idx.entry(r.entry);
        assert_eq!(view.entry, r.entry, "{query}: entry ordinal");
        assert_eq!(view.score_milli, r.score_milli, "{query}: score_milli");
        let c = &r.contributions;
        assert_eq!(
            view.contributions_milli,
            [
                milli(c.concept),
                milli(c.lexical),
                milli(c.syntax),
                milli(c.context),
                milli(c.prior)
            ],
            "{query}: contributions"
        );
        let expected_risk = match e.risk {
            fathom_corpus::Risk::ReadOnly => 0u8,
            fathom_corpus::Risk::ChangesConfig => 1,
            fathom_corpus::Risk::Disruptive => 2,
        };
        assert_eq!(view.risk, expected_risk, "{query}: risk byte");
        assert_eq!(
            view.flags & 1 != 0,
            r.score_milli < CONFIDENT_MILLI,
            "{query}: band flag"
        );
        assert_eq!(
            view.flags & 2 != 0,
            !e.next_if_bad.is_empty(),
            "{query}: next_if_bad flag"
        );
        assert_eq!(view.strings[0], idx.display_cmd(r.entry), "{query}: s0");
        assert_eq!(view.strings[1], e.id, "{query}: s1");
        assert_eq!(view.strings[2], e.answers, "{query}: s2");
        assert_eq!(view.strings[3], e.read_field, "{query}: s3");
        assert_eq!(
            view.strings[4],
            e.next_if_bad.first().cloned().unwrap_or_default(),
            "{query}: s4"
        );
    }
}

fn assert_summary_matches(
    query: &str,
    view: &FinderRowView,
    result: &SearchResult,
    idx: &CorpusIndex,
) {
    assert_eq!(view.role, ROLE_SUMMARY, "{query}: record 0 is the summary");
    assert_eq!(
        view.entry,
        result.query_concepts.concepts.len() as u32,
        "{query}: query-concept count"
    );
    assert_eq!(view.score_milli, milli(result.g_syn), "{query}: g_syn");
    assert_eq!(
        view.contributions_milli, [0; 5],
        "{query}: summary contributions"
    );
    assert_eq!(
        view.flags & 1 != 0,
        result.ladder_group_trigger,
        "{query}: ladder flag"
    );
    assert_eq!(
        view.flags & 2 != 0,
        result.reverse.is_some(),
        "{query}: reverse-present flag"
    );
    assert_eq!(
        view.flags & 4 != 0,
        result.reverse.as_ref().is_some_and(|r| r.full),
        "{query}: reverse-full flag"
    );
    assert_eq!(
        view.flags & 8 != 0,
        result.filter_clause.is_some(),
        "{query}: filter-clause flag"
    );
    assert_eq!(
        view.strings[0],
        result.filter_clause.clone().unwrap_or_default(),
        "{query}: filter clause"
    );
    match &result.reverse {
        None => {
            assert_eq!(view.strings[1], "", "{query}: no reverse cmd");
            assert_eq!(view.strings[2], "", "{query}: no reverse id");
            assert_eq!(view.strings[3], "", "{query}: no reverse captures");
            assert_eq!(view.strings[4], "", "{query}: no reverse leftover");
        }
        Some(rev) => {
            assert_eq!(
                view.strings[1],
                idx.display_cmd(rev.entry),
                "{query}: reverse cmd"
            );
            assert_eq!(
                view.strings[2],
                idx.entry(rev.entry).id,
                "{query}: reverse id"
            );
            assert_eq!(
                view.strings[3],
                rev.captures
                    .iter()
                    .map(|(slot, value)| format!("{slot} := {value}"))
                    .collect::<Vec<_>>()
                    .join("\n"),
                "{query}: reverse captures"
            );
            assert_eq!(
                view.strings[4],
                rev.leftover.join(" "),
                "{query}: reverse leftover"
            );
        }
    }
}

#[test]
fn shell_replies_mirror_the_native_finder() {
    let mut shell = initialised_shell();
    let finder = Finder::new(CorpusIndex::load(&corpus_root()).expect("the corpus loads"));
    let idx = &finder.index;

    let golden =
        std::fs::read_to_string(workspace_root().join("crates/fathom-find/tests/golden.txt"))
            .expect("the golden set is readable");
    let mut queries: Vec<String> = golden
        .lines()
        .filter_map(|l| l.strip_prefix("q: "))
        .map(str::to_owned)
        .collect();
    assert!(!queries.is_empty(), "the golden set carries queries");
    queries.push("is the vpn to site B actually up".to_owned());

    for query in &queries {
        let reply = shell.handle(OP_QUERY, query.as_bytes());
        let rows = match decode_reply(&reply).expect("a query reply decodes") {
            ReplyView::FinderRows(rows) => rows,
            other => panic!("{query}: expected finder rows, got {other:?}"),
        };
        let result = finder.search(query);
        assert_eq!(
            rows.len(),
            1 + result.shown.len() + result.below.len(),
            "{query}: record count"
        );
        assert_summary_matches(query, &rows[0], &result, idx);
        let shown: Vec<&FinderRowView> = rows.iter().filter(|r| r.role == ROLE_SHOWN).collect();
        let below: Vec<&FinderRowView> = rows.iter().filter(|r| r.role == ROLE_BELOW).collect();
        assert_rows_match(query, ROLE_SHOWN, &result.shown, &shown, idx);
        assert_rows_match(query, ROLE_BELOW, &result.below, &below, idx);
    }
}

#[test]
fn error_replies_are_typed() {
    let mut fresh = Shell::new();
    assert_eq!(
        error_code(&fresh.handle(OP_QUERY, b"anything")),
        ERR_NOT_INITIALISED,
        "a query before OP_INIT is refused, not answered"
    );

    let mut shell = initialised_shell();
    assert_eq!(
        error_code(&shell.handle(9, b"")),
        ERR_UNKNOWN_OP,
        "an unimplemented opcode is refused by number"
    );
    assert_eq!(
        error_code(&shell.handle(OP_QUERY, &[0xff, 0xfe])),
        ERR_BAD_UTF8,
        "a non-UTF-8 query is refused"
    );

    // The error reply is a KIND_ERROR record carrying its detail string.
    let raw = encode_error(ERR_UNKNOWN_OP, "detail travels");
    assert_eq!(u16::from_le_bytes([raw[6], raw[7]]), KIND_ERROR);
    assert_eq!(error_detail(&raw), "detail travels");
}

#[test]
fn init_frame_refusals() {
    let sources = bare_sources();
    let good = pack_corpus(&sources);

    let mut shell = Shell::new();
    assert_eq!(
        error_code(&shell.handle(OP_INIT, &good[..good.len() - 1])),
        ERR_BAD_FRAME,
        "a truncated frame is refused"
    );

    let mut bad_section = pack_corpus(&sources[..1]);
    bad_section[4] = 3;
    assert_eq!(
        error_code(&shell.handle(OP_INIT, &bad_section)),
        ERR_BAD_FRAME,
        "a section byte outside 0–2 is refused"
    );

    let duplicated = vec![sources[0].clone(), sources[0].clone()];
    assert_eq!(
        error_code(&shell.handle(OP_INIT, &pack_corpus(&duplicated))),
        ERR_BAD_FRAME,
        "a duplicate (section, name) is refused"
    );

    let broken = vec![SourceFile {
        section: Section::Commands,
        name: "broken.yaml".to_owned(),
        source: "entries:\n  - id: a\n\tbroken: yes\n".to_owned(),
    }];
    let reply = shell.handle(OP_INIT, &pack_corpus(&broken));
    assert_eq!(
        error_code(&reply),
        ERR_CORPUS_LOAD,
        "a broken source is a load error, not a frame error"
    );
    let detail = error_detail(&reply);
    assert!(
        detail.contains(":3:"),
        "the loader's line number travels in the detail: {detail}"
    );
}
