//! The block-config front end — a switch's running or exported config in the
//! `interface …` / `vlan N` block style (TP-Link JetStream and Omada switches)
//! in, the same typed graph fragment out.
//!
//! # Why this is a front end, the way `iproute.rs` and `routeros.rs` are
//!
//! A block config sets context with an opener line (`interface
//! gigabitEthernet 1/0/1`, `vlan 10`) and the lines under it act on that
//! context (`switchport pvid 70`, `name "ISPLAN"`) until a separator line
//! (`#`) or the next opener ends it. No line is `set`-form. The move that
//! solved the other front ends solves it here too: **a line's meaning is
//! `(the opener's words, the line's words)`, and every one of those is real
//! bytes of the paste.** This module synthesises one statement per line from
//! them, and from that point on the dictionary trie, the redaction gate, the
//! binder, the line ledger and the residue list are the code every other
//! platform runs, unmodified.
//!
//! # The statement shape the dictionary sees
//!
//! ```text
//!   vlan 10                       [vlan, 10]
//!   name "ISPLAN"                 [vlan, 10, name, ISPLAN]
//!   #
//!   interface gigabitEthernet 1/0/1
//!                                 [interface, gigabitEthernet1/0/1]
//!   switchport pvid 70            [interface, gigabitEthernet1/0/1, switchport, pvid, 70]
//!   #
//!   hostname "SW_ALIANCA00"       [hostname, SW_ALIANCA00]
//! ```
//!
//! An interface's name is its type word and its number with the space between
//! them dropped (`gigabitEthernet1/0/1`, `vlan10`), because a name is one
//! word. A quoted value is one segment, read without its quotes.
//!
//! **Indentation is never read.** Every sample the README cites lost its
//! leading whitespace on the way to the page it was read from, so a block
//! ends only at a separator, `exit`, `end` or the next opener.
//!
//! # Secrets
//!
//! A line that carries a credential keyword ([`is_secret_word`]) becomes one
//! statement: its words up to the keyword, then **everything after the
//! keyword to the end of the line as a single segment, destroyed whatever any
//! detector says** (`redact::gate_with_forced`). No type digit, alphabet or
//! length is assumed: TP-Link prints `password 0 <clear>`, `password 7
//! <reversible>`, `secret 5 <hash>` and, in one real export, `secret` with no
//! digit at all (`corpus/dict/README-omada-sw.md`). Every line, shaped or
//! not, also goes to the gate's safety-net sweep before anything is stored.

use std::collections::BTreeMap;

use crate::bind;
use crate::dict::Dictionary;
use crate::frame::{
    self, ByteSpan, JoinKind, LineClass, LineOrdinal, LineOutcome, LogicalLine, Outcome, ShapeError,
};
use crate::lex::{Token, TokenKind};
use crate::redact;
use crate::shape::{SegId, Stmt, StmtIdx, StmtNode, StmtTree, UnshapedLine};
use crate::{CaptureScope, IngestOutput, IngestRefusal, ResidueEntry};

/// Words after which the rest of a line is a credential. Sources for each, by
/// vendor, are in `corpus/dict/README-omada-sw.md`.
const SECRET_WORDS: [&str; 18] = [
    "password",
    "secret",
    "key",
    "keystring",
    "cpwd",
    "epwd",
    "community",
    "community-group",
    "auth-md5",
    "auth-sha",
    "priv-des",
    "priv-aes128",
    "authkey",
    "privkey",
    "passphrase",
    "psk",
    "snmptrap",
    "wpa-psk",
];

/// A credential keyword: one of [`SECRET_WORDS`], or a word ending the way a
/// credential keyword does (`auth-sha-key`, `enable-password`), compared
/// without case.
fn is_secret_word(word: &str) -> bool {
    let w = word.to_ascii_lowercase();
    SECRET_WORDS.contains(&w.as_str())
        || ["password", "passwd", "secret", "-key", "pwd"]
            .iter()
            .any(|s| w.ends_with(s))
}

