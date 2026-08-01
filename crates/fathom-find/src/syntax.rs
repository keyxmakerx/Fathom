//! Matcher 2 — syntax, 16 §6, in the first-cut form the spec's §6.2 permits:
//! exact prefix over the sorted command-key list plus a per-token map with
//! trigram-filtered Jaro-Winkler fuzz at distance guards. Whole-command
//! Levenshtein runs at distance 1 only; distance 2 stays off (§6.3).

use std::collections::BTreeMap;

use fathom_corpus::index::{padded_trigrams, CmdTok, CorpusIndex};
use fathom_corpus::normalize::Normalized;

/// §6.3's guards, all necessary.
const MIN_FUZZY_LEN: usize = 4;
const MAX_FUZZY_TOKENS: usize = 2;
const JW_ACCEPT: f64 = 0.86;
const TRIGRAM_CANDIDATE_CAP: usize = 400;
const PREFIX_CAP: usize = 64;
const LEV1_CAP: usize = 32;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Via {
    Prefix,
    Tokens,
    Lev1,
}

#[derive(Debug, Clone, Copy)]
pub struct SyntaxHit {
    pub score: f64,
    pub via: Via,
    /// Fraction of query tokens aligned (token path only; 1.0 for prefix).
    pub cover: f64,
}

/// Jaro similarity, then Winkler's prefix boost: p = 0.1, prefix cap 4,
/// boost only when Jaro > 0.7 (16 §6.3, pinned so it cannot drift).
pub fn jaro_winkler(a: &str, b: &str) -> f64 {
    let jaro = jaro(a, b);
    if jaro > 0.7 {
        let l = a
            .bytes()
            .zip(b.bytes())
            .take(4)
            .take_while(|(x, y)| x == y)
            .count() as f64;
        jaro + 0.1 * l * (1.0 - jaro)
    } else {
        jaro
    }
}

fn jaro(a: &str, b: &str) -> f64 {
    let a: Vec<u8> = a.bytes().collect();
    let b: Vec<u8> = b.bytes().collect();
    if a.is_empty() || b.is_empty() {
        return 0.0;
    }
    let window = (a.len().max(b.len()) / 2).saturating_sub(1);
    let mut b_used = vec![false; b.len()];
    let mut matches = 0usize;
    let mut a_matched = Vec::with_capacity(a.len());
    for (i, &ca) in a.iter().enumerate() {
        let lo = i.saturating_sub(window);
        let hi = (i + window + 1).min(b.len());
        let mut hit = false;
        for j in lo..hi {
            if !b_used[j] && b[j] == ca {
                b_used[j] = true;
                matches += 1;
                hit = true;
                break;
            }
        }
        a_matched.push(hit);
    }
    if matches == 0 {
        return 0.0;
    }
    let matched_b: Vec<u8> = b_used
        .iter()
        .zip(b.iter())
        .filter(|(u, _)| **u)
        .map(|(_, c)| *c)
        .collect();
    let mut transpositions = 0usize;
    let mut k = 0usize;
    for (i, &ca) in a.iter().enumerate() {
        if a_matched[i] {
            if matched_b[k] != ca {
                transpositions += 1;
            }
            k += 1;
        }
    }
    let m = matches as f64;
    (m / a.len() as f64 + m / b.len() as f64 + (m - (transpositions / 2) as f64) / m) / 3.0
}

/// Bounded edit distance ≤ 1 between two strings.
pub fn within_one_edit(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    let (short, long) = if a.len() <= b.len() { (a, b) } else { (b, a) };
    if long.len() - short.len() > 1 {
        return false;
    }
    let mut i = 0;
    let mut j = 0;
    let mut edits = 0;
    while i < short.len() && j < long.len() {
        if short[i] == long[j] {
            i += 1;
            j += 1;
            continue;
        }
        edits += 1;
        if edits > 1 {
            return false;
        }
        if short.len() == long.len() {
            i += 1;
        }
        j += 1;
    }
    edits + (long.len() - j) + (short.len() - i) <= 1
}

/// §8.1's continuous gate: fraction of non-stopword tokens that are command
/// tokens, at half credit for strict prefixes of one.
pub fn g_syn(idx: &CorpusIndex, n: &Normalized) -> f64 {
    let mut hits = 0.0f64;
    let mut total = 0usize;
    for tok in &n.tokens {
        if tok.stopword {
            continue;
        }
        total += 1;
        if idx.cmd_token_dict.contains(&tok.text) {
            hits += 1.0;
        } else if is_strict_prefix_of_dict(idx, &tok.text) {
            hits += 0.5;
        }
    }
    if total == 0 {
        0.0
    } else {
        hits / total as f64
    }
}

