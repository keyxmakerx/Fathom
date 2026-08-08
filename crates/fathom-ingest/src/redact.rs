//! Stage 4 — **the gate** (`14` §9).
//!
//! *"NOTHING PASSES UNGATED."* Position is not negotiable: the gate runs after
//! shape and before bind, so no stage that produces anything durable has ever
//! held pre-redaction text. ADR-0002's amended invariant 3 is the contract —
//! *"A pasted capture may contain a credential; it is redacted at the ingest
//! gate and the unredacted text never reaches the encryptor."*
//!
//! Three structural properties ship here (`14` §9.1's table, slice half):
//! the graph side cannot hold a secret because `SecretPlaceholder` has no
//! text constructor; the capture text is private to [`RedactedCapture`],
//! which only this module constructs; and every stage after the gate reads
//! either that capture or the tree's post-gate segments, where a redacted
//! position holds marker text and carries the `redacted` flag.

use std::collections::BTreeSet;

use crate::dict::{self, Dictionary, Match, PathSeg, ValueSpec};
use crate::frame::{ByteSpan, LineOrdinal, LineOutcome, LogicalLine, Outcome};
use crate::lex::{self, TokenKind};
use crate::shape::{self, Stmt, StmtIdx, StmtTree, UnshapedLine};

/// Only the gate constructs one; the text field is private (14 §9.1's
/// "CaptureStore::insert takes a RedactedCapture" property, at this slice's
/// boundary).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RedactedCapture {
    text: String,
}

impl RedactedCapture {
    pub fn text(&self) -> &str {
        &self.text
    }

