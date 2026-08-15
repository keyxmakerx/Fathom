//! `14` §9.11's canary proof, in this slice's form.
//!
//! Every secret-bearing position in the fixture holds a distinctive canary.
//! The test serialises the entire `IngestOutput` — capture text, ledger,
//! residue, fragment and drop manifest in one sweep — and asserts the canary
//! appears nowhere. Not *"check the capture"*: the point is to catch the path
//! nobody thought of.

use std::path::{Path, PathBuf};

use fathom_ingest::bind::FragNodeId;
use fathom_ingest::dict::Dictionary;
use fathom_ingest::frame::{LineOutcome, ShapeError};
use fathom_ingest::redact::DetectorSet;
use fathom_ingest::{ingest, IngestOutput};

use fathom_ir::generated::ir_types::NodeKind;

const CANARY: &str = "FATHOMCANARY";

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .nth(2)
        .expect("the crate lives two levels under the repo root")
        .to_path_buf()
}

fn dict() -> Dictionary {
    Dictionary::load(&repo_root()).expect("the shipped dictionary loads")
}

fn fixture_run() -> IngestOutput {
    let text = std::fs::read(
        Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/junos-srx-s0-synthetic.txt"),
    )
    .expect("the fixture is checked in");
    ingest(&text, &dict()).expect("within the caps")
}

#[test]
fn no_canary_survives_anywhere() {
    let out = fixture_run();
    let serialised = format!("{out:?}");
    assert!(
        !serialised.contains(CANARY),
        "a canary survived into the ingest output"
    );
}

#[test]
fn pre_redacted_not_counted_as_drop() {
    let out = fixture_run();
    // The `hexadecimal "<REDACTED>"` line: the user redacted it themselves,
    // so it is recorded, bound, and not reported as a drop (`14` §9.6).
    assert_eq!(out.drops.already_redacted.len(), 1);
    let ordinal = out.drops.already_redacted[0];
    assert!(
        out.drops.entries.iter().all(|e| e.ordinal != ordinal),
        "a user pre-redaction was counted as a drop"
    );
    assert!(out.capture.text().contains("<REDACTED>"));
}

#[test]
fn quarantine_destroys_unshaped_secret_line() {
    let out = fixture_run();
    let (idx, orig_len) = out
        .ledger
        .lines
        .iter()
        .enumerate()
        .find_map(|(i, e)| match e.outcome {
            LineOutcome::Quarantined { orig_len, .. } => Some((i, orig_len)),
            _ => None,
        })
        .expect("the clipped head is quarantined");
    assert!(orig_len > 0, "the original length is recorded");
    let span = out.ledger.lines[idx].span;
    let sketch = &out.capture.text()[span.start as usize..span.end as usize];
    // The shape sketch: the first two tokens were not kept (`ecurity` is not
    // a known dictionary segment), so no character of any token survives.
    assert_eq!(
        sketch,
        "<word:7> <word:3> <word:6> <word:7> <word:14> <word:10> <quoted:21>"
    );
    for token in ["ecurity", "IKE-POL", "pre-shared-key", "ascii-text", CANARY] {
        assert!(!sketch.contains(token), "`{token}` survived the sketch");
    }
}

#[test]
fn pfs_keys_group_not_redacted() {
    let out = fixture_run();
    // `keys` is in the secret-word list; without `secret_exempt` the field
    // card's own PFS line would lose its DH group (§12 item 2).
    assert!(out
        .capture
        .text()
        .contains("perfect-forward-secrecy keys group14"));
    let bound = out
        .fragment
        .nodes
        .iter()
        .any(|n| n.kind == NodeKind::IpsecPolicy && n.fields.len() == 2);
    assert!(
        bound,
        "IPSEC-POL bound both name and perfect_forward_secrecy"
    );
}

/// §4.6's read-path proof: a bound entry's key capture that trips a
/// value-shape detector never reaches the fragment from pre-redaction text,
/// and the marker it was replaced by is not mistaken for a name.
#[test]
fn redacted_key_never_binds() {
    let out = ingest(
        b"set security ike gateway $9$FATHOMCANARY-F66666 ike-policy IKE-POL\n",
        &dict(),
    )
    .expect("within the caps");
    assert_eq!(
        out.ledger.lines[0].outcome,
        LineOutcome::Unshaped {
            reason: ShapeError::KeyUnparsable
        }
    );
    assert!(
        !out.fragment
            .nodes
            .iter()
            .any(|n| n.kind == NodeKind::IkeGateway),
        "a redacted key minted a node"
    );
    assert_eq!(out.fragment.nodes.len(), 1, "only the root Device");
    assert_eq!(out.fragment.nodes[0].owner, None);
    assert_eq!(out.drops.entries.len(), 1);
    assert!(
        out.drops.entries[0].detectors.0 & DetectorSet::CRYPT_PREFIX != 0,
        "the crypt-prefix detector is what caught it"
    );
    assert!(!format!("{out:?}").contains(CANARY));
    // The line bound nothing, so the ledger names no node.
    assert!(!matches!(
        out.ledger.lines[0].outcome,
        LineOutcome::Bound {
            node: FragNodeId(_),
            ..
        }
    ));
}

/// The hole a partial dictionary entry opened in the leaf-name detector,
/// pinned so it cannot reopen.
///
/// When a statement matched an entry, the leaf-name walk ran over the ENTRY's
/// path. For a `partial: true` entry that stops short of the line, the tail of
/// the line was outside that path — so a secret word appearing only in the
/// tail was invisible to the detector, and the credential after it survived
/// with the entry's own detectors saying nothing about it.
///
/// The shipped `security zones security-zone <z> interfaces <unit>` entry is
/// six segments and `partial`, so the line below matches it, and the walk saw
/// a path ending in `interfaces` rather than the word `secret` one token
/// before the value. The fix unions the raw-line walk in for tokens past the
/// end of the matched entry's path.
///
/// The statement is not valid Junos and is not meant to be: the point is that
/// the gate must not depend on the dictionary having modelled the stanza. The
/// whole class of unmodelled sub-statement is what `14` §9.4's safety net is
/// for, and a dictionary match must not switch it off.
#[test]
fn a_secret_word_in_an_unmodelled_tail_is_still_caught() {
    let line = b"set security zones security-zone Z interfaces ge-0/0/0.0 \
                 vendor-extension secret FATHOMCANARY-TAIL-99999\n";
    let out = ingest(line, &dict()).expect("within the caps");
    let serialised = format!("{out:?}");
    assert!(
        !serialised.contains(CANARY),
        "a credential in an unmodelled tail survived the gate: {serialised}"
    );
    assert!(
        !out.drops.entries.is_empty(),
        "the gate recorded no drop for the tail credential"
    );
    assert!(
        out.drops
            .entries
            .iter()
            .any(|e| e.detectors.0 & DetectorSet::LEAF_NAME != 0),
        "the leaf-name detector is what should have caught it, got {:?}",
        out.drops.entries
    );
}