fn is_strict_prefix_of_dict(idx: &CorpusIndex, tok: &str) -> bool {
    if tok.len() < 2 {
        return false;
    }
    idx.cmd_token_dict
        .range(tok.to_owned()..)
        .next()
        .map(|t| t.starts_with(tok) && t != tok)
        .unwrap_or(false)
}

/// Fuzzy candidates for one query token (16 §6.3): trigram recall filter,
/// Jaro-Winkler rescoring, accept ≥ 0.86, keep the best 3.
fn fuzzy_candidates(idx: &CorpusIndex, tok: &str) -> Vec<(String, f64)> {
    let mut counts: BTreeMap<u32, u32> = BTreeMap::new();
    for tri in padded_trigrams(tok) {
        if let Some(list) = idx.trigrams.get(&tri) {
            for &term in list {
                *counts.entry(term).or_default() += 1;
            }
        }
    }
    let mut scored: Vec<(String, f64)> = Vec::new();
    for (term_ord, shared) in counts {
        if shared < 2 {
            continue;
        }
        if scored.len() >= TRIGRAM_CANDIDATE_CAP {
            break;
        }
        let term = &idx.cmd_token_list[term_ord as usize];
        let jw = jaro_winkler(tok, term);
        if jw >= JW_ACCEPT {
            scored.push((term.clone(), jw));
        }
    }
    scored.sort_by(|a, b| {
        b.1.partial_cmp(&a.1)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| a.0.cmp(&b.0))
    });
    scored.truncate(3);
    scored
}

fn cmd_literals(idx: &CorpusIndex, entry: u32) -> Vec<&str> {
    idx.cmd_paths[entry as usize]
        .iter()
        .filter_map(|t| match t {
            CmdTok::Literal(s) => Some(s.as_str()),
            CmdTok::Slot(_) => None,
        })
        .collect()
}

/// (jw, matched a sub-part rather than the whole token). Sub-part matches
/// leave the cursor on the same cmd token so `sec assoc` can walk the two
/// halves of `security-associations` in order (§13's worked cover).
fn token_matches(query: &str, cmd_tok: &str, fuzzy: &[(String, f64)]) -> Option<(f64, bool)> {
    if query == cmd_tok {
        return Some((1.0, false));
    }
    // Sub-token comparison across hyphen/dot boundaries (§6.3's guard) and
    // strict prefixes count as matches at jw 1.0 (§13's worked cover).
    if cmd_tok.contains('-') || cmd_tok.contains('.') {
        for part in cmd_tok.split(['-', '.']) {
            if part == query || (query.len() >= 2 && part.starts_with(query)) {
                return Some((1.0, true));
            }
        }
    }
    if query.len() >= 2 && cmd_tok.starts_with(query) {
        return Some((1.0, false));
    }
    for (term, jw) in fuzzy {
        if term == cmd_tok {
            return Some((*jw, false));
        }
        if cmd_tok
            .split(['-', '.'])
            .any(|p| p == term.as_str() && p != cmd_tok)
        {
            return Some((*jw, true));
        }
    }
    None
}

