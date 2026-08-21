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

    // --- fixture audit (2026-08-15) -----------------------------------------
    //
    // The demo estate is a development fixture and is worth 35,272 bytes — 4%
    // of the ceiling — so it builds only under `fathom-inventory`'s off-by-
    // default `demo-estate` feature. What keeps it out of THIS build is Cargo's
    // resolver-2 rule that dev-dependency features are not unified into builds
    // that are not building dev-dependencies. That is a resolver behaviour, and
    // the whole 35 KB rests on it, so it is asserted here rather than believed:
    // one `default-features`, one stray feature edge, or a resolver change puts
    // the fixture back silently, with the size gate none the wiser while there
    // is headroom to absorb it.
    //
    // The probes are the fixture's own string literals, and they were chosen by
    // NEGATIVE CONTROL, not by inspection: both were confirmed present in a
    // `--features demo-estate` build and absent from this one before this
    // assertion was written. `Cedar Row` was tried as a third and dropped
    // because it is in neither — a probe that cannot fail is not a guard. This
    // is rule 0's discipline (a gate is tested against what it must catch)
    // applied to a byte gate rather than a redaction gate.
    for probe in ["Riverside CO", "demo estate — WO-08"] {
        assert!(
            !wasm.windows(probe.len()).any(|w| w == probe.as_bytes()),
            "the demo estate is linked into the shipping module: found {probe:?}. \
             Something enabled fathom-inventory's `demo-estate` feature in the \
             module's normal dependency graph; it belongs to test targets only."
        );
    }

    // The `inspect` feature is the same bet on the same resolver rule, made
    // 2026-08-21 for a read path into the held estate that only tests use. It
    // is far smaller than the demo estate, which is exactly why it needs the
    // assertion more: a few hundred bytes would never trip the size gate below,
    // so nothing else in this file would notice it shipping.
    //
    // The probe is chosen by the same negative control as the two above —
    // `estate_for_test` is present in a `--features inspect` build and absent
    // from this one, checked before this was written rather than assumed.
    {
        let probe = b"estate_for_test";
        assert!(
            !wasm.windows(probe.len()).any(|w| w == probe),
            "the test-only estate accessor is linked into the shipping module. \
             Something enabled fathom-wasm's `inspect` feature in the module's \
             normal dependency graph; it belongs to test targets only."
        );
    }

    // --- size REPORT, not a gate. The ceiling was removed 2026-08-21. --------
    //
    // `44` §5.2's 900,000-byte hard ceiling decided what shipped for months. It
    // was a WEBASSEMBLY constraint: what a browser could fetch, parse and
    // instantiate inside `44`'s first-render budget, in a product whose whole
    // delivery was one HTML file opened from a disk.
    //
    // **THE OWNER RETIRED THAT PRODUCT ON 2026-08-18** (`49` §1): the data lives
    // on the server, the browser is a window onto it, and the single offline
    // file is dropped. `49` §1 lists the ceiling among the things the pivot
    // retires, because a native binary has no such limit and the browser stops
    // carrying a typed graph, a parser and a layout engine.
    //
    // It is removed rather than raised, and the distinction matters. Raising it
    // to whatever number today's build happens to need is how a safety number
    // dies: it stops meaning "we measured this" and starts meaning "this is
    // what fitted last time somebody bumped into it". `47` §11 warned about
    // exactly that. Either the constraint applies or it does not — and the
    // product decision is that it does not.
    //
    // **WHAT REPLACES IT IS VISIBILITY, NOT NOTHING.** The size is printed on
    // every run, so growth stays in front of whoever is reading the output. The
    // three assertions above — no imports, no demo estate, no test-only
    // accessor — are the ones that were ever really guarding correctness, and
    // they stay. They caught real things; the byte count never caught anything,
    // it only ever refused work.
    //
    // **IF THE BROWSER MODULE IS EVER THE PRODUCT AGAIN, DO NOT RESTORE A
    // NUMBER — RESTORE A MEASUREMENT.** The ceiling's justification was always a
    // first-render claim, and a first-render claim is measured in a browser, not
    // asserted in a unit test. `49` §1 re-scopes this module to the ingest gate
    // and nothing else, and a gate-sized module will not be near this figure.
    let size = wasm.len();

    println!("wasm size: {size} bytes (no ceiling since 2026-08-21; see 49 §1)");
    println!("imports: {imports:?}");
    println!("export funcs: {funcs:?}");
    println!("export mems: {mems:?}");
    println!("export globals: {globals:?}");
    println!("export tables: {tables:?}");
}
