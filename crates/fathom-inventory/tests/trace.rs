//! Path trace on a small estate with a known path, each hop asserted.
//!
//! host-a --- sw-1 (VLAN 20) --- fw-1 --- patch panel --- rtr-1
//! 10.1.0.10/24                  10.1.0.1/24 (lan)   203.0.113.2/30
//!                               203.0.113.1/30 (wan)  10.8.0.1/16
//!
//! fw-1 holds a static route 10.8.0.0/16 via 203.0.113.2 and the lan->wan set.

use std::net::{IpAddr, Ipv4Addr};

use fathom_graph::{
    Actor, Confidence, ElementId, Graph, NodeId, Origin, ProvenanceId, ProvenanceRecord, Timestamp,
    UserId,
};
use fathom_id::Ulid;
use fathom_inventory::{trace, Flow, Trace};
use fathom_ir::generated::ir_types::{CableEnd, EdgeKind, NodeKind, PolicyAction, FIELD_KEYS};
use fathom_ir::scalar;
use fathom_ir::value::{AddressValue, L4Spec, NextHop, PolicyScope};

const TS0: u64 = 1_785_456_000_000;

struct B {
    g: Graph,
    next: u128,
}

fn fk(name: &str) -> fathom_ir::bag::FieldKey {
    let (_, k) = FIELD_KEYS
        .iter()
        .find(|(n, _)| *n == name)
        .unwrap_or_else(|| panic!("`{name}` is not a declared field"));
    fathom_ir::bag::FieldKey(*k)
}

fn prov() -> ProvenanceRecord {
    ProvenanceRecord {
        id: ProvenanceId(Ulid::from_parts(TS0, 9001).unwrap()),
        origin: Origin::Hand,
        asserted_at: Timestamp(TS0),
        asserted_by: Actor::User(UserId(Ulid::from_parts(TS0, 9000).unwrap())),
        confidence: Confidence::Asserted,
        supersedes: None,
    }
}

fn v4(a: u8, b: u8, c: u8, d: u8) -> IpAddr {
    IpAddr::V4(Ipv4Addr::new(a, b, c, d))
}

impl B {
    fn new() -> B {
        let mut g = Graph::new();
        g.begin_batch(
            fathom_graph::BatchId(Ulid::from_parts(TS0, 9002).unwrap()),
            "trace fixture",
        )
        .unwrap();
        B { g, next: 1 }
    }

    fn id(&mut self) -> Ulid {
        self.next += 1;
        Ulid::from_parts(TS0, self.next).unwrap()
    }

    fn node(&mut self, kind: NodeKind) -> NodeId {
        let u = self.id();
        self.g.insert_node(kind, u, prov()).unwrap()
    }

    fn set<T: core::any::Any>(&mut self, n: NodeId, field: &str, v: T) {
        self.g
            .set_field(ElementId::Node(n), fk(field), v, prov())
            .unwrap_or_else(|e| panic!("{field}: {e}"));
    }

    fn edge(&mut self, kind: EdgeKind, from: NodeId, to: NodeId) -> fathom_graph::EdgeId {
        let u = self.id();
        self.g
            .insert_edge(kind, u, from, to, prov())
            .unwrap_or_else(|e| panic!("{kind:?}: {e}"))
    }

    fn device(&mut self, name: &str) -> NodeId {
        let d = self.node(NodeKind::Device);
        self.set(d, "Device.hostname", scalar::Identifier(name.to_owned()));
        d
    }

    /// A port on a fresh chassis of `dev`.
    fn port(&mut self, chassis: NodeId, label: &str) -> NodeId {
        let p = self.node(NodeKind::PhysicalPort);
        self.set(p, "PhysicalPort.label", scalar::Text(label.to_owned()));
        self.edge(EdgeKind::HasPort, chassis, p);
        p
    }

    fn chassis(&mut self, dev: NodeId) -> NodeId {
        let c = self.node(NodeKind::Chassis);
        self.edge(EdgeKind::HasChassis, dev, c);
        c
    }

    /// An interface on `port` with one unit; `addr` is `(ip, prefix_len)`.
    fn unit(
        &mut self,
        dev: NodeId,
        port: NodeId,
        name: &str,
        addr: Option<(IpAddr, u8)>,
        vlan: Option<NodeId>,
    ) -> NodeId {
        let i = self.node(NodeKind::Interface);
        self.set(i, "Interface.name", scalar::InterfaceName(name.to_owned()));
        self.edge(EdgeKind::HasInterface, dev, i);
        self.edge(EdgeKind::Occupies, i, port);
        let u = self.node(NodeKind::LogicalUnit);
        self.set(u, "LogicalUnit.index", 0u32);
        self.edge(EdgeKind::HasUnit, i, u);
        if let Some((a, l)) = addr {
            let n = self.node(NodeKind::Address);
            self.set(
                n,
                "Address.value",
                scalar::InterfaceAddress {
                    addr: a,
                    prefix_len: l,
                },
            );
            self.edge(EdgeKind::HasAddress, u, n);
        }
        if let Some(v) = vlan {
            self.edge(EdgeKind::VlanMember, u, v);
        }
        u
    }

    fn cable(&mut self, a: NodeId, b: NodeId) -> NodeId {
        let c = self.node(NodeKind::Cable);
        let e1 = self.edge(EdgeKind::Terminates, c, a);
        let e2 = self.edge(EdgeKind::Terminates, c, b);
        for (e, end) in [(e1, CableEnd::A), (e2, CableEnd::B)] {
            self.g
                .set_field(ElementId::Edge(e), fk("Terminates.end"), end, prov())
                .unwrap();
        }
        c
    }

