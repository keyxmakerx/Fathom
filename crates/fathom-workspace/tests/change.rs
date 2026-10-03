//! `fathom-change 1` (ADR-0063): the document, its application, every refusal,
//! and the vectors the TypeScript client is proved against.
//!
//! Each vector is a directory under `client/src/document/vectors/change/`:
//! `before.plain`, `change`, `after.plain` and `meta.json`. `after.plain` is
//! `before.plain` with `change` applied by `apply_change`, written with
//! `write_plain`; the client must reproduce it byte for byte. Regenerate with
//!
//! ```text
//! cargo test -p fathom-workspace --test change -- --ignored --nocapture
//! ```

use std::fs;
use std::path::PathBuf;

use fathom_canon::Json;
use fathom_graph::{
    Actor, Batch, BatchId, ElementId, Graph, NodeId, Op, Origin, ProvenanceId, ProvenanceRecord,
    StoredPresence, Timestamp, UserId, WriteError,
};
use fathom_id::Ulid;
use fathom_ir::generated::ir_types::{
    CaptureField, ChassisField, DocField, DocLinkField, EdgeKind, MountedInFace, MountedInField,
    NodeKind, NoteField, PremisesField, RackField, RackUnitNumbering,
};
use fathom_ir::scalar::Text;
use fathom_workspace::{
    apply_change, read_change, read_plain, write_change, write_plain, Change, ChangeError,
};

const AT: u64 = 1_700_000_000_000;

fn ulid(n: u128) -> Ulid {
    Ulid::from_parts(AT, n).expect("48-bit timestamp")
}

fn me() -> Actor {
    Actor::User(UserId(ulid(7)))
}

fn someone_else() -> Actor {
    Actor::User(UserId(ulid(8)))
}

fn prov_by(n: u128, by: Actor) -> ProvenanceRecord {
    ProvenanceRecord {
        id: ProvenanceId(ulid(1_000_000 + n)),
        origin: Origin::Hand,
        asserted_at: Timestamp(AT + n as u64),
        asserted_by: by,
        confidence: fathom_graph::Confidence::Asserted,
        supersedes: None,
    }
}

fn prov(n: u128) -> ProvenanceRecord {
    prov_by(n, me())
}

fn batch_id(n: u128) -> BatchId {
    BatchId(ulid(2_000_000 + n))
}

const PREMISES: u128 = 1;
const RACK: u128 = 3;
const HAS_RACK: u128 = 5;
const DEVICE: u128 = 10;
const CHASSIS: u128 = 12;
const HAS_CHASSIS: u128 = 14;

fn node(kind: NodeKind, n: u128) -> NodeId {
    NodeId {
        kind,
        ulid: ulid(n),
    }
}

fn rack() -> ElementId {
    node(NodeKind::Rack, RACK).into()
}

/// A premises, a rack (`label` R1, `height_u` 42) and a device with one
/// chassis, all written by `me()`.
fn base() -> Graph {
    let mut g = Graph::new();
    g.begin_batch(batch_id(0), "base").unwrap();
    let premises = g
        .insert_node(NodeKind::Premises, ulid(PREMISES), prov(1))
        .unwrap();
    let rack = g.insert_node(NodeKind::Rack, ulid(RACK), prov(2)).unwrap();
    g.insert_edge(EdgeKind::HasRack, ulid(HAS_RACK), premises, rack, prov(3))
        .unwrap();
    g.set_field(
        rack.into(),
        RackField::Label.key(),
        Text("R1".into()),
        prov(4),
    )
    .unwrap();
    g.set_field(rack.into(), RackField::HeightU.key(), 42u8, prov(5))
        .unwrap();
    let device = g
        .insert_node(NodeKind::Device, ulid(DEVICE), prov(6))
        .unwrap();
    let chassis = g
        .insert_node(NodeKind::Chassis, ulid(CHASSIS), prov(7))
        .unwrap();
    g.insert_edge(
        EdgeKind::HasChassis,
        ulid(HAS_CHASSIS),
        device,
        chassis,
        prov(8),
    )
    .unwrap();
    g.end_batch().unwrap();
    g
}

