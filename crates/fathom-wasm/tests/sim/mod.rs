//! A seeded writer of realistic estates, through the real write path, for the `OP_SYNC` tests.
//!
//! Devices with chassis, ports, interfaces, units, addresses, VLAN membership and power supplies;
//! cables with `Terminates` edges; field sets, absences and clears; tombstones of nodes with
//! subtrees and of edges; revives; undo-style reversal batches.

#![allow(dead_code)]

use fathom_graph::{
    Actor, BatchId, Confidence, EdgeId, ElementId, Graph, NodeId, Op, Origin, ProvenanceId,
    ProvenanceRecord, Timestamp, UserId,
};
use fathom_id::Ulid;
use fathom_ir::bag::FieldKey;
use fathom_ir::generated::ir_types::{EdgeKind, NodeKind, FIELD_KEYS};
use fathom_rules::graph::box_from_text;
use fathom_wasm::protocol::{decode_reply, ReplyView, FACE_CHECK};
use fathom_wasm::shell::Shell;
use fathom_wasm::{OP_CHECKS, OP_LOAD_PLAIN, OP_SYNC};

const T0: u64 = 1_790_899_200_000;

pub struct Rng(pub u64);

impl Rng {
    pub fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }
    pub fn below(&mut self, n: usize) -> usize {
        (self.next() % n.max(1) as u64) as usize
    }
    pub fn pick<'a, T>(&mut self, v: &'a [T]) -> Option<&'a T> {
        if v.is_empty() {
            None
        } else {
            Some(&v[self.below(v.len())])
        }
    }
    pub fn chance(&mut self, pct: usize) -> bool {
        self.below(100) < pct
    }
}

pub fn key(owner: &str, field: &str) -> FieldKey {
    let full = format!("{owner}.{field}");
    FieldKey(
        FIELD_KEYS
            .iter()
            .find(|(n, _)| *n == full)
            .unwrap_or_else(|| panic!("{full} is not a declared field"))
            .1,
    )
}

/// The writer's own estate: the design the page would hold.
pub struct Sim {
    pub g: Graph,
    pub rng: Rng,
    n: u128,
    batches: u128,
}

/// What one random set may write: owner kind name, field, candidate tokens.
const SETS: &[(&str, &str, &[&str])] = &[
    (
        "Cable",
        "media",
        &["cat5e", "cat6", "cat6a", "smf", "mmf", "twinax", "power"],
    ),
    (
        "PhysicalPort",
        "connector",
        &["rj45", "sfp_plus", "sfp", "qsfp", "c13", "c14"],
    ),
    ("PhysicalPort", "speed_max", &["1000000000", "10000000000"]),
    ("PhysicalPort", "transceiver", &["present"]),
    (
        "Interface",
        "speed",
        &["1000000000", "10000000000", "5000000000"],
    ),
    (
        "Address",
        "value",
        &[
            "10.0.0.1/30",
            "10.0.0.2/30",
            "10.0.0.1/24",
            "10.0.1.1/30",
            "10.0.0.0/30",
            "10.0.0.3/30",
        ],
    ),
    ("Vlan", "vlan_id", &["10", "20", "30"]),
    ("VlanMember", "mode", &["access", "trunk"]),
    ("Terminates", "end", &["a", "b"]),
    (
        "Device",
        "hostname",
        &["alpha", "bravo", "charlie", "delta", "echo"],
    ),
];

impl Sim {
    pub fn new(seed: u64) -> Sim {
        Sim {
            g: Graph::new(),
            rng: Rng(seed.wrapping_mul(0x2545_F491_4F6C_DD1D) ^ 0xA5A5),
            n: 1,
            batches: 1,
        }
    }

    pub fn ulid(&mut self) -> Ulid {
        self.n += 1;
        Ulid::from_parts(T0, self.n).expect("48-bit")
    }

    pub fn prov(&mut self) -> ProvenanceRecord {
        let id = ProvenanceId(self.ulid());
        ProvenanceRecord {
            id,
            origin: Origin::Hand,
            asserted_at: Timestamp(T0 + self.n as u64),
            asserted_by: Actor::User(UserId(Ulid::from_parts(T0, 7).unwrap())),
            confidence: Confidence::Asserted,
            supersedes: None,
        }
    }

    pub fn actor() -> Actor {
        Actor::User(UserId(Ulid::from_parts(T0, 7).unwrap()))
    }

    pub fn at(&mut self) -> Timestamp {
        self.n += 1;
        Timestamp(T0 + self.n as u64)
    }

    pub fn node(&mut self, kind: NodeKind) -> Option<NodeId> {
        let (u, p) = (self.ulid(), self.prov());
        self.g.insert_node(kind, u, p).ok()
    }