    fn route(&mut self, dev: NodeId, dest: (IpAddr, u8), hop: NextHop) -> NodeId {
        let ri = {
            let existing = self
                .g
                .out(dev, EdgeKind::HasRoutingInstance)
                .map(|e| e.to)
                .next();
            match existing {
                Some(r) => r,
                None => {
                    let r = self.node(NodeKind::RoutingInstance);
                    self.edge(EdgeKind::HasRoutingInstance, dev, r);
                    r
                }
            }
        };
        let r = self.node(NodeKind::StaticRoute);
        self.set(
            r,
            "StaticRoute.destination",
            scalar::IpPrefix {
                addr: dest.0,
                len: dest.1,
            },
        );
        self.set(r, "StaticRoute.next_hop", vec![hop]);
        self.edge(EdgeKind::HasStaticRoute, ri, r);
        r
    }

    fn object(&mut self, name: &str, v: Option<AddressValue>) -> NodeId {
        let o = self.node(NodeKind::AddressObject);
        self.set(o, "AddressObject.name", scalar::Identifier(name.to_owned()));
        if let Some(v) = v {
            self.set(o, "AddressObject.value", v);
        }
        o
    }

    #[allow(clippy::too_many_arguments)]
    fn policy(
        &mut self,
        set: NodeId,
        ordinal: u32,
        name: &str,
        action: PolicyAction,
        any_src: bool,
        dst: Option<NodeId>,
        app: Option<NodeId>,
    ) -> NodeId {
        let p = self.node(NodeKind::SecurityPolicy);
        self.set(
            p,
            "SecurityPolicy.name",
            scalar::Identifier(name.to_owned()),
        );
        self.set(p, "SecurityPolicy.ordinal", ordinal);
        self.set(p, "SecurityPolicy.action", action);
        if any_src {
            self.set(p, "SecurityPolicy.match_any_source", true);
        }
        self.edge(EdgeKind::HasPolicy, set, p);
        match dst {
            Some(d) => {
                self.edge(EdgeKind::MatchDestination, p, d);
            }
            None => self.set(p, "SecurityPolicy.match_any_destination", true),
        }
        if let Some(a) = app {
            self.edge(EdgeKind::MatchApplication, p, a);
        } else {
            self.set(p, "SecurityPolicy.match_any_application", true);
        }
        p
    }
}

struct Estate {
    g: Graph,
    host: NodeId,
    host_unit: NodeId,
    fw: NodeId,
    rtr: NodeId,
    rtr_lan_port: NodeId,
    policies: Vec<NodeId>,
}

fn estate() -> Estate {
    let mut b = B::new();

    let host = b.device("host-a");
    let hc = b.chassis(host);
    let hp = b.port(hc, "eth0");
    let host_unit = b.unit(host, hp, "eth0", Some((v4(10, 1, 0, 10), 24)), None);
    b.route(
        host,
        (v4(0, 0, 0, 0), 0),
        NextHop::Address(scalar::IpAddr(v4(10, 1, 0, 1))),
    );

    let sw = b.device("sw-1");
    let sc = b.chassis(sw);
    let sp1 = b.port(sc, "ge-0/0/1");
    let sp2 = b.port(sc, "ge-0/0/2");
    let sp3 = b.port(sc, "ge-0/0/3");
    let vlan20 = b.node(NodeKind::Vlan);
    b.set(vlan20, "Vlan.vlan_id", scalar::VlanId(20));
    b.edge(EdgeKind::HasVlan, sw, vlan20);
    let vlan30 = b.node(NodeKind::Vlan);
    b.set(vlan30, "Vlan.vlan_id", scalar::VlanId(30));
    b.edge(EdgeKind::HasVlan, sw, vlan30);
    b.unit(sw, sp1, "ge-0/0/1", None, Some(vlan20));
    b.unit(sw, sp2, "ge-0/0/2", None, Some(vlan20));
    b.unit(sw, sp3, "ge-0/0/3", None, Some(vlan30));

    let fw = b.device("fw-1");
    let fc = b.chassis(fw);
    let f0 = b.port(fc, "ge-0/0/0");
    let f1 = b.port(fc, "ge-0/0/1");
    let lan = b.unit(fw, f0, "ge-0/0/0", Some((v4(10, 1, 0, 1), 24)), None);
    let wan = b.unit(fw, f1, "ge-0/0/1", Some((v4(203, 0, 113, 1), 30)), None);
    b.route(
        fw,
        (v4(10, 8, 0, 0), 16),
        NextHop::Address(scalar::IpAddr(v4(203, 0, 113, 2))),
    );

    let panel = b.node(NodeKind::PassiveNode);
    let front = b.node(NodeKind::PhysicalPort);
    b.set(
        front,
        "PhysicalPort.label",
        scalar::Text("front-1".to_owned()),
    );
    b.edge(EdgeKind::HasPort, panel, front);
    let rear = b.node(NodeKind::PhysicalPort);
    b.set(
        rear,
        "PhysicalPort.label",
        scalar::Text("rear-1".to_owned()),
    );
    b.edge(EdgeKind::HasPort, panel, rear);
    b.edge(EdgeKind::PassThrough, front, rear);

    let rtr = b.device("rtr-1");
    let rc = b.chassis(rtr);
    let r0 = b.port(rc, "ge-0/0/0");
    let r1 = b.port(rc, "ge-0/0/1");
    b.unit(rtr, r0, "ge-0/0/0", Some((v4(203, 0, 113, 2), 30)), None);
    b.unit(rtr, r1, "ge-0/0/1", Some((v4(10, 8, 0, 1), 16)), None);

    b.cable(hp, sp1);
    b.cable(sp2, f0);
    b.cable(f1, front);
    b.cable(rear, r0);

    // Zones and the lan -> wan set.
    let zl = b.node(NodeKind::Zone);
    b.set(zl, "Zone.name", scalar::Identifier("lan".to_owned()));
    b.edge(EdgeKind::HasZone, fw, zl);
    b.edge(EdgeKind::ZoneMember, zl, lan);
    let zw = b.node(NodeKind::Zone);
    b.set(zw, "Zone.name", scalar::Identifier("wan".to_owned()));
    b.edge(EdgeKind::HasZone, fw, zw);
    b.edge(EdgeKind::ZoneMember, zw, wan);
    let zd = b.node(NodeKind::Zone);
    b.set(zd, "Zone.name", scalar::Identifier("dmz".to_owned()));
    b.edge(EdgeKind::HasZone, fw, zd);

    let set = b.node(NodeKind::PolicySet);
    b.edge(EdgeKind::HasPolicySet, fw, set);
    b.set(
        set,
        "PolicySet.scope",
        PolicyScope::ZonePair {
            from: fathom_id::NodeId(zl.ulid),
            to: fathom_id::NodeId(zw.ulid),
        },
    );
    // A set for another pair: it must not be listed on this hop.
    let other = b.node(NodeKind::PolicySet);
    b.edge(EdgeKind::HasPolicySet, fw, other);
    b.set(
        other,
        "PolicySet.scope",
        PolicyScope::ZonePair {
            from: fathom_id::NodeId(zd.ulid),
            to: fathom_id::NodeId(zw.ulid),
        },
    );
    b.policy(other, 1, "dmz-out", PolicyAction::Permit, true, None, None);

    let net = b.object(
        "branch-net",
        Some(AddressValue::Prefix(scalar::IpPrefix {
            addr: v4(10, 8, 0, 0),
            len: 16,
        })),
    );
    let guests = b.object(
        "guests",
        Some(AddressValue::Prefix(scalar::IpPrefix {
            addr: v4(192, 168, 99, 0),
            len: 24,
        })),
    );
    let ghost = b.object("zone-book-name", None);
    let smb = b.node(NodeKind::Application);
    b.set(
        smb,
        "Application.name",
        scalar::Identifier("smb".to_owned()),
    );
    b.set(
        smb,
        "Application.l4",
        L4Spec::Protocol {
            protocol: scalar::IpProtocol(6),
            source_ports: vec![],
            destination_ports: vec![scalar::PortRange { lo: 445, hi: 445 }],
        },
    );
    let https = b.node(NodeKind::Application);
    b.set(
        https,
        "Application.name",
        scalar::Identifier("junos-https".to_owned()),
    );

    let p1 = b.policy(
        set,
        1,
        "block-smb",
        PolicyAction::Deny,
        true,
        Some(net),
        Some(smb),
    );
    let p2 = b.policy(
        set,
        2,
        "guests-out",
        PolicyAction::Permit,
        false,
        Some(net),
        None,
    );
    // A policy whose source is the guests object: the host is not in it.
    b.edge(EdgeKind::MatchSource, p2, guests);
    let p3 = b.policy(
        set,
        3,
        "web",
        PolicyAction::Permit,
        true,
        Some(net),
        Some(https),
    );
    let p4 = b.policy(
        set,
        4,
        "named-elsewhere",
        PolicyAction::Permit,
        true,
        Some(ghost),
        None,
    );
    let p5 = b.policy(set, 5, "any-any", PolicyAction::Deny, true, None, None);

    // An unscoped set (what an OPNsense paste makes).
    let unscoped = b.node(NodeKind::PolicySet);
    b.edge(EdgeKind::HasPolicySet, fw, unscoped);
    b.policy(
        unscoped,
        1,
        "lan-rule",
        PolicyAction::Permit,
        true,
        None,
        None,
    );

    b.g.end_batch().unwrap();
    Estate {
        g: b.g,
        host,
        host_unit,
        fw,
        rtr,
        rtr_lan_port: r1,
        policies: vec![p1, p2, p3, p4, p5],
    }
}

