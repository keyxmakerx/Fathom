//! Invariant 3 at the surface that actually matters: **every page the browser
//! can reach**.
//!
//! `fathom-ingest`'s `redaction_canary.rs` sweeps the whole `IngestOutput` and
//! proves no canary survives the gate. That is the parser's half, and until
//! 2026-08-10 it was the only half anybody checked. Between it and a user's
//! screen there are now three more places a secret could come to rest — the
//! typed store the weld writes, the `WeldOutput` handed back, and the reply
//! bytes this module encodes — and `OP_PASTE` added all of them at once.
//!
//! So this test does not sample. It enumerates **every node in the estate**,
//! asks the shell for every page the page can open for it, and searches the
//! decoded strings of every reply. The method is deliberately the crude one,
//! for the reason the parser's canary states: *"Not 'check the capture': the
//! point is to catch the path nobody thought of."* A targeted assertion tests
//! the author's imagination; a sweep tests the product.
//!
//! Why the estate is rebuilt here rather than read out of the shell: the shell
//! holds its graph privately, and widening that for a test would be widening
//! the module's surface for a test. The weld is pure (invariant 9), so the same
//! frame inputs give byte-identical ULIDs — `every_display_id_is_reachable`
//! below is what proves the rebuilt estate really is the shell's, rather than
//! leaving it assumed.

use std::path::{Path, PathBuf};

use fathom_graph::{Actor, BatchId, Graph, Timestamp, UserId};
use fathom_id::Ulid;
use fathom_ingest::dict::Dictionary;
use fathom_ir::scalar::PlatformId;
use fathom_wasm::protocol::{decode_reply, ReplyView};
use fathom_wasm::shell::Shell;
use fathom_wasm::{OP_ELEMENT, OP_EQUIPMENT, OP_INV_ROWS, OP_PASTE};
use fathom_weld::{apply_new_device, Manifest};

/// The string the shipped fixture plants in every secret-bearing position.
const CANARY: &str = "FATHOMCANARY";

const TS: u64 = 1_786_147_200_000;
const ENTROPY: u128 = 0x0000_0000_0000_0000_2026;
/// Must match `shell.rs`'s `PASTE_LABEL`, or the rebuilt estate is not the
/// shell's and `every_display_id_is_reachable` will say so.
const PASTE_LABEL: &str = "Paste junos-srx config";

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .nth(2)
        .expect("the crate lives two levels under the repo root")
        .to_path_buf()
}

fn fixture_bytes() -> Vec<u8> {
    std::fs::read(
        repo_root().join("crates/fathom-ingest/tests/fixtures/junos-srx-s0-synthetic.txt"),
    )
    .expect("the fixture is checked in")
}

fn frame(text: &[u8]) -> Vec<u8> {
    let mut f = Vec::with_capacity(24 + text.len());
    f.extend_from_slice(&TS.to_le_bytes());
    f.extend_from_slice(&ENTROPY.to_le_bytes());
    f.extend_from_slice(text);
    f
}

/// The estate the shell builds, rebuilt with the same inputs.
fn estate() -> Graph {
    let dict = Dictionary::load(&repo_root()).expect("the shipped dictionary loads");
    let ingest = fathom_ingest::ingest(&fixture_bytes(), &dict).expect("within the caps");
    let mut graph = Graph::new();
    apply_new_device(
        &mut graph,
        &ingest,
        &Manifest {
            at: Timestamp(TS),
            entropy: ENTROPY,
            actor: Actor::User(UserId(Ulid::from_parts(TS, 1).expect("in range"))),
            batch: BatchId(Ulid::from_parts(TS, 2).expect("in range")),
            label: PASTE_LABEL,
            platform: PlatformId(dict.platform().to_owned()),
        },
    )
    .expect("the fixture applies");
    graph
}

/// The display id of every node, which is every id the page could ever post.
fn every_display_id(graph: &Graph) -> Vec<String> {
    let mut ids: Vec<String> = graph
        .nodes()
        .filter_map(|n| fathom_inventory::element_page(graph, n.id).map(|p| p.id))
        .collect();
    ids.sort();
    ids.dedup();
    ids
}

