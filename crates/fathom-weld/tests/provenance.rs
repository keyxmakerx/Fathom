//! What every write carries out of the weld (WO-09 §4.5 steps 3–8, §12 item 3).
//!
//! `11` §8.1 asks three questions of provenance — why a node exists, why an
//! edge exists, why a field holds what it holds — and this WO constructs one
//! record for each. These tests read them back off the store rather than off
//! the constructors, because a record the store did not intern is a record
//! nothing can ever explain.

use std::path::{Path, PathBuf};

use fathom_graph::{
    Actor, BatchId, ElementId, Graph, Origin, ProvenanceId, StoredPresence, Timestamp, UserId,
};
use fathom_id::Ulid;
use fathom_ingest::dict::Dictionary;
use fathom_ingest::{ingest, IngestOutput};
use fathom_ir::scalar::PlatformId;
use fathom_weld::{apply_new_device, Manifest, WeldOutput};

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

fn apply(ingest: &IngestOutput) -> (Graph, WeldOutput) {
    let mut graph = Graph::new();
    let out = apply_new_device(&mut graph, ingest, &manifest("Paste junos-srx config"))
        .expect("the shipped fixture applies");
    (graph, out)
}

fn applied() -> (Graph, IngestOutput, WeldOutput) {
    let ingest = fixture_ingest();
    let (graph, out) = apply(&ingest);
    (graph, ingest, out)
}

/// Every provenance id the store now holds against a node, an edge or a field
/// slot, in a stable order.
fn every_provenance(graph: &Graph) -> Vec<ProvenanceId> {
    let mut ids = Vec::new();
    for node in graph.nodes() {
        ids.push(node.existence);
        for key in node.id.kind.fields() {
            if let Ok(info) = graph.presence(ElementId::Node(node.id), *key) {
                ids.extend(info.prov);
            }
        }
    }
    for edge in graph.edges() {
        ids.push(edge.prov);
        for key in edge.id.kind.fields() {
            if let Ok(info) = graph.presence(ElementId::Edge(edge.id), *key) {
                ids.extend(info.prov);
            }
        }
    }
    ids
}

/// §4.5 step 7: one record per assertion, `Origin::Parsed`, carrying that
/// assertion's own post-redaction span (`14` §9.5) — not the line, not the
/// statement, not a span shared with its neighbours (`11` §8.4).
#[test]
fn every_field_record_is_parsed_with_its_own_span() {
    let (graph, ingest, out) = applied();
    let mut checked = 0usize;

    for (index, node) in ingest.fragment.nodes.iter().enumerate() {
        let id = *out.nodes.get(index).expect("index-aligned");
        for assertion in &node.fields {
            let info = graph
                .presence(ElementId::Node(id), assertion.key)
                .expect("the key is declared on the kind");
            assert_eq!(info.presence, StoredPresence::Set);
            let record = graph
                .provenance(info.prov.expect("a Set slot carries provenance"))
                .expect("the record is interned");
            assert_eq!(
                record.origin,
                Origin::Parsed {
                    capture: out.capture,
                    span: fathom_graph::CaptureSpan {
                        start: assertion.prov.span.start,
                        end: assertion.prov.span.end,
                    },
                },
                "node {index} field {} carries the wrong span",
                assertion.key.0
            );
            assert_eq!(record.asserted_at, Timestamp(TS));
            assert_eq!(record.confidence, fathom_graph::Confidence::Asserted);
            assert_eq!(record.supersedes, None, "the store fills supersedes");
            checked += 1;
        }
    }

    for (index, edge) in ingest.fragment.edges.iter().enumerate() {
        let id = *out.edges.get(index).expect("index-aligned");
        for assertion in &edge.fields {
            let info = graph
                .presence(ElementId::Edge(id), assertion.key)
                .expect("the key is declared on the edge kind");
            let record = graph
                .provenance(info.prov.expect("a Set slot carries provenance"))
                .expect("the record is interned");
            assert_eq!(
                record.origin,
                Origin::Parsed {
                    capture: out.capture,
                    span: fathom_graph::CaptureSpan {
                        start: assertion.prov.span.start,
                        end: assertion.prov.span.end,
                    },
                }
            );
            checked += 1;
        }
    }

    assert!(checked > 0, "the fixture must assert some fields");
}

/// §4.5 step 3: a node's existence record spans its **first** assertion — the
/// statement that named the object is the reason it exists.
#[test]
fn node_existence_span_is_the_first_assertion() {
    let (graph, ingest, out) = applied();
    let mut checked = 0usize;

    for (index, frag) in ingest.fragment.nodes.iter().enumerate() {
        let Some(first) = frag.fields.first() else {
            continue;
        };
        let id = *out.nodes.get(index).expect("index-aligned");
        let node = graph.node(id).expect("the node is in the store");
        let record = graph
            .provenance(node.existence)
            .expect("the record is interned");
        assert_eq!(
            record.origin,
            Origin::Parsed {
                capture: out.capture,
                span: fathom_graph::CaptureSpan {
                    start: first.prov.span.start,
                    end: first.prov.span.end,
                },
            },
            "node {index} existence does not span its first assertion"
        );
        assert_eq!(record.confidence, fathom_graph::Confidence::Asserted);
        checked += 1;
    }
    assert_eq!(checked, ingest.fragment.nodes.len());
}

