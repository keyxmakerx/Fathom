//! The concept layer, 16 §3, built from what the seed corpus actually
//! carries: entry `concepts:`/`symptoms:` sets, the bundle's `new_concepts`
//! declarations, the explainer concept documents (labels), the crate's seed
//! concept graph (`seed_concepts.yaml` — transcribed from 16 §3.2/§12 and
//! 61 §8, pending the authored `corpus/concepts/` tree), and `aka:` harvesting
//! per 16 §3.6 (exact, lowercased phrases at a fixed harvest confidence — no
//! invented stems).

use std::collections::BTreeMap;

use fathom_schema::subset::{parse_profile, Profile};
use fathom_schema::value::Value;

use crate::detln::ln_milli;
use crate::model::Corpus;
use crate::normalize::{normalize, Lexicons};

pub const SEED_CONCEPTS: &str = include_str!("seed_concepts.yaml");

/// 16 §3.1 — not decoration: §7.3 gates on `Object`, §3.4 resolves breadth on
/// `State`, §11 picks ladder entry points from `Action`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConceptKind {
    Object,
    State,
    Action,
    Attribute,
    Symptom,
    Phase,
}

impl ConceptKind {
    fn parse(s: &str) -> Option<ConceptKind> {
        match s {
            "object" => Some(ConceptKind::Object),
            "state" => Some(ConceptKind::State),
            "action" => Some(ConceptKind::Action),
            "attribute" => Some(ConceptKind::Attribute),
            "symptom" => Some(ConceptKind::Symptom),
            "phase" => Some(ConceptKind::Phase),
            _ => None,
        }
    }
}

#[derive(Debug, Clone)]
pub struct Surface {
    /// Normalised, lemma-joined phrase (≤ 4 tokens).
    pub text: String,
    pub conf_milli: u16,
}

#[derive(Debug, Clone)]
pub struct Concept {
    pub id: String,
    pub kind: ConceptKind,
    pub label: String,
    pub surfaces: Vec<Surface>,
    pub narrower: Vec<u32>,
    pub broader: Vec<u32>,
    pub related: Vec<u32>,
    pub opposite: Option<u32>,
    /// Direct carriers in the corpus.
    pub entry_count: u32,
    /// Precomputed, quantised (16 §5.4). Broad concepts with zero direct
    /// carriers take the union of their one-hop narrower carriers, so a
    /// query-side-only concept still has a finite, meaningful ICF.
    pub icf_milli: u32,
    /// True when the concept came from the crate seed rather than the corpus.
    pub seed: bool,
}

#[derive(Debug, Clone)]
pub struct ConceptTable {
    pub concepts: Vec<Concept>,
    pub by_id: BTreeMap<String, u32>,
    /// Surface phrase → (concept ord, conf_milli), values sorted by ord.
    pub phrase_table: BTreeMap<String, Vec<(u32, u16)>>,
}

impl ConceptTable {
    pub fn get(&self, ord: u32) -> &Concept {
        &self.concepts[ord as usize]
    }
}

/// Confidence assigned to a surface harvested mechanically from an entry's
/// `aka:` list (16 §3.6 lifts them as candidates; unreviewed harvest sits at
/// the floor 61 §8.2 permits).
const HARVEST_CONF_MILLI: u16 = 500;
/// Confidence of the mechanical surface derived from a concept id's own name
/// segment (`obj.ike-gateway` → "ike gateway").
const NAME_CONF_MILLI: u16 = 900;

fn kind_from_prefix(path: &str) -> ConceptKind {
    let prefix = path.split('.').next().unwrap_or("");
    match prefix {
        "obj" => ConceptKind::Object,
        "act" => ConceptKind::Action,
        "attr" => ConceptKind::Attribute,
        "symptom" => ConceptKind::Symptom,
        "phase" => ConceptKind::Phase,
        "state" | "p1" | "p2" | "dataplane" => ConceptKind::State,
        // Domain-topic concepts (`junos.…`, `ipsec.…`, `ike.…`) that join to
        // explainer documents: no ranking machinery keys on them, so the
        // neutral kind is Attribute. Recorded as a mapping decision.
        _ => ConceptKind::Attribute,
    }
}

fn add_surface(surfaces: &mut Vec<Surface>, text: String, conf_milli: u16) {
    if text.is_empty() {
        return;
    }
    if let Some(existing) = surfaces.iter_mut().find(|s| s.text == text) {
        if existing.conf_milli < conf_milli {
            existing.conf_milli = conf_milli;
        }
        return;
    }
    surfaces.push(Surface { text, conf_milli });
}

/// Normalise a surface phrase exactly as queries are normalised, and join the
/// whole-token lemmas — surface matching runs over the lemma stream, so both
/// sides go through the one normaliser.
fn norm_phrase(text: &str, lex: &Lexicons) -> Option<String> {
    let n = normalize(text, lex);
    if n.tokens.is_empty() || n.tokens.len() > 4 {
        return None;
    }
    Some(
        n.tokens
            .iter()
            .map(|t| t.lemma.as_str())
            .collect::<Vec<_>>()
            .join(" "),
    )
}

