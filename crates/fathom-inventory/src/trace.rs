//! Path trace (ADR-0061 item 9): the route one flow would take through the
//! design, hop by hop, and where the design stops saying.
//!
//! The rule that governs everything here is the one `inside.rs` states: Fathom
//! never says permitted or denied. A firewall hop names the zones, the policy
//! set between them and its policies in the order the device reads them, each
//! with its configured action and whether this flow matches it: *matches*,
//! *doesn't match* or *can't tell*, with the reason. There is no verdict for
//! the flow. Anything the design does not hold is "could not establish", and
//! the trace stops at the first such hop rather than guess past it.
//!
//! Read: cables and patch-panel pass-through, VLAN membership on switch ports,
//! connected and static routes (longest prefix, then preference), zone pairs
//! and their policies. Not read, and said so: learned routes, NAT, and any
//! policy qualifier the dictionaries do not bind (a trace lists policies as
//! stored).

use std::net::IpAddr;

use fathom_graph::{ElementId, Graph, NodeId, Origin};
use fathom_ir::generated::accessors::{
    address, address_object, application, logical_unit, policy_set, security_policy, static_route,
    vlan,
};
use fathom_ir::generated::ir_types::{EdgeKind, NodeKind, PolicyAction};
use fathom_ir::scalar::{IpPrefix, IpRange};
use fathom_ir::value::{AddressValue, L4Spec, NextHop, PolicyScope};

use crate::element::{display_name, parse_display_id};

/// The most hops one trace walks. A loop in the design ends here, said.
const MAX_STEPS: usize = 24;

/// How far one switch search wanders through further switches.
const L2_DEPTH: usize = 4;

/// A flow's protocol and destination port, when the person gave them.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Flow {
    pub protocol: u8,
    pub port: u16,
}

/// One policy a firewall hop reads, with this flow's match state.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PolicyLine {
    pub id: String,
    pub ordinal: String,
    pub name: String,
    pub action: String,
    /// `matches`, `doesn't match` or `can't tell`.
    pub state: &'static str,
    pub reason: String,
    /// True unless the state is `doesn't match`.
    pub could_affect: bool,
}

/// One hop. `nodes` are display ids the canvas highlights.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Hop {
    /// `start`, `device`, `cable`, `switch`, `end` or `stop`.
    pub kind: &'static str,
    pub title: String,
    pub detail: Vec<String>,
    pub nodes: Vec<String>,
    /// Why the trace took this step, in a sentence.
    pub why: String,
    /// Where the fact came from: `read from a pasted config` or `entered by hand`.
    pub source: String,
    /// Non-empty only at a firewall.
    pub scope: String,
    pub policies: Vec<PolicyLine>,
    /// Policies that could not be placed (an unscoped set), listed apart.
    pub unplaced: Vec<PolicyLine>,
    pub unplaced_why: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Trace {
    pub from: String,
    pub to: String,
    pub flow: String,
    pub hops: Vec<Hop>,
    /// Why the trace stopped short; empty when it reached the far end.
    pub stopped: String,
}

/// Trace one flow. `from` and `to` are display ids (a device, port or
/// interface unit) or, for `to`, an address.
pub fn trace(g: &Graph, from: &str, to: &str, flow: Option<Flow>) -> Trace {
    let mut w = Walk {
        g,
        flow,
        t: Trace {
            from: from.to_owned(),
            to: to.to_owned(),
            flow: flow
                .map(|f| format!("{} {}", proto_word(f.protocol), f.port))
                .unwrap_or_default(),
            ..Trace::default()
        },
    };
    if let Err(why) = w.run(from, to) {
        w.stop(&why);
    }
    w.t
}

struct Walk<'a> {
    g: &'a Graph,
    flow: Option<Flow>,
    t: Trace,
}

/// A chosen route: the unit it leaves by, the address to reach next, and how
/// it was read.
struct Chosen {
    unit: NodeId,
    next: IpAddr,
    words: String,
    node: NodeId,
    source: String,
}