/// Openers: the words that start a block. `interface` and `vlan` take the rest
/// of the line as their context; the longer ones are matched whole.
const OPENERS: [&[&str]; 5] = [
    &["interface"],
    &["vlan"],
    &["line"],
    &["ip", "dhcp", "server", "pool"],
    &["ipv6", "dhcp", "server", "pool"],
];

/// Does this paste look like a TP-Link JetStream or Omada switch config?
///
/// Exact rather than fuzzy, like `iproute::looks_like_iproute`: after any
/// blank lines, prompts and the echoed command, the first line must be `!`
/// and the model in one word (`!T2600G-28TS`), and some later line must be a
/// bare `#` separator. Cisco's bare `!` lines and Ubiquiti's `!Current
/// Configuration:` do not pass.
///
/// Runs on raw bytes, before the UTF-8 check, because the caller has to choose
/// a dictionary first.
pub fn looks_like_tplink(paste: &[u8]) -> bool {
    let body = paste.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(paste);
    let Ok(text) = std::str::from_utf8(body) else {
        return false;
    };
    let mut lines = text.lines().map(str::trim);
    let first = lines.find(|l| !l.is_empty() && !is_prompt(l) && !is_command_echo(l));
    let Some(model) = first.and_then(|l| l.strip_prefix('!')) else {
        return false;
    };
    if model.is_empty() || model.contains(char::is_whitespace) || model.starts_with('!') {
        return false;
    }
    lines.any(|l| l == "#")
}

/// `T2600G-28TS#show running-config`, `SG3428>`: the switch's own prompt, as
/// oxidized's TP-Link model matches it (`[\w.@()-]+[#>]`), with or without
/// the command typed after it.
fn is_prompt(text: &str) -> bool {
    let Some(at) = text.find(['#', '>']) else {
        return false;
    };
    let name = text.get(..at).unwrap_or_default();
    !name.is_empty()
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_.@()-".contains(&b))
}

/// The command a terminal echoes above its output.
fn is_command_echo(text: &str) -> bool {
    let w: Vec<&str> = text.split_ascii_whitespace().collect();
    matches!(
        w.as_slice(),
        ["show", "running-config" | "startup-config", ..] | ["terminal", "length", ..]
    )
}

/// A line that only separates or frames: `#`, `!…`, `end`, `exit`.
fn is_separator(text: &str) -> bool {
    text.starts_with('#') && text.trim_start_matches('#').trim().is_empty()
        || text.starts_with('!')
        || text == "end"
        || text == "exit"
}

/// `Press any key to continue (Q to quit)`, the pager, possibly run together.
fn is_pager(text: &str) -> bool {
    let squashed: String = text.chars().filter(|c| !c.is_whitespace()).collect();
    squashed.starts_with("Pressanykeytocontinue")
}

/// One word, located in the capture. A quoted word's `text` and `span` are
/// what is inside its quotes; `raw` is where its first byte (the quote) is.
#[derive(Debug, Clone)]
struct Word {
    span: ByteSpan,
    raw: u32,
    text: String,
    quoted: bool,
}

fn words(capture: &str, span: ByteSpan) -> Vec<Word> {
    let text = frame::slice(capture, span);
    let at = |i: usize| span.start + i as u32;
    let mut out = Vec::new();
    let mut chars = text.char_indices().peekable();
    while let Some((i, c)) = chars.next() {
        if c.is_ascii_whitespace() {
            continue;
        }
        if c == '"' {
            let inner = i + 1;
            let mut end = text.len();
            for (j, d) in chars.by_ref() {
                if d == '"' {
                    end = j;
                    break;
                }
            }
            out.push(Word {
                span: ByteSpan {
                    start: at(inner),
                    end: at(end),
                },
                raw: at(i),
                text: text.get(inner..end).unwrap_or_default().to_owned(),
                quoted: true,
            });
            continue;
        }
        let mut end = text.len();
        while let Some(&(j, d)) = chars.peek() {
            if d.is_ascii_whitespace() {
                end = j;
                break;
            }
            chars.next();
        }
        out.push(Word {
            span: ByteSpan {
                start: at(i),
                end: at(end),
            },
            raw: at(i),
            text: text.get(i..end).unwrap_or_default().to_owned(),
            quoted: false,
        });
    }
    out
}

