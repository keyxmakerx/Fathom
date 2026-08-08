//! fathom-artifact: the dev browser artifact's assembler.
//!
//! `42` §2.1, quoting `35` §6.2: *"a single-file artifact has a trivial
//! bundling problem — the 'bundle' is a concatenation in a fixed order."*
//! This crate is that concatenation, first-party: a hand-authored shell
//! source plus two deterministic splices — `design/tokens.css` and the
//! base64 `fathom-wasm` module, `42` §8.2's mode A (*"base64 WASM →
//! instantiated from a Uint8Array, never fetched"*).
//!
//! No dependencies: the assembler is file plumbing plus one
//! `std::process::Command`, the same nested-cargo pattern WO-07's
//! `artifact_gates` uses, and the base64 encoder is ~20 first-party lines —
//! `fathom-id`'s Crockford encoder is the house precedent for hand-rolling an
//! encoding rather than adding a crate.
//!
//! The assembled file is **not** checked in, the same posture as the `.wasm`
//! itself. It is byte-identical on every run: the source and the tokens are
//! checked in, and the module rebuild is byte-identical (WO-07 G7).

#![forbid(unsafe_code)]

use std::path::Path;

/// Workspace-relative paths and the two splice tokens. The names carry
/// `dev` on purpose: this is 45 §9.1's dev build, not `fathom-<ver>.html`
/// (43 §3.5) — versioned assembly is WO-08 §10 item 7.
pub const SHELL_SOURCE: &str = "crates/fathom-artifact/html/fathom-dev.src.html";
pub const TOKENS_SOURCE: &str = "design/tokens.css";
pub const ARTIFACT_OUT: &str = "target/artifact/fathom-dev.html";
pub const TOKEN_TOKENS_CSS: &str = "@FATHOM_TOKENS_CSS@";
pub const TOKEN_WASM_B64: &str = "@FATHOM_WASM_B64@";

/// Where the nested build puts the module. Its own target dir, so it never
/// contends with `artifact_gates`'s (WO-07 §4.6).
const WASM_TARGET_DIR: &str = "target/artifact-wasm";
const WASM_MODULE: &str = "target/artifact-wasm/wasm32-unknown-unknown/release/fathom_wasm.wasm";

const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/// RFC 4648 §4 base64: standard alphabet, padded.
pub fn base64(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = *chunk.get(1).unwrap_or(&0) as u32;
        let b2 = *chunk.get(2).unwrap_or(&0) as u32;
        let n = (b0 << 16) | (b1 << 8) | b2;
        out.push(ALPHABET[(n >> 18) as usize & 63] as char);
        out.push(ALPHABET[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 {
            ALPHABET[(n >> 6) as usize & 63] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            ALPHABET[n as usize & 63] as char
        } else {
            '='
        });
    }
    out
}

/// Replace `token` exactly once. Any other count is a defect in the source,
/// never something to paper over: a missing token ships an artifact with a
/// literal `@FATHOM_…@` in it, and a doubled one ships the module twice.
fn splice(source: &str, token: &str, value: &str) -> Result<String, String> {
    let n = source.matches(token).count();
    if n != 1 {
        return Err(format!(
            "`{token}` occurs {n} times in the shell source; expected 1"
        ));
    }
    Ok(source.replacen(token, value, 1))
}

fn read(root: &Path, rel: &str) -> Result<String, String> {
    std::fs::read_to_string(root.join(rel)).map_err(|e| format!("{rel}: {e}"))
}

/// Build the module, read the three inputs, splice, and return the final
/// artifact bytes.
pub fn assemble(workspace_root: &Path) -> Result<Vec<u8>, String> {
    let cargo = std::env::var("CARGO").unwrap_or_else(|_| "cargo".to_owned());
    let status = std::process::Command::new(&cargo)
        .current_dir(workspace_root)
        .args([
            "build",
            "--release",
            "--target",
            "wasm32-unknown-unknown",
            "-p",
            "fathom-wasm",
            "--target-dir",
            WASM_TARGET_DIR,
        ])
        .status()
        .map_err(|e| format!("cargo must be runnable: {e}"))?;
    if !status.success() {
        return Err(format!("the release wasm build failed: {status}"));
    }

    let module = std::fs::read(workspace_root.join(WASM_MODULE))
        .map_err(|e| format!("{WASM_MODULE}: {e}"))?;
    let source = read(workspace_root, SHELL_SOURCE)?;
    let tokens = read(workspace_root, TOKENS_SOURCE)?;

    let spliced = splice(&source, TOKEN_TOKENS_CSS, &tokens)?;
    let spliced = splice(&spliced, TOKEN_WASM_B64, &base64(&module))?;
    Ok(spliced.into_bytes())
}
