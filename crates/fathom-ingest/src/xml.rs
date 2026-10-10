//! The XML front end — a whole-file configuration backup (pfSense's
//! `config.xml`) in, the same typed graph fragment out.
//!
//! # Why this is a front end, the way `csv.rs` and `routeros.rs` are
//!
//! `corpus/dict/opnsense/README-config-xml.md` §4 made the argument before
//! there was code: **a leaf element's meaning is `(its path from the root, its
//! name, its text)`, and every one of those is real bytes of the file.** So
//! this module synthesises one statement per leaf, and the dictionary trie,
//! the redaction gate, the binder, the ledger and the residue list are the
//! code every other platform runs, unmodified.
//!
//! # The statement shape the dictionary sees
//!
//! ```text
//!   <vlans><vlan><if>igb1</if><tag>10</tag><vlanif>igb1.10</vlanif></vlan></vlans>
//!
//!   [vlans, vlan, vlanif, igb1.10]               the record itself
//!   [vlans, vlan, vlanif, igb1.10, if, igb1]     one per other leaf
//!   [vlans, vlan, vlanif, igb1.10, tag, 10]
//! ```
//!
//! A record that repeats (users, VLANs, tunnels) is told apart by the first of
//! [`IDENTITY_KEYS`] among its leaf children, wherever in the record that
//! child sits; the file is read whole before anything is synthesised, so the
//! identity can come after the leaves it names. An element without one (the
//! `<lan>` under `<interfaces>`) is named by its own tag. An empty element
//! (`<enable/>`) is a flag: its path ends at its name.
//!
//! # Lines
//!
//! A line is a physical line, except that a value, comment or tag running
//! over several lines (a base64 certificate, a CDATA script) joins them into
//! one, so the gate's edit and the ledger's entry are the same bytes. A line
//! holding only markup is a `Header`; it and every comment are swept by the
//! gate's safety net like any line that produced no statement.
//!
//! # A file that does not parse
//!
//! Every non-blank line is `Unshaped` and swept at maximum aggression. Nothing
//! binds, so the caller refuses it as nothing understood, and nothing is
//! stored. An encrypted backup lands here: its body is one base64 block.

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

/// The leaf children that name a record, in order of preference. Each is a
/// unique key in pfSense's own code for the record it sits in: a user's
/// `name`, a VLAN's `vlanif`, an IPsec phase 1's `ikeid`, an OpenVPN
/// instance's `vpnid`, a certificate's `refid`, a gateway or tunable's
/// `name`. `if` is last: an interface assignment (`<lan>`) is named by its
/// tag, and `if` is how its statements find the device's own port name.
pub const IDENTITY_KEYS: [&str; 6] = ["name", "vlanif", "ikeid", "vpnid", "refid", "if"];

/// The root element of a document that looks like an XML backup, or `None`.
///
/// Exact rather than fuzzy: after an optional BOM, whitespace, `<?xml …?>`
/// declaration and comments, the first element's name is returned. The caller
/// decides which roots it reads. Raw bytes, before the UTF-8 check.
pub fn root_element(paste: &[u8]) -> Option<&str> {
    let body = paste.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(paste);
    let head = body.get(..body.len().min(4096))?;
    // A cut through a multi-byte character at 4096 is not a reason to refuse.
    let text = match std::str::from_utf8(head) {
        Ok(t) => t,
        Err(e) => std::str::from_utf8(head.get(..e.valid_up_to())?).ok()?,
    };
    let mut rest = text.trim_start();
    loop {
        if let Some(r) = rest.strip_prefix("<?") {
            rest = r.split_once("?>")?.1.trim_start();
        } else if let Some(r) = rest.strip_prefix("<!--") {
            rest = r.split_once("-->")?.1.trim_start();
        } else {
            break;
        }
    }
    let r = rest.strip_prefix('<')?;
    let end = r.find(|c: char| c == '>' || c == '/' || c.is_whitespace())?;
    let name = r.get(..end)?;
    (!name.is_empty()
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "-_.:".contains(c)))
    .then_some(name)
}

