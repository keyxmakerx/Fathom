//! JSON that arrives from an AI app (ADR-0072 decisions 13 to 19): `/mcp` requests and
//! client registrations are written by software Fathom does not control, so they are plain
//! RFC 8259 JSON (any key order, whitespace, `\u` escapes), not the canonical form every
//! other route takes. This reads them into the same [`Json`] tree and nothing wider:
//!
//! - whole numbers only, in `i64`; a fraction or an exponent is refused, as
//!   `Json::parse_canonical` refuses every float;
//! - a key twice in one object is refused, so no two readers of one body can disagree;
//! - nesting beyond [`MAX_DEPTH`] is refused, and the caller bounds the length;
//! - lone surrogates and raw control characters are refused.

use std::collections::BTreeMap;

use fathom_canon::Json;

/// Deeper than any MCP message or registration a well-behaved app sends.
pub const MAX_DEPTH: usize = 32;

/// Parse one JSON value with optional whitespace around it.
pub fn parse(bytes: &[u8]) -> Result<Json, &'static str> {
    let text = std::str::from_utf8(bytes).map_err(|_| "not UTF-8")?;
    let mut p = Parser {
        b: text.as_bytes(),
        at: 0,
    };
    p.ws();
    let v = p.value(0)?;
    p.ws();
    if p.at != p.b.len() {
        return Err("bytes after the value");
    }
    Ok(v)
}

struct Parser<'a> {
    b: &'a [u8],
    at: usize,
}

