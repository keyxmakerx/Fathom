//! Three-state presence, provenance chaining, and bounded history.
//!
//! The distinction these tests protect is `11` §5.1's: `Absent` is *"we
//! looked and there is none"* and `Unknown` is *"nobody has said"*. A store
//! that collapses them is how `ipsec.pfs.absent` becomes untrustworthy.

use fathom_graph::{
    Actor, BatchId, Confidence, ElementId, Graph, NodeId, Origin, ProvenanceId, ProvenanceRecord,
    StoredPresence, Timestamp, UserId,
};
use fathom_id::Ulid;
use fathom_ir::bag::FieldError;
use fathom_ir::generated::accessors;
use fathom_ir::generated::ir_types::{DeviceField, IpsecPolicyField, NodeKind};
use fathom_ir::scalar::{DhGroup, Identifier};

const AT: u64 = 1_700_000_000_000;

fn ulid(n: u128) -> Ulid {
    Ulid::from_parts(AT, n).expect("48-bit timestamp")
}

struct Fx {
    g: Graph,
    next: u128,
}

impl Fx {
    fn new() -> Fx {
        let mut g = Graph::new();
        g.begin_batch(BatchId(ulid(0)), "fields fixture")
            .expect("open");
        Fx { g, next: 1 }
    }

    fn p(&mut self) -> ProvenanceRecord {
        let n = self.next;
        self.next += 1;
        ProvenanceRecord {
            id: ProvenanceId(ulid(1_000_000 + n)),
            origin: Origin::Hand,
            asserted_at: Timestamp(AT + n as u64),
            asserted_by: Actor::User(UserId(ulid(u128::MAX))),
            confidence: Confidence::Asserted,
            supersedes: None,
        }
    }

    fn node(&mut self, kind: NodeKind) -> NodeId {
        let n = self.next;
        self.next += 1;
        let p = self.p();
        self.g.insert_node(kind, ulid(n), p).expect("bare node")
    }
}

#[test]
fn unknown_is_a_missing_slot() {
    let mut fx = Fx::new();
    let device = ElementId::Node(fx.node(NodeKind::Device));
    let info =
        fx.g.presence(device, DeviceField::Hostname.key())
            .expect("declared field");
    assert_eq!(info.presence, StoredPresence::Unknown);
    assert_eq!(info.prov, None, "nothing to attribute");
    assert!(fx.g.history(device, DeviceField::Hostname.key()).is_none());
}

#[test]
fn absent_is_stored_and_distinct_from_unknown() {
    let mut fx = Fx::new();
    let policy = ElementId::Node(fx.node(NodeKind::IpsecPolicy));
    let pfs = IpsecPolicyField::PerfectForwardSecrecy.key();
    let p = fx.p();
    let asserted = p.id;
    fx.g.assert_absent(policy, pfs, p).expect("closed world");
    let info = fx.g.presence(policy, pfs).expect("declared field");
    assert_eq!(info.presence, StoredPresence::Absent);
    assert_eq!(info.prov, Some(asserted), "Absent carries its provenance");
    // A different field on the same node is still Unknown — absence is per
    // field, not per node.
    let other = IpsecPolicyField::Description.key();
    assert_eq!(
        fx.g.presence(policy, other).expect("declared").presence,
        StoredPresence::Unknown
    );
}

#[test]
fn accessor_reads_set_slot_and_misses_absent() {
    let mut fx = Fx::new();
    let id = fx.node(NodeKind::Device);
    let device = ElementId::Node(id);
    let p = fx.p();
    fx.g.set_field(
        device,
        DeviceField::Hostname.key(),
        Identifier("srx-a-01".to_owned()),
        p,
    )
    .expect("declared slot type");
    let node = fx.g.node(id).expect("stored");
    assert_eq!(
        accessors::device::hostname(node).expect("Set slot reads"),
        &Identifier("srx-a-01".to_owned())
    );
    // The generated accessors see `Missing` for Absent and Unknown alike; the
    // three-way distinction is `Graph::presence`.
    assert_eq!(
        accessors::device::os_version(node),
        Err(FieldError::Missing),
        "Unknown reads as Missing"
    );
    let p = fx.p();
    fx.g.assert_absent(device, DeviceField::OsVersion.key(), p)
        .expect("closed world");
    let node = fx.g.node(id).expect("stored");
    assert_eq!(
        accessors::device::os_version(node),
        Err(FieldError::Missing),
        "Absent reads as Missing too"
    );
    assert_eq!(
        fx.g.presence(device, DeviceField::OsVersion.key())
            .expect("declared")
            .presence,
        StoredPresence::Absent,
        "but the store still knows the difference"
    );
}

