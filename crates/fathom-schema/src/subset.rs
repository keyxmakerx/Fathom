//! The 62 §2.2 YAML-subset parser.
//!
//! This is not a general YAML implementation and must never become one. The
//! subset exists "so that the file has exactly one spelling for every
//! construct"; everything outside it is an error with code
//! `schema.yaml.subset`, not a tolerated dialect. Accepted: block maps and
//! sequences; flow maps/sequences on a single line; plain and double-quoted
//! scalars; `|` block scalars; `true`/`false`, decimal integers, `null`.
//! Refused: anchors, aliases, merge keys, tags, single-quoted scalars,
//! `yes/no/on/off`/`~`, octal, multi-document streams, tabs in indentation,
//! and any flow collection that does not close on its own line.

use crate::value::{Node, Value};

/// Which dialect of the subset a source file is parsed under.
///
/// `Schema` is the 62 §2.2 subset exactly as shipped — folded (`>`) block
/// scalars, same-indent sequences and multi-line flow are refused the same
/// way they always were. `Corpus` carries exactly the three extensions the
/// seed corpus bundles are written in, no more: `key: >` folded block scalars
/// (YAML *clip* semantics), a block sequence at the same indent as its key,
/// and flow collections that continue until they close. Everything else —
/// anchors, aliases, tags, single quotes, `yes/no`, octal, multi-document,
/// tabs — stays refused identically in both profiles. This is an option on
/// the one parser, not a second parser.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Profile {
    #[default]
    Schema,
    Corpus,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SubsetError {
    pub line: usize,
    pub message: String,
}

impl SubsetError {
    fn new(line: usize, message: impl Into<String>) -> Self {
        SubsetError {
            line,
            message: message.into(),
        }
    }
}

/// A pre-lexed content line: original line number, indent width, and content
/// with any trailing comment stripped.
struct Line {
    no: usize,
    indent: usize,
    text: String,
}

pub fn parse(source: &str) -> Result<Node, SubsetError> {
    parse_profile(source, Profile::Schema)
}

