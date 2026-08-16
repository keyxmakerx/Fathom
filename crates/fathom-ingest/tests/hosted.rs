//! A handed-in dictionary is the dictionary on disk.
//!
//! This replaces `tests/embedded.rs`, which pinned the same property for the
//! `include_str!` copy that used to be compiled into the WebAssembly module.
//! The bytes moved to the page on 2026-08-15 (`crate::hosted`), so the risk
//! moved with them and split in two:
//!
//! * **Does the host path build the same dictionary as the disk path?** Here.
//!   It is a different code path — it never reads the schema tree, taking the
//!   field-key registry straight out of one file — so byte-equal inputs do not
//!   prove behaviour-equal outputs, and this is what exercises it.
//! * **Does the page actually hand in what is in the repository?** Not here,
//!   because this crate cannot see the page. `crates/fathom-artifact/tests/
//!   artifact.rs` decodes the frame out of the assembled artifact and compares
//!   it file by file and byte by byte against the directory.
//!
//! Together they are what `include_str!` gave for free.

use std::path::{Path, PathBuf};

use fathom_ingest::dict::{DictGate, Dictionary};
use fathom_ingest::hosted::dictionary_from_host;
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
/// dictionary directory, sorted, as `(name, text)`.
fn on_disk_sources() -> Vec<(String, String)> {
    let mut paths: Vec<PathBuf> = std::fs::read_dir(dict_dir())
        .expect("the dictionary directory is checked in")
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.extension().map(|x| x == "yaml").unwrap_or(false))
        .collect();
    paths.sort();
    paths
        .iter()
        .map(|p| {
            (
                p.file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or_default(),
                std::fs::read_to_string(p).unwrap_or_else(|e| panic!("{}: {e}", p.display())),
            )
        })
        .collect()
}

fn field_keys_text() -> String {
    std::fs::read_to_string(repo_root().join("schema").join("field-keys.yaml"))
        .expect("schema/field-keys.yaml is checked in")
}

fn hosted() -> Dictionary {
    dictionary_from_host(
        &on_disk_sources(),
        "schema/field-keys.yaml",
        &field_keys_text(),
    )
    .expect("the handed-in dictionary loads")
}

/// The two dictionaries understand the same paste the same way.
#[test]
fn hosted_and_on_disk_ingest_identically() {
    let disk = Dictionary::load(&repo_root()).expect("the shipped dictionary loads");
    let host = hosted();

    assert_eq!(host.platform(), disk.platform());
    assert_eq!(host.entry_count(), disk.entry_count());
    for i in 0..disk.entry_count() {
        let i = u16::try_from(i).expect("fewer than 65536 entries");
        assert_eq!(host.entry_id(i), disk.entry_id(i), "entry {i}");
    }

    let paste = std::fs::read(
        Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/junos-srx-s0-synthetic.txt"),
    )
    .expect("the fixture is checked in");

    let a = ingest(&paste, &disk).expect("within the caps");
    let b = ingest(&paste, &host).expect("within the caps");

    assert_eq!(a.capture, b.capture);
    assert_eq!(a.drops, b.drops);
    assert_eq!(a.fragment, b.fragment);
    assert_eq!(format!("{a:?}"), format!("{b:?}"));
}

/// Every gate `load` runs, the host path runs. The load-time gates are the
/// whole reason a dictionary can be trusted, and a constructor that skipped
/// them to be convenient would move the corpus's correctness from a checked
/// property to a hoped-for one.
#[test]
fn the_host_path_runs_the_load_time_gates() {
    let keys = field_keys_text();
    let shadowing = vec![(
        "t.yaml".to_owned(),
        "platform: junos-srx\nentries:\n  \
         - { id: a, path: [security, ike], versions: \"*\", reviewed_by: x }\n  \
         - { id: b, path: [security, ike, mode], versions: \"*\", reviewed_by: x }\n"
            .to_owned(),
    )];
    let e = dictionary_from_host(&shadowing, "schema/field-keys.yaml", &keys)
        .expect_err("a strict prefix without `partial: true` is refused");
    assert_eq!(e.gate, DictGate::Shadowing);
}

/// A field-key registry that is not the registry is a parse failure naming the
/// file it was handed, not a dictionary that quietly knows no field keys.
#[test]
fn an_unreadable_field_key_registry_is_refused_by_name() {
    let e = dictionary_from_host(&on_disk_sources(), "not-the-registry.yaml", "\t\tnope\n")
        .expect_err("the registry does not parse");
    assert_eq!(e.gate, DictGate::Parse);
    assert_eq!(e.file, "not-the-registry.yaml");
}

/// An empty registry parses and then fails the *wire-key* gate rather than
/// producing a dictionary that binds nothing. Pinned because "no field keys"
/// is the failure a botched frame produces, and it must be loud.
#[test]
fn an_empty_field_key_registry_fails_the_wire_key_gate() {
    let e = dictionary_from_host(&on_disk_sources(), "empty.yaml", "field_keys:\n")
        .expect_err("entries name fields that now have no key");
    assert_eq!(e.gate, DictGate::FieldUnknown);
}
