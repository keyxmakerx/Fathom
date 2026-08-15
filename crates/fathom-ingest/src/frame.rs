//! Stage 1 — frame: a paste becomes logical lines, and the ledger that makes
//! *"nothing parsed is silently lost"* an arithmetic identity rather than a
//! promise (`14` §4).
//!
//! The framer classifies damage; it never removes it. Every byte of the
//! capture ends up inside exactly one ledger span or inside exactly one
//! single-byte separator between two of them — Invariant L, `14` §4.6.

use crate::{bind, redact, IngestRefusal, MAX_PASTE_BYTES, MAX_PASTE_LINES};

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub struct ByteSpan {
    pub start: u32,
    pub end: u32,
} // capture coordinates

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub struct LineOrdinal(pub u32); // dense, from 0, input order

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum JoinKind {
    None,
    Backslash,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NoiseClass {
    Prompt,
    CommandEcho,
    ClusterBanner,
    Pagination,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LineClass {
    Statement,
    Noise(NoiseClass),
    Blank,
}

#[derive(Debug, Clone)]
pub struct LogicalLine {
    pub ordinal: LineOrdinal,
    /// Physical-line spans joined to make this line; len 1 unless Backslash.
    pub pieces: Vec<ByteSpan>,
    pub join: JoinKind,
    pub class: LineClass,
}

#[derive(Debug, Clone)]
pub struct LineLedger {
    pub capture_len: u32,
    pub lines: Vec<LedgerEntry>,
}

#[derive(Debug, Clone)]
pub struct LedgerEntry {
    pub ordinal: LineOrdinal,
    pub span: ByteSpan, // post-redaction coordinates, 14 §9.5
    pub outcome: LineOutcome,
    pub diags: Vec<Diag>,
}

/// 14 §8.3's contract, transcribed with two slice notes (§12 items 3–4).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LineOutcome {
    Bound {
        node: bind::FragNodeId,
        fields: u16,
        edges: u16,
    },
    /// Path shaped cleanly; dictionary has no binding for it. `known_prefix`
    /// is the number of leading path segments the trie recognised.
    Unmapped {
        known_prefix: u8,
    },
    Unshaped {
        reason: ShapeError,
    },
    Noise {
        class: NoiseClass,
    },
    Blank,
    /// A table's header row — the line that named the columns (`csv.rs`).
    ///
    /// It exists because none of the other arms is true of it. It is not
    /// `Bound`: it produced no node. It is not `Unmapped`: it was understood
    /// completely, and calling it "not in the dictionary" would send an
    /// operator looking for a dictionary entry that must never exist. It is not
    /// `Noise`: noise is text a terminal added, and this is the line that gives
    /// every other line its meaning.
    Header {
        columns: u16,
    },
    /// 14 §9.7 — text destroyed, sketch stored, length recorded.
    Quarantined {
        label: redact::RedactLabel,
        orig_len: u32,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ShapeError {
    /// First token is not one of the 12 config-mode verbs and the line is
    /// not noise. Covers clipped heads, wraps, markers — everything §4.1
    /// defers (14 §4.3's refuse-to-guess rule).
    NotVerbInitial,
    /// A recognised verb this slice does not bind (everything except `set`).
    UnsupportedVerb,
    UnterminatedQuote,
    UnterminatedBracket,
    /// Final physical line ends with an unquoted `\`.
    UnterminatedContinuation,
    /// A `binds`-key capture failed Identifier/u32 parse, or was redacted at
    /// the gate (§4.6's read-path DECISION, rule 3) — the node cannot be
    /// identified, so nothing on the line may bind.
    KeyUnparsable,
    /// More than 64 path segments (14 §11.6's depth cap at this layer).
    TooManySegments,
}

/// Per-line diagnostics that do not change the outcome class.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Diag {
    /// 14 §7.1: a value failed Scalar::parse / enum from_token / token-map
    /// lookup; the rest of the statement still bound.
    ValueUnparsed { key: fathom_ir::bag::FieldKey },
}

// ---------------------------------------------------------------------------
// The framer itself. Everything below is private to the crate: `14` §4's
// stages are an implementation, not an API.
// ---------------------------------------------------------------------------

/// The framer's output, carried between stages inside one `ingest` call.
#[derive(Debug)]
pub(crate) struct Framed {
    pub(crate) capture: String,
    pub(crate) lines: Vec<LogicalLine>,
    /// Frame-detected shape errors, by logical-line index. `14` §4.3's
    /// unterminated continuation is the only one this stage can see.
    pub(crate) frame_errors: Vec<Option<ShapeError>>,
    pub(crate) truncated: bool,
}

/// The one checked slice in the crate: `clippy::indexing_slicing` is denied
/// crate-wide, so every read of the capture goes through here. An out-of-range
/// or non-boundary span yields the empty string rather than a panic — a
/// parser that traps is a parser that loses the paste (`14` §13.5).
pub(crate) fn slice(text: &str, span: ByteSpan) -> &str {
    text.get(span.start as usize..span.end as usize)
        .unwrap_or("")
}

pub(crate) fn frame(paste: &[u8]) -> Result<Framed, IngestRefusal> {
    // 1. Refusals first: size caps, then strict UTF-8 (14 §11.4, §4.2 step 2).
    let raw_lines = paste.iter().filter(|b| **b == b'\n').count() + 1;
    if paste.len() > MAX_PASTE_BYTES || raw_lines > MAX_PASTE_LINES {
        return Err(IngestRefusal::TooLarge {
            bytes: paste.len(),
            lines: raw_lines,
        });
    }
    let decoded = match core::str::from_utf8(paste) {
        Ok(s) => s,
        Err(e) => {
            return Err(IngestRefusal::Undecodable {
                offset: e.valid_up_to(),
            })
        }
    };

    // 2. Strip one leading BOM; normalise line endings; tabs become one space
    //    (14 §4.2 steps 1, 3, 6).
    let capture = normalise(decoded);

    // Physical lines: `split('\n')`, not `lines()`. A trailing newline
    // therefore terminates the last line and opens an empty one, which is
    // what makes Invariant L hold exactly (§12 item 14).
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

    // 3. Backslash continuation — the one certain join (14 §4.3).
    let mut lines: Vec<LogicalLine> = Vec::new();
    let mut frame_errors: Vec<Option<ShapeError>> = Vec::new();
    let mut truncated = false;
    let mut i = 0usize;
    while i < physical.len() {
        let mut pieces = Vec::new();
        let mut join = JoinKind::None;
        let mut error = None;
        while let Some(span) = physical.get(i).copied() {
            pieces.push(span);
            if !ends_with_unquoted_backslash(slice(&capture, span)) {
                break;
            }
            if i + 1 >= physical.len() {
                // A trailing `\` on the final line joins nothing.
                error = Some(ShapeError::UnterminatedContinuation);
                break;
            }
            join = JoinKind::Backslash;
            i += 1;
        }
        i += 1;

        // 4/5. Classification. A joined line had a trailing backslash, so it
        //      is a statement candidate by construction.
        let class = if pieces.len() > 1 {
            LineClass::Statement
        } else {
            let text = pieces
                .first()
                .map(|s| slice(&capture, *s))
                .unwrap_or("")
                .trim();
            classify(text)
        };
        if class == LineClass::Noise(NoiseClass::Pagination) {
            truncated = true;
        }
        lines.push(LogicalLine {
            ordinal: LineOrdinal(lines.len() as u32),
            pieces,
            join,
            class,
        });
        frame_errors.push(error);
    }

    Ok(Framed {
        capture,
        lines,
        frame_errors,
        truncated,
    })
}

fn normalise(text: &str) -> String {
    let body = text.strip_prefix('\u{feff}').unwrap_or(text);
    let mut out = String::with_capacity(body.len());
    let mut chars = body.chars().peekable();
    while let Some(ch) = chars.next() {
        match ch {
            '\r' => {
                if chars.peek() == Some(&'\n') {
                    chars.next();
                }
                out.push('\n');
            }
            '\t' => out.push(' '),
            other => out.push(other),
        }
    }
    out
}

/// True when the physical line ends with a `\` that is not inside a quoted
/// token (`14` §4.3's backslash row).
fn ends_with_unquoted_backslash(text: &str) -> bool {
    let mut in_quote = false;
    let mut escaped = false;
    let mut trailing_backslash = false;
    for ch in text.chars() {
        if in_quote {
            if escaped {
                escaped = false;
            } else if ch == '\\' {
                escaped = true;
            } else if ch == '"' {
                in_quote = false;
            }
            trailing_backslash = false;
        } else if ch == '"' {
            in_quote = true;
            trailing_backslash = false;
        } else {
            trailing_backslash = ch == '\\';
        }
    }
    !in_quote && trailing_backslash
}

/// §4.3 rule 4's four noise patterns, exact, plus Blank. Everything else is
/// a Statement and goes to the lexer.
fn classify(text: &str) -> LineClass {
    if text.is_empty() {
        return LineClass::Blank;
    }
    if is_pagination(text) {
        return LineClass::Noise(NoiseClass::Pagination);
    }
    if is_cluster_banner(text) {
        return LineClass::Noise(NoiseClass::ClusterBanner);
    }
    if let Some(rest) = prompt_tail(text) {
        // One class per line: a prompt with an echoed command behind it is
        // CommandEcho, never both (§12 item 4).
        return if rest.is_empty() {
            LineClass::Noise(NoiseClass::Prompt)
        } else {
            LineClass::Noise(NoiseClass::CommandEcho)
        };
    }
    LineClass::Statement
}

fn is_pagination(text: &str) -> bool {
    text == "--More--" || (text.starts_with("---(more") && text.ends_with(")---"))
}

/// `{` + one or more of `[a-z0-9:-]` + `}` and nothing else — `{primary:node0}`,
/// `{backup}` (`14` §4.4).
fn is_cluster_banner(text: &str) -> bool {
    let inner = match text.strip_prefix('{').and_then(|t| t.strip_suffix('}')) {
        Some(i) => i,
        None => return false,
    };
    !inner.is_empty()
        && inner
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == ':' || c == '-')
}

/// `^[A-Za-z0-9_.@-]+[>#]` — returns what follows the prompt character, or
/// `None` when the line is not prompt-initial. `Some("")` is a bare prompt;
/// `Some(" cmd")` is a command echo.
fn prompt_tail(text: &str) -> Option<&str> {
    let mut idx = None;
    for (at, ch) in text.char_indices() {
        if ch == '>' || ch == '#' {
            idx = Some(at);
            break;
        }
        if !(ch.is_ascii_alphanumeric() || ch == '_' || ch == '.' || ch == '@' || ch == '-') {
            return None;
        }
    }
    let at = idx?;
    if at == 0 {
        return None;
    }
    let rest = text.get(at + 1..)?;
    // `Some("")` is a bare prompt; `Some(" cmd")` is a command echo.
    if rest.is_empty() || (rest.starts_with(' ') && rest.len() > 1) {
        Some(rest)
    } else {
        None
    }
}

/// Fills the ledger from the framed lines, their post-gate spans and their
/// outcomes. One entry per logical line, in ordinal order.
pub(crate) fn build_ledger(
    ledger: &mut LineLedger,
    capture: &str,
    lines: &[LogicalLine],
    spans: &[ByteSpan],
    outcomes: &[Outcome],
) {
    ledger.capture_len = capture.len() as u32;
    ledger.lines.clear();
    for (idx, line) in lines.iter().enumerate() {
        let span = spans
            .get(idx)
            .copied()
            .unwrap_or(ByteSpan { start: 0, end: 0 });
        let outcome = outcomes
            .get(idx)
            .map(|o| o.outcome.clone())
            .unwrap_or(LineOutcome::Blank);
        let diags = outcomes
            .get(idx)
            .map(|o| o.diags.clone())
            .unwrap_or_default();
        ledger.lines.push(LedgerEntry {
            ordinal: line.ordinal,
            span,
            outcome,
            diags,
        });
    }
}

/// **Invariant L** (`14` §4.6): the ledger's spans, plus the single-byte
/// separators between them, tile `[0, capture_len)` exactly — no gaps, no
/// overlaps. A `debug_assert` here (WO-03 §5 step 2); the release-build proof
/// is `tests/srx_fixture.rs::fixture_ledger_tiles`, which checks the
/// identity from outside the crate with its own arithmetic.
pub(crate) fn assert_invariant_l(ledger: &LineLedger) {
    debug_assert!(tiles_exactly(ledger), "Invariant L violated");
}

/// The invariant as a pure predicate, so tests can assert it without relying
/// on `debug_assert` being compiled in.
pub(crate) fn tiles_exactly(ledger: &LineLedger) -> bool {
    let mut cursor = 0u32;
    for (idx, entry) in ledger.lines.iter().enumerate() {
        let want = if idx == 0 { cursor } else { cursor + 1 };
        if entry.span.start != want || entry.span.end < entry.span.start {
            return false;
        }
        cursor = entry.span.end;
    }
    if ledger.lines.is_empty() {
        return ledger.capture_len == 0;
    }
    cursor == ledger.capture_len
}

/// One logical line's outcome plus its diagnostics, carried between stages.
#[derive(Debug, Clone)]
pub(crate) struct Outcome {
    pub(crate) outcome: LineOutcome,
    pub(crate) diags: Vec<Diag>,
}

impl Outcome {
    pub(crate) fn new(outcome: LineOutcome) -> Outcome {
        Outcome {
            outcome,
            diags: Vec::new(),
        }
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

    fn ledger_of(paste: &str) -> LineLedger {
        let framed = frame(paste.as_bytes()).expect("frames");
        let spans: Vec<ByteSpan> = framed
            .lines
            .iter()
            .map(|l| ByteSpan {
                start: l.pieces.first().map(|p| p.start).unwrap_or(0),
                end: l.pieces.last().map(|p| p.end).unwrap_or(0),
            })
            .collect();
        let outcomes: Vec<Outcome> = framed
            .lines
            .iter()
            .map(|_| Outcome::new(LineOutcome::Blank))
            .collect();
        let mut ledger = LineLedger {
            capture_len: 0,
            lines: Vec::new(),
        };
        build_ledger(
            &mut ledger,
            &framed.capture,
            &framed.lines,
            &spans,
            &outcomes,
        );
        ledger
    }

    #[test]
    fn ledger_tiles_exactly() {
        for paste in [
            "",
            "\n",
            "set a b",
            "set a b\n",
            "set a b\nset c d\n",
            "set a b\n\nset c d",
            "\r\nset a b\r\n",
            "set a \\\n  b c\nset d e\n",
            "set a b \\",
            "\u{feff}set a b\n",
        ] {
            let ledger = ledger_of(paste);
            assert!(tiles_exactly(&ledger), "Invariant L failed on {paste:?}");
        }
    }

    #[test]
    fn backslash_joins_one_logical_line() {
        let framed = frame(b"set a b \\\n  c d\nset e f\n").expect("frames");
        assert_eq!(
            framed.lines.len(),
            3,
            "two statements plus the trailing empty"
        );
        assert_eq!(framed.lines[0].join, JoinKind::Backslash);
        assert_eq!(framed.lines[0].pieces.len(), 2);
        assert_eq!(framed.lines[1].join, JoinKind::None);
    }

    #[test]
    fn lone_trailing_backslash_is_unterminated() {
        let framed = frame(b"set a b \\").expect("frames");
        assert_eq!(
            framed.frame_errors[0],
            Some(ShapeError::UnterminatedContinuation)
        );
    }

    #[test]
    fn noise_patterns_classify() {
        let framed = frame(
            b"{primary:node0}\nadmin@srx-a-01> show configuration | display set\n\
              ---(more 41%)---\nadmin@srx-a-01>\n--More--\nset a b\n\n",
        )
        .expect("frames");
        let classes: Vec<&LineClass> = framed.lines.iter().map(|l| &l.class).collect();
        assert_eq!(classes[0], &LineClass::Noise(NoiseClass::ClusterBanner));
        assert_eq!(classes[1], &LineClass::Noise(NoiseClass::CommandEcho));
        assert_eq!(classes[2], &LineClass::Noise(NoiseClass::Pagination));
        assert_eq!(classes[3], &LineClass::Noise(NoiseClass::Prompt));
        assert_eq!(classes[4], &LineClass::Noise(NoiseClass::Pagination));
        assert_eq!(classes[5], &LineClass::Statement);
        assert_eq!(classes[6], &LineClass::Blank);
        assert!(framed.truncated);
    }

    #[test]
    fn refusals_are_decided_before_processing() {
        assert_eq!(
            frame(&[0x66, 0xff, 0x67]).unwrap_err(),
            IngestRefusal::Undecodable { offset: 1 }
        );
        let huge = vec![b'\n'; MAX_PASTE_LINES + 1];
        assert!(matches!(
            frame(&huge).unwrap_err(),
            IngestRefusal::TooLarge { .. }
        ));
    }

    #[test]
    fn tabs_and_crlf_normalise() {
        let framed = frame(b"set\ta\r\nset b\r").expect("frames");
        assert_eq!(framed.capture, "set a\nset b\n");
    }
}