pub fn parse_profile(source: &str, profile: Profile) -> Result<Node, SubsetError> {
    let raw: Vec<&str> = source.lines().collect();
    let mut lines: Vec<Line> = Vec::new();
    let mut i = 0usize;

    while i < raw.len() {
        let no = i + 1;
        let line = raw[i];
        if line.trim() == "---" {
            return Err(SubsetError::new(
                no,
                "multi-document stream: `---` is refused (one document per file)",
            ));
        }
        let indent = leading_spaces(line, no)?;
        let body = &line[indent..];
        if body.is_empty() || body.starts_with('#') {
            i += 1;
            continue;
        }
        let stripped = strip_trailing_comment(body);
        let stripped = stripped.trim_end();
        if stripped.is_empty() {
            i += 1;
            continue;
        }

        // Block scalars swallow their following lines verbatim, comments and
        // all, so they are folded into one Line here at lex time. Literal (`|`)
        // blocks exist in both profiles; folded (`>`) blocks only in Corpus.
        let literal_key = block_scalar_key(stripped);
        let folded_key = if profile == Profile::Corpus {
            folded_scalar_key(stripped)
        } else {
            None
        };
        if let Some(key) = literal_key.or(folded_key) {
            let folded = literal_key.is_none();
            let mut j = i + 1;
            let mut body_lines: Vec<(usize, &str)> = Vec::new();
            while j < raw.len() {
                let l = raw[j];
                if l.trim().is_empty() {
                    body_lines.push((0, ""));
                    j += 1;
                    continue;
                }
                let li = leading_spaces(l, j + 1)?;
                if li <= indent {
                    break;
                }
                body_lines.push((li, l));
                j += 1;
            }
            while matches!(body_lines.last(), Some((_, ""))) {
                body_lines.pop();
            }
            let base = body_lines
                .iter()
                .filter(|(li, _)| *li > 0)
                .map(|(li, _)| *li)
                .min()
                .unwrap_or(indent + 2);
            let text = if folded {
                fold_clip(&body_lines, base)
            } else {
                let mut text = String::new();
                for (li, l) in &body_lines {
                    if *li == 0 {
                        text.push('\n');
                    } else {
                        text.push_str(&l[base.min(l.len())..]);
                        text.push('\n');
                    }
                }
                text
            };
            lines.push(Line {
                no,
                indent,
                text: format!("{key}: \u{0}BLOCK\u{0}{text}"),
            });
            i = j;
            continue;
        }

        // Corpus profile only: a flow collection may continue across lines
        // until it closes (the seed bundles' `new_concepts` block is written
        // that way). Continuation lines are joined with a single space. The
        // schema profile refuses multi-line flow exactly as before.
        if profile == Profile::Corpus && flow_depth_delta(stripped) > 0 {
            let mut joined = stripped.to_owned();
            let mut depth = flow_depth_delta(stripped);
            let mut j = i + 1;
            while j < raw.len() && depth > 0 {
                let cont = strip_trailing_comment(raw[j].trim()).trim_end();
                if !cont.is_empty() {
                    joined.push(' ');
                    joined.push_str(cont);
                    depth += flow_depth_delta(cont);
                }
                j += 1;
            }
            if depth > 0 {
                return Err(SubsetError::new(
                    no,
                    "flow collection does not close before end of file",
                ));
            }
            lines.push(Line {
                no,
                indent,
                text: joined,
            });
            i = j;
            continue;
        }

        lines.push(Line {
            no,
            indent,
            text: stripped.to_owned(),
        });
        i += 1;
    }

    let mut cursor = 0usize;
    let root = parse_block(&lines, &mut cursor, 0, profile)?;
    if cursor < lines.len() {
        let l = &lines[cursor];
        return Err(SubsetError::new(
            l.no,
            format!("unexpected content at indent {}", l.indent),
        ));
    }
    Ok(root)
}

fn leading_spaces(line: &str, no: usize) -> Result<usize, SubsetError> {
    let mut n = 0usize;
    for b in line.bytes() {
        match b {
            b' ' => n += 1,
            b'\t' => return Err(SubsetError::new(no, "tab in indentation")),
            _ => break,
        }
    }
    Ok(n)
}

/// Strips a ` #` comment outside double quotes. A `#` opening the line's
/// content is handled by the lexer before this is called.
fn strip_trailing_comment(s: &str) -> &str {
    let bytes = s.as_bytes();
    let mut in_quotes = false;
    let mut k = 0usize;
    while k < bytes.len() {
        match bytes[k] {
            b'"' => in_quotes = !in_quotes,
            b'\\' if in_quotes => k += 1,
            b'#' if !in_quotes => {
                // A comment must be preceded by whitespace (or start the line)
                // so that `set{host_service}`-style text is never truncated.
                if k == 0 || bytes[k - 1] == b' ' {
                    return s[..k].trim_end();
                }
            }
            _ => {}
        }
        k += 1;
    }
    s
}

/// Net `{`/`[` vs `}`/`]` depth outside double quotes — the corpus profile's
/// multi-line-flow continuation test.
fn flow_depth_delta(s: &str) -> i32 {
    let mut depth = 0i32;
    let mut in_quotes = false;
    let mut k = 0usize;
    let bytes = s.as_bytes();
    while k < bytes.len() {
        match bytes[k] {
            b'"' => in_quotes = !in_quotes,
            b'\\' if in_quotes => k += 1,
            b'{' | b'[' if !in_quotes => depth += 1,
            b'}' | b']' if !in_quotes => depth -= 1,
            _ => {}
        }
        k += 1;
    }
    depth
}

fn block_scalar_key(s: &str) -> Option<&str> {
    let rest = s.strip_suffix('|')?;
    let rest = rest.trim_end();
    let key = rest.strip_suffix(':')?;
    if key.is_empty() || key.contains(' ') {
        return None;
    }
    Some(key)
}

