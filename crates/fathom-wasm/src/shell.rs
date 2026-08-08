//! Opcode dispatch over WO-07 §4.4's byte protocol. One call, one reply; a
//! failure is a typed error record, never a trap and never an unwind across
//! the boundary (41 §3.9).
//!
//! The shell owns the only mutable state in the module: the finder, absent
//! until `OP_INIT` succeeds. Nothing here reads a clock, draws entropy or
//! touches a filesystem — which is why the built module's import section is
//! empty (`wasmbin::IMPORT_ALLOWLIST`).

use fathom_corpus::{CorpusIndex, Section, SourceFile};
use fathom_find::Finder;

use crate::protocol::{
    self, ERR_BAD_FRAME, ERR_BAD_UTF8, ERR_CORPUS_LOAD, ERR_NOT_INITIALISED, ERR_UNKNOWN_OP,
};
use crate::{OP_INIT, OP_QUERY};

pub struct Shell {
    finder: Option<Finder>,
}

impl Shell {
    pub fn new() -> Shell {
        Shell { finder: None }
    }

    /// One call, one reply (empty = success with nothing to say).
    pub fn handle(&mut self, op: u32, req: &[u8]) -> Vec<u8> {
        match op {
            OP_INIT => match self.init(req) {
                Ok(()) => Vec::new(),
                Err((code, detail)) => protocol::encode_error(code, &detail),
            },
            OP_QUERY => self.query(req),
            _ => protocol::encode_error(
                ERR_UNKNOWN_OP,
                &format!("opcode {op} is not implemented by this module"),
            ),
        }
    }

    fn init(&mut self, req: &[u8]) -> Result<(), (u16, String)> {
        let files = parse_init_frame(req)?;
        let index =
            CorpusIndex::from_sources(&files).map_err(|e| (ERR_CORPUS_LOAD, e.to_string()))?;
        self.finder = Some(Finder::new(index));
        Ok(())
    }

    fn query(&mut self, req: &[u8]) -> Vec<u8> {
        let Some(finder) = self.finder.as_ref() else {
            return protocol::encode_error(
                ERR_NOT_INITIALISED,
                "no corpus is loaded: OP_INIT must succeed before OP_QUERY",
            );
        };
        let query = match std::str::from_utf8(req) {
            Ok(q) => q,
            Err(e) => {
                return protocol::encode_error(ERR_BAD_UTF8, &format!("query is not UTF-8: {e}"))
            }
        };
        let result = finder.search(query);
        protocol::encode_query_reply(finder, &result)
    }
}

impl Default for Shell {
    fn default() -> Shell {
        Shell::new()
    }
}

/// A cursor over the request bytes that refuses every short read.
struct Cursor<'a> {
    bytes: &'a [u8],
    at: usize,
}

impl<'a> Cursor<'a> {
    fn u8(&mut self) -> Result<u8, (u16, String)> {
        if self.at >= self.bytes.len() {
            return Err((
                ERR_BAD_FRAME,
                format!("frame truncated at byte {}", self.at),
            ));
        }
        let b = self.bytes[self.at];
        self.at += 1;
        Ok(b)
    }

    fn u32(&mut self) -> Result<u32, (u16, String)> {
        if self.at + 4 > self.bytes.len() {
            return Err((
                ERR_BAD_FRAME,
                format!("frame truncated at byte {}", self.at),
            ));
        }
        let v = u32::from_le_bytes([
            self.bytes[self.at],
            self.bytes[self.at + 1],
            self.bytes[self.at + 2],
            self.bytes[self.at + 3],
        ]);
        self.at += 4;
        Ok(v)
    }

    fn text(&mut self, len: u32) -> Result<String, (u16, String)> {
        let len = len as usize;
        let end = self.at.checked_add(len).ok_or_else(|| {
            (
                ERR_BAD_FRAME,
                format!("length overflows at byte {}", self.at),
            )
        })?;
        if end > self.bytes.len() {
            return Err((
                ERR_BAD_FRAME,
                format!("frame truncated at byte {}", self.at),
            ));
        }
        let slice = &self.bytes[self.at..end];
        self.at = end;
        std::str::from_utf8(slice).map(str::to_owned).map_err(|e| {
            (
                ERR_BAD_UTF8,
                format!("not UTF-8 at byte {}: {e}", self.at - len),
            )
        })
    }
}

/// §4.4's OP_INIT frame. Names are labels, never opened: each is prefixed
/// with its section directory so a load error reads the way `load_corpus`'s
/// does.
fn parse_init_frame(req: &[u8]) -> Result<Vec<SourceFile>, (u16, String)> {
    let mut c = Cursor { bytes: req, at: 0 };
    let file_count = c.u32()?;
    let mut files: Vec<SourceFile> = Vec::new();
    for _ in 0..file_count {
        let section = match c.u8()? {
            0 => Section::Commands,
            1 => Section::Explainers,
            2 => Section::Rules,
            other => {
                return Err((
                    ERR_BAD_FRAME,
                    format!("section byte {other} at byte {} is not 0, 1 or 2", c.at - 1),
                ))
            }
        };
        let name_len = c.u32()?;
        let name = c.text(name_len)?;
        let source_len = c.u32()?;
        let source = c.text(source_len)?;
        let name = format!("{}{name}", section_prefix(section));
        if files.iter().any(|f| f.section == section && f.name == name) {
            return Err((
                ERR_BAD_FRAME,
                format!("duplicate source `{name}` in the init frame"),
            ));
        }
        files.push(SourceFile {
            section,
            name,
            source,
        });
    }
    if c.at != req.len() {
        return Err((
            ERR_BAD_FRAME,
            format!(
                "{} trailing bytes after {file_count} sources",
                req.len() - c.at
            ),
        ));
    }
    Ok(files)
}

fn section_prefix(section: Section) -> &'static str {
    match section {
        Section::Commands => "commands/",
        Section::Explainers => "explainers/",
        Section::Rules => "rules/",
    }
}