    pub fn edge(&mut self, kind: EdgeKind, from: NodeId, to: NodeId) -> Option<EdgeId> {
        let (u, p) = (self.ulid(), self.prov());
        self.g.insert_edge(kind, u, from, to, p).ok()
    }

    pub fn set(&mut self, el: ElementId, owner: &str, field: &str, text: &str) {
        let k = key(owner, field);
        if let Ok(v) = box_from_text(k, text) {
            let p = self.prov();
            let _ = self.g.set_field_boxed(el, k, v, p);
        }
    }

    pub fn live_nodes(&self, kind: NodeKind) -> Vec<NodeId> {
        self.g
            .nodes_of_kind(kind)
            .filter(|n| n.absent_since.is_none())
            .map(|n| n.id)
            .collect()
    }

    pub fn live_edges(&self, kind: EdgeKind) -> Vec<EdgeId> {
        self.g
            .edges_of_kind(kind)
            .filter(|e| e.absent_since.is_none())
            .map(|e| e.id)
            .collect()
    }

    /// A device with a chassis, ports, interfaces, units, an address and a VLAN, and two
    /// power supplies half the time.
    pub fn add_device(&mut self) {
        let Some(dev) = self.node(NodeKind::Device) else {
            return;
        };
        let names = ["alpha", "bravo", "charlie", "delta", "echo", "fox", "golf"];
        let name = format!("{}-{}", names[self.rng.below(names.len())], self.n);
        self.set(ElementId::Node(dev), "Device", "hostname", &name);
        self.set(ElementId::Node(dev), "Device", "platform", "junos-ex");
        self.set(ElementId::Node(dev), "Device", "role", "switch");
        let Some(ch) = self.node(NodeKind::Chassis) else {
            return;
        };
        self.edge(EdgeKind::HasChassis, dev, ch);
        self.set(ElementId::Node(ch), "Chassis", "member_index", "0");
        let vlan = self.node(NodeKind::Vlan);
        if let Some(v) = vlan {
            self.edge(EdgeKind::HasVlan, dev, v);
            let id = ["10", "20", "30"][self.rng.below(3)];
            self.set(ElementId::Node(v), "Vlan", "vlan_id", id);
        }
        for port_ix in 0..2 + self.rng.below(3) {
            let Some(p) = self.node(NodeKind::PhysicalPort) else {
                continue;
            };
            self.edge(EdgeKind::HasPort, ch, p);
            let sfp = self.rng.chance(40);
            self.set(
                ElementId::Node(p),
                "PhysicalPort",
                "label",
                &format!("ge-0/0/{port_ix}"),
            );
            self.set(
                ElementId::Node(p),
                "PhysicalPort",
                "connector",
                if sfp { "sfp_plus" } else { "rj45" },
            );
            self.set(ElementId::Node(p), "PhysicalPort", "service", "ethernet");
            if sfp {
                let el = ElementId::Node(p);
                if self.rng.chance(50) {
                    let pr = self.prov();
                    let _ = self
                        .g
                        .assert_absent(el, key("PhysicalPort", "transceiver"), pr);
                } else {
                    self.set(el, "PhysicalPort", "transceiver", "present");
                }
            }
            if self.rng.chance(70) {
                let Some(i) = self.node(NodeKind::Interface) else {
                    continue;
                };
                self.edge(EdgeKind::HasInterface, dev, i);
                self.edge(EdgeKind::Occupies, i, p);
                self.set(
                    ElementId::Node(i),
                    "Interface",
                    "name",
                    &format!("ge-0/0/{port_ix}"),
                );
                self.set(ElementId::Node(i), "Interface", "form", "ethernet");
                if self.rng.chance(60) {
                    let sp = ["1000000000", "10000000000"][self.rng.below(2)];
                    self.set(ElementId::Node(i), "Interface", "speed", sp);
                }
                if let Some(u) = self.node(NodeKind::LogicalUnit) {
                    self.edge(EdgeKind::HasUnit, i, u);
                    self.set(ElementId::Node(u), "LogicalUnit", "index", "0");
                    if self.rng.chance(60) {
                        if let Some(a) = self.node(NodeKind::Address) {
                            self.edge(EdgeKind::HasAddress, u, a);
                            let (_, _, vals) = SETS[5];
                            let v = vals[self.rng.below(vals.len())];
                            self.set(ElementId::Node(a), "Address", "value", v);
                            self.set(ElementId::Node(a), "Address", "family", "inet");
                        }
                    }
                    if let (Some(v), true) = (vlan, self.rng.chance(60)) {
                        if let Some(e) = self.edge(EdgeKind::VlanMember, u, v) {
                            let m = ["access", "trunk"][self.rng.below(2)];
                            self.set(ElementId::Edge(e), "VlanMember", "mode", m);
                        }
                    }
                }
            }
        }
        if self.rng.chance(50) {
            for slot in 0..2 {
                let Some(ps) = self.node(NodeKind::PowerSupply) else {
                    continue;
                };
                self.edge(EdgeKind::FittedIn, ch, ps);
                self.set(
                    ElementId::Node(ps),
                    "PowerSupply",
                    "slot",
                    &slot.to_string(),
                );
                if let Some(inlet) = self.node(NodeKind::PhysicalPort) {
                    self.edge(EdgeKind::HasPort, ps, inlet);
                    self.set(
                        ElementId::Node(inlet),
                        "PhysicalPort",
                        "label",
                        &format!("AC {slot}"),
                    );
                    self.set(ElementId::Node(inlet), "PhysicalPort", "connector", "c14");
                    self.set(ElementId::Node(inlet), "PhysicalPort", "service", "power");
                }
            }
        }
    }

