//! A first-party reader for the two sections of the WebAssembly binary format
//! the artifact audit needs: imports (id 2) and exports (id 7).
//!
//! 34 §7.5 and 42 §9.4 check 5 specify the audit over `wasm-objdump -x`. No
//! such tool is in this repository and none may be added (78 §5.2), so the
//! audit parses the binary itself: the preamble is `\0asm` and a u32 version,
//! then a sequence of sections, each an id byte and a LEB128 payload size.
//! Everything below is safe Rust over a byte slice; nothing is executed.

/// The committed import allowlist (34 §7.5; 42 §9.4 check 5). The only names
/// that may ever appear here are `fathom_entropy` and `fathom_now_ms`
/// (38 §2 G1) — and neither is needed yet: the finder draws no entropy and
/// reads no clock, so the list is EMPTY and the audit asserts the import
/// section is too. Growing this list is a planning decision, never a fix
/// for a red gate.
pub const IMPORT_ALLOWLIST: &[&str] = &[];

pub struct ExportEntry {
    pub name: String,
    /// 0 func · 1 table · 2 mem · 3 global — the format's own kind byte.
    pub kind: u8,
}

const SECTION_IMPORT: u8 = 2;
const SECTION_EXPORT: u8 = 7;

/// (module, field) for every entry in the import section, in section order.
pub fn import_entries(wasm: &[u8]) -> Result<Vec<(String, String)>, String> {
    let Some(payload) = section(wasm, SECTION_IMPORT)? else {
        return Ok(Vec::new());
    };
    let mut r = Reader::new(payload);
    let count = r.leb_u32()?;
    let mut out = Vec::new();
    for _ in 0..count {
        let module = r.name()?;
        let field = r.name()?;
        r.skip_import_desc()?;
        out.push((module, field));
    }
    Ok(out)
}

pub fn export_entries(wasm: &[u8]) -> Result<Vec<ExportEntry>, String> {
    let Some(payload) = section(wasm, SECTION_EXPORT)? else {
        return Ok(Vec::new());
    };
    let mut r = Reader::new(payload);
    let count = r.leb_u32()?;
    let mut out = Vec::new();
    for _ in 0..count {
        let name = r.name()?;
        let kind = r.byte()?;
        let _index = r.leb_u32()?;
        out.push(ExportEntry { name, kind });
    }
    Ok(out)
}

/// The payload of the first section with this id, or `None` if the module has
/// no such section.
fn section(wasm: &[u8], want: u8) -> Result<Option<&[u8]>, String> {
    if wasm.len() < 8 || &wasm[0..4] != b"\0asm" {
        return Err("not a WebAssembly module: bad preamble at offset 0".to_owned());
    }
    let mut r = Reader::new(&wasm[8..]);
    while !r.done() {
        let id = r.byte()?;
        let size = r.leb_u32()? as usize;
        let payload = r.take(size)?;
        if id == want {
            return Ok(Some(payload));
        }
    }
    Ok(None)
}

struct Reader<'a> {
    bytes: &'a [u8],
    at: usize,
}

impl<'a> Reader<'a> {
    fn new(bytes: &'a [u8]) -> Reader<'a> {
        Reader { bytes, at: 0 }
    }

    fn done(&self) -> bool {
        self.at >= self.bytes.len()
    }

    fn byte(&mut self) -> Result<u8, String> {
        if self.at >= self.bytes.len() {
            return Err(format!("truncated at offset {}", self.at));
        }
        let b = self.bytes[self.at];
        self.at += 1;
        Ok(b)
    }

    fn take(&mut self, len: usize) -> Result<&'a [u8], String> {
        let end = self
            .at
            .checked_add(len)
            .ok_or_else(|| format!("length overflows at offset {}", self.at))?;
        if end > self.bytes.len() {
            return Err(format!("truncated at offset {}", self.at));
        }
        let slice = &self.bytes[self.at..end];
        self.at = end;
        Ok(slice)
    }

    /// Unsigned LEB128, bounded at five bytes — the width a u32 can occupy.
    fn leb_u32(&mut self) -> Result<u32, String> {
        let mut value: u64 = 0;
        let mut shift = 0;
        for _ in 0..5 {
            let b = self.byte()?;
            value |= u64::from(b & 0x7f) << shift;
            if b & 0x80 == 0 {
                if value > u64::from(u32::MAX) {
                    return Err(format!("LEB128 value overflows u32 at offset {}", self.at));
                }
                return Ok(value as u32);
            }
            shift += 7;
        }
        Err(format!("LEB128 runs past five bytes at offset {}", self.at))
    }

    fn name(&mut self) -> Result<String, String> {
        let len = self.leb_u32()? as usize;
        let at = self.at;
        let bytes = self.take(len)?;
        std::str::from_utf8(bytes)
            .map(str::to_owned)
            .map_err(|e| format!("name at offset {at} is not UTF-8: {e}"))
    }

    /// Advance past one import descriptor, whose shape depends on its kind
    /// byte: func (a type index), table (a reference type and limits), memory
    /// (limits), global (a value type and a mutability byte), tag (an
    /// attribute and a type index).
    fn skip_import_desc(&mut self) -> Result<(), String> {
        match self.byte()? {
            0x00 => {
                self.leb_u32()?;
            }
            0x01 => {
                self.byte()?;
                self.skip_limits()?;
            }
            0x02 => self.skip_limits()?,
            0x03 => {
                self.byte()?;
                self.byte()?;
            }
            0x04 => {
                self.byte()?;
                self.leb_u32()?;
            }
            other => {
                return Err(format!(
                    "unknown import kind {other:#04x} at offset {}",
                    self.at - 1
                ))
            }
        }
        Ok(())
    }

    fn skip_limits(&mut self) -> Result<(), String> {
        let flag = self.byte()?;
        self.leb_u32()?;
        if flag & 0x01 != 0 {
            self.leb_u32()?;
        }
        Ok(())
    }
}
