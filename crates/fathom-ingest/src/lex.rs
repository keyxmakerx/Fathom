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
    /// A second quote character. A token opened with it closes with it. EdgeOS/Vyatta
    /// `show configuration commands` prints single-quoted values (`'a b c'`), and a lexer
    /// that split them at spaces left the tail of a secret in the capture.
    pub alt_quote: Option<char>,
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
    alt_quote: Some('\''),
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
        let is_quote = |c: char| c == table.quote || Some(c) == table.alt_quote;
        if is_quote(ch) {
            // One token however many quoted and bare pieces are glued with no space
            // between them (`'a'b c'` is one word, as a shell reads it), so a value split
            // by an inner quote is not left half-gated. An unterminated quote still
            // emits the rest of the line as a token before it errs: the gate looks back
            // from tokens that exist, and a secret word followed by nothing finds none.
            let mut end = start;
            let mut open = Some(ch);
            loop {
                if let Some(close) = open.take() {
                    it.next();
                    let mut escaped = false;
                    let mut closed = None;
                    for (at2, ch2) in it.by_ref() {
                        if escaped {
                            escaped = false;
                        } else if ch2 == table.escape {
                            escaped = true;
                        } else if ch2 == close {
                            closed = Some(base + (at2 + ch2.len_utf8()) as u32);
                            break;
                        }
                    }
                    let Some(e) = closed else {
                        out.push(Token {
                            kind: TokenKind::Quoted,
                            span: ByteSpan {
                                start,
                                end: base + text.len() as u32,
                            },
                        });
                        return Err(ShapeError::UnterminatedQuote);
                    };
                    end = e;
                }
                match it.peek().copied() {
                    Some((_, c)) if is_quote(c) => open = Some(c),
                    Some((at2, c))
                        if !table.bare_excludes.contains(&c)
                            && c != table.list_open
                            && c != table.list_close =>
                    {
                        end = base + (at2 + c.len_utf8()) as u32;
                        it.next();
                    }
                    _ => break,
                }
            }
            out.push(Token {
                kind: TokenKind::Quoted,
                span: ByteSpan { start, end },
            });
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
    // Read as a shell reads a word: quoted pieces lose their quotes and resolve their
    // escapes, glued bare pieces stay as written (`"a"b` is `ab`, #104 item 5).
    let is_quote = |c: char| c == table.quote || Some(c) == table.alt_quote;
    let mut out = String::with_capacity(raw.len());
    let mut open: Option<char> = None;
    let mut escaped = false;
    for ch in raw.chars() {
        match open {
            Some(q) => {
                if escaped {
                    out.push(ch);
                    escaped = false;
                } else if ch == table.escape {
                    escaped = true;
                } else if ch == q {
                    open = None;
                } else {
                    out.push(ch);
                }
            }
            None if is_quote(ch) => open = Some(ch),
            None => out.push(ch),
        }
    }
    if open.is_some() {
        // Unterminated: the token ran to the end of the line. Keep the old reading,
        // opening quote and all, so the shaper never sees a value that looks closed.
        let q = raw.chars().next().unwrap_or(table.quote);
        let inner = raw.strip_prefix(q).unwrap_or(raw);
        return format!("{q}{}", unescape(inner, table));
    }
    out
}

fn unescape(text: &str, table: &LexTable) -> String {
    let mut out = String::with_capacity(text.len());
    let mut escaped = false;
    for ch in text.chars() {
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

    /// #104 item 5: a glued quoted token interns as a shell reads it, quotes dropped.
    #[test]
    fn glued_quoted_token_interns_without_its_quotes() {
        let text = "set x \"a\"b 'c d'e\"f\"";
        let tokens = scan_all(text);
        assert_eq!(interned_text(text, &tokens[2], &JUNOS_SET), "ab");
        assert_eq!(interned_text(text, &tokens[3], &JUNOS_SET), "c def");
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
