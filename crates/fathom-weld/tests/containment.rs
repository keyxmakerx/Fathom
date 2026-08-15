//! The containment lookup, proved from the generated tables (WO-09 §4.6, G5).
//!
//! `containment_edge` is the one place the weld turns a `FragNode.owner` into
//! a schema-declared edge kind. ADR-0008 forbids a hand-written table, so the
//! function scans `fathom-ir`'s generated const tables; these tests re-prove
//! over every kind pair that the scan is unambiguous, rather than trusting the
//! paragraph in WO-09 §3 that says so.

use fathom_ir::generated::ir_types::{EdgeClass, EdgeKind, NodeKind};
use fathom_weld::containment_edge;

/// Every containment edge kind that admits this exact (owner, child) pair,
/// computed here rather than read from the crate under test.
fn admitting(owner: NodeKind, child: NodeKind) -> Vec<EdgeKind> {
    EdgeKind::ALL
        .into_iter()
        .filter(|k| {
            k.class() == EdgeClass::Containment
                && k.from_kinds().contains(&owner)
                && k.to_kinds().contains(&child)
        })
        .collect()
}

/// G5. All 48 × 48 = 2,304 pairs: no pair is carried by two containment edge
/// kinds, and `containment_edge` returns exactly what an independent scan of
/// the same tables returns.
///
/// The pair count this pins is 46, not WO-09 §3's 51: the five
/// root-containment kinds (`HasTunnel`, `HasPremises`, `HasCable`,
/// `HasTenant`, `HasServiceType`) declare `from: [root]`, and the workspace
/// root is not a node kind, so `from_kinds()` is empty for each and no
/// (NodeKind, NodeKind) pair names them. 51 − 5 = 46.
#[test]
fn every_kind_pair_has_at_most_one_containment_edge() {
    let mut resolved = 0usize;
    for owner in NodeKind::ALL {
        for child in NodeKind::ALL {
            let found = admitting(owner, child);
            assert!(
                found.len() <= 1,
                "({}, {}) is carried by {} containment edge kinds: {:?}",
                owner.name(),
                child.name(),
                found.len(),
                found.iter().map(|k| k.name()).collect::<Vec<_>>()
            );
            assert_eq!(
                containment_edge(owner, child),
                found.first().copied(),
                "containment_edge disagrees with the tables on ({}, {})",
                owner.name(),
                child.name()
            );
            if !found.is_empty() {
                resolved += 1;
            }
        }
    }
    assert_eq!(resolved, 46, "the containment pair set moved");

    // The 41 containment kinds are all still containment kinds, and every
    // kind but `LearnedRoute` and `Site` is somebody's containment child.
    let containment = EdgeKind::ALL
        .into_iter()
        .filter(|k| k.class() == EdgeClass::Containment)
        .count();
    assert_eq!(containment, 41);
    let orphans: Vec<&str> = NodeKind::ALL
        .into_iter()
        .filter(|child| {
            NodeKind::ALL
                .into_iter()
                .all(|owner| containment_edge(owner, *child).is_none())
        })
        .map(|k| k.name())
        .collect();
    assert_eq!(
        orphans,
        vec![
            "Site",
            "LearnedRoute",
            "Tunnel",
            "Cable",
            "Premises",
            "Tenant",
            "ServiceType"
        ],
        "the set of kinds no node kind contains moved"
    );
}

