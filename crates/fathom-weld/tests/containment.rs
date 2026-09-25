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

/// G5. All 54 × 54 = 2,916 pairs: no pair is carried by two containment edge
/// kinds, and `containment_edge` returns exactly what an independent scan of
/// the same tables returns.
///
/// The pair count this pins is 104, and it is 51 real containment pairs plus
/// 53 `HasLayoutPin` pairs.
///
/// **51** is every non-root containment edge kind's own pairs, one bucket:
/// the five root-containment kinds (`HasTunnel`, `HasPremises`, `HasCable`,
/// `HasTenant`, `HasServiceType`) declare `from: [root]`, and the workspace
/// root is not a node kind, so `from_kinds()` is empty for each and no
/// (NodeKind, NodeKind) pair names them — that is where 51 (WO-09 §3) becomes
/// 46. ADR-0036 adds `HasRack` (`Premises -> Rack`), WO-10 adds `HasDhcpRelay`
/// (`Device -> DhcpRelay`), ADR-0050 adds `FittedIn` (`Chassis ->
/// PowerSupply`) — 46 + 3 = 49. ADR-0051 §1 adds `HasSurface` (`Premises ->
/// Surface`) — 49 + 1 = 50. ADR-0052 §3 adds `HasCapture` (`Device ->
/// Capture`) — 50 + 1 = 51. `MountedIn` is NOT here and must never be — it is
/// a `reference`, because `Chassis` already has a containment parent
/// (`Device`) and this test's own `<= 1` property is what would have caught
/// the mistake of making a rack contain a box. `FittedIn` IS here, unlike
/// `MountedIn`: `PowerSupply` has no competing containment parent, so nothing
/// forces it to be a reference the way `Chassis` is forced. `SitsOn` and
/// `FixedTo` are NOT here for the identical reason `MountedIn` is not: both
/// are `reference` edges, because the `Chassis` or `PassiveNode` they seat or
/// fix already has a real containment parent (`HasChassis` or
/// `HasPassiveNode`).
///
/// **53** is `HasLayoutPin` (ADR-0035), whose `from:` is the `Placeable` class —
/// every kind but `LayoutPin` itself, which is 53 once `Capture` joins the
/// class (ADR-0052 §3) atop `Surface` (ADR-0051 §1), `PowerSupply` (ADR-0050),
/// `Rack` (ADR-0036) and `DhcpRelay` (WO-10). One edge kind, fifty-three pairs,
/// all with the same child. That is what makes a position storable on
/// anything the diagram draws without fifty-one edge declarations, and the
/// count moving by exactly the kind count is the arithmetic to check if it
/// ever moves again.
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
    // 96 -> 98 on 2026-08-29 (WO-10, schema 0.5), and the second one is the
    // one to notice: `HasDhcpRelay` adds (Device, DhcpRelay), and joining the
    // `Placeable` class adds (DhcpRelay, LayoutPin) through `HasLayoutPin` —
    // every placeable kind owns its own pin, so a new kind costs TWO pairs
    // here, never one. A count that moved by one would mean the kind was
    // declared but left out of the class, which is exactly the drift
    // `shipped_tree.rs::every_kind_but_the_pin_itself_is_placeable` guards.
    //
    // 98 -> 100 on 2026-09-16 (ADR-0050, schema 0.7), the same shape of move
    // again: `FittedIn` adds (Chassis, PowerSupply) — CONTAINMENT, unlike
    // `MountedIn`, because `PowerSupply` has no other containment parent to
    // conflict with, unlike `Chassis` — and joining `Placeable` adds
    // (PowerSupply, LayoutPin) through `HasLayoutPin`. Two pairs for one new
    // kind, the same arithmetic WO-10 established.
    //
    // 100 -> 101 the same day: `HasPort`'s own `from` list gains
    // `PowerSupply`, which the `PortHost` class already named — a supply
    // hosts its inlet port (ADR-0050 §4) — adding (PowerSupply, PhysicalPort).
    //
    // 101 -> 103 on 2026-09-18 (ADR-0051 §1, schema 0.8), the same shape of
    // move WO-10 and ADR-0050 both made: `HasSurface` adds (Premises,
    // Surface) — CONTAINMENT, in the manner of `HasRack` — and joining
    // `Placeable` adds (Surface, LayoutPin) through `HasLayoutPin`. `SitsOn`
    // and `FixedTo` add nothing here: both are REFERENCE edges, `MountedIn`'s
    // own shape, because the `Chassis` or `PassiveNode` they name already has
    // a real containment parent.
    //
    // 103 -> 105 on 2026-09-18 (ADR-0052 §3, schema 0.9), the same shape of
    // move again: `HasCapture` adds (Device, Capture) — CONTAINMENT, in the
    // manner of `HasChassis` — and joining `Placeable` adds (Capture,
    // LayoutPin) through `HasLayoutPin`.
    // 105 -> 109 on 2026-09-19 (ADR-0053, schema 0.10): `HasNote` from the
    // `Notable` class resolves to three pairs (Device, PhysicalPort, Rack)
    // -> Note, and `Note` joining `Placeable` adds (Note, LayoutPin).
    //
    // 109 -> 115 (ADR-0058, schema 0.11): `HasContainerNetwork`
    // (Device -> ContainerNetwork), `HasContainer` (Device -> Container) and
    // `HasPublishedPort` (Container -> PublishedPort) each add one pair — +3
    // — and joining `Placeable` adds three more (ContainerNetwork, Container,
    // PublishedPort) -> LayoutPin through `HasLayoutPin` — +3. `AttachedTo`
    // and `ParentUnit` are NOT here for `MountedIn`'s reason: both
    // targets (`ContainerNetwork`, `LogicalUnit`) already have a real
    // containment parent, so both are `reference`.
    assert_eq!(resolved, 115, "the containment pair set moved");

    // The 43 containment kinds are all still containment kinds, and every
    // kind but `LearnedRoute` and `Site` is somebody's containment child.
    // `LayoutPin` is not among the orphans: it is contained by whatever it
    // places, which is what makes `Graph::tombstone` take a pin away with the
    // box it was pinning (ADR-0035). Nor is `Rack`: `HasRack` (ADR-0036) is the
    // 43rd containment kind (42 + 1) and `Premises` is its owner, so a
    // rack goes when the premises does. `MountedIn` is a REFERENCE and is
    // deliberately not counted here — tombstoning a rack must not take the
    // chassis standing in it.
    let containment = EdgeKind::ALL
        .into_iter()
        .filter(|k| k.class() == EdgeClass::Containment)
        .count();
    // 44 as of 2026-08-29: `HasDhcpRelay` (WO-10, schema 0.5), Device -> DhcpRelay.
    // 45 as of 2026-09-16: `FittedIn` (ADR-0050, schema 0.7), Chassis -> PowerSupply.
    // 46 as of 2026-09-18: `HasSurface` (ADR-0051 §1, schema 0.8), Premises -> Surface.
    // `SitsOn` and `FixedTo` are REFERENCE and do not count here.
    // 47 as of 2026-09-18: `HasCapture` (ADR-0052 §3, schema 0.9), Device -> Capture.
    // 48: `HasNote` (ADR-0053 §5, schema 0.10), Notable -> Note.
    // 49-51 (ADR-0058, schema 0.11): `HasContainerNetwork`
    // (Device -> ContainerNetwork), `HasContainer` (Device -> Container),
    // `HasPublishedPort` (Container -> PublishedPort). `AttachedTo` and
    // `ParentUnit` are REFERENCE and do not count here.
    assert_eq!(containment, 51);
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
            "PolicySet->SecurityPolicy",
            "SystemSettings->NtpServer",
            "TunnelInterface->LogicalUnit",
        ],
        "the nested-kind set the shipped dictionary produces moved"
    );
}