/// `key: >` — a folded block scalar header. Same key rule as `|`: the `>` must
/// stand alone as the value, so `key: a > b` is a plain scalar in every
/// profile. Corpus profile only.
fn folded_scalar_key(s: &str) -> Option<&str> {
    let rest = s.strip_suffix('>')?;
    let rest = rest.trim_end();
    let key = rest.strip_suffix(':')?;
    if key.is_empty() || key.contains(' ') {
        return None;
    }
    Some(key)
}

/// YAML folded-scalar *clip* semantics over the pre-lexed body lines:
/// a single break between two base-indented lines folds to one space; `k`
/// blank lines between them become `k` newlines; breaks adjacent to a
/// more-indented line are literal; the value ends with exactly one newline.
fn fold_clip(body_lines: &[(usize, &str)], base: usize) -> String {
    let mut out = String::new();
    let mut pending_blanks = 0usize;
    let mut prev_more_indented = false;
    let mut first = true;
    for (li, l) in body_lines {
        if *li == 0 {
            pending_blanks += 1;
            continue;
        }
        let more_indented = *li > base;
        let content = &l[base.min(l.len())..];
        if first {
            first = false;
        } else if more_indented || prev_more_indented {
            for _ in 0..=pending_blanks {
                out.push('\n');
            }
        } else if pending_blanks > 0 {
            for _ in 0..pending_blanks {
                out.push('\n');
            }
        } else {
            out.push(' ');
        }
        out.push_str(content);
        pending_blanks = 0;
        prev_more_indented = more_indented;
    }
    if !out.is_empty() {
        out.push('\n');
    }
    out
}

fn parse_block(
    lines: &[Line],
    cursor: &mut usize,
    indent: usize,
    profile: Profile,
) -> Result<Node, SubsetError> {
    let first = &lines[*cursor];
    if first.text == "-" || first.text.starts_with("- ") {
        parse_seq(lines, cursor, indent, profile)
    } else {
        parse_map(lines, cursor, indent, profile)
    }
}

fn parse_seq(
    lines: &[Line],
    cursor: &mut usize,
    indent: usize,
    profile: Profile,
) -> Result<Node, SubsetError> {
    let start_line = lines[*cursor].no;
    let mut items: Vec<Node> = Vec::new();
    while *cursor < lines.len() {
        let l = &lines[*cursor];
        if l.indent != indent || !(l.text == "-" || l.text.starts_with("- ")) {
            break;
        }
        let item_line = l.no;
        let rest = if l.text == "-" { "" } else { &l.text[2..] };
        let body_indent = indent + 2;
        if rest.is_empty() {
            *cursor += 1;
            if *cursor < lines.len() && lines[*cursor].indent > indent {
                let child_indent = lines[*cursor].indent;
                items.push(parse_block(lines, cursor, child_indent, profile)?);
            } else {
                items.push(Node::new(Value::Null, item_line));
            }
        } else if matches!(rest.as_bytes()[0], b'{' | b'[' | b'"') {
            // A flow collection or quoted scalar item — must be recognised
            // before key-splitting, or `- { name: x }` reads as a block map.
            *cursor += 1;
            items.push(parse_scalar_or_flow(rest, item_line)?);
        } else if let Some((key, val)) = split_key(rest) {
            // `- key: value` opens a block map inline; its remaining keys sit
            // at the body indent on the following lines.
            *cursor += 1;
            let mut entries: Vec<(String, Node)> = Vec::new();
            let first_val = map_entry_value(lines, cursor, body_indent, val, item_line, profile)?;
            entries.push((key, first_val));
            while *cursor < lines.len() && lines[*cursor].indent == body_indent {
                let ml = &lines[*cursor];
                if ml.text == "-" || ml.text.starts_with("- ") {
                    break;
                }
                let (k, v) = split_key(&ml.text)
                    .ok_or_else(|| SubsetError::new(ml.no, "expected `key: value` in block map"))?;
                let mline = ml.no;
                *cursor += 1;
                let value = map_entry_value(lines, cursor, body_indent, v, mline, profile)?;
                entries.push((k, value));
            }
            items.push(Node::new(Value::Map(entries), item_line));
        } else {
            *cursor += 1;
            items.push(parse_scalar_or_flow(rest, item_line)?);
        }
    }
    Ok(Node::new(Value::Seq(items), start_line))
}

