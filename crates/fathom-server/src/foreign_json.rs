//! **Reading JSON that somebody else wrote** (ADR-0071 part four): an outside vault's answers.
//!
//! `fathom_canon::Json::parse_canonical` accepts exactly the canonical emitter's output and
//! nothing wider, by decision (WO-05 §4.1), so it cannot read a Vaultwarden answer: those carry
//! whitespace, keys in any order and `\u` escapes. This is RFC 8259's whole grammar instead,
//! into the same `Json` tree, with three refusals a lenient parser usually skips:
//!
//! - **A duplicate key is refused**, not resolved. Two parsers that pick different copies of a
//!   duplicated key is how a check reads one value and a use reads another.
//! - **Nesting beyond [`MAX_DEPTH`] is refused**: a recursive descent over a stranger's bytes
//!   is a stack-overflow surface otherwise.
//! - **A lone surrogate is refused**: it has no UTF-8 spelling.
//!
//! The caller bounds the size (`vault_external::https` caps a body before it gets here).

use std::collections::BTreeMap;

use fathom_canon::Json;

/// No answer this reads nests deeper than a handful of levels.
pub const MAX_DEPTH: usize = 64;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ForeignJsonError {
    pub offset: usize,
    pub reason: &'static str,
}

impl core::fmt::Display for ForeignJsonError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        write!(f, "{} at byte {}", self.reason, self.offset)
    }
}

pub fn parse(bytes: &[u8]) -> Result<Json, ForeignJsonError> {
    let mut p = Parser { bytes, at: 0 };
    // A byte-order mark is not JSON (RFC 8259 §8.1 lets a parser ignore one).
    if p.bytes.starts_with(&[0xef, 0xbb, 0xbf]) {
        p.at = 3;
    }
    p.ws();
    let v = p.value(0)?;
    p.ws();
    if p.at != p.bytes.len() {
        return Err(p.err("trailing bytes"));
    }
    Ok(v)
}

struct Parser<'a> {
    bytes: &'a [u8],
    at: usize,
}