fn pasted_shell() -> Shell {
    let mut shell = Shell::new();
    let reply = shell.handle(OP_PASTE, &frame(&fixture_bytes()));
    match decode_reply(&reply).expect("a well-formed reply") {
        ReplyView::FaceRows(_) => {}
        other => panic!("the fixture did not paste: {other:?}"),
    }
    shell
}

/// Every string in every reply the page can obtain, in one vector.
fn everything_the_page_can_see() -> Vec<String> {
    let graph = estate();
    let mut shell = pasted_shell();
    let mut seen: Vec<String> = Vec::new();

    let mut collect = |reply: &[u8]| match decode_reply(reply).expect("a well-formed reply") {
        ReplyView::FaceRows(rows) => {
            for r in rows {
                seen.extend(r.strings);
            }
        }
        // An error reply is still bytes the page renders, so its detail is
        // swept too rather than skipped as "not a real reply".
        ReplyView::Error(e) => seen.push(e.detail),
        ReplyView::Empty => {}
        other => panic!("unexpected reply {other:?}"),
    };

    // The paste reply itself — the summary, every residue line, every
    // unresolved reference.
    collect(&Shell::new().handle(OP_PASTE, &frame(&fixture_bytes())));

    // Every inventory table.
    for kind in 0u8..3 {
        collect(&shell.handle(OP_INV_ROWS, &[kind]));
    }

    // Every element page and every equipment page, for every node.
    for id in every_display_id(&graph) {
        collect(&shell.handle(OP_ELEMENT, id.as_bytes()));
        collect(&shell.handle(OP_EQUIPMENT, id.as_bytes()));
    }

    seen
}

/// The fixture must actually carry what this file searches for. Without it,
/// every assertion below passes on a canary-free fixture and the whole file
/// becomes a very confident no-op.
#[test]
fn the_fixture_still_carries_canaries() {
    let text = String::from_utf8(fixture_bytes()).expect("the fixture is UTF-8");
    let n = text.matches(CANARY).count();
    assert!(
        n >= 4,
        "the fixture carries {n} canaries; it plants one in every secret-bearing \
         position, and a canary test against a canary-free fixture proves nothing"
    );
}

/// The estate rebuilt here is the estate the shell holds. If the weld ever
/// stopped being a pure function of the frame, or the label drifted, this fails
/// and the sweep below stops being exhaustive — which would otherwise be
/// completely invisible.
#[test]
fn every_display_id_is_reachable() {
    let graph = estate();
    let mut shell = pasted_shell();
    let ids = every_display_id(&graph);
    assert!(ids.len() > 5, "the fixture builds a real estate: {ids:?}");

    for id in &ids {
        let reply = shell.handle(OP_ELEMENT, id.as_bytes());
        match decode_reply(&reply).expect("a well-formed reply") {
            ReplyView::FaceRows(rows) => assert!(!rows.is_empty(), "{id} opened an empty page"),
            other => panic!(
                "{id} was rebuilt from the same inputs the shell used and the shell \
                 does not have it: {other:?}"
            ),
        }
    }
}

/// The sweep. Every page, every string, no canary.
#[test]
fn no_canary_reaches_any_page() {
    for s in everything_the_page_can_see() {
        assert!(
            !s.contains(CANARY),
            "a secret reached a page the browser can open, in: {s}"
        );
    }
}

/// The sweep is only worth what its coverage is worth, so the coverage is
/// asserted rather than hoped for: a bug that made every reply empty would pass
/// `no_canary_reaches_any_page` silently.
#[test]
fn the_sweep_actually_sees_the_estate() {
    let seen = everything_the_page_can_see();
    let joined = seen.join("\n");
    assert!(
        seen.len() > 100,
        "the sweep collected only {} strings; it is supposed to cover every page",
        seen.len()
    );
    // Things the fixture definitely produces, so an empty sweep cannot pass.
    for expected in ["IKE-POL", "junos-srx"] {
        assert!(
            joined.contains(expected),
            "the sweep never saw `{expected}`, so it is not reading the estate"
        );
    }
    // And the redaction marker IS present — the secret was replaced, not
    // dropped, which is the behaviour `14` §9.7 specifies.
    assert!(
        joined.contains("REDACTED") || joined.contains("psk"),
        "no trace of the redaction itself appears; the gate should leave a marker"
    );
}