fn parse_map(
    lines: &[Line],
    cursor: &mut usize,
    indent: usize,
    profile: Profile,
) -> Result<Node, SubsetError> {
    let start_line = lines[*cursor].no;
    let mut entries: Vec<(String, Node)> = Vec::new();
    while *cursor < lines.len() {
        let l = &lines[*cursor];
        if l.indent != indent {
            break;
        }
        if l.text == "-" || l.text.starts_with("- ") {
            break;
        }
        let (key, val) = split_key(&l.text)
            .ok_or_else(|| SubsetError::new(l.no, "expected `key: value` in block map"))?;
        let line_no = l.no;
        *cursor += 1;
        let value = map_entry_value(lines, cursor, indent, val, line_no, profile)?;
        entries.push((key, value));
    }
    Ok(Node::new(Value::Map(entries), start_line))
}

/// Parses the value part of a map entry: inline scalar/flow, folded block
/// scalar, or a nested block on the following more-indented lines.
fn map_entry_value(
    lines: &[Line],
    cursor: &mut usize,
    key_indent: usize,
    val: &str,
    line_no: usize,
    profile: Profile,
) -> Result<Node, SubsetError> {
    if let Some(body) = val.strip_prefix("\u{0}BLOCK\u{0}") {
        return Ok(Node::new(Value::Str(body.to_owned()), line_no));
    }
    if !val.is_empty() {
        return parse_scalar_or_flow(val, line_no);
    }
    if *cursor < lines.len() && lines[*cursor].indent > key_indent {
        let child_indent = lines[*cursor].indent;
        return parse_block(lines, cursor, child_indent, profile);
    }
    // Corpus profile only: a block sequence at the same indent as its key
    // (`entries:` with `- …` items at column 0) — the style the seed bundles
    // are written in. The schema profile refuses it exactly as before.
    if profile == Profile::Corpus && *cursor < lines.len() {
        let l = &lines[*cursor];
        if l.indent == key_indent && (l.text == "-" || l.text.starts_with("- ")) {
            return parse_seq(lines, cursor, key_indent, profile);
        }
    }
    Ok(Node::new(Value::Null, line_no))
}

/// Splits `key: value` / `key:` at the first unquoted `: ` (or trailing `:`).
fn split_key(s: &str) -> Option<(String, &str)> {
    let bytes = s.as_bytes();
    let mut in_quotes = false;
    let mut k = 0usize;
    while k < bytes.len() {
        match bytes[k] {
            b'"' => in_quotes = !in_quotes,
            b'\\' if in_quotes => k += 1,
            b':' if !in_quotes => {
                if k + 1 == bytes.len() {
                    return Some((s[..k].trim().to_owned(), ""));
                }
                if bytes[k + 1] == b' ' {
                    let raw = &s[k + 2..];
                    // A folded block scalar's payload keeps its exact text,
                    // trailing newline included.
                    let val = if raw.trim_start().starts_with('\u{0}') {
                        raw.trim_start()
                    } else {
                        raw.trim()
                    };
                    return Some((s[..k].trim().to_owned(), val));
                }
            }
            _ => {}
        }
        k += 1;
    }
    None
}

fn parse_scalar_or_flow(s: &str, line: usize) -> Result<Node, SubsetError> {
    match s.as_bytes().first() {
        Some(b'{') | Some(b'[') => {
            let mut chars = FlowCursor {
                s: s.as_bytes(),
                pos: 0,
                line,
            };
            let v = chars.parse_flow()?;
            chars.skip_spaces();
            if chars.pos != chars.s.len() {
                return Err(SubsetError::new(
                    line,
                    "trailing content after flow collection",
                ));
            }
            Ok(Node::new(v, line))
        }
        _ => parse_scalar(s, line),
    }
}

