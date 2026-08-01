//! The in-memory finder index, 16 §9's structures at seed-corpus scale: BM25F
//! postings over the §5.3 fields, the command-token prefix structures, the
//! concept maps. Everything iterates in a deterministic order — `BTreeMap`
//! and sorted `Vec` throughout, never a hash map (invariant 9).

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

use crate::concepts::{build_concept_table, ConceptTable};
use crate::detln::ln_milli;
use crate::load::{load_corpus, LoadError};
use crate::model::{Corpus, Entry, Risk, Status};
use crate::normalize::{normalize, Lexicons, Normalized};

/// The eight indexed fields, 16 §5.3. `explain.explained` and
/// `explain.teaching` are deliberately not indexed — see §5.3's rationale.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Field {
    Answers,
    Aka,
    ConceptLabels,
    Title,
    Cmd,
    ReadField,
    OutputMeans,
    ExplainTerse,
}

pub const FIELDS: [Field; 8] = [
    Field::Answers,
    Field::Aka,
    Field::ConceptLabels,
    Field::Title,
    Field::Cmd,
    Field::ReadField,
    Field::OutputMeans,
    Field::ExplainTerse,
];

impl Field {
    /// `boost_f` in milli (16 §5.3).
    pub fn boost_milli(self) -> u32 {
        match self {
            Field::Answers => 3000,
            Field::Aka => 2000,
            Field::ConceptLabels => 2500,
            Field::Title => 1500,
            Field::Cmd => 1000,
            Field::ReadField => 800,
            Field::OutputMeans => 500,
            Field::ExplainTerse => 400,
        }
    }

    /// `b_f` in milli (16 §5.3).
    pub fn b_milli(self) -> u32 {
        match self {
            Field::Answers => 750,
            Field::Aka => 300,
            Field::ConceptLabels => 300,
            Field::Title => 500,
            Field::Cmd => 300,
            Field::ReadField => 500,
            Field::OutputMeans => 750,
            Field::ExplainTerse => 750,
        }
    }
}

/// One term's postings: per-entry, per-field weighted term frequency in milli
/// (whole token = 1000, sub-token = 600 — §4.1 step 7 / §5.2 `sub_f`).
#[derive(Debug, Clone, Default)]
pub struct TermInfo {
    pub idf_milli: u32,
    pub df: u32,
    /// Sorted by entry ordinal.
    pub postings: Vec<(u32, [u32; 8])>,
}

/// One token of a command path: a literal, or a declared slot.
#[derive(Debug, Clone)]
pub enum CmdTok {
    Literal(String),
    /// Index into the entry's `slots`.
    Slot(usize),
}

#[derive(Debug, Clone)]
pub struct EntryMeta {
    pub risk: Risk,
    pub weight: i64,
    pub status: Status,
    /// The entry has a `requires:` that nothing in a workspace-less context
    /// can satisfy — 16 §8.3's −0.25.
    pub has_requires: bool,
    /// 16 §16.5: the unscoped form of a scoped Disruptive command. Reachable
    /// only when the query's syntax match reaches it directly; never a
    /// concept-match result.
    pub unscoped_gated: bool,
}

pub struct CorpusIndex {
    pub corpus: Corpus,
    pub concepts: ConceptTable,
    pub lexicons: Lexicons,
    /// BM25F term dictionary, deterministic iteration order.
    pub terms: BTreeMap<String, TermInfo>,
    /// Per entry, per field: length in milli-tokens.
    pub field_len_milli: Vec<[u32; 8]>,
    /// Per field: average length in milli-tokens over entries with the field.
    pub avgdl_milli: [u32; 8],
    /// Sorted (normalised command key, entry ordinal). Slot tokens render as
    /// their placeholder.
    pub cmd_keys: Vec<(String, u32)>,
    /// Per entry: the token path of its `cmd`.
    pub cmd_paths: Vec<Vec<CmdTok>>,
    /// Whole command tokens and their hyphen/dot sub-parts, raw normalised
    /// (unlemmatised) — matcher 2 and `g_syn` consult this.
    pub cmd_token_dict: BTreeSet<String>,
    /// Sorted unique command tokens for fuzzy candidate generation.
    pub cmd_token_list: Vec<String>,
    /// Trigram → indices into `cmd_token_list` (16 §6.3 step 1).
    pub trigrams: BTreeMap<[u8; 3], Vec<u32>>,
    /// Entry ordinal → sorted concept ordinals (concepts + symptoms).
    pub e2c: Vec<Vec<u32>>,
    /// Concept ordinal → sorted entry ordinals.
    pub c2e: Vec<Vec<u32>>,
    pub meta: Vec<EntryMeta>,
}

impl CorpusIndex {
    pub fn load(root: &Path) -> Result<CorpusIndex, LoadError> {
        let corpus = load_corpus(root)?;
        build_index(corpus).map_err(|m| LoadError {
            file: root.display().to_string(),
            line: 0,
            message: m,
        })
    }