fn kinds(t: &Trace) -> Vec<&'static str> {
    t.hops.iter().map(|h| h.kind).collect()
}

fn titles(t: &Trace) -> Vec<String> {
    t.hops.iter().map(|h| h.title.clone()).collect()
}

fn flow445() -> Option<Flow> {
    Some(Flow {
        protocol: 6,
        port: 445,
    })
}

#[test]
fn a_known_path_is_walked_hop_by_hop() {
    let e = estate();
    let t = trace(&e.g, &e.host.to_string(), "10.8.0.1", flow445());
    assert_eq!(t.stopped, "", "the path reaches the far end: {t:#?}");
    assert_eq!(
        kinds(&t),
        [
            "start",  // host-a
            "device", // host-a routes via 10.1.0.1
            "cable",  // host-a eth0 -> sw-1 ge-0/0/1
            "switch", // sw-1 VLAN 20
            "cable",  // sw-1 ge-0/0/2 -> fw-1 ge-0/0/0
            "device", // fw-1: the firewall
            "cable",  // fw-1 ge-0/0/1 -> panel front-1
            "cable",  // panel pass-through
            "cable",  // panel rear-1 -> rtr-1
            "end",    // rtr-1 holds 10.8.0.1
        ],
        "{:#?}",
        titles(&t)
    );
    assert_eq!(t.hops[0].title, "host-a");
    assert!(t.hops[1]
        .detail
        .iter()
        .any(|d| d.contains("static route 0.0.0.0/0 via 10.1.0.1")));
    assert!(t.hops[3].detail[0].contains("VLAN 20: in on ge-0/0/1, out on ge-0/0/2"));
    let fw = &t.hops[5];
    assert_eq!(fw.title, "fw-1");
    assert!(fw
        .detail
        .iter()
        .any(|d| d.contains("static route 10.8.0.0/16 via 203.0.113.2")));
    assert!(fw.detail.iter().any(|d| d.starts_with("out on ")));
    assert_eq!(fw.scope, "lan to wan");
    assert!(t.hops[7].detail[0].contains("passes through to rear-1"));
    assert_eq!(t.hops[9].title, "rtr-1");
}

