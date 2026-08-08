//! The canonical JSON byte contract (62 §17.1), in one place.
//!
//! Canonical form is a *byte* contract: object keys sorted (`BTreeMap` **is**
//! the sort), no insignificant whitespace, one line plus one trailing LF,
//! UTF-8. Escaping is RFC 8259's minimum: `"`, `\`, and control characters;
//! non-ASCII is emitted as raw UTF-8, never `\u`-escaped — one spelling per
//! string, deterministically.
//!
//! The emitter moved here verbatim from `fathom-schemagen`, which now
//! re-exports it: 35 §5.1 C8 asks for *"one implementation per job"*, and two
//! copies of a byte contract are two contracts as soon as one is edited.
//!
//! Floats are structurally excluded from the IR (11 §14.1, 12 §3.4), but the
//! tree itself carries them in one place — `matching:`, the residue-guard
//! constants (11 §10.4) — and `schema.json` transcribes every tree block so
//! the bump checker (62 §16.4) can classify every diff. The canonical float
//! form is Rust's shortest round-trip decimal (`f64` `Display`): a pure,
//! platform-independent function of the parsed value. Non-finite values have
//! no JSON spelling and no way into a parsed tree.
//!
//! **Two deliberate asymmetries between the emitter and the parser**, both
//! recorded in WO-05 §12.3 and repeated at each site in this file:
//!
//! 1. The emitter can emit [`Json::Float`]; [`Json::parse_canonical`] refuses
//!    every float with [`ParseReason::FloatRefused`]. Nothing this parser
//!    serves carries a float, and one `Json` type beats two.
//! 2. The emitter recurses without a depth limit; the parser refuses nesting
//!    beyond [`MAX_DEPTH`]. Refusing on read what could in principle be
//!    emitted is the safe direction for a hand-editable plaintext file: an
//!    unbounded recursive parser over one is a stack-overflow surface.

#![forbid(unsafe_code)]

use std::collections::BTreeMap;

/// The parser's nesting cap. No schema-shaped value approaches it; an
/// unbounded recursive descent over a hand-editable file is a stack-overflow
/// surface this crate refuses to carry.
pub const MAX_DEPTH: usize = 512;

#[derive(Debug, Clone, PartialEq)]
pub enum Json {
    Null,
    Bool(bool),
    Int(i64),
    /// Finite by construction: `fathom-schemagen`'s `from_node` (the only
    /// tree-conversion path) refuses non-finite values, and nothing else
    /// builds this variant. `parse_canonical` never produces one.
    Float(f64),
    Str(String),
    Arr(Vec<Json>),
    Obj(BTreeMap<String, Json>),
}

impl Json {
    /// Canonical bytes: minified, sorted, one trailing newline.
    pub fn to_canonical_bytes(&self) -> Vec<u8> {
        let mut out = String::new();
        emit(self, &mut out);
        out.push('\n');
        out.into_bytes()
    }
}

fn emit(j: &Json, out: &mut String) {
    match j {
        Json::Null => out.push_str("null"),
        Json::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Json::Int(i) => out.push_str(&i.to_string()),
        Json::Float(f) => {
            // Shortest round-trip decimal; `Display` never uses exponent
            // notation, so the output is always a valid JSON number.
            debug_assert!(f.is_finite(), "non-finite floats refuse at from_node");
            out.push_str(&f.to_string());
        }
        Json::Str(s) => emit_str(s, out),
        Json::Arr(items) => {
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                emit(item, out);
            }
            out.push(']');
        }
        Json::Obj(map) => {
            out.push('{');
            for (i, (k, v)) in map.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                emit_str(k, out);
                out.push(':');
                emit(v, out);
            }
            out.push('}');
        }
    }
}

fn emit_str(s: &str, out: &mut String) {
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            '\u{08}' => out.push_str("\\b"),
            '\u{0c}' => out.push_str("\\f"),
            c if (c as u32) < 0x20 => {
                out.push_str(&format!("\\u{:04x}", c as u32));
            }
            c => out.push(c),
        }
    }
    out.push('"');
}

// ---------------------------------------------------------------------------
// The strict parser

