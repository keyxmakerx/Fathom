//! The two artifact gates the security corpus specifies for this module, made
//! runnable: the import audit (34 §7.5, 42 §9.4 check 5 — here asserting the
//! stronger fact that the import section is *empty*) and the size gate
//! (44 §5.2's 900 KB uncompressed ceiling, read as 900 000 bytes).
//!
//! The audit parses the built `.wasm` with `fathom_wasm::wasmbin`: no
//! `wasm-objdump`, no `twiggy`, no tool download (78 §5 item 2).

use std::path::PathBuf;
use std::process::Command;

use fathom_wasm::wasmbin::{export_entries, import_entries, ExportEntry, IMPORT_ALLOWLIST};

fn workspace_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")
}

fn names(exports: &[ExportEntry], kind: u8) -> Vec<String> {
    let mut out: Vec<String> = exports
        .iter()
        .filter(|e| e.kind == kind)
        .map(|e| e.name.clone())
        .collect();
    out.sort();
    out
}

#[test]
fn release_wasm_builds_audits_and_fits() {
    let root = workspace_root();
    let cargo = std::env::var("CARGO").unwrap_or_else(|_| "cargo".to_owned());

    // A separate target dir, so this nested build never contends with the
    // lock of the outer `cargo test` running it (WO-07 §4.6).
    let status = Command::new(&cargo)
        .current_dir(&root)
        .args([
            "build",
            "--release",
            "--target",
            "wasm32-unknown-unknown",
            "-p",
            "fathom-wasm",
            "--target-dir",
            "target/wasm-audit",
        ])
        .status()
        .expect("the cargo binary must be runnable");
    assert!(status.success(), "the release wasm build must succeed");

    let artifact = root.join("target/wasm-audit/wasm32-unknown-unknown/release/fathom_wasm.wasm");
    let wasm = std::fs::read(&artifact).unwrap_or_else(|e| panic!("{}: {e}", artifact.display()));

    // --- import audit (34 §7.5, 42 §9.4 check 5, 38 §2 G1) -------------------
    let imports = import_entries(&wasm).expect("the import section must parse");
    assert!(
        imports.is_empty(),
        "the import section must be empty; found {imports:?}"
    );
    for (module, field) in &imports {
        assert!(
            IMPORT_ALLOWLIST.contains(&field.as_str()),
            "import {module}::{field} is not in the committed allowlist"
        );
    }

    // --- export audit (34 §7.5: an export is a capability grant) -------------
    let exports = export_entries(&wasm).expect("the export section must parse");
    let funcs = names(&exports, 0);
    let tables = names(&exports, 1);
    let mems = names(&exports, 2);
    let globals = names(&exports, 3);
    assert_eq!(
        funcs,
        vec![
            "fathom_alloc".to_owned(),
            "fathom_call".to_owned(),
            "fathom_free".to_owned()
        ],
        "the function export set is exactly 41 §3.7's three data-plane entry points"
    );
    assert_eq!(mems, vec!["memory".to_owned()]);
    assert_eq!(
        globals,
        vec!["__data_end".to_owned(), "__heap_base".to_owned()],
        "the two linker-emitted globals, and nothing else"
    );
    assert!(tables.is_empty(), "no table export: {tables:?}");
    assert!(
        exports.iter().all(|e| e.kind <= 3),
        "no export of any other kind"
    );

    // --- size gate (44 §5.2's hard ceiling, KB read as 1 000 bytes) ----------
    let size = wasm.len();
    assert!(
        size <= 900_000,
        "the module is {size} bytes, over 44 §5.2's 900 000-byte ceiling"
    );

    println!("wasm size: {size} bytes (ceiling 900000)");
    println!("imports: {imports:?}");
    println!("export funcs: {funcs:?}");
    println!("export mems: {mems:?}");
    println!("export globals: {globals:?}");
    println!("export tables: {tables:?}");
}
