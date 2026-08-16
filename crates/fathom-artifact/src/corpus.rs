//! The corpus, handed to the module at boot rather than compiled into it.
//!
//! `OP_INIT` has taken its corpus as a frame since WO-07 — `parse_init_frame`
//! and `protocol::pack_corpus` are both a year older than this file. What did
//! not exist was anything that *built* that frame outside a test, so the page
//! shipped with a disabled search box on top of a working finder.
//!
//! # Why the frame is built here and not in the page
//!
//! `pack_corpus` is the reference encoder and there is exactly one of it. A
//! JavaScript re-implementation of the same framing would be a second encoder
//! that agrees with the first until a length prefix moves, and the failure mode
//! of a disagreement is a corpus that loads with the wrong file boundaries
//! rather than one that refuses. So the assembler packs the frame with the
//! module's own encoder, base64s it, and the page's whole contribution is
//! `atob` — no lengths, no section bytes, no ordering.
//!
//! Base64 rather than the YAML spliced in as text: the corpus is 548 KB of
//! prose full of quotes, backslashes and — in at least one entry — the
//! characters that end a script element. Splicing it as text would put the
//! artifact's integrity behind an escaping routine. Base64 costs 4/3 and has no
//! escaping routine to get wrong. `44` §5.3 budgets the whole artifact at
//! 4.5 MB and it is nowhere near that.
//!
//! # Why the assembler loads it before shipping it
//!
//! `verify` runs the packed frame through the module's own `OP_INIT` on the
//! host. A corpus that does not parse then fails `cargo run -p fathom-artifact`
//! with the load error, instead of shipping an artifact whose finder is empty
//! and whose page cannot say why.

use std::path::{Path, PathBuf};

use fathom_corpus::{SourceFile, SECTION_DIRS};
use fathom_wasm::protocol::pack_corpus;
use fathom_wasm::shell::Shell;
use fathom_wasm::OP_INIT;

/// The corpus root, relative to the workspace root.
pub const CORPUS_DIR: &str = "corpus";

/// The seed corpus as bare-named sources, in `load_corpus`'s own order:
/// commands, explainers, rules, concepts, each directory's `*.yaml` sorted by
/// path.
///
/// The section list is `fathom_corpus::SECTION_DIRS` rather than a copy. It was
/// a copy until `concepts/` was added, and a copy is exactly the shape of
/// defect that ships a page missing one whole section while every test that
/// reads the directory still passes.
///
/// Names are the bare file name. The shell prefixes each with its section
/// directory (`shell::section_prefix`), so a load error in the browser reads
/// `commands/junos-srx-ipsec.yaml:1234: …` — the same string the native path
/// prints. Sending the full path instead would leak the build machine's
/// directory layout into the shipped artifact for no gain.
pub fn sources(workspace_root: &Path) -> Result<Vec<SourceFile>, String> {
    let root = workspace_root.join(CORPUS_DIR);
    let mut out = Vec::new();
    for (section, dir) in SECTION_DIRS {
        let path = root.join(dir);
        let mut paths: Vec<PathBuf> = std::fs::read_dir(&path)
            .map_err(|e| format!("{}: {e}", path.display()))?
            .map(|e| {
                e.map(|e| e.path())
                    .map_err(|e| format!("{}: {e}", path.display()))
            })
            .collect::<Result<Vec<_>, String>>()?;
        paths.retain(|p| p.extension().and_then(|e| e.to_str()) == Some("yaml"));
        // Sorted, because a directory listing is not ordered and the frame's
        // byte order must be a function of the tree alone (invariant 9). This
        // mirrors `load::yaml_files`, which sorts for the same reason.
        paths.sort();
        for p in paths {
            let name = p
                .file_name()
                .ok_or_else(|| format!("{}: no file name", p.display()))?
                .to_string_lossy()
                .into_owned();
            let source =
                std::fs::read_to_string(&p).map_err(|e| format!("{}: {e}", p.display()))?;
            out.push(SourceFile {
                section,
                name,
                source,
            });
        }
    }
    if out.is_empty() {
        return Err(format!(
            "{}: no corpus bundles found; the artifact would ship a finder with nothing in it",
            root.display()
        ));
    }
    Ok(out)
}

/// The packed `OP_INIT` frame for the checked-in corpus.
pub fn frame(workspace_root: &Path) -> Result<Vec<u8>, String> {
    let files = sources(workspace_root)?;
    let frame = pack_corpus(&files);
    verify(&frame)?;
    Ok(frame)
}

/// Run the frame through the module's own `OP_INIT`, on the host, and refuse a
/// frame the module will not accept.
///
/// This is the gate that makes the splice honest. Without it the only thing
/// asserting that the shipped corpus parses is a test over the *directory*, and
/// the artifact ships the *frame* — one encode step apart, which is exactly
/// where a length prefix or a section byte would go wrong silently.
fn verify(frame: &[u8]) -> Result<(), String> {
    let reply = Shell::new().handle(OP_INIT, frame);
    if reply.is_empty() {
        return Ok(());
    }
    match fathom_wasm::protocol::decode_reply(&reply) {
        Ok(fathom_wasm::protocol::ReplyView::Error(e)) => Err(format!(
            "the corpus does not load through OP_INIT: code {} · {}",
            e.code, e.detail
        )),
        other => Err(format!(
            "OP_INIT answered something other than success or a typed error: {other:?}"
        )),
    }
}