    pub fn add_cable(&mut self) {
        let ports = self.live_nodes(NodeKind::PhysicalPort);
        let (Some(a), Some(b)) = (
            self.rng.pick(&ports).copied(),
            self.rng.pick(&ports).copied(),
        ) else {
            return;
        };
        if a == b {
            return;
        }
        let Some(c) = self.node(NodeKind::Cable) else {
            return;
        };
        if self.rng.chance(75) {
            let m = ["cat5e", "cat6", "cat6a", "smf", "mmf", "twinax", "power"][self.rng.below(7)];
            self.set(ElementId::Node(c), "Cable", "media", m);
        }
        for (end, p) in [("a", a), ("b", b)] {
            if self.rng.chance(92) {
                if let Some(e) = self.edge(EdgeKind::Terminates, c, p) {
                    self.set(ElementId::Edge(e), "Terminates", "end", end);
                }
            }
        }
    }

    pub fn set_random(&mut self) {
        let (owner, field, vals) = SETS[self.rng.below(SETS.len())];
        let text = vals[self.rng.below(vals.len())];
        if let Some(kind) = NodeKind::from_name(owner) {
            let live = self.live_nodes(kind);
            if let Some(n) = self.rng.pick(&live).copied() {
                self.set(ElementId::Node(n), owner, field, text);
            }
        } else if let Some(kind) = EdgeKind::from_name(owner) {
            let live = self.live_edges(kind);
            if let Some(e) = self.rng.pick(&live).copied() {
                self.set(ElementId::Edge(e), owner, field, text);
            }
        }
    }

    pub fn absent_or_clear(&mut self) {
        let (owner, field, _) = SETS[self.rng.below(SETS.len())];
        let Some(kind) = NodeKind::from_name(owner) else {
            return;
        };
        let live = self.live_nodes(kind);
        let Some(n) = self.rng.pick(&live).copied() else {
            return;
        };
        let (k, p) = (key(owner, field), self.prov());
        let el = ElementId::Node(n);
        if self.rng.chance(50) {
            let _ = self.g.assert_absent(el, k, p);
        } else {
            let _ = self.g.clear_field(el, k, p);
        }
    }

    pub fn tombstone_node(&mut self) {
        let kind = [
            NodeKind::Device,
            NodeKind::Cable,
            NodeKind::PhysicalPort,
            NodeKind::Address,
            NodeKind::Vlan,
            NodeKind::Interface,
            NodeKind::PowerSupply,
        ][self.rng.below(7)];
        let live = self.live_nodes(kind);
        if let Some(n) = self.rng.pick(&live).copied() {
            let (at, by) = (self.at(), Self::actor());
            let _ = self.g.tombstone(ElementId::Node(n), at, by);
        }
    }

    pub fn tombstone_edge(&mut self) {
        let kind = [
            EdgeKind::Terminates,
            EdgeKind::Terminates,
            EdgeKind::VlanMember,
            EdgeKind::HasAddress,
            EdgeKind::Occupies,
            EdgeKind::FittedIn,
        ][self.rng.below(6)];
        let live = self.live_edges(kind);
        if let Some(e) = self.rng.pick(&live).copied() {
            let (at, by) = (self.at(), Self::actor());
            let _ = self.g.tombstone(ElementId::Edge(e), at, by);
        }
    }

