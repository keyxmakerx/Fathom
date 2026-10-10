//! The RouterOS front end — a MikroTik `/export` in, the same typed graph
//! fragment out.
//!
//! # Why this is a front end, the way `csv.rs` is
//!
//! An export is not `set`-form. It is a section header that names a menu once
//! (`/interface vlan`) and command lines under it that fill it
//! (`add interface=bridge1 name=iot vlan-id=30`). That is the table shape
//! `csv.rs` reads, turned sideways: the header names the menu, the row's
//! identity is one of its own `key=value` pairs, and every other pair is a
//! cell. So the same move works. **A pair's meaning is `(the menu, the row's
//! identity, the pair's key, the pair's value)`, and every one of those is
//! real bytes of the operator's paste.** This module synthesises one statement
//! per pair from them, and from that point on the dictionary trie, the
//! redaction gate, the binder, the line ledger and the residue list are the
//! code every other platform runs, unmodified.
//!
//! What is synthesised is the arrangement, never the text: every segment's
//! token points at bytes in the capture, which is what lets the gate destroy
//! them.
//!
//! # The statement shape the dictionary sees
//!
//! ```text
//!   /interface vlan
//!   add interface=bridge1 name=iot vlan-id=30
//!
//!   [interface, vlan, name, iot]                      the row itself
//!   [interface, vlan, name, iot, interface, bridge1]  one per other pair
//!   [interface, vlan, name, iot, vlan-id, 30]
//! ```
//!
//! The identity is the first of `name`, the `[ find … ]` predicate,
//! `interface` and `address` the row carries. A row with none of them (a
//! firewall rule, `/ip dns set servers=…`) yields `[menu…, verb, key, value]`
//! per pair, so it is still gated and still on the residue list when the
//! dictionary has nothing for it.
//!
//! # What reaches the gate that a pair statement cannot carry
//!
//! A value with a space, `=` or `:` in it (a script `source=`, a scheduler
//! `on-event=`, a comment someone typed a password into) is also handed to the
//! gate's safety-net sweep as its own token. That sweep reads `key=value`
//! inside text, which the pair statement cannot: the statement sees only the
//! outer key. A value that trips it quarantines the line, and the binder skips
//! a quarantined line, so nothing on it is kept.
//!
//! Comment lines, menu headers and every line this reader cannot shape go to
//! the same sweep, at the same aggression, before anything is stored.

use std::collections::BTreeMap;

use crate::bind;
use crate::dict::Dictionary;
use crate::frame::{
    self, ByteSpan, JoinKind, LineClass, LineOrdinal, LineOutcome, LogicalLine, NoiseClass,
    Outcome, ShapeError,
};
use crate::lex::{Token, TokenKind};
use crate::redact;
use crate::shape::{SegId, Stmt, StmtIdx, StmtNode, StmtTree, UnshapedLine};
use crate::{CaptureScope, IngestOutput, IngestRefusal, ResidueEntry};

/// The two verbs an export writes. Everything else (`remove`, `:if`, `print`)
/// is a line this reader names on the residue list rather than guesses at.
const VERBS: [&str; 2] = ["add", "set"];

/// The row identity, in order of preference. `name` first because it is what
/// every other menu refers to a row by (`interface=staff` names the VLAN
/// interface `add … name=staff` made). The `[ find … ]` predicate sits between
/// `name` and the rest; see [`identity`].
const IDENTITY_KEYS: [&str; 2] = ["interface", "address"];

