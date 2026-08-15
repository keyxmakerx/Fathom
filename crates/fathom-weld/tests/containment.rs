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

/// G5. All 49 × 49 = 2,401 pairs: no pair is carried by two containment edge
/// kinds, and `containment_edge` returns exactly what an independent scan of
/// the same tables returns.
///
/// The pair count this pins is 47, not WO-09 §3's 51: the five
/// root-containment kinds (`HasTunnel`, `HasPremises`, `HasCable`,
/// `HasTenant`, `HasServiceType`) declare `from: [root]`, and the workspace
/// root is not a node kind, so `from_kinds()` is empty for each and no
/// (NodeKind, NodeKind) pair names them. 52 − 5 = 47.
///
/// ADR-0035 moved this by exactly one: `HasRack` (`Premises -> Rack`) is the
/// 52nd containment kind and the 47th resolvable pair. `MountedIn` is NOT
/// here and must never be — it is a `reference`, because `Chassis` already
/// has a containment parent (`Device`) and this test's own `<= 1` property is
/// what would have caught the mistake of making a rack contain a box.
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
    assert_eq!(resolved, 47, "the containment pair set moved");

    // The 42 containment kinds are all still containment kinds, and every
    // kind but `LearnedRoute` and `Site` is somebody's containment child.
    let containment = EdgeKind::ALL
        .into_iter()
        .filter(|k| k.class() == EdgeClass::Containment)
        .count();
    assert_eq!(containment, 42);
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
