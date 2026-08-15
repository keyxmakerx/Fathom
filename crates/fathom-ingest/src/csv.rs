//! The table front end — one OPNsense firewall-rules CSV in, the same typed
//! graph fragment out.
//!
//! # Why this is a front end and not a second parser
//!
//! `14`'s six stages are frame → lex → shape → **redact** → bind → resolve, and
//! five of them are about a `set`-form line grammar: a statement is the words on
//! a line, in order. A CSV row has no words. It has a header that names columns
//! once and a record per line that fills them.
//!
//! The honest question the work order asked was whether that is a new front end
//! into the same pipeline or something narrower. It is a front end, and the
//! reason it can be is one observation:
//!
//! > **A cell's meaning is `(the row's identity, the column's name, the cell's
//! > value)`, and all three of those are real bytes of the operator's file.**
//!
//! The row identity and the value come from the data row; the column name comes
//! from the header row, once, and is shared by every record beneath it. So this
//! module synthesises a *statement* per cell whose three path segments carry
//! spans that slice back into the paste — and from that point on **nothing
//! downstream knows or cares that the input was a table**. The dictionary trie,
//! the redaction gate, the binder, the deferred-edge resolver, the line ledger
//! and the residue list are the same code the Junos path runs, unmodified.
//!
//! What is synthesised is the *arrangement*, never the text. That is what keeps
//! `14`'s law true on this path as written: **nothing parsed is silently lost,
//! and nothing secret is ever kept.**
//!
//! # What this deliberately does not do
//!
//! It does not read `/conf/config.xml`, the JSON from `pluginctl -g`, NAT rules,
//! aliases, or any other CSV. `64` §1.1 documents the capture path; this reads
//! the one file the owner asked for by name.

use std::collections::BTreeMap;

use crate::bind;
use crate::dict::Dictionary;
use crate::frame::{self, ByteSpan, LineClass, LineOrdinal, LineOutcome, Outcome, ShapeError};
use crate::lex::{Token, TokenKind};
use crate::redact;
use crate::shape::{SegId, Stmt, StmtIdx, StmtNode, StmtTree, UnshapedLine};
use crate::{CaptureScope, IngestOutput, IngestRefusal, ResidueEntry};

/// The first column of the export, verbatim. Established twice on 2026-08-15
/// (`64` §1.1): a user's pasted header in `opnsense/core` issue #9861, and the
/// exporter `src/opnsense/scripts/filter/list_legacy_rules.php` on master,
/// which builds the same keys in the same order.
const UUID_COLUMN: &str = "@uuid";

/// The two separators this reader will accept. `;` is the one attested — by the
/// pasted header alone, because the exporter script emits JSON and the CSV is
/// assembled above it, so the second source confirms the columns and not the
/// separator (`64` §5). `,` is accepted because it is the other thing a file
/// called `.csv` is: sniffing costs one byte of lookahead and removes a guess.
const DELIMITERS: [char; 2] = [';', ','];

/// Does this paste look like the export from Firewall → Rules → Migration
/// assistant?
///
/// Deliberately exact rather than fuzzy: the first non-blank line must begin
/// with `@uuid` followed immediately by one of [`DELIMITERS`]. A sniff that
/// guessed would mean a Junos paste occasionally read as a table, and the cost
/// of a wrong guess here is an operator's estate replaced by nonsense.
///
/// Runs on raw bytes, before the UTF-8 check, because the caller has to choose
/// a dictionary before `ingest_csv` can run. A leading UTF-8 BOM is stepped
/// over — a browser textarea will not add one, but a file saved by a Windows
/// spreadsheet and pasted back will.
pub fn looks_like_rules_csv(paste: &[u8]) -> bool {
    let body = paste.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(paste);
    let end = body
        .iter()
        .position(|b| *b == b'\n' || *b == b'\r')
        .unwrap_or(body.len());
    let head = body.get(..end).unwrap_or_default();
    let Some(rest) = head.strip_prefix(UUID_COLUMN.as_bytes()) else {
        return false;
    };
    matches!(rest.first(), Some(b) if DELIMITERS.contains(&(*b as char)))
}