fn parse_scalar(s: &str, line: usize) -> Result<Node, SubsetError> {
    debug_assert!(!s.is_empty());
    let first = s.as_bytes()[0];
    match first {
        b'"' => Ok(Node::new(Value::Str(parse_quoted(s, line)?.0), line)),
        b'\'' => Err(SubsetError::new(
            line,
            "single-quoted scalar: one quoting style, and it is double",
        )),
        b'&' => Err(SubsetError::new(line, "anchor (`&`) is refused")),
        b'*' => Err(SubsetError::new(line, "alias (`*`) is refused")),
        b'!' => Err(SubsetError::new(line, "tag (`!`) is refused")),
        _ => {
            match s {
                "true" => return Ok(Node::new(Value::Bool(true), line)),
                "false" => return Ok(Node::new(Value::Bool(false), line)),
                "null" => return Ok(Node::new(Value::Null, line)),
                "~" => return Err(SubsetError::new(line, "`~`: null is spelled null")),
                _ => {}
            }
            let lower = s.to_ascii_lowercase();
            if matches!(lower.as_str(), "yes" | "no" | "on" | "off") {
                return Err(SubsetError::new(
                    line,
                    format!("`{s}`: booleans are spelled true/false"),
                ));
            }
            if let Some(rest) = s.strip_prefix('-').or(Some(s)) {
                if rest.len() > 1
                    && rest.starts_with('0')
                    && rest.bytes().all(|b| b.is_ascii_digit())
                {
                    return Err(SubsetError::new(
                        line,
                        format!("`{s}`: octal-looking integer is refused"),
                    ));
                }
            }
            if s.bytes().all(|b| b.is_ascii_digit())
                || (first == b'-' && s.len() > 1 && s[1..].bytes().all(|b| b.is_ascii_digit()))
            {
                if let Ok(i) = s.parse::<i64>() {
                    return Ok(Node::new(Value::Int(i), line));
                }
            }
            if is_simple_float(s) {
                if let Ok(f) = s.parse::<f64>() {
                    return Ok(Node::new(Value::Float(f), line));
                }
            }
            Ok(Node::new(Value::Str(s.to_owned()), line))
        }
    }
}

fn is_simple_float(s: &str) -> bool {
    let s = s.strip_prefix('-').unwrap_or(s);
    let Some((a, b)) = s.split_once('.') else {
        return false;
    };
    !a.is_empty()
        && !b.is_empty()
        && a.bytes().all(|c| c.is_ascii_digit())
        && b.bytes().all(|c| c.is_ascii_digit())
}

/// Parses a double-quoted scalar starting at `s[0] == '"'`. Returns the
/// unescaped text and the byte index one past the closing quote.
fn parse_quoted(s: &str, line: usize) -> Result<(String, usize), SubsetError> {
    let bytes = s.as_bytes();
    let mut out = String::new();
    let mut k = 1usize;
    while k < bytes.len() {
        match bytes[k] {
            b'"' => return Ok((out, k + 1)),
            b'\\' => {
                k += 1;
                match bytes.get(k) {
                    Some(b'"') => out.push('"'),
                    Some(b'\\') => out.push('\\'),
                    Some(b'n') => out.push('\n'),
                    Some(b't') => out.push('\t'),
                    Some(&c) => {
                        return Err(SubsetError::new(
                            line,
                            format!("unsupported escape `\\{}`", c as char),
                        ))
                    }
                    None => return Err(SubsetError::new(line, "dangling escape at end of string")),
                }
            }
            _ => {
                let ch_len = utf8_len(bytes[k]);
                out.push_str(&s[k..k + ch_len]);
                k += ch_len - 1;
            }
        }
        k += 1;
    }
    Err(SubsetError::new(line, "unterminated double-quoted string"))
}