#[test]
fn clear_returns_unknown() {
    let mut fx = Fx::new();
    let policy = ElementId::Node(fx.node(NodeKind::IpsecPolicy));
    let pfs = IpsecPolicyField::PerfectForwardSecrecy.key();
    let p = fx.p();
    fx.g.set_field(policy, pfs, DhGroup::MODP2048, p)
        .expect("set");
    let p = fx.p();
    let clearing = p.id;
    fx.g.clear_field(policy, pfs, p).expect("clear");
    // 11 §8.5: clearing a field must produce Unknown, not Absent.
    let info = fx.g.presence(policy, pfs).expect("declared");
    assert_eq!(info.presence, StoredPresence::Unknown);
    assert_eq!(info.prov, None);
    // The clear is not silent: it is in the history and it is in the log.
    let history = fx.g.history(policy, pfs).expect("written before");
    let last = history.entries().last().expect("non-empty");
    assert_eq!(last.presence, StoredPresence::Unknown);
    assert_eq!(last.prov, clearing);
    assert!(fx.g.provenance(clearing).is_some());
}

#[test]
fn edits_never_overwrite_supersedes_chains() {
    let mut fx = Fx::new();
    let device = ElementId::Node(fx.node(NodeKind::Device));
    let key = DeviceField::Hostname.key();

    let p1 = fx.p();
    let first = p1.id;
    fx.g.set_field(device, key, Identifier("srx-a-01".to_owned()), p1)
        .expect("first assertion");
    let p2 = fx.p();
    let second = p2.id;
    fx.g.set_field(device, key, Identifier("srx-a-02".to_owned()), p2)
        .expect("re-assertion");

    // 11 §8.6: a new assertion produces a new record with `supersedes`
    // pointing at the old one. `supersedes` is store-owned; the caller passed
    // None both times.
    assert_eq!(
        fx.g.provenance(second).expect("interned").supersedes,
        Some(first)
    );
    assert_eq!(
        fx.g.provenance(first).expect("interned").supersedes,
        None,
        "the superseded record stays, unchanged"
    );
    // The replaced value lives in the side table, not in the node.
    let history = fx.g.history(device, key).expect("one edit");
    assert_eq!(history.entries().len(), 1);
    assert_eq!(history.entries()[0].prov, first);
    assert_eq!(history.entries()[0].presence, StoredPresence::Set);
    assert_eq!(
        history.entries()[0]
            .value
            .as_ref()
            .expect("value moved in")
            .downcast_ref::<Identifier>(),
        Some(&Identifier("srx-a-01".to_owned()))
    );
    assert_eq!(
        fx.g.presence(device, key).expect("declared").prov,
        Some(second)
    );
}

#[test]
fn history_retention_sixteen_plus_earliest() {
    let mut fx = Fx::new();
    let device = ElementId::Node(fx.node(NodeKind::Device));
    let key = DeviceField::Hostname.key();

    let mut written: Vec<ProvenanceId> = Vec::new();
    for i in 0..40u32 {
        let p = fx.p();
        written.push(p.id);
        fx.g.set_field(device, key, Identifier(format!("srx-a-{i:02}")), p)
            .expect("re-assertion");
    }
    // Each write after the first archives the slot the previous one left.
    let archived = written.len() - 1;
    let history = fx.g.history(device, key).expect("many edits");
    // 11 §8.6: the most recent 16, plus the earliest entry from each distinct
    // Origin discriminant. `Hand` is the only origin at this stage, so that is
    // one extra entry.
    assert_eq!(history.entries().len(), 17);
    assert_eq!(history.truncated(), (archived - 17) as u32);
    assert_eq!(
        history.entries()[0].prov,
        written[0],
        "the original assertion survives 40 edits"
    );
    assert_eq!(
        history.entries().last().expect("non-empty").prov,
        written[archived - 1],
        "and the newest archived entry is last"
    );
    // Truncation is counted, never silent.
    assert!(history.truncated() > 0);
}