pub fn build_concept_table(corpus: &Corpus, lex: &Lexicons) -> Result<ConceptTable, String> {
    // 1. Collect the id universe in deterministic order: seed first (it is the
    //    graph), then declared, then referenced, then explainer-doc concepts.
    let seed = parse_profile(SEED_CONCEPTS, Profile::Corpus)
        .map_err(|e| format!("seed_concepts.yaml:{}: {}", e.line, e.message))?;
    let seed_list = seed
        .get("concepts")
        .and_then(|c| c.as_seq())
        .ok_or("seed_concepts.yaml: no `concepts` sequence")?;

    let mut by_id: BTreeMap<String, u32> = BTreeMap::new();
    let mut concepts: Vec<Concept> = Vec::new();
    let intern = |id: &str, concepts: &mut Vec<Concept>, by_id: &mut BTreeMap<String, u32>| {
        if let Some(&ord) = by_id.get(id) {
            return ord;
        }
        let ord = concepts.len() as u32;
        let path = id.strip_prefix("concept:").unwrap_or(id);
        let name = path.split('.').nth(1).unwrap_or(path);
        concepts.push(Concept {
            id: id.to_owned(),
            kind: kind_from_prefix(path),
            label: name.replace('-', " "),
            surfaces: Vec::new(),
            narrower: Vec::new(),
            broader: Vec::new(),
            related: Vec::new(),
            opposite: None,
            entry_count: 0,
            icf_milli: 0,
            seed: false,
        });
        by_id.insert(id.to_owned(), ord);
        ord
    };

    for item in seed_list {
        let id = item
            .get("id")
            .and_then(|v| v.as_str())
            .ok_or("seed concept without id")?;
        let ord = intern(id, &mut concepts, &mut by_id);
        let c = &mut concepts[ord as usize];
        c.seed = true;
        if let Some(k) = item.get("kind").and_then(|v| v.as_str()) {
            c.kind = ConceptKind::parse(k).ok_or_else(|| format!("{id}: bad kind `{k}`"))?;
        }
        if let Some(l) = item.get("label").and_then(|v| v.as_str()) {
            c.label = l.to_owned();
        }
        if let Some(surfs) = item.get("surfaces").and_then(|v| v.as_seq()) {
            for s in surfs {
                let text = s
                    .get("text")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| format!("{id}: surface without text"))?;
                let conf = match s.get("conf").map(|v| &v.value) {
                    Some(Value::Float(f)) => (*f * 1000.0 + 0.5) as u16,
                    Some(Value::Int(i)) => (*i * 1000) as u16,
                    _ => return Err(format!("{id}: surface without conf")),
                };
                if let Some(phrase) = norm_phrase(text, lex) {
                    add_surface(&mut concepts[ord as usize].surfaces, phrase, conf);
                }
            }
        }
    }
    // Seed relations, second pass so targets intern deterministically after
    // all seed concepts exist.
    for item in seed_list {
        let id = item.get("id").and_then(|v| v.as_str()).unwrap_or_default();
        let ord = by_id[id];
        for key in ["narrower", "broader", "related"] {
            if let Some(seq) = item.get(key).and_then(|v| v.as_seq()) {
                for t in seq {
                    if let Some(tid) = t.as_str() {
                        let tord = intern(tid, &mut concepts, &mut by_id);
                        match key {
                            "narrower" => concepts[ord as usize].narrower.push(tord),
                            "broader" => concepts[ord as usize].broader.push(tord),
                            _ => concepts[ord as usize].related.push(tord),
                        }
                    }
                }
            }
        }
        if let Some(tid) = item.get("opposite").and_then(|v| v.as_str()) {
            let tord = intern(tid, &mut concepts, &mut by_id);
            concepts[ord as usize].opposite = Some(tord);
        }
    }

    // Declared (bundle `new_concepts`) — fixes kinds for non-seed ids.
    for (category, path) in &corpus.declared_concepts.entries {
        let id = format!("concept:{path}");
        let ord = intern(&id, &mut concepts, &mut by_id);
        if !concepts[ord as usize].seed {
            if let Some(k) = ConceptKind::parse(category) {
                concepts[ord as usize].kind = k;
            }
        }
    }

    // Referenced by entries.
    for e in &corpus.entries {
        for cid in e.concepts.iter().chain(e.symptoms.iter()) {
            intern(cid, &mut concepts, &mut by_id);
        }
    }

    // Explainer concept documents supply labels for the domain-topic ids
    // (`explain:concept:junos.cluster-sa-anchoring` ↔
    // `concept:junos.cluster-sa-anchoring`).
    for ex in &corpus.explainers {
        if let Some(path) = ex.id.strip_prefix("explain:concept:") {
            let id = format!("concept:{path}");
            if let Some(&ord) = by_id.get(&id) {
                if let Some(t) = &ex.title {
                    concepts[ord as usize].label = t.clone();
                }
            }
        }
    }

    // 2. Mechanical name surfaces for every concept: the id's own name segment,
    //    both hyphenated (one token) and space-joined forms.
    for c in concepts.iter_mut() {
        let path = c.id.strip_prefix("concept:").unwrap_or(&c.id);
        let name = path.split('.').nth(1).unwrap_or(path);
        if let Some(p) = norm_phrase(name, lex) {
            add_surface(&mut c.surfaces, p, NAME_CONF_MILLI);
        }
        if name.contains('-') {
            if let Some(p) = norm_phrase(&name.replace('-', " "), lex) {
                add_surface(&mut c.surfaces, p, NAME_CONF_MILLI);
            }
        }
    }

    // 3. `aka:` harvest (16 §3.6): each aka phrase of ≤4 tokens becomes a
    //    surface of every concept the entry carries, at the harvest floor.
    for e in &corpus.entries {
        for aka in &e.aka {
            if let Some(phrase) = norm_phrase(aka, lex) {
                for cid in e.concepts.iter().chain(e.symptoms.iter()) {
                    if let Some(&ord) = by_id.get(cid) {
                        add_surface(
                            &mut concepts[ord as usize].surfaces,
                            phrase.clone(),
                            HARVEST_CONF_MILLI,
                        );
                    }
                }
            }
        }
    }

    // 4. Materialise reverse relations (61 §8.1: broader↔narrower consistency
    //    is fixed up at build with a warning-level gate elsewhere).
    let pairs: Vec<(u32, u32)> = concepts
        .iter()
        .enumerate()
        .flat_map(|(i, c)| c.narrower.iter().map(move |&n| (i as u32, n)))
        .collect();
    for (broad, narrow) in pairs {
        if !concepts[narrow as usize].broader.contains(&broad) {
            concepts[narrow as usize].broader.push(broad);
        }
    }
    let pairs: Vec<(u32, u32)> = concepts
        .iter()
        .enumerate()
        .flat_map(|(i, c)| c.broader.iter().map(move |&b| (i as u32, b)))
        .collect();
    for (narrow, broad) in pairs {
        if !concepts[broad as usize].narrower.contains(&narrow) {
            concepts[broad as usize].narrower.push(narrow);
        }
    }
    let opp: Vec<(u32, u32)> = concepts
        .iter()
        .enumerate()
        .filter_map(|(i, c)| c.opposite.map(|o| (i as u32, o)))
        .collect();
    for (a, b) in opp {
        if concepts[b as usize].opposite.is_none() {
            concepts[b as usize].opposite = Some(a);
        }
    }
    // Related is symmetric in lookup: materialise the reverse edge.
    let rel: Vec<(u32, u32)> = concepts
        .iter()
        .enumerate()
        .flat_map(|(i, c)| c.related.iter().map(move |&r| (i as u32, r)))
        .collect();
    for (a, b) in rel {
        if !concepts[b as usize].related.contains(&a) {
            concepts[b as usize].related.push(a);
        }
    }
    for c in concepts.iter_mut() {
        c.narrower.sort_unstable();
        c.narrower.dedup();
        c.broader.sort_unstable();
        c.broader.dedup();
        c.related.sort_unstable();
        c.related.dedup();
        c.surfaces.sort_by(|a, b| a.text.cmp(&b.text));
    }

    // 5. entry_count and ICF. Direct carriers; zero-carrier concepts fall back
    //    to the union of one-hop narrower carriers (a broad query-side concept
    //    must not divide by zero and must not dominate either).
    let n_entries = corpus.entries.len() as u32;
    let mut carriers: Vec<Vec<u32>> = vec![Vec::new(); concepts.len()];
    for (eord, e) in corpus.entries.iter().enumerate() {
        for cid in e.concepts.iter().chain(e.symptoms.iter()) {
            if let Some(&ord) = by_id.get(cid) {
                carriers[ord as usize].push(eord as u32);
            }
        }
    }
    for v in carriers.iter_mut() {
        v.sort_unstable();
        v.dedup();
    }
    for ord in 0..concepts.len() {
        let mut count = carriers[ord].len() as u32;
        if count == 0 {
            let mut union: Vec<u32> = Vec::new();
            for &nw in &concepts[ord].narrower {
                union.extend_from_slice(&carriers[nw as usize]);
            }
            union.sort_unstable();
            union.dedup();
            count = union.len() as u32;
        }
        concepts[ord].entry_count = carriers[ord].len() as u32;
        let denom = if count == 0 { n_entries.max(1) } else { count };
        concepts[ord].icf_milli = ln_milli(1.0 + f64::from(n_entries) / f64::from(denom));
    }

    // 6. Phrase table.
    let mut phrase_table: BTreeMap<String, Vec<(u32, u16)>> = BTreeMap::new();
    for (ord, c) in concepts.iter().enumerate() {
        for s in &c.surfaces {
            let v = phrase_table.entry(s.text.clone()).or_default();
            match v.iter_mut().find(|(o, _)| *o == ord as u32) {
                Some(slot) => slot.1 = slot.1.max(s.conf_milli),
                None => v.push((ord as u32, s.conf_milli)),
            }
        }
    }
    for v in phrase_table.values_mut() {
        v.sort_unstable();
    }

    Ok(ConceptTable {
        concepts,
        by_id,
        phrase_table,
    })
}
