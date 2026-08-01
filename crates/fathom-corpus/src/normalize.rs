//! Query/document normalisation, 16 §4. One function, compiled once, used by
//! the index builder and the query path — the builder and the runtime link
//! this same module, which is the property §4 demands.
//!
//! Deviations from §4.1, stated: step 1 (NFKC) is not implemented — the corpus
//! is ASCII and this workspace carries no Unicode tables and no dependencies;
//! non-ASCII input passes through simple-lowercased, unchanged otherwise.

use std::collections::{BTreeMap, BTreeSet};

/// §4.1 step 8 — shape classification.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Shape {
    Ip4,
    Ip6,
    Prefix,
    Integer,
    Identifier,
    Word,
}

impl Shape {
    /// Does a token of this shape satisfy a slot `accepts` name (61 §5)?
    /// `Identifier` accepts plain words too — VPN names are often pure alpha.
    pub fn accepts(self, accept: &str) -> bool {
        match accept {
            "Any" => true,
            "Ip4" => self == Shape::Ip4,
            "Ip6" => self == Shape::Ip6,
            "Prefix" => self == Shape::Prefix,
            "Integer" => self == Shape::Integer,
            "Identifier" => matches!(self, Shape::Identifier | Shape::Word),
            "Word" => self == Shape::Word,
            _ => false,
        }
    }
}

/// A sub-token part of a hyphen/dot token (§4.1 step 7), emitted at 0.6.
#[derive(Debug, Clone)]
pub struct Part {
    pub text: String,
    pub lemma: String,
}

/// A whole token of the normalised stream.
#[derive(Debug, Clone)]
pub struct Token {
    /// Original spelling (case preserved) — reverse capture renders this.
    pub raw: String,
    /// Lowercased text.
    pub text: String,
    /// Conservatively lemmatised text (§4.2).
    pub lemma: String,
    /// Sub-token parts at the 0.6 multiplier (§4.1 step 7).
    pub parts: Vec<Part>,
    /// §4.3 — marked, never removed.
    pub stopword: bool,
    pub shape: Shape,
}

#[derive(Debug, Clone)]
pub struct Normalized {
    pub tokens: Vec<Token>,
    /// Everything from the first ` | ` — held aside, not tokenised (§4.1
    /// step 5).
    pub filter: Option<String>,
}

/// §4.3 — about 60 words. Excluded from BM25 and from `g_syn`'s denominator,
/// retained in the token stream because concept surfaces need them. Negation
/// words (`not`, `no`, `down`, …) are deliberately absent: they participate in
/// surfaces as content.
const STOPWORDS: &[&str] = &[
    "a", "an", "the", "is", "are", "was", "were", "be", "been", "being", "am", "if", "i", "my",
    "me", "we", "our", "us", "you", "your", "it", "its", "this", "that", "these", "those", "to",
    "of", "in", "on", "at", "for", "with", "from", "by", "as", "do", "does", "did", "how", "what",
    "which", "who", "whom", "when", "where", "can", "could", "should", "would", "will", "shall",
    "there", "here", "has", "have", "had", "and", "or", "but", "than", "then", "so", "any", "some",
];

/// §4.2's authored override table — the words where the mechanical rule is
/// wrong. Small by design; every miss is one line here rather than an
/// algorithm discussion. (The generic double-s guard below covers the
/// `address`/`process` class wholesale.)
const LEMMA_OVERRIDES: &[(&str, &str)] = &[
    ("statistics", "statistics"),
    ("associations", "association"),
    ("establishes", "establish"),
    ("established", "establish"),
    ("establishing", "establish"),
    ("routes", "route"),
    ("zones", "zone"),
    ("policies", "policy"),
];

/// Lexicons the lemmatiser consults (§4.2). `identifier` is generated at
/// index-build time from every whole token in any entry's `cmd` and every
/// `output_fields` name — never guessed.
#[derive(Debug, Clone, Default)]
pub struct Lexicons {
    pub identifier: BTreeSet<String>,
    pub lemma_overrides: BTreeMap<String, String>,
    pub stopwords: BTreeSet<String>,
}