/// The syntax matcher. Returns per-entry hits (best of §6.2 prefix, §6.4
/// token alignment, §6.3 whole-command Levenshtein-1).
pub fn syntax_hits(idx: &CorpusIndex, n: &Normalized, g: f64) -> BTreeMap<u32, SyntaxHit> {
    let mut hits: BTreeMap<u32, SyntaxHit> = BTreeMap::new();
    let mut upsert = |entry: u32, score: f64, via: Via, cover: f64| {
        let h = hits.entry(entry).or_insert(SyntaxHit {
            score: 0.0,
            via,
            cover,
        });
        if score > h.score {
            *h = SyntaxHit { score, via, cover };
        }
    };

    let q_joined = n
        .tokens
        .iter()
        .map(|t| t.text.as_str())
        .collect::<Vec<_>>()
        .join(" ");
    if q_joined.is_empty() {
        return hits;
    }

    // §6.2 exact prefix.
    let start = idx
        .cmd_keys
        .partition_point(|(k, _)| k.as_str() < q_joined.as_str());
    let mut prefix_entries: Vec<u32> = Vec::new();
    for (key, entry) in idx.cmd_keys.iter().skip(start).take(PREFIX_CAP) {
        if !key.starts_with(&q_joined) {
            break;
        }
        let score = 0.70 + 0.25 * (q_joined.len() as f64 / key.len() as f64);
        upsert(*entry, score, Via::Prefix, 1.0);
        prefix_entries.push(*entry);
    }

    // Token alignment over a candidate set: prefix hits plus entries opening
    // with the query's first non-stopword token (commands start with their
    // verb), plus Levenshtein-1 hits below.
    let qtoks: Vec<&fathom_corpus::normalize::Token> =
        n.tokens.iter().filter(|t| !t.stopword).collect();
    if !qtoks.is_empty() {
        // Fuzzy per token, §6.3's guards.
        let mut fuzzy: BTreeMap<&str, Vec<(String, f64)>> = BTreeMap::new();
        let mut fuzzed = 0usize;
        for t in &qtoks {
            if t.text.len() >= MIN_FUZZY_LEN && !idx.cmd_token_dict.contains(&t.text) {
                let c = fuzzy_candidates(idx, &t.text);
                if !c.is_empty() {
                    fuzzed += 1;
                    fuzzy.insert(t.text.as_str(), c);
                }
            }
        }
        if fuzzed > MAX_FUZZY_TOKENS {
            // Three misspelled tokens is a different query, not a typo.
            fuzzy.clear();
        }

        let first = qtoks[0].text.as_str();
        let mut candidates: Vec<u32> = prefix_entries.clone();
        let first_matches: Vec<String> = std::iter::once(first.to_owned())
            .chain(
                fuzzy
                    .get(first)
                    .map(|v| v.iter().map(|(t, _)| t.clone()).collect::<Vec<_>>())
                    .unwrap_or_default(),
            )
            .collect();
        for (eord, path) in idx.cmd_paths.iter().enumerate() {
            if let Some(CmdTok::Literal(t0)) = path.first() {
                if first_matches.iter().any(|f| f == t0) {
                    candidates.push(eord as u32);
                }
            }
        }
        candidates.sort_unstable();
        candidates.dedup();

        for entry in candidates {
            let ctoks = cmd_literals(idx, entry);
            let mut pos = 0usize;
            let mut matched = 0usize;
            let mut jw_sum = 0.0f64;
            let mut out_of_order = false;
            for qt in &qtoks {
                let fz = fuzzy
                    .get(qt.text.as_str())
                    .map(|v| v.as_slice())
                    .unwrap_or(&[]);
                let mut found = None;
                for (j, ct) in ctoks.iter().enumerate().skip(pos) {
                    if let Some((jw, sub)) = token_matches(&qt.text, ct, fz) {
                        found = Some((j, jw, sub, true));
                        break;
                    }
                }
                if found.is_none() {
                    for (j, ct) in ctoks.iter().enumerate().take(pos) {
                        if let Some((jw, sub)) = token_matches(&qt.text, ct, fz) {
                            found = Some((j, jw, sub, false));
                            break;
                        }
                    }
                }
                if let Some((j, jw, sub, in_order)) = found {
                    matched += 1;
                    jw_sum += jw;
                    if in_order {
                        // A sub-part match keeps the cursor on the same cmd
                        // token — the next query token may match its next part.
                        pos = if sub { j } else { j + 1 };
                    } else {
                        out_of_order = true;
                    }
                }
            }
            if matched > 0 {
                let cover = matched as f64 / qtoks.len() as f64;
                let mean_jw = jw_sum / matched as f64;
                let mut s = 0.60 * cover + 0.40 * mean_jw;
                if out_of_order {
                    s -= 0.15;
                }
                if s > 0.0 {
                    upsert(entry, s, Via::Tokens, cover);
                }
            }
        }
    }

    // §6.3 whole-command Levenshtein at distance 1 — only when the query has
    // ≥3 tokens and looks like a command.
    if n.tokens.len() >= 3 && g >= 0.5 {
        let mut found = 0usize;
        for (key, entry) in &idx.cmd_keys {
            if within_one_edit(&q_joined, key) {
                upsert(*entry, 0.55, Via::Lev1, 1.0);
                found += 1;
                if found >= LEV1_CAP {
                    break;
                }
            }
        }
    }

    hits
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn worked_jaro_winkler_pairs() {
        // 16 §6.3's hand-computed table, the design's own checkpoints.
        let jw = jaro_winkler("secuirty", "security");
        assert!((jw - 0.975).abs() < 0.005, "secuirty/security = {jw}");
        let jw = jaro_winkler("assoc", "associations");
        assert!((jw - 0.8833).abs() < 0.005, "assoc/associations = {jw}");
        let jw = jaro_winkler("ike", "ipsec");
        assert!(jw < 0.86, "ike must never fuzz into ipsec (got {jw})");
        assert!(jw < 0.70, "below the boost threshold too (got {jw})");
    }

    #[test]
    fn edit_distance_one() {
        assert!(within_one_edit("show security", "show security"));
        // The missing-space case §6.3 names.
        assert!(within_one_edit(
            "showsecurity ike sa",
            "show security ike sa"
        ));
        assert!(within_one_edit("show securty", "show security"));
        assert!(!within_one_edit("show secrty", "show security"));
    }
}
