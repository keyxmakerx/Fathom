//! The iproute2 front end — what a Linux host prints about its own interfaces
//! (`ip addr`, `ip -d link`, and their `-o` one-line forms) in, the same typed
//! graph fragment out.
//!
//! # Why this is a front end, the way `csv.rs` and `routeros.rs` are
//!
//! `ip` prints numbered, indented records: a header line names the interface
//! (`2: eth0: <BROADCAST,UP,LOWER_UP> mtu 1500 …`) and the indented lines
//! under it carry its attributes (`inet 192.0.2.10/24 …`). No line is
//! `set`-form, which is why `corpus/dict/README-linux-host.md` found that the
//! core could not read it. The move that solved `csv.rs` and `routeros.rs`
//! solves it here too: **an attribute's meaning is `(the interface name, the
//! attribute word, its value)`, and every one of those is real bytes of the
//! paste.** This module synthesises one statement per attribute from them,
//! and from that point on the dictionary trie, the redaction gate, the binder,
//! the line ledger and the residue list are the code every other platform
//! runs, unmodified.
//!
//! # The statement shape the dictionary sees
//!
//! ```text
//!   9: bond0.10@bond0: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500 qdisc noqueue
//!       vlan protocol 802.1Q id 10 <REORDER_HDR>
//!       inet 10.10.10.1/24 brd 10.10.10.255 scope global bond0.10
//!
//!   [bond0.10]                         the record itself
//!   [bond0.10, UP]                     one per flag
//!   [bond0.10, mtu, 1500]              one per header pair
//!   [bond0.10, vlan, protocol, 802.1Q] one per pair, on a `vlan` line
//!   [bond0.10, vlan, id, 10]
//!   [bond0.10, inet, 10.10.10.1/24]    the first two words of an address line
//! ```
//!
//! The `@parent` half of a name (`bond0.10@bond0`, `veth0@if12`) is not part
//! of the name: `ip` prints it to say what the link rides on.
//!
//! # Only attribute lines this reader knows are shaped
//!
//! An indented line is read as an attribute only when its first word is one
//! of [`ATTRIBUTE_WORDS`]. Anything else under a record (`valid_lft …`,
//! `bridge_slave …`, or the output of another command pasted below, such as
//! `ip xfrm state`, whose `auth-trunc` and `enc` lines carry keys) yields no
//! statement. Every line, shaped or not, goes to the gate's safety-net sweep
//! before anything is stored, at the same aggression as any unshaped line.
//!
//! A shell prompt (`root@fw1:~# ip -d addr`) names the host. Its command is
//! swept like any other line.

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

/// Indented lines read as attributes. `link/…` (`link/ether`, `link/none`,
/// `link/loopback`) is matched by its prefix.
const ATTRIBUTE_WORDS: [&str; 4] = ["inet", "inet6", "altname", "vlan"];

/// Attribute lines that are a run of `key value` pairs after the first word.
/// The rest are read as their first two words only: an address line goes on
/// with flags (`dynamic`, `noprefixroute`) that are not pairs.
const PAIRED_ATTRIBUTES: [&str; 1] = ["vlan"];

/// Does this paste look like `ip addr` or `ip link` output?
///
/// Exact rather than fuzzy, like `csv::looks_like_rules_csv`: after any blank
/// lines and shell prompts, the first line must be a record header, an index
/// and a colon then a name, followed by either `: <` (the flags of the full
/// and `-o link` forms) or an `inet`/`inet6`/`link/` word (the `-o addr`
/// form).
///
/// Runs on raw bytes, before the UTF-8 check, because the caller has to choose
/// a dictionary first.
pub fn looks_like_iproute(paste: &[u8]) -> bool {
    let body = paste.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(paste);
    for raw in body.split(|b| *b == b'\n') {
        let line = raw.strip_suffix(b"\r").unwrap_or(raw);
        let Ok(text) = std::str::from_utf8(line) else {
            return false;
        };
        let text = text.trim();
        if text.is_empty() || prompt_host(text).is_some() || is_bare_prompt(text) {
            continue;
        }
        return header_shape(text);
    }
    false
}