impl Parser<'_> {
    fn err(&self, reason: &'static str) -> ForeignJsonError {
        ForeignJsonError {
            offset: self.at,
            reason,
        }
    }

    fn peek(&self) -> Option<u8> {
        self.bytes.get(self.at).copied()
    }

    fn ws(&mut self) {
        while matches!(self.peek(), Some(b' ' | b'\t' | b'\n' | b'\r')) {
            self.at += 1;
        }
    }

    fn literal(&mut self, want: &[u8], v: Json) -> Result<Json, ForeignJsonError> {
        if self.bytes[self.at..].starts_with(want) {
            self.at += want.len();
            Ok(v)
        } else {
            Err(self.err("unexpected byte"))
        }
    }

    fn value(&mut self, depth: usize) -> Result<Json, ForeignJsonError> {
        if depth > MAX_DEPTH {
            return Err(self.err("nested too deeply"));
        }
        match self.peek() {
            Some(b'n') => self.literal(b"null", Json::Null),
            Some(b't') => self.literal(b"true", Json::Bool(true)),
            Some(b'f') => self.literal(b"false", Json::Bool(false)),
            Some(b'"') => Ok(Json::Str(self.string()?)),
            Some(b'[') => self.array(depth),
            Some(b'{') => self.object(depth),
            Some(b'-' | b'0'..=b'9') => self.number(),
            _ => Err(self.err("unexpected byte")),
        }
    }

    fn array(&mut self, depth: usize) -> Result<Json, ForeignJsonError> {
        self.at += 1;
        let mut items = Vec::new();
        self.ws();
        if self.peek() == Some(b']') {
            self.at += 1;
            return Ok(Json::Arr(items));
        }
        loop {
            self.ws();
            items.push(self.value(depth + 1)?);
            self.ws();
            match self.peek() {
                Some(b',') => self.at += 1,
                Some(b']') => {
                    self.at += 1;
                    return Ok(Json::Arr(items));
                }
                _ => return Err(self.err("expected , or ]")),
            }
        }
    }

    fn object(&mut self, depth: usize) -> Result<Json, ForeignJsonError> {
        self.at += 1;
        let mut map = BTreeMap::new();
        self.ws();
        if self.peek() == Some(b'}') {
            self.at += 1;
            return Ok(Json::Obj(map));
        }
        loop {
            self.ws();
            if self.peek() != Some(b'"') {
                return Err(self.err("expected a key"));
            }
            let key_at = self.at;
            let key = self.string()?;
            self.ws();
            if self.peek() != Some(b':') {
                return Err(self.err("expected :"));
            }
            self.at += 1;
            self.ws();
            let v = self.value(depth + 1)?;
            if map.insert(key, v).is_some() {
                return Err(ForeignJsonError {
                    offset: key_at,
                    reason: "a key appears twice",
                });
            }
            self.ws();
            match self.peek() {
                Some(b',') => self.at += 1,
                Some(b'}') => {
                    self.at += 1;
                    return Ok(Json::Obj(map));
                }
                _ => return Err(self.err("expected , or }")),
            }
        }
    }

    fn hex4(&mut self) -> Result<u32, ForeignJsonError> {
        let Some(digits) = self.bytes.get(self.at..self.at + 4) else {
            return Err(self.err("short \\u escape"));
        };
        let mut v = 0u32;
        for &b in digits {
            let d = (b as char)
                .to_digit(16)
                .ok_or_else(|| self.err("bad \\u escape"))?;
            v = v * 16 + d;
        }
        self.at += 4;
        Ok(v)
    }

    fn string(&mut self) -> Result<String, ForeignJsonError> {
        self.at += 1;
        let mut out = String::new();
        loop {
            let start = self.at;
            // Copy the plain run in one go; it is validated as UTF-8 by `from_utf8`.
            while let Some(b) = self.peek() {
                if b == b'"' || b == b'\\' || b < 0x20 {
                    break;
                }
                self.at += 1;
            }
            out.push_str(
                core::str::from_utf8(&self.bytes[start..self.at])
                    .map_err(|_| self.err("not UTF-8"))?,
            );
            match self.peek() {
                Some(b'"') => {
                    self.at += 1;
                    return Ok(out);
                }
                Some(b'\\') => {
                    self.at += 1;
                    let c = match self.peek() {
                        Some(b'"') => '"',
                        Some(b'\\') => '\\',
                        Some(b'/') => '/',
                        Some(b'b') => '\u{08}',
                        Some(b'f') => '\u{0c}',
                        Some(b'n') => '\n',
                        Some(b'r') => '\r',
                        Some(b't') => '\t',
                        Some(b'u') => {
                            self.at += 1;
                            let hi = self.hex4()?;
                            let code = if (0xd800..0xdc00).contains(&hi) {
                                if !self.bytes[self.at..].starts_with(b"\\u") {
                                    return Err(self.err("a lone surrogate"));
                                }
                                self.at += 2;
                                let lo = self.hex4()?;
                                if !(0xdc00..0xe000).contains(&lo) {
                                    return Err(self.err("a lone surrogate"));
                                }
                                0x10000 + ((hi - 0xd800) << 10) + (lo - 0xdc00)
                            } else if (0xdc00..0xe000).contains(&hi) {
                                return Err(self.err("a lone surrogate"));
                            } else {
                                hi
                            };
                            out.push(char::from_u32(code).ok_or_else(|| self.err("bad escape"))?);
                            continue;
                        }
                        _ => return Err(self.err("bad escape")),
                    };
                    self.at += 1;
                    out.push(c);
                }
                Some(_) => return Err(self.err("a raw control character in a string")),
                None => return Err(self.err("unterminated string")),
            }
        }
    }

    fn number(&mut self) -> Result<Json, ForeignJsonError> {
        let start = self.at;
        if self.peek() == Some(b'-') {
            self.at += 1;
        }
        let int_at = self.at;
        while matches!(self.peek(), Some(b'0'..=b'9')) {
            self.at += 1;
        }
        let int_len = self.at - int_at;
        if int_len == 0 || (int_len > 1 && self.bytes[int_at] == b'0') {
            return Err(self.err("bad number"));
        }
        let mut float = false;
        if self.peek() == Some(b'.') {
            float = true;
            self.at += 1;
            let f = self.at;
            while matches!(self.peek(), Some(b'0'..=b'9')) {
                self.at += 1;
            }
            if self.at == f {
                return Err(self.err("bad number"));
            }
        }
        if matches!(self.peek(), Some(b'e' | b'E')) {
            float = true;
            self.at += 1;
            if matches!(self.peek(), Some(b'+' | b'-')) {
                self.at += 1;
            }
            let e = self.at;
            while matches!(self.peek(), Some(b'0'..=b'9')) {
                self.at += 1;
            }
            if self.at == e {
                return Err(self.err("bad number"));
            }
        }
        let text = core::str::from_utf8(&self.bytes[start..self.at]).expect("ASCII");
        if !float {
            if let Ok(i) = text.parse::<i64>() {
                return Ok(Json::Int(i));
            }
        }
        match text.parse::<f64>() {
            Ok(f) if f.is_finite() => Ok(Json::Float(f)),
            _ => Err(self.err("number out of range")),
        }
    }
}