/// Where a canonical parse gave up, and why.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParseError {
    pub offset: usize,
    pub reason: ParseReason,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ParseReason {
    /// Anything outside the canonical grammar, including any whitespace.
    UnexpectedByte,
    /// Invalid UTF-8 in a string.
    Utf8,
    /// An object key at or below its predecessor in byte order — which also
    /// covers duplicates.
    UnsortedKey,
    /// A leading zero, a `-0`, or a plus sign.
    NonShortestInt,
    /// An integer literal outside `i64`; no `Json::Int(i64)` produced it.
    IntOutOfRange,
    /// A `.` or an exponent in a number — the IR is float-free.
    FloatRefused,
    /// Any escape the emitter would not produce (`A` spelling `"A"`).
    NonMinimalEscape,
    /// An unescaped byte below `0x20` inside a string.
    RawControl,
    /// Nesting beyond [`MAX_DEPTH`].
    DepthExceeded,
    /// Any byte after the value other than the single final LF.
    TrailingBytes,
    /// The value is not followed by exactly one LF.
    MissingFinalNewline,
}

/// **DECISION (WO-05 §4.1) — the parser accepts exactly the emitter's output
/// set, nothing wider.** The law, tested: for every `b` this accepts,
/// `parse_canonical(b)?.to_canonical_bytes() == b`. There is no lenient mode,
/// no whitespace tolerance and no alternative escape spelling — one spelling
/// per value is the entire point of a canonical form, and a parser that
/// accepts two spellings makes byte-identity a lie.
impl Json {
    pub fn parse_canonical(bytes: &[u8]) -> Result<Json, ParseError> {
        let mut p = Parser { bytes, at: 0 };
        let value = p.value(0)?;
        // Exactly one LF, then nothing.
        match p.bytes.get(p.at) {
            Some(b'\n') => p.at += 1,
            Some(_) => return Err(p.err(ParseReason::MissingFinalNewline)),
            None => return Err(p.err(ParseReason::MissingFinalNewline)),
        }
        if p.at != p.bytes.len() {
            return Err(p.err(ParseReason::TrailingBytes));
        }
        Ok(value)
    }
}

struct Parser<'a> {
    bytes: &'a [u8],
    at: usize,
}