/// Does this paste look like a RouterOS export?
///
/// Exact rather than fuzzy, like `csv::looks_like_rules_csv`: the first line
/// that is neither blank nor a `#` comment must open a menu (`/` then a
/// lowercase letter), and the first line after it that is not blank or a
/// comment must be a command (`add `, `set `) or another menu. A Linux paste
/// that starts with a path (`/etc/…`) fails the second half. The header
/// comment `# … by RouterOS 7.15` also counts, on its own, when it is the
/// first line.
///
/// Runs on raw bytes, before the UTF-8 check, because the caller has to choose
/// a dictionary first.
pub fn looks_like_routeros(paste: &[u8]) -> bool {
    let body = paste.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(paste);
    let mut lines = body
        .split(|b| *b == b'\n')
        .map(|l| trim_ascii(l.strip_suffix(b"\r").unwrap_or(l)))
        .filter(|l| !l.is_empty());
    let mut first_comment = true;
    let mut menu = false;
    for line in lines.by_ref() {
        if line.first() == Some(&b'#') {
            if first_comment && contains(line, b" by RouterOS ") {
                return true;
            }
            first_comment = false;
            continue;
        }
        first_comment = false;
        if !menu {
            match line {
                [b'/', c, ..] if c.is_ascii_lowercase() => menu = true,
                _ => return false,
            }
            continue;
        }
        return line.starts_with(b"add ")
            || line.starts_with(b"set ")
            || line.first() == Some(&b'/');
    }
    false
}

fn trim_ascii(mut b: &[u8]) -> &[u8] {
    while let [first, rest @ ..] = b {
        if !first.is_ascii_whitespace() {
            break;
        }
        b = rest;
    }
    while let [rest @ .., last] = b {
        if !last.is_ascii_whitespace() {
            break;
        }
        b = rest;
    }
    b
}

fn contains(hay: &[u8], needle: &[u8]) -> bool {
    hay.windows(needle.len()).any(|w| w == needle)
}

/// One word of a command line: its raw bytes and the text it means.
#[derive(Debug, Clone)]
struct Word {
    /// Raw extent in the capture, quotes and continuations included.
    span: ByteSpan,
    /// Escape-resolved, continuation-free text.
    text: String,
    /// The first unquoted `=`: `(raw offset, offset in text)`.
    eq: Option<(u32, usize)>,
    /// The value half opens with `"`.
    quoted_value: bool,
}

/// One `key=value` pair, both halves located.
#[derive(Debug, Clone)]
struct Pair {
    key: String,
    key_span: ByteSpan,
    value: String,
    value_span: ByteSpan,
    quoted: bool,
}

impl Pair {
    fn of(word: &Word) -> Option<Pair> {
        let (raw_eq, text_eq) = word.eq?;
        let key = word.text.get(..text_eq)?.to_owned();
        let value = word.text.get(text_eq + 1..)?.to_owned();
        if key.is_empty() {
            return None;
        }
        Some(Pair {
            key,
            key_span: ByteSpan {
                start: word.span.start,
                end: raw_eq,
            },
            value,
            value_span: ByteSpan {
                start: raw_eq + 1,
                end: word.span.end,
            },
            quoted: word.quoted_value,
        })
    }

    fn key_token(&self) -> Token {
        Token {
            kind: TokenKind::Bare,
            span: self.key_span,
        }
    }

    fn value_token(&self) -> Token {
        Token {
            kind: if self.quoted {
                TokenKind::Quoted
            } else {
                TokenKind::Bare
            },
            span: self.value_span,
        }
    }
}

