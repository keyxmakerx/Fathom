//! fathom-corpus: loads the seed command/explainer/rule bundles (61's formats,
//! as instantiated by `corpus/`), builds the concept layer (16 §3) and the
//! in-memory finder index (16 §9 at seed scale), and runs the mechanically-
//! checkable subset of 61 §14's gates as an inventory.
//!
//! Nothing here ships anything: gates report, they do not fail the build.
//! Determinism is an invariant — no hash maps, no clocks, no RNG, no
//! transcendental math at query time (idf/icf are precomputed via a
//! deterministic ln and quantised to milli-nats).

#![forbid(unsafe_code)]

pub mod concepts;
pub mod detln;
pub mod gates;
pub mod index;
pub mod load;
pub mod model;
pub mod normalize;

pub use gates::{Finding, Severity};
pub use index::CorpusIndex;
pub use load::LoadError;
pub use load::{load_corpus_sources, Section, SourceFile};
pub use model::{Corpus, Entry, Risk};

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn corpus_root() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../..")
            .join("corpus")
    }

    #[test]
    fn seed_corpus_loads_and_indexes() {
        let idx = CorpusIndex::load(&corpus_root()).expect("seed corpus must load");
        assert_eq!(
            idx.corpus.entries.len(),
            98,
            "the seed bundle is 98 entries"
        );
        assert_eq!(idx.corpus.explainers.len(), 42);
        assert!(!idx.terms.is_empty());
        assert!(idx.concepts.by_id.contains_key("concept:obj.tunnel"));
        // The flagship trace's own join: p2.installed is narrower of
        // state.operational, and both resolve.
        let op = idx.concepts.by_id["concept:state.operational"];
        let p2 = idx.concepts.by_id["concept:p2.installed"];
        assert!(idx.concepts.get(op).narrower.contains(&p2));
        assert!(idx.concepts.get(p2).broader.contains(&op));
    }

    #[test]
    fn unscoped_disruptive_is_gated() {
        let idx = CorpusIndex::load(&corpus_root()).unwrap();
        let ord = idx
            .corpus
            .entries
            .iter()
            .position(|e| e.id == "junos-srx/ike.sa.clear-all")
            .unwrap();
        assert!(
            idx.meta[ord].unscoped_gated,
            "16 §16.5: the unscoped clear is syntax-reachable only"
        );
        let vpn = idx
            .corpus
            .entries
            .iter()
            .position(|e| e.id == "junos-srx/ipsec.sa.clear-vpn")
            .unwrap();
        assert!(
            !idx.meta[vpn].unscoped_gated,
            "the P2 clear has no scoped sibling and stays concept-reachable"
        );
    }

    #[test]
    fn gate_inventory_reports_reviewed_by_for_every_entry() {
        let idx = CorpusIndex::load(&corpus_root()).unwrap();
        let findings = gates::run(&idx);
        let placeholders = findings
            .iter()
            .filter(|f| {
                f.code == "corpus.reviewed_by.placeholder"
                    && idx.corpus.entries.iter().any(|e| e.id == f.subject)
            })
            .count();
        assert_eq!(placeholders, 98, "all 98 command entries are unreviewed");
        assert!(findings
            .iter()
            .all(|f| !f.subject.is_empty() && !f.message.is_empty()));
    }

    #[test]
    fn index_is_deterministic_across_constructions() {
        let a = CorpusIndex::load(&corpus_root()).unwrap();
        let b = CorpusIndex::load(&corpus_root()).unwrap();
        let dump = |idx: &CorpusIndex| {
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
        };
        assert_eq!(dump(&a), dump(&b));
    }
}