impl Walk<'_> {
    fn stop(&mut self, why: &str) {
        self.t.stopped = why.to_owned();
        self.t.hops.push(Hop {
            kind: "stop",
            title: "could not establish".to_owned(),
            detail: vec![why.to_owned()],
            why: "The trace stops at the first step the design does not state.".to_owned(),
            ..Hop::default()
        });
    }

    fn run(&mut self, from: &str, to: &str) -> Result<(), String> {
        let (mut dev, mut ingress, mut src) = self.start(from)?;
        let (dest, dest_dev) = self.end(to)?;
        self.t.hops.push(Hop {
            kind: "start",
            title: display_name(self.g, dev),
            detail: vec![match src {
                Some(a) => format!("from {a}"),
                None => "from this device".to_owned(),
            }],
            nodes: vec![dev.to_string()],
            why: "Where the flow starts.".to_owned(),
            ..Hop::default()
        });

        for _ in 0..MAX_STEPS {
            if self.owns(dev, dest) || Some(dev) == dest_dev && ingress.is_some() {
                self.t.hops.push(Hop {
                    kind: "end",
                    title: display_name(self.g, dev),
                    detail: vec![format!("holds {dest}")],
                    nodes: vec![dev.to_string()],
                    why: "The address is one this device holds.".to_owned(),
                    ..Hop::default()
                });
                return Ok(());
            }
            let chosen = match self.route(dev, dest) {
                Ok(c) => c,
                Err(e) => {
                    // The device is on the path even though its route is not read.
                    self.t.hops.push(Hop {
                        kind: "device",
                        title: display_name(self.g, dev),
                        detail: vec![format!(
                            "in on {}",
                            ingress.map_or("the start".to_owned(), |u| display_name(self.g, u))
                        )],
                        nodes: vec![dev.to_string()],
                        why: "The flow reaches this device; its route is the first thing the design does not state.".to_owned(),
                        ..Hop::default()
                    });
                    return Err(e);
                }
            };
            if src.is_none() {
                src = self.unit_addr(chosen.unit, dest);
            }
            let mut hop = Hop {
                kind: "device",
                title: display_name(self.g, dev),
                detail: vec![
                    format!(
                        "in on {}",
                        ingress.map_or("the start".to_owned(), |u| display_name(self.g, u))
                    ),
                    chosen.words.clone(),
                    format!("out on {}", display_name(self.g, chosen.unit)),
                ],
                nodes: vec![dev.to_string(), chosen.unit.to_string()],
                why: "The longest matching prefix wins; a tie goes to the lower preference."
                    .to_owned(),
                source: self.source_of(chosen.node, chosen.source.as_str()),
                ..Hop::default()
            };
            self.firewall(dev, ingress, chosen.unit, src, dest, &mut hop);
            self.t.hops.push(hop);

            let port = self.port_of(chosen.unit)?;
            let (mut steps, holder_port) =
                self.arrive(port, chosen.next, unit_vlan(self.g, chosen.unit), 0)?;
            self.t.hops.append(&mut steps);
            let holder_dev = self
                .g
                .device_of(holder_port)
                .ok_or("the far port is not on a device")?;
            ingress = self.units_on(holder_port).into_iter().next();
            dev = holder_dev;
        }
        Err(format!(
            "after {MAX_STEPS} hops the path had not reached {dest}; the design may hold a loop"
        ))
    }

    // ---- ends ---------------------------------------------------------

    /// The start device, the unit traffic enters on (when the start names
    /// one), and the source address when it is known.
    fn start(&self, text: &str) -> Result<(NodeId, Option<NodeId>, Option<IpAddr>), String> {
        if let Some(ElementId::Node(n)) = parse_display_id(self.g, text) {
            if !live(self.g, n) {
                return Err("the start is no longer in the design".to_owned());
            }
            return match n.kind {
                NodeKind::Device => Ok((n, None, None)),
                NodeKind::PhysicalPort => {
                    let d = self
                        .g
                        .device_of(n)
                        .ok_or("the start port is on no device")?;
                    let u = self.units_on(n).into_iter().next();
                    Ok((d, u, u.and_then(|u| self.unit_addrs(u).first().copied())))
                }
                NodeKind::LogicalUnit => {
                    let d = self
                        .g
                        .device_of(n)
                        .ok_or("the start unit is on no device")?;
                    Ok((d, Some(n), self.unit_addrs(n).first().copied()))
                }
                _ => Err(format!(
                    "{} is not a device, port or interface unit",
                    display_name(self.g, n)
                )),
            };
        }
        if let Ok(ip) = text.trim().parse::<IpAddr>() {
            return match self.holder_of(ip) {
                Some((d, u)) => Ok((d, Some(u), Some(ip))),
                None => Err(format!("no device in the design holds {ip}")),
            };
        }
        Err(format!(
            "could not read \"{text}\" as a device, port or address"
        ))
    }

    /// The destination address, and the device that owns it when the person
    /// named one.
    fn end(&self, text: &str) -> Result<(IpAddr, Option<NodeId>), String> {
        if let Some(ElementId::Node(n)) = parse_display_id(self.g, text) {
            let name = display_name(self.g, n);
            let (dev, addrs) = match n.kind {
                NodeKind::Device => (n, self.device_addrs(n)),
                NodeKind::LogicalUnit => (self.g.device_of(n).unwrap_or(n), self.unit_addrs(n)),
                NodeKind::PhysicalPort => (
                    self.g.device_of(n).unwrap_or(n),
                    self.units_on(n)
                        .into_iter()
                        .flat_map(|u| self.unit_addrs(u))
                        .collect(),
                ),
                _ => return Err(format!("{name} is not a device, port or interface unit")),
            };
            return match addrs.as_slice() {
                [] => Err(format!("{name} has no address in the design")),
                [a] => Ok((*a, Some(dev))),
                [a, ..] => Ok((*a, Some(dev))),
            };
        }
        match text.trim().parse::<IpAddr>() {
            Ok(ip) => Ok((ip, self.holder_of(ip).map(|(d, _)| d))),
            Err(_) => Err(format!("could not read \"{text}\" as an address or device")),
        }
    }

    // ---- addresses ----------------------------------------------------

    fn device_units(&self, dev: NodeId) -> Vec<NodeId> {
        let mut out = Vec::new();
        for i in children(self.g, dev, EdgeKind::HasInterface) {
            out.extend(children(self.g, i, EdgeKind::HasUnit));
        }
        out
    }

    fn unit_addrs(&self, unit: NodeId) -> Vec<IpAddr> {
        let mut out: Vec<IpAddr> = children(self.g, unit, EdgeKind::HasAddress)
            .into_iter()
            .filter_map(|a| self.g.node(a))
            .filter_map(|n| address::value(n).ok().map(|v| v.addr))
            .collect();
        out.sort();
        out
    }

    fn unit_prefixes(&self, unit: NodeId) -> Vec<(IpAddr, u8)> {
        children(self.g, unit, EdgeKind::HasAddress)
            .into_iter()
            .filter_map(|a| self.g.node(a))
            .filter_map(|n| address::value(n).ok().map(|v| (v.addr, v.prefix_len)))
            .collect()
    }

    fn device_addrs(&self, dev: NodeId) -> Vec<IpAddr> {
        let mut out: Vec<IpAddr> = self
            .device_units(dev)
            .into_iter()
            .flat_map(|u| self.unit_addrs(u))
            .collect();
        out.sort();
        out
    }

    fn owns(&self, dev: NodeId, ip: IpAddr) -> bool {
        self.device_addrs(dev).contains(&ip)
    }

    fn holder_of(&self, ip: IpAddr) -> Option<(NodeId, NodeId)> {
        let mut found = None;
        for d in self.g.nodes_of_kind(NodeKind::Device).map(|n| n.id) {
            if !live(self.g, d) {
                continue;
            }
            for u in self.device_units(d) {
                if self.unit_addrs(u).contains(&ip) {
                    found.get_or_insert((d, u));
                }
            }
        }
        found
    }

    /// The address on `unit` that shares a subnet with `toward`, else its first.
    fn unit_addr(&self, unit: NodeId, toward: IpAddr) -> Option<IpAddr> {
        let ps = self.unit_prefixes(unit);
        ps.iter()
            .find(|(a, l)| prefix_has(*a, *l, toward))
            .or_else(|| ps.first())
            .map(|(a, _)| *a)
    }

    // ---- routes -------------------------------------------------------

    fn route(&self, dev: NodeId, dest: IpAddr) -> Result<Chosen, String> {
        let name = display_name(self.g, dev);
        // (prefix length, preference, chosen)
        let mut found: Vec<(u8, u32, Chosen)> = Vec::new();

        for u in self.device_units(dev) {
            if self
                .g
                .node(u)
                .is_some_and(|n| logical_unit::admin_up(n) == Ok(&false))
            {
                continue;
            }
            for (a, l) in self.unit_prefixes(u) {
                if prefix_has(a, l, dest) {
                    found.push((
                        l,
                        0,
                        Chosen {
                            unit: u,
                            next: dest,
                            words: format!("connected: {} is on {}/{}", dest, mask(a, l), l),
                            node: u,
                            source: "LogicalUnit.index".to_owned(),
                        },
                    ));
                }
            }
        }

        for ri in children(self.g, dev, EdgeKind::HasRoutingInstance) {
            for r in children(self.g, ri, EdgeKind::HasStaticRoute) {
                let Some(node) = self.g.node(r) else { continue };
                let Ok(p) = static_route::destination(node) else {
                    continue;
                };
                if !prefix_has(p.addr, p.len, dest) {
                    continue;
                }
                let pref = static_route::preference(node).map_or(u32::MAX, |p| u32::from(*p));
                let hops = static_route::next_hop(node)
                    .map(Vec::as_slice)
                    .unwrap_or(&[]);
                let words = format!("static route {}/{}", p.addr, p.len);
                let chosen = match hops {
                    [] => {
                        return Err(format!(
                            "the static route {}/{} on {name} names no next hop",
                            p.addr, p.len
                        ))
                    }
                    [NextHop::Address(a)] => {
                        let via = a.0;
                        let unit = self.device_units(dev).into_iter().find(|u| {
                            self.unit_prefixes(*u)
                                .iter()
                                .any(|(ua, l)| prefix_has(*ua, *l, via))
                        });
                        let Some(unit) = unit else {
                            return Err(format!(
                                "the static route {}/{} on {name} goes via {via}, and no interface on {name} reaches {via}",
                                p.addr, p.len
                            ));
                        };
                        Chosen {
                            unit,
                            next: via,
                            words: format!("{words} via {via}"),
                            node: r,
                            source: "StaticRoute.destination".to_owned(),
                        }
                    }
                    [NextHop::Interface(id)] => {
                        let unit = match self.g.resolve_ref(*id) {
                            Some(ElementId::Node(n)) if n.kind == NodeKind::LogicalUnit && live(self.g, n) => n,
                            _ => {
                                return Err(format!(
                                    "the static route {}/{} on {name} names an interface that is not in this design",
                                    p.addr, p.len
                                ))
                            }
                        };
                        Chosen {
                            unit,
                            next: dest,
                            words: format!("{words} out {}", display_name(self.g, unit)),
                            node: r,
                            source: "StaticRoute.destination".to_owned(),
                        }
                    }
                    [NextHop::Discard] | [NextHop::Reject] => {
                        return Err(format!(
                            "the best route on {name} for {dest} is {}/{}, which the config sets to discard",
                            p.addr, p.len
                        ))
                    }
                    [_] => {
                        return Err(format!(
                            "the static route {}/{} on {name} uses a next hop this trace does not read",
                            p.addr, p.len
                        ))
                    }
                    _ => {
                        return Err(format!(
                            "the static route {}/{} on {name} has more than one next hop; could not establish which one the flow takes",
                            p.addr, p.len
                        ))
                    }
                };
                found.push((p.len, pref, chosen));
            }
        }

        // Longest prefix first, then the lower preference (connected counts 0).
        let best = found
            .iter()
            .map(|(l, p, _)| (*l, std::cmp::Reverse(*p)))
            .max();
        let Some(best) = best else {
            return Err(format!(
                "no connected or static route on {name} covers {dest}; learned routes are not in the design, so the route on {name} could not be established"
            ));
        };
        let mut top: Vec<Chosen> = found
            .into_iter()
            .filter(|(l, p, _)| (*l, std::cmp::Reverse(*p)) == best)
            .map(|(_, _, c)| c)
            .collect();
        top.sort_by(|a, b| a.words.cmp(&b.words));
        top.dedup_by(|a, b| a.words == b.words);
        if top.len() > 1 {
            return Err(format!(
                "more than one route on {name} is equally specific for {dest}; could not establish which one is used"
            ));
        }
        Ok(top.remove(0))
    }

    // ---- cables, patch panels, switches -----------------------------------

    fn units_on(&self, port: NodeId) -> Vec<NodeId> {
        let mut out = Vec::new();
        for e in self
            .g
            .inn(port, EdgeKind::Occupies)
            .filter(|e| e.absent_since.is_none())
        {
            out.extend(children(self.g, e.from, EdgeKind::HasUnit));
        }
        out.sort();
        out
    }

    fn port_of(&self, unit: NodeId) -> Result<NodeId, String> {
        let name = display_name(self.g, unit);
        let iface = self
            .g
            .owner(unit)
            .ok_or_else(|| format!("{name} belongs to no interface"))?;
        let ports = children(self.g, iface, EdgeKind::Occupies);
        match ports.as_slice() {
            [p] => Ok(*p),
            [] => Err(format!(
                "{name} is not tied to a port, so the cable it leaves by could not be established"
            )),
            _ => Err(format!(
                "{name} sits on more than one port; could not establish which carries the flow"
            )),
        }
    }

    /// The far end of the cable on `port`, with the cable.
    fn cable_far(&self, port: NodeId) -> Option<(NodeId, NodeId)> {
        for e in self
            .g
            .inn(port, EdgeKind::Terminates)
            .filter(|e| e.absent_since.is_none())
        {
            let cable = e.from;
            if !live(self.g, cable) {
                continue;
            }
            for o in self
                .g
                .out(cable, EdgeKind::Terminates)
                .filter(|o| o.absent_since.is_none())
            {
                if o.to != port && o.to.kind == NodeKind::PhysicalPort && live(self.g, o.to) {
                    return Some((cable, o.to));
                }
            }
        }
        None
    }

    /// The port a patch panel passes `port` through to, if it has one.
    fn pass_through(&self, port: NodeId) -> Vec<NodeId> {
        let mut out: Vec<NodeId> = self
            .g
            .out(port, EdgeKind::PassThrough)
            .filter(|e| e.absent_since.is_none())
            .map(|e| e.to)
            .chain(
                self.g
                    .inn(port, EdgeKind::PassThrough)
                    .filter(|e| e.absent_since.is_none())
                    .map(|e| e.from),
            )
            .filter(|p| live(self.g, *p))
            .collect();
        out.sort();
        out.dedup();
        out
    }

    /// Follow the cable from `from_port` through any patch panels to the port
    /// where it meets a device that is not a panel. The steps are cable hops.
    fn cable_chain(&self, from_port: NodeId) -> Result<(Vec<Hop>, NodeId), String> {
        let mut hops = Vec::new();
        let mut here = from_port;
        for _ in 0..MAX_STEPS {
            let Some((cable, far)) = self.cable_far(here) else {
                return Err(format!(
                    "no cable is recorded on {} of {}",
                    display_name(self.g, here),
                    self.g
                        .device_of(here)
                        .map_or(String::new(), |d| display_name(self.g, d))
                ));
            };
            hops.push(Hop {
                kind: "cable",
                title: "cable".to_owned(),
                detail: vec![format!(
                    "{} {} to {} {}",
                    self.dev_name(here),
                    display_name(self.g, here),
                    self.dev_name(far),
                    display_name(self.g, far)
                )],
                nodes: vec![here.to_string(), cable.to_string(), far.to_string()],
                why: "The cable recorded between these two ports.".to_owned(),
                source: self.source_of(cable, "Cable.label"),
                ..Hop::default()
            });
            let passes = self.pass_through(far);
            match passes.as_slice() {
                [] => return Ok((hops, far)),
                [next] => {
                    hops.push(Hop {
                        kind: "cable",
                        title: "patch panel".to_owned(),
                        detail: vec![format!(
                            "{} {} passes through to {}",
                            self.dev_name(far),
                            display_name(self.g, far),
                            display_name(self.g, *next)
                        )],
                        nodes: vec![far.to_string(), next.to_string()],
                        why: "A patch panel passes a port straight through to its pair.".to_owned(),
                        ..Hop::default()
                    });
                    here = *next;
                }
                _ => {
                    return Err(format!(
                        "{} passes through to more than one port; could not establish which the cable takes",
                        display_name(self.g, far)
                    ))
                }
            }
        }
        Err("the cable path is longer than this trace walks".to_owned())
    }

    fn dev_name(&self, port: NodeId) -> String {
        self.g
            .device_of(port)
            .map_or(String::new(), |d| display_name(self.g, d))
    }

    fn vlans_on(&self, port: NodeId) -> Vec<u16> {
        let mut out: Vec<u16> = Vec::new();
        for u in self.units_on(port) {
            for e in self
                .g
                .out(u, EdgeKind::VlanMember)
                .filter(|e| e.absent_since.is_none())
            {
                if let Some(n) = self.g.node(e.to) {
                    if let Ok(v) = vlan::vlan_id(n) {
                        out.push(v.0);
                    }
                }
            }
        }
        out.sort_unstable();
        out.dedup();
        out
    }

    /// Cross the cable from `from_port` and say what is at the other end: a
    /// device holding `next` (done), or switches on the way to one. Returns the
    /// hops and the port on the device that holds `next`.
    fn arrive(
        &self,
        from_port: NodeId,
        next: IpAddr,
        hint: Option<u16>,
        depth: usize,
    ) -> Result<(Vec<Hop>, NodeId), String> {
        let (mut hops, far) = self.cable_chain(from_port)?;
        let dev = self
            .g
            .device_of(far)
            .ok_or("the far port is on no device")?;
        let dev_name = display_name(self.g, dev);
        if self.owns(dev, next) {
            return Ok((hops, far));
        }
        if self
            .units_on(far)
            .iter()
            .any(|u| !self.unit_addrs(*u).is_empty())
        {
            return Err(format!(
                "the cable reaches {dev_name}, which does not hold {next}; could not establish where the flow goes from there"
            ));
        }
        // A port with no address of its own: a switch. Which VLAN?
        if depth >= L2_DEPTH {
            return Err("the path passes through more switches than this trace follows".to_owned());
        }
        let on = self.vlans_on(far);
        let vlan = match (on.as_slice(), hint) {
            ([], _) => {
                return Err(format!(
                    "could not establish the VLAN on {} of {dev_name}",
                    display_name(self.g, far)
                ))
            }
            ([v], None) => *v,
            ([v], Some(h)) if *v == h => *v,
            (vs, Some(h)) if vs.contains(&h) => h,
            (vs, Some(h)) => {
                return Err(format!(
                    "VLAN {h} is not among the VLANs read on {} of {dev_name} ({})",
                    display_name(self.g, far),
                    list(vs)
                ))
            }
            (vs, None) => {
                return Err(format!(
                "{} of {dev_name} carries VLANs {}; could not establish which one the flow uses",
                display_name(self.g, far),
                list(vs)
            ))
            }
        };

        let mut paths: Vec<(Vec<Hop>, NodeId)> = Vec::new();
        let mut errs: Vec<String> = Vec::new();
        let candidates: Vec<NodeId> = self
            .device_ports(dev)
            .into_iter()
            .filter(|p| *p != far && self.vlans_on(*p).contains(&vlan))
            .collect();
        for c in &candidates {
            let sw = Hop {
                kind: "switch",
                title: dev_name.clone(),
                detail: vec![format!(
                    "VLAN {vlan}: in on {}, out on {}",
                    display_name(self.g, far),
                    display_name(self.g, *c)
                )],
                nodes: vec![dev.to_string(), far.to_string(), c.to_string()],
                why: "A switch carries a frame to the other ports in its VLAN.".to_owned(),
                source: String::new(),
                ..Hop::default()
            };
            match self.arrive(*c, next, Some(vlan), depth + 1) {
                Ok((mut rest, hp)) => {
                    let mut all = vec![sw];
                    all.append(&mut rest);
                    paths.push((all, hp));
                }
                Err(e) => errs.push(e),
            }
        }
        match paths.len() {
            1 => {
                let (mut p, hp) = paths.remove(0);
                hops.append(&mut p);
                Ok((hops, hp))
            }
            0 => Err(format!(
                "no port of {dev_name} in VLAN {vlan} leads to a device holding {next}{}",
                match errs.first() {
                    Some(e) if candidates.len() == 1 => format!(" ({e})"),
                    _ => String::new(),
                }
            )),
            n => Err(format!(
                "{n} paths through {dev_name} in VLAN {vlan} lead to {next}; could not establish which one the flow takes"
            )),
        }
    }

    fn device_ports(&self, dev: NodeId) -> Vec<NodeId> {
        let mut out = Vec::new();
        for c in children(self.g, dev, EdgeKind::HasChassis) {
            out.extend(children(self.g, c, EdgeKind::HasPort));
        }
        out.sort();
        out
    }

    // ---- firewall -----------------------------------------------------

    fn firewall(
        &self,
        dev: NodeId,
        ingress: Option<NodeId>,
        egress: NodeId,
        src: Option<IpAddr>,
        dst: IpAddr,
        hop: &mut Hop,
    ) {
        let sets = children(self.g, dev, EdgeKind::HasPolicySet);
        if sets.is_empty() {
            return;
        }
        let zone_of = |u: NodeId| -> Option<NodeId> {
            self.g
                .inn(u, EdgeKind::ZoneMember)
                .filter(|e| e.absent_since.is_none())
                .map(|e| e.from)
                .find(|z| live(self.g, *z))
        };
        let zin = ingress.and_then(zone_of);
        let zout = zone_of(egress);
        let zname = |z: Option<NodeId>, unit: Option<NodeId>| match (z, unit) {
            (Some(z), _) => display_name(self.g, z),
            (None, Some(u)) => format!("no zone read for {}", display_name(self.g, u)),
            (None, None) => "no ingress interface".to_owned(),
        };
        hop.scope = format!("{} to {}", zname(zin, ingress), zname(zout, Some(egress)));

        for s in sets {
            let scope = self.g.node(s).and_then(|n| policy_set::scope(n).ok());
            let place = match scope {
                Some(PolicyScope::ZonePair { from, to }) => {
                    let f = self.zone_ref(*from);
                    let t = self.zone_ref(*to);
                    match (zin, zout, f, t) {
                        (Some(zi), Some(zo), Some(f), Some(t)) if zi == f && zo == t => Place::Here,
                        (Some(_), Some(_), Some(_), Some(_)) => Place::Elsewhere,
                        _ => Place::Unknown,
                    }
                }
                Some(PolicyScope::Global) => Place::Here,
                Some(PolicyScope::InterfaceDirection { .. }) | None => Place::Unplaced,
            };
            let lines = self.policy_lines(s, src, dst);
            match place {
                Place::Here => hop.policies.extend(lines),
                Place::Unplaced => {
                    hop.unplaced_why =
                        "could not establish which interface and direction these rules apply to"
                            .to_owned();
                    hop.unplaced.extend(lines.into_iter().map(|mut l| {
                        l.state = "can't tell";
                        l.reason = "the rule's interface and direction were not read".to_owned();
                        l.could_affect = true;
                        l
                    }));
                }
                Place::Unknown => {
                    if hop.unplaced_why.is_empty() {
                        hop.unplaced_why =
                            "could not establish the zones on this hop, so which set applies"
                                .to_owned();
                    }
                    // Only the sets that end in the egress zone could be this hop's, and only when the
                    // zone the traffic enters from is the one thing missing.
                    let ends_here = zout.is_some()
                        && matches!(scope, Some(PolicyScope::ZonePair { to, .. })
                            if self.zone_ref(*to) == zout);
                    if ends_here {
                        hop.unplaced.extend(lines.into_iter().map(|mut l| {
                            l.state = "can't tell";
                            l.reason = "which zone the traffic enters from was not read, so whether this set applies could not be established".to_owned();
                            l.could_affect = true;
                            l
                        }));
                    }
                }
                Place::Elsewhere => {}
            }
        }
        hop.detail.push("NAT is not read".to_owned());
        hop.detail
            .push("Policies are listed as stored; qualifiers the config uses but Fathom does not read are not shown".to_owned());
    }

    fn zone_ref(&self, r: fathom_id::NodeId) -> Option<NodeId> {
        match self.g.resolve_ref(r) {
            Some(ElementId::Node(n)) if n.kind == NodeKind::Zone && live(self.g, n) => Some(n),
            _ => None,
        }
    }

    fn policy_lines(&self, set: NodeId, src: Option<IpAddr>, dst: IpAddr) -> Vec<PolicyLine> {
        let mut ps: Vec<(u32, NodeId)> = children(self.g, set, EdgeKind::HasPolicy)
            .into_iter()
            .map(|p| {
                let o = self
                    .g
                    .node(p)
                    .and_then(|n| security_policy::ordinal(n).ok().copied())
                    .unwrap_or(u32::MAX);
                (o, p)
            })
            .collect();
        ps.sort();
        ps.into_iter()
            .map(|(_, p)| self.policy_line(p, src, dst))
            .collect()
    }

    fn policy_line(&self, p: NodeId, src: Option<IpAddr>, dst: IpAddr) -> PolicyLine {
        let node = self.g.node(p);
        let get = |f: fn(&fathom_graph::Node) -> Result<&bool, fathom_ir::bag::FieldError>| {
            node.and_then(|n| f(n).ok().copied()).unwrap_or(false)
        };
        let name = node
            .and_then(|n| security_policy::name(n).ok().map(|i| i.0.clone()))
            .unwrap_or_default();
        let action = match node.and_then(|n| security_policy::action(n).ok()) {
            Some(PolicyAction::Permit) => "permit".to_owned(),
            Some(PolicyAction::Deny) => "deny".to_owned(),
            Some(PolicyAction::Reject) => "reject".to_owned(),
            Some(PolicyAction::Unknown(s)) => s.clone(),
            None => "action not read".to_owned(),
        };
        let ordinal = node
            .and_then(|n| security_policy::ordinal(n).ok().map(|o| o.to_string()))
            .unwrap_or_default();

        let off = node.and_then(|n| security_policy::enabled(n).ok().copied()) == Some(false);
        let (state, reason) = if off {
            ("doesn't match", "turned off in the config".to_owned())
        } else {
            let parts = [
                (
                    "source",
                    self.addr_state(
                        p,
                        EdgeKind::MatchSource,
                        get(security_policy::match_any_source),
                        src,
                        "source address",
                    ),
                ),
                (
                    "destination",
                    self.addr_state(
                        p,
                        EdgeKind::MatchDestination,
                        get(security_policy::match_any_destination),
                        Some(dst),
                        "destination address",
                    ),
                ),
                (
                    "application",
                    self.app_state(p, get(security_policy::match_any_application)),
                ),
            ];
            combine(&parts)
        };
        PolicyLine {
            id: p.to_string(),
            ordinal,
            name,
            action,
            state,
            reason,
            could_affect: state != "doesn't match",
        }
    }

    fn addr_state(
        &self,
        p: NodeId,
        edge: EdgeKind,
        any: bool,
        ip: Option<IpAddr>,
        what: &str,
    ) -> (State, String) {
        if any {
            return (State::Matches, "any".to_owned());
        }
        let mut objects: Vec<NodeId> = Vec::new();
        for t in children(self.g, p, edge) {
            self.expand(t, &mut objects, 0);
        }
        if objects.is_empty() {
            return (State::Cant, format!("no {what} was read for this policy"));
        }
        let Some(ip) = ip else {
            return (State::Cant, format!("the {what} was not established"));
        };
        let mut cant: Option<String> = None;
        for o in objects {
            let name = display_name(self.g, o);
            match self.g.node(o).and_then(|n| address_object::value(n).ok()) {
                Some(AddressValue::Prefix(IpPrefix { addr, len }))
                    if prefix_has(*addr, *len, ip) =>
                {
                    return (State::Matches, format!("{ip} is in {name}"))
                }
                Some(AddressValue::Host(h)) if h.0 == ip => {
                    return (State::Matches, format!("{ip} is {name}"))
                }
                Some(AddressValue::Range(IpRange { lo, hi })) if *lo <= ip && ip <= *hi => {
                    return (State::Matches, format!("{ip} is in {name}"))
                }
                Some(AddressValue::Prefix(_) | AddressValue::Host(_) | AddressValue::Range(_)) => {}
                Some(AddressValue::Fqdn(_)) => {
                    cant.get_or_insert(format!("{name} is a name; its addresses are not read"));
                }
                Some(AddressValue::Any) => {
                    cant.get_or_insert(format!(
                        "{name} is the vendor's \"any\"; what it covers is not read"
                    ));
                }
                None => {
                    cant.get_or_insert(format!("{name} is named but its address was not read"));
                }
            }
        }
        match cant {
            Some(c) => (State::Cant, c),
            None => (State::No, format!("{ip} is in none of its addresses")),
        }
    }

    /// An address object, or the objects an address set holds.
    fn expand(&self, n: NodeId, out: &mut Vec<NodeId>, depth: usize) {
        match n.kind {
            NodeKind::AddressObject => out.push(n),
            NodeKind::AddressSet if depth < 4 => {
                let members = children(self.g, n, EdgeKind::Contains);
                if members.is_empty() {
                    // An empty set is a name with nothing read behind it.
                    out.push(n);
                }
                for m in members {
                    self.expand(m, out, depth + 1);
                }
            }
            _ => out.push(n),
        }
    }

    fn app_state(&self, p: NodeId, any: bool) -> (State, String) {
        if any {
            return (State::Matches, "any".to_owned());
        }
        let apps = children(self.g, p, EdgeKind::MatchApplication);
        if apps.is_empty() {
            return (
                State::Cant,
                "no application was read for this policy".to_owned(),
            );
        }
        let Some(flow) = self.flow else {
            return (
                State::Cant,
                "no protocol or port was given for the flow".to_owned(),
            );
        };
        let mut cant: Option<String> = None;
        for a in apps {
            let name = display_name(self.g, a);
            match self.g.node(a).and_then(|n| application::l4(n).ok()) {
                Some(L4Spec::Any) => {
                    return (State::Matches, format!("{name} covers any protocol"))
                }
                Some(L4Spec::Protocol {
                    protocol,
                    destination_ports,
                    ..
                }) => {
                    let ports = destination_ports.is_empty()
                        || destination_ports
                            .iter()
                            .any(|r| r.lo <= flow.port && flow.port <= r.hi);
                    if protocol.0 == flow.protocol && ports {
                        return (State::Matches, format!("{name} covers {}", self.t.flow));
                    }
                }
                None => {
                    cant.get_or_insert("application not read".to_owned());
                }
            }
        }
        match cant {
            Some(c) => (State::Cant, c),
            None => (
                State::No,
                format!("none of its applications covers {}", self.t.flow),
            ),
        }
    }

    // ---- provenance ---------------------------------------------------

    /// Where a stored field came from, in words.
    fn source_of(&self, node: NodeId, field: &str) -> String {
        let Some((_, k)) = fathom_ir::generated::ir_types::FIELD_KEYS
            .iter()
            .find(|(n, _)| *n == field)
        else {
            return String::new();
        };
        let Ok(info) = self
            .g
            .presence(ElementId::Node(node), fathom_ir::bag::FieldKey(*k))
        else {
            return String::new();
        };
        match info
            .prov
            .and_then(|p| self.g.provenance(p))
            .map(|r| &r.origin)
        {
            Some(Origin::Parsed { .. }) => "read from a pasted config".to_owned(),
            Some(Origin::Hand) => "entered by hand".to_owned(),
            None => String::new(),
        }
    }
}

