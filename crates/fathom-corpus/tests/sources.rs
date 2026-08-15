//! The filesystem-free load path (WO-07 §4.2): `load_corpus_sources` must be
//! the same load `load_corpus` performs, and it must refuse a duplicate
//! `(section, name)` rather than silently taking one of them.

use std::path::PathBuf;

use fathom_corpus::{CorpusIndex, Section, SourceFile};

fn corpus_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .join("corpus")
}

/// The three subdirectories, listed exactly as `yaml_files` lists them:
/// `*.yaml` only, sorted, with `path.display().to_string()` as the name.
fn source_files() -> Vec<SourceFile> {
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
                name: path.display().to_string(),
                source: std::fs::read_to_string(&path).expect("readable bundle"),
            });
        }
    }
    out
}

/// `index_is_deterministic_across_constructions`'s dump (`src/lib.rs`): the
/// term dictionary with its quantised idf, the concept table with its
/// quantised icf, and the command keys.
fn dump(idx: &CorpusIndex) -> String {
    let mut s = String::new();
    for (t, info) in &idx.terms {
        s.push_str(&format!("{t} {} {}\n", info.idf_milli, info.df));
    }
    for c in &idx.concepts.concepts {
        s.push_str(&format!("{} {} {}\n", c.id, c.icf_milli, c.entry_count));
    }
    for (k, e) in &idx.cmd_keys {
        s.push_str(&format!("{k} {e}\n"));
    }
    s
}

#[test]
fn sources_load_equals_dir_load() {
    let files = source_files();
    assert!(!files.is_empty(), "the seed corpus has bundles");
    let from_sources = CorpusIndex::from_sources(&files).expect("sources must load");
    let from_dir = CorpusIndex::load(&corpus_root()).expect("dir must load");

    assert_eq!(
        from_sources.corpus.entries.len(),
        from_dir.corpus.entries.len()
    );
    assert_eq!(
        from_sources.corpus.explainers.len(),
        from_dir.corpus.explainers.len()
    );
    assert_eq!(from_sources.corpus.rules.len(), from_dir.corpus.rules.len());
    assert_eq!(dump(&from_sources), dump(&from_dir));
}

#[test]
fn duplicate_source_names_refused() {
    let mut files = source_files();
    let first = files[0].clone();
    files.push(first);
    let err = match CorpusIndex::from_sources(&files) {
        Ok(_) => panic!("a duplicate (section, name) must be refused"),
        Err(e) => e,
    };
    assert!(
        err.message.starts_with("duplicate source"),
        "message names the defect: {}",
        err.message
    );
}

// --- 61 §3.1's `verified_on` -------------------------------------------------
//
// The loader did not parse this field until 2026-08-15, and the absence was not
// harmless: `fathom_wasm::protocol` could not see the one fact ADR-0027 §2's
// `unverified` label is defined by, so it keyed the label on `reviewed_by`
// instead. These three tests hold the loader to the spec's own shape.

/// Nothing in the shipped corpus has been run on a box, and the bundle's header
/// says so in as many words: *"NOTHING IN THIS FILE HAS BEEN RUN ON A BOX BY
/// ITS AUTHOR. Every entry therefore omits `verified_on` and ships with the
/// `unverified` margin tab (61 §3.1)."* If that ever stops being true, it must
/// stop because somebody ran the commands — not because a test drifted.
#[test]
fn the_shipped_corpus_declares_no_bench_run() {
    let idx = CorpusIndex::from_sources(&source_files()).expect("the corpus loads");
    let run = idx
        .corpus
        .entries
        .iter()
        .filter(|e| e.verified_on.is_some())
        .count();
    assert_eq!(run, 0, "{run} entries now claim a bench run");
    // And every entry carries the review date the stamp prints, so the stamp
    // cannot be reached with an empty date slot.
    assert!(
        idx.corpus.entries.iter().all(|e| !e.reviewed_on.is_empty()),
        "61 §3.1 makes `reviewed_on` required"
    );
}

/// The shape 61 §3.1 declares — a flow table of `{ platform, version }`, which
/// is how §15.1's worked entry writes it — round-trips through the loader.
#[test]
fn a_verified_on_table_parses() {
    let mut files = source_files();
    for f in files.iter_mut() {
        if f.section == Section::Commands {
            f.source = f.source.replace(
                "\n  reviewed_on: 2026-07-28\n",
                "\n  reviewed_on: 2026-07-28\n  verified_on: { platform: junos-srx, version: \"21.4R3\" }\n",
            );
        }
    }
    let idx = CorpusIndex::from_sources(&files).expect("the edited corpus loads");
    let v = idx.corpus.entries[0]
        .verified_on
        .as_ref()
        .expect("the table parsed");
    assert_eq!(v.platform, "junos-srx");
    assert_eq!(v.version, "21.4R3");
    assert!(idx.corpus.entries.iter().all(|e| e.verified_on.is_some()));
}

/// A `verified_on` that is present and malformed is REFUSED. Reading it as
/// absent would turn a broken entry into one that merely looks honest, and
/// reading it loosely would let a table that names no box claim a bench run.
#[test]
fn a_malformed_verified_on_is_refused() {
    for (bad, want) in [
        // A bare scalar, which the subset parser accepts and the entry loader
        // must not: `verified_on: junos-srx` names a platform and no train, and
        // is exactly the shape an author writes when skimming §3.1.
        (
            "verified_on: junos-srx",
            "must be a `{ platform, version }` table",
        ),
        (
            "verified_on: { platform: junos-srx }",
            "missing required field `version`",
        ),
        (
            "verified_on: { version: \"21.4R3\" }",
            "missing required field `platform`",
        ),
    ] {
        let mut files = source_files();
        for f in files.iter_mut() {
            if f.section == Section::Commands {
                f.source = f.source.replacen(
                    "\n  reviewed_on: 2026-07-28\n",
                    &format!("\n  reviewed_on: 2026-07-28\n  {bad}\n"),
                    1,
                );
            }
        }
        let err = match CorpusIndex::from_sources(&files) {
            Ok(_) => panic!("`{bad}` must be refused"),
            Err(e) => e,
        };
        assert!(
            err.message.contains(want),
            "`{bad}` -> {:?}, wanted {want:?}",
            err.message
        );
    }
}