#[test]
fn a_firewall_hop_lists_every_policy_in_order_with_its_match_state() {
    let e = estate();
    let t = trace(&e.g, &e.host.to_string(), "10.8.0.1", flow445());
    let fw = t
        .hops
        .iter()
        .find(|h| h.kind == "device" && h.title == "fw-1")
        .unwrap();
    let names: Vec<&str> = fw.policies.iter().map(|p| p.name.as_str()).collect();
    assert_eq!(
        names,
        [
            "block-smb",
            "guests-out",
            "web",
            "named-elsewhere",
            "any-any"
        ],
        "the set between lan and wan only, in the device's order"
    );
    let state = |n: &str| fw.policies.iter().find(|p| p.name == n).unwrap();
    // block-smb: any source, 10.8.0.0/16, TCP 445 -- all three match.
    assert_eq!(state("block-smb").state, "matches");
    assert_eq!(state("block-smb").action, "deny");
    // guests-out: the host 10.1.0.10 is not in 192.168.99.0/24.
    assert_eq!(state("guests-out").state, "doesn't match");
    assert!(!state("guests-out").could_affect);
    assert!(state("guests-out").reason.contains("source"));
    // web: the application was named but its ports were never read.
    assert_eq!(state("web").state, "can't tell");
    assert!(state("web").reason.contains("application not read"));
    // named-elsewhere: the object has no value.
    assert_eq!(state("named-elsewhere").state, "can't tell");
    assert!(state("named-elsewhere")
        .reason
        .contains("address was not read"));
    assert_eq!(state("any-any").state, "matches");
    assert!(fw.policies.iter().filter(|p| p.could_affect).count() == 4);
    // The unscoped set is listed apart, never placed.
    assert_eq!(fw.unplaced.len(), 1);
    assert_eq!(fw.unplaced[0].state, "can't tell");
    assert!(fw.unplaced_why.contains("which interface and direction"));
    assert!(fw.detail.iter().any(|d| d == "NAT is not read"));
    assert_eq!(e.policies.len(), 5);
}

#[test]
fn without_a_port_the_application_can_only_be_unknown() {
    let e = estate();
    let t = trace(&e.g, &e.host.to_string(), "10.8.0.1", None);
    let fw = t
        .hops
        .iter()
        .find(|h| h.title == "fw-1" && h.kind == "device")
        .unwrap();
    let smb = fw.policies.iter().find(|p| p.name == "block-smb").unwrap();
    assert_eq!(smb.state, "can't tell");
    assert!(smb.reason.contains("no protocol or port"));
}

#[test]
fn another_port_does_not_match_the_smb_application() {
    let e = estate();
    let t = trace(
        &e.g,
        &e.host.to_string(),
        "10.8.0.1",
        Some(Flow {
            protocol: 6,
            port: 22,
        }),
    );
    let fw = t
        .hops
        .iter()
        .find(|h| h.title == "fw-1" && h.kind == "device")
        .unwrap();
    let smb = fw.policies.iter().find(|p| p.name == "block-smb").unwrap();
    assert_eq!(smb.state, "doesn't match");
}

#[test]
fn a_missing_route_stops_with_could_not_establish() {
    let e = estate();
    // fw-1 has no route for 10.9.9.9; host-a's default reaches it first.
    let t = trace(&e.g, &e.host.to_string(), "10.9.9.9", None);
    assert!(
        t.stopped.contains("could not be established") || t.stopped.contains("could not establish"),
        "{}",
        t.stopped
    );
    assert!(t.stopped.contains("fw-1"), "{}", t.stopped);
    let last = t.hops.last().unwrap();
    assert_eq!(last.kind, "stop");
    assert_eq!(last.title, "could not establish");
    // Everything before the stop is still there.
    assert!(t
        .hops
        .iter()
        .any(|h| h.kind == "device" && h.title == "fw-1"));
}

#[test]
fn a_port_with_no_cable_stops_at_that_port() {
    let e = estate();
    // 10.8.0.1/16 is connected on rtr-1 ge-0/0/1, which has no cable.
    let t = trace(&e.g, &e.host.to_string(), "10.8.9.9", None);
    assert!(
        t.stopped
            .contains("no cable is recorded on ge-0/0/1 of rtr-1"),
        "{}",
        t.stopped
    );
    let _ = e.rtr_lan_port;
}

#[test]
fn a_destination_the_design_does_not_hold_is_not_guessed() {
    let e = estate();
    let t = trace(&e.g, "not an id", "10.8.0.1", None);
    assert!(t.stopped.contains("could not read"));
    let t = trace(&e.g, &e.host.to_string(), "no.such.thing", None);
    assert!(t.stopped.contains("could not read"));
}

#[test]
fn a_trace_from_a_unit_knows_its_source_address() {
    let e = estate();
    let t = trace(&e.g, &e.host_unit.to_string(), "10.8.0.1", flow445());
    assert_eq!(t.stopped, "");
    assert_eq!(t.hops[0].detail[0], "from 10.1.0.10");
}

#[test]
fn a_destination_that_is_a_device_resolves_to_its_address() {
    let e = estate();
    let t = trace(&e.g, &e.host.to_string(), &e.rtr.to_string(), None);
    assert_eq!(t.stopped, "", "{t:#?}");
    assert_eq!(t.hops.last().unwrap().kind, "end");
}

#[test]
fn the_start_can_be_the_firewall_itself() {
    let e = estate();
    let t = trace(&e.g, &e.fw.to_string(), "10.8.0.1", None);
    assert_eq!(t.stopped, "");
    // No ingress interface: the zone is said, not invented.
    let fw = t.hops.iter().find(|h| h.kind == "device").unwrap();
    assert!(fw.scope.starts_with("no ingress interface"));
    // The sets that end in the egress zone are listed, each "can't tell": the zone entered from is the gap.
    assert!(fw.policies.is_empty());
    assert!(!fw.unplaced.is_empty());
    assert!(fw
        .unplaced
        .iter()
        .all(|p| p.state == "can't tell" && p.could_affect));
    assert!(fw.unplaced_why.starts_with("could not establish"));
}

