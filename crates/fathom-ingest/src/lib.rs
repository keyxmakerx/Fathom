//! fathom-ingest: paste in, typed graph fragment out — one platform
//! (`junos-srx`, set form), the first half of `14`'s on-ramp (WO-03).
//!
//! The governing rule, quoted once from `14`'s preamble register and binding
//! on every stage below:
//!
//! ```text
//! NOTHING PARSED IS SILENTLY LOST, AND NOTHING SECRET IS EVER KEPT
//! ```
//!
//! Six stages, in this order and no other (`14` §2.1, §9.1):
//! frame → lex → shape → **redact** → bind → resolve. The gate sits at stage
//! four because that is where invariant 3 is either true or a slogan: nothing
//! that outlives the call has ever seen pre-redaction text.
//!
//! Deliberately outside this crate: device identification, reconciliation,
//! applying the fragment to a store, ULID minting, emitters, explainers,
//! findings, and every syntactic family WO-03 §4.1 defers.

#![forbid(unsafe_code)]
#![deny(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

pub mod bind;
pub mod dict;
pub mod frame;
pub mod hosted;
pub mod lex;
pub mod redact;
pub mod shape;

/// 14 §11.4's refusal caps: refuse before processing, never OOM mid-way.
pub const MAX_PASTE_BYTES: usize = 32 * 1024 * 1024;
pub const MAX_PASTE_LINES: usize = 250_000;

/// Total for every input within the caps (14 §8.2). The only two refusals,
/// both decided before any stage runs (14 §11.4).
pub fn ingest(paste: &[u8], dict: &dict::Dictionary) -> Result<IngestOutput, IngestRefusal> {
    let framed = frame::frame(paste)?;
    let mut capture = framed.capture.clone();
    let truncated = framed.truncated;

    // Stages 2 and 3: lex and shape every Statement line into one shared tree.
    let shaped = shape::shape(&capture, &framed);
    let mut tree = shaped.tree;
    let mut outcomes = shaped.outcomes;

    // Stage 3.5: the dictionary lookup, done once. The gate and the binder
    // read the same match, so a path the gate treated as secret-bearing can
    // never be a path the binder treated as something else.
    let matches = dict.match_statements(&tree, &shaped.stmts);

    // Stage 4: THE GATE (14 §9.1). Rewrites the capture, every recorded span
    // and the tree's redacted positions in one pass.
    let gated = redact::gate(
        &mut capture,
        &framed.lines,
        &mut tree,
        &mut outcomes,
        &shaped.stmts,
        &shaped.unshaped,
        &shaped.noise,
        &matches,
        dict,
    );

    // Stage 5 and 6: bind, then resolve deferred edges within the fragment.
    let bound = bind::bind(&tree, &shaped.stmts, &matches, dict, &mut outcomes);

    let mut ledger = frame::LineLedger {
        capture_len: 0,
        lines: Vec::new(),
    };
    frame::build_ledger(
        &mut ledger,
        &capture,
        &framed.lines,
        &gated.spans,
        &outcomes,
    );
    frame::assert_invariant_l(&ledger);

    let uses_groups = shape::uses_groups(&tree);

    let residue = ledger
        .lines
        .iter()
        .filter(|e| {
            matches!(
                e.outcome,
                frame::LineOutcome::Unmapped { .. }
                    | frame::LineOutcome::Unshaped { .. }
                    | frame::LineOutcome::Quarantined { .. }
            )
        })
        .map(|e| ResidueEntry {
            ordinal: e.ordinal,
            span: e.span,
            outcome: e.outcome.clone(),
        })
        .collect();

    Ok(IngestOutput {
        capture: redact::RedactedCapture::seal(capture),
        ledger,
        residue,
        drops: gated.drops,
        fragment: bound,
        scope: CaptureScope::Fragment,
        uses_groups,
        truncated,
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IngestRefusal {
    /// Not UTF-8; offset of the first bad byte (14 §4.2 step 2, cp1252
    /// fallback deferred — §12 item 5).
    Undecodable {
        offset: usize,
    },
    TooLarge {
        bytes: usize,
        lines: usize,
    },
}

/// 14 §7.4's computation is deferred; this slice never asserts absence, so
/// the conservative value is pinned (§12 item 6).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CaptureScope {
    Fragment,
}

#[derive(Debug)]
pub struct IngestOutput {
    pub capture: redact::RedactedCapture,
    pub ledger: frame::LineLedger,
    /// Every ledger entry whose outcome is Unmapped, Unshaped or Quarantined,
    /// in ordinal order (14 §8.5). First-class: callers persist this, they do
    /// not recompute it.
    pub residue: Vec<ResidueEntry>,
    pub drops: redact::DropManifest,
    pub fragment: bind::Fragment,
    pub scope: CaptureScope,
    /// 14 §5.1's group DECISION, detect half: any statement whose first path
    /// segment is `groups` or `apply-groups`.
    pub uses_groups: bool,
    /// A pagination marker was seen (14 §4.4's last row).
    pub truncated: bool,
}

#[derive(Debug, Clone)]
pub struct ResidueEntry {
    pub ordinal: frame::LineOrdinal,
    pub span: frame::ByteSpan,
    pub outcome: frame::LineOutcome,
}