    pub fn entry(&self, ord: u32) -> &Entry {
        &self.corpus.entries[ord as usize]
    }

    /// The command with slots rendered as their angle-bracket placeholders.
    pub fn display_cmd(&self, ord: u32) -> String {
        let e = self.entry(ord);
        let mut out = Vec::new();
        for tok in &self.cmd_paths[ord as usize] {
            match tok {
                CmdTok::Literal(s) => out.push(s.clone()),
                CmdTok::Slot(i) => out.push(e.slots[*i].placeholder.clone()),
            }
        }
        out.join(" ")
    }
}

/// Split a `cmd` string into its token path, resolving `{{slot}}` tokens.
fn cmd_path(e: &Entry) -> Result<Vec<CmdTok>, String> {
    let mut out = Vec::new();
    for raw in e.cmd.split_whitespace() {
        if let Some(name) = raw.strip_prefix("{{").and_then(|r| r.strip_suffix("}}")) {
            let idx = e
                .slots
                .iter()
                .position(|s| s.name == name)
                .ok_or_else(|| format!("{}: `{{{{{name}}}}}` has no slot declaration", e.id))?;
            out.push(CmdTok::Slot(idx));
        } else {
            out.push(CmdTok::Literal(raw.to_lowercase()));
        }
    }
    Ok(out)
}

fn accumulate(
    tf: &mut BTreeMap<String, [u32; 8]>,
    len: &mut [u32; 8],
    field: usize,
    n: &Normalized,
) {
    for tok in &n.tokens {
        if tok.stopword {
            continue;
        }
        tf.entry(tok.lemma.clone()).or_default()[field] += 1000;
        len[field] += 1000;
        for p in &tok.parts {
            tf.entry(p.lemma.clone()).or_default()[field] += 600;
            len[field] += 600;
        }
    }
}