/// §4.5 step 3's other half: a node the capture named but asserted nothing
/// about exists on the **whole capture**, because no narrower span is honest.
///
/// The shipped fixture has no such node — every node it produces carries at
/// least one assertion — so one is built here by emptying a node's field
/// vector. That is the only way to exercise the branch without inventing a
/// fixture line, and WO-09 §4.6 names the test.
#[test]
fn fieldless_node_existence_spans_the_capture() {
    let mut ingest = fixture_ingest();
    let last = ingest.fragment.nodes.len() - 1;
    let stripped = ingest
        .fragment
        .nodes
        .get_mut(last)
        .expect("the fixture has nodes");
    assert!(
        !stripped.fields.is_empty(),
        "the fixture's last node must have had fields for this test to mean anything"
    );
    stripped.fields.clear();

    let whole = fathom_graph::CaptureSpan {
        start: 0,
        end: u32::try_from(ingest.capture.text().len()).expect("the paste cap fits u32"),
    };
    let (graph, out) = apply(&ingest);
    let id = *out.nodes.get(last).expect("index-aligned");
    let node = graph.node(id).expect("the node is in the store");
    let record = graph
        .provenance(node.existence)
        .expect("the record is interned");
    assert_eq!(
        record.origin,
        Origin::Parsed {
            capture: out.capture,
            span: whole,
        }
    );
    // Its containment edge, if it has one, carries the same span (§4.5 step 5:
    // "the child's existence provenance content, a fresh id, same origin").
    for edge in graph.edges() {
        if edge.to == id {
            let record = graph.provenance(edge.prov).expect("interned");
            assert_eq!(
                record.origin,
                Origin::Parsed {
                    capture: out.capture,
                    span: whole,
                }
            );
        }
    }
}

/// §4.4 step 1: one `CaptureId`, minted once, on every record the apply
/// writes. A second id would make two halves of one paste unpairable with the
/// blob behind them (`11` §8.4).
#[test]
fn one_capture_id_across_the_apply() {
    let (graph, _ingest, out) = applied();
    let mut seen = 0usize;
    for id in every_provenance(&graph) {
        let record = graph.provenance(id).expect("the record is interned");
        match record.origin {
            Origin::Parsed { capture, .. } => assert_eq!(capture, out.capture),
            Origin::Hand => panic!("the weld wrote a Hand record"),
        }
        seen += 1;
    }
    assert!(seen > 0);
    // The capture id is the mint's first draw and is not reused as an element
    // or provenance id.
    assert!(graph
        .resolve_ref(fathom_id::NodeId(out.capture.0))
        .is_none());
    assert!(graph.provenance(ProvenanceId(out.capture.0)).is_none());
}

/// §12 item 3: one immutable assertion record per assertion, never shared.
/// Sharing is safe only while a first application writes each field exactly
/// once — which is precisely the property reconciliation removes.
#[test]
fn records_are_never_shared_between_assertions() {
    let (graph, _ingest, out) = applied();
    let ids = every_provenance(&graph);
    let total = ids.len();
    let mut sorted = ids;
    sorted.sort();
    sorted.dedup();
    assert_eq!(sorted.len(), total, "a provenance record was shared");

    // Every id the store holds came off this apply's mint, and the mint issued
    // exactly the capture id plus one id per record plus one ULID per element.
    let elements = graph.nodes().count() + graph.edges().count();
    assert_eq!(u32::try_from(1 + total + elements), Ok(out.minted));
}

/// §4.5's DECISION — the weld never asserts absence, never tombstones, never
/// clears. `14` §7.4 pins this slice's scope to `Fragment` and `11` §10.5
/// gives `Fragment` scope no licence: *"nothing happens"* to a node missing
/// from the capture.
#[test]
fn nothing_is_absent_after_apply() {
    let (graph, _ingest, _out) = applied();
    let mut walked = 0usize;

    for node in graph.nodes() {
        assert_eq!(node.absent_since, None, "a node was tombstoned");
        for key in node.id.kind.fields() {
            let info = graph
                .presence(ElementId::Node(node.id), *key)
                .expect("a declared key reads");
            assert_ne!(
                info.presence,
                StoredPresence::Absent,
                "{} field {} is Absent",
                node.id,
                key.0
            );
            walked += 1;
        }
    }
    for edge in graph.edges() {
        assert_eq!(edge.absent_since, None, "an edge was tombstoned");
        for key in edge.id.kind.fields() {
            let info = graph
                .presence(ElementId::Edge(edge.id), *key)
                .expect("a declared key reads");
            assert_ne!(info.presence, StoredPresence::Absent);
            walked += 1;
        }
    }
    assert!(walked > 0, "the walk must have covered some keys");
}
