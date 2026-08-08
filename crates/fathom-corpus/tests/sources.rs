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