enum Place {
    Here,
    Elsewhere,
    Unknown,
    Unplaced,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum State {
    Matches,
    No,
    Cant,
}

fn combine(parts: &[(&str, (State, String))]) -> (&'static str, String) {
    if let Some((w, (_, r))) = parts.iter().find(|(_, (s, _))| *s == State::No) {
        return ("doesn't match", format!("{w}: {r}"));
    }
    let cants: Vec<String> = parts
        .iter()
        .filter(|(_, (s, _))| *s == State::Cant)
        .map(|(w, (_, r))| format!("{w}: {r}"))
        .collect();
    if cants.is_empty() {
        let all: Vec<String> = parts
            .iter()
            .map(|(w, (_, r))| format!("{w}: {r}"))
            .collect();
        ("matches", all.join("; "))
    } else {
        ("can't tell", cants.join("; "))
    }
}

fn live(g: &Graph, n: NodeId) -> bool {
    g.node(n).is_some_and(|node| node.absent_since.is_none())
}

fn children(g: &Graph, n: NodeId, k: EdgeKind) -> Vec<NodeId> {
    let mut v: Vec<NodeId> = g
        .out(n, k)
        .filter(|e| e.absent_since.is_none())
        .map(|e| e.to)
        .filter(|t| live(g, *t))
        .collect();
    v.sort();
    v
}

fn unit_vlan(g: &Graph, unit: NodeId) -> Option<u16> {
    g.node(unit)
        .and_then(|n| logical_unit::vlan_id(n).ok())
        .map(|v| v.0)
}

fn list(vs: &[u16]) -> String {
    vs.iter().map(u16::to_string).collect::<Vec<_>>().join(", ")
}

fn proto_word(p: u8) -> String {
    match p {
        6 => "TCP".to_owned(),
        17 => "UDP".to_owned(),
        n => format!("protocol {n}"),
    }
}

/// True when `ip` is inside `net`/`len`, same family only.
fn prefix_has(net: IpAddr, len: u8, ip: IpAddr) -> bool {
    match (net, ip) {
        (IpAddr::V4(n), IpAddr::V4(i)) if len <= 32 => {
            let m = if len == 0 {
                0
            } else {
                u32::MAX << (32 - u32::from(len))
            };
            u32::from(n) & m == u32::from(i) & m
        }
        (IpAddr::V6(n), IpAddr::V6(i)) if len <= 128 => {
            let m = if len == 0 {
                0
            } else {
                u128::MAX << (128 - u32::from(len))
            };
            u128::from(n) & m == u128::from(i) & m
        }
        _ => false,
    }
}

/// `net` with the host bits cleared, for "10.0.0.0/24" from "10.0.0.1/24".
fn mask(net: IpAddr, len: u8) -> IpAddr {
    match net {
        IpAddr::V4(n) if len <= 32 => {
            let m = if len == 0 {
                0
            } else {
                u32::MAX << (32 - u32::from(len))
            };
            IpAddr::V4((u32::from(n) & m).into())
        }
        IpAddr::V6(n) if len <= 128 => {
            let m = if len == 0 {
                0
            } else {
                u128::MAX << (128 - u32::from(len))
            };
            IpAddr::V6((u128::from(n) & m).into())
        }
        other => other,
    }
}
