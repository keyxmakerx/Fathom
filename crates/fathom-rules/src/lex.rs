//! fex's lexer. Bounded: a source over `MAX_SOURCE` bytes or `MAX_TOKENS` tokens is
//! refused before it is parsed, so the parser's work is bounded by constants.

use crate::value::{parse_ip, parse_net, Ip};

pub const MAX_SOURCE: usize = 4096;
pub const MAX_TOKENS: usize = 1024;

#[derive(Debug, Clone, PartialEq)]
pub enum Tok {
    Int(i64),
    Str(String),
    Ident(String),
    Addr(Ip),
    Prefix(Ip, u8),
    LParen,
    RParen,
    LBrack,
    RBrack,
    Comma,
    Dot,
    Question,
    Colon,
    Bang,
    Plus,
    Minus,
    EqEq,
    Ne,
    Lt,
    Le,
    Gt,
    Ge,
    AndAnd,
    OrOr,
    Eof,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Error {
    pub pos: usize,
    pub msg: String,
}

pub(crate) fn err(pos: usize, msg: impl Into<String>) -> Error {
    Error {
        pos,
        msg: msg.into(),
    }
}

pub fn lex(src: &str) -> Result<Vec<(Tok, usize)>, Error> {
    if src.len() > MAX_SOURCE {
        return Err(err(
            0,
            format!(
                "expression is {} bytes; the limit is {MAX_SOURCE}",
                src.len()
            ),
        ));
    }
    let b = src.as_bytes();
    let mut out: Vec<(Tok, usize)> = Vec::new();
    let mut i = 0;
    while i < b.len() {
        if out.len() >= MAX_TOKENS {
            return Err(err(i, format!("more than {MAX_TOKENS} tokens")));
        }
        let c = b[i];
        let at = i;
        if c.is_ascii_whitespace() {
            i += 1;
            continue;
        }
        let tok = match c {
            b'(' => Tok::LParen,
            b')' => Tok::RParen,
            b'[' => Tok::LBrack,
            b']' => Tok::RBrack,
            b',' => Tok::Comma,
            b'.' => Tok::Dot,
            b'?' => Tok::Question,
            b':' => Tok::Colon,
            b'+' => Tok::Plus,
            b'-' => Tok::Minus,
            b'!' if b.get(i + 1) == Some(&b'=') => {
                i += 1;
                Tok::Ne
            }
            b'!' => Tok::Bang,
            b'=' if b.get(i + 1) == Some(&b'=') => {
                i += 1;
                Tok::EqEq
            }
            b'<' if b.get(i + 1) == Some(&b'=') => {
                i += 1;
                Tok::Le
            }
            b'<' => Tok::Lt,
            b'>' if b.get(i + 1) == Some(&b'=') => {
                i += 1;
                Tok::Ge
            }
            b'>' => Tok::Gt,
            b'&' if b.get(i + 1) == Some(&b'&') => {
                i += 1;
                Tok::AndAnd
            }
            b'|' if b.get(i + 1) == Some(&b'|') => {
                i += 1;
                Tok::OrOr
            }
            b'"' => {
                let mut s = String::new();
                i += 1;
                loop {
                    match b.get(i) {
                        None => return Err(err(at, "unterminated string")),
                        Some(b'"') => break,
                        Some(b'\\') => match b.get(i + 1) {
                            Some(b'"') => {
                                s.push('"');
                                i += 2;
                            }
                            Some(b'\\') => {
                                s.push('\\');
                                i += 2;
                            }
                            _ => return Err(err(i, "only \\\" and \\\\ are escapes")),
                        },
                        Some(_) => {
                            // Copy one whole UTF-8 scalar, not a byte.
                            let ch = src[i..].chars().next().unwrap_or('\u{fffd}');
                            s.push(ch);
                            i += ch.len_utf8();
                        }
                    }
                }
                Tok::Str(s)
            }
            b'0'..=b'9' => {
                let start = i;
                while i < b.len() && (b[i].is_ascii_digit() || b[i] == b'.') {
                    i += 1;
                }
                // `10.0.0.1/24`: a prefix literal is digits, dots, a slash, digits.
                let mut end = i;
                if b.get(i) == Some(&b'/') && b.get(i + 1).is_some_and(u8::is_ascii_digit) {
                    i += 1;
                    while i < b.len() && b[i].is_ascii_digit() {
                        i += 1;
                    }
                    end = i;
                }
                let text = &src[start..end];
                let tok = if text.contains('/') {
                    let (ip, len) = parse_net(text)
                        .ok_or_else(|| err(start, format!("`{text}` is not an address prefix")))?;
                    Tok::Prefix(ip, len)
                } else if text.contains('.') {
                    Tok::Addr(
                        parse_ip(text)
                            .ok_or_else(|| err(start, format!("`{text}` is not an address")))?,
                    )
                } else {
                    Tok::Int(
                        text.parse::<i64>()
                            .map_err(|_| err(start, format!("`{text}` is not a 64-bit integer")))?,
                    )
                };
                out.push((tok, start));
                continue;
            }
            c if c.is_ascii_alphabetic() || c == b'_' => {
                let start = i;
                while i < b.len() && (b[i].is_ascii_alphanumeric() || b[i] == b'_') {
                    i += 1;
                }
                out.push((Tok::Ident(src[start..i].to_owned()), start));
                continue;
            }
            _ => {
                let ch = src[i..].chars().next().unwrap_or('\u{fffd}');
                return Err(err(i, format!("unexpected `{ch}`")));
            }
        };
        i += 1;
        out.push((tok, at));
    }
    out.push((Tok::Eof, b.len()));
    Ok(out)
}
