//! Matcher 3 — concept, 16 §7, with §3.3's leftmost-longest surface matching
//! and §3.4's breadth resolution.
//!
//! Scoring uses the pre-breadth query concepts with §7.2's one-hop traversal —
//! exactly how §12.6's worked numbers are computed. Derived (DERIVED-flagged)
//! narrower concepts widen candidate generation only; scoring through both
//! would double-count the same evidence (§12.4's note on `Z`).

use fathom_corpus::concepts::ConceptKind;
use fathom_corpus::index::CorpusIndex;
use fathom_corpus::normalize::Normalized;

#[derive(Debug, Clone)]
pub struct QueryConcept {
    pub ord: u32,
    pub conf_milli: u16,
    pub derived: bool,
}

#[derive(Debug, Clone, Default)]
pub struct ConceptQuery {
    pub concepts: Vec<QueryConcept>,
    /// Broad State concepts found by §3.4 — the ladder-group trigger (§17.3).
    pub broad: Vec<u32>,
}

/// §3.3 — exact, leftmost-longest, over n-gram windows of the lemma stream,
/// max 4-gram. A token consumed by a longer surface is not reconsidered.
pub fn surface_match(idx: &CorpusIndex, n: &Normalized) -> ConceptQuery {
    let lemmas: Vec<&str> = n.tokens.iter().map(|t| t.lemma.as_str()).collect();
    let mut found: Vec<QueryConcept> = Vec::new();
    let mut i = 0usize;
    while i < lemmas.len() {
        let mut advanced = false;
        for k in (1..=4usize.min(lemmas.len() - i)).rev() {
            let phrase = lemmas[i..i + k].join(" ");
            if let Some(hits) = idx.concepts.phrase_table.get(&phrase) {
                for &(ord, conf) in hits {
                    found.push(QueryConcept {
                        ord,
                        conf_milli: conf,
                        derived: false,
                    });
                }
                i += k;
                advanced = true;
                break;
            }
        }
        if !advanced {
            i += 1;
        }
    }
    // Dedup by concept, keeping the highest confidence, ordered by ordinal.
    found.sort_by_key(|q| (q.ord, std::cmp::Reverse(q.conf_milli)));
    found.dedup_by_key(|q| q.ord);

    let mut query = ConceptQuery {
        concepts: found,
        broad: Vec::new(),
    };
    breadth_resolve(idx, &mut query);
    query
}

/// §3.4 — when a State concept in Q is broad (≥2 narrower concepts with
/// entries) and Q carries an Object concept, expand: narrower concepts enter
/// Q as DERIVED at conf × 0.6. Nothing is excluded on a guess.
fn breadth_resolve(idx: &CorpusIndex, q: &mut ConceptQuery) {
    let has_object = q
        .concepts
        .iter()
        .any(|c| idx.concepts.get(c.ord).kind == ConceptKind::Object);
    if !has_object {
        return;
    }
    let mut derived: Vec<QueryConcept> = Vec::new();
    for qc in &q.concepts {
        let c = idx.concepts.get(qc.ord);
        if c.kind != ConceptKind::State || c.narrower.len() < 2 {
            continue;
        }
        let carried: Vec<u32> = c
            .narrower
            .iter()
            .copied()
            .filter(|&nw| !idx.c2e[nw as usize].is_empty())
            .collect();
        if carried.len() < 2 {
            continue;
        }
        q.broad.push(qc.ord);
        for nw in carried {
            derived.push(QueryConcept {
                ord: nw,
                conf_milli: (u32::from(qc.conf_milli) * 600 / 1000) as u16,
                derived: true,
            });
        }
    }
    for d in derived {
        if !q.concepts.iter().any(|c| c.ord == d.ord) {
            q.concepts.push(d);
        }
    }
    q.broad.sort_unstable();
    q.broad.dedup();
}

fn intersects(a: &[u32], b: &[u32]) -> bool {
    let (mut i, mut j) = (0usize, 0usize);
    while i < a.len() && j < b.len() {
        match a[i].cmp(&b[j]) {
            std::cmp::Ordering::Less => i += 1,
            std::cmp::Ordering::Greater => j += 1,
            std::cmp::Ordering::Equal => return true,
        }
    }
    false
}

/// §7.2 — entry match strength. Highest applicable wins; one hop only.
pub fn match_strength(idx: &CorpusIndex, concept: u32, e2c: &[u32]) -> f64 {
    if e2c.binary_search(&concept).is_ok() {
        return 1.0;
    }
    let c = idx.concepts.get(concept);
    if intersects(&c.narrower, e2c) || intersects(&c.broader, e2c) {
        return 0.60;
    }
    if intersects(&c.related, e2c) {
        return 0.35;
    }
    if let Some(op) = c.opposite {
        if e2c.binary_search(&op).is_ok() {
            return 0.30;
        }
    }
    0.0
}

/// §7.3 — C(e) with the object gate. Returns (C, per-concept rows for
/// `--why`: (concept ord, conf·icf·match contribution)).
pub fn concept_score(
    idx: &CorpusIndex,
    q: &ConceptQuery,
    entry: u32,
    why: Option<&mut Vec<(u32, f64)>>,
) -> f64 {
    let e2c = &idx.e2c[entry as usize];
    let mut z = 0.0f64;
    let mut num = 0.0f64;
    let mut object_present = false;
    let mut object_matched = false;
    let mut rows = Vec::new();
    for qc in &q.concepts {
        if qc.derived {
            continue; // candidate generation only — see module docs
        }
        let c = idx.concepts.get(qc.ord);
        let conf = f64::from(qc.conf_milli) / 1000.0;
        let icf = f64::from(c.icf_milli) / 1000.0;
        z += conf * icf;
        let m = match_strength(idx, qc.ord, e2c);
        if c.kind == ConceptKind::Object {
            object_present = true;
            if m > 0.0 {
                object_matched = true;
            }
        }
        if m > 0.0 {
            num += conf * icf * m;
            rows.push((qc.ord, conf * icf * m));
        }
    }
    if z == 0.0 {
        return 0.0;
    }
    let gate = if !object_present || object_matched {
        1.0
    } else {
        0.35
    };
    if let Some(out) = why {
        *out = rows;
    }
    (num / z) * gate
}
