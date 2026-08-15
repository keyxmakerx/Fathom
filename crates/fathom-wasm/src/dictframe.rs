//! `OP_DICT`'s frame: the statement dictionary, handed in by the page.
//!
//! # The frame, and why it is `OP_INIT`'s
//!
//! ```text
//!   0   4   file_count (u32)
//!   per file:
//!       1   role (u8) — 0 = a dictionary `.yaml`, 1 = the field-key registry
//!       4   name_len (u32), then that many bytes of UTF-8
//!       4   source_len (u32), then that many bytes of UTF-8
//! ```
//!
//! That is `parse_init_frame`'s frame with `section` renamed `role`, down to
//! the byte. Deliberately: `OP_INIT` already carries corpus text from the page
//! into the module and has since WO-07, so this is a second use of a proven
//! route rather than a second route. A page that can encode one can encode the
//! other with the same three lines, and a reader of either finds the other
//! obvious.
//!
//! # Why a role byte rather than two opcodes
//!
//! The dictionary and the field-key registry are useless apart: entries name
//! fields, and a field with no wire key fails the `FieldUnknown` gate. Handing
//! them in together means the module never holds half a dictionary, and the
//! refusal for "you sent no registry" can be stated once, here, instead of as
//! an ordering rule between two opcodes that nothing enforces.
//!
//! # What this module does not do
//!
//! It does not choose a platform. One `Dictionary` holds one platform and
//! `from_sources` refuses files that disagree (`dict.rs`), so the platform is
//! whatever the handed-in files say it is. Holding several at once is `65`
//! §(a)'s open gap and is not made better or worse by this change.

use fathom_ingest::dict::Dictionary;
use fathom_ingest::hosted::dictionary_from_host;

use crate::protocol::{ERR_BAD_FRAME, ERR_CORPUS_LOAD};
use crate::shell::Cursor;

/// A dictionary `.yaml`, as `Dictionary::load` would have read it off disk.
pub const ROLE_DICT_SOURCE: u8 = 0;
/// `schema/field-keys.yaml`.
pub const ROLE_FIELD_KEYS: u8 = 1;

/// Encode an `OP_DICT` frame. The reference encoder — the artifact assembler
/// and this crate's tests both use it, so the page can never be encoding
/// against a different reading of the bytes than the module decodes with.
///
/// Mirrors `protocol::pack_corpus`, which does the same job for `OP_INIT`.
pub fn pack_dict(files: &[(u8, &str, &str)]) -> Vec<u8> {
    let mut out = Vec::new();
    out.extend_from_slice(&(files.len() as u32).to_le_bytes());
    for (role, name, source) in files {
        out.push(*role);
        out.extend_from_slice(&(name.len() as u32).to_le_bytes());
        out.extend_from_slice(name.as_bytes());
        out.extend_from_slice(&(source.len() as u32).to_le_bytes());
        out.extend_from_slice(source.as_bytes());
    }
    out
}

/// Decode the frame and build the dictionary, running every gate
/// `Dictionary::load` runs.
///
/// The two refusal classes are kept apart on purpose, because the remedies
/// differ and nothing else can tell them apart afterwards:
///
/// * `ERR_BAD_FRAME` — the bytes are not an `OP_DICT` frame, or the file set is
///   wrong (no sources, no registry, two registries). A **page** defect.
/// * `ERR_CORPUS_LOAD` — the frame decoded and the dictionary failed one of its
///   gates. A **corpus** defect, and the message carries the file, the line and
///   the gate that refused it.
pub(crate) fn load(req: &[u8]) -> Result<Dictionary, (u16, String)> {
    let mut c = Cursor::new(req);
    let file_count = c.u32()?;
    let mut sources: Vec<(String, String)> = Vec::new();
    let mut field_keys: Option<(String, String)> = None;

    for _ in 0..file_count {
        let role = c.u8()?;
        let name_len = c.u32()?;
        let name = c.text(name_len)?;
        let source_len = c.u32()?;
        let source = c.text(source_len)?;
        match role {
            ROLE_DICT_SOURCE => {
                // A duplicate name would load twice and silently double every
                // entry, which the shadowing gate then reports as a same-path
                // collision between an entry and itself — a confusing way to
                // learn the page sent one file twice.
                if sources.iter().any(|(n, _)| n == &name) {
                    return Err((
                        ERR_BAD_FRAME,
                        format!("duplicate dictionary source `{name}` in the frame"),
                    ));
                }
                sources.push((name, source));
            }
            ROLE_FIELD_KEYS => {
                if let Some((first, _)) = &field_keys {
                    return Err((
                        ERR_BAD_FRAME,
                        format!(
                            "the frame carries two field-key registries, `{first}` and `{name}`"
                        ),
                    ));
                }
                field_keys = Some((name, source));
            }
            other => {
                return Err((
                    ERR_BAD_FRAME,
                    format!("role byte {other} is not 0 (dictionary source) or 1 (field keys)"),
                ))
            }
        }
    }
    if c.at() != req.len() {
        return Err((
            ERR_BAD_FRAME,
            format!(
                "{} trailing bytes after {file_count} sources",
                req.len() - c.at()
            ),
        ));
    }

    if sources.is_empty() {
        return Err((
            ERR_BAD_FRAME,
            "the frame carries no dictionary source: a dictionary of nothing would parse \
             nothing and say it succeeded"
                .to_owned(),
        ));
    }
    let Some((keys_name, keys_text)) = field_keys else {
        return Err((
            ERR_BAD_FRAME,
            "the frame carries no field-key registry (role 1): without it every entry \
             fails the wire-key gate"
                .to_owned(),
        ));
    };

    // Entry indices are positional and `BindProv.entry` is a `u16` into them,
    // so the file order decides what every provenance record names. A frame in
    // the wrong order would load, parse and bind perfectly, and answer "which
    // dictionary entry asserted this?" with the wrong entry — invisible until
    // someone asks.
    //
    // So it is CHECKED, not fixed. Sorting here was the first draft and it
    // measured 5 096 bytes of module: `slice::sort_by` monomorphised for
    // `(String, String)` is a whole merge sort, and this frame is built by one
    // assembler that already sorts. Checking costs a comparison per file and
    // refuses out loud, which is also the better contract — a page that ships a
    // scrambled frame should be told, not quietly corrected into working.
    if let Some(pair) = sources.windows(2).find(|w| {
        w.first().map(|(n, _)| n.as_str()).unwrap_or("")
            >= w.get(1).map(|(n, _)| n.as_str()).unwrap_or("")
    }) {
        let name = |i: usize| pair.get(i).map(|(n, _)| n.as_str()).unwrap_or("");
        return Err((
            ERR_BAD_FRAME,
            format!(
                "dictionary sources arrive sorted by name and `{}` precedes `{}`: \
                 entry indices are positional, so the order decides what every \
                 provenance record names",
                name(0),
                name(1)
            ),
        ));
    }

    dictionary_from_host(&sources, &keys_name, &keys_text).map_err(|e| {
        (
            ERR_CORPUS_LOAD,
            format!(
                "the handed-in dictionary failed to load: {} line {}: {}",
                e.file, e.line, e.message
            ),
        )
    })
}