/// Splits one logical line into words.
///
/// RouterOS's own rules, not the Junos lexer's: a `"` opens a string anywhere
/// in a word (`comment="uplink to core"` is one word), `\` escapes inside it,
/// and a `\` at the end of a physical line joins the next one with its
/// leading indentation dropped — inside a string as well as outside, which is
/// how `/export` wraps a long `source=`. `[` and `]` stand alone.
///
/// `Err` is an unterminated string.
fn words(capture: &str, span: ByteSpan) -> Result<Vec<Word>, ShapeError> {
    let text = frame::slice(capture, span);
    let base = span.start;
    let mut out: Vec<Word> = Vec::new();
    let mut cur: Option<Word> = None;
    let mut in_quote = false;
    let mut it = text.char_indices().peekable();

    // Skips the newline after a joining `\` and the indentation under it.
    fn skip_join(it: &mut std::iter::Peekable<std::str::CharIndices<'_>>) -> bool {
        if it.peek().map(|(_, c)| *c) != Some('\n') {
            return false;
        }
        it.next();
        while it.peek().map(|(_, c)| *c) == Some(' ') {
            it.next();
        }
        true
    }

    while let Some((at, ch)) = it.next() {
        let raw = base + at as u32;
        let end = raw + ch.len_utf8() as u32;
        if in_quote {
            let Some(w) = cur.as_mut() else {
                continue;
            };
            w.span.end = end;
            match ch {
                '"' => in_quote = false,
                '\n' => {}
                '\\' => {
                    if skip_join(&mut it) {
                        continue;
                    }
                    if let Some((at2, next)) = it.next() {
                        w.span.end = base + at2 as u32 + next.len_utf8() as u32;
                        match next {
                            // Kept as written: these name characters a segment should
                            // not carry, and the value is evidence, not a decoded string.
                            'n' | 'r' | 't' | 'a' | 'b' | 'f' | 'v' => {
                                w.text.push('\\');
                                w.text.push(next);
                            }
                            '_' => w.text.push(' '),
                            c if c.is_ascii_hexdigit() => {
                                w.text.push('\\');
                                w.text.push(c);
                            }
                            c => w.text.push(c),
                        }
                    }
                }
                c => w.text.push(c),
            }
            continue;
        }
        match ch {
            '\\' if it.peek().map(|(_, c)| *c) == Some('\n') => {
                skip_join(&mut it);
                if let Some(w) = cur.as_mut() {
                    w.span.end = end;
                }
            }
            // A bare newline is left only by a wrap without a backslash (see
            // `logical_lines`): the terminal cut the line, so it joins with no gap.
            '\n' => {
                if let Some(w) = cur.as_mut() {
                    w.span.end = end;
                }
            }
            ' ' => {
                if let Some(w) = cur.take() {
                    out.push(w);
                }
            }
            '[' | ']' if cur.is_none() || ch == ']' => {
                if let Some(w) = cur.take() {
                    out.push(w);
                }
                out.push(Word {
                    span: ByteSpan { start: raw, end },
                    text: ch.to_string(),
                    eq: None,
                    quoted_value: false,
                });
            }
            c => {
                let w = cur.get_or_insert_with(|| Word {
                    span: ByteSpan {
                        start: raw,
                        end: raw,
                    },
                    text: String::new(),
                    eq: None,
                    quoted_value: false,
                });
                w.span.end = end;
                if c == '"' {
                    in_quote = true;
                    if w.eq.is_some_and(|(_, t)| t + 1 == w.text.len()) {
                        w.quoted_value = true;
                    }
                    continue;
                }
                if c == '=' && w.eq.is_none() {
                    w.eq = Some((raw, w.text.len()));
                }
                if c == '\\' {
                    // An escaped character outside a string stands for itself.
                    if let Some((at2, next)) = it.next() {
                        w.span.end = base + at2 as u32 + next.len_utf8() as u32;
                        w.text.push(next);
                    }
                    continue;
                }
                w.text.push(c);
            }
        }
    }
    if in_quote {
        return Err(ShapeError::UnterminatedQuote);
    }
    if let Some(w) = cur.take() {
        out.push(w);
    }
    Ok(out)
}