/// WO-09 §3's eleven rows, by name: every (owner kind, child kind) pair this
/// slice's dictionary can produce resolves, so a fragment from the shipped
/// dictionary can never reach `WeldError::NoContainmentEdge`.
#[test]
fn the_dictionary_pairs_resolve() {
    let cases: &[(NodeKind, NodeKind, EdgeKind)] = &[
        (
            NodeKind::Device,
            NodeKind::IkeProposal,
            EdgeKind::HasIkeProposal,
        ),
        (
            NodeKind::Device,
            NodeKind::IkePolicy,
            EdgeKind::HasIkePolicy,
        ),
        (
            NodeKind::Device,
            NodeKind::IkeGateway,
            EdgeKind::HasIkeGateway,
        ),
        (
            NodeKind::Device,
            NodeKind::IpsecProposal,
            EdgeKind::HasIpsecProposal,
        ),
        (
            NodeKind::Device,
            NodeKind::IpsecPolicy,
            EdgeKind::HasIpsecPolicy,
        ),
        (NodeKind::Device, NodeKind::IpsecVpn, EdgeKind::HasIpsecVpn),
        (
            NodeKind::IpsecVpn,
            NodeKind::TrafficSelector,
            EdgeKind::HasTrafficSelector,
        ),
        (NodeKind::Device, NodeKind::Zone, EdgeKind::HasZone),
        (
            NodeKind::Device,
            NodeKind::Interface,
            EdgeKind::HasInterface,
        ),
        (
            NodeKind::Device,
            NodeKind::AggregateInterface,
            EdgeKind::HasInterface,
        ),
        (
            NodeKind::Device,
            NodeKind::RethInterface,
            EdgeKind::HasInterface,
        ),
        (
            NodeKind::Device,
            NodeKind::TunnelInterface,
            EdgeKind::HasInterface,
        ),
        (
            NodeKind::Interface,
            NodeKind::LogicalUnit,
            EdgeKind::HasUnit,
        ),
        (
            NodeKind::AggregateInterface,
            NodeKind::LogicalUnit,
            EdgeKind::HasUnit,
        ),
        (
            NodeKind::RethInterface,
            NodeKind::LogicalUnit,
            EdgeKind::HasUnit,
        ),
        (
            NodeKind::TunnelInterface,
            NodeKind::LogicalUnit,
            EdgeKind::HasUnit,
        ),
        (
            NodeKind::LogicalUnit,
            NodeKind::Address,
            EdgeKind::HasAddress,
        ),
    ];
    for (owner, child, want) in cases {
        assert_eq!(
            containment_edge(*owner, *child),
            Some(*want),
            "({}, {}) should resolve to {}",
            owner.name(),
            child.name(),
            want.name()
        );
    }

    // The negative half: a pair the schema declares no containment for.
    assert_eq!(containment_edge(NodeKind::Zone, NodeKind::Device), None);
    assert_eq!(containment_edge(NodeKind::Device, NodeKind::Site), None);
}

/// The gap the hand-maintained list above left open, closed by derivation.
///
/// `the_dictionary_pairs_resolve` is a list a human keeps in step with the
/// dictionary, and on 2026-08-15 a human did not: a new `system ntp server`
/// entry owned `NtpServer` off `Device`, when `HasNtpServer` runs
/// `SystemSettings -> NtpServer`. It compiled, it loaded, every unit test
/// passed, and it failed in the browser on the first real paste with
/// `NoContainmentEdge { owner: Device, child: NtpServer }`.
///
/// This test does not maintain a list. It runs the shipped dictionary over a
/// documented branch configuration and asserts that every (owner kind, child
/// kind) pair the resulting fragment actually contains resolves to a
/// containment edge. A new dictionary entry with the wrong owner now fails at
/// `cargo test`, which is where it should have failed the first time.
///
/// The fixture is the coverage fixture, deliberately: it is the widest paste
/// in the repo, so it exercises the most owner pairs. Reaching across crates
/// for it is cheaper than keeping a second copy in step with the first.
#[test]
fn every_owner_pair_the_shipped_dictionary_produces_resolves() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .nth(2)
        .expect("the crate lives two levels under the repo root")
        .to_path_buf();
    let dict = fathom_ingest::dict::Dictionary::load(&root).expect("the shipped dictionary loads");
    let paste = std::fs::read(
        root.join("crates/fathom-ingest/tests/fixtures/junos-srx-branch-documented.txt"),
    )
    .expect("the branch fixture is on disk");
    let out = fathom_ingest::ingest(&paste, &dict).expect("within the caps");

    let mut pairs: Vec<(NodeKind, NodeKind)> = Vec::new();
    for node in &out.fragment.nodes {
        let Some(owner) = node.owner else { continue };
        let owner_kind = out
            .fragment
            .nodes
            .get(owner.0 as usize)
            .expect("an owner index inside the fragment")
            .kind;
        let pair = (owner_kind, node.kind);
        if !pairs.contains(&pair) {
            pairs.push(pair);
        }
    }
    for (owner, child) in &pairs {
        assert!(
            containment_edge(*owner, *child).is_some(),
            "the dictionary produces ({}, {}) and no containment edge carries it",
            owner.name(),
            child.name()
        );
    }

    // The set is pinned as well as checked. Six is small because most of what
    // a paste builds is a TOP-LEVEL object — a Zone, an IkeGateway, a Vlan —
    // which the fragment leaves with `owner: None` for the weld to attach to
    // the device. Only genuine nesting appears here. Pinning it means a
    // widening that adds a nested kind has to say so in this diff.
    let mut named: Vec<String> = pairs
        .iter()
        .map(|(o, c)| format!("{}->{}", o.name(), c.name()))
        .collect();
    named.sort();
    assert_eq!(
        named,
        vec![
            "Device->SecurityFlowSettings",
            "Device->SystemSettings",
            "Interface->LogicalUnit",
            "LogicalUnit->Address",
            "SystemSettings->NtpServer",
            "TunnelInterface->LogicalUnit",
        ],
        "the nested-kind set the shipped dictionary produces moved"
    );
}
