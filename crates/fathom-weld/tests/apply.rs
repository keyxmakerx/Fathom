//! `apply_new_device` against the shipped fixture, and the two refusals it
//! makes before it writes (WO-09 §4.6, §4.5 steps 1–10).
//!
//! Every positive test below applies the real `junos-srx-s0-synthetic.txt`
//! through the real dictionary: a fragment hand-built here would only prove
//! that the weld agrees with itself. The two negative tests do build a
//! fragment by hand, because WO-03 §4.8's contract makes both refusals
//! unreachable from the shipped parser and this order refuses them rather
//! than assuming them.

use std::path::{Path, PathBuf};

use fathom_graph::{
    Actor, BatchId, ElementId, Graph, Op, Origin, StoredPresence, Timestamp, UserId,
};
use fathom_id::Ulid;
use fathom_ingest::bind::{FragNode, FragNodeId};
use fathom_ingest::dict::Dictionary;
use fathom_ingest::{ingest, IngestOutput};
use fathom_ir::bag::FieldKey;
use fathom_ir::generated::ir_types::{EdgeKind, NodeKind};
use fathom_ir::scalar::PlatformId;
use fathom_weld::{apply_new_device, containment_edge, Manifest, WeldError, WeldOutput};

/// 2026-08-08T00:00:00Z. A stored value, like every timestamp in this tree.
const TS: u64 = 1_786_147_200_000;
/// The apply's entropy base. Any value; fixed so the run is reproducible.
const ENTROPY: u128 = 0x0000_0000_0000_0000_2026;

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .nth(2)
        .expect("the crate lives two levels under the repo root")
        .to_path_buf()
}

fn dictionary() -> Dictionary {
    Dictionary::load(&repo_root()).expect("the shipped dictionary loads")
}

