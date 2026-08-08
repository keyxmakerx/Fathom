//! Assemble the dev artifact and write it to `target/artifact/`.

use std::path::PathBuf;

fn main() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    let bytes = match fathom_artifact::assemble(&root) {
        Ok(b) => b,
        Err(e) => {
            eprintln!("{e}");
            std::process::exit(1);
        }
    };
    let out = root.join(fathom_artifact::ARTIFACT_OUT);
    if let Some(dir) = out.parent() {
        std::fs::create_dir_all(dir).unwrap_or_else(|e| panic!("{}: {e}", dir.display()));
    }
    std::fs::write(&out, &bytes).unwrap_or_else(|e| panic!("{}: {e}", out.display()));
    println!("{} · {} bytes", fathom_artifact::ARTIFACT_OUT, bytes.len());
}