/// One physical line per logical line: these configs never wrap.
fn logical_lines(capture: &str) -> Vec<LogicalLine> {
    let mut lines = Vec::new();
    let mut start = 0u32;
    let mut spans = Vec::new();
    for (idx, _) in capture.char_indices().filter(|(_, c)| *c == '\n') {
        let at = idx as u32;
        spans.push(ByteSpan { start, end: at });
        start = at + 1;
    }
    spans.push(ByteSpan {
        start,
        end: capture.len() as u32,
    });
    for span in spans {
        let blank = frame::slice(capture, span).trim().is_empty();
        lines.push(LogicalLine {
            ordinal: LineOrdinal(lines.len() as u32),
            pieces: vec![span],
            join: JoinKind::None,
            class: if blank {
                LineClass::Blank
            } else {
                LineClass::Statement
            },
        });
    }
    lines
}

/// A path segment: its text and the bytes it was read from.
type Seg = (String, Token);

fn seg(w: &Word) -> Seg {
    (w.text.clone(), bare(w.span))
}

/// The opener a line starts, if it starts one: the context segments every
/// line under it is read with.
fn opener(ws: &[Word]) -> Option<Vec<Seg>> {
    let lead: Vec<&str> = ws.iter().map(|w| w.text.as_str()).collect();
    let words = OPENERS
        .iter()
        .find(|o| lead.len() > o.len() && lead.starts_with(o))?;
    let (head, rest) = ws.split_at(words.len());
    let mut out: Vec<Seg> = head.iter().map(seg).collect();
    match (words.first(), rest) {
        // `interface gigabitEthernet 1/0/1`: the name is one word.
        (Some(&"interface"), [kind, number]) if !kind.quoted && !number.quoted => {
            out.push((
                format!("{}{}", kind.text, number.text),
                bare(ByteSpan {
                    start: kind.span.start,
                    end: number.span.end,
                }),
            ));
        }
        _ => out.extend(rest.iter().map(seg)),
    }
    Some(out)
}

/// Where the credential on a line starts, as an index into its words: the
/// word after the first credential keyword, or, for `snmp-server host IP …`,
/// the word after the address (TP-Link prints the community there).
fn secret_from(ws: &[Word]) -> Option<usize> {
    if let [a, b, _, ..] = ws {
        if a.text == "snmp-server" && b.text == "host" {
            return Some(3);
        }
    }
    ws.iter()
        .position(|w| !w.quoted && is_secret_word(&w.text))
        .map(|at| at + 1)
}