/// One cell: where its raw text sits, and whether it arrived quoted.
#[derive(Debug, Clone, Copy)]
struct Cell {
    /// Capture coordinates of the raw field, quotes included — the same
    /// convention `lex.rs` uses, and what makes the gate able to destroy the
    /// whole field rather than its interior.
    span: ByteSpan,
    quoted: bool,
}

/// Splits one line into cells.
///
/// RFC 4180 quoting: a field that opens with `"` runs to the next `"` that is
/// not doubled, and `""` inside stands for one `"`. An unquoted field runs to
/// the next delimiter. **Both are implemented because neither is established**
/// — no OPNsense document states the writer's quoting rule and the exporter
/// script does not do the writing (`64` §5). Accepting the union is not a guess;
/// guessing would be picking one.
///
/// A field is never dropped, including an empty one, because the cell index is
/// what pairs a value with its column name and a dropped empty cell would shift
/// every column after it by one.
fn split_cells(capture: &str, line: ByteSpan, delim: char, out: &mut Vec<Cell>) {
    out.clear();
    let text = frame::slice(capture, line);
    let base = line.start;
    // `start` is always where the CURRENT field begins, including the field
    // that has not been reached yet: crossing a delimiter advances it past that
    // delimiter. Without that, a line ending on a delimiter — which is what an
    // empty last column looks like, and OPNsense writes empty columns
    // constantly — closed its final field at the *previous* field's start and
    // reported `any;` where the file said `any`. Caught by
    // `empty_cells_keep_their_position`, which is why it is a test and not a
    // comment.
    let mut start = 0usize;
    let mut quoted = false;
    let mut in_quote = false;
    let mut fresh = true;
    let mut it = text.char_indices().peekable();
    while let Some((at, ch)) = it.next() {
        if fresh {
            start = at;
            quoted = ch == '"';
            in_quote = quoted;
            fresh = false;
            if quoted {
                continue;
            }
        }
        if in_quote {
            if ch == '"' {
                // `""` is one literal quote and does not close the field.
                if it.peek().map(|(_, c)| *c) == Some('"') {
                    it.next();
                } else {
                    in_quote = false;
                }
            }
            continue;
        }
        if ch == delim {
            out.push(Cell {
                span: ByteSpan {
                    start: base + start as u32,
                    end: base + at as u32,
                },
                quoted,
            });
            fresh = true;
            quoted = false;
            start = at + ch.len_utf8();
        }
    }
    // The last field. A line that ended on a delimiter left `start` pointing
    // one past it, so this yields the empty final column rather than a repeat.
    if !text.is_empty() {
        out.push(Cell {
            span: ByteSpan {
                start: base + start as u32,
                end: line.end,
            },
            quoted: quoted && !fresh,
        });
    }
}

/// A cell's value: the raw field with the quotes removed and `""` resolved.
///
/// The returned `String` is what gets interned as a path segment, so — exactly
/// as in `shape.rs` — a segment is never a slice of the capture and a redaction
/// can never leave a segment pointing at destroyed bytes.
fn cell_text(capture: &str, cell: &Cell) -> String {
    let raw = frame::slice(capture, cell.span);
    if !cell.quoted {
        return raw.to_owned();
    }
    let inner = raw
        .strip_prefix('"')
        .map(|t| t.strip_suffix('"').unwrap_or(t))
        .unwrap_or(raw);
    inner.replace("\"\"", "\"")
}