#[test]
fn no_verdict_word_appears_in_any_hop_text() {
    let e = estate();
    let mut texts = Vec::new();
    for dest in ["10.8.0.1", "10.9.9.9", "10.8.9.9"] {
        for f in [None, flow445()] {
            let t = trace(&e.g, &e.host.to_string(), dest, f);
            for h in t.hops {
                texts.push(h.title);
                texts.push(h.why);
                texts.extend(h.detail);
                texts.push(h.unplaced_why);
                for p in h.policies.into_iter().chain(h.unplaced) {
                    texts.push(p.state.to_owned());
                    texts.push(p.reason);
                    texts.push(p.action);
                }
            }
            texts.push(t.stopped);
        }
    }
    let banned = [
        "allowed",
        "permitted",
        "denied",
        "blocked",
        "reachable",
        "unreachable",
    ];
    for t in &texts {
        let lower = t.to_lowercase();
        for b in banned {
            assert!(!lower.contains(b), "`{b}` appears in `{t}`");
        }
    }
}

/// One device with one addressed unit (10.1.1.1/24 on eth0) and nothing cabled.
fn lone() -> (B, NodeId) {
    let mut b = B::new();
    let d = b.device("r-lone");
    let c = b.chassis(d);
    let p = b.port(c, "eth0");
    b.unit(d, p, "eth0", Some((v4(10, 1, 1, 1), 24)), None);
    (b, d)
}

#[test]
fn a_shorter_discard_route_does_not_stop_a_longer_connected_one() {
    let (mut b, d) = lone();
    b.route(d, (v4(10, 0, 0, 0), 8), NextHop::Discard);
    let t = trace(&b.g, &d.to_string(), "10.1.1.5", None);
    assert!(
        !t.stopped.contains("discard"),
        "the /24 connected route wins: {}",
        t.stopped
    );
    assert!(t
        .hops
        .iter()
        .any(|h| h.detail.iter().any(|l| l.contains("connected"))));
}

#[test]
fn a_winning_discard_route_is_said_plainly() {
    let (mut b, d) = lone();
    b.route(d, (v4(10, 9, 0, 0), 16), NextHop::Discard);
    let t = trace(&b.g, &d.to_string(), "10.9.1.1", None);
    assert!(t.stopped.contains("discard"), "{}", t.stopped);
}

#[test]
fn two_routing_instances_stop_the_route_lookup() {
    let (mut b, d) = lone();
    for _ in 0..2 {
        let r = b.node(NodeKind::RoutingInstance);
        b.edge(EdgeKind::HasRoutingInstance, d, r);
    }
    let t = trace(&b.g, &d.to_string(), "10.1.1.5", None);
    assert!(
        t.stopped.contains("more than one routing instance"),
        "{}",
        t.stopped
    );
}

/// Arista's `vrf instance MGMT` on a switch with no default-table route: one
/// instance, but a VRF, so the switch's interfaces are not one table.
#[test]
fn a_lone_vrf_stops_the_route_lookup_too() {
    let (mut b, d) = lone();
    let r = b.node(NodeKind::RoutingInstance);
    b.set(
        r,
        "RoutingInstance.name",
        scalar::Identifier("MGMT".to_owned()),
    );
    b.edge(EdgeKind::HasRoutingInstance, d, r);
    let t = trace(&b.g, &d.to_string(), "10.1.1.5", None);
    assert!(
        t.stopped.contains("other than its default (MGMT)"),
        "{}",
        t.stopped
    );
    // The default table a person adds by hand is not a VRF.
    let (mut b, d) = lone();
    let r = b.node(NodeKind::RoutingInstance);
    b.set(
        r,
        "RoutingInstance.name",
        scalar::Identifier("default".to_owned()),
    );
    b.edge(EdgeKind::HasRoutingInstance, d, r);
    let t = trace(&b.g, &d.to_string(), "10.1.1.5", None);
    assert!(!t.stopped.contains("routing instance"), "{}", t.stopped);
}

#[test]
fn a_dual_stack_start_does_not_invent_a_source() {
    let (mut b, d) = lone();
    // A second IPv4 address on the same unit: no single source of that family.
    let u = b.g.nodes_of_kind(NodeKind::LogicalUnit).next().unwrap().id;
    let n = b.node(NodeKind::Address);
    b.set(
        n,
        "Address.value",
        scalar::InterfaceAddress {
            addr: v4(10, 1, 1, 2),
            prefix_len: 24,
        },
    );
    b.edge(EdgeKind::HasAddress, u, n);
    let t = trace(&b.g, &d.to_string(), "10.1.1.5", None);
    assert_eq!(t.hops[0].detail[0], "from this device");
}

// ---- the routing audit's fixes (2026-11-02) ------------------------------

fn ip(s: &str) -> IpAddr {
    s.parse().unwrap()
}

fn via(s: &str) -> NextHop {
    NextHop::Address(scalar::IpAddr(ip(s)))
}

impl B {
    fn host(&mut self, name: &str, addr: &str) -> (NodeId, NodeId) {
        let h = self.device(name);
        let c = self.chassis(h);
        let p = self.port(c, "eth0");
        self.unit(h, p, "eth0", Some((ip(addr), 24)), None);
        (h, p)
    }

    /// A switch whose `n` ports all carry VLAN 10.
    fn vlan10_switch(&mut self, name: &str, n: usize) -> Vec<NodeId> {
        let d = self.device(name);
        let c = self.chassis(d);
        let v = self.node(NodeKind::Vlan);
        self.set(v, "Vlan.vlan_id", scalar::VlanId(10));
        self.edge(EdgeKind::HasVlan, d, v);
        (0..n)
            .map(|i| {
                let label = format!("Et{}", i + 1);
                let p = self.port(c, &label);
                self.unit(d, p, &label, None, Some(v));
                p
            })
            .collect()
    }
}

