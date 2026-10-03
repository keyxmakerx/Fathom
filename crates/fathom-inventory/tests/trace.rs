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