/// `2: eth0: <…` or `2: eth0    inet …`.
fn header_shape(text: &str) -> bool {
    let mut words = text.split_ascii_whitespace();
    let (Some(index), Some(name), Some(third)) = (words.next(), words.next(), words.next()) else {
        return false;
    };
    if !is_index(index) {
        return false;
    }
    if name.ends_with(':') {
        third.starts_with('<') && third.ends_with('>')
    } else {
        third == "inet" || third == "inet6" || third.starts_with("link/")
    }
}

/// `2:`, the interface index.
fn is_index(word: &str) -> bool {
    word.strip_suffix(':')
        .is_some_and(|n| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()))
}

/// `$ ip addr` or `# ip addr`, a prompt with no user or host in it.
fn is_bare_prompt(text: &str) -> bool {
    text.starts_with("$ ") || text.starts_with("# ") || text == "$" || text == "#"
}

/// The host in `user@host:~$ …`, `root@host:/etc# …` or `[user@host ~]$ …`,
/// as a byte range of `text`. The host must open with a letter: `admin@10.0.0.1`
/// is where someone connected to, not what the box is called.
fn prompt_host(text: &str) -> Option<(usize, usize)> {
    let first_end = text.find(char::is_whitespace).unwrap_or(text.len());
    let first = text.get(..first_end)?;
    let at = first.find('@')?;
    let user = first.get(..at)?.trim_start_matches('[');
    if user.is_empty()
        || !user
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-' || b == b'.')
    {
        return None;
    }
    let host_start = at + 1;
    let rest = first.get(host_start..)?;
    let host_len = rest
        .find(|c: char| !(c.is_ascii_alphanumeric() || c == '-' || c == '.' || c == '_'))
        .unwrap_or(rest.len());
    let host = rest.get(..host_len)?;
    if !host.chars().next().is_some_and(|c| c.is_ascii_alphabetic()) {
        return None;
    }
    // The prompt has to end in `$` or `#` somewhere before the command.
    let tail = text.get(host_start + host_len..)?;
    let marker = tail.find(['$', '#'])?;
    let before = tail.get(..marker)?;
    if before.len() > 64 {
        return None;
    }
    Some((host_start, host_start + host_len))
}

/// One whitespace-separated word, located in the capture. `brk` is set when
/// the word ended in the `\` the `-o` forms print between a record's parts.
#[derive(Debug, Clone)]
struct Word {
    span: ByteSpan,
    text: String,
    brk: bool,
}

fn words(capture: &str, span: ByteSpan) -> Vec<Word> {
    let text = frame::slice(capture, span);
    let mut out = Vec::new();
    let mut start: Option<usize> = None;
    let push = |s: usize, e: usize, out: &mut Vec<Word>| {
        let Some(raw) = text.get(s..e) else { return };
        let (body, brk) = match raw.strip_suffix('\\') {
            Some(b) => (b, true),
            None => (raw, false),
        };
        if body.is_empty() {
            if brk {
                if let Some(last) = out.last_mut() {
                    let last: &mut Word = last;
                    last.brk = true;
                }
            }
            return;
        }
        out.push(Word {
            span: ByteSpan {
                start: span.start + s as u32,
                end: span.start + (s + body.len()) as u32,
            },
            text: body.to_owned(),
            brk,
        });
    };
    for (i, c) in text.char_indices() {
        if c.is_ascii_whitespace() {
            if let Some(s) = start.take() {
                push(s, i, &mut out);
            }
        } else if start.is_none() {
            start = Some(i);
        }
    }
    if let Some(s) = start {
        push(s, text.len(), &mut out);
    }
    out
}

/// Splits a run of words into the parts `-o` joined with `\`.
fn parts(ws: &[Word]) -> Vec<&[Word]> {
    let mut out = Vec::new();
    let mut from = 0usize;
    for (i, w) in ws.iter().enumerate() {
        if w.brk {
            if let Some(p) = ws.get(from..=i) {
                out.push(p);
            }
            from = i + 1;
        }
    }
    if let Some(p) = ws.get(from..).filter(|p| !p.is_empty()) {
        out.push(p);
    }
    out
}

/// One physical line per logical line: `ip` never wraps.
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