#[test]
fn a_connected_route_beats_an_equally_specific_static_one() {
    // A pasted static route carries no preference; a connected route always outranks it.
    let mut b = B::new();
    let r = b.device("r1");
    let c = b.chassis(r);
    let lan = b.port(c, "ge0");
    let wan = b.port(c, "ge1");
    b.unit(r, lan, "ge0", Some((ip("10.1.1.1"), 24)), None);
    b.unit(r, wan, "ge1", Some((ip("192.0.2.1"), 30)), None);
    b.route(r, (ip("10.1.1.0"), 24), via("192.0.2.2"));
    let (_, hp) = b.host("h", "10.1.1.5");
    b.cable(lan, hp);
    let t = trace(&b.g, &r.to_string(), "10.1.1.5", None);
    assert!(t.stopped.is_empty(), "{}", t.stopped);
    assert!(t.hops[1].detail.iter().any(|l| l.starts_with("connected")));
}

#[test]
fn a_next_hop_resolves_through_the_longest_prefix_that_is_up() {
    let mut b = B::new();
    let r = b.device("r1");
    let c = b.chassis(r);
    let p0 = b.port(c, "ge0");
    let p1 = b.port(c, "ge1");
    let down = b.unit(r, p0, "ge0", Some((ip("192.0.2.1"), 24)), None);
    b.set(down, "LogicalUnit.admin_up", false);
    b.unit(r, p1, "ge1", Some((ip("192.0.2.129"), 25)), None);
    b.route(r, (ip("0.0.0.0"), 0), via("192.0.2.130"));
    let isp = b.device("isp");
    let ic = b.chassis(isp);
    let q = b.port(ic, "x");
    b.unit(isp, q, "x", Some((ip("192.0.2.130"), 25)), None);
    b.cable(p1, q);
    let t = trace(&b.g, &r.to_string(), "8.8.8.8", None);
    assert!(
        t.hops[1].detail.iter().any(|l| l == "out on ge1.0"),
        "{:?}",
        t.hops[1].detail
    );
    assert!(titles(&t).contains(&"isp".to_owned()), "{:?}", titles(&t));
}

#[test]
fn an_address_two_devices_hold_is_not_a_start() {
    // One private range at two sites: the trace does not pick a site.
    let mut b = B::new();
    b.host("site-a-nas", "192.168.1.10");
    b.host("site-b-nas", "192.168.1.10");
    let t = trace(&b.g, "192.168.1.10", "192.168.1.20", None);
    assert!(
        t.stopped.contains("more than one device") && t.stopped.contains("site-b-nas"),
        "{}",
        t.stopped
    );
}

#[test]
fn two_uplinks_in_one_vlan_are_two_paths_not_none() {
    let mut b = B::new();
    let (a, pa) = b.host("pc-a", "10.10.0.11");
    let (_, pb) = b.host("pc-b", "10.10.0.12");
    let acc = b.vlan10_switch("acc", 3);
    let dist = b.vlan10_switch("dist", 3);
    b.cable(pa, acc[0]);
    b.cable(acc[1], dist[0]);
    b.cable(acc[2], dist[1]);
    b.cable(dist[2], pb);
    let t = trace(&b.g, &a.to_string(), "10.10.0.12", None);
    assert!(
        t.stopped.contains("more than one path from acc"),
        "{}",
        t.stopped
    );
}

#[test]
fn a_vlan_stretched_across_a_three_tier_campus_is_followed() {
    // access, distribution, core, distribution, access, and one more: six switches in a line.
    let mut b = B::new();
    let (a, pa) = b.host("pc-a", "10.10.0.11");
    let (_, pb) = b.host("pc-b", "10.10.0.12");
    let mut prev = pa;
    for i in 0..6 {
        let ps = b.vlan10_switch(&format!("sw-{i}"), 2);
        b.cable(prev, ps[0]);
        prev = ps[1];
    }
    b.cable(prev, pb);
    let t = trace(&b.g, &a.to_string(), "10.10.0.12", None);
    assert!(t.stopped.is_empty(), "{}", t.stopped);
    assert_eq!(kinds(&t).iter().filter(|k| **k == "switch").count(), 6);
}

// ---- round 1: SVIs and irb, and LAGs (r96, 2026-11-02) ------------------------

impl B {
    fn vlan(&mut self, dev: NodeId, id: u16) -> NodeId {
        let v = self.node(NodeKind::Vlan);
        self.set(v, "Vlan.vlan_id", scalar::VlanId(id));
        self.edge(EdgeKind::HasVlan, dev, v);
        v
    }

    /// An SVI (`Vlan20`) or irb unit: an interface with no port, the gateway of `vlan`.
    fn svi(&mut self, dev: NodeId, vlan: NodeId, name: &str, addr: &str, len: u8) -> NodeId {
        let i = self.node(NodeKind::Interface);
        self.set(i, "Interface.name", scalar::InterfaceName(name.to_owned()));
        self.edge(EdgeKind::HasInterface, dev, i);
        let u = self.node(NodeKind::LogicalUnit);
        self.set(u, "LogicalUnit.index", 0u32);
        self.edge(EdgeKind::HasUnit, i, u);
        let n = self.node(NodeKind::Address);
        self.set(
            n,
            "Address.value",
            scalar::InterfaceAddress {
                addr: ip(addr),
                prefix_len: len,
            },
        );
        self.edge(EdgeKind::HasAddress, u, n);
        self.edge(EdgeKind::L3Interface, vlan, u);
        u
    }

    /// A LAG `name` on `dev` over `ports`: member interfaces on each port, and one unit on
    /// the aggregate, in `vlan` or holding `addr`.
    fn lag(
        &mut self,
        dev: NodeId,
        name: &str,
        ports: &[NodeId],
        vlan: Option<NodeId>,
        addr: Option<(&str, u8)>,
    ) -> NodeId {
        let agg = self.node(NodeKind::AggregateInterface);
        self.set(
            agg,
            "AggregateInterface.name",
            scalar::InterfaceName(name.to_owned()),
        );
        self.edge(EdgeKind::HasInterface, dev, agg);
        for (k, p) in ports.iter().enumerate() {
            let i = self.node(NodeKind::Interface);
            self.set(
                i,
                "Interface.name",
                scalar::InterfaceName(format!("{name}-m{k}")),
            );
            self.edge(EdgeKind::HasInterface, dev, i);
            self.edge(EdgeKind::Occupies, i, *p);
            self.edge(EdgeKind::MemberOfAggregate, i, agg);
        }
        let u = self.node(NodeKind::LogicalUnit);
        self.set(u, "LogicalUnit.index", 0u32);
        self.edge(EdgeKind::HasUnit, agg, u);
        if let Some(v) = vlan {
            self.edge(EdgeKind::VlanMember, u, v);
        }
        if let Some((a, l)) = addr {
            let n = self.node(NodeKind::Address);
            self.set(
                n,
                "Address.value",
                scalar::InterfaceAddress {
                    addr: ip(a),
                    prefix_len: l,
                },
            );
            self.edge(EdgeKind::HasAddress, u, n);
        }
        u
    }

