//! The statement dictionary, gathered off disk and packed into the frame the
//! page hands the module at boot.
//!
//! # Why the page carries it
//!
//! It used to be `include_str!`'d into the WebAssembly module. Measured
//! 2026-08-15: taking it out shrank the release module from 852 918 bytes to
//! 826 003, against `44` §5.2's 900 000-byte ceiling that fails the merge. The
//! YAML did not evaporate — it moved into this file, base64 in the page, where
//! the ceiling is 4.5 MB rather than 900 KB and where every further platform's
//! dictionary can follow it.
//!
//! # Base64, not a JavaScript string literal
//!
//! Base64 costs 4/3 of the raw bytes and a literal would cost about 1/1. It is
//! still the right encoding, for two reasons that outrank the third of a
//! kilobyte per kilobyte:
//!
//! * **A YAML file is not a safe JS string.** It has quotes, backslashes and
//!   newlines, and the day one gains a `</script>` is the day the escaping is
//!   load-bearing. Base64's alphabet cannot terminate a script element or a
//!   string literal, so there is no escaping to get wrong.
//! * **It is the established route.** `42` §8.2 mode A already splices the
//!   module itself as base64 and the page already has the decoder. This adds a
//!   second call to a function that exists, not a second mechanism.
//!
//! # The drift guard, which used to be the compiler's job
//!
//! `include_str!` could not disagree with the repository. A frame built here
//! can, so `tests/artifact.rs` decodes the frame out of the **assembled page**
//! and compares it against the directory, file by file and byte by byte. That
//! is `fathom-ingest`'s old `tests/embedded.rs`, moved to the boundary that now
//! carries the risk.

use std::path::Path;

/// `Dictionary::load` joins this same path. One platform per directory, because
/// one `Dictionary` holds one platform — `from_sources` refuses a file set whose
/// `platform:` lines disagree, so two platforms are two directories, two frames
/// and two `OP_DICT` calls rather than one dictionary that spans both.
///
/// Holding several at once inside ONE `Dictionary` is still `65` §(a)'s open
/// gap and this file does not close it: the module keeps them in separate slots
/// and a paste chooses one.
pub const DICT_DIR: &str = "corpus/dict/junos-srx";
/// The OPNsense firewall-rules dictionary — a table grammar, not a set-form one
/// (`64` §1.1). It travels the same way for the same reason: it is 4 065 bytes
/// of YAML, and `include_str!`ing it would have spent them against `44` §5.2's
/// 900 000-byte module ceiling instead of the artifact's 4.5 MB.
pub const CSV_DICT_DIR: &str = "corpus/dict/opnsense";
pub const FIELD_KEYS_SOURCE: &str = "schema/field-keys.yaml";

/// Every `.yaml` under [`DICT_DIR`], sorted by file name.
///
/// The same enumeration `Dictionary::load` performs — `read_dir`, filter to
/// `.yaml`, sort — and it must stay the same one: entry indices are positional
/// and `BindProv.entry` is a `u16` into them, so a different order here would
/// hand the module a dictionary whose provenance names the wrong entries. The
/// module refuses an out-of-order frame rather than trusting this
/// (`fathom_wasm::dictframe`), and `tests/artifact.rs` pins the set.
pub fn sources(root: &Path) -> Result<Vec<(String, String)>, String> {
    sources_in(root, DICT_DIR)
}

/// [`sources`] for any dictionary directory. Split out 2026-08-15 when the
/// second platform arrived: the one directory name was written into the body,
/// which was true while there was one platform and became a false generality
/// the moment there were two.
pub fn sources_in(root: &Path, rel: &str) -> Result<Vec<(String, String)>, String> {
    let dir = root.join(rel);
    let mut paths: Vec<std::path::PathBuf> = std::fs::read_dir(&dir)
        .map_err(|e| format!("{rel}: {e}"))?
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.extension().map(|x| x == "yaml").unwrap_or(false))
        .collect();
    paths.sort();

    let mut out = Vec::with_capacity(paths.len());
    for path in &paths {
        let name = path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        let text = std::fs::read_to_string(path).map_err(|e| format!("{name}: {e}"))?;
        out.push((name, text));
    }
    if out.is_empty() {
        return Err(format!(
            "{rel} holds no .yaml: the page would boot with a dictionary that \
             understands nothing"
        ));
    }
    Ok(out)
}

/// The `OP_DICT` frame: every dictionary source at role 0, then
/// `schema/field-keys.yaml` at role 1.
///
/// The registry goes last only because it reads that way; the module keys on
/// the role byte, never on position.
pub fn frame(root: &Path) -> Result<Vec<u8>, String> {
    frame_for(root, DICT_DIR)
}

/// [`frame`] for any dictionary directory. The field-key registry travels in
/// EVERY frame, not once: the module builds each dictionary independently and a
/// dictionary with no registry fails its own wire-key gate, so sharing one
/// across frames would make the second `OP_DICT` depend on the first having
/// happened — an ordering rule with nothing to enforce it.
pub fn frame_for(root: &Path, rel: &str) -> Result<Vec<u8>, String> {
    let sources = sources_in(root, rel)?;
    let keys = std::fs::read_to_string(root.join(FIELD_KEYS_SOURCE))
        .map_err(|e| format!("{FIELD_KEYS_SOURCE}: {e}"))?;

    let mut files: Vec<(u8, &str, &str)> = sources
        .iter()
        .map(|(name, text)| {
            (
                fathom_wasm::dictframe::ROLE_DICT_SOURCE,
                name.as_str(),
                text.as_str(),
            )
        })
        .collect();
    files.push((
        fathom_wasm::dictframe::ROLE_FIELD_KEYS,
        FIELD_KEYS_SOURCE,
        keys.as_str(),
    ));
    Ok(fathom_wasm::dictframe::pack_dict(&files))
}
