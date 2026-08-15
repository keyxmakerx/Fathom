//! The synthetic junos-srx fixture, end to end (WO-03 §4.9, §6.1).
//!
//! The fixture is **synthetic** — assembled from the command corpus, the SRX
//! field card and `14`'s own framing devices, in documentation address ranges
//! only (`61` §6.4). When the owner's S0 exports land, a follow-up work order
//! re-pins these counts with a Disagreements entry (WO-03 §10 item 8).
//!
//! The counts below are load-bearing: a later change to fixture, dictionary
//! or pipeline that moves one of them needs a §12 Disagreements entry stating
//! old → new and why, in the PR that moves it.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use fathom_ingest::bind::{BoundValue, PendingTarget};
use fathom_ingest::dict::Dictionary;
use fathom_ingest::frame::{LineOutcome, NoiseClass, ShapeError};
use fathom_ingest::redact::RedactLabel;
use fathom_ingest::{ingest, IngestOutput};

use fathom_ir::generated::ir_types::{EdgeKind, NodeKind};
use fathom_ir::scalar::{Identifier, Scalar};

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .nth(2)
        .expect("the crate lives two levels under the repo root")
        .to_path_buf()
}

fn fixture() -> Vec<u8> {
    std::fs::read(
        Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/junos-srx-s0-synthetic.txt"),
    )
    .expect("the fixture is checked in")
}

fn run() -> IngestOutput {
    let dict = Dictionary::load(&repo_root()).expect("the shipped dictionary loads");
    ingest(&fixture(), &dict).expect("the fixture is within the caps")
}

/// **Invariant L** (`14` §4.6, quoted by WO-03 §2): the ledger's spans, plus
/// the single-byte separators between them, tile `[0, capture_len)` exactly —
/// no gaps, no overlaps. This is what makes *"nothing is silently lost"* an
/// arithmetic identity instead of a promise.
#[test]
fn fixture_ledger_tiles() {
    let out = run();
    let mut cursor = 0u32;
    for (idx, entry) in out.ledger.lines.iter().enumerate() {
        let want = if idx == 0 { cursor } else { cursor + 1 };
        assert_eq!(entry.span.start, want, "gap or overlap at line {idx}");
        assert!(entry.span.end >= entry.span.start);
        cursor = entry.span.end;
    }
    assert_eq!(cursor, out.ledger.capture_len);
    assert_eq!(out.ledger.capture_len as usize, out.capture.text().len());
}

/// WO-03 §4.9's expected-outcome table, line by line. A divergence here is a
/// defect in the design, not a test to adjust (§7 trigger 5).
#[test]
fn fixture_outcome_classes() {
    let out = run();
    let at = |n: usize| out.ledger.lines[n].outcome.clone();

    // The `# SYNTHETIC FIXTURE` header §4.9 requires is not a Junos verb, so
    // it is residue rather than something silently skipped: the framer has no
    // comment class because `display set` output has none.
    assert_eq!(
        at(0),
        LineOutcome::Unshaped {
            reason: ShapeError::NotVerbInitial
        }
    );
    assert_eq!(
        at(1),
        LineOutcome::Noise {
            class: NoiseClass::ClusterBanner
        }
    );
    assert_eq!(
        at(2),
        LineOutcome::Noise {
            class: NoiseClass::CommandEcho
        }
    );
    assert_eq!(
        at(16),
        LineOutcome::Noise {
            class: NoiseClass::Pagination
        }
    );
    assert!(out.truncated, "a pagination marker truncates the capture");
    assert_eq!(
        at(39),
        LineOutcome::Noise {
            class: NoiseClass::ClusterBanner
        }
    );
    assert_eq!(
        at(40),
        LineOutcome::Noise {
            class: NoiseClass::Prompt
        }
    );

    // The backslash continuation is one logical line, and dead-peer-detection
    // is deliberately not bindable in this slice (§4.7).
    assert_eq!(at(15), LineOutcome::Unmapped { known_prefix: 4 });
    // `security idp` is understood as far as `security`; routing-options not
    // at all (`14` §8.3's own worked pair).
    assert_eq!(at(31), LineOutcome::Unmapped { known_prefix: 1 });
    assert_eq!(at(32), LineOutcome::Unmapped { known_prefix: 0 });
    // Secret-only entries catalogue without modelling: residue, with a drop.
    assert_eq!(at(33), LineOutcome::Unmapped { known_prefix: 3 });
    assert_eq!(at(34), LineOutcome::Unmapped { known_prefix: 3 });
    assert_eq!(at(35), LineOutcome::Unmapped { known_prefix: 5 });
    // `14` §9.7's hard case: a secret in a line we did not understand.
    assert!(matches!(
        at(36),
        LineOutcome::Quarantined {
            label: RedactLabel::Unknown,
            ..
        }
    ));
    assert_eq!(at(38), LineOutcome::Blank);

    // Every remaining statement line bound.
    for idx in (3..=14).chain(17..=30).chain([37]) {
        assert!(
            matches!(at(idx), LineOutcome::Bound { .. }),
            "line {idx} did not bind: {:?}",
            at(idx)
        );
    }
    // The pre-redacted PSK is idempotent with the ascii-text line's, so it
    // adds no field (`14` §9.6).
    assert!(matches!(at(37), LineOutcome::Bound { fields: 0, .. }));
}