    /// A switch with one VLAN, `access` access ports and a LAG `ae0` over `links` ports.
    /// Returns (switch, vlan, access ports, LAG ports).
    fn lag_switch(
        &mut self,
        name: &str,
        access: usize,
        links: usize,
    ) -> (NodeId, NodeId, Vec<NodeId>, Vec<NodeId>) {
        let d = self.device(name);
        let c = self.chassis(d);
        let v = self.vlan(d, 10);
        let acc: Vec<NodeId> = (0..access)
            .map(|i| {
                let label = format!("Et{}", i + 1);
                let p = self.port(c, &label);
                self.unit(d, p, &label, None, Some(v));
                p
            })
            .collect();
        let lp: Vec<NodeId> = (0..links)
            .map(|i| self.port(c, &format!("Et{}", 40 + i)))
            .collect();
        self.lag(d, "ae0", &lp, Some(v), None);
        (d, v, acc, lp)
    }
}

#[test]
fn an_l3_switch_routes_between_vlans_through_its_svis() {
    // pc-a (VLAN 10) to pc-b (VLAN 20) through core's Vlan10 and Vlan20 SVIs.
    let mut b = B::new();
    let core = b.device("core");
    let cc = b.chassis(core);
    let v10 = b.vlan(core, 10);
    let v20 = b.vlan(core, 20);
    let p1 = b.port(cc, "Et1");
    let p2 = b.port(cc, "Et2");
    b.unit(core, p1, "Et1", None, Some(v10));
    b.unit(core, p2, "Et2", None, Some(v20));
    b.svi(core, v10, "Vlan10", "10.10.0.1", 24);
    b.svi(core, v20, "Vlan20", "10.20.0.1", 24);
    let (a, pa) = b.host("pc-a", "10.10.0.11");
    b.route(a, (ip("0.0.0.0"), 0), via("10.10.0.1"));
    let (_, pb) = b.host("pc-b", "10.20.0.12");
    b.cable(pa, p1);
    b.cable(p2, pb);
    let t = trace(&b.g, &a.to_string(), "10.20.0.12", None);
    assert!(t.stopped.is_empty(), "{}", t.stopped);
    let at_core = t
        .hops
        .iter()
        .find(|h| h.kind == "device" && h.title == "core")
        .expect("core routes");
    assert!(
        at_core.detail.contains(&"in on Vlan10.0".to_owned()),
        "{:?}",
        at_core.detail
    );
    assert!(
        at_core.detail.contains(&"out on Vlan20.0".to_owned()),
        "{:?}",
        at_core.detail
    );
    let sw = t
        .hops
        .iter()
        .find(|h| h.kind == "switch" && h.title == "core")
        .expect("core switches into VLAN 20");
    assert_eq!(sw.detail[0], "VLAN 20: from Vlan20.0, out on Et2");
    assert_eq!(t.hops.last().unwrap().title, "pc-b");
}

#[test]
fn an_svi_with_no_port_in_its_vlan_says_so() {
    let mut b = B::new();
    let core = b.device("core");
    let v20 = b.vlan(core, 20);
    b.svi(core, v20, "irb.20", "10.20.0.1", 24);
    let t = trace(&b.g, &core.to_string(), "10.20.0.12", None);
    assert!(
        t.stopped
            .contains("irb.20.0 is the gateway of VLAN 20, and no port of core"),
        "{}",
        t.stopped
    );
}

#[test]
fn a_lag_between_two_switches_is_one_path_not_two() {
    let mut b = B::new();
    let (a, pa) = b.host("pc-a", "10.10.0.11");
    let (_, pb) = b.host("pc-b", "10.10.0.12");
    let (_, _, acc_a, lag_a) = b.lag_switch("acc", 1, 2);
    let (_, _, acc_b, lag_b) = b.lag_switch("dist", 1, 2);
    b.cable(pa, acc_a[0]);
    b.cable(lag_a[0], lag_b[0]);
    b.cable(lag_a[1], lag_b[1]);
    b.cable(acc_b[0], pb);
    let t = trace(&b.g, &a.to_string(), "10.10.0.12", None);
    assert!(t.stopped.is_empty(), "{}", t.stopped);
    let sw = t
        .hops
        .iter()
        .find(|h| h.kind == "switch" && h.title == "acc")
        .expect("acc");
    assert!(
        sw.detail
            .iter()
            .any(|l| l.starts_with("ae0 bundles 2 links to dist")),
        "{:?}",
        sw.detail
    );
    assert_eq!(kinds(&t).iter().filter(|k| **k == "switch").count(), 2);
}

#[test]
fn lag_links_to_two_different_switches_are_still_two_paths() {
    // MLAG: acc's ae0 goes to dist-1 and dist-2, both of which reach pc-b. Not ranked yet.
    let mut b = B::new();
    let (a, pa) = b.host("pc-a", "10.10.0.11");
    let (_, pb) = b.host("pc-b", "10.10.0.12");
    let (_, _, acc, lag) = b.lag_switch("acc", 1, 2);
    let d1 = b.vlan10_switch("dist-1", 2);
    let d2 = b.vlan10_switch("dist-2", 2);
    let core = b.vlan10_switch("core", 3);
    b.cable(pa, acc[0]);
    b.cable(lag[0], d1[0]);
    b.cable(lag[1], d2[0]);
    b.cable(d1[1], core[0]);
    b.cable(d2[1], core[1]);
    b.cable(core[2], pb);
    let t = trace(&b.g, &a.to_string(), "10.10.0.12", None);
    assert!(
        t.stopped.contains("more than one path from acc in VLAN 10"),
        "{}",
        t.stopped
    );
}

