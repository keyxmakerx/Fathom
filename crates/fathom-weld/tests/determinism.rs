//! Invariant 9 at the weld: same fragment + same manifest ⇒ the same graph,
//! byte for byte (WO-09 §4.4, §9 failure mode 2).
//!
//! The weld reads no clock, no entropy source, no environment and no file:
//! everything it cannot derive from the fragment is a `Manifest` field. So two
//! applies of one `IngestOutput` must be indistinguishable, and the way to
//! prove it is to render both and compare the bytes rather than to compare
//! structures field by field and hope the comparison is exhaustive.

use std::path::{Path, PathBuf};

use fathom_graph::{Actor, BatchId, Graph, Timestamp, UserId};
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

/// Every id the store would ever show a user, as text: the conventions'
/// `<kind-lower>:<ulid>` for nodes and edges, in the store's own iteration
/// order (`fathom-graph`'s `BTreeMap`s, which is why there is an order at all).
fn rendered_ids(graph: &Graph) -> String {
    let mut out = String::new();
    for node in graph.nodes() {
        out.push_str(&format!("{}\n", node.id));
    }
    for edge in graph.edges() {
        out.push_str(&format!("{} {} -> {}\n", edge.id, edge.from, edge.to));
    }
    out
}

/// The op log as text, batch label included: the undo unit a user sees.
fn rendered_log(graph: &Graph) -> String {
    graph
        .log()
        .iter()
        .map(|batch| format!("{batch:?}\n"))
        .collect()
}

#[test]
fn two_applies_one_ingest_render_identically() {
    let ingest = fixture_ingest();

    let mut first = Graph::new();
    let a: WeldOutput = apply_new_device(&mut first, &ingest, &manifest("Paste junos-srx config"))
        .expect("the shipped fixture applies");

    let mut second = Graph::new();
    let b: WeldOutput = apply_new_device(&mut second, &ingest, &manifest("Paste junos-srx config"))
        .expect("the shipped fixture applies");

    assert_eq!(rendered_ids(&first), rendered_ids(&second));
    assert_eq!(rendered_log(&first), rendered_log(&second));
    assert_eq!(
        first.log().iter().map(|b| b.ops.len()).sum::<usize>(),
        second.log().iter().map(|b| b.ops.len()).sum::<usize>()
    );
    assert_eq!(format!("{a:?}"), format!("{b:?}"));
    assert_eq!(a, b);

    // A different entropy base moves every id — the comparison above is not
    // vacuous, and the mint really is what fixes them.
    let mut third = Graph::new();
    let mut other = manifest("Paste junos-srx config");
    other.entropy = ENTROPY + 1;
    let c = apply_new_device(&mut third, &ingest, &other).expect("the shipped fixture applies");
    assert_ne!(rendered_ids(&first), rendered_ids(&third));
    assert_ne!(a.device, c.device);
    assert_eq!(a.minted, c.minted);
}