    pub(crate) fn seal(text: String) -> RedactedCapture {
        RedactedCapture { text }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DropManifest {
    pub entries: Vec<RedactionEntry>,
    /// 14 §9.6: user pre-redactions — bound, not counted as drops.
    pub already_redacted: Vec<LineOrdinal>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RedactionEntry {
    pub ordinal: LineOrdinal,
    pub span: ByteSpan, // of the marker, post-redaction
    pub label: RedactLabel,
    pub detectors: DetectorSet,
    /// 14 §9.5: for the in-session report only; the persistence layer must
    /// not store it. Enforced by doc comment now, by the store weld later.
    pub orig_len: u32,
}

/// Ingest-side labels. The first five mirror fathom_ir's SecretLabel
/// one-to-one; Unknown covers 14 §9.4's safety-net detections, which have no
/// graph-side label. Extending SecretLabel itself is WO-01 §7 trigger 5 —
/// owner/planning work, not this crate's.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RedactLabel {
    Psk,
    CertKey,
    SnmpCommunity,
    TacacsKey,
    Password,
    Unknown,
}

impl RedactLabel {
    pub fn to_secret_label(self) -> Option<fathom_ir::scalar::SecretLabel> {
        use fathom_ir::scalar::SecretLabel;
        Some(match self {
            RedactLabel::Psk => SecretLabel::Psk,
            RedactLabel::CertKey => SecretLabel::CertKey,
            RedactLabel::SnmpCommunity => SecretLabel::SnmpCommunity,
            RedactLabel::TacacsKey => SecretLabel::TacacsKey,
            RedactLabel::Password => SecretLabel::Password,
            RedactLabel::Unknown => return None,
        })
    }

    /// The marker token: psk, cert-key, snmp-community, tacacs-key,
    /// password, unknown.
    pub fn token(self) -> &'static str {
        match self {
            RedactLabel::Psk => "psk",
            RedactLabel::CertKey => "cert-key",
            RedactLabel::SnmpCommunity => "snmp-community",
            RedactLabel::TacacsKey => "tacacs-key",
            RedactLabel::Password => "password",
            RedactLabel::Unknown => "unknown",
        }
    }
}

/// Bit set over the detectors that fired (a value may be caught by several;
/// 14 §9.2: "redacted once and the manifest records both reasons").
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DetectorSet(pub u8);

impl DetectorSet {
    pub const PATH: u8 = 1;
    pub const CRYPT_PREFIX: u8 = 2;
    pub const PEM_ARMOUR: u8 = 4;
    pub const LONG_HEX: u8 = 8;
    pub const BASE64: u8 = 16;
    pub const LEAF_NAME: u8 = 32;
}

/// 14 §9.4's secret-word list, verbatim, case-folded, hyphens = underscores.
pub const SECRET_WORD_LIST: [&str; 24] = [
    "key",
    "keys",
    "key-string",
    "secret",
    "shared-secret",
    "password",
    "passwd",
    "plain-text-password",
    "encrypted-password",
    "psk",
    "pre-shared-key",
    "passphrase",
    "community",
    "snmp-community-string",
    "authentication-key",
    "auth-key",
    "md5",
    "hmac",
    "credential",
    "token",
    "bearer",
    "phash",
    "passhash",
    "private-key",
];

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

/// The marker written into the capture — unquoted, so the stored capture
/// cannot be pasted back into a box as working config (`14` §14.3).
fn marker(label: RedactLabel) -> String {
    format!("<REDACTED:{}>", label.token())
}

#[derive(Debug, Clone)]
struct Edit {
    start: u32,
    end: u32,
    text: String,
    ordinal: LineOrdinal,
    label: RedactLabel,
    detectors: u8,
    /// Set on a value redaction; the gate re-points this node's segment at a
    /// freshly interned marker (§4.6 rule 1).
    node: Option<StmtIdx>,
    /// Set on a quarantine: the whole line's outcome changes.
    quarantine: bool,
}

pub(crate) struct Gated {
    pub(crate) drops: DropManifest,
    /// Post-redaction span of every logical line, in ordinal order.
    pub(crate) spans: Vec<ByteSpan>,
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn gate(
    capture: &mut String,
    lines: &[LogicalLine],
    tree: &mut StmtTree,
    outcomes: &mut [Outcome],
    stmts: &[Stmt],
    unshaped: &[UnshapedLine],
    matches: &[Match],
    dict: &Dictionary,
) -> Gated {
    let mut edits: Vec<Edit> = Vec::new();
    let mut already: BTreeSet<u32> = BTreeSet::new();

    for (idx, stmt) in stmts.iter().enumerate() {
        let m = match matches.get(idx) {
            Some(m) => *m,
            None => continue,
        };
        gate_statement(capture, tree, dict, stmt, m, &mut edits, &mut already);
    }
    for line in unshaped {
        gate_unshaped(capture, dict, line, &mut edits);
    }

    // Deterministic, non-overlapping edit order. A bracket list expands into
    // several statements sharing their head tokens, so the same position can
    // be proposed twice; the first proposal stands.
    edits.sort_by_key(|e| (e.start, e.end));
    edits.dedup_by_key(|e| e.start);
    let mut kept: Vec<Edit> = Vec::new();
    for edit in edits {
        if kept.last().map(|k| k.end > edit.start).unwrap_or(false) {
            continue;
        }
        kept.push(edit);
    }

    // Rewrite the buffer, recording each marker's post-redaction span.
    let mut rebuilt = String::with_capacity(capture.len());
    let mut cursor = 0u32;
    let mut entries: Vec<RedactionEntry> = Vec::new();
    for edit in &kept {
        rebuilt.push_str(crate::frame::slice(
            capture,
            ByteSpan {
                start: cursor,
                end: edit.start,
            },
        ));
        let new_start = rebuilt.len() as u32;
        rebuilt.push_str(&edit.text);
        entries.push(RedactionEntry {
            ordinal: edit.ordinal,
            span: ByteSpan {
                start: new_start,
                end: rebuilt.len() as u32,
            },
            label: edit.label,
            detectors: DetectorSet(edit.detectors),
            orig_len: edit.end.saturating_sub(edit.start),
        });
        cursor = edit.end;
    }
    rebuilt.push_str(crate::frame::slice(
        capture,
        ByteSpan {
            start: cursor,
            end: capture.len() as u32,
        },
    ));
    *capture = rebuilt;

    // Every span recorded from here on is in post-redaction coordinates
    // (`14` §9.5).
    let spans: Vec<ByteSpan> = lines
        .iter()
        .map(|line| ByteSpan {
            start: remap(line.pieces.first().map(|p| p.start).unwrap_or(0), &kept),
            end: remap(line.pieces.last().map(|p| p.end).unwrap_or(0), &kept),
        })
        .collect();

    // The tree rewrite: a redacted position's segment is re-pointed at a
    // fresh marker segment and flagged. Never rewritten in place — interning
    // is shared, and a secret whose text collides with a literal segment used
    // elsewhere would otherwise corrupt unrelated statements (§4.6 rule 1).
    for edit in &kept {
        if let Some(StmtIdx(node)) = edit.node {
            let seg = shape::SegId(tree.segs.len() as u32);
            tree.segs.push(edit.text.clone());
            if let Some(n) = tree.arena.get_mut(node as usize) {
                n.seg = seg;
                n.redacted = Some(edit.label);
            }
        }
        if edit.quarantine {
            if let Some(o) = outcomes.get_mut(edit.ordinal.0 as usize) {
                o.outcome = LineOutcome::Quarantined {
                    label: edit.label,
                    orig_len: edit.end.saturating_sub(edit.start),
                };
            }
        }
    }

    Gated {
        drops: DropManifest {
            entries,
            already_redacted: already.into_iter().map(LineOrdinal).collect(),
        },
        spans,
    }
}

/// Old offset -> new offset. `kept` is sorted and non-overlapping, so the
/// shift at `pos` is the sum of the length changes strictly before it.
fn remap(pos: u32, kept: &[Edit]) -> u32 {
    let mut delta: i64 = 0;
    for edit in kept {
        if edit.end > pos {
            break;
        }
        delta += edit.text.len() as i64 - i64::from(edit.end - edit.start);
    }
    (i64::from(pos) + delta).max(0) as u32
}

fn gate_statement(
    capture: &str,
    tree: &StmtTree,
    dict: &Dictionary,
    stmt: &Stmt,
    m: Match,
    edits: &mut Vec<Edit>,
    already: &mut BTreeSet<u32>,
) {
    let segs: Vec<String> = stmt
        .path
        .iter()
        .map(|idx| shape::seg_text(tree, *idx).to_owned())
        .collect();

    // PEM armour quarantines the whole line: set-form Junos has no
    // framer-level block forms in scope, and quarantine errs toward
    // destruction, which is `14` §9.7's own stated direction of error.
    if segs.iter().any(|s| s.starts_with("-----BEGIN")) {
        edits.push(Edit {
            start: stmt.span.start,
            end: stmt.span.end,
            text: sketch(capture, dict, &stmt.tokens, &[]),
            ordinal: stmt.line,
            label: RedactLabel::CertKey,
            detectors: DetectorSet::PEM_ARMOUR,
            node: None,
            quarantine: true,
        });
        return;
    }

    let entry = m.entry.and_then(|e| dict.entry(e));
    // "Argument tokens": on a dictionary-matched statement the tokens its
    // captures consume plus the unconsumed trailing tokens; on an Unmapped
    // statement every token after the longest known prefix.
    let mut args: Vec<usize> = Vec::new();
    match entry {
        Some(e) => {
            for (idx, seg) in e.path.iter().enumerate() {
                if matches!(seg, PathSeg::Capture(_)) {
                    args.push(idx);
                }
            }
            for idx in m.consumed..segs.len() {
                args.push(idx);
            }
        }
        None => args.extend(m.known_prefix..segs.len()),
    }
    let secret_pos = entry.and_then(|e| e.secret.and_then(|_| e.secret_pos()));

    for at in args {
        let text = match segs.get(at) {
            Some(t) => t.as_str(),
            None => continue,
        };
        let mut detectors = 0u8;
        let mut label = RedactLabel::Unknown;
        if Some(at) == secret_pos {
            detectors |= DetectorSet::PATH;
            if let Some(l) = entry.and_then(|e| e.secret) {
                label = l;
            }
        }
        if crypt_prefix(text) {
            detectors |= DetectorSet::CRYPT_PREFIX;
        }
        if long_hex(text) {
            detectors |= DetectorSet::LONG_HEX;
        }
        // The base64 guard: `14` §9.4's three-condition rule keeps
        // fingerprints and descriptions alive. A statement the dictionary
        // matched is never "no better information".
        if entry.is_none() && base64ish(text) {
            detectors |= DetectorSet::BASE64;
        }
        let leaf_hit = match entry {
            Some(e) => {
                // The suppression the field card's own `perfect-forward-secrecy
                // keys group14` line forces (§12 item 2).
                !e.secret_exempt && dict::leaf_name_walk(&e.path, at)
            }
            None => raw_walk(&segs, at),
        };
        if leaf_hit {
            detectors |= DetectorSet::LEAF_NAME;
        }
        if detectors == 0 {
            continue;
        }
        if pre_redacted(text) {
            already.insert(stmt.line.0);
            continue;
        }
        let token = match stmt.tokens.get(at) {
            Some(t) => *t,
            None => continue,
        };
        edits.push(Edit {
            start: token.span.start,
            end: token.span.end,
            text: marker(label),
            ordinal: stmt.line,
            label,
            detectors,
            node: stmt.path.get(at).copied(),
            quarantine: false,
        });
    }
}

/// `14` §9.7's DECISION: an `Unshaped` line is run through the value-shape
/// detectors at token granularity, at maximum aggression, and a line that
/// trips any of them is quarantined — text destroyed, shape sketch stored.
fn gate_unshaped(capture: &str, dict: &Dictionary, line: &UnshapedLine, edits: &mut Vec<Edit>) {
    let texts: Vec<String> = line
        .tokens
        .iter()
        .map(|t| lex::interned_text(capture, t, &lex::JUNOS_SET))
        .collect();
    let mut detectors = 0u8;
    let mut label = RedactLabel::Unknown;
    for (at, text) in texts.iter().enumerate() {
        if text.starts_with("-----BEGIN") {
            detectors |= DetectorSet::PEM_ARMOUR;
            label = RedactLabel::CertKey;
        }
        if at < 2 {
            continue;
        }
        if crypt_prefix(text) {
            detectors |= DetectorSet::CRYPT_PREFIX;
        }
        if long_hex(text) {
            detectors |= DetectorSet::LONG_HEX;
        }
        if base64ish(text) {
            detectors |= DetectorSet::BASE64;
        }
        if raw_walk(&texts, at) {
            detectors |= DetectorSet::LEAF_NAME;
        }
    }
    if detectors == 0 {
        return;
    }
    edits.push(Edit {
        start: line.span.start,
        end: line.span.end,
        text: sketch(capture, dict, &line.tokens, &texts),
        ordinal: line.line,
        label,
        detectors,
        node: None,
        quarantine: true,
    });
}

/// §4.6's two-position leaf-name walk over raw tokens: no capture positions
/// are known, so every preceding token counts as a position.
fn raw_walk(texts: &[String], at: usize) -> bool {
    texts
        .iter()
        .take(at)
        .rev()
        .take(2)
        .any(|t| dict::is_secret_word(t))
}

/// `14` §9.7's sketch, verbatim: the first two tokens are kept only if
/// neither trips a detector and both are in the dictionary's known segment
/// set; every other token becomes `<word:LEN>` or `<quoted:LEN>`; no
/// character of any token beyond the second survives.
fn sketch(capture: &str, dict: &Dictionary, tokens: &[lex::Token], texts: &[String]) -> String {
    let text_at = |at: usize| -> String {
        texts
            .get(at)
            .cloned()
            .or_else(|| {
                tokens
                    .get(at)
                    .map(|t| lex::interned_text(capture, t, &lex::JUNOS_SET))
            })
            .unwrap_or_default()
    };
    let head_safe = tokens.len() >= 2
        && (0..2).all(|at| {
            let text = text_at(at);
            dict.is_known_segment(&text)
                && !crypt_prefix(&text)
                && !long_hex(&text)
                && !base64ish(&text)
                && !dict::is_secret_word(&text)
        });
    let mut out = String::new();
    for (at, token) in tokens.iter().enumerate() {
        if at > 0 {
            out.push(' ');
        }
        if head_safe && at < 2 {
            out.push_str(&text_at(at));
            continue;
        }
        let len = token.span.end.saturating_sub(token.span.start);
        match token.kind {
            TokenKind::Quoted => out.push_str(&format!("<quoted:{len}>")),
            _ => out.push_str(&format!("<word:{len}>")),
        }
    }
    out
}

/// `^\$[0-9a-z]{1,2}\$` — `$1$` md5crypt, `$5$`, `$6$`, `$8$`, `$9$`.
fn crypt_prefix(text: &str) -> bool {
    let rest = match text.strip_prefix('$') {
        Some(r) => r,
        None => return false,
    };
    let head: String = rest.chars().take_while(|c| *c != '$').collect();
    (1..=2).contains(&head.chars().count())
        && head
            .chars()
            .all(|c| c.is_ascii_digit() || c.is_ascii_lowercase())
        && rest.len() > head.len()
        && rest.get(head.len()..).map(|r| r.starts_with('$')) == Some(true)
}

/// `^[0-9a-fA-F]{32,}$` — 32 hex characters is 128 bits.
fn long_hex(text: &str) -> bool {
    text.chars().count() >= 32 && text.chars().all(|c| c.is_ascii_hexdigit())
}

/// `^[A-Za-z0-9+/]{24,}={0,2}$`.
fn base64ish(text: &str) -> bool {
    let body = text.trim_end_matches('=');
    let pad = text.chars().count() - body.chars().count();
    pad <= 2
        && body.chars().count() >= 24
        && body
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '+' || c == '/')
}

/// `14` §9.6: the value consists of ≤ 2 distinct characters, or matches
/// `^<[A-Za-z_ -]+>$`, or equals a placeholder our own emitter writes.
fn pre_redacted(text: &str) -> bool {
    if text.is_empty() {
        return true;
    }
    let distinct: BTreeSet<char> = text.chars().collect();
    if distinct.len() <= 2 {
        return true;
    }
    if text == "<PSK>" {
        return true;
    }
    let inner = text.strip_prefix('<').and_then(|t| t.strip_suffix('>'));
    match inner {
        Some(i) => {
            !i.is_empty()
                && i.chars()
                    .all(|c| c.is_ascii_alphabetic() || c == '_' || c == ' ' || c == '-')
        }
        None => false,
    }
}

/// True when this node's token was redacted by the gate. The flag, not the
/// marker text, is the authority (§4.6 rule 2).
pub(crate) fn is_redacted(tree: &StmtTree, idx: StmtIdx) -> Option<RedactLabel> {
    tree.arena.get(idx.0 as usize).and_then(|n| n.redacted)
}

/// The `SecretPlaceholder` a `secret_placeholder:` field spec constructs. It
/// takes the entry's label and never the argument's text — WO-01 §4.4's only
/// path into the type.
pub(crate) fn placeholder_of(spec: &ValueSpec) -> Option<fathom_ir::scalar::SecretPlaceholder> {
    match spec {
        ValueSpec::Secret { label } => Some(fathom_ir::scalar::SecretPlaceholder::new(*label)),
        _ => None,
    }
}

#[cfg(test)]
#[allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]
mod tests {
    use super::*;

