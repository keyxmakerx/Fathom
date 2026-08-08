//! Stage 2 — lex: the shared scanner, driven by a per-platform token table.
//!
//! `14` §2.2 makes the lexer *"shared scanner, per-platform token table"* and
//! §5.5 prices the table as *"Data + a few lines"*. The scanner below is the
//! few lines; [`JUNOS_SET`] is the data.

use crate::frame::{self, ByteSpan, ShapeError};

/// The per-platform half of stage 2 (14 §2.2): data, not code.
#[derive(Debug, Clone, Copy)]
pub struct LexTable {
    pub quote: char,
    pub escape: char,
    /// Bracket-list delimiters (14 §5.1's bracket_list production).
    pub list_open: char,
    pub list_close: char,
    /// Bytes that may appear in a bare token: everything printable except
    /// space, tab, the quote and the two list delimiters (14 §5.1: bare :=
    /// [^ \t"\[\]]+ ).
    pub bare_excludes: &'static [char],
}

/// junos-srx `display set` (14 §5.1's eleven-line grammar).
pub const JUNOS_SET: LexTable = LexTable {
    quote: '"',
    escape: '\\',
    list_open: '[',
    list_close: ']',
    bare_excludes: &[' ', '\t', '"', '[', ']'],
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TokenKind {
    Bare,
    Quoted,
    ListOpen,
    ListClose,
}

#[derive(Debug, Clone, Copy)]
pub struct Token {
    pub kind: TokenKind,
    pub span: frame::ByteSpan,
}

/// Scans one physical piece of a logical line. `span` is the piece's extent in
/// capture coordinates; tokens carry capture coordinates too, which is what
/// lets the gate rewrite them and `token_spans_slice_back` hold.
///
/// Iterative by construction — there is no recursion on input length or depth
/// (`14` §11.6).
pub(crate) fn scan(
    capture: &str,
    span: ByteSpan,
    table: &LexTable,
    out: &mut Vec<Token>,
) -> Result<(), ShapeError> {
    let text = frame::slice(capture, span);
    let base = span.start;
    let mut it = text.char_indices().peekable();
    while let Some(&(at, ch)) = it.peek() {
        if ch == ' ' {
            it.next();
            continue;
        }
        let start = base + at as u32;
        if ch == table.list_open || ch == table.list_close {
            it.next();
            out.push(Token {
                kind: if ch == table.list_open {
                    TokenKind::ListOpen
                } else {
                    TokenKind::ListClose
                },
                span: ByteSpan {
                    start,
                    end: start + ch.len_utf8() as u32,
                },
            });
            continue;
        }
        if ch == table.quote {
            it.next();
            let mut escaped = false;
            let mut closed = None;
            for (at2, ch2) in it.by_ref() {
                if escaped {
                    escaped = false;
                } else if ch2 == table.escape {
                    escaped = true;
                } else if ch2 == table.quote {
                    closed = Some(base + (at2 + ch2.len_utf8()) as u32);
                    break;
                }
            }
            match closed {
                Some(end) => out.push(Token {
                    kind: TokenKind::Quoted,
                    span: ByteSpan { start, end },
                }),
                None => return Err(ShapeError::UnterminatedQuote),
            }
            continue;
        }
        // Bare: everything up to the next excluded character.
        let mut end = base + (at + ch.len_utf8()) as u32;
        it.next();
        while let Some(&(at2, ch2)) = it.peek() {
            if table.bare_excludes.contains(&ch2) {
                break;
            }
            end = base + (at2 + ch2.len_utf8()) as u32;
            it.next();
        }
        out.push(Token {
            kind: TokenKind::Bare,
            span: ByteSpan { start, end },
        });
    }
    Ok(())
}

/// A token's own text, quotes included (§4.4: quoted tokens keep their quotes
/// in the span; the shaper strips them when it interns).
pub(crate) fn token_text<'a>(capture: &'a str, token: &Token) -> &'a str {
    frame::slice(capture, token.span)
}

/// A quoted token's content with the quotes removed and escapes resolved
/// (`\"` → `"`, `\\` → `\`); a bare token unchanged. This is what the shaper
/// interns, which is why a segment can never be a slice of the capture
/// (§12 item 10).
pub(crate) fn interned_text(capture: &str, token: &Token, table: &LexTable) -> String {
    let raw = token_text(capture, token);
    if token.kind != TokenKind::Quoted {
        return raw.to_owned();
    }
    let inner = raw
        .strip_prefix(table.quote)
        .and_then(|t| t.strip_suffix(table.quote))
        .unwrap_or(raw);
    let mut out = String::with_capacity(inner.len());
    let mut escaped = false;
    for ch in inner.chars() {
        if escaped {
            out.push(ch);
            escaped = false;
        } else if ch == table.escape {
            escaped = true;
        } else {
            out.push(ch);
        }
    }
    if escaped {
        out.push(table.escape);
    }
    out
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

    fn scan_all(text: &str) -> Vec<Token> {
        let mut out = Vec::new();
        scan(
            text,
            ByteSpan {
                start: 0,
                end: text.len() as u32,
            },
            &JUNOS_SET,
            &mut out,
        )
        .expect("scans");
        out
    }

    /// 14 §3.8's mitigation row: every token's span slices back to its own
    /// text, so a span can never name bytes the token does not own.
    #[test]
    fn token_spans_slice_back() {
        let text = "set security ike policy IKE-POL proposals [ P1 P2 ] \"a b\\\"c\"";
        let tokens = scan_all(text);
        let mut rebuilt = String::new();
        for token in &tokens {
            let slice = token_text(text, token);
            assert!(!slice.is_empty(), "empty token span");
            assert_eq!(
                slice,
                &text[token.span.start as usize..token.span.end as usize]
            );
            rebuilt.push_str(slice);
        }
        assert_eq!(tokens.len(), 11);
        assert_eq!(tokens[6].kind, TokenKind::ListOpen);
        assert_eq!(tokens[9].kind, TokenKind::ListClose);
        assert_eq!(tokens[10].kind, TokenKind::Quoted);
        assert!(rebuilt.contains("IKE-POL"));
    }

    #[test]
    fn quoted_token_interns_escape_resolved() {
        let text = "set x \"a \\\"b\\\" c\"";
        let tokens = scan_all(text);
        assert_eq!(interned_text(text, &tokens[2], &JUNOS_SET), "a \"b\" c");
    }

    #[test]
    fn unterminated_quote_is_a_shape_error() {
        let text = "set x \"open";
        let mut out = Vec::new();
        let err = scan(
            text,
            ByteSpan {
                start: 0,
                end: text.len() as u32,
            },
            &JUNOS_SET,
            &mut out,
        )
        .unwrap_err();
        assert_eq!(err, ShapeError::UnterminatedQuote);
    }
}