impl Parser<'_> {
    fn err(&self, reason: ParseReason) -> ParseError {
        ParseError {
            offset: self.at,
            reason,
        }
    }

    fn peek(&self) -> Option<u8> {
        self.bytes.get(self.at).copied()
    }

    fn literal(&mut self, want: &[u8]) -> Result<(), ParseError> {
        if self.bytes.len() < self.at + want.len()
            || &self.bytes[self.at..self.at + want.len()] != want
        {
            return Err(self.err(ParseReason::UnexpectedByte));
        }
        self.at += want.len();
        Ok(())
    }

    fn value(&mut self, depth: usize) -> Result<Json, ParseError> {
        if depth > MAX_DEPTH {
            return Err(self.err(ParseReason::DepthExceeded));
        }
        match self.peek() {
            None => Err(self.err(ParseReason::UnexpectedByte)),
            Some(b'n') => {
                self.literal(b"null")?;
                Ok(Json::Null)
            }
            Some(b't') => {
                self.literal(b"true")?;
                Ok(Json::Bool(true))
            }
            Some(b'f') => {
                self.literal(b"false")?;
                Ok(Json::Bool(false))
            }
            Some(b'"') => Ok(Json::Str(self.string()?)),
            Some(b'[') => self.array(depth),
            Some(b'{') => self.object(depth),
            Some(b'-') | Some(b'0'..=b'9') => self.number(),
            Some(_) => Err(self.err(ParseReason::UnexpectedByte)),
        }
    }

    fn array(&mut self, depth: usize) -> Result<Json, ParseError> {
        self.at += 1; // '['
        let mut items = Vec::new();
        if self.peek() == Some(b']') {
            self.at += 1;
            return Ok(Json::Arr(items));
        }
        loop {
            items.push(self.value(depth + 1)?);
            match self.peek() {
                Some(b',') => self.at += 1,
                Some(b']') => {
                    self.at += 1;
                    return Ok(Json::Arr(items));
                }
                _ => return Err(self.err(ParseReason::UnexpectedByte)),
            }
        }
    }

    fn object(&mut self, depth: usize) -> Result<Json, ParseError> {
        self.at += 1; // '{'
        let mut map: BTreeMap<String, Json> = BTreeMap::new();
        let mut previous: Option<String> = None;
        if self.peek() == Some(b'}') {
            self.at += 1;
            return Ok(Json::Obj(map));
        }
        loop {
            let key_at = self.at;
            if self.peek() != Some(b'"') {
                return Err(self.err(ParseReason::UnexpectedByte));
            }
            let key = self.string()?;
            // Strictly ascending in byte order. `<=` catches duplicates too,
            // which is why there is no separate duplicate-key reason.
            if let Some(prev) = &previous {
                if key.as_bytes() <= prev.as_bytes() {
                    return Err(ParseError {
                        offset: key_at,
                        reason: ParseReason::UnsortedKey,
                    });
                }
            }
            if self.peek() != Some(b':') {
                return Err(self.err(ParseReason::UnexpectedByte));
            }
            self.at += 1;
            let value = self.value(depth + 1)?;
            map.insert(key.clone(), value);
            previous = Some(key);
            match self.peek() {
                Some(b',') => self.at += 1,
                Some(b'}') => {
                    self.at += 1;
                    return Ok(Json::Obj(map));
                }
                _ => return Err(self.err(ParseReason::UnexpectedByte)),
            }
        }
    }

    /// The canonical string grammar: the seven short escapes the emitter
    /// writes, `\u00xx` for the remaining control characters, and raw UTF-8
    /// for everything else. Any other escape is a second spelling.
    fn string(&mut self) -> Result<String, ParseError> {
        self.at += 1; // '"'
        let mut out = String::new();
        loop {
            let b = match self.peek() {
                Some(b) => b,
                None => return Err(self.err(ParseReason::UnexpectedByte)),
            };
            match b {
                b'"' => {
                    self.at += 1;
                    return Ok(out);
                }
                b'\\' => {
                    let start = self.at;
                    self.at += 1;
                    match self.peek() {
                        Some(b'"') => {
                            out.push('"');
                            self.at += 1;
                        }
                        Some(b'\\') => {
                            out.push('\\');
                            self.at += 1;
                        }
                        Some(b'n') => {
                            out.push('\n');
                            self.at += 1;
                        }
                        Some(b'r') => {
                            out.push('\r');
                            self.at += 1;
                        }
                        Some(b't') => {
                            out.push('\t');
                            self.at += 1;
                        }
                        Some(b'b') => {
                            out.push('\u{08}');
                            self.at += 1;
                        }
                        Some(b'f') => {
                            out.push('\u{0c}');
                            self.at += 1;
                        }
                        Some(b'u') => {
                            self.at += 1;
                            let c = self.four_hex(start)?;
                            // The emitter reaches for `\u` only below 0x20,
                            // and only in lower-case four-digit form; every
                            // other code point it writes raw. Anything else
                            // here is a second spelling of the same string.
                            if c >= 0x20 {
                                return Err(ParseError {
                                    offset: start,
                                    reason: ParseReason::NonMinimalEscape,
                                });
                            }
                            // `\b`, `\f`, `\n`, `\r`, `\t` have shorter forms.
                            if matches!(c, 0x08 | 0x09 | 0x0a | 0x0c | 0x0d) {
                                return Err(ParseError {
                                    offset: start,
                                    reason: ParseReason::NonMinimalEscape,
                                });
                            }
                            out.push(char::from_u32(c).expect("below 0x20"));
                        }
                        _ => {
                            return Err(ParseError {
                                offset: start,
                                reason: ParseReason::NonMinimalEscape,
                            })
                        }
                    }
                }
                c if c < 0x20 => return Err(self.err(ParseReason::RawControl)),
                _ => {
                    // One UTF-8 scalar, decoded strictly.
                    let rest = &self.bytes[self.at..];
                    let width = utf8_width(rest[0]).ok_or_else(|| self.err(ParseReason::Utf8))?;
                    if rest.len() < width {
                        return Err(self.err(ParseReason::Utf8));
                    }
                    let s = core::str::from_utf8(&rest[..width])
                        .map_err(|_| self.err(ParseReason::Utf8))?;
                    out.push_str(s);
                    self.at += width;
                }
            }
        }
    }

    fn four_hex(&mut self, escape_at: usize) -> Result<u32, ParseError> {
        if self.bytes.len() < self.at + 4 {
            return Err(ParseError {
                offset: escape_at,
                reason: ParseReason::NonMinimalEscape,
            });
        }
        let mut v: u32 = 0;
        for i in 0..4 {
            let b = self.bytes[self.at + i];
            // The emitter writes `{:04x}` — lower case only.
            let d = match b {
                b'0'..=b'9' => u32::from(b - b'0'),
                b'a'..=b'f' => u32::from(b - b'a') + 10,
                _ => {
                    return Err(ParseError {
                        offset: escape_at,
                        reason: ParseReason::NonMinimalEscape,
                    })
                }
            };
            v = v * 16 + d;
        }
        self.at += 4;
        Ok(v)
    }

    /// Integers only, in the shortest spelling `i64::to_string` produces.
    fn number(&mut self) -> Result<Json, ParseError> {
        let start = self.at;
        if self.peek() == Some(b'-') {
            self.at += 1;
        }
        let digits_at = self.at;
        while matches!(self.peek(), Some(b'0'..=b'9')) {
            self.at += 1;
        }
        if self.at == digits_at {
            return Err(ParseError {
                offset: start,
                reason: ParseReason::UnexpectedByte,
            });
        }
        // A float would continue here. The IR is float-free (WO-05 §3.1).
        if matches!(self.peek(), Some(b'.') | Some(b'e') | Some(b'E')) {
            return Err(ParseError {
                offset: start,
                reason: ParseReason::FloatRefused,
            });
        }
        let text = core::str::from_utf8(&self.bytes[start..self.at]).map_err(|_| ParseError {
            offset: start,
            reason: ParseReason::Utf8,
        })?;
        let digits = &self.bytes[digits_at..self.at];
        if digits.len() > 1 && digits[0] == b'0' {
            return Err(ParseError {
                offset: start,
                reason: ParseReason::NonShortestInt,
            });
        }
        if text == "-0" {
            return Err(ParseError {
                offset: start,
                reason: ParseReason::NonShortestInt,
            });
        }
        match text.parse::<i64>() {
            Ok(i) => Ok(Json::Int(i)),
            Err(_) => Err(ParseError {
                offset: start,
                reason: ParseReason::IntOutOfRange,
            }),
        }
    }
}