#[test]
fn a_routed_lag_leaves_by_its_links() {
    // r1's ae0.0 holds 10.1.1.1/24 over two links to acc's ae0; the host is on acc.
    let mut b = B::new();
    let r = b.device("r1");
    let rc = b.chassis(r);
    let rl: Vec<NodeId> = (0..2).map(|i| b.port(rc, &format!("xe-0/0/{i}"))).collect();
    b.lag(r, "ae0", &rl, None, Some(("10.1.1.1", 24)));
    let (_, _, acc, lag) = b.lag_switch("acc", 1, 2);
    b.cable(rl[0], lag[0]);
    b.cable(rl[1], lag[1]);
    let (_, hp) = b.host("h", "10.1.1.5");
    b.cable(acc[0], hp);
    let t = trace(&b.g, &r.to_string(), "10.1.1.5", None);
    assert!(t.stopped.is_empty(), "{}", t.stopped);
    assert!(
        t.hops[1].detail.contains(&"out on ae0.0".to_owned()),
        "{:?}",
        t.hops[1].detail
    );
    assert!(
        t.hops.iter().any(|h| h
            .detail
            .iter()
            .any(|l| l.starts_with("ae0 bundles 2 links to acc"))),
        "{:?}",
        t.hops
    );
}

#[test]
fn a_reply_comes_back_into_a_routed_lag() {
    // The host answers r1: its default route reaches ae0.0 over acc's LAG.
    let mut b = B::new();
    let r = b.device("r1");
    let rc = b.chassis(r);
    let rl: Vec<NodeId> = (0..2).map(|i| b.port(rc, &format!("xe-0/0/{i}"))).collect();
    b.lag(r, "ae0", &rl, None, Some(("10.1.1.1", 24)));
    let lo = b.port(rc, "lo");
    b.unit(r, lo, "lo0", Some((ip("192.0.2.1"), 32)), None);
    let (_, _, acc, lag) = b.lag_switch("acc", 1, 2);
    b.cable(rl[0], lag[0]);
    b.cable(rl[1], lag[1]);
    let (h, hp) = b.host("h", "10.1.1.5");
    b.route(h, (ip("0.0.0.0"), 0), via("10.1.1.1"));
    b.cable(acc[0], hp);
    let t = trace(&b.g, &h.to_string(), "192.0.2.1", None);
    assert!(t.stopped.is_empty(), "{}", t.stopped);
    let end = t.hops.last().unwrap();
    assert_eq!(end.title, "r1");
}

impl B {
    /// A 1:`n` splitter: its common port and its branch ports.
    fn splitter(&mut self, name: &str, n: usize) -> (NodeId, Vec<NodeId>) {
        let s = self.node(NodeKind::PassiveNode);
        self.set(s, "PassiveNode.label", scalar::Text(name.to_owned()));
        let common = self.node(NodeKind::PhysicalPort);
        self.set(common, "PhysicalPort.label", scalar::Text("COM".to_owned()));
        self.edge(EdgeKind::HasPort, s, common);
        let outs = (0..n)
            .map(|i| {
                let o = self.node(NodeKind::PhysicalPort);
                self.set(o, "PhysicalPort.label", scalar::Text(format!("{}", i + 1)));
                self.edge(EdgeKind::HasPort, s, o);
                self.edge(EdgeKind::PassThrough, common, o);
                o
            })
            .collect();
        (common, outs)
    }
}

#[test]
fn a_pon_splitter_is_followed_down_to_the_ont_the_flow_is_for() {
    let mut b = B::new();
    let olt = b.device("e7");
    let oc = b.chassis(olt);
    let pon = b.port(oc, "PON 1/1");
    b.unit(olt, pon, "pon1", Some((ip("100.64.0.1"), 24)), None);
    let (common, outs) = b.splitter("spl", 4);
    b.cable(pon, common);
    let mut onts = Vec::new();
    for (i, o) in outs.iter().enumerate() {
        let (ont, op) = b.host(&format!("ont-{i}"), &format!("100.64.0.{}", 10 + i));
        b.cable(*o, op);
        onts.push(ont);
    }
    let t = trace(&b.g, &olt.to_string(), "100.64.0.12", None);
    assert!(t.stopped.is_empty(), "{}", t.stopped);
    let spl = t
        .hops
        .iter()
        .find(|h| h.title == "splitter")
        .expect("a splitter hop");
    assert!(
        spl.detail[0] == "spl COM splits to 4 ports; the flow is for the branch on 3",
        "{:?}",
        spl.detail
    );
    assert_eq!(t.hops.last().unwrap().title, "ont-2");
    // And back up: one way through the splitter.
    let up = trace(&b.g, &onts[2].to_string(), "100.64.0.1", None);
    assert!(up.stopped.is_empty(), "{}", up.stopped);
}

#[test]
fn a_splitter_whose_branches_hold_no_such_address_says_so() {
    let mut b = B::new();
    let olt = b.device("e7");
    let oc = b.chassis(olt);
    let pon = b.port(oc, "PON 1/1");
    b.unit(olt, pon, "pon1", Some((ip("100.64.0.1"), 24)), None);
    let (common, outs) = b.splitter("spl", 2);
    b.cable(pon, common);
    for (i, o) in outs.iter().enumerate() {
        let (_, op) = b.host(&format!("ont-{i}"), &format!("100.64.0.{}", 10 + i));
        b.cable(*o, op);
    }
    let t = trace(&b.g, &olt.to_string(), "100.64.0.99", None);
    assert!(
        t.stopped
            .contains("splits to 2 ports and no device on them holds 100.64.0.99"),
        "{}",
        t.stopped
    );
}