/// Physical lines, joined where one ends in an odd run of `\` — RouterOS's
/// continuation, which applies inside a string as well (where `frame`'s
/// Junos rule, rightly for Junos, does not join).
fn logical_lines(capture: &str) -> (Vec<LogicalLine>, Vec<Option<ShapeError>>) {
    let mut physical: Vec<ByteSpan> = Vec::new();
    let mut start = 0u32;
    for (idx, _) in capture.char_indices().filter(|(_, c)| *c == '\n') {
        let at = idx as u32;
        physical.push(ByteSpan { start, end: at });
        start = at + 1;
    }
    physical.push(ByteSpan {
        start,
        end: capture.len() as u32,
    });

    let mut lines = Vec::new();
    let mut errors = Vec::new();
    let mut i = 0usize;
    while i < physical.len() {
        let mut pieces = Vec::new();
        let mut error = None;
        while let Some(span) = physical.get(i).copied() {
            pieces.push(span);
            let text = frame::slice(capture, span);
            let run = text.chars().rev().take_while(|c| *c == '\\').count();
            if run % 2 == 0 {
                break;
            }
            if i + 1 >= physical.len() {
                error = Some(ShapeError::UnterminatedContinuation);
                break;
            }
            i += 1;
        }
        i += 1;

        // A terminal that wrapped a long command without a backslash leaves its
        // tail on a line of its own, possibly cut mid-word (`passw` / `ord=…`).
        // A non-blank line that cannot open anything, under a command, is that
        // tail: it is joined back so a split secret is read whole by the gate.
        if let (Some(prev), [only]) = (lines.last_mut(), pieces.as_slice()) {
            let tail = frame::slice(capture, *only);
            if error.is_none() && is_command(capture, prev) && is_wrapped_tail(tail) {
                let prev: &mut LogicalLine = prev;
                prev.pieces.push(*only);
                prev.join = JoinKind::Backslash;
                continue;
            }
        }

        let text = pieces
            .first()
            .map(|s| frame::slice(capture, *s))
            .unwrap_or("")
            .trim();
        let class = if pieces.len() == 1 && text.is_empty() {
            LineClass::Blank
        } else if is_prompt(text) {
            LineClass::Noise(NoiseClass::CommandEcho)
        } else {
            LineClass::Statement
        };
        lines.push(LogicalLine {
            ordinal: LineOrdinal(lines.len() as u32),
            join: if pieces.len() > 1 {
                JoinKind::Backslash
            } else {
                JoinKind::None
            },
            pieces,
            class,
        });
        errors.push(error);
    }
    (lines, errors)
}

/// The line opens a command (`add `/`set `, after any indentation).
fn is_command(capture: &str, line: &LogicalLine) -> bool {
    line.class == LineClass::Statement
        && line
            .pieces
            .first()
            .map(|p| frame::slice(capture, *p).trim_start())
            .is_some_and(|t| t.starts_with("add ") || t.starts_with("set "))
}

/// A line that cannot open anything of its own: not blank, not a menu, a
/// comment, a command, a script line or a prompt.
fn is_wrapped_tail(text: &str) -> bool {
    let t = text.trim();
    !t.is_empty()
        && !text.starts_with(' ')
        && !["/", "#", ":", "["].iter().any(|p| t.starts_with(p))
        && !VERBS
            .iter()
            .any(|v| t == *v || t.starts_with(&format!("{v} ")))
}

/// `[admin@MikroTik] > /export`, the console echoing the command that was run.
fn is_prompt(text: &str) -> bool {
    text.starts_with('[')
        && text
            .split_once("] >")
            .is_some_and(|(head, _)| head.contains('@'))
}

/// The row's identity: `name`, else the `[ find … ]` predicate, else
/// `interface`, else `address`. Returns the index into `pairs`, or `None` for
/// the predicate (which is not a pair of the row).
enum Identity {
    Pair(usize),
    Find,
    None,
}

fn identity(pairs: &[Pair], find: Option<&Pair>) -> Identity {
    if let Some(at) = pairs.iter().position(|p| p.key == "name") {
        return Identity::Pair(at);
    }
    if find.is_some() {
        return Identity::Find;
    }
    for key in IDENTITY_KEYS {
        if let Some(at) = pairs.iter().position(|p| p.key == key) {
            return Identity::Pair(at);
        }
    }
    Identity::None
}