impl Parser<'_> {
    fn ws(&mut self) {
        while let Some(b' ' | b'\t' | b'\n' | b'\r') = self.b.get(self.at) {
            self.at += 1;
        }
    }

    fn eat(&mut self, want: &[u8]) -> Result<(), &'static str> {
        if self.b[self.at..].starts_with(want) {
            self.at += want.len();
            Ok(())
        } else {
            Err("unexpected character")
        }
    }

    fn value(&mut self, depth: usize) -> Result<Json, &'static str> {
        if depth > MAX_DEPTH {
            return Err("nested too deeply");
        }
        match self.b.get(self.at) {
            Some(b'n') => self.eat(b"null").map(|_| Json::Null),
            Some(b't') => self.eat(b"true").map(|_| Json::Bool(true)),
            Some(b'f') => self.eat(b"false").map(|_| Json::Bool(false)),
            Some(b'"') => self.string().map(Json::Str),
            Some(b'[') => {
                self.at += 1;
                let mut items = Vec::new();
                self.ws();
                if self.b.get(self.at) == Some(&b']') {
                    self.at += 1;
                    return Ok(Json::Arr(items));
                }
                loop {
                    self.ws();
                    items.push(self.value(depth + 1)?);
                    self.ws();
                    match self.b.get(self.at) {
                        Some(b',') => self.at += 1,
                        Some(b']') => {
                            self.at += 1;
                            return Ok(Json::Arr(items));
                        }
                        _ => return Err("expected , or ]"),
                    }
                }
            }
            Some(b'{') => {
                self.at += 1;
                let mut map = BTreeMap::new();
                self.ws();
                if self.b.get(self.at) == Some(&b'}') {
                    self.at += 1;
                    return Ok(Json::Obj(map));
                }
                loop {
                    self.ws();
                    if self.b.get(self.at) != Some(&b'"') {
                        return Err("expected a key");
                    }
                    let key = self.string()?;
                    self.ws();
                    self.eat(b":")?;
                    self.ws();
                    let v = self.value(depth + 1)?;
                    if map.insert(key, v).is_some() {
                        return Err("a key appears twice");
                    }
                    self.ws();
                    match self.b.get(self.at) {
                        Some(b',') => self.at += 1,
                        Some(b'}') => {
                            self.at += 1;
                            return Ok(Json::Obj(map));
                        }
                        _ => return Err("expected , or }"),
                    }
                }
            }
            Some(b'-' | b'0'..=b'9') => self.number(),
            _ => Err("unexpected character"),
        }
    }

    fn number(&mut self) -> Result<Json, &'static str> {
        let start = self.at;
        if self.b.get(self.at) == Some(&b'-') {
            self.at += 1;
        }
        match self.b.get(self.at) {
            Some(b'0') => self.at += 1,
            Some(b'1'..=b'9') => {
                while let Some(b'0'..=b'9') = self.b.get(self.at) {
                    self.at += 1;
                }
            }
            _ => return Err("not a number"),
        }
        if let Some(b'.' | b'e' | b'E') = self.b.get(self.at) {
            return Err("only whole numbers");
        }
        let text = std::str::from_utf8(&self.b[start..self.at]).map_err(|_| "not a number")?;
        text.parse::<i64>()
            .map(Json::Int)
            .map_err(|_| "number out of range")
    }

    fn hex4(&mut self) -> Result<u32, &'static str> {
        let digits = self.b.get(self.at..self.at + 4).ok_or("short \\u escape")?;
        let text = std::str::from_utf8(digits).map_err(|_| "bad \\u escape")?;
        let v = u32::from_str_radix(text, 16).map_err(|_| "bad \\u escape")?;
        self.at += 4;
        Ok(v)
    }

    fn string(&mut self) -> Result<String, &'static str> {
        self.at += 1; // the opening quote
        let mut out = String::new();
        loop {
            let start = self.at;
            while let Some(&c) = self.b.get(self.at) {
                if c == b'"' || c == b'\\' || c < 0x20 {
                    break;
                }
                self.at += 1;
            }
            // The input is valid UTF-8 and the run stops only at ASCII, so this slice is too.
            out.push_str(std::str::from_utf8(&self.b[start..self.at]).map_err(|_| "not UTF-8")?);
            match self.b.get(self.at) {
                Some(b'"') => {
                    self.at += 1;
                    return Ok(out);
                }
                Some(b'\\') => {
                    self.at += 1;
                    let c = *self.b.get(self.at).ok_or("unfinished escape")?;
                    self.at += 1;
                    match c {
                        b'"' => out.push('"'),
                        b'\\' => out.push('\\'),
                        b'/' => out.push('/'),
                        b'b' => out.push('\u{8}'),
                        b'f' => out.push('\u{c}'),
                        b'n' => out.push('\n'),
                        b'r' => out.push('\r'),
                        b't' => out.push('\t'),
                        b'u' => {
                            let hi = self.hex4()?;
                            let code = if (0xD800..0xDC00).contains(&hi) {
                                self.eat(b"\\u").map_err(|_| "lone surrogate")?;
                                let lo = self.hex4()?;
                                if !(0xDC00..0xE000).contains(&lo) {
                                    return Err("lone surrogate");
                                }
                                0x10000 + ((hi - 0xD800) << 10) + (lo - 0xDC00)
                            } else if (0xDC00..0xE000).contains(&hi) {
                                return Err("lone surrogate");
                            } else {
                                hi
                            };
                            out.push(char::from_u32(code).ok_or("bad \\u escape")?);
                        }
                        _ => return Err("unknown escape"),
                    }
                }
                Some(_) => return Err("a raw control character in a string"),
                None => return Err("unfinished string"),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plain_json_reads_into_the_same_tree() {
        let v = parse(b" {\"b\": [1, -2, true, null], \"a\" : \"x\\u00e9\\ud83d\\ude00\\n\"} ")
            .unwrap();
        let Json::Obj(m) = v else { panic!() };
        assert_eq!(m["a"], Json::Str("x\u{e9}\u{1F600}\n".into()));
        assert_eq!(
            m["b"],
            Json::Arr(vec![
                Json::Int(1),
                Json::Int(-2),
                Json::Bool(true),
                Json::Null
            ])
        );
    }

    #[test]
    fn what_two_readers_could_disagree_on_is_refused() {
        for bad in [
            &b"{\"a\":1,\"a\":2}"[..],
            b"1.5",
            b"1e3",
            b"\"\\ud800\"",
            b"\"\\udc00x\"",
            b"\"a\x01\"",
            b"01",
            b"[1,]",
            b"{} {}",
            b"99999999999999999999",
        ] {
            assert!(parse(bad).is_err(), "{:?}", String::from_utf8_lossy(bad));
        }
        let deep = "[".repeat(MAX_DEPTH + 2) + &"]".repeat(MAX_DEPTH + 2);
        assert!(parse(deep.as_bytes()).is_err());
    }
}