// ---------------------------------------------------------------------------
// Deriving a change from what the graph recorded

fn field_json(g: &Graph, element: ElementId, key: fathom_ir::bag::FieldKey) -> Json {
    let snap = g.to_snapshot().unwrap();
    let fields = match element {
        ElementId::Node(id) => snap
            .nodes
            .iter()
            .find(|n| n.id == id)
            .unwrap()
            .fields
            .clone(),
        ElementId::Edge(id) => snap
            .edges
            .iter()
            .find(|e| e.id == id)
            .unwrap()
            .fields
            .clone(),
    };
    fields
        .iter()
        .find(|f| f.key == key)
        .and_then(|f| f.value.clone())
        .expect("a set field has a value")
}

/// The change the last batch of `after` is: the batch, the provenance records
/// its ops name (without `supersedes`) and the values of its set ops.
fn change_of(after: &Graph) -> Change {
    let batch = after.log().last().unwrap().clone();
    let mut ids: Vec<ProvenanceId> = Vec::new();
    let mut values = Vec::new();
    for op in &batch.ops {
        match op {
            Op::AddNode { prov, .. } | Op::AddEdge { prov, .. } => ids.push(*prov),
            Op::SetField {
                element,
                key,
                presence,
                prov,
            } => {
                ids.push(*prov);
                if *presence == StoredPresence::Set {
                    values.push(field_json(after, *element, *key));
                }
            }
            _ => {}
        }
    }
    ids.sort();
    ids.dedup();
    let provenance = ids
        .iter()
        .map(|id| {
            let mut r = after.provenance(*id).unwrap().clone();
            r.supersedes = None;
            r
        })
        .collect();
    Change {
        batch,
        provenance,
        values,
    }
}

// ---------------------------------------------------------------------------
// The vectors

struct Scenario {
    name: &'static str,
    description: &'static str,
    before: Graph,
    after: Graph,
}

fn scenario(
    name: &'static str,
    description: &'static str,
    before: Graph,
    write: impl FnOnce(&mut Graph),
) -> Scenario {
    let mut after = before.clone();
    write(&mut after);
    Scenario {
        name,
        description,
        before,
        after,
    }
}