/// A value the pair statement cannot fully speak for: it holds words or a
/// `key=value` of its own.
fn needs_sweep(value: &str) -> bool {
    value.contains([' ', '=', ':', '\\'])
}

/// The whole read: an export in, an [`IngestOutput`] out, identical in shape
/// to what [`crate::ingest`] returns for a `set`-form paste.
pub fn ingest_routeros(paste: &[u8], dict: &Dictionary) -> Result<IngestOutput, IngestRefusal> {
    // `frame` for its refusals and its normalisation only; the lines are ours.
    let framed = frame::frame(paste)?;
    let mut capture = framed.capture;
    let (lines, frame_errors) = logical_lines(&capture);

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
    // The menu in force: its words, each with the span it was read from.
    let mut menu: Option<Vec<(String, ByteSpan)>> = None;

    for (idx, line) in lines.iter().enumerate() {
        let span = line_span(&lines, idx);
        let mut refuse = |reason: ShapeError, toks: Vec<Token>, outcomes: &mut Vec<Outcome>| {
            outcomes.push(Outcome::new(LineOutcome::Unshaped { reason }));
            unshaped.push(UnshapedLine {
                line: line.ordinal,
                span,
                tokens: if toks.is_empty() {
                    vec![bare(span)]
                } else {
                    toks
                },
            });
        };
        match line.class {
            LineClass::Blank => {
                outcomes.push(Outcome::new(LineOutcome::Blank));
                continue;
            }
            LineClass::Noise(class) => {
                outcomes.push(Outcome::new(LineOutcome::Noise { class }));
                noise.push(UnshapedLine {
                    line: line.ordinal,
                    span,
                    tokens: vec![bare(span)],
                });
                continue;
            }
            LineClass::Statement => {}
        }
        if let Some(Some(e)) = frame_errors.get(idx) {
            refuse(*e, Vec::new(), &mut outcomes);
            continue;
        }
        let ws = match words(&capture, span) {
            Ok(ws) => ws,
            Err(e) => {
                refuse(e, Vec::new(), &mut outcomes);
                continue;
            }
        };
        let toks: Vec<Token> = ws.iter().map(|w| bare(w.span)).collect();
        let Some(first) = ws.first() else {
            outcomes.push(Outcome::new(LineOutcome::Blank));
            continue;
        };

        // A comment. The export's header (`# … by RouterOS 7.15`, `# model = …`)
        // is evidence about the box this dictionary does not bind yet, so it is
        // named on the residue list, and swept like any other line first.
        if first.text.starts_with('#') {
            outcomes.push(Outcome::new(LineOutcome::Unmapped { known_prefix: 0 }));
            noise.push(UnshapedLine {
                line: line.ordinal,
                span,
                tokens: toks,
            });
            continue;
        }

        // A menu: `/interface vlan`, `/interface/vlan`, or a one-line command
        // with its menu in front (`/ip address add …`), which does not change
        // the menu in force.
        let mut rest: &[Word] = &ws;
        let mut inline: Option<Vec<(String, ByteSpan)>> = None;
        if first.text.starts_with('/') {
            let mut path: Vec<(String, ByteSpan)> = Vec::new();
            let mut taken = 0usize;
            for w in &ws {
                if taken > 0 && (VERBS.contains(&w.text.as_str()) || w.eq.is_some()) {
                    break;
                }
                taken += 1;
                for part in w.text.split('/').filter(|p| !p.is_empty()) {
                    path.push((part.to_owned(), w.span));
                }
            }
            rest = ws.get(taken..).unwrap_or_default();
            if rest.is_empty() {
                outcomes.push(Outcome::new(LineOutcome::Header {
                    columns: path.len().min(u16::MAX as usize) as u16,
                }));
                noise.push(UnshapedLine {
                    line: line.ordinal,
                    span,
                    tokens: toks,
                });
                menu = Some(path);
                continue;
            }
            inline = Some(path);
        }
        let Some(section) = inline.as_ref().or(menu.as_ref()) else {
            refuse(ShapeError::NotVerbInitial, toks, &mut outcomes);
            continue;
        };
        let Some((verb, args)) = rest.split_first() else {
            refuse(ShapeError::NotVerbInitial, toks, &mut outcomes);
            continue;
        };
        if !VERBS.contains(&verb.text.as_str()) {
            refuse(ShapeError::UnsupportedVerb, toks, &mut outcomes);
            continue;
        }

        // `set [ find default-name=ether1 ] …`; `where` is the long spelling.
        let mut args = args;
        let mut find: Option<Pair> = None;
        if args.first().is_some_and(|w| w.text == "[") {
            let close = args.iter().position(|w| w.text == "]");
            let inner = close.and_then(|c| args.get(1..c)).unwrap_or_default();
            let mut inner = inner
                .iter()
                .skip_while(|w| w.text == "find" || w.text == "where");
            let pred = inner.next().and_then(Pair::of);
            match (close, pred, inner.next()) {
                (Some(c), Some(p), None) => {
                    find = Some(p);
                    args = args.get(c + 1..).unwrap_or_default();
                }
                _ => {
                    refuse(ShapeError::KeyUnparsable, toks, &mut outcomes);
                    continue;
                }
            }
        }
        let pairs: Option<Vec<Pair>> = args.iter().map(Pair::of).collect();
        let Some(mut pairs) = pairs else {
            // A positional argument (`set 0 …`, `set ether1 …`) names a row by
            // something that is not in the paste. Refused, not guessed.
            refuse(ShapeError::KeyUnparsable, toks, &mut outcomes);
            continue;
        };

        // Every value with words in it goes to the sweep before anything else
        // decides whether it is kept.
        for p in &pairs {
            if needs_sweep(&p.value) {
                noise.push(UnshapedLine {
                    line: line.ordinal,
                    span: p.value_span,
                    tokens: vec![p.value_token()],
                });
            }
        }
        if let Some(p) = find.as_ref().filter(|p| needs_sweep(&p.value)) {
            noise.push(UnshapedLine {
                line: line.ordinal,
                span: p.value_span,
                tokens: vec![p.value_token()],
            });
        }
        // An empty value is the absence of one; there is nothing to bind or gate.
        pairs.retain(|p| !p.value.is_empty());

        let before = stmts.len();
        let sec = section_tokens(section);
        let mut emit = |head: &[(String, Token)], tail: &[(String, Token)]| {
            let mut path = Vec::new();
            let mut tokens = Vec::new();
            let all: Vec<&(String, Token)> =
                sec.iter().chain(head.iter()).chain(tail.iter()).collect();
            let last = all.len().saturating_sub(1);
            for (at, (text, tok)) in all.into_iter().enumerate() {
                path.push(node(
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
                path,
                tokens,
                list_pos: 0,
            });
        };
        let kv = |p: &Pair| -> [(String, Token); 2] {
            [
                (p.key.clone(), p.key_token()),
                (p.value.clone(), p.value_token()),
            ]
        };

        match identity(&pairs, find.as_ref()) {
            Identity::Pair(at) => {
                let Some(id) = pairs.get(at).cloned() else {
                    continue;
                };
                let head = kv(&id);
                emit(&head, &[]);
                if let Some(p) = find.as_ref() {
                    emit(&head, &kv(p));
                }
                for (i, p) in pairs.iter().enumerate() {
                    if i != at {
                        emit(&head, &kv(p));
                    }
                }
            }
            Identity::Find => {
                let Some(id) = find.as_ref() else {
                    continue;
                };
                let head = kv(id);
                emit(&head, &[]);
                for p in &pairs {
                    emit(&head, &kv(p));
                }
            }
            Identity::None => {
                let head = [(verb.text.clone(), bare(verb.span))];
                for p in &pairs {
                    emit(&head, &kv(p));
                }
            }
        }
        if stmts.len() == before {
            // `set` with nothing to set: understood, and says nothing.
            outcomes.push(Outcome::new(LineOutcome::Unmapped { known_prefix: 0 }));
            noise.push(UnshapedLine {
                line: line.ordinal,
                span,
                tokens: toks,
            });
            continue;
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

fn section_tokens(section: &[(String, ByteSpan)]) -> Vec<(String, Token)> {
    section
        .iter()
        .map(|(text, span)| (text.clone(), bare(*span)))
        .collect()
}

fn bare(span: ByteSpan) -> Token {
    Token {
        kind: TokenKind::Bare,
        span,
    }
}

fn line_span(lines: &[LogicalLine], idx: usize) -> ByteSpan {
    match lines.get(idx) {
        Some(line) => ByteSpan {
            start: line.pieces.first().map(|p| p.start).unwrap_or(0),
            end: line.pieces.last().map(|p| p.end).unwrap_or(0),
        },
        None => ByteSpan { start: 0, end: 0 },
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

    fn texts(line: &str) -> Vec<String> {
        words(
            line,
            ByteSpan {
                start: 0,
                end: line.len() as u32,
            },
        )
        .unwrap()
        .into_iter()
        .map(|w| w.text)
        .collect()
    }

    #[test]
    fn the_sniff_is_exact() {
        assert!(looks_like_routeros(
            b"/interface bridge\nadd name=bridge1\n"
        ));
        assert!(looks_like_routeros(
            b"# 2024-05-01 12:00:00 by RouterOS 7.15\n# model = RB5009\n"
        ));
        assert!(looks_like_routeros(
            b"\n# software id = X\n/ip address\nadd address=10.0.0.1/24 interface=ether2\n"
        ));
        assert!(!looks_like_routeros(b"set system host-name r1\n"));
        assert!(!looks_like_routeros(
            b"/etc/network/interfaces\nauto eth0\n"
        ));
        assert!(!looks_like_routeros(b"@uuid;enabled\n"));
        assert!(!looks_like_routeros(b""));
    }

    #[test]
    fn a_string_is_one_word_and_its_escapes_resolve() {
        assert_eq!(
            texts(r#"add comment="uplink \"core\" a\_b" name=x"#),
            vec!["add", r#"comment=uplink "core" a b"#, "name=x"]
        );
    }

    #[test]
    fn a_continuation_inside_a_string_drops_the_indent() {
        let line = "add source=\":put a\\r\\\n    \\n:put b\" name=s";
        assert_eq!(
            texts(line),
            vec!["add", "source=:put a\\r\\n:put b", "name=s"]
        );
    }

    #[test]
    fn brackets_stand_alone() {
        assert_eq!(
            texts("set [ find default-name=ether1 ] name=wan"),
            vec!["set", "[", "find", "default-name=ether1", "]", "name=wan"]
        );
    }

    #[test]
    fn an_open_string_is_refused() {
        let line = "add comment=\"never closed";
        assert_eq!(
            words(
                line,
                ByteSpan {
                    start: 0,
                    end: line.len() as u32
                }
            )
            .unwrap_err(),
            ShapeError::UnterminatedQuote
        );
    }

    #[test]
    fn a_pair_locates_both_halves() {
        let line = "add password=\"s3cr3t pw\"";
        let ws = words(
            line,
            ByteSpan {
                start: 0,
                end: line.len() as u32,
            },
        )
        .unwrap();
        let p = Pair::of(&ws[1]).unwrap();
        assert_eq!(p.key, "password");
        assert_eq!(p.value, "s3cr3t pw");
        assert!(p.quoted);
        assert_eq!(frame::slice(line, p.key_span), "password");
        assert_eq!(frame::slice(line, p.value_span), "\"s3cr3t pw\"");
    }
}
