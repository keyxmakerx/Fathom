//! Worked-trace-D machinery, 16 §15: the reverse query shape — a pasted
//! command resolves to its entry via a longest-prefix walk with typed
//! argument capture. Degradation is explicit, never silent: an unmatched
//! remainder is reported as "not in corpus", never guessed at.

use fathom_corpus::index::{CmdTok, CorpusIndex};
use fathom_corpus::normalize::Normalized;

/// §11 shape D's verb set.
const REVERSE_VERBS: &[&str] = &[
    "show",
    "set",
    "delete",
    "clear",
    "monitor",
    "ping",
    "traceroute",
    "request",
    "restart",
    "get",
    "diagnose",
    "execute",
    "display",
    "run",
    "configure",
    "commit",
];

#[derive(Debug, Clone)]
pub struct ReverseHit {
    pub entry: u32,
    /// (slot name, raw token as pasted).
    pub captures: Vec<(String, String)>,
    /// Every command token and every query token consumed.
    pub full: bool,
    pub matched_depth: usize,
    /// Query tokens the walk could not place — "not in corpus".
    pub leftover: Vec<String>,
}

fn walk_entry(idx: &CorpusIndex, entry: u32, n: &Normalized) -> Option<ReverseHit> {
    let e = idx.entry(entry);
    let path = &idx.cmd_paths[entry as usize];
    let mut captures = Vec::new();
    let mut qi = 0usize;
    let mut depth = 0usize;
    for tok in path {
        let Some(qt) = n.tokens.get(qi) else { break };
        match tok {
            CmdTok::Literal(lit) => {
                if &qt.text == lit {
                    qi += 1;
                    depth += 1;
                } else {
                    break;
                }
            }
            CmdTok::Slot(i) => {
                let slot = &e.slots[*i];
                if slot.accepts.iter().any(|a| qt.shape.accepts(a)) {
                    captures.push((slot.name.clone(), qt.raw.clone()));
                    qi += 1;
                    depth += 1;
                } else {
                    break;
                }
            }
        }
    }
    if depth == 0 {
        return None;
    }
    let leftover: Vec<String> = n.tokens[qi..].iter().map(|t| t.raw.clone()).collect();
    Some(ReverseHit {
        entry,
        captures,
        full: depth == path.len() && qi == n.tokens.len(),
        matched_depth: depth,
        leftover,
    })
}

/// Shape-D detection (§11): first non-stopword token is a command verb and
/// the query matches ≥2 tokens deep into some command path.
pub fn detect_and_resolve(idx: &CorpusIndex, n: &Normalized) -> Option<ReverseHit> {
    let first = n.tokens.iter().find(|t| !t.stopword)?;
    if !REVERSE_VERBS.contains(&first.text.as_str()) {
        return None;
    }
    let mut best: Option<ReverseHit> = None;
    for entry in 0..idx.cmd_paths.len() as u32 {
        if let Some(hit) = walk_entry(idx, entry, n) {
            let better = match &best {
                None => true,
                Some(b) => {
                    (
                        hit.full,
                        hit.matched_depth,
                        std::cmp::Reverse(&idx.entry(hit.entry).id),
                    ) > (
                        b.full,
                        b.matched_depth,
                        std::cmp::Reverse(&idx.entry(b.entry).id),
                    )
                }
            };
            if better {
                best = Some(hit);
            }
        }
    }
    match best {
        Some(hit) if hit.matched_depth >= 2 => Some(hit),
        _ => None,
    }
}