    pub fn revive(&mut self) {
        let mut gone: Vec<ElementId> = self
            .g
            .nodes()
            .filter(|n| n.absent_since.is_some())
            .map(|n| ElementId::Node(n.id))
            .collect();
        gone.extend(
            self.g
                .edges()
                .filter(|e| e.absent_since.is_some())
                .map(|e| ElementId::Edge(e.id)),
        );
        if let Some(el) = self.rng.pick(&gone).copied() {
            let (at, by) = (self.at(), Self::actor());
            let _ = self.g.revive(el, at, by);
        }
    }

    /// An undo of an earlier batch: what it added is tombstoned, what it tombstoned is
    /// revived, what it set is set back to nothing a rule can read (cleared). The batch is
    /// marked as the reversal.
    pub fn reverse(&mut self, of: BatchId, ops: Vec<Op>) {
        let _ = self.g.set_batch_reverses(of);
        let _ = self
            .g
            .set_batch_comment(fathom_ir::scalar::Text("undo".into()));
        for op in ops.into_iter().rev() {
            let (at, by) = (self.at(), Self::actor());
            match op {
                Op::AddNode { node, .. } => {
                    let _ = self.g.tombstone(ElementId::Node(node), at, by);
                }
                Op::AddEdge { edge, .. } => {
                    let _ = self.g.tombstone(ElementId::Edge(edge), at, by);
                }
                Op::Tombstone { element, .. } => {
                    let _ = self.g.revive(element, at, by);
                }
                Op::Revive { element, .. } => {
                    let _ = self.g.tombstone(element, at, by);
                }
                Op::SetField { element, key, .. } => {
                    let p = self.prov();
                    let _ = self.g.clear_field(element, key, p);
                }
            }
        }
    }

    /// One batch of the caller's own writes.
    pub fn batch(&mut self, label: &str, f: impl FnOnce(&mut Sim)) -> BatchId {
        self.batches += 1;
        let id = BatchId(Ulid::from_parts(T0, 1_000_000 + self.batches).unwrap());
        self.g.begin_batch(id, label).unwrap();
        f(self);
        self.g.end_batch().unwrap()
    }

    /// One batch: one user intention.
    pub fn step(&mut self) {
        self.batches += 1;
        let id = BatchId(Ulid::from_parts(T0, 1_000_000 + self.batches).unwrap());
        self.g.begin_batch(id, "step").unwrap();
        let roll = self.rng.below(40);
        let mut reversed = false;
        match roll {
            0..=3 if self.live_nodes(NodeKind::Device).len() < 8 => self.add_device(),
            0..=3 => self.add_cable(),
            4..=10 => self.add_cable(),
            11..=18 => self.set_random(),
            19..=21 => self.absent_or_clear(),
            22..=24 => self.tombstone_node(),
            25..=27 => self.tombstone_edge(),
            28..=31 => self.revive(),
            32..=34 => {
                for _ in 0..1 + self.rng.below(3) {
                    self.set_random();
                }
            }
            _ => {
                // Reverse an earlier batch (and sometimes the reversal of a reversal).
                let log = self.g.log();
                if let Some(b) = (!log.is_empty()).then(|| log[self.rng.below(log.len())].clone()) {
                    reversed = true;
                    self.reverse(b.id, b.ops);
                }
            }
        }
        let _ = reversed;
        self.g.end_batch().unwrap();
    }
}

// --- the two modules --------------------------------------------------------

pub fn checks(shell: &mut Shell) -> Vec<u8> {
    shell.handle(OP_CHECKS, &[])
}

pub fn load(shell: &mut Shell, g: &Graph) {
    let reply = shell.handle(OP_LOAD_PLAIN, &fathom_workspace::write_plain(g).unwrap());
    if let Ok(ReplyView::Error(e)) = decode_reply(&reply) {
        panic!("load refused: {e:?}");
    }
}

pub fn sync_reply(shell: &mut Shell, g: &Graph, from: usize) -> Vec<u8> {
    shell.handle(
        OP_SYNC,
        &fathom_workspace::write_delta_since(g, from).unwrap(),
    )
}

/// Did `OP_SYNC` take the delta? The reply is the held estate's node and edge counts; they must
/// be the writer's own.
pub fn sync_took(reply: &[u8], g: &Graph) -> bool {
    let counts = [g.nodes().count() as u32, g.edges().count() as u32];
    reply.len() == 8
        && reply[..4] == counts[0].to_le_bytes()
        && reply[4..] == counts[1].to_le_bytes()
}

pub fn finding_rows(reply: &[u8]) -> Vec<Vec<String>> {
    match decode_reply(reply) {
        Ok(ReplyView::FaceRows(r)) => r
            .iter()
            .filter(|r| r.role == FACE_CHECK)
            .map(|r| r.strings.to_vec())
            .collect(),
        other => panic!("{other:?}"),
    }
}