fn fixture_ingest() -> IngestOutput {
    let bytes = std::fs::read(
        repo_root().join("crates/fathom-ingest/tests/fixtures/junos-srx-s0-synthetic.txt"),
    )
    .expect("the fixture is checked in");
    ingest(&bytes, &dictionary()).expect("the fixture is within the caps")
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

/// The fixture applied onto a fresh graph, with the ingest kept so a test can
/// compare the store against the fragment it came from.
fn applied() -> (Graph, IngestOutput, WeldOutput) {
    let ingest = fixture_ingest();
    let mut graph = Graph::new();
    let out = apply_new_device(&mut graph, &ingest, &manifest("Paste junos-srx config"))
        .expect("the shipped fixture applies");
    (graph, ingest, out)
}

/// `Device.platform`'s key, read from the generated registry (ADR-0008).
fn platform_key() -> FieldKey {
    FieldKey(
        fathom_ir::generated::ir_types::FIELD_KEYS
            .iter()
            .find(|(name, _)| *name == "Device.platform")
            .map(|(_, key)| *key)
            .expect("the registry declares Device.platform"),
    )
}

/// §4.5 step 3 and `WeldOutput.nodes`' doc: one store node per fragment node,
/// in fragment order, with the fragment's kind.
#[test]
fn nodes_land_index_aligned() {
    let (graph, ingest, out) = applied();
    let fragment = &ingest.fragment;

    assert_eq!(out.nodes.len(), fragment.nodes.len());
    assert_eq!(out.device, *out.nodes.first().expect("a device"));
    for (index, (node, id)) in fragment.nodes.iter().zip(out.nodes.iter()).enumerate() {
        assert_eq!(node.kind, id.kind, "kind moved at fragment index {index}");
        assert!(
            graph.node(*id).is_some(),
            "node {index} is not in the store"
        );
    }
    // Nothing else was created: the store holds exactly the fragment's nodes.
    assert_eq!(graph.nodes().count(), fragment.nodes.len());
    // Every id is distinct — the mint's counter never reissued.
    let mut sorted = out.nodes.clone();
    sorted.sort();
    sorted.dedup();
    assert_eq!(sorted.len(), out.nodes.len(), "a node id was reused");
}

/// §4.5 step 5: every `FragNode.owner` became the containment edge the schema
/// declares for that (owner kind, child kind) pair, and `Graph::owner` walks
/// back to the fragment's owner. Where the fragment declared no `owner`, the
/// parent is the one the **schema** determines for the child's kind (§10 item
/// 10's answer), which for every kind this fixture produces is the device —
/// so every node but `nodes[0]` ends the apply contained.
#[test]
fn owner_becomes_the_declared_containment_edge() {
    let (graph, ingest, out) = applied();
    let fragment = &ingest.fragment;

    let declared = fragment.nodes.iter().filter(|n| n.owner.is_some()).count();
    assert!(declared > 0, "the fixture must exercise declared owners");
    let derived = fragment.nodes.len() - 1 - declared;
    assert!(derived > 0, "the fixture must exercise derived owners");
    assert_eq!(out.containment.len(), fragment.nodes.len() - 1);

    for (index, node) in fragment.nodes.iter().enumerate() {
        let id = *out.nodes.get(index).expect("index-aligned");
        if index == 0 {
            assert_eq!(graph.owner(id), None, "the device gained an owner");
            continue;
        }
        let owner_id = match node.owner {
            Some(FragNodeId(at)) => {
                let at = usize::try_from(at).expect("a fragment index fits");
                *out.nodes.get(at).expect("owner is an earlier node")
            }
            // Derived, not defaulted: the device is the only node kind the
            // schema lets contain this kind. Proved here over every kind, not
            // assumed from the pair the weld happened to pick.
            None => {
                let parents: Vec<NodeKind> = NodeKind::ALL
                    .into_iter()
                    .filter(|owner| containment_edge(*owner, id.kind).is_some())
                    .collect();
                assert_eq!(
                    parents,
                    vec![NodeKind::Device],
                    "the schema no longer determines {}'s parent",
                    id.kind.name()
                );
                out.device
            }
        };
        assert_eq!(graph.owner(id), Some(owner_id), "owner moved at {index}");
        let want = containment_edge(owner_id.kind, id.kind)
            .expect("the pair the weld resolved still resolves");
        let edge = graph
            .inn(id, want)
            .next()
            .expect("the containment in-edge exists");
        assert_eq!(edge.from, owner_id);
        assert_eq!(edge.to, id);
        assert!(out.containment.contains(&edge.id));
    }
}

/// §4.5 step 6: `nodes[0]` gets no containment in-edge. `Site` is not in the
/// fragment and this WO does not invent one — a `Device` with no `HasDevice`
/// in-edge is L0-valid (`11` §7.2's rule is an upper bound at write time).
#[test]
fn device_has_no_containment_in_edge() {
    let (graph, _ingest, out) = applied();
    assert_eq!(out.device.kind, NodeKind::Device);
    assert_eq!(graph.owner(out.device), None);
    assert_eq!(graph.inn(out.device, EdgeKind::HasDevice).count(), 0);
    assert_eq!(graph.nodes_of_kind(NodeKind::Site).count(), 0);
    assert_eq!(graph.nodes_of_kind(NodeKind::Device).count(), 1);
}

/// §4.5 step 4: the platform is stamped on `nodes[0]` with
/// `Confidence::Derived` — no statement asserts it, it follows from which
/// dictionary parsed the capture (`11` §8.3).
#[test]
fn platform_is_stamped_derived() {
    let (graph, _ingest, out) = applied();
    let node = graph.node(out.device).expect("the device is in the store");

    assert_eq!(
        fathom_ir::generated::accessors::device::platform(node),
        Ok(&PlatformId("junos-srx".to_owned()))
    );
    let info = graph
        .presence(ElementId::Node(out.device), platform_key())
        .expect("platform is declared on Device");
    assert_eq!(info.presence, StoredPresence::Set);
    let record = graph
        .provenance(info.prov.expect("a Set slot carries provenance"))
        .expect("the record is interned");
    assert_eq!(record.confidence, fathom_graph::Confidence::Derived);
    assert!(matches!(record.origin, Origin::Parsed { .. }));

    // The capture-derived platform is the *only* Derived record in the apply:
    // everything else the capture states outright (§4.5's DECISION).
    let derived = graph
        .nodes()
        .filter_map(|n| graph.provenance(n.existence))
        .filter(|r| r.confidence == fathom_graph::Confidence::Derived)
        .count();
    assert_eq!(derived, 0, "no node exists on a derived assertion");
}

/// §4.5 step 8: every `FragEdge` landed with its endpoints and its fields.
#[test]
fn fragment_edges_and_their_fields_land() {
    let (graph, ingest, out) = applied();
    let fragment = &ingest.fragment;

    assert_eq!(out.edges.len(), fragment.edges.len());
    assert!(!fragment.edges.is_empty(), "the fixture must resolve edges");

    for (index, (frag, id)) in fragment.edges.iter().zip(out.edges.iter()).enumerate() {
        assert_eq!(frag.kind, id.kind, "edge kind moved at {index}");
        let edge = graph.edge(*id).expect("the edge is in the store");
        let from = *out
            .nodes
            .get(usize::try_from(frag.from.0).expect("fits"))
            .expect("in range");
        let to = *out
            .nodes
            .get(usize::try_from(frag.to.0).expect("fits"))
            .expect("in range");
        assert_eq!(edge.from, from);
        assert_eq!(edge.to, to);
        for assertion in &frag.fields {
            let info = graph
                .presence(ElementId::Edge(*id), assertion.key)
                .expect("the key is declared on the edge kind");
            assert_eq!(
                info.presence,
                StoredPresence::Set,
                "edge field {} did not land",
                assertion.key.0
            );
        }
    }

    // The store holds the fragment's edges plus exactly the containment edges
    // the weld materialised, and nothing else.
    assert_eq!(
        graph.edges().count(),
        fragment.edges.len() + out.containment.len()
    );
}

/// §4.5 step 9 / `14` §7.3: *"recorded, not materialised."* Every pending
/// reference comes out, in fragment order, and none of them wrote anything.
#[test]
fn pending_is_carried_not_materialised() {
    let (graph, ingest, out) = applied();
    let fragment = &ingest.fragment;

    assert_eq!(out.unresolved.len(), fragment.pending.len());
    assert!(
        !fragment.pending.is_empty(),
        "the fixture must exercise pending references"
    );
    for (pending, row) in fragment.pending.iter().zip(out.unresolved.iter()) {
        assert_eq!(row.kind, pending.kind);
        assert_eq!(row.target, pending.target);
        assert_eq!(row.line, pending.prov.line);
        assert_eq!(row.span.start, pending.prov.span.start);
        assert_eq!(row.span.end, pending.prov.span.end);
        assert_eq!(
            row.from,
            *out.nodes
                .get(usize::try_from(pending.from.0).expect("fits"))
                .expect("in range")
        );
        // Nothing was created to receive the reference.
        assert_eq!(graph.out(row.from, row.kind).count(), 0);
    }
    // The store's edge count already accounts for every edge (see
    // `fragment_edges_and_their_fields_land`); no pending edge is among them.
    assert_eq!(
        graph.edges().count(),
        fragment.edges.len() + out.containment.len()
    );
}

/// §4.5 steps 2 and 10: one batch, opened once, closed once, holding every op
/// the apply produced — the undo unit `53` §7.2 requires.
#[test]
fn one_batch_holds_every_op() {
    let (graph, ingest, out) = applied();
    let fragment = &ingest.fragment;

    let log = graph.log();
    assert_eq!(log.len(), 1, "the apply must land in exactly one batch");
    let batch = log.first().expect("one batch");
    assert_eq!(batch.id, out.batch);
    assert_eq!(batch.label, "Paste junos-srx config");

    let node_fields: usize = fragment.nodes.iter().map(|n| n.fields.len()).sum();
    let edge_fields: usize = fragment.edges.iter().map(|e| e.fields.len()).sum();
    let adds = fragment.nodes.len();
    let edges = fragment.edges.len() + out.containment.len();
    // +1 for `Device.platform`, which no assertion carries.
    let sets = node_fields + edge_fields + 1;
    assert_eq!(batch.ops.len(), adds + edges + sets);

    assert_eq!(
        batch
            .ops
            .iter()
            .filter(|op| matches!(op, Op::AddNode { .. }))
            .count(),
        adds
    );
    assert_eq!(
        batch
            .ops
            .iter()
            .filter(|op| matches!(op, Op::AddEdge { .. }))
            .count(),
        edges
    );
    assert_eq!(
        batch
            .ops
            .iter()
            .filter(|op| matches!(op, Op::SetField { .. }))
            .count(),
        sets
    );
    // §4.5's never-called set: no tombstone reaches the log.
    assert!(!batch
        .ops
        .iter()
        .any(|op| matches!(op, Op::Tombstone { .. })));
}

/// §4.5 step 1: validation runs before the batch opens, so a fragment whose
/// `owner` points forward leaves the graph untouched — which matters because
/// `fathom-graph` cannot roll a batch back (§4.5's atomicity DECISION).
#[test]
fn owner_not_earlier_is_refused_before_any_write() {
    let mut ingest = fixture_ingest();
    // Point the second node's owner at itself: WO-03 §4.8 contract item 2
    // makes this unreachable from the parser, which is why it is built here.
    let target = ingest
        .fragment
        .nodes
        .get_mut(1)
        .expect("the fixture has more than one node");
    target.owner = Some(FragNodeId(1));

    let mut graph = Graph::new();
    assert_eq!(
        apply_new_device(&mut graph, &ingest, &manifest("refused")),
        Err(WeldError::OwnerNotEarlier { node: 1 })
    );
    assert_eq!(graph.nodes().count(), 0);
    assert_eq!(graph.edges().count(), 0);
    assert_eq!(graph.log().len(), 0, "no batch was opened");
}

/// §4.5 step 5's refusal: a (owner kind, child kind) pair the schema declares
/// no containment for names **both** kinds, so a schema gap is legible without
/// a debugger.
#[test]
fn no_containment_edge_names_both_kinds() {
    let mut ingest = fixture_ingest();
    // `Site` is one of the kinds no node kind contains (`tests/containment.rs`
    // pins the set), so `(Device, Site)` has no containment edge.
    ingest.fragment.nodes.truncate(1);
    ingest.fragment.edges.clear();
    ingest.fragment.pending.clear();
    ingest.fragment.nodes.push(FragNode {
        kind: NodeKind::Site,
        owner: Some(FragNodeId(0)),
        fields: Vec::new(),
    });

    let mut graph = Graph::new();
    assert_eq!(
        apply_new_device(&mut graph, &ingest, &manifest("refused")),
        Err(WeldError::NoContainmentEdge {
            owner: NodeKind::Device,
            child: NodeKind::Site,
        })
    );
}