impl Lexicons {
    pub fn new(identifier: BTreeSet<String>) -> Lexicons {
        Lexicons {
            identifier,
            lemma_overrides: LEMMA_OVERRIDES
                .iter()
                .map(|(a, b)| ((*a).to_owned(), (*b).to_owned()))
                .collect(),
            stopwords: STOPWORDS.iter().map(|s| (*s).to_owned()).collect(),
        }
    }
}

/// §4.2 — conservative suffix stripping, never a general stemmer.
pub fn lemma(tok: &str, lex: &Lexicons) -> String {
    if lex.identifier.contains(tok) {
        return tok.to_owned();
    }
    if !tok.bytes().all(|b| b.is_ascii_alphabetic()) {
        return tok.to_owned();
    }
    if tok.len() < 5 {
        return tok.to_owned();
    }
    if let Some(c) = lex.lemma_overrides.get(tok) {
        return c.clone();
    }
    for suffix in ["ies", "es", "ed", "ing", "s"] {
        if suffix == "s" && tok.ends_with("ss") {
            // `address`, `process`, `access` — stripping the final `s` of a
            // double-s word is always wrong; guarded here rather than one
            // override per word.
            continue;
        }
        if let Some(strip) = tok.strip_suffix(suffix) {
            if strip.len() >= 3 {
                let mut stem = strip.to_owned();
                if suffix == "ies" {
                    stem.push('y');
                }
                if let Some(c) = lex.lemma_overrides.get(&stem) {
                    return c.clone();
                }
                return stem;
            }
        }
    }
    tok.to_owned()
}

fn classify(text: &str) -> Shape {
    let b = text.as_bytes();
    if b.is_empty() {
        return Shape::Word;
    }
    if b.iter().all(|c| c.is_ascii_digit()) {
        return Shape::Integer;
    }
    if let Some((addr, len)) = text.split_once('/') {
        if is_ip4(addr) && !len.is_empty() && len.bytes().all(|c| c.is_ascii_digit()) {
            return Shape::Prefix;
        }
    }
    if is_ip4(text) {
        return Shape::Ip4;
    }
    if text.contains(':')
        && b.iter()
            .all(|c| c.is_ascii_hexdigit() || *c == b':' || *c == b'.')
    {
        return Shape::Ip6;
    }
    if b.iter().all(|c| c.is_ascii_alphabetic()) {
        return Shape::Word;
    }
    Shape::Identifier
}

fn is_ip4(s: &str) -> bool {
    let mut groups = 0;
    for g in s.split('.') {
        if g.is_empty() || g.len() > 3 || !g.bytes().all(|c| c.is_ascii_digit()) {
            return false;
        }
        if g.parse::<u32>().map(|v| v > 255).unwrap_or(true) {
            return false;
        }
        groups += 1;
    }
    groups == 4
}

/// Strip a leading device prompt (`user@srx-a>`, `srx-a#`, `(config)#`) —
/// §4.1 step 3 — then a leading `run ` (step 4).
fn strip_prompt(input: &str) -> &str {
    let s = input.trim_start();
    let b = s.as_bytes();
    let mut i = 0;
    while i < b.len() {
        let c = b[i];
        if c.is_ascii_alphanumeric()
            || c == b'_'
            || c == b'.'
            || c == b'@'
            || c == b'-'
            || c == b'('
            || c == b')'
        {
            i += 1;
        } else {
            break;
        }
    }
    if i > 0 && i < b.len() && (b[i] == b'>' || b[i] == b'#') {
        s[i + 1..].trim_start()
    } else {
        s
    }
}