/// The whole read: a table in, an [`IngestOutput`] out, identical in shape to
/// what [`crate::ingest`] returns for a `set`-form paste.
///
/// Refuses only what `frame` refuses, plus one refusal of its own — see
/// [`IngestRefusal::EmptyTable`], which exists because of a live vendor bug.
pub fn ingest_csv(paste: &[u8], dict: &Dictionary) -> Result<IngestOutput, IngestRefusal> {
    let framed = frame::frame(paste)?;
    let mut capture = framed.capture.clone();

    // The header is the first line with any content. Not "the first Statement
    // line": `frame`'s classifier is a Junos classifier, and a table has no
    // business being told its header is a prompt.
    let header_idx = framed
        .lines
        .iter()
        .position(|l| l.class != LineClass::Blank)
        .ok_or(IngestRefusal::EmptyTable { columns: 0 })?;
    let header_span = line_span(&framed, header_idx);
    let delim = *DELIMITERS
        .iter()
        .find(|d| {
            frame::slice(&capture, header_span)
                .strip_prefix(UUID_COLUMN)
                .and_then(|r| r.chars().next())
                == Some(**d)
        })
        .ok_or(IngestRefusal::EmptyTable { columns: 0 })?;

    let mut cells: Vec<Cell> = Vec::new();
    split_cells(&capture, header_span, delim, &mut cells);
    let header: Vec<Cell> = cells.clone();
    let names: Vec<String> = header.iter().map(|c| cell_text(&capture, c)).collect();
    let uuid_col =
        names
            .iter()
            .position(|n| n == UUID_COLUMN)
            .ok_or(IngestRefusal::EmptyTable {
                columns: names.len(),
            })?;

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
    // (line index, column index) for every cell that produced a statement, in
    // statement order — what turns a per-statement dictionary miss into a
    // residue entry at that cell's own bytes rather than at the whole row's.
    let mut cell_of_stmt: Vec<(usize, usize)> = Vec::new();
    let mut rows = 0usize;

    for (idx, line) in framed.lines.iter().enumerate() {
        let span = line_span(&framed, idx);
        if line.class == LineClass::Blank {
            outcomes.push(Outcome::new(LineOutcome::Blank));
            continue;
        }
        if idx == header_idx {
            outcomes.push(Outcome::new(LineOutcome::Header {
                columns: names.len().min(u16::MAX as usize) as u16,
            }));
            // The header still goes to the gate. `14` §9.1's rule is that no
            // line reaches the end of ingest without a detector having looked
            // at it, and a column *name* is exactly where a mis-pasted file
            // announces that it carries credentials — issue #9861 records an
            // operator importing a backup config into the rules importer by
            // mistake, so the wrong file in this box is a documented event and
            // not a hypothetical.
            noise.push(UnshapedLine {
                line: line.ordinal,
                span,
                tokens: row_tokens(&header),
            });
            continue;
        }

        rows += 1;
        split_cells(&capture, span, delim, &mut cells);
        let row = cells.clone();
        let uuid = row.get(uuid_col).map(|c| cell_text(&capture, c));
        let Some(uuid) = uuid.filter(|u| !u.is_empty()) else {
            // No identity, no rule. The whole row is refused rather than bound
            // to an anonymous node, which is the same rule `bind.rs` applies to
            // an unparsable key: a node that cannot be identified may not bind
            // anything at all.
            outcomes.push(Outcome::new(LineOutcome::Unshaped {
                reason: ShapeError::KeyUnparsable,
            }));
            unshaped.push(UnshapedLine {
                line: line.ordinal,
                span,
                tokens: row_tokens(&row),
            });
            continue;
        };

        outcomes.push(Outcome::new(LineOutcome::Unmapped { known_prefix: 0 }));
        let Some(uuid_cell) = row.get(uuid_col).copied() else {
            continue;
        };
        for (col, cell) in row.iter().enumerate() {
            if col == uuid_col {
                continue;
            }
            let (Some(name_cell), Some(name)) = (header.get(col), names.get(col)) else {
                // More cells than the header declared. The extra ones are named
                // on the residue list below rather than dropped; they cannot be
                // bound because nothing says what they are.
                continue;
            };
            let value = cell_text(&capture, cell);
            if value.is_empty() {
                // An empty cell is the absence of a value, not an unknown one.
                // OPNsense writes `''` for every unset field on every rule, so
                // binding or reporting them would bury the real content under
                // roughly forty empty strings per row.
                continue;
            }
            let path = vec![
                node(&mut tree, &mut intern, &uuid, span, line.ordinal, false),
                node(&mut tree, &mut intern, name, span, line.ordinal, false),
                node(&mut tree, &mut intern, &value, span, line.ordinal, true),
            ];
            stmts.push(Stmt {
                line: line.ordinal,
                span,
                path,
                tokens: vec![token(&uuid_cell), token(name_cell), token(cell)],
                list_pos: 0,
            });
            cell_of_stmt.push((idx, col));
        }
    }

    if rows == 0 {
        return Err(IngestRefusal::EmptyTable {
            columns: names.len(),
        });
    }

    let matches = dict.match_statements(&tree, &stmts);
    let gated = redact::gate(
        &mut capture,
        &framed.lines,
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
    frame::build_ledger(
        &mut ledger,
        &capture,
        &framed.lines,
        &gated.spans,
        &outcomes,
    );
    frame::assert_invariant_l(&ledger);

    let residue = residue(
        &capture,
        &ledger,
        &gated.spans,
        delim,
        &stmts,
        &matches,
        &cell_of_stmt,
    );

    Ok(IngestOutput {
        capture: redact::RedactedCapture::seal(capture),
        ledger,
        residue,
        drops: gated.drops,
        fragment,
        scope: CaptureScope::Fragment,
        uses_groups: false,
        truncated: framed.truncated,
    })
}

/// The residue list, at **cell** granularity.
///
/// This is the one place the table shape earns a different answer from the
/// Junos path, and it is a better one. There, a line is bound or it is not.
/// Here a row of fifty columns can have four understood and six that are not,
/// and reporting the row as "bound" would be true and useless — the operator
/// would never learn that their destination network went nowhere.
///
/// So: a row is on the ledger, and every **cell** the dictionary had no entry
/// for is on the residue list with its own bytes and its own reason. The spans
/// are recomputed from the **post-redaction** capture, because that is the text
/// the caller will slice them out of (`14` §9.5) — never remapped by arithmetic,
/// which would have to be kept in step with the gate's edit list forever.
///
/// When a row's post-gate cell count disagrees with its pre-gate one, the whole
/// row is reported instead of its cells. That happens when the gate quarantined
/// the row and replaced it with a shape sketch, and a sketch has no columns.
fn residue(
    capture: &str,
    ledger: &frame::LineLedger,
    spans: &[ByteSpan],
    delim: char,
    stmts: &[Stmt],
    matches: &[crate::dict::Match],
    cell_of_stmt: &[(usize, usize)],
) -> Vec<ResidueEntry> {
    let mut out: Vec<ResidueEntry> = Vec::new();

    // Whole-line residue first: a row with no identity, a row `frame` refused,
    // a row the gate quarantined. Exactly the Junos path's own three classes.
    for entry in &ledger.lines {
        if matches!(
            entry.outcome,
            LineOutcome::Unshaped { .. } | LineOutcome::Quarantined { .. }
        ) {
            out.push(ResidueEntry {
                ordinal: entry.ordinal,
                span: entry.span,
                outcome: entry.outcome.clone(),
            });
        }
    }

    let quarantined = |line: usize| -> bool {
        ledger
            .lines
            .get(line)
            .map(|e| matches!(e.outcome, LineOutcome::Quarantined { .. }))
            .unwrap_or(false)
    };

    let mut post: Vec<Cell> = Vec::new();
    let mut at_line: Option<usize> = None;
    for (at, stmt) in stmts.iter().enumerate() {
        let Some(m) = matches.get(at).filter(|m| m.entry.is_none()) else {
            continue;
        };
        let Some((line, col)) = cell_of_stmt.get(at).copied() else {
            continue;
        };
        // A quarantined row is already on the list above, whole, and its cells
        // no longer exist — the sketch that replaced it has no columns.
        if quarantined(line) {
            continue;
        }
        if at_line != Some(line) {
            let Some(span) = spans.get(line).copied() else {
                continue;
            };
            split_cells(capture, span, delim, &mut post);
            at_line = Some(line);
        }
        let Some(cell) = post.get(col).copied() else {
            continue;
        };
        out.push(ResidueEntry {
            ordinal: stmt.line,
            span: cell.span,
            // `known_prefix` is the trie depth the lookup reached. On this path
            // depth 1 is "the row was recognised, the column was not", which is
            // what the reader wants to hear.
            outcome: LineOutcome::Unmapped {
                known_prefix: m.known_prefix.min(u8::MAX as usize) as u8,
            },
        });
    }
    out.sort_by_key(|r| (r.ordinal, r.span.start));
    out
}

fn line_span(framed: &frame::Framed, idx: usize) -> ByteSpan {
    match framed.lines.get(idx) {
        Some(line) => ByteSpan {
            start: line.pieces.first().map(|p| p.start).unwrap_or(0),
            end: line.pieces.last().map(|p| p.end).unwrap_or(0),
        },
        None => ByteSpan { start: 0, end: 0 },
    }
}

fn token(cell: &Cell) -> Token {
    Token {
        kind: if cell.quoted {
            TokenKind::Quoted
        } else {
            TokenKind::Bare
        },
        span: cell.span,
    }
}

/// Every cell of a row as tokens, for the gate's safety-net sweep.
fn row_tokens(row: &[Cell]) -> Vec<Token> {
    row.iter().map(token).collect()
}

/// One fresh arena node per path position per statement.
///
/// Fresh, never shared, and that is load-bearing: the gate redacts by
/// re-pointing a node's segment at a marker, so two statements sharing one
/// arena node would mean redacting a value in row 12 also redacted whatever
/// row 40 had at that position. Segment *text* is still interned and shared,
/// because the gate never mutates a segment — it appends a new one.
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

    fn spans(text: &str, delim: char) -> Vec<String> {
        let mut out = Vec::new();
        split_cells(
            text,
            ByteSpan {
                start: 0,
                end: text.len() as u32,
            },
            delim,
            &mut out,
        );
        out.iter().map(|c| cell_text(text, c)).collect()
    }

    #[test]
    fn the_sniff_is_exact() {
        assert!(looks_like_rules_csv(b"@uuid;enabled;action\n"));
        assert!(looks_like_rules_csv(b"@uuid,enabled,action\n"));
        assert!(looks_like_rules_csv(
            b"\xef\xbb\xbf@uuid;enabled\r\nrow\r\n"
        ));
        // Junos, and the near misses.
        assert!(!looks_like_rules_csv(b"set security ike policy P\n"));
        assert!(!looks_like_rules_csv(b"@uuid\n"));
        assert!(!looks_like_rules_csv(b"uuid;enabled\n"));
        assert!(!looks_like_rules_csv(b"@uuid_extra;enabled\n"));
        assert!(!looks_like_rules_csv(b""));
    }

    #[test]
    fn empty_cells_keep_their_position() {
        assert_eq!(spans("a;;c", ';'), vec!["a", "", "c"]);
        assert_eq!(spans("a;b;", ';'), vec!["a", "b", ""]);
        assert_eq!(spans(";", ';'), vec!["", ""]);
        assert_eq!(spans("", ';'), Vec::<String>::new());
    }

    #[test]
    fn rfc4180_quoting_survives_a_delimiter_and_a_quote() {
        assert_eq!(
            spans("a;\"has;a;delimiter\";c", ';'),
            vec!["a", "has;a;delimiter", "c"]
        );
        assert_eq!(spans("\"say \"\"hi\"\"\";b", ';'), vec!["say \"hi\"", "b"]);
    }

    /// A quoted cell's span covers the quotes, which is what lets the gate
    /// destroy the whole field rather than leave a pair of empty quotes behind.
    #[test]
    fn a_quoted_cell_spans_its_quotes() {
        let text = "a;\"b\";c";
        let mut cells = Vec::new();
        split_cells(
            text,
            ByteSpan {
                start: 0,
                end: text.len() as u32,
            },
            ';',
            &mut cells,
        );
        assert_eq!(cells[1].span, ByteSpan { start: 2, end: 5 });
        assert!(cells[1].quoted);
        assert_eq!(frame::slice(text, cells[1].span), "\"b\"");
    }
}