/// One element, read whole.
#[derive(Debug)]
struct Elem {
    name: String,
    name_span: ByteSpan,
    children: Vec<usize>,
    /// The text, when the element holds no child elements: raw span (CDATA
    /// markers included) and the decoded value.
    text: Option<(ByteSpan, String)>,
    attrs: Vec<Attr>,
    /// From `<` of the start tag to `>` of the end tag.
    extent: ByteSpan,
}

#[derive(Debug)]
struct Attr {
    name: String,
    name_span: ByteSpan,
    value: String,
    value_span: ByteSpan,
}

/// The parse: elements (index 0 is the root) and every comment's extent.
struct Doc {
    elems: Vec<Elem>,
    comments: Vec<ByteSpan>,
    /// Spans of start tags that ran over a line (attributes on several lines).
    tags: Vec<ByteSpan>,
}

fn decode(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut rest = raw;
    while let Some(at) = rest.find('&') {
        out.push_str(rest.get(..at).unwrap_or(""));
        let tail = rest.get(at..).unwrap_or("");
        let Some(semi) = tail.find(';').filter(|s| *s <= 10) else {
            out.push('&');
            rest = tail.get(1..).unwrap_or("");
            continue;
        };
        let ent = tail.get(1..semi).unwrap_or("");
        let ch = match ent {
            "amp" => Some('&'),
            "lt" => Some('<'),
            "gt" => Some('>'),
            "quot" => Some('"'),
            "apos" => Some('\''),
            _ => ent
                .strip_prefix("#x")
                .and_then(|h| u32::from_str_radix(h, 16).ok())
                .or_else(|| ent.strip_prefix('#').and_then(|d| d.parse().ok()))
                .and_then(char::from_u32),
        };
        match ch {
            Some(c) => {
                out.push(c);
                rest = tail.get(semi + 1..).unwrap_or("");
            }
            None => {
                out.push('&');
                rest = tail.get(1..).unwrap_or("");
            }
        }
    }
    out.push_str(rest);
    out
}

fn is_name_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || "-_.:".contains(c)
}

