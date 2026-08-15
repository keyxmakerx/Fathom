//! The dictionary, handed in by the host rather than compiled in.
//!
//! # Why this file exists
//!
//! Until 2026-08-15 the WebAssembly build got its dictionary from six
//! `include_str!` lines in [`crate::dict`]. That worked and it did not scale:
//! `14` §2.2 sizes one real platform dictionary at 400–2 500 entries, the
//! junos-srx slice measures ~457 bytes of YAML per entry, and the module has a
//! hard 900 000-byte ceiling (`44` §5.2) it was already inside by under 6 %.
//! The second platform's dictionary would have burst it on its own, and no
//! amount of compiler cleverness recovers bytes that are literally a copy of a
//! YAML file in the data section.
//!
//! So the dictionary moves to where the corpus already lives: the page hands it
//! in over the byte protocol, exactly as it hands in commands, explainers and
//! rules through `OP_INIT`. `65` §(g) named this route before it was built —
//! *"the module already has a working, tested channel for the page to hand it
//! corpus text at runtime … Moving it there is a section byte and a loader
//! call, not a new architecture."*
//!
//! # What is deliberately unchanged
//!
//! Every gate. This is the same [`Dictionary::from_sources`] the on-disk
//! [`Dictionary::load`] calls, with the same inputs in the same order, so a
//! dictionary that the host hands in is checked exactly as hard as one read off
//! disk: shadowing, secret coupling, capture arity, wire keys, the lookup
//! budget. A host-supplied dictionary that does not pass is not half-loaded, it
//! is refused.
//!
//! # The drift this file cannot catch, and who does
//!
//! `include_str!` had one virtue: the bytes could not disagree with the repo,
//! because the compiler read them from it. Handing them in loses that, and the
//! replacement guard has to live where the handing-in happens — the artifact
//! assembler. `crates/fathom-artifact/tests/artifact.rs` reads the directory,
//! decodes the frame spliced into the built page, and fails if they differ by
//! one file or by one byte. That is the same protection `fathom-ingest`'s old
//! `tests/embedded.rs` gave, moved to the boundary that now carries the risk.

use std::collections::BTreeMap;

use crate::dict::{DictError, DictGate, Dictionary};

/// Build a dictionary from sources the caller supplies: the `.yaml` files that
/// would have been read out of `corpus/dict/<platform>/`, plus the text of
/// `schema/field-keys.yaml`.
///
/// `sources` must be in the order [`Dictionary::load`] would read them —
/// alphabetical by file name — because entry indices are positional and
/// `BindProv.entry` is a `u16` into them. Two hosts that order the same files
/// differently would produce two dictionaries that agree on every statement and
/// disagree on every provenance record, which is the kind of divergence that is
/// invisible until someone asks *"which entry bound this?"*. Ordering is
/// therefore the caller's contract, and the artifact assembler discharges it by
/// sorting, the same call `load` makes.
///
/// `field_keys_name` is only ever a label in an error: nothing here opens a
/// path. It exists so a refusal reads the way `load`'s does.
pub fn dictionary_from_host(
    sources: &[(String, String)],
    field_keys_name: &str,
    field_keys_text: &str,
) -> Result<Dictionary, DictError> {
    let keys = parse_field_keys(field_keys_name, field_keys_text)?;
    Dictionary::from_sources(sources, keys)
}

/// `schema/field-keys.yaml`, parsed into the map the dictionary loader wants.
///
/// The same reading `SchemaTree::load` performs — literally the same function,
/// `fathom_schema::model::field_key_entries`, so the two paths cannot drift.
/// A negative or over-wide key is refused rather than wrapped: the registry is
/// a `u32` on the wire (`11` §14.1) and a value that does not fit it is a
/// defect in the file, not something to round.
///
/// Moved here from `dict.rs` unchanged when the `include_str!` went away; the
/// only edit is that the text and the name are arguments instead of constants.
pub fn parse_field_keys(name: &str, text: &str) -> Result<BTreeMap<String, u32>, DictError> {
    let node = fathom_schema::subset::parse(text).map_err(|e| DictError {
        file: name.to_owned(),
        line: e.line,
        gate: DictGate::Parse,
        message: e.message,
    })?;
    let mut keys = BTreeMap::new();
    for (field, key, line) in fathom_schema::model::field_key_entries(&node) {
        let key = u32::try_from(key).map_err(|_| DictError {
            file: name.to_owned(),
            line,
            gate: DictGate::Parse,
            message: format!("field key `{field}` is {key}, which is not a u32"),
        })?;
        keys.insert(field, key);
    }
    Ok(keys)
}