fn scenarios() -> Vec<Scenario> {
    let rack_node = node(NodeKind::Rack, RACK);
    let chassis_node = node(NodeKind::Chassis, CHASSIS);
    let premises = node(NodeKind::Premises, PREMISES);

    let mut out = vec![
        scenario(
            "add-node-with-fields",
            "A second Rack with a HasRack edge from the Premises and three fields.",
            base(),
            |g| {
                g.begin_batch(batch_id(1), "add rack").unwrap();
                let r2 = g.insert_node(NodeKind::Rack, ulid(100), prov(100)).unwrap();
                g.insert_edge(EdgeKind::HasRack, ulid(102), premises, r2, prov(101))
                    .unwrap();
                g.set_field(
                    r2.into(),
                    RackField::Label.key(),
                    Text("R2".into()),
                    prov(102),
                )
                .unwrap();
                g.set_field(r2.into(), RackField::HeightU.key(), 24u8, prov(103))
                    .unwrap();
                g.set_field(
                    r2.into(),
                    RackField::UnitNumbering.key(),
                    RackUnitNumbering::Descending,
                    prov(104),
                )
                .unwrap();
                g.end_batch().unwrap();
            },
        ),
        scenario(
            "add-edge-with-fields",
            "A MountedIn edge from the Chassis to the Rack with position_u and face.",
            base(),
            |g| {
                g.begin_batch(batch_id(1), "mount chassis").unwrap();
                let e = g
                    .insert_edge(
                        EdgeKind::MountedIn,
                        ulid(110),
                        chassis_node,
                        rack_node,
                        prov(110),
                    )
                    .unwrap();
                g.set_field(e.into(), MountedInField::PositionU.key(), 10u8, prov(111))
                    .unwrap();
                g.set_field(
                    e.into(),
                    MountedInField::Face.key(),
                    MountedInFace::Front,
                    prov(112),
                )
                .unwrap();
                g.end_batch().unwrap();
            },
        ),
        scenario(
            "set-over-existing-value",
            "Rack.label R1 becomes Core rack: the old value moves into history and the new \
             provenance record supersedes the old one.",
            base(),
            |g| {
                g.begin_batch(batch_id(1), "rename rack").unwrap();
                g.set_field(
                    rack(),
                    RackField::Label.key(),
                    Text("Core rack".into()),
                    prov(120),
                )
                .unwrap();
                g.end_batch().unwrap();
            },
        ),
        scenario(
            "history-retention",
            "Rack.label already has 20 superseded values; one more set triggers the retention \
             rule (16 most recent plus the earliest of each origin) and a truncated count.",
            {
                let mut g = base();
                for i in 0..20u128 {
                    g.begin_batch(batch_id(10 + i), "relabel").unwrap();
                    g.set_field(
                        rack(),
                        RackField::Label.key(),
                        Text(format!("L{i}")),
                        prov(200 + i),
                    )
                    .unwrap();
                    g.end_batch().unwrap();
                }
                g
            },
            |g| {
                g.begin_batch(batch_id(1), "relabel").unwrap();
                g.set_field(
                    rack(),
                    RackField::Label.key(),
                    Text("L20".into()),
                    prov(300),
                )
                .unwrap();
                g.end_batch().unwrap();
            },
        ),
        scenario(
            "clear-field",
            "Rack.height_u is cleared: the slot goes, history gains the value and then an \
             unknown entry carrying the clear's provenance.",
            base(),
            |g| {
                g.begin_batch(batch_id(1), "clear height").unwrap();
                g.clear_field(rack(), RackField::HeightU.key(), prov(130))
                    .unwrap();
                g.end_batch().unwrap();
            },
        ),
        scenario(
            "assert-absent",
            "Chassis.serial is asserted absent where nothing was recorded before.",
            base(),
            |g| {
                g.begin_batch(batch_id(1), "no serial").unwrap();
                g.assert_absent(chassis_node.into(), ChassisField::Serial.key(), prov(140))
                    .unwrap();
                g.end_batch().unwrap();
            },
        ),
        scenario(
            "tombstone",
            "The Rack and its HasRack edge are tombstoned, node first, one op per element.",
            base(),
            |g| {
                g.begin_batch(batch_id(1), "remove rack").unwrap();
                g.tombstone_exact(rack(), Timestamp(AT + 5_000), me())
                    .unwrap();
                g.tombstone_exact(
                    fathom_graph::EdgeId {
                        kind: EdgeKind::HasRack,
                        ulid: ulid(HAS_RACK),
                    }
                    .into(),
                    Timestamp(AT + 5_000),
                    me(),
                )
                .unwrap();
                g.end_batch().unwrap();
            },
        ),
        scenario(
            "revive",
            "The Rack was tombstoned in an earlier batch; this one revives it.",
            {
                let mut g = base();
                g.begin_batch(batch_id(5), "remove rack").unwrap();
                g.tombstone_exact(rack(), Timestamp(AT + 5_000), me())
                    .unwrap();
                g.end_batch().unwrap();
                g
            },
            |g| {
                g.begin_batch(batch_id(1), "restore rack").unwrap();
                g.revive(rack(), Timestamp(AT + 6_000), me()).unwrap();
                g.end_batch().unwrap();
            },
        ),
    ];

    // An undo: batch X relabels the rack, the change reverses X with a
    // comment and restores the old value.
    let mut with_x = base();
    with_x.begin_batch(batch_id(50), "relabel").unwrap();
    with_x
        .set_field(rack(), RackField::Label.key(), Text("R9".into()), prov(150))
        .unwrap();
    with_x.end_batch().unwrap();
    out.push(scenario(
        "undo-with-reverses",
        "An undo batch: reverses the earlier relabel, carries a comment, and sets the label \
         back to R1 under a new provenance record.",
        with_x,
        |g| {
            g.begin_batch(batch_id(1), "undo relabel").unwrap();
            g.set_batch_reverses(batch_id(50)).unwrap();
            g.set_batch_comment(Text("put it back".into())).unwrap();
            g.set_field(rack(), RackField::Label.key(), Text("R1".into()), prov(151))
                .unwrap();
            g.end_batch().unwrap();
        },
    ));
    out
}

