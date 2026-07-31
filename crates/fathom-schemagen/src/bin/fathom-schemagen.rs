//! `fathom-schemagen [--check] [path-to-schema-dir]`
//!
//! Regenerates the 62 §17.1 artifacts from the schema tree (default `schema`)
//! into the tree's parent — the repo root — at their fixed repo-relative
//! paths. `--check` compares instead of writing (the CLI face of
//! `schema.codegen.stale`; the same check runs as a cargo test in this
//! crate, so CI needs no special wiring).
//!
//! Exit codes: 0 clean, 1 stale (`--check` only), 2 could not generate
//! (load error or failure-severity gate findings — gates first, then
//! codegen, never generate from a broken tree).

use std::fs;
use std::path::{Path, PathBuf};
use std::process::ExitCode;

fn main() -> ExitCode {
    let mut check = false;
    let mut root: Option<PathBuf> = None;
    for arg in std::env::args().skip(1) {
        match arg.as_str() {
            "--check" => check = true,
            other => root = Some(PathBuf::from(other)),
        }
    }
    let root = root.unwrap_or_else(|| PathBuf::from("schema"));
    let repo: PathBuf = match root.parent() {
        Some(p) if !p.as_os_str().is_empty() => p.to_path_buf(),
        _ => PathBuf::from("."),
    };

    let artifacts = match fathom_schemagen::generate(&root) {
        Ok(a) => a,
        Err(e) => {
            eprintln!("fathom-schemagen: {e}");
            return ExitCode::from(2);
        }
    };

    let mut stale = 0usize;
    for a in &artifacts {
        let path = repo.join(a.repo_path);
        if check {
            match fs::read(&path) {
                Ok(disk) if disk == a.bytes => println!("current  {}", a.repo_path),
                Ok(_) => {
                    println!("STALE    {}", a.repo_path);
                    stale += 1;
                }
                Err(_) => {
                    println!("MISSING  {}", a.repo_path);
                    stale += 1;
                }
            }
        } else if let Err(e) = write(&path, &a.bytes) {
            eprintln!("fathom-schemagen: {}: {e}", path.display());
            return ExitCode::from(2);
        } else {
            println!("wrote    {}  ({} bytes)", a.repo_path, a.bytes.len());
        }
    }

    if stale > 0 {
        println!("{stale} artifact(s) stale — run `cargo run -p fathom-schemagen`");
        return ExitCode::from(1);
    }
    ExitCode::SUCCESS
}

fn write(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(path, bytes)
}