/// The whole read: a block config in, an [`IngestOutput`] out, identical in
/// shape to what [`crate::ingest`] returns for a `set`-form paste.
pub fn ingest_blockcfg(paste: &[u8], dict: &Dictionary) -> Result<IngestOutput, IngestRefusal> {
    // `frame` for its refusals and its normalisation only; the lines are ours.
    let framed = frame::frame(paste)?;
    let mut capture = framed.capture;
    let lines = logical_lines(&capture);

    let mut tree = StmtTree {
        arena: Vec::new(),
        roots: Vec::new(),
        segs: Vec::new(),
    };
    let mut intern: BTreeMap<String, SegId> = BTreeMap::new();
    let mut outcomes: Vec<Outcome> = Vec::new();
    let mut stmts: Vec<Stmt> = Vec::new();
    let mut forced: Vec<(usize, usize)> = Vec::new();
    let mut unshaped: Vec<UnshapedLine> = Vec::new();
    let mut noise: Vec<UnshapedLine> = Vec::new();
    // The block in force: its opener's segments.
    let mut block: Option<Vec<Seg>> = None;

    for line in &lines {
        let span = line
            .pieces
            .first()
            .copied()
            .unwrap_or(ByteSpan { start: 0, end: 0 });
        if line.class == LineClass::Blank {
            outcomes.push(Outcome::new(LineOutcome::Blank));
            continue;
        }
        let ws = words(&capture, span);
        let toks: Vec<Token> = if ws.is_empty() {
            vec![bare(span)]
        } else {
            ws.iter().map(|w| bare(w.span)).collect()
        };
        // Every line goes to the sweep, shaped or not.
        noise.push(UnshapedLine {
            line: line.ordinal,
            span,
            tokens: toks.clone(),
        });
        let text = frame::slice(&capture, span).trim();

        if is_separator(text) {
            block = None;
            outcomes.push(Outcome::new(LineOutcome::Header { columns: 0 }));
            continue;
        }
        if is_pager(text) || is_command_echo(text) || (is_prompt(text) && !text.contains(' ')) {
            outcomes.push(Outcome::new(LineOutcome::Unmapped { known_prefix: 0 }));
            continue;
        }
        if is_prompt(text) {
            // A prompt with a command after it: swept, never read, and the
            // block it interrupts is over.
            block = None;
            unshaped.push(UnshapedLine {
                line: line.ordinal,
                span,
                tokens: toks,
            });
            outcomes.push(Outcome::new(LineOutcome::Unshaped {
                reason: ShapeError::NotVerbInitial,
            }));
            continue;
        }

        let mut path: Vec<Seg> = Vec::new();
        let mut secret = false;
        if let Some(open) = opener(&ws) {
            block = Some(open.clone());
            path = open;
        } else {
            if let Some(ctx) = &block {
                path.extend(ctx.iter().cloned());
            }
            match secret_from(&ws) {
                Some(from) => {
                    path.extend(ws.iter().take(from).map(seg));
                    if let Some(first) = ws.get(from) {
                        // The rest of the line, as bytes, quotes and all.
                        let tail = ByteSpan {
                            start: first.raw,
                            end: span.start + frame::slice(&capture, span).trim_end().len() as u32,
                        };
                        path.push((frame::slice(&capture, tail).to_owned(), bare(tail)));
                        secret = true;
                    }
                }
                None => path.extend(ws.iter().map(seg)),
            }
        }
        // An opener whose own line holds a credential (`line …` never does,
        // but nothing here assumes it) is caught by the sweep like any line.

        let mut nodes = Vec::new();
        let mut tokens = Vec::new();
        let last = path.len().saturating_sub(1);
        for (at, (t, tok)) in path.iter().enumerate() {
            nodes.push(node(
                &mut tree,
                &mut intern,
                t,
                span,
                line.ordinal,
                at == last,
            ));
            tokens.push(*tok);
        }
        if secret {
            forced.push((stmts.len(), last));
        }
        stmts.push(Stmt {
            line: line.ordinal,
            span,
            path: nodes,
            tokens,
            list_pos: 0,
        });
        outcomes.push(Outcome::new(LineOutcome::Unmapped { known_prefix: 0 }));
    }

    let matches = dict.match_statements(&tree, &stmts);
    let gated = redact::gate_with_forced(
        &mut capture,
        &lines,
        &mut tree,
        &mut outcomes,
        &stmts,
        &unshaped,
        &noise,
        &matches,
        dict,
        &forced,
    );
    let fragment = bind::bind(&tree, &stmts, &matches, dict, &mut outcomes);

    let mut ledger = frame::LineLedger {
        capture_len: 0,
        lines: Vec::new(),
    };
    frame::build_ledger(&mut ledger, &capture, &lines, &gated.spans, &outcomes);
    frame::assert_invariant_l(&ledger);

    let residue = ledger
        .lines
        .iter()
        .filter(|e| {
            matches!(
                e.outcome,
                LineOutcome::Unmapped { .. }
                    | LineOutcome::Unshaped { .. }
                    | LineOutcome::Quarantined { .. }
            )
        })
        .map(|e| ResidueEntry {
            ordinal: e.ordinal,
            span: e.span,
            outcome: e.outcome.clone(),
        })
        .collect();

    Ok(IngestOutput {
        capture: redact::RedactedCapture::seal(capture),
        ledger,
        residue,
        drops: gated.drops,
        fragment,
        scope: CaptureScope::Fragment,
        uses_groups: false,
        truncated: false,
    })
}

fn bare(span: ByteSpan) -> Token {
    Token {
        kind: TokenKind::Bare,
        span,
    }
}

