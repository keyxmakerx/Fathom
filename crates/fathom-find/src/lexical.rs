//! Matcher 1 — lexical BM25F, 16 §5.2's formula with §5.3's parameters.
//! No transcendental arithmetic at query time: IDF is the index's quantised
//! milli-nat value; everything here is IEEE basic ops in a fixed order.

use fathom_corpus::index::{CorpusIndex, FIELDS};
use fathom_corpus::normalize::Normalized;

pub const K1: f64 = 1.2;
/// §8.2 — the squash constant, pinned with the field boosts.
pub const KAPPA: f64 = 6.0;

/// Query-side term weights, milli. Implementation constants (WO-06): 16
/// §5.2's score formula carries no query-side factor — its `sub_f` is
/// document-side, folded into the stored weighted tf at index build
/// (fathom-corpus `index.rs`). The 0.6 here is §4.1 step 7's sub-token
/// multiplier applied at the query side by the same shared normaliser
/// ("one function, compiled once, used twice", §4), so a hyphenated query
/// token does not score as three independent whole terms. The value is
/// step 7's; the application point is not in §5.2 and is filed as a spec
/// gap in 73 §14.
pub const W_WHOLE_MILLI: u32 = 1000;
/// See `W_WHOLE_MILLI`.
pub const W_SUB_MILLI: u32 = 600;

/// Unique query terms in dictionary order: (lemma, query-side weight milli).
/// Whole tokens carry `W_WHOLE_MILLI`, hyphen/dot sub-parts `W_SUB_MILLI`
/// (the documented deviation on those constants); a lemma reached both ways
/// keeps the higher weight. Stopwords are excluded (§4.3).
pub fn query_terms(n: &Normalized) -> Vec<(String, u32)> {
    let mut terms: Vec<(String, u32)> = Vec::new();
    let mut push = |lemma: &str, w: u32| match terms.iter_mut().find(|(t, _)| t == lemma) {
        Some((_, existing)) => *existing = (*existing).max(w),
        None => terms.push((lemma.to_owned(), w)),
    };
    for tok in &n.tokens {
        if tok.stopword {
            continue;
        }
        push(&tok.lemma, W_WHOLE_MILLI);
        for p in &tok.parts {
            push(&p.lemma, W_SUB_MILLI);
        }
    }
    terms.sort();
    terms
}

/// Raw BM25F for one entry. Decomposes per term for the `--why` panel.
pub fn bm25(
    idx: &CorpusIndex,
    terms: &[(String, u32)],
    entry: u32,
    why: Option<&mut Vec<(String, f64)>>,
) -> f64 {
    let mut total = 0.0f64;
    let mut why_rows = Vec::new();
    for (term, w_q) in terms {
        let Some(info) = idx.terms.get(term) else {
            continue;
        };
        let Ok(pos) = info.postings.binary_search_by_key(&entry, |(e, _)| *e) else {
            continue;
        };
        let tfs = &info.postings[pos].1;
        let lens = &idx.field_len_milli[entry as usize];
        let mut tf_tilde = 0.0f64;
        for (f, field) in FIELDS.iter().enumerate() {
            if tfs[f] == 0 {
                continue;
            }
            let b = f64::from(field.b_milli()) / 1000.0;
            let len = f64::from(lens[f]);
            let avg = f64::from(idx.avgdl_milli[f]).max(1.0);
            let norm = 1.0 - b + b * (len / avg);
            let boost = f64::from(field.boost_milli()) / 1000.0;
            // `sub_f` is folded into the stored weighted tf (§5.2).
            tf_tilde += boost * (f64::from(tfs[f]) / 1000.0) / norm;
        }
        let idf = f64::from(info.idf_milli) / 1000.0;
        let contribution = idf * (f64::from(*w_q) / 1000.0) * (tf_tilde / (K1 + tf_tilde));
        total += contribution;
        if contribution > 0.0 {
            why_rows.push((term.clone(), contribution));
        }
    }
    if let Some(out) = why {
        *out = why_rows;
    }
    total
}

/// §8.2 — monotone, corpus-independent, deterministic squash into [0,1).
pub fn squash(bm25: f64) -> f64 {
    bm25 / (bm25 + KAPPA)
}

#[cfg(test)]
mod tests {
    use super::*;
    use fathom_corpus::normalize::{normalize, Lexicons};
    use std::collections::BTreeSet;

    /// WO-06 MINOR 1 — the query-side weights are implementation constants
    /// (16 §4.1 step 7's multiplier at the query side; absent from §5.2's
    /// formula; filed in 73 §14). Pinned so any change is deliberate.
    #[test]
    fn query_side_weights_pinned() {
        let lex = Lexicons::new(BTreeSet::new());
        let n = normalize("check the inactive-tunnels", &lex);
        assert_eq!(
            query_terms(&n),
            vec![
                ("check".to_owned(), W_WHOLE_MILLI),
                ("inactive".to_owned(), W_SUB_MILLI),
                ("inactive-tunnels".to_owned(), W_WHOLE_MILLI),
                ("tunnel".to_owned(), W_SUB_MILLI),
            ],
            "whole 1000, sub-part 600, stopword excluded, dictionary order"
        );
        // A lemma reached whole and as a sub-part keeps the whole weight.
        let n = normalize("tunnel inactive-tunnels", &lex);
        assert_eq!(
            query_terms(&n),
            vec![
                ("inactive".to_owned(), W_SUB_MILLI),
                ("inactive-tunnels".to_owned(), W_WHOLE_MILLI),
                ("tunnel".to_owned(), W_WHOLE_MILLI),
            ]
        );
    }
}