/// The whole read: `ip` output in, an [`IngestOutput`] out, identical in shape
/// to what [`crate::ingest`] returns for a `set`-form paste.
pub fn ingest_iproute(paste: &[u8], dict: &Dictionary) -> Result<IngestOutput, IngestRefusal> {
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
    let mut unshaped: Vec<UnshapedLine> = Vec::new();
    let mut noise: Vec<UnshapedLine> = Vec::new();
    // The record in force: the interface name as a path segment.
    let mut record: Option<Seg> = None;

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

        let mut emit = |path: &[Seg]| {
            let mut nodes = Vec::new();
            let mut tokens = Vec::new();
            let last = path.len().saturating_sub(1);
            for (at, (text, tok)) in path.iter().enumerate() {
                nodes.push(node(
                    &mut tree,
                    &mut intern,
                    text,
                    span,
                    line.ordinal,
                    at == last,
                ));
                tokens.push(*tok);
            }
            stmts.push(Stmt {
                line: line.ordinal,
                span,
                path: nodes,
                tokens,
                list_pos: 0,
            });
        };

        let text = frame::slice(&capture, span);
        let indented = text.starts_with([' ', '\t']);
        let trimmed_at = text.len() - text.trim_start().len();

        // A prompt names the host; the command after it is only swept.
        if !indented {
            if let Some((hs, he)) = prompt_host(text.trim_start()) {
                let host = Word {
                    span: ByteSpan {
                        start: span.start + (trimmed_at + hs) as u32,
                        end: span.start + (trimmed_at + he) as u32,
                    },
                    text: text.trim_start().get(hs..he).unwrap_or_default().to_owned(),
                    brk: false,
                };
                // `@` is the byte before the host.
                let at = ByteSpan {
                    start: host.span.start - 1,
                    end: host.span.start,
                };
                emit(&[("@".to_owned(), bare(at)), seg(&host)]);
                record = None;
                outcomes.push(Outcome::new(LineOutcome::Unmapped { known_prefix: 0 }));
                continue;
            }
            if is_bare_prompt(text.trim()) {
                record = None;
                outcomes.push(Outcome::new(LineOutcome::Unmapped { known_prefix: 0 }));
                continue;
            }
        }

        match ws.as_slice() {
            // A record header.
            [index, name, rest @ ..] if !indented && is_index(&index.text) => {
                let named_colon = name.text.ends_with(':');
                let bare_name = name.text.trim_end_matches(':');
                let base = bare_name.split('@').next().unwrap_or(bare_name);
                if base.is_empty() {
                    unshaped.push(UnshapedLine {
                        line: line.ordinal,
                        span,
                        tokens: toks,
                    });
                    outcomes.push(Outcome::new(LineOutcome::Unshaped {
                        reason: ShapeError::KeyUnparsable,
                    }));
                    record = None;
                    continue;
                }
                let me: Seg = (
                    base.to_owned(),
                    bare(ByteSpan {
                        start: name.span.start,
                        end: name.span.start + base.len() as u32,
                    }),
                );
                emit(std::slice::from_ref(&me));
                let mut groups = parts(rest).into_iter();
                if named_colon {
                    // The header's own part: flags, then `key value` pairs.
                    if let Some(head) = groups.next() {
                        header(&me, head, &mut emit);
                    }
                }
                // `-o`: what follows is attribute parts, `\`-joined.
                for part in groups {
                    attribute(&me, part, &mut emit);
                }
                record = Some(me);
            }
            // An attribute line under the record in force.
            [_, ..] if indented => match record.as_ref() {
                Some(me) => {
                    for part in parts(&ws) {
                        attribute(me, part, &mut emit);
                    }
                }
                None => {
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
            },
            // A route, a table, another command's output: not ours.
            _ => {
                record = None;
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
        }
        outcomes.push(Outcome::new(LineOutcome::Unmapped { known_prefix: 0 }));
    }

    let matches = dict.match_statements(&tree, &stmts);
    let gated = redact::gate(
        &mut capture,
        &lines,
        &mut tree,
        &mut outcomes,
        &stmts,
        &unshaped,
        &noise,
        &matches,
        dict,
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

/// `<BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500 qdisc mq state UP …`.
fn header(me: &Seg, ws: &[Word], emit: &mut impl FnMut(&[Seg])) {
    let mut rest = ws;
    if let Some((flags, after)) = ws.split_first() {
        if flags.text.starts_with('<') && flags.text.ends_with('>') {
            let inner_start = flags.span.start + 1;
            let mut at = 0usize;
            let inner = flags
                .text
                .get(1..flags.text.len().saturating_sub(1))
                .unwrap_or_default();
            for flag in inner.split(',') {
                if !flag.is_empty() {
                    let f = Word {
                        span: ByteSpan {
                            start: inner_start + at as u32,
                            end: inner_start + (at + flag.len()) as u32,
                        },
                        text: flag.to_owned(),
                        brk: false,
                    };
                    emit(&[me.clone(), seg(&f)]);
                }
                at += flag.len() + 1;
            }
            rest = after;
        }
    }
    for pair in rest.chunks_exact(2) {
        if let [k, v] = pair {
            emit(&[me.clone(), seg(k), seg(v)]);
        }
    }
}

/// `inet 192.0.2.10/24 brd …`, `vlan protocol 802.1Q id 10 …`, `link/ether …`.
fn attribute(me: &Seg, ws: &[Word], emit: &mut impl FnMut(&[Seg])) {
    let Some((kind, rest)) = ws.split_first() else {
        return;
    };
    let known = ATTRIBUTE_WORDS.contains(&kind.text.as_str()) || kind.text.starts_with("link/");
    if !known {
        return;
    }
    if PAIRED_ATTRIBUTES.contains(&kind.text.as_str()) {
        for pair in rest.chunks_exact(2) {
            if let [k, v] = pair {
                emit(&[me.clone(), seg(kind), seg(k), seg(v)]);
            }
        }
    } else if let Some(v) = rest.first() {
        emit(&[me.clone(), seg(kind), seg(v)]);
    }
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

    #[test]
    fn the_sniff_is_exact() {
        assert!(looks_like_iproute(
            b"2: eth0: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500 qdisc mq\n"
        ));
        assert!(looks_like_iproute(
            b"root@fw1:~# ip -d addr\n1: lo: <LOOPBACK,UP,LOWER_UP> mtu 65536\n"
        ));
        assert!(looks_like_iproute(
            b"2: eth0    inet 192.0.2.10/24 brd 192.0.2.255 scope global eth0\\       valid_lft forever\n"
        ));
        assert!(looks_like_iproute(b"$ ip a\n\n3: br0: <UP> mtu 1500\n"));
        assert!(!looks_like_iproute(b"set system host-name r1\n"));
        assert!(!looks_like_iproute(b"default via 192.0.2.1 dev eth0\n"));
        assert!(!looks_like_iproute(
            b"/interface bridge\nadd name=bridge1\n"
        ));
        assert!(!looks_like_iproute(b"1: not a header\n"));
        assert!(!looks_like_iproute(b""));
    }

    #[test]
    fn a_prompt_names_its_host() {
        let host = |t: &str| prompt_host(t).map(|(s, e)| t[s..e].to_owned());
        assert_eq!(host("root@fw1:~# ip a").as_deref(), Some("fw1"));
        assert_eq!(host("[ops@nas-01 ~]$ ip addr").as_deref(), Some("nas-01"));
        assert_eq!(
            host("pi@raspberrypi:~ $ ip a").as_deref(),
            Some("raspberrypi")
        );
        assert_eq!(host("admin@10.0.0.1:~$ ip a"), None);
        assert_eq!(host("2: eth0: <UP>"), None);
        assert_eq!(host("someone@example.com wrote"), None);
    }

    #[test]
    fn a_one_line_record_splits_on_its_backslashes() {
        let line = "2: eth0    inet 192.0.2.10/24 scope global eth0\\       valid_lft forever";
        let ws = words(
            line,
            ByteSpan {
                start: 0,
                end: line.len() as u32,
            },
        );
        let ps = parts(&ws);
        assert_eq!(ps.len(), 2);
        assert_eq!(ps[0].last().unwrap().text, "eth0");
        assert_eq!(frame::slice(line, ps[0].last().unwrap().span), "eth0");
        assert_eq!(ps[1][0].text, "valid_lft");
    }
}