/// The normaliser, §4.1. Identical for index build and query — by
/// construction, since this is the only implementation.
pub fn normalize(input: &str, lex: &Lexicons) -> Normalized {
    let s = strip_prompt(input);
    let s = s.strip_prefix("run ").unwrap_or(s);
    let (body, filter) = match s.find(" | ") {
        Some(pos) => (&s[..pos], Some(s[pos + 3..].trim().to_owned())),
        None => (s, None),
    };

    let mut tokens = Vec::new();
    let mut cur = String::new();
    let flush = |cur: &mut String, tokens: &mut Vec<Token>| {
        if cur.is_empty() {
            return;
        }
        let raw = std::mem::take(cur);
        let text = raw.to_lowercase();
        let shape = classify(&text);
        let mut parts = Vec::new();
        if text.contains('-') || text.contains('.') {
            for p in text.split(['-', '.']) {
                if !p.is_empty() {
                    parts.push(Part {
                        lemma: lemma(p, lex),
                        text: p.to_owned(),
                    });
                }
            }
        }
        let lemma = lemma(&text, lex);
        let stopword = lex.stopwords.contains(text.as_str());
        tokens.push(Token {
            raw,
            text,
            lemma,
            parts,
            stopword,
            shape,
        });
    };
    for ch in body.chars() {
        // Split on whitespace and , ; " ' ( ) ? !  — never on - / . : _
        // (§4.1 step 6: those are inside identifiers).
        if ch.is_whitespace() || matches!(ch, ',' | ';' | '"' | '\'' | '(' | ')' | '?' | '!') {
            flush(&mut cur, &mut tokens);
        } else {
            cur.push(ch);
        }
    }
    flush(&mut cur, &mut tokens);
    Normalized { tokens, filter }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lex() -> Lexicons {
        let mut ids = BTreeSet::new();
        for t in ["ipsec", "ike", "statistics", "interfaces", "st0.0"] {
            ids.insert(t.to_owned());
        }
        Lexicons::new(ids)
    }

    #[test]
    fn prompt_and_pipe() {
        let n = normalize(
            "user@srx-a> show security ipsec security-associations | match Installed",
            &lex(),
        );
        assert_eq!(n.tokens[0].text, "show");
        assert_eq!(n.filter.as_deref(), Some("match Installed"));
        assert!(n.tokens.iter().all(|t| t.text != "match"));
    }

    #[test]
    fn sub_tokens_and_lemma() {
        let n = normalize("inactive-tunnels check tunnels associations", &lex());
        let t0 = &n.tokens[0];
        assert_eq!(t0.parts.len(), 2);
        assert_eq!(t0.parts[1].lemma, "tunnel");
        assert_eq!(n.tokens[2].lemma, "tunnel");
        assert_eq!(n.tokens[3].lemma, "association");
        // identifier lexicon protects domain tokens
        let n2 = normalize("statistics interfaces", &lex());
        assert_eq!(n2.tokens[0].lemma, "statistics");
        assert_eq!(n2.tokens[1].lemma, "interfaces");
    }

    #[test]
    fn double_s_guard() {
        let l = lex();
        assert_eq!(lemma("address", &l), "address");
        assert_eq!(lemma("process", &l), "process");
    }

    #[test]
    fn stopwords_marked_not_removed() {
        let n = normalize("check if a tunnel is up", &lex());
        assert_eq!(n.tokens.len(), 6);
        assert!(n.tokens[1].stopword && n.tokens[2].stopword && n.tokens[4].stopword);
        assert!(!n.tokens[5].stopword, "`up` is never a stopword");
    }

    #[test]
    fn shapes() {
        let n = normalize("203.0.113.10 10.2.0.0/16 42 vpn-b tunnel", &lex());
        let shapes: Vec<Shape> = n.tokens.iter().map(|t| t.shape).collect();
        assert_eq!(
            shapes,
            vec![
                Shape::Ip4,
                Shape::Prefix,
                Shape::Integer,
                Shape::Identifier,
                Shape::Word
            ]
        );
    }
}