pub fn build_index(corpus: Corpus) -> Result<CorpusIndex, String> {
    // --- lexicons: every whole token in any cmd, every output_fields name ---
    let empty = Lexicons::default();
    let mut identifier = BTreeSet::new();
    for e in &corpus.entries {
        for raw in e.cmd.split_whitespace() {
            if raw.starts_with("{{") {
                continue;
            }
            identifier.insert(raw.to_lowercase());
        }
        for of in &e.output_fields {
            for t in normalize(&of.field, &empty).tokens {
                identifier.insert(t.text);
            }
        }
    }
    let lexicons = Lexicons::new(identifier);

    // --- concept table (needs the lexicons for surface normalisation) -------
    let concepts = build_concept_table(&corpus, &lexicons)?;

    // --- e2c / c2e ----------------------------------------------------------
    let mut e2c: Vec<Vec<u32>> = Vec::with_capacity(corpus.entries.len());
    let mut c2e: Vec<Vec<u32>> = vec![Vec::new(); concepts.concepts.len()];
    for (eord, e) in corpus.entries.iter().enumerate() {
        let mut cs: Vec<u32> = e
            .concepts
            .iter()
            .chain(e.symptoms.iter())
            .filter_map(|cid| concepts.by_id.get(cid).copied())
            .collect();
        cs.sort_unstable();
        cs.dedup();
        for &c in &cs {
            c2e[c as usize].push(eord as u32);
        }
        e2c.push(cs);
    }
    for v in c2e.iter_mut() {
        v.sort_unstable();
        v.dedup();
    }

    // --- command structures -------------------------------------------------
    let mut cmd_paths = Vec::with_capacity(corpus.entries.len());
    let mut cmd_keys = Vec::with_capacity(corpus.entries.len());
    let mut cmd_token_dict = BTreeSet::new();
    for (eord, e) in corpus.entries.iter().enumerate() {
        let path = cmd_path(e)?;
        let mut key_parts = Vec::new();
        for tok in &path {
            match tok {
                CmdTok::Literal(s) => {
                    key_parts.push(s.clone());
                    cmd_token_dict.insert(s.clone());
                    if s.contains('-') || s.contains('.') {
                        for p in s.split(['-', '.']) {
                            if !p.is_empty() {
                                cmd_token_dict.insert(p.to_owned());
                            }
                        }
                    }
                }
                CmdTok::Slot(i) => key_parts.push(e.slots[*i].placeholder.clone()),
            }
        }
        cmd_keys.push((key_parts.join(" "), eord as u32));
        cmd_paths.push(path);
    }
    cmd_keys.sort();
    let cmd_token_list: Vec<String> = cmd_token_dict.iter().cloned().collect();
    let mut trigrams: BTreeMap<[u8; 3], Vec<u32>> = BTreeMap::new();
    for (i, term) in cmd_token_list.iter().enumerate() {
        for tri in padded_trigrams(term) {
            let v = trigrams.entry(tri).or_default();
            if v.last() != Some(&(i as u32)) {
                v.push(i as u32);
            }
        }
    }

    // --- BM25F postings -----------------------------------------------------
    let mut terms: BTreeMap<String, TermInfo> = BTreeMap::new();
    let mut field_len_milli = Vec::with_capacity(corpus.entries.len());
    for (eord, e) in corpus.entries.iter().enumerate() {
        let mut tf: BTreeMap<String, [u32; 8]> = BTreeMap::new();
        let mut len = [0u32; 8];
        accumulate(&mut tf, &mut len, 0, &normalize(&e.answers, &lexicons));
        for aka in &e.aka {
            accumulate(&mut tf, &mut len, 1, &normalize(aka, &lexicons));
        }
        for cord in &e2c[eord] {
            let label = concepts.get(*cord).label.clone();
            accumulate(&mut tf, &mut len, 2, &normalize(&label, &lexicons));
        }
        if let Some(t) = &e.title {
            accumulate(&mut tf, &mut len, 3, &normalize(t, &lexicons));
        }
        // Cmd field indexes literal tokens only — placeholders are not user
        // vocabulary.
        let literals: String = cmd_paths[eord]
            .iter()
            .filter_map(|t| match t {
                CmdTok::Literal(s) => Some(s.as_str()),
                CmdTok::Slot(_) => None,
            })
            .collect::<Vec<_>>()
            .join(" ");
        accumulate(&mut tf, &mut len, 4, &normalize(&literals, &lexicons));
        accumulate(&mut tf, &mut len, 5, &normalize(&e.read_field, &lexicons));
        for of in &e.output_fields {
            accumulate(&mut tf, &mut len, 6, &normalize(&of.means, &lexicons));
        }
        accumulate(
            &mut tf,
            &mut len,
            7,
            &normalize(&e.explain.terse, &lexicons),
        );
        for (term, tfs) in tf {
            terms
                .entry(term)
                .or_default()
                .postings
                .push((eord as u32, tfs));
        }
        field_len_milli.push(len);
    }
    let n_entries = corpus.entries.len() as u32;
    for info in terms.values_mut() {
        info.postings.sort_by_key(|(e, _)| *e);
        info.df = info.postings.len() as u32;
        // idf(t) = ln(1 + (N − df + 0.5)/(df + 0.5)), precomputed and
        // quantised (16 §5.2, §5.4).
        let df = f64::from(info.df);
        let n = f64::from(n_entries);
        info.idf_milli = ln_milli(1.0 + (n - df + 0.5) / (df + 0.5));
    }
    let mut avgdl_milli = [0u32; 8];
    for (f, slot) in avgdl_milli.iter_mut().enumerate() {
        let (mut sum, mut count) = (0u64, 0u64);
        for len in &field_len_milli {
            if len[f] > 0 {
                sum += u64::from(len[f]);
                count += 1;
            }
        }
        *slot = if count == 0 {
            1000
        } else {
            (sum / count) as u32
        };
    }

    // --- meta ---------------------------------------------------------------
    let mut meta = Vec::with_capacity(corpus.entries.len());
    for (eord, e) in corpus.entries.iter().enumerate() {
        let unscoped_gated = e.risk == Risk::Disruptive
            && e.slots.is_empty()
            && corpus.entries.iter().enumerate().any(|(o, other)| {
                o != eord
                    && other.platform == e.platform
                    && !other.scope_required.is_empty()
                    && starts_with_path(&cmd_paths[o], &cmd_paths[eord])
            });
        meta.push(EntryMeta {
            risk: e.risk,
            weight: e.weight,
            status: e.status,
            has_requires: !e.requires.is_empty(),
            unscoped_gated,
        });
    }

    Ok(CorpusIndex {
        corpus,
        concepts,
        lexicons,
        terms,
        field_len_milli,
        avgdl_milli,
        cmd_keys,
        cmd_paths,
        cmd_token_dict,
        cmd_token_list,
        trigrams,
        e2c,
        c2e,
        meta,
    })
}

/// Does `longer`'s literal prefix extend the whole of `shorter`'s literals?
fn starts_with_path(longer: &[CmdTok], shorter: &[CmdTok]) -> bool {
    if longer.len() <= shorter.len() {
        return false;
    }
    shorter
        .iter()
        .zip(longer.iter())
        .all(|(a, b)| match (a, b) {
            (CmdTok::Literal(x), CmdTok::Literal(y)) => x == y,
            _ => false,
        })
}

/// `$$token$$` character trigrams (16 §6.3 step 1).
pub fn padded_trigrams(term: &str) -> Vec<[u8; 3]> {
    let mut padded = Vec::with_capacity(term.len() + 4);
    padded.extend_from_slice(b"$$");
    padded.extend_from_slice(term.as_bytes());
    padded.extend_from_slice(b"$$");
    let mut out = Vec::new();
    for w in padded.windows(3) {
        out.push([w[0], w[1], w[2]]);
    }
    out
}