/// One fresh arena node per path position per statement, for the reason
/// `csv.rs`'s `node` gives: the gate re-points a redacted node, and a shared
/// node would redact every statement that shares it.
fn node(
    tree: &mut StmtTree,
    intern: &mut BTreeMap<String, SegId>,
    text: &str,
    span: ByteSpan,
    line: LineOrdinal,
    terminal: bool,
) -> StmtIdx {
    let seg = match intern.get(text) {
        Some(s) => *s,
        None => {
            let s = SegId(tree.segs.len() as u32);
            tree.segs.push(text.to_owned());
            intern.insert(text.to_owned(), s);
            s
        }
    };
    let idx = StmtIdx(tree.arena.len() as u32);
    tree.arena.push(StmtNode {
        seg,
        parent: None,
        children: Vec::new(),
        span,
        line,
        terminal,
        redacted: None,
    });
    idx
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

    fn ws(line: &str) -> Vec<Word> {
        words(
            line,
            ByteSpan {
                start: 0,
                end: line.len() as u32,
            },
        )
    }

    #[test]
    fn the_sniff_is_exact() {
        assert!(looks_like_tplink(b"!T2600G-28TS\n#\nvlan 10\n"));
        assert!(looks_like_tplink(
            b"T2600G-28TS#show running-config\n!T2600G-28TS\n#\n"
        ));
        assert!(looks_like_tplink(b"\r\n!T1700G-28TQRev2\r\n#\r\n#\r\n"));
        assert!(!looks_like_tplink(b"!\nversion 15.2\n!\nhostname r1\n"));
        assert!(!looks_like_tplink(
            b"!Current Configuration:\n!\n!System Description \"USW-48P-500\"\n"
        ));
        assert!(!looks_like_tplink(b"!T2600G-28TS\nvlan 10\n"));
        assert!(!looks_like_tplink(b"set system host-name r1\n#\n"));
        assert!(!looks_like_tplink(b""));
    }

    #[test]
    fn a_quoted_word_is_one_word_without_its_quotes() {
        let w = ws("description \"two words\" after");
        assert_eq!(w.len(), 3);
        assert_eq!(w[1].text, "two words");
        assert!(w[1].quoted);
        assert_eq!(w[1].raw, 12);
        assert_eq!(w[2].text, "after");
        let open = ws("name \"never closed");
        assert_eq!(open[1].text, "never closed");
    }

    #[test]
    fn an_interface_name_is_one_word() {
        let o = opener(&ws("interface gigabitEthernet 1/0/1")).unwrap();
        assert_eq!(o.len(), 2);
        assert_eq!(o[1].0, "gigabitEthernet1/0/1");
        assert_eq!(o[1].1.span, ByteSpan { start: 10, end: 31 });
        let v = opener(&ws("vlan 10")).unwrap();
        assert_eq!(
            v.iter().map(|s| s.0.as_str()).collect::<Vec<_>>(),
            ["vlan", "10"]
        );
        assert!(opener(&ws("vlan")).is_none());
        assert!(opener(&ws("switchport pvid 70")).is_none());
    }

    #[test]
    fn a_credential_starts_after_its_keyword() {
        let at = |l: &str| secret_from(&ws(l));
        assert_eq!(
            at("user name admin privilege admin password 0 admin"),
            Some(6)
        );
        assert_eq!(at("user name admin privilege admin secret 5 $1$x"), Some(6));
        assert_eq!(at("enable admin password 7 ABCDEF"), Some(3));
        assert_eq!(at("snmp-server community public read-only"), Some(2));
        assert_eq!(
            at("snmp-server host 192.0.2.9 162 public smode v2c"),
            Some(3)
        );
        assert_eq!(at("radius-server host 192.0.2.5 key 0 sharedkey"), Some(4));
        assert_eq!(at("snmp-server user u1 local g1 cmode SHA cpwd x"), Some(8));
        assert_eq!(at("description \"password reset\""), None);
        assert_eq!(at("switchport pvid 70"), None);
        assert_eq!(at("service password-encryption"), None);
    }
}