/// Reads the whole document. `None` for anything that is not well-formed
/// enough to name every leaf with certainty.
fn parse(text: &str) -> Option<Doc> {
    let mut elems: Vec<Elem> = Vec::new();
    let mut comments = Vec::new();
    let mut tags = Vec::new();
    let mut stack: Vec<usize> = Vec::new();
    // Text since the last tag, for the element on top of the stack.
    let mut pending: Option<(ByteSpan, String)> = None;
    let mut root_closed = false;
    let mut pos = 0usize;
    let bytes = text.as_bytes();

    while pos < text.len() {
        let rest = text.get(pos..)?;
        if !rest.starts_with('<') {
            let len = rest.find('<').unwrap_or(rest.len());
            let raw = rest.get(..len)?;
            let trimmed = raw.trim();
            if !trimmed.is_empty() {
                if stack.is_empty() {
                    return None;
                }
                let lead = raw.len() - raw.trim_start().len();
                let start = (pos + lead) as u32;
                let span = ByteSpan {
                    start,
                    end: start + trimmed.len() as u32,
                };
                let value = decode(trimmed);
                pending = Some(match pending.take() {
                    Some((s, v)) => (
                        ByteSpan {
                            start: s.start,
                            end: span.end,
                        },
                        v + &value,
                    ),
                    None => (span, value),
                });
            }
            pos += len;
            continue;
        }
        if let Some(r) = rest.strip_prefix("<!--") {
            let end = r.find("-->")? + 4 + 3;
            comments.push(ByteSpan {
                start: pos as u32,
                end: (pos + end) as u32,
            });
            pos += end;
            continue;
        }
        if let Some(r) = rest.strip_prefix("<![CDATA[") {
            if stack.is_empty() {
                return None;
            }
            let inner = r.find("]]>")?;
            let end = 9 + inner + 3;
            let span = ByteSpan {
                start: pos as u32,
                end: (pos + end) as u32,
            };
            // pfSense entity-escapes values even inside CDATA and decodes them
            // after parsing (`xmlparse.inc`), so `a&amp;b` there means `a&b`.
            let value = decode(r.get(..inner)?);
            pending = Some(match pending.take() {
                Some((s, v)) => (
                    ByteSpan {
                        start: s.start,
                        end: span.end,
                    },
                    v + &value,
                ),
                None => (span, value),
            });
            pos += end;
            continue;
        }
        if rest.starts_with("<?") || rest.starts_with("<!") {
            if !stack.is_empty() || root_closed {
                return None;
            }
            pos += rest.find('>')? + 1;
            continue;
        }
        let close = rest.find('>')?;
        let tag = rest.get(1..close)?;
        let tag_span = ByteSpan {
            start: pos as u32,
            end: (pos + close + 1) as u32,
        };
        if tag.contains('\n') {
            tags.push(tag_span);
        }
        if let Some(name) = tag.strip_prefix('/') {
            let top = stack.pop()?;
            let e = elems.get_mut(top)?;
            if e.name != name.trim() {
                return None;
            }
            if let Some(t) = pending.take() {
                if !e.children.is_empty() {
                    // Mixed content is not a configuration shape.
                    return None;
                }
                e.text = Some(t);
            }
            e.extent.end = tag_span.end;
            if stack.is_empty() {
                root_closed = true;
            }
            pos += close + 1;
            continue;
        }
        if root_closed || pending.is_some() {
            return None;
        }
        let self_closing = tag.ends_with('/');
        let body = tag.strip_suffix('/').unwrap_or(tag);
        let name_len = body.find(|c: char| !is_name_char(c)).unwrap_or(body.len());
        let name = body.get(..name_len)?;
        if name.is_empty() {
            return None;
        }
        let mut elem = Elem {
            name: name.to_owned(),
            name_span: ByteSpan {
                start: (pos + 1) as u32,
                end: (pos + 1 + name_len) as u32,
            },
            children: Vec::new(),
            text: None,
            attrs: Vec::new(),
            extent: tag_span,
        };
        // Attributes: name="value" or name='value'.
        let mut at = pos + 1 + name_len;
        let tag_end = pos + close - usize::from(self_closing);
        while at < tag_end {
            let c = *bytes.get(at)?;
            if c.is_ascii_whitespace() {
                at += 1;
                continue;
            }
            let rest = text.get(at..tag_end)?;
            let eq = rest.find('=')?;
            let aname = rest.get(..eq)?.trim();
            if aname.is_empty() || !aname.chars().all(is_name_char) {
                return None;
            }
            let after = rest.get(eq + 1..)?;
            let lead = after.len() - after.trim_start().len();
            let quote = after.trim_start().chars().next()?;
            if quote != '"' && quote != '\'' {
                return None;
            }
            let vstart = at + eq + 1 + lead;
            let inner = text.get(vstart + 1..tag_end)?;
            let vlen = inner.find(quote)?;
            elem.attrs.push(Attr {
                name: aname.to_owned(),
                name_span: ByteSpan {
                    start: at as u32,
                    end: (at + aname.len()) as u32,
                },
                value: decode(inner.get(..vlen)?),
                value_span: ByteSpan {
                    start: vstart as u32,
                    end: (vstart + vlen + 2) as u32,
                },
            });
            at = vstart + vlen + 2;
        }
        let idx = elems.len();
        if let Some(parent) = stack.last().copied() {
            elems.get_mut(parent)?.children.push(idx);
        } else if !elems.is_empty() {
            return None;
        }
        elems.push(elem);
        if !self_closing {
            stack.push(idx);
        }
        pos += close + 1;
    }
    (stack.is_empty() && !elems.is_empty()).then_some(Doc {
        elems,
        comments,
        tags,
    })
}

