//! The whole path end to end: pasted junos-srx text, through the shipped
//! dictionary, into a store (WO-09 §4.6's last file).
//!
//! The four other integration files each pin one property of the apply. This
//! one asserts that the product of them is usable: a device a face could open,
//! whose objects it can walk to, with the references the capture never defined
//! carried out rather than invented (`14` §7.3).

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use fathom_graph::{Actor, BatchId, ElementId, Graph, NodeId, StoredPresence, Timestamp, UserId};
use fathom_id::Ulid;
use fathom_ingest::bind::PendingTarget;
use fathom_ingest::dict::Dictionary;
use fathom_ingest::{ingest, IngestOutput};
use fathom_ir::generated::ir_types::{EdgeKind, NodeKind};
use fathom_ir::scalar::{Identifier, PlatformId};
use fathom_weld::{apply_new_device, Manifest};

/// 2026-08-08T00:00:00Z. A stored value, like every timestamp in this tree.
const TS: u64 = 1_786_147_200_000;
const ENTROPY: u128 = 0x0000_0000_0000_0000_2026;

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .nth(2)
        .expect("the crate lives two levels under the repo root")
        .to_path_buf()
}

fn fixture_ingest() -> IngestOutput {
    let dict = Dictionary::load(&repo_root()).expect("the shipped dictionary loads");
    let bytes = std::fs::read(
        repo_root().join("crates/fathom-ingest/tests/fixtures/junos-srx-s0-synthetic.txt"),
    )
    .expect("the fixture is checked in");
    ingest(&bytes, &dict).expect("the fixture is within the caps")
}

fn manifest(label: &str) -> Manifest<'_> {
    Manifest {
        at: Timestamp(TS),
        entropy: ENTROPY,
        actor: Actor::User(UserId(Ulid::from_parts(TS, 1).expect("in range"))),
        batch: BatchId(Ulid::from_parts(TS, 2).expect("in range")),
        label,
        platform: PlatformId("junos-srx".to_owned()),
    }
}

/// Every node reachable from `start` by walking containment and reference
/// edges in both directions, over every declared edge kind. This is the walk a
/// device-rooted face makes; if a node is outside it, no face can show it.
fn reachable(graph: &Graph, start: NodeId) -> BTreeSet<NodeId> {
    let mut seen = BTreeSet::new();
    let mut queue = vec![start];
    seen.insert(start);
    while let Some(node) = queue.pop() {
        for kind in EdgeKind::ALL {
            for edge in graph.out(node, kind) {
                if seen.insert(edge.to) {
                    queue.push(edge.to);
                }
            }
            for edge in graph.inn(node, kind) {
                if seen.insert(edge.from) {
                    queue.push(edge.from);
                }
            }
        }
    }
    seen
}

/// WO-09 §4.6's fixture gate. The counts it pins are recorded in WO-09 §6.1.
#[test]
fn the_synthetic_srx_fixture_applies() {
    let ingest = fixture_ingest();
    let mut graph = Graph::new();
    let out = apply_new_device(&mut graph, &ingest, &manifest("Paste junos-srx config"))
        .expect("the shipped fixture applies");

    // One store node per fragment node, and nothing else created.
    assert_eq!(out.nodes.len(), ingest.fragment.nodes.len());
    assert_eq!(out.nodes.len(), 13);
    assert_eq!(graph.nodes().count(), 13);
    assert_eq!(out.edges.len(), 7);
    assert_eq!(out.containment.len(), 12);
    assert_eq!(graph.edges().count(), 19);
    assert_eq!(out.minted, 99);

    // The device the paste created, with the two fields a face names it by:
    // `hostname` the capture states, `platform` the dictionary derives.
    let device = graph.node(out.device).expect("the device is in the store");
    assert_eq!(out.device.kind, NodeKind::Device);
    assert_eq!(
        fathom_ir::generated::accessors::device::hostname(device),
        Ok(&Identifier("srx-a-01".to_owned()))
    );
    assert_eq!(
        fathom_ir::generated::accessors::device::platform(device),
        Ok(&PlatformId("junos-srx".to_owned()))
    );
    for name in ["Device.hostname", "Device.platform"] {
        let key = fathom_ir::bag::FieldKey(
            fathom_ir::generated::ir_types::FIELD_KEYS
                .iter()
                .find(|(field, _)| *field == name)
                .map(|(_, key)| *key)
                .expect("the registry declares the field"),
        );
        let info = graph
            .presence(ElementId::Node(out.device), key)
            .expect("the key is declared on Device");
        assert_eq!(info.presence, StoredPresence::Set, "{name} did not land");
    }

    // The `IpsecVpn` closure is reachable from the device: the VPN itself, the
    // gateway and policies it names, and the traffic selector it contains.
    let closure = reachable(&graph, out.device);
    let vpn = graph
        .nodes_of_kind(NodeKind::IpsecVpn)
        .map(|n| n.id)
        .next()
        .expect("the fixture configures one IpsecVpn");
    assert!(closure.contains(&vpn), "the IpsecVpn is unreachable");
    for kind in [
        NodeKind::IkeGateway,
        NodeKind::IkePolicy,
        NodeKind::IkeProposal,
        NodeKind::IpsecPolicy,
        NodeKind::IpsecProposal,
        NodeKind::TrafficSelector,
        NodeKind::TunnelInterface,
        NodeKind::LogicalUnit,
        NodeKind::Address,
        NodeKind::Zone,
    ] {
        let mut of_kind = graph.nodes_of_kind(kind).peekable();
        assert!(
            of_kind.peek().is_some(),
            "the fixture must produce a {}",
            kind.name()
        );
        for node in of_kind {
            assert!(
                closure.contains(&node.id),
                "{} is unreachable from the device",
                node.id
            );
        }
    }
    // Nothing at all is outside the walk: the whole paste is one connected
    // estate rooted at the device it configured.
    assert_eq!(closure.len(), graph.nodes().count());
    assert_eq!(graph.device_of(vpn), Some(out.device));

    // The references the capture names but never defines stay unresolved —
    // `14` §7.3, *"recorded, not materialised"*. `reth0.0` is the one the
    // fixture names twice and defines nowhere: it declares `st0` only.
    assert!(!out.unresolved.is_empty());
    assert_eq!(out.unresolved.len(), 2);
    let reth = out
        .unresolved
        .iter()
        .filter(|row| {
            matches!(
                &row.target,
                PendingTarget::InterfaceUnit { name, unit, .. }
                    if name == &Identifier("reth0".to_owned()) && *unit == 0
            )
        })
        .count();
    // Both rows are `reth0.0`: the gateway's `external-interface` and the WAN
    // zone's membership. Nothing else in the fixture goes unresolved.
    assert_eq!(reth, out.unresolved.len());
    assert!(
        reth > 0,
        "the reth0.0 reference is not among {:?}",
        out.unresolved
            .iter()
            .map(|row| &row.target)
            .collect::<Vec<_>>()
    );
    assert_eq!(graph.nodes_of_kind(NodeKind::RethInterface).count(), 0);
}
