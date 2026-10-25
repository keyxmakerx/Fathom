//! ADR-0066 item 1.1: the explainer fields a person reads in the app's About card
//! load from the real corpus, not only the id and title the finder needs.

use std::path::PathBuf;

use fathom_corpus::load::load_corpus;

fn corpus_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../corpus")
}

#[test]
fn every_read_this_first_entry_has_words_and_a_source() {
    let corpus = load_corpus(&corpus_root()).expect("the corpus loads");
    let firsts: Vec<_> = corpus
        .explainers
        .iter()
        .filter(|e| e.tab.as_deref() == Some("read this first"))
        .collect();
    assert!(firsts.len() >= 14, "found {}", firsts.len());
    for e in firsts {
        assert!(e.subject_path.is_some(), "{} has no subject path", e.id);
        assert!(
            e.terse.as_deref().is_some_and(|t| !t.is_empty()),
            "{} has no terse",
            e.id
        );
        assert!(e.explained.is_some(), "{} has no explained", e.id);
        assert!(!e.sources.is_empty(), "{} cites nothing", e.id);
        for s in &e.sources {
            assert!(!s.doc.is_empty(), "{} has a source with no doc", e.id);
        }
    }
}

#[test]
fn platforms_and_teaching_are_read() {
    let corpus = load_corpus(&corpus_root()).expect("the corpus loads");
    let eos = corpus
        .explainers
        .iter()
        .find(|e| e.subject_path.as_deref() == Some("arista.eos-basics"))
        .expect("the EOS explainer");
    assert_eq!(eos.platforms, vec!["eos".to_string()]);
    let debian = corpus
        .explainers
        .iter()
        .find(|e| e.subject_path.as_deref() == Some("linux-debian.basics"))
        .expect("the Debian explainer");
    assert!(debian
        .teaching
        .as_deref()
        .is_some_and(|t| t.contains("apt")));
    assert!(debian.breaks_if_wrong.is_some());
}