/// Physical lines, with each span in `joins` holding its lines together.
fn logical_lines(capture: &str, joins: &[ByteSpan]) -> Vec<LogicalLine> {
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
    // `glue[i]`: physical line i continues into i + 1.
    let mut glue = vec![false; physical.len()];
    let line_of = |pos: u32| physical.partition_point(|p| p.end < pos);
    for span in joins {
        let (a, b) = (line_of(span.start), line_of(span.end.saturating_sub(1)));
        for g in glue.iter_mut().take(b).skip(a) {
            *g = true;
        }
    }
    let mut lines = Vec::new();
    let mut i = 0usize;
    while i < physical.len() {
        let mut pieces = Vec::new();
        while let Some(span) = physical.get(i).copied() {
            pieces.push(span);
            let more = glue.get(i).copied().unwrap_or(false);
            i += 1;
            if !more {
                break;
            }
        }
        let blank = pieces.len() == 1
            && pieces
                .first()
                .map(|s| frame::slice(capture, *s).trim().is_empty())
                .unwrap_or(true);
        lines.push(LogicalLine {
            ordinal: LineOrdinal(lines.len() as u32),
            join: if pieces.len() > 1 {
                JoinKind::Backslash
            } else {
                JoinKind::None
            },
            pieces,
            class: if blank {
                LineClass::Blank
            } else {
                LineClass::Statement
            },
        });
    }
    lines
}

/// The words of a span, as bare tokens for the sweep. Markup separates words
/// as whitespace does, so `<password>hunter2</password>` is `password`,
/// `hunter2`, `/password`, and the sweep's leaf-name walk sees the value
/// follow its name.
fn word_tokens(capture: &str, span: ByteSpan) -> Vec<Token> {
    let text = frame::slice(capture, span);
    let mut out = Vec::new();
    let mut start: Option<usize> = None;
    for (at, ch) in text
        .char_indices()
        .chain(std::iter::once((text.len(), ' ')))
    {
        if ch.is_whitespace() || ch == '<' || ch == '>' {
            if let Some(s) = start.take() {
                out.push(bare(ByteSpan {
                    start: span.start + s as u32,
                    end: span.start + at as u32,
                }));
            }
        } else if start.is_none() {
            start = Some(at);
        }
    }
    if out.is_empty() {
        out.push(bare(span));
    }
    out
}

/// A value the leaf statement cannot fully speak for: words, or a
/// `key=value`/`key: value` of its own.
fn needs_sweep(value: &str) -> bool {
    value.contains(|c: char| c.is_whitespace() || c == '=' || c == ':')
}

struct Builder<'a> {
    doc: &'a Doc,
    tree: StmtTree,
    intern: BTreeMap<String, SegId>,
    stmts: Vec<Stmt>,
    /// Per statement: its last segment is a value (not a flag's name).
    valued: Vec<bool>,
    noise: Vec<UnshapedLine>,
    /// For each statement, the logical line it belongs to.
    line_of: &'a dyn Fn(u32) -> usize,
    lines: &'a [LogicalLine],
}