    #[test]
    fn crypt_prefix_detector() {
        assert!(crypt_prefix("$9$abcdef"));
        assert!(crypt_prefix("$1$xyz"));
        assert!(!crypt_prefix("$$abc"));
        assert!(!crypt_prefix("aes-256-cbc"));
        assert!(!crypt_prefix("$abcd$x"));
    }

    #[test]
    fn long_hex_and_base64_detectors() {
        assert!(long_hex(&"a".repeat(32)));
        assert!(!long_hex(&"a".repeat(31)));
        assert!(!long_hex("zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz"));
        assert!(base64ish("QUJDREVGR0hJSktMTU5PUFFSU1RVVg=="));
        assert!(!base64ish("short"));
        assert!(!base64ish("has-a-hyphen-in-it-which-is-not-base64"));
    }

    #[test]
    fn pre_redaction_detector() {
        assert!(pre_redacted("<REDACTED>"));
        assert!(pre_redacted("<PSK>"));
        assert!(pre_redacted("xxxxxxxx"));
        assert!(pre_redacted("********"));
        assert!(!pre_redacted("$9$EXAMPLEnotARealKey01234"));
        assert!(!pre_redacted("aes-256-cbc"));
    }

    #[test]
    fn labels_map_onto_the_graph_side_one_for_one() {
        use fathom_ir::scalar::SecretLabel;
        assert_eq!(RedactLabel::Psk.to_secret_label(), Some(SecretLabel::Psk));
        assert_eq!(RedactLabel::Unknown.to_secret_label(), None);
        assert_eq!(
            marker(RedactLabel::SnmpCommunity),
            "<REDACTED:snmp-community>"
        );
    }

    #[test]
    fn secret_words_fold_hyphens_and_case() {
        assert!(dict::is_secret_word("Pre-Shared-Key"));
        assert!(dict::is_secret_word("pre_shared_key"));
        assert!(!dict::is_secret_word("ascii-text"));
    }
}
