//! One `ProvenanceRecord` per assertion (WO-09 §4.5, §12 item 3).
//!
//! `11` §8.2 calls the record *"One immutable assertion record"*. It is never
//! shared between two assertions here, even where one `set` statement wrote
//! several fields: `Graph::check_prov` fills `supersedes` from the slot's
//! current provenance, so a shared id whose second use lands on an
//! already-written slot is refused as `ProvenanceIdReused`. Sharing is safe
//! only while a first application writes each field exactly once, which is
//! precisely the property reconciliation removes.
//!
//! `supersedes` is always `None` on the way in — the store owns it
//! (`11` §8.6), and a caller that fills it is refused rather than believed.
//!
//! The module is public because WO-09 §4.1 names it; it exports nothing. Every
//! constructor below is crate-private, which is what keeps the record shape a
//! property of the weld rather than of its callers.

use fathom_graph::{CaptureId, CaptureSpan, Confidence, Origin, ProvenanceId, ProvenanceRecord};

use crate::mint::{Mint, MintError};
use crate::Manifest;

/// The shape all three constructors share: a fresh id off the mint, the
/// manifest's clock and actor, and `Origin::Parsed` over one capture span.
fn record(
    mint: &mut Mint,
    manifest: &Manifest<'_>,
    capture: CaptureId,
    span: CaptureSpan,
    confidence: Confidence,
) -> Result<ProvenanceRecord, MintError> {
    Ok(ProvenanceRecord {
        id: ProvenanceId(mint.next()?),
        origin: Origin::Parsed { capture, span },
        asserted_at: manifest.at,
        asserted_by: manifest.actor,
        confidence,
        supersedes: None,
    })
}

/// Why a node or an edge exists at all (`11` §8.1). `Asserted`: the statement
/// that named the object observed it directly (`11` §8.3).
pub(crate) fn existence(
    mint: &mut Mint,
    manifest: &Manifest<'_>,
    capture: CaptureId,
    span: CaptureSpan,
) -> Result<ProvenanceRecord, MintError> {
    record(mint, manifest, capture, span, Confidence::Asserted)
}

/// One field assertion the capture states outright. Same confidence as
/// `existence`, and deliberately a separate constructor: the two answer
/// different questions in `11` §8.1 and only their current shape coincides.
pub(crate) fn field(
    mint: &mut Mint,
    manifest: &Manifest<'_>,
    capture: CaptureId,
    span: CaptureSpan,
) -> Result<ProvenanceRecord, MintError> {
    record(mint, manifest, capture, span, Confidence::Asserted)
}

/// A value no statement says, which follows necessarily from the ones that do
/// (`11` §8.3's `Derived`). `Device.platform` is the only one this WO writes:
/// the dictionary that parsed the capture names the platform, no line does.
pub(crate) fn derived(
    mint: &mut Mint,
    manifest: &Manifest<'_>,
    capture: CaptureId,
    span: CaptureSpan,
) -> Result<ProvenanceRecord, MintError> {
    record(mint, manifest, capture, span, Confidence::Derived)
}