impl Builder<'_> {
    fn emit(&mut self, at: u32, segs: &[(String, ByteSpan)], valued: bool) {
        let idx = (self.line_of)(at);
        let Some(line) = self.lines.get(idx) else {
            return;
        };
        let span = line_span(line);
        let last = segs.len().saturating_sub(1);
        let mut path = Vec::with_capacity(segs.len());
        let mut tokens = Vec::with_capacity(segs.len());
        for (i, (text, s)) in segs.iter().enumerate() {
            path.push(node(
                &mut self.tree,
                &mut self.intern,
                text,
                span,
                line.ordinal,
                i == last,
            ));
            tokens.push(bare(*s));
        }
        self.stmts.push(Stmt {
            line: line.ordinal,
            span,
            path,
            tokens,
            list_pos: 0,
        });
        self.valued.push(valued);
    }

    fn sweep(&mut self, at: u32, span: ByteSpan, kind: TokenKind) {
        let Some(line) = self.lines.get((self.line_of)(at)) else {
            return;
        };
        self.noise.push(UnshapedLine {
            line: line.ordinal,
            span,
            tokens: vec![Token { kind, span }],
        });
    }

    /// The statements under element `idx`, whose own path is `prefix`.
    fn walk(&mut self, idx: usize, prefix: &[(String, ByteSpan)], named: bool) {
        let doc = self.doc;
        let Some(e) = doc.elems.get(idx) else {
            return;
        };
        let leaf_text = |c: &usize| {
            doc.elems
                .get(*c)
                .filter(|k| k.children.is_empty())
                .and_then(|k| k.text.as_ref().map(|t| (k, t)))
        };
        let id = IDENTITY_KEYS.iter().find_map(|key| {
            e.children
                .iter()
                .find(|c| leaf_text(c).is_some_and(|(k, t)| k.name == *key && !t.1.is_empty()))
                .copied()
        });
        let mut own: Vec<(String, ByteSpan)> = prefix.to_vec();
        if named {
            own.push((e.name.clone(), e.name_span));
        }
        if let Some((k, (span, value))) = id.and_then(|c| leaf_text(&c)) {
            own.push((k.name.clone(), k.name_span));
            own.push((value.clone(), *span));
            self.emit(span.start, &own, true);
        }
        for a in &e.attrs {
            let mut segs = own.clone();
            segs.push((a.name.clone(), a.name_span));
            segs.push((a.value.clone(), a.value_span));
            self.emit(a.value_span.start, &segs, true);
            if needs_sweep(&a.value) {
                self.sweep(a.value_span.start, a.value_span, TokenKind::Quoted);
            }
        }
        for c in &e.children {
            if Some(*c) == id {
                continue;
            }
            let Some(k) = doc.elems.get(*c) else {
                continue;
            };
            if !k.children.is_empty() || !k.attrs.is_empty() {
                self.walk(*c, &own, true);
                continue;
            }
            let mut segs = own.clone();
            segs.push((k.name.clone(), k.name_span));
            match &k.text {
                Some((span, value)) => {
                    segs.push((value.clone(), *span));
                    self.emit(span.start, &segs, true);
                    if needs_sweep(value) {
                        self.sweep(span.start, *span, TokenKind::Bare);
                    }
                }
                // `<enable/>` or `<enable></enable>`: a flag.
                None => self.emit(k.name_span.start, &segs, false),
            }
        }
    }
}