fn utf8_len(b: u8) -> usize {
    match b {
        0x00..=0x7f => 1,
        0xc0..=0xdf => 2,
        0xe0..=0xef => 3,
        _ => 4,
    }
}

/// Single-line flow collection parser. Reaching end of line with an open
/// collection is the subset's multi-line-flow refusal, by construction.
struct FlowCursor<'a> {
    s: &'a [u8],
    pos: usize,
    line: usize,
}

impl<'a> FlowCursor<'a> {
    fn err(&self, msg: impl Into<String>) -> SubsetError {
        SubsetError::new(self.line, msg.into())
    }

    fn skip_spaces(&mut self) {
        while self.pos < self.s.len() && self.s[self.pos] == b' ' {
            self.pos += 1;
        }
    }

    fn parse_flow(&mut self) -> Result<Value, SubsetError> {
        match self.s.get(self.pos) {
            Some(b'{') => self.parse_flow_map(),
            Some(b'[') => self.parse_flow_seq(),
            _ => self.parse_flow_scalar(),
        }
    }

    fn parse_flow_map(&mut self) -> Result<Value, SubsetError> {
        self.pos += 1; // consume '{'
        let mut entries: Vec<(String, Node)> = Vec::new();
        loop {
            self.skip_spaces();
            match self.s.get(self.pos) {
                None => return Err(self.err(
                    "flow map does not close on this line (flow collections are single-line only)",
                )),
                Some(b'}') => {
                    self.pos += 1;
                    return Ok(Value::Map(entries));
                }
                Some(b',') => {
                    self.pos += 1;
                    continue;
                }
                _ => {
                    let key = self.parse_flow_key()?;
                    self.skip_spaces();
                    if self.s.get(self.pos) != Some(&b':') {
                        return Err(self.err(format!("expected `:` after flow map key `{key}`")));
                    }
                    self.pos += 1;
                    self.skip_spaces();
                    let vline = self.line;
                    let v = self.parse_flow()?;
                    entries.push((key, Node::new(v, vline)));
                }
            }
        }
    }

    fn parse_flow_seq(&mut self) -> Result<Value, SubsetError> {
        self.pos += 1; // consume '['
        let mut items: Vec<Node> = Vec::new();
        loop {
            self.skip_spaces();
            match self.s.get(self.pos) {
                None => {
                    return Err(self.err(
                        "flow sequence does not close on this line (flow collections are single-line only)",
                    ))
                }
                Some(b']') => {
                    self.pos += 1;
                    return Ok(Value::Seq(items));
                }
                Some(b',') => {
                    self.pos += 1;
                    continue;
                }
                _ => {
                    let vline = self.line;
                    let v = self.parse_flow()?;
                    items.push(Node::new(v, vline));
                }
            }
        }
    }

    fn parse_flow_key(&mut self) -> Result<String, SubsetError> {
        if self.s.get(self.pos) == Some(&b'"') {
            let rest =
                core::str::from_utf8(&self.s[self.pos..]).map_err(|_| self.err("invalid UTF-8"))?;
            let (text, consumed) = parse_quoted(rest, self.line)?;
            self.pos += consumed;
            return Ok(text);
        }
        let start = self.pos;
        while let Some(&b) = self.s.get(self.pos) {
            if b == b':' || b == b',' || b == b'}' {
                break;
            }
            self.pos += 1;
        }
        let raw = core::str::from_utf8(&self.s[start..self.pos])
            .map_err(|_| self.err("invalid UTF-8"))?;
        let key = raw.trim();
        if key.is_empty() {
            return Err(self.err("empty flow map key"));
        }
        Ok(key.to_owned())
    }