fn vectors_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../client/src/document/vectors/change")
}

fn meta(s: &Scenario) -> String {
    format!(
        "{{\n  \"name\": \"{}\",\n  \"description\": \"{}\",\n  \"actor\": \"{}\"\n}}\n",
        s.name,
        s.description,
        ulid(7).encode()
    )
}

fn files(s: &Scenario) -> [(&'static str, Vec<u8>); 4] {
    [
        ("before.plain", write_plain(&s.before).unwrap()),
        ("change", write_change(&change_of(&s.after))),
        ("after.plain", write_plain(&s.after).unwrap()),
        ("meta.json", meta(s).into_bytes()),
    ]
}

#[test]
fn applying_each_change_to_its_before_reproduces_the_after() {
    for s in scenarios() {
        let before = read_plain(&write_plain(&s.before).unwrap()).unwrap();
        let change = read_change(&write_change(&change_of(&s.after))).unwrap();
        let mut applied = before;
        apply_change(&mut applied, &change, me()).unwrap_or_else(|e| panic!("{}: {e}", s.name));
        assert_eq!(
            write_plain(&applied).unwrap(),
            write_plain(&s.after).unwrap(),
            "{}",
            s.name
        );
    }
}

#[test]
fn a_change_document_reads_back_byte_identical() {
    for s in scenarios() {
        let bytes = write_change(&change_of(&s.after));
        assert_eq!(
            write_change(&read_change(&bytes).unwrap()),
            bytes,
            "{}",
            s.name
        );
    }
}

#[test]
fn the_fixtures_on_disk_are_what_the_engine_writes() {
    for s in scenarios() {
        for (file, bytes) in files(&s) {
            let path = vectors_dir().join(s.name).join(file);
            let on_disk = fs::read(&path).unwrap_or_else(|_| {
                panic!(
                    "{} is missing; run this file's generator (see its header)",
                    path.display()
                )
            });
            assert_eq!(
                on_disk,
                bytes,
                "{} is stale; regenerate the vectors",
                path.display()
            );
        }
    }
}

#[test]
#[ignore = "writes client/src/document/vectors/change/ -- run explicitly"]
fn write_change_vectors() {
    for s in scenarios() {
        let dir = vectors_dir().join(s.name);
        fs::create_dir_all(&dir).unwrap();
        for (file, bytes) in files(&s) {
            fs::write(dir.join(file), bytes).unwrap();
            println!("wrote {}/{}", s.name, file);
        }
    }
}

// ---------------------------------------------------------------------------
// Refusals

struct Build {
    ops: Vec<Op>,
    provenance: Vec<ProvenanceRecord>,
    values: Vec<Json>,
}

impl Build {
    fn new() -> Self {
        Build {
            ops: Vec::new(),
            provenance: Vec::new(),
            values: Vec::new(),
        }
    }
    fn prov(mut self, p: ProvenanceRecord) -> Self {
        self.provenance.push(p);
        self.provenance.sort_by_key(|r| r.id);
        self
    }
    fn op(mut self, op: Op) -> Self {
        self.ops.push(op);
        self
    }
    fn set(self, element: ElementId, key: fathom_ir::bag::FieldKey, value: Json, n: u128) -> Self {
        let mut b = self.prov(prov(n)).op(Op::SetField {
            element,
            key,
            presence: StoredPresence::Set,
            prov: prov(n).id,
        });
        b.values.push(value);
        b
    }
    fn text(self, element: ElementId, key: fathom_ir::bag::FieldKey, text: &str, n: u128) -> Self {
        let json = Json::Str(text.to_owned());
        self.set(element, key, json, n)
    }
    fn build(self, n: u128) -> Change {
        Change {
            batch: Batch {
                id: batch_id(500 + n),
                label: "test".into(),
                ops: self.ops,
                comment: None,
                reverses: None,
            },
            provenance: self.provenance,
            values: self.values,
        }
    }
}

fn refused(g: &Graph, c: &Change) -> ChangeError {
    let before = write_plain(g).unwrap();
    let mut trial = read_plain(&before).unwrap();
    let e = apply_change(&mut trial, c, me()).expect_err("must be refused");
    assert_eq!(
        write_plain(&trial).unwrap(),
        before,
        "refusal must leave the graph untouched"
    );
    e
}

fn add_node(kind: NodeKind, n: u128, p: u128) -> Build {
    Build::new().prov(prov(p)).op(Op::AddNode {
        node: node(kind, n),
        prov: prov(p).id,
    })
}

#[test]
fn an_undeclared_field_is_refused() {
    let c = Build::new()
        .text(
            node(NodeKind::Premises, PREMISES).into(),
            RackField::Label.key(),
            "x",
            900,
        )
        .build(1);
    assert!(matches!(
        refused(&base(), &c),
        ChangeError::Write(WriteError::UndeclaredField { .. })
    ));
}

#[test]
fn a_value_of_the_wrong_type_is_refused() {
    let c = Build::new()
        .set(
            rack(),
            RackField::HeightU.key(),
            Json::Str("tall".into()),
            900,
        )
        .build(1);
    assert!(matches!(refused(&base(), &c), ChangeError::Value(_)));
}

#[test]
fn an_edge_to_a_missing_node_is_refused() {
    let c = Build::new()
        .prov(prov(900))
        .op(Op::AddEdge {
            edge: fathom_graph::EdgeId {
                kind: EdgeKind::HasRack,
                ulid: ulid(901),
            },
            from: node(NodeKind::Premises, PREMISES),
            to: node(NodeKind::Rack, 999),
            prov: prov(900).id,
        })
        .build(1);
    assert!(matches!(
        refused(&base(), &c),
        ChangeError::Write(WriteError::MissingEndpoint { .. })
    ));
}

#[test]
fn an_edge_between_the_wrong_kinds_is_refused() {
    let c = Build::new()
        .prov(prov(900))
        .op(Op::AddEdge {
            edge: fathom_graph::EdgeId {
                kind: EdgeKind::HasRack,
                ulid: ulid(901),
            },
            from: node(NodeKind::Device, DEVICE),
            to: node(NodeKind::Rack, RACK),
            prov: prov(900).id,
        })
        .build(1);
    assert!(matches!(
        refused(&base(), &c),
        ChangeError::Write(WriteError::EndpointKind { .. })
    ));
}

#[test]
fn a_second_mounted_in_for_a_chassis_is_refused() {
    let mount = |edge: u128, n: u128| {
        Build::new().prov(prov(n)).op(Op::AddEdge {
            edge: fathom_graph::EdgeId {
                kind: EdgeKind::MountedIn,
                ulid: ulid(edge),
            },
            from: node(NodeKind::Chassis, CHASSIS),
            to: node(NodeKind::Rack, RACK),
            prov: prov(n).id,
        })
    };
    let mut g = base();
    apply_change(&mut g, &mount(910, 910).build(1), me()).unwrap();
    assert!(matches!(
        refused(&g, &mount(911, 911).build(2)),
        ChangeError::Write(WriteError::OutBoundExceeded { .. })
    ));
}

/// Tombstone an edge and replace it with one whose id sorts *before* it: the
/// write path counts live edges, so it is legal, and the face must load again.
fn replaced_edge_round_trips(kind: EdgeKind, from: NodeId, to: NodeId, old: u128, new: u128) {
    let mut g = base();
    // `old` may already be in `base`; add it only when it is not.
    if g.edge(fathom_graph::EdgeId {
        kind,
        ulid: ulid(old),
    })
    .is_none()
    {
        g.begin_batch(batch_id(801), "first").unwrap();
        g.insert_edge(kind, ulid(old), from, to, prov(801)).unwrap();
        g.end_batch().unwrap();
    }
    g.begin_batch(batch_id(802), "remove").unwrap();
    g.tombstone_exact(
        fathom_graph::EdgeId {
            kind,
            ulid: ulid(old),
        }
        .into(),
        Timestamp(AT),
        me(),
    )
    .unwrap();
    g.end_batch().unwrap();
    g.begin_batch(batch_id(803), "replace").unwrap();
    g.insert_edge(kind, ulid(new), from, to, prov(823)).unwrap();
    g.end_batch().unwrap();

    let bytes = write_plain(&g).unwrap();
    let back = read_plain(&bytes).expect("a face the write path produced must read back");
    assert_eq!(write_plain(&back).unwrap(), bytes);
}

#[test]
fn a_tombstoned_edge_replaced_by_one_with_a_smaller_id_still_loads() {
    replaced_edge_round_trips(
        EdgeKind::MountedIn,
        node(NodeKind::Chassis, CHASSIS),
        node(NodeKind::Rack, RACK),
        911,
        905,
    );
    // Containment: HasRack (id 5 in `base`) replaced by id 4.
    replaced_edge_round_trips(
        EdgeKind::HasRack,
        node(NodeKind::Premises, PREMISES),
        node(NodeKind::Rack, RACK),
        HAS_RACK,
        4,
    );
}

#[test]
fn a_reused_element_id_is_refused() {
    let c = add_node(NodeKind::Rack, RACK, 900).build(1);
    assert!(matches!(
        refused(&base(), &c),
        ChangeError::Write(WriteError::UlidReused { .. })
    ));
}

#[test]
fn provenance_naming_someone_else_is_refused() {
    let p = prov_by(900, someone_else());
    let c = Build::new()
        .prov(p.clone())
        .op(Op::AddNode {
            node: node(NodeKind::Rack, 901),
            prov: p.id,
        })
        .build(1);
    assert!(matches!(
        refused(&base(), &c),
        ChangeError::WrongAuthor { .. }
    ));
}

#[test]
fn a_tombstone_or_revive_naming_someone_else_is_refused() {
    for revive in [false, true] {
        let op = if revive {
            Op::Revive {
                element: rack(),
                at: Timestamp(1),
                by: someone_else(),
            }
        } else {
            Op::Tombstone {
                element: rack(),
                at: Timestamp(1),
                by: someone_else(),
            }
        };
        let c = Build::new().op(op).build(1);
        assert!(matches!(
            refused(&base(), &c),
            ChangeError::WrongAuthor { .. }
        ));
    }
}

#[test]
fn a_provenance_id_already_in_the_graph_is_refused() {
    let c = add_node(NodeKind::Rack, 901, 1).build(1);
    assert!(matches!(
        refused(&base(), &c),
        ChangeError::ProvenanceKnown { .. }
    ));
}

#[test]
fn a_batch_id_already_in_the_log_is_refused() {
    let mut c = add_node(NodeKind::Rack, 901, 900).build(1);
    c.batch.id = batch_id(0);
    assert!(matches!(
        refused(&base(), &c),
        ChangeError::Write(WriteError::BatchIdReused { .. })
    ));
}

#[test]
fn reversing_another_persons_batch_is_refused() {
    let mut g = base();
    g.begin_batch(batch_id(60), "theirs").unwrap();
    g.set_field(
        rack(),
        RackField::Label.key(),
        Text("theirs".into()),
        prov_by(600, someone_else()),
    )
    .unwrap();
    g.end_batch().unwrap();

    let mut c = Build::new()
        .text(rack(), RackField::Label.key(), "R1", 901)
        .build(1);
    c.batch.reverses = Some(batch_id(60));
    assert!(matches!(
        refused(&g, &c),
        ChangeError::ReversesOthers { .. }
    ));

    // One of mine, and one the log does not hold.
    c.batch.reverses = Some(batch_id(0));
    let mut ok = g.clone();
    apply_change(&mut ok, &c, me()).unwrap();
    let mut c2 = Build::new()
        .text(rack(), RackField::Label.key(), "R1", 902)
        .build(2);
    c2.batch.reverses = Some(batch_id(777));
    assert!(matches!(
        refused(&g, &c2),
        ChangeError::ReversesUnknown { .. }
    ));
}

#[test]
fn a_credential_in_a_doc_or_a_link_title_is_refused() {
    let body = add_node(NodeKind::Doc, 950, 950)
        .text(
            node(NodeKind::Doc, 950).into(),
            DocField::Body.key(),
            "# Edge router\n\nwifi psk=Str0ngP@ssw0rd!\n",
            951,
        )
        .build(1);
    assert!(matches!(
        refused(&base(), &body),
        ChangeError::Credential {
            kind: "Doc",
            line: 3
        }
    ));
    let title = add_node(NodeKind::DocLink, 960, 960)
        .text(
            node(NodeKind::DocLink, 960).into(),
            DocLinkField::Title.key(),
            "pre-shared-key=Str0ngP@ssw0rd!",
            961,
        )
        .build(2);
    assert!(matches!(
        refused(&base(), &title),
        ChangeError::Credential {
            kind: "DocLink",
            line: 1
        }
    ));
}

#[test]
fn a_credential_in_a_capture_or_a_note_is_refused() {
    // Space-separated device forms (CLAUDE.md rule 2), not what the detector needs.
    let capture = add_node(NodeKind::Capture, 920, 920)
        .text(
            node(NodeKind::Capture, 920).into(),
            CaptureField::Text.key(),
            "interfaces {\n  ge-0/0/0 { }\n}\nenable secret cisco123\n",
            921,
        )
        .build(1);
    assert!(matches!(
        refused(&base(), &capture),
        ChangeError::Credential {
            kind: "Capture",
            line: 4
        }
    ));
    let note = add_node(NodeKind::Note, 930, 930)
        .text(
            node(NodeKind::Note, 930).into(),
            NoteField::Text.key(),
            "pre-shared-key=Str0ngP@ssw0rd!",
            931,
        )
        .build(2);
    assert!(matches!(
        refused(&base(), &note),
        ChangeError::Credential {
            kind: "Note",
            line: 1
        }
    ));
    // Ordinary prose passes.
    let fine = add_node(NodeKind::Note, 940, 940)
        .text(
            node(NodeKind::Note, 940).into(),
            NoteField::Text.key(),
            "replaced the key switch in rack 4",
            941,
        )
        .build(3);
    apply_change(&mut base(), &fine, me()).unwrap();
}

/// Full-length device secrets (CLAUDE.md rule 2): a real MD5-crypt hash on a
/// bare-space `enable secret 5`, and a real-length SHA-512 crypt on a Junos line.
const CISCO_SECRET: &str = "enable secret 5 $1$mERr$hx5rVt7rPNoS4wqbXKX7m0";
const JUNOS_SECRET: &str = "set system root-authentication encrypted-password \"$6$9aZ0Cq3o$Qo1fJ0mH1jXy2x6E3C8kP5W7vNnR4tY1uB0sD2gHfL9aKjM3pQwErTyUiOp5AsDfGhJkLzXcVbNm1QwErTyUiOpAsDfGh.\"";

#[test]
fn a_secret_set_and_then_overwritten_in_one_batch_is_still_refused() {
    for secret in [CISCO_SECRET, JUNOS_SECRET] {
        let el: ElementId = node(NodeKind::Capture, 950).into();
        let c = add_node(NodeKind::Capture, 950, 950)
            .text(el, CaptureField::Text.key(), secret, 951)
            .text(el, CaptureField::Text.key(), "interfaces { }\n", 952)
            .build(1);
        assert!(
            matches!(
                refused(&base(), &c),
                ChangeError::Credential {
                    kind: "Capture",
                    line: 1
                }
            ),
            "{secret}"
        );
    }
    // The same on an existing note, where the end state is clean.
    let mut g = base();
    let add = add_node(NodeKind::Note, 960, 960)
        .text(
            node(NodeKind::Note, 960).into(),
            NoteField::Text.key(),
            "replaced the key switch",
            961,
        )
        .build(2);
    apply_change(&mut g, &add, me()).unwrap();
    let el: ElementId = node(NodeKind::Note, 960).into();
    let c = Build::new()
        .text(
            el,
            NoteField::Text.key(),
            "pre-shared-key=Str0ngP@ssw0rd!",
            962,
        )
        .text(el, NoteField::Text.key(), "fine", 963)
        .build(3);
    assert!(matches!(
        refused(&g, &c),
        ChangeError::Credential { kind: "Note", .. }
    ));
}

#[test]
fn a_secret_in_a_fields_history_is_found_in_a_whole_graph() {
    for secret in [CISCO_SECRET, JUNOS_SECRET] {
        let mut g = base();
        g.begin_batch(batch_id(70), "history").unwrap();
        let cap = g
            .insert_node(NodeKind::Capture, ulid(970), prov(970))
            .unwrap();
        g.set_field(
            cap.into(),
            CaptureField::Text.key(),
            Text(secret.into()),
            prov(971),
        )
        .unwrap();
        g.set_field(
            cap.into(),
            CaptureField::Text.key(),
            Text("interfaces { }\n".into()),
            prov(972),
        )
        .unwrap();
        g.end_batch().unwrap();
        assert!(
            fathom_workspace::find_credential(&g).is_some(),
            "a secret only in history must still be found: {secret}"
        );
    }
}

#[test]
fn a_change_is_refused_when_its_pieces_do_not_agree() {
    // No ops.
    assert!(matches!(
        refused(&base(), &Build::new().build(1)),
        ChangeError::Empty
    ));
    // A provenance record no op names.
    let c = add_node(NodeKind::Rack, 901, 900).prov(prov(901)).build(2);
    assert!(matches!(
        refused(&base(), &c),
        ChangeError::ProvenanceMismatch
    ));
    // A value too many.
    let mut c = add_node(NodeKind::Rack, 902, 902).build(3);
    c.values.push(Json::Int(1));
    assert!(matches!(
        refused(&base(), &c),
        ChangeError::ValueCount { .. }
    ));
    // A caller-supplied `supersedes`.
    let mut c = Build::new()
        .text(rack(), RackField::Label.key(), "x", 903)
        .build(4);
    c.provenance[0].supersedes = Some(prov(4).id);
    assert!(matches!(
        refused(&base(), &c),
        ChangeError::Write(WriteError::SupersedesIsStoreOwned { .. })
    ));
}

#[test]
fn a_refusal_halfway_through_leaves_the_graph_as_it_was() {
    // The first op is fine, the second names a node that does not exist.
    let c = add_node(NodeKind::Rack, 950, 950)
        .text(
            node(NodeKind::Rack, 998).into(),
            RackField::Label.key(),
            "x",
            951,
        )
        .build(1);
    let mut g = base();
    let before = write_plain(&g).unwrap();
    assert!(apply_change(&mut g, &c, me()).is_err());
    assert_eq!(write_plain(&g).unwrap(), before);
}

#[test]
fn a_tombstone_replays_exactly_and_does_not_cascade() {
    let mut g = base();
    let c = Build::new()
        .op(Op::Tombstone {
            element: node(NodeKind::Device, DEVICE).into(),
            at: Timestamp(5),
            by: me(),
        })
        .build(1);
    apply_change(&mut g, &c, me()).unwrap();
    let chassis = g.node(node(NodeKind::Chassis, CHASSIS)).unwrap();
    assert!(chassis.absent_since.is_none(), "the child is its own op");
}

#[test]
fn the_change_header_is_checked() {
    let good = write_change(&change_of(&scenarios()[0].after));
    assert!(matches!(
        read_change(b"fathom-plain 1\n"),
        Err(ChangeError::NotChange)
    ));
    let text = String::from_utf8(good.clone()).unwrap();
    assert!(matches!(
        read_change(text.replacen("change 1", "change 2", 1).as_bytes()),
        Err(ChangeError::UnsupportedFormat { .. })
    ));
    assert!(matches!(
        read_change(text.replacen("schema 0.", "schema 9.", 1).as_bytes()),
        Err(ChangeError::SchemaVersion { .. })
    ));
    assert!(read_change(&good).is_ok());
}

#[test]
fn premises_fields_are_not_rack_fields() {
    // Guards the first refusal test against a schema change making it vacuous.
    assert!(!fathom_ir::generated::ir_types::NodeKind::Premises
        .fields()
        .contains(&RackField::Label.key()));
    let _ = PremisesField::Label;
}