/// WO-03 §6.1's pinned counts.
#[test]
fn fixture_counts_pinned() {
    let out = run();
    assert_eq!(fixture().iter().filter(|b| **b == b'\n').count() + 1, 43);
    assert_eq!(out.ledger.lines.len(), 42);

    let mut classes: BTreeMap<&str, usize> = BTreeMap::new();
    for entry in &out.ledger.lines {
        let name = match entry.outcome {
            LineOutcome::Bound { .. } => "Bound",
            LineOutcome::Unmapped { .. } => "Unmapped",
            LineOutcome::Unshaped { .. } => "Unshaped",
            LineOutcome::Noise { .. } => "Noise",
            LineOutcome::Blank => "Blank",
            LineOutcome::Quarantined { .. } => "Quarantined",
            // Only `csv.rs` produces this, and this fixture is `set` form.
            // Counted rather than ignored: if a Junos paste ever produced a
            // header row, the assertion below would fail and say so.
            LineOutcome::Header { .. } => "Header",
        };
        *classes.entry(name).or_default() += 1;
    }
    assert_eq!(classes.get("Bound"), Some(&27));
    assert_eq!(classes.get("Unmapped"), Some(&6));
    assert_eq!(classes.get("Unshaped"), Some(&1));
    assert_eq!(classes.get("Quarantined"), Some(&1));
    assert_eq!(classes.get("Noise"), Some(&5));
    assert_eq!(classes.get("Blank"), Some(&2));
    assert_eq!(out.residue.len(), 8, "Unmapped + Unshaped + Quarantined");

    assert_eq!(out.fragment.nodes.len(), 13);
    let mut kinds: BTreeMap<&str, usize> = BTreeMap::new();
    for node in &out.fragment.nodes {
        *kinds.entry(node.kind.name()).or_default() += 1;
    }
    assert_eq!(kinds.get("Device"), Some(&1));
    assert_eq!(kinds.get("IkeProposal"), Some(&1));
    assert_eq!(kinds.get("IkePolicy"), Some(&1));
    assert_eq!(kinds.get("IkeGateway"), Some(&1));
    assert_eq!(kinds.get("IpsecProposal"), Some(&1));
    assert_eq!(kinds.get("IpsecPolicy"), Some(&1));
    assert_eq!(kinds.get("IpsecVpn"), Some(&1));
    assert_eq!(kinds.get("TrafficSelector"), Some(&1));
    assert_eq!(kinds.get("TunnelInterface"), Some(&1));
    assert_eq!(kinds.get("LogicalUnit"), Some(&1));
    assert_eq!(kinds.get("Address"), Some(&1));
    assert_eq!(kinds.get("Zone"), Some(&2));
    assert_eq!(kinds.len(), 12);

    assert_eq!(out.fragment.edges.len(), 7);
    let mut edges: BTreeMap<&str, usize> = BTreeMap::new();
    for edge in &out.fragment.edges {
        *edges.entry(edge.kind.name()).or_default() += 1;
    }
    assert_eq!(edges.get("UsesProposal"), Some(&2));
    assert_eq!(edges.get("UsesIkePolicy"), Some(&1));
    assert_eq!(edges.get("UsesIkeGateway"), Some(&1));
    assert_eq!(edges.get("UsesIpsecPolicy"), Some(&1));
    assert_eq!(edges.get("BindsInterface"), Some(&1));
    assert_eq!(edges.get("ZoneMember"), Some(&1));
    assert_eq!(edges.len(), 6);

    // Both pending edges point at the same unmodelled reth0.0 — the paste
    // never defined it, which is not an error (`14` §7.3).
    assert_eq!(out.fragment.pending.len(), 2);
    let target = PendingTarget::InterfaceUnit {
        kind: NodeKind::RethInterface,
        name: Identifier("reth0".to_owned()),
        unit: 0,
    };
    assert_eq!(out.fragment.pending[0].kind, EdgeKind::ExternalInterface);
    assert_eq!(out.fragment.pending[0].target, target);
    assert_eq!(out.fragment.pending[1].kind, EdgeKind::ZoneMember);
    assert_eq!(out.fragment.pending[1].target, target);

    assert_eq!(out.drops.entries.len(), 5);
    let mut labels: BTreeMap<&str, usize> = BTreeMap::new();
    for drop in &out.drops.entries {
        *labels.entry(drop.label.token()).or_default() += 1;
    }
    assert_eq!(labels.get("psk"), Some(&1));
    assert_eq!(labels.get("snmp-community"), Some(&2));
    assert_eq!(labels.get("tacacs-key"), Some(&1));
    assert_eq!(labels.get("unknown"), Some(&1));
    assert_eq!(labels.len(), 4);

    assert_eq!(out.drops.already_redacted.len(), 1);
    assert!(!out.uses_groups);
}

