//! fathom-find: the finder core — 16 §4 normalisation, the three matchers
//! (§5 lexical BM25F, §6 syntax, §7 concept), and §8's fusion with the risk
//! prior and integer-milli ordering. Deterministic by construction: identical
//! corpus + identical query ⇒ identical ranked list, across runs (invariant 9).

#![forbid(unsafe_code)]

pub mod conceptm;
pub mod lexical;
pub mod reverse;
pub mod syntax;

use std::collections::BTreeSet;

use fathom_corpus::model::Status;
use fathom_corpus::normalize::normalize;
use fathom_corpus::CorpusIndex;

use conceptm::ConceptQuery;
use reverse::ReverseHit;
use syntax::{SyntaxHit, Via};

/// §8.1's weights, as pinned in 61 §2.2's `[finder]` table.
pub const W_CONCEPT: f64 = 3.0;
pub const W_LEXICAL: f64 = 1.0;
pub const W_SYNTAX: f64 = 2.0;
/// §8.4's show cutoff, in milli.
pub const CUTOFF_MILLI: i32 = 1000;
/// §8.4's confident band.
pub const CONFIDENT_MILLI: i32 = 2500;
pub const MAX_ROWS: usize = 25;
/// §9.3's candidate cap.
const CANDIDATE_CAP: usize = 1024;
const LEXICAL_DF_CAP: u32 = 400;

#[derive(Debug, Clone, Default)]
pub struct Contributions {
    pub concept: f64,
    pub lexical: f64,
    pub syntax: f64,
    pub context: f64,
    pub prior: f64,
}

#[derive(Debug, Clone)]
pub struct Ranked {
    pub entry: u32,
    pub score_milli: i32,
    pub contributions: Contributions,
}

#[derive(Debug, Clone)]
pub struct SearchResult {
    /// Above the §8.4 cutoff, ordered, capped at 25.
    pub shown: Vec<Ranked>,
    /// The best below-cutoff rows — the §19.5 miss state shows them with
    /// scores, because a user who can see a near-miss can adjust.
    pub below: Vec<Ranked>,
    pub g_syn: f64,
    pub query_concepts: ConceptQuery,
    pub reverse: Option<ReverseHit>,
    pub filter_clause: Option<String>,
    /// Broad State concepts fired (§3.4) — where the §17.3 ladder group will
    /// attach once ladders exist as corpus documents. TODO(16 §17.3): no
    /// ladder documents are authored in corpus/ yet; the entry-local
    /// `next_if_bad` chain on each row is the honest first cut.
    pub ladder_group_trigger: bool,
}

pub struct Finder {
    pub index: CorpusIndex,
}

impl Finder {
    pub fn new(index: CorpusIndex) -> Finder {
        Finder { index }
    }

    /// §8.3's prior, bounded ±0.45. Context (`X`) is 0 throughout: this build
    /// has no workspace, which §16.6 defines as a legitimate, complete mode.
    fn prior_milli(&self, entry: u32) -> i64 {
        let meta = &self.index.meta[entry as usize];
        let mut p = 100 * meta.weight; // canonicality: 0.10 × weight 0..3
        p += meta.risk.prior_milli();
        if meta.has_requires {
            // Runtime-only `requires` with no workspace to satisfy it (§16.4).
            p -= 250;
        }
        if meta.status == Status::Draft {
            p -= 150;
        }
        p
    }

    pub fn search(&self, query: &str) -> SearchResult {
        let idx = &self.index;
        let n = normalize(query, &idx.lexicons);

        // Matchers.
        let cq = conceptm::surface_match(idx, &n);
        let terms = lexical::query_terms(&n);
        let g = syntax::g_syn(idx, &n);
        let syn = syntax::syntax_hits(idx, &n, g);
        let rev = reverse::detect_and_resolve(idx, &n);

        // §9.3 candidate generation: concept postings (query concepts, their
        // derived expansions, and one-hop neighbours — the hop §7.2 scores
        // through), lexical postings below the df cap, syntax hits.
        let mut candidates: BTreeSet<u32> = BTreeSet::new();
        for qc in &cq.concepts {
            let c = idx.concepts.get(qc.ord);
            candidates.extend(idx.c2e[qc.ord as usize].iter().copied());
            for &nb in c
                .narrower
                .iter()
                .chain(c.broader.iter())
                .chain(c.related.iter())
                .chain(c.opposite.iter())
            {
                candidates.extend(idx.c2e[nb as usize].iter().copied());
            }
        }
        for (term, _) in &terms {
            if let Some(info) = idx.terms.get(term) {
                if info.df <= LEXICAL_DF_CAP {
                    candidates.extend(info.postings.iter().map(|(e, _)| *e));
                }
            }
        }
        candidates.extend(syn.keys().copied());
        let candidates: Vec<u32> = candidates.into_iter().take(CANDIDATE_CAP).collect();

        // Scoring: f64 accumulation in fixed order (entries ascending, terms
        // in dictionary order), quantised once to i32 milli (§8.4). Ordering
        // never touches a float.
        let mut ranked: Vec<Ranked> = Vec::new();
        for &entry in &candidates {
            let meta = &idx.meta[entry as usize];
            let shit = syn.get(&entry);
            if meta.unscoped_gated && !syntax_reachable(shit) {
                // §16.5: the unscoped Disruptive form is never a
                // concept-match result.
                continue;
            }
            let c = conceptm::concept_score(idx, &cq, entry, None);
            let l = lexical::squash(lexical::bm25(idx, &terms, entry, None));
            let s = shit.map(|h| h.score).unwrap_or(0.0);
            let contributions = Contributions {
                concept: W_CONCEPT * c,
                lexical: W_LEXICAL * l,
                syntax: W_SYNTAX * g * s,
                context: 0.0,
                prior: self.prior_milli(entry) as f64 / 1000.0,
            };
            let total = contributions.concept
                + contributions.lexical
                + contributions.syntax
                + contributions.context
                + contributions.prior;
            let score_milli = (total * 1000.0).round() as i32;
            ranked.push(Ranked {
                entry,
                score_milli,
                contributions,
            });
        }

        // §8.4's total ordering key: (−S_milli, −canonicality, corpus id).
        ranked.sort_by(|a, b| {
            b.score_milli
                .cmp(&a.score_milli)
                .then_with(|| {
                    self.index.meta[b.entry as usize]
                        .weight
                        .cmp(&self.index.meta[a.entry as usize].weight)
                })
                .then_with(|| {
                    self.index
                        .entry(a.entry)
                        .id
                        .cmp(&self.index.entry(b.entry).id)
                })
        });
        let mut shown = Vec::new();
        let mut below = Vec::new();
        for r in ranked {
            if r.score_milli >= CUTOFF_MILLI && shown.len() < MAX_ROWS {
                shown.push(r);
            } else if r.score_milli < CUTOFF_MILLI && below.len() < 5 {
                below.push(r);
            }
        }

        SearchResult {
            shown,
            below,
            g_syn: g,
            ladder_group_trigger: !cq.broad.is_empty(),
            query_concepts: cq,
            reverse: rev,
            filter_clause: n.filter,
        }
    }
}

/// §16.5's "reached directly by syntax": an exact whole-query prefix of the
/// command, or a token alignment covering ≥ 0.6 of the query.
fn syntax_reachable(hit: Option<&SyntaxHit>) -> bool {
    match hit {
        None => false,
        Some(h) => match h.via {
            Via::Prefix | Via::Lev1 => true,
            Via::Tokens => h.cover >= 0.6,
        },
    }
}