/// Field access over a parsed answer, by path, without panicking on a stranger's shape.
pub fn get<'a>(v: &'a Json, key: &str) -> Option<&'a Json> {
    match v {
        Json::Obj(m) => m.get(key),
        _ => None,
    }
}

pub fn get_str<'a>(v: &'a Json, key: &str) -> Option<&'a str> {
    match get(v, key) {
        Some(Json::Str(s)) => Some(s),
        _ => None,
    }
}

pub fn get_int(v: &Json, key: &str) -> Option<i64> {
    match get(v, key) {
        Some(Json::Int(i)) => Some(*i),
        _ => None,
    }
}

pub fn get_arr<'a>(v: &'a Json, key: &str) -> Option<&'a [Json]> {
    match get(v, key) {
        Some(Json::Arr(a)) => Some(a),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn it_reads_what_a_stranger_writes() {
        let v = parse(
            b" { \"b\" : [1, -2, 3.5e1, true, null],\r\n \"a\": \"x\\u00e9\\ud83d\\ude00\\/\" } ",
        )
        .expect("parses");
        assert_eq!(get_str(&v, "a"), Some("x\u{e9}\u{1f600}/"));
        let b = get_arr(&v, "b").unwrap();
        assert_eq!(b[0], Json::Int(1));
        assert_eq!(b[1], Json::Int(-2));
        assert_eq!(b[2], Json::Float(35.0));
        assert_eq!(b[3], Json::Bool(true));
        assert_eq!(b[4], Json::Null);
        assert_eq!(parse(b"\xef\xbb\xbf[]").unwrap(), Json::Arr(vec![]));
    }

    #[test]
    fn it_refuses_what_could_be_read_two_ways() {
        for bad in [
            &b"{\"a\":1,\"a\":2}"[..],
            b"\"\\ud800\"",
            b"\"\\udc00\"",
            b"\"\\ud800\\u0041\"",
            b"[1,]",
            b"01",
            b"1.",
            b"\"a\nb\"",
            b"{} x",
            b"\"\xff\"",
            b"1e999",
        ] {
            assert!(parse(bad).is_err(), "{:?}", String::from_utf8_lossy(bad));
        }
        let deep = format!("{}{}", "[".repeat(MAX_DEPTH + 2), "]".repeat(MAX_DEPTH + 2));
        assert!(parse(deep.as_bytes()).is_err());
        let ok = format!("{}{}", "[".repeat(MAX_DEPTH), "]".repeat(MAX_DEPTH));
        assert!(parse(ok.as_bytes()).is_ok());
    }
}