/// Spot assertions on the fragment's shape (WO-03 §5 step 10).
#[test]
fn fixture_fragment_shape() {
    let out = run();
    let node = |kind: NodeKind| {
        out.fragment
            .nodes
            .iter()
            .find(|n| n.kind == kind)
            .unwrap_or_else(|| panic!("no {kind:?} node"))
    };

    // The vendor token `group14` normalises through the platform token map
    // into the platform-independent canonical `14`.
    let dh = node(NodeKind::IkeProposal)
        .fields
        .iter()
        .find_map(|f| match &f.value {
            BoundValue::DhGroup(g) => Some(g.canonical()),
            _ => None,
        })
        .expect("IKE-P1 carries a dh_group");
    assert_eq!(dh, "14");

    // The PSK is a placeholder with a label, never a value: `SecretPlaceholder`
    // has no constructor from text (invariant 3 in the type system).
    let psk = node(NodeKind::IkePolicy)
        .fields
        .iter()
        .find_map(|f| match &f.value {
            BoundValue::Secret(s) => Some(s.label()),
            _ => None,
        })
        .expect("IKE-POL carries a pre_shared_key");
    assert_eq!(psk, fathom_ir::scalar::SecretLabel::Psk);

    // st0.0 was defined in the paste, so the zone edge resolved; reth0.0 was
    // not, so the WAN zone's edge is pending with its host-inbound service.
    let unit = out
        .fragment
        .nodes
        .iter()
        .position(|n| n.kind == NodeKind::LogicalUnit)
        .expect("st0.0 exists");
    let zone_member = out
        .fragment
        .edges
        .iter()
        .find(|e| e.kind == EdgeKind::ZoneMember)
        .expect("the VPN zone member resolved");
    assert_eq!(zone_member.to.0 as usize, unit);
    let wan = out
        .fragment
        .pending
        .iter()
        .find(|e| e.kind == EdgeKind::ZoneMember)
        .expect("the WAN zone member is pending");
    assert!(matches!(
        wan.fields.first().map(|f| &f.value),
        Some(BoundValue::HostServiceSet(_))
    ));

    // Containment is a chain of earlier indices, which is what lets the store
    // weld derive the Has* edges (§4.8 contract item 2).
    for (idx, n) in out.fragment.nodes.iter().enumerate() {
        if let Some(owner) = n.owner {
            assert!((owner.0 as usize) < idx, "owner chain is not acyclic");
        }
    }
    assert_eq!(out.fragment.nodes[0].kind, NodeKind::Device);
    assert_eq!(out.fragment.nodes[0].owner, None);
}
