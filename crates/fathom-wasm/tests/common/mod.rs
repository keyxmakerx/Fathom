//! The boot step every pasting test now needs: hand the shell its dictionary.
//!
//! Before 2026-08-15 a `Shell::new()` could paste immediately, because the
//! dictionary was compiled into the crate. It is handed in over `OP_DICT` now
//! (`fathom_wasm::dictframe`), so a shell that has not been given one refuses
//! with `ERR_NO_DICTIONARY` — which is a tested behaviour of its own in
//! `dictionary.rs`, and is not what the paste tests are about.
//!
//! The frame is built from the checked-in corpus with the same encoder the
//! artifact assembler uses, so these tests exercise the bytes the browser will
//! actually send rather than a convenient stand-in.

use std::path::{Path, PathBuf};

use fathom_wasm::dictframe::{pack_dict, ROLE_DICT_SOURCE, ROLE_FIELD_KEYS};
use fathom_wasm::shell::Shell;
use fathom_wasm::OP_DICT;

pub fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .nth(2)
        .expect("the crate lives two levels under the repo root")
        .to_path_buf()
}

/// `corpus/dict/junos-srx/*.yaml`, sorted, exactly as `Dictionary::load` reads
/// them.
pub fn dict_sources() -> Vec<(String, String)> {
    let dir = repo_root().join("corpus").join("dict").join("junos-srx");
    let mut paths: Vec<PathBuf> = std::fs::read_dir(&dir)
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

pub fn field_keys() -> String {
    std::fs::read_to_string(repo_root().join("schema").join("field-keys.yaml"))
        .expect("schema/field-keys.yaml is checked in")
}

/// The `OP_DICT` frame the page splices in, built here from the same files.
pub fn dict_frame() -> Vec<u8> {
    let sources = dict_sources();
    let keys = field_keys();
    let mut files: Vec<(u8, &str, &str)> = sources
        .iter()
        .map(|(n, t)| (ROLE_DICT_SOURCE, n.as_str(), t.as_str()))
        .collect();
    files.push((ROLE_FIELD_KEYS, "schema/field-keys.yaml", keys.as_str()));
    pack_dict(&files)
}

/// A shell that has been through the page's boot: dictionary loaded, nothing
/// else. The empty reply is asserted rather than ignored, so a dictionary that
/// stopped loading fails here loudly instead of surfacing as a mystifying
/// paste refusal in twelve other tests.
pub fn booted_shell() -> Shell {
    let mut shell = Shell::new();
    let reply = shell.handle(OP_DICT, &dict_frame());
    assert!(
        reply.is_empty(),
        "OP_DICT must succeed before any paste; it replied {} bytes",
        reply.len()
    );
    shell
}