    fn parse_flow_scalar(&mut self) -> Result<Value, SubsetError> {
        if self.s.get(self.pos) == Some(&b'"') {
            let rest =
                core::str::from_utf8(&self.s[self.pos..]).map_err(|_| self.err("invalid UTF-8"))?;
            let (text, consumed) = parse_quoted(rest, self.line)?;
            self.pos += consumed;
            return Ok(Value::Str(text));
        }
        let start = self.pos;
        while let Some(&b) = self.s.get(self.pos) {
            if b == b',' || b == b'}' || b == b']' {
                break;
            }
            self.pos += 1;
        }
        let raw = core::str::from_utf8(&self.s[start..self.pos])
            .map_err(|_| self.err("invalid UTF-8"))?
            .trim();
        if raw.is_empty() {
            return Err(self.err("empty flow value"));
        }
        let node = parse_scalar(raw, self.line)?;
        Ok(node.value)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse_ok(s: &str) -> Node {
        parse(s).expect("should parse")
    }

    #[test]
    fn block_map_and_seq() {
        let n = parse_ok(
            "kinds:\n  - kind: Site\n    layer: config\n  - kind: Device\n    layer: config\n",
        );
        let kinds = n.get("kinds").unwrap().as_seq().unwrap();
        assert_eq!(kinds.len(), 2);
        assert_eq!(kinds[0].get("kind").unwrap().as_str(), Some("Site"));
        assert_eq!(kinds[1].get("layer").unwrap().as_str(), Some("config"));
    }

    #[test]
    fn flow_map_with_quoted_commas_and_escapes() {
        let n = parse_ok(
            r#"fields:
  - { name: platform, card: "0..1", doc: "junos-srx, panos. Not \"vendor\"." }
"#,
        );
        let f = &n.get("fields").unwrap().as_seq().unwrap()[0];
        assert_eq!(f.get("card").unwrap().as_str(), Some("0..1"));
        assert_eq!(
            f.get("doc").unwrap().as_str(),
            Some(r#"junos-srx, panos. Not "vendor"."#)
        );
    }

    #[test]
    fn trailing_comments_stripped_outside_quotes() {
        let n = parse_ok("a: 1    # comment\nb: \"has # inside\"  # real comment\n");
        assert_eq!(n.get("a").unwrap().as_int(), Some(1));
        assert_eq!(n.get("b").unwrap().as_str(), Some("has # inside"));
    }

    #[test]
    fn block_scalar_preserves_text() {
        let n = parse_ok("doc: |\n  line one\n  line two\nnext: 1\n");
        assert_eq!(n.get("doc").unwrap().as_str(), Some("line one\nline two\n"));
        assert_eq!(n.get("next").unwrap().as_int(), Some(1));
    }

    #[test]
    fn refusals() {
        assert!(parse("a: 'single'\n").is_err());
        assert!(parse("a: yes\n").is_err());
        assert!(parse("a: ~\n").is_err());
        assert!(parse("a: &anchor 1\n").is_err());
        assert!(parse("a: *alias\n").is_err());
        assert!(parse("a: !tag x\n").is_err());
        assert!(parse("a: 017\n").is_err());
        assert!(parse("---\na: 1\n").is_err());
        assert!(parse("\ta: 1\n").is_err());
    }

    #[test]
    fn multiline_flow_refused() {
        let e = parse("a: { x: 1,\n     y: 2 }\n").unwrap_err();
        assert!(e.message.contains("single-line"), "{}", e.message);
    }

    #[test]
    fn empty_flow_collections() {
        let n = parse_ok("identity: []\nvendors:\n  juniper: {}\n");
        assert_eq!(n.get("identity").unwrap().as_seq().unwrap().len(), 0);
        assert_eq!(
            n.get("vendors")
                .unwrap()
                .get("juniper")
                .unwrap()
                .as_map()
                .unwrap()
                .len(),
            0
        );
    }

    #[test]
    fn nested_flow_in_seq_items() {
        let n = parse_ok("identity:\n  - [ owner(Device), name ]\n  - [ edge(Terminates:A), edge(Terminates:B) ]\n");
        let tiers = n.get("identity").unwrap().as_seq().unwrap();
        assert_eq!(
            tiers[0].as_seq().unwrap()[0].as_str(),
            Some("owner(Device)")
        );
        assert_eq!(
            tiers[1].as_seq().unwrap()[1].as_str(),
            Some("edge(Terminates:B)")
        );
    }

    #[test]
    fn floats_accepted_pragmatically() {
        let n = parse_ok("match_threshold: 0.75\n");
        assert!(matches!(n.get("match_threshold").unwrap().value, Value::Float(f) if f == 0.75));
    }

    #[test]
    fn corpus_profile_folds_clip_semantics() {
        let n = parse_profile(
            "doc: >\n  line one\n  line two\n\n  paragraph two\nnext: 1\n",
            Profile::Corpus,
        )
        .expect("corpus profile should fold");
        assert_eq!(
            n.get("doc").unwrap().as_str(),
            Some("line one line two\nparagraph two\n")
        );
        assert_eq!(n.get("next").unwrap().as_int(), Some(1));
    }

    #[test]
    fn corpus_profile_folded_more_indented_lines_stay_literal() {
        let n = parse_profile(
            "doc: >\n  intro\n    kept literal\n  outro\n",
            Profile::Corpus,
        )
        .unwrap();
        assert_eq!(
            n.get("doc").unwrap().as_str(),
            Some("intro\n  kept literal\noutro\n")
        );
    }

    #[test]
    fn corpus_profile_keeps_every_other_refusal() {
        for bad in [
            "a: 'single'\n",
            "a: yes\n",
            "a: ~\n",
            "a: &anchor 1\n",
            "a: *alias\n",
            "a: !tag x\n",
            "a: 017\n",
            "---\na: 1\n",
            "\ta: 1\n",
        ] {
            assert!(
                parse_profile(bad, Profile::Corpus).is_err(),
                "corpus profile must still refuse {bad:?}"
            );
        }
    }

    #[test]
    fn corpus_profile_same_indent_seq_and_multiline_flow() {
        // The two block styles the seed bundles are written in; the schema
        // profile refuses both exactly as before.
        let seq = "entries:\n- id: a\n- id: b\n";
        let n = parse_profile(seq, Profile::Corpus).unwrap();
        assert_eq!(n.get("entries").unwrap().as_seq().unwrap().len(), 2);
        assert!(
            parse(seq).is_err(),
            "schema profile refuses same-indent seq"
        );

        let flow = "kinds: [a,\n        b, c]\n";
        let n = parse_profile(flow, Profile::Corpus).unwrap();
        assert_eq!(n.get("kinds").unwrap().as_seq().unwrap().len(), 3);
        assert!(
            parse(flow).is_err(),
            "schema profile refuses multi-line flow"
        );
        assert!(
            parse_profile("a: [1, 2\n", Profile::Corpus).is_err(),
            "an unclosed flow is still an error in the corpus profile"
        );
    }

    #[test]
    fn schema_profile_still_refuses_folded_scalars() {
        // Exactly the pre-Profile behaviour, pinned: the `>` reads as a plain
        // scalar and the indented body is then unexpected content.
        let e = parse("a: >\n  body text\n").unwrap_err();
        assert!(e.message.contains("unexpected content"), "{}", e.message);
        // A bodyless `a: >` was (and stays) the literal string ">".
        let n = parse("a: >\n").unwrap();
        assert_eq!(n.get("a").unwrap().as_str(), Some(">"));
    }

    #[test]
    fn folded_scalar_value_position_only() {
        // `>` inside a plain scalar is text in both profiles.
        let n = parse_profile("a: x > y\n", Profile::Corpus).unwrap();
        assert_eq!(n.get("a").unwrap().as_str(), Some("x > y"));
    }

    #[test]
    fn dotted_keys_and_ints() {
        let n = parse_ok("keys:\n  Site.name: 1\n  Site.code: 2\n");
        assert_eq!(
            n.get("keys").unwrap().get("Site.name").unwrap().as_int(),
            Some(1)
        );
    }
}