/// Leading-byte width of one UTF-8 scalar. `None` for a continuation byte or
/// an invalid leading byte; the slice is then re-validated by `from_utf8`,
/// which rejects overlong forms and surrogates.
fn utf8_width(b: u8) -> Option<usize> {
    match b {
        0x00..=0x7f => Some(1),
        0xc2..=0xdf => Some(2),
        0xe0..=0xef => Some(3),
        0xf0..=0xf4 => Some(4),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(v: &str) -> Json {
        Json::Str(v.to_owned())
    }

    #[test]
    fn objects_sort_and_minify() {
        let mut m = BTreeMap::new();
        m.insert("b".to_owned(), Json::Int(2));
        m.insert(
            "a".to_owned(),
            Json::Arr(vec![Json::Bool(true), Json::Null]),
        );
        let bytes = Json::Obj(m).to_canonical_bytes();
        assert_eq!(bytes, b"{\"a\":[true,null],\"b\":2}\n");
    }

    #[test]
    fn escaping_is_rfc_8259_minimal() {
        let bytes = s("a\"b\\c\nd\u{1}e — ✓").to_canonical_bytes();
        assert_eq!(
            std::str::from_utf8(&bytes).unwrap(),
            "\"a\\\"b\\\\c\\nd\\u0001e — ✓\"\n"
        );
    }
}