/// The whole read: a backup in, an [`IngestOutput`] out, identical in shape
/// to what [`crate::ingest`] returns for a `set`-form paste. The root
/// element's own name is not part of any path.
pub fn ingest_xml(paste: &[u8], dict: &Dictionary) -> Result<IngestOutput, IngestRefusal> {
    let framed = frame::frame(paste)?;
    let mut capture = framed.capture;
    let doc = parse(&capture);

    let mut joins: Vec<ByteSpan> = Vec::new();
    if let Some(d) = &doc {
        joins.extend(d.comments.iter().copied());
        joins.extend(d.tags.iter().copied());
        for e in &d.elems {
            if let Some((span, _)) = &e.text {
                joins.push(*span);
            }
        }
    }
    let lines = logical_lines(&capture, &joins);
    let starts: Vec<u32> = lines
        .iter()
        .map(|l| l.pieces.first().map(|p| p.start).unwrap_or(0))
        .collect();
    let line_of = |pos: u32| starts.partition_point(|s| *s <= pos).saturating_sub(1);

    let empty = Doc {
        elems: Vec::new(),
        comments: Vec::new(),
        tags: Vec::new(),
    };
    let mut b = Builder {
        doc: doc.as_ref().unwrap_or(&empty),
        tree: StmtTree {
            arena: Vec::new(),
            roots: Vec::new(),
            segs: Vec::new(),
        },
        intern: BTreeMap::new(),
        stmts: Vec::new(),
        valued: Vec::new(),
        noise: Vec::new(),
        line_of: &line_of,
        lines: &lines,
    };
    if !b.doc.elems.is_empty() {
        b.walk(0, &[], false);
    }
    let Builder {
        mut tree,
        stmts,
        valued,
        mut noise,
        ..
    } = b;

    let mut has_stmt = vec![false; lines.len()];
    for s in &stmts {
        if let Some(h) = has_stmt.get_mut(s.line.0 as usize) {
            *h = true;
        }
    }
    let comment_lines: Vec<usize> = doc
        .as_ref()
        .map(|d| d.comments.iter().map(|c| line_of(c.start)).collect())
        .unwrap_or_default();

    let mut outcomes: Vec<Outcome> = Vec::new();
    let mut unshaped: Vec<UnshapedLine> = Vec::new();
    for (idx, line) in lines.iter().enumerate() {
        let span = line_span(line);
        if line.class == LineClass::Blank {
            outcomes.push(Outcome::new(LineOutcome::Blank));
            continue;
        }
        if doc.is_none() {
            outcomes.push(Outcome::new(LineOutcome::Unshaped {
                reason: ShapeError::UnterminatedBracket,
            }));
            unshaped.push(UnshapedLine {
                line: line.ordinal,
                span,
                tokens: word_tokens(&capture, span),
            });
            continue;
        }
        let stmt_line = has_stmt.get(idx).copied().unwrap_or(false);
        if stmt_line || comment_lines.contains(&idx) {
            outcomes.push(Outcome::new(LineOutcome::Unmapped { known_prefix: 0 }));
        } else {
            outcomes.push(Outcome::new(LineOutcome::Header { columns: 0 }));
        }
        if !stmt_line {
            noise.push(UnshapedLine {
                line: line.ordinal,
                span,
                tokens: word_tokens(&capture, span),
            });
        }
    }

    let matches = dict.match_statements(&tree, &stmts);
    // ALLOWLIST, NOT DENY-LIST: every value the dictionary does not describe
    // is destroyed. pfSense stores private keys, VPN keys and PPP passwords
    // base64-encoded (no word or shape detector sees a password in
    // `aHVudGVyMg==`), carries SSH host keys deflated then base64-encoded, and
    // every package adds fields nobody can list in advance
    // (`corpus/dict/README-pfsense.md`). What survives in the stored capture
    // is what an entry was written for.
    let forced: Vec<(usize, usize)> = matches
        .iter()
        .enumerate()
        .filter(|(at, m)| {
            let len = stmts.get(*at).map(|s| s.path.len()).unwrap_or(0);
            valued.get(*at).copied().unwrap_or(false) && (m.entry.is_none() || m.consumed < len)
        })
        .map(|(at, _)| (at, stmts.get(at).map(|s| s.path.len()).unwrap_or(1) - 1))
        .collect();
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

fn line_span(line: &LogicalLine) -> ByteSpan {
    ByteSpan {
        start: line.pieces.first().map(|p| p.start).unwrap_or(0),
        end: line.pieces.last().map(|p| p.end).unwrap_or(0),
    }
}

/// One fresh arena node per path position per statement, for the reason
/// `csv.rs`'s `node` gives.
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
    fn the_root_is_named_exactly() {
        assert_eq!(
            root_element(b"<?xml version=\"1.0\"?>\n<pfsense>\n"),
            Some("pfsense")
        );
        assert_eq!(root_element(b"\xef\xbb\xbf<pfsense>"), Some("pfsense"));
        assert_eq!(root_element(b"<!-- c -->\n<opnsense>"), Some("opnsense"));
        assert_eq!(root_element(b"set system host-name x"), None);
        assert_eq!(root_element(b"---- BEGIN config.xml ----\n"), None);
        assert_eq!(root_element(b""), None);
    }

    #[test]
    fn entities_decode() {
        assert_eq!(decode("a&amp;b&lt;c&#65;&#x42;&bogus;"), "a&b<cAB&bogus;");
    }

    #[test]
    fn a_document_parses_into_leaves() {
        let d = parse("<r><a>1</a><b x=\"y\"/><c><![CDATA[<z>]]></c></r>").unwrap();
        assert_eq!(d.elems.len(), 4);
        assert_eq!(d.elems[1].text.as_ref().unwrap().1, "1");
        assert_eq!(d.elems[2].attrs[0].value, "y");
        assert_eq!(d.elems[3].text.as_ref().unwrap().1, "<z>");
    }

    #[test]
    fn malformed_documents_are_refused() {
        assert!(parse("<r><a>1</b></r>").is_none());
        assert!(parse("<r><a>1</a>").is_none());
        assert!(parse("<r>text<a/></r>").is_none());
        assert!(parse("<r/><s/>").is_none());
        assert!(parse("<r><a>1</a></r>trailing").is_none());
    }
}
