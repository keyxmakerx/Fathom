//! The compiled-in dictionary is the dictionary on disk.
//!
//! `Dictionary::embedded` exists so the WebAssembly build can parse without a
//! filesystem. Its whole risk is drift: a seventh file lands in
//! `corpus/dict/junos-srx/`, or an existing one is edited, and the browser
//! silently keeps understanding the old estate while every native test passes.
//! These three tests are the only thing standing between that and a shipped
//! artifact, so they compare the *list*, the *bytes* and the *behaviour* —
//! each of the three catches a drift the other two do not.

use std::path::{Path, PathBuf};

use fathom_ingest::dict::{Dictionary, EMBEDDED_DICT_SOURCES, EMBEDDED_FIELD_KEYS};
use fathom_ingest::ingest;

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .nth(2)
        .expect("the crate lives two levels under the repo root")
        .to_path_buf()
}

fn dict_dir() -> PathBuf {
    repo_root().join("corpus").join("dict").join("junos-srx")
}

/// The same enumeration `Dictionary::load` performs: every `.yaml` under the
/// dictionary directory, sorted.
fn on_disk_names() -> Vec<String> {
    let mut names: Vec<String> = std::fs::read_dir(dict_dir())
        .expect("the dictionary directory is checked in")
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.extension().map(|x| x == "yaml").unwrap_or(false))
        .filter_map(|p| p.file_name().map(|n| n.to_string_lossy().into_owned()))
        .collect();
    names.sort();
    names
}

/// A file added to or removed from the directory. `load` would pick it up;
/// `embedded` cannot, because `include_str!` takes a literal path.
#[test]
fn the_embedded_list_is_the_directory() {
    let embedded: Vec<String> = EMBEDDED_DICT_SOURCES
        .iter()
        .map(|(name, _)| (*name).to_owned())
        .collect();
    assert_eq!(
        embedded,
        on_disk_names(),
        "EMBEDDED_DICT_SOURCES and corpus/dict/junos-srx/ disagree. \
         A dictionary file was added, removed or renamed and the embedded \
         list was not updated: add the include_str! entry, in sorted order."
    );
}

/// An edit to a file already in the list. `include_str!` re-reads at compile
/// time, so this can only fail if the checked-in bytes differ from what the
/// build saw — a stale build, or a path in the list pointing at the wrong file.
#[test]
fn every_embedded_source_is_byte_identical() {
    for (name, text) in EMBEDDED_DICT_SOURCES {
        let disk = std::fs::read_to_string(dict_dir().join(name))
            .unwrap_or_else(|e| panic!("{name}: {e}"));
        assert_eq!(&disk, text, "{name} differs from the compiled-in copy");
    }
    let keys = std::fs::read_to_string(repo_root().join("schema").join("field-keys.yaml"))
        .expect("schema/field-keys.yaml is checked in");
    assert_eq!(
        &keys, EMBEDDED_FIELD_KEYS,
        "schema/field-keys.yaml differs from the compiled-in copy"
    );
}

/// The two dictionaries understand the same paste the same way. Bytes being
/// equal does not prove this on its own: `embedded` skips the schema tree and
/// reads the field-key registry directly, so the field keys it hands the
/// binder are a separate code path and this is what exercises it.
#[test]
fn embedded_and_on_disk_ingest_identically() {
    let disk = Dictionary::load(&repo_root()).expect("the shipped dictionary loads");
    let embedded = Dictionary::embedded().expect("the compiled-in dictionary loads");

    assert_eq!(embedded.platform(), disk.platform());
    assert_eq!(embedded.entry_count(), disk.entry_count());
    for i in 0..disk.entry_count() {
        let i = u16::try_from(i).expect("fewer than 65536 entries");
        assert_eq!(embedded.entry_id(i), disk.entry_id(i), "entry {i}");
    }

    let paste = std::fs::read(
        Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/junos-srx-s0-synthetic.txt"),
    )
    .expect("the fixture is checked in");

    let a = ingest(&paste, &disk).expect("within the caps");
    let b = ingest(&paste, &embedded).expect("within the caps");

    assert_eq!(a.capture, b.capture);
    assert_eq!(a.drops, b.drops);
    assert_eq!(a.fragment, b.fragment);
    assert_eq!(format!("{a:?}"), format!("{b:?}"));
}
