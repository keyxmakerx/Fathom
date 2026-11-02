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
//! SVIs and irb (a gateway leaves through its device's ports in its VLAN), LAGs
//! (the links of one bundle to one device are one way; which link a flow hashes
//! onto is not read), connected and static routes (longest prefix, then
//! connected over static, then preference), zone pairs
//! and their policies. Not read, and said so: learned routes, NAT, and any
//! policy qualifier the dictionaries do not bind (a trace lists policies as
//! stored).

use std::net::IpAddr;

use fathom_graph::{ElementId, Graph, NodeId, Origin};
use fathom_ir::generated::accessors::{
    address, address_object, address_set, application, card, logical_unit, physical_port,
    policy_set, security_policy, static_route, vlan,
};
use fathom_ir::generated::ir_types::{EdgeKind, NodeKind, PolicyAction};
use fathom_ir::scalar::{IpPrefix, IpRange};
use fathom_ir::value::{AddressValue, L4Spec, NextHop, PolicyScope};

use crate::element::{display_name, parse_display_id};

/// The most hops one trace walks. A loop in the design ends here, said.
const MAX_STEPS: usize = 24;

/// How far one switch search wanders through further switches. A three-tier campus with a
/// stretched VLAN (access, distribution, core, distribution, access) is five; MLAG pairs add more.
const L2_DEPTH: usize = 8;
/// Ports the switch search may visit in one trace, so a meshed fabric ends in "could not establish" and not a frozen tab.
const SEARCH_BUDGET: u32 = 2_000;

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
        steps: std::cell::Cell::new(0),
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
    /// Switch-search steps taken; the search ends at `SEARCH_BUDGET`.
    steps: std::cell::Cell<u32>,
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
        // A source address is set only when the person gave it (an address as the start), or the start
        // interface (else the start device) holds exactly one address of the destination's family.
        if src.is_none() {
            let held = match ingress {
                Some(u) => self.unit_addrs(u),
                None => self.device_addrs(dev),
            };
            let same: Vec<IpAddr> = held
                .into_iter()
                .filter(|a| a.is_ipv4() == dest.is_ipv4())
                .collect();
            if let [a] = same.as_slice() {
                src = Some(*a);
            }
        }
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

            let (mut steps, holder_port) = self.leave(dev, chosen.unit, chosen.next)?;
            self.t.hops.append(&mut steps);
            let holder_dev = self
                .g
                .device_of(holder_port)
                .ok_or("the far port is not on a device")?;
            // The unit that holds the next hop; none, or several, and the entry unit is not stated.
            let mut entry: Vec<NodeId> = self
                .units_on(holder_port)
                .into_iter()
                .filter(|u| {
                    self.unit_prefixes(*u)
                        .iter()
                        .any(|(a, l)| prefix_has(*a, *l, chosen.next))
                })
                .collect();
            if entry.is_empty() {
                // Arrived on a switch port: the unit that holds the next hop is the VLAN's
                // gateway (an SVI or irb), wherever it sits on the device.
                entry = self
                    .device_units(holder_dev)
                    .into_iter()
                    .filter(|u| self.unit_addrs(*u).contains(&chosen.next))
                    .collect();
            }
            ingress = (entry.len() == 1).then(|| entry[0]);
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
                    // Several units on one port: which one traffic uses is not stated.
                    let units = self.units_on(n);
                    let u = (units.len() == 1).then(|| units[0]);
                    Ok((d, u, None))
                }
                NodeKind::LogicalUnit => {
                    let d = self
                        .g
                        .device_of(n)
                        .ok_or("the start unit is on no device")?;
                    Ok((d, Some(n), None))
                }
                _ => Err(format!(
                    "{} is not a device, port or interface unit",
                    display_name(self.g, n)
                )),
            };
        }
        if let Ok(ip) = text.trim().parse::<IpAddr>() {
            let held = self.holders_of(ip);
            return match held.as_slice() {
                [(d, u)] => Ok((*d, Some(*u), Some(ip))),
                [] => Err(format!("no device in the design holds {ip}")),
                _ => Err(format!(
                    "{ip} is held by more than one device ({}); start from the device instead",
                    self.names(&held)
                )),
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
            // An address two devices hold (one private range at two sites) names no one device:
            // the walk ends wherever the path meets a holder.
            Ok(ip) => Ok((
                ip,
                match self.holders_of(ip).as_slice() {
                    [(d, _)] => Some(*d),
                    _ => None,
                },
            )),
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

    /// Every device that holds `ip`, with the first unit on it that does; one entry per device.
    fn holders_of(&self, ip: IpAddr) -> Vec<(NodeId, NodeId)> {
        let mut found = Vec::new();
        for d in self.g.nodes_of_kind(NodeKind::Device).map(|n| n.id) {
            if !live(self.g, d) {
                continue;
            }
            if let Some(u) = self
                .device_units(d)
                .into_iter()
                .find(|u| self.unit_addrs(*u).contains(&ip))
            {
                found.push((d, u));
            }
        }
        found.sort();
        found
    }

    fn names(&self, held: &[(NodeId, NodeId)]) -> String {
        held.iter()
            .map(|(d, _)| display_name(self.g, *d))
            .collect::<Vec<_>>()
            .join(", ")
    }

    // ---- routes -------------------------------------------------------

    fn route(&self, dev: NodeId, dest: IpAddr) -> Result<Chosen, String> {
        let name = display_name(self.g, dev);
        if children(self.g, dev, EdgeKind::HasRoutingInstance).len() > 1 {
            return Err(format!(
                "{name} has more than one routing instance, and which one this flow uses could not be established"
            ));
        }
        // (prefix length, preference when stated, candidate). A candidate that cannot be followed is
        // kept, not returned: only the winning prefix may stop the trace.
        let mut found: Vec<(u8, Option<u32>, Result<Chosen, String>)> = Vec::new();
        // Prefix lengths a connected route covers. Every platform ranks a connected route above a
        // static one for the same prefix (Junos direct 0 against static 5; IOS and EOS distance 0
        // against 1), so an equally specific static route is never the one used.
        let mut connected_lens: Vec<u8> = Vec::new();

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
                    connected_lens.push(l);
                    found.push((
                        l,
                        Some(0),
                        Ok(Chosen {
                            unit: u,
                            next: dest,
                            words: format!("connected: {} is on {}/{}", dest, mask(a, l), l),
                            node: u,
                            source: "LogicalUnit.index".to_owned(),
                        }),
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
                if !prefix_has(p.addr, p.len, dest) || connected_lens.contains(&p.len) {
                    continue;
                }
                let pref = static_route::preference(node).ok().map(|p| u32::from(*p));
                found.push((p.len, pref, self.static_choice(dev, r, p.addr, p.len, dest)));
            }
        }

        // Longest prefix first.
        let Some(longest) = found.iter().map(|(l, _, _)| *l).max() else {
            return Err(format!(
                "no connected or static route on {name} covers {dest}; learned routes are not in the design, so the route on {name} could not be established"
            ));
        };
        let top: Vec<(Option<u32>, Result<Chosen, String>)> = found
            .into_iter()
            .filter(|(l, _, _)| *l == longest)
            .map(|(_, p, c)| (p, c))
            .collect();
        // Equal length: the lower preference wins, but a route whose preference was not read (a pasted
        // Junos route carries none) cannot be ranked against another.
        let stated: Vec<u32> = top.iter().filter_map(|(p, _)| *p).collect();
        let unstated = top.iter().filter(|(p, _)| p.is_none()).count();
        let mut winners: Vec<Result<Chosen, String>> = if unstated > 0 && !stated.is_empty() {
            return Err(format!(
                "routes on {name} equally specific for {dest} differ in whether their preference was read; could not establish which one is used"
            ));
        } else if unstated > 0 {
            top.into_iter().map(|(_, c)| c).collect()
        } else {
            let low = stated.iter().copied().min().unwrap_or(0);
            top.into_iter()
                .filter(|(p, _)| *p == Some(low))
                .map(|(_, c)| c)
                .collect()
        };
        winners.sort_by(|a, b| match (a, b) {
            (Ok(x), Ok(y)) => x.words.cmp(&y.words),
            (Err(x), Err(y)) => x.cmp(y),
            (Ok(_), Err(_)) => std::cmp::Ordering::Less,
            (Err(_), Ok(_)) => std::cmp::Ordering::Greater,
        });
        winners.dedup_by(|a, b| match (a, b) {
            (Ok(x), Ok(y)) => x.words == y.words,
            (Err(x), Err(y)) => x == y,
            _ => false,
        });
        if winners.len() > 1 {
            return Err(format!(
                "more than one route on {name} is equally specific for {dest}; could not establish which one is used"
            ));
        }
        winners.remove(0)
    }

    /// One static route as a way forward, or the reason it cannot be followed.
    fn static_choice(
        &self,
        dev: NodeId,
        r: NodeId,
        addr: IpAddr,
        len: u8,
        dest: IpAddr,
    ) -> Result<Chosen, String> {
        let name = display_name(self.g, dev);
        let node = self.g.node(r).ok_or("the route is gone")?;
        let words = format!("static route {addr}/{len}");
        let hops = static_route::next_hop(node)
            .map(Vec::as_slice)
            .unwrap_or(&[]);
        match hops {
            [] => Err(format!("the static route {addr}/{len} on {name} names no next hop")),
            [NextHop::Address(a)] => {
                let via = a.0;
                // The next hop resolves like any address: through the longest connected prefix on
                // an interface that is not shut down.
                let mut reach: Vec<(u8, NodeId)> = Vec::new();
                for u in self.device_units(dev) {
                    if self
                        .g
                        .node(u)
                        .is_some_and(|n| logical_unit::admin_up(n) == Ok(&false))
                    {
                        continue;
                    }
                    if let Some(l) = self
                        .unit_prefixes(u)
                        .iter()
                        .filter(|(ua, l)| prefix_has(*ua, *l, via))
                        .map(|(_, l)| *l)
                        .max()
                    {
                        reach.push((l, u));
                    }
                }
                let best = reach.iter().map(|(l, _)| *l).max();
                let units: Vec<NodeId> = reach
                    .iter()
                    .filter(|(l, _)| Some(*l) == best)
                    .map(|(_, u)| *u)
                    .collect();
                let unit = match units.as_slice() {
                    [u] => *u,
                    [] => {
                        return Err(format!(
                            "the static route {addr}/{len} on {name} goes via {via}, and no interface on {name} that is up reaches {via}"
                        ))
                    }
                    _ => {
                        return Err(format!(
                            "the static route {addr}/{len} on {name} goes via {via}, which more than one interface on {name} reaches; could not establish which one the flow leaves by"
                        ))
                    }
                };
                Ok(Chosen {
                    unit,
                    next: via,
                    words: format!("{words} via {via}"),
                    node: r,
                    source: "StaticRoute.destination".to_owned(),
                })
            }
            [NextHop::Interface(id)] => {
                let unit = match self.g.resolve_ref(*id) {
                    Some(ElementId::Node(n)) if n.kind == NodeKind::LogicalUnit && live(self.g, n) => n,
                    _ => {
                        return Err(format!(
                            "the static route {addr}/{len} on {name} names an interface that is not in this design"
                        ))
                    }
                };
                Ok(Chosen {
                    unit,
                    next: dest,
                    words: format!("{words} out {}", display_name(self.g, unit)),
                    node: r,
                    source: "StaticRoute.destination".to_owned(),
                })
            }
            [NextHop::Discard] | [NextHop::Reject] => Err(format!(
                "the best route on {name} for {dest} is {addr}/{len}, which the config sets to discard"
            )),
            [_] => Err(format!(
                "the static route {addr}/{len} on {name} uses a next hop this trace does not read"
            )),
            _ => Err(format!(
                "the static route {addr}/{len} on {name} has more than one next hop; could not establish which one the flow takes"
            )),
        }
    }

    // ---- cables, patch panels, switches -----------------------------------

    /// The units a port carries: its interface's own, and, for a link in a LAG, the
    /// aggregate's (the units of a bundle live on ae0 or Port-Channel1, not on its members).
    fn units_on(&self, port: NodeId) -> Vec<NodeId> {
        let mut out = Vec::new();
        for i in parents(self.g, port, EdgeKind::Occupies) {
            out.extend(children(self.g, i, EdgeKind::HasUnit));
            for agg in children(self.g, i, EdgeKind::MemberOfAggregate) {
                out.extend(children(self.g, agg, EdgeKind::HasUnit));
            }
        }
        out.sort();
        out.dedup();
        out
    }

    /// The LAG a port is a link of, when its interface is a member of one.
    fn lag_of(&self, port: NodeId) -> Option<NodeId> {
        parents(self.g, port, EdgeKind::Occupies)
            .into_iter()
            .flat_map(|i| children(self.g, i, EdgeKind::MemberOfAggregate))
            .next()
    }

    /// The ports a LAG's member links occupy.
    fn member_ports(&self, agg: NodeId) -> Vec<NodeId> {
        let mut out: Vec<NodeId> = parents(self.g, agg, EdgeKind::MemberOfAggregate)
            .into_iter()
            .flat_map(|i| children(self.g, i, EdgeKind::Occupies))
            .collect();
        out.sort();
        out.dedup();
        out
    }

    /// Leave `dev` by `unit` towards `next`: out of its port, out of a LAG's links, or, for
    /// an SVI or irb, out of the device's own ports in that VLAN. Returns the hops and the
    /// port on the device that holds `next`.
    fn leave(&self, dev: NodeId, unit: NodeId, next: IpAddr) -> Result<(Vec<Hop>, NodeId), String> {
        let name = display_name(self.g, unit);
        let dev_name = display_name(self.g, dev);
        let iface = self
            .g
            .owner(unit)
            .ok_or_else(|| format!("{name} belongs to no interface"))?;
        let hint = unit_vlan(self.g, unit);
        let start = [dev];
        if iface.kind == NodeKind::AggregateInterface {
            let ports = self.member_ports(iface);
            let agg = display_name(self.g, iface);
            if ports.is_empty() {
                return Err(format!(
                    "no link of {agg} on {dev_name} is tied to a port, so the cable it leaves by could not be established"
                ));
            }
            return self
                .fan(dev, None, &ports, next, hint, &start, &|_, _| None)
                .map_err(|m| m.text);
        }
        let ports = children(self.g, iface, EdgeKind::Occupies);
        match ports.as_slice() {
            [p] => return self.search(*p, next, hint, &start).map_err(|m| m.text),
            [] => {}
            _ => {
                return Err(format!(
                    "{name} sits on more than one port; could not establish which carries the flow"
                ))
            }
        }
        // No port of its own: an SVI or irb leaves through the device's ports in its VLAN.
        let vlans: Vec<u16> = parents(self.g, unit, EdgeKind::L3Interface)
            .into_iter()
            .filter_map(|v| {
                self.g
                    .node(v)
                    .and_then(|n| vlan::vlan_id(n).ok())
                    .map(|v| v.0)
            })
            .collect();
        let [vid] = vlans.as_slice() else {
            return Err(format!(
                "{name} is not tied to a port, so the cable it leaves by could not be established"
            ));
        };
        let vid = *vid;
        let candidates: Vec<NodeId> = self
            .device_ports(dev)
            .into_iter()
            .filter(|p| self.vlans_on(*p).contains(&vid))
            .collect();
        if candidates.is_empty() {
            return Err(format!(
                "{name} is the gateway of VLAN {vid}, and no port of {dev_name} is read as carrying VLAN {vid}"
            ));
        }
        let mk = |out: NodeId, note: Option<&str>| {
            let mut detail = vec![format!(
                "VLAN {vid}: from {name}, out on {}",
                display_name(self.g, out)
            )];
            detail.extend(note.map(str::to_owned));
            Some(Hop {
                kind: "switch",
                title: dev_name.clone(),
                detail,
                nodes: vec![dev.to_string(), unit.to_string(), out.to_string()],
                why: format!("{name} is the gateway of VLAN {vid}; the device switches the frame to its ports in that VLAN."),
                ..Hop::default()
            })
        };
        self.fan(dev, Some(vid), &candidates, next, Some(vid), &start, &mk)
            .map_err(|m| m.text)
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

    /// The parts a cable end sits in (ADR-0073): the card the port is on, and the optic in
    /// its cage, each as one line of the hop. Serials are left out; the trace says what, not
    /// which one.
    fn parts_at(&self, port: NodeId) -> Vec<String> {
        let mut out = Vec::new();
        let at = format!("{} {}", self.dev_name(port), display_name(self.g, port));
        if let Some(card) = self
            .g
            .out(port, EdgeKind::OnCard)
            .filter(|e| e.absent_since.is_none())
            .map(|e| e.to)
            .find(|c| live(self.g, *c))
        {
            let slot = self
                .g
                .node(card)
                .and_then(|n| card::slot(n).ok())
                .map_or(String::new(), |t| format!(" in slot {}", t.0.as_str()));
            out.push(format!("{at} is on the card{slot}"));
        }
        if let Some(optic) = self
            .g
            .node(port)
            .and_then(|n| physical_port::transceiver(n).ok())
        {
            let what: Vec<&str> = [
                optic.r#type.as_ref().map(|t| t.0.as_str()),
                optic.part.as_ref().map(|p| p.0.as_str()),
            ]
            .into_iter()
            .flatten()
            .collect();
            out.push(if what.is_empty() {
                format!("optic in {at}")
            } else {
                format!("optic in {at}: {}", what.join(", "))
            });
        }
        out
    }

    /// Follow the cable from `from_port` through any patch panels to the port
    /// where it meets a device that is not a panel. The steps are cable hops. At a
    /// splitter (a port that passes through to several), the branch that reaches a
    /// device holding `next` is the one followed: downstream, a PON splitter sends the
    /// light down every branch, and only the ONT it is for takes it.
    fn cable_chain(
        &self,
        from_port: NodeId,
        next: Option<IpAddr>,
    ) -> Result<(Vec<Hop>, NodeId), String> {
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
            let mut detail = vec![format!(
                "{} {} to {} {}",
                self.dev_name(here),
                display_name(self.g, here),
                self.dev_name(far),
                display_name(self.g, far)
            )];
            detail.extend(self.parts_at(here));
            detail.extend(self.parts_at(far));
            hops.push(Hop {
                kind: "cable",
                title: "cable".to_owned(),
                detail,
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
                many => {
                    let Some(next) = next else {
                        return Err(format!(
                            "{} passes through to more than one port; could not establish which the cable takes",
                            display_name(self.g, far)
                        ));
                    };
                    return self.split(far, many, next).map(|(mut rest, end)| {
                        hops.append(&mut rest);
                        (hops, end)
                    });
                }
            }
        }
        Err("the cable path is longer than this trace walks".to_owned())
    }

    /// Choose the branch of a splitter at `at` that reaches a device holding `next`; when
    /// no branch does, the only branch with a device on it at all.
    fn split(
        &self,
        at: NodeId,
        branches: &[NodeId],
        next: IpAddr,
    ) -> Result<(Vec<Hop>, NodeId), String> {
        // A splitter is a passive node, not a device: name it by whatever owns the port.
        let owner = self
            .g
            .owner(at)
            .map_or(String::new(), |o| display_name(self.g, o));
        let name = format!("{owner} {}", display_name(self.g, at))
            .trim()
            .to_owned();
        let mut reached: Vec<(NodeId, Vec<Hop>, NodeId)> = Vec::new();
        for b in branches {
            self.steps.set(self.steps.get() + 1);
            if self.steps.get() > SEARCH_BUDGET {
                return Err(format!(
                    "{name} splits into more branches than this trace searches; could not establish which one the flow takes"
                ));
            }
            if let Ok((h, end)) = self.cable_chain(*b, Some(next)) {
                reached.push((*b, h, end));
            }
        }
        let holding: Vec<usize> = (0..reached.len())
            .filter(|i| {
                self.g
                    .device_of(reached[*i].2)
                    .is_some_and(|d| self.owns(d, next))
            })
            .collect();
        let pick = match (holding.as_slice(), reached.len()) {
            ([i], _) => *i,
            ([], 1) => 0,
            ([], 0) => {
                return Err(format!(
                    "{name} splits to {} ports and no cable is recorded on any of them",
                    branches.len()
                ))
            }
            ([], _) => {
                return Err(format!(
                    "{name} splits to {} ports and no device on them holds {next}; could not establish which branch the flow takes",
                    branches.len()
                ))
            }
            _ => {
                return Err(format!(
                    "more than one branch of {name} reaches a device holding {next}; could not establish which one the flow takes"
                ))
            }
        };
        let (branch, mut rest, end) = reached.swap_remove(pick);
        let mut hops = vec![Hop {
            kind: "cable",
            title: "splitter".to_owned(),
            detail: vec![format!(
                "{name} splits to {} ports; the flow is for the branch on {}",
                branches.len(),
                display_name(self.g, branch)
            )],
            nodes: vec![at.to_string(), branch.to_string()],
            why: "A splitter sends the signal down every branch; the device it is addressed to is on this one.".to_owned(),
            ..Hop::default()
        }];
        hops.append(&mut rest);
        Ok((hops, end))
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

    /// The switch search: cross the cable from `from_port` and say what is at the other end,
    /// a device holding `next` (done) or switches on the way to one. `path` holds the devices
    /// already crossed: a frame never comes back to one it left, so a way back is not a way on.
    fn search(
        &self,
        from_port: NodeId,
        next: IpAddr,
        hint: Option<u16>,
        path: &[NodeId],
    ) -> Result<(Vec<Hop>, NodeId), Miss> {
        self.steps.set(self.steps.get() + 1);
        if self.steps.get() > SEARCH_BUDGET {
            return Err(Miss::plain("the switches here form more paths than this trace searches; could not establish the path through them"));
        }
        let (mut hops, far) = self
            .cable_chain(from_port, Some(next))
            .map_err(Miss::plain)?;
        let dev = self
            .g
            .device_of(far)
            .ok_or_else(|| Miss::plain("the far port is on no device"))?;
        if path.contains(&dev) {
            return Err(Miss {
                text: String::new(),
                kind: MissKind::Back,
            });
        }
        let dev_name = display_name(self.g, dev);
        if self.owns(dev, next) {
            return Ok((hops, far));
        }
        if self
            .units_on(far)
            .iter()
            .any(|u| !self.unit_addrs(*u).is_empty())
        {
            return Err(Miss::plain(format!(
                "the cable reaches {dev_name}, which does not hold {next}; could not establish where the flow goes from there"
            )));
        }
        // A port with no address of its own: a switch. Which VLAN?
        // `path` holds the device the flow left plus the switches crossed so far.
        if path.len() > L2_DEPTH {
            return Err(Miss::plain(
                "the path passes through more switches than this trace follows",
            ));
        }
        let on = self.vlans_on(far);
        let vlan = match (on.as_slice(), hint) {
            ([], _) => {
                return Err(Miss::plain(format!(
                    "could not establish the VLAN on {} of {dev_name}",
                    display_name(self.g, far)
                )))
            }
            ([v], None) => *v,
            ([v], Some(h)) if *v == h => *v,
            (vs, Some(h)) if vs.contains(&h) => h,
            (vs, Some(h)) => {
                return Err(Miss::plain(format!(
                    "VLAN {h} is not among the VLANs read on {} of {dev_name} ({})",
                    display_name(self.g, far),
                    list(vs)
                )))
            }
            (vs, None) => {
                return Err(Miss::plain(format!(
                "{} of {dev_name} carries VLANs {}; could not establish which one the flow uses",
                display_name(self.g, far),
                list(vs)
            )))
            }
        };

        // The other ports in the VLAN; the other links of the LAG the frame came in on lead back.
        let came_in = self.lag_of(far);
        let candidates: Vec<NodeId> = self
            .device_ports(dev)
            .into_iter()
            .filter(|p| *p != far && (came_in.is_none() || self.lag_of(*p) != came_in))
            .filter(|p| self.vlans_on(*p).contains(&vlan))
            .collect();
        let mk = |out: NodeId, note: Option<&str>| {
            let mut detail = vec![format!(
                "VLAN {vlan}: in on {}, out on {}",
                display_name(self.g, far),
                display_name(self.g, out)
            )];
            detail.extend(note.map(str::to_owned));
            Some(Hop {
                kind: "switch",
                title: dev_name.clone(),
                detail,
                nodes: vec![dev.to_string(), far.to_string(), out.to_string()],
                why: "A switch carries a frame to the other ports in its VLAN.".to_owned(),
                ..Hop::default()
            })
        };
        let (mut rest, hp) = self.fan(dev, Some(vlan), &candidates, next, Some(vlan), path, &mk)?;
        hops.append(&mut rest);
        Ok((hops, hp))
    }

    /// Try every way out of `dev` among `candidates` and keep the one that reaches `next`.
    /// The links of one LAG that all reach the same device are one way, not several. `mk`
    /// makes the hop on `dev` for the port a way leaves by (with a note for a bundle).
    #[allow(clippy::too_many_arguments)]
    fn fan(
        &self,
        dev: NodeId,
        vlan: Option<u16>,
        candidates: &[NodeId],
        next: IpAddr,
        hint: Option<u16>,
        path: &[NodeId],
        mk: &dyn Fn(NodeId, Option<&str>) -> Option<Hop>,
    ) -> Result<(Vec<Hop>, NodeId), Miss> {
        let dev_name = display_name(self.g, dev);
        let mut on_path = path.to_vec();
        if !on_path.contains(&dev) {
            on_path.push(dev);
        }
        // Group the candidates: one LAG whose links all reach one device is one way.
        let mut ways: Vec<(Vec<NodeId>, Option<String>)> = Vec::new();
        let mut seen: Vec<NodeId> = Vec::new();
        for c in candidates {
            match self.lag_of(*c) {
                Some(agg) if !seen.contains(&agg) => {
                    seen.push(agg);
                    let links: Vec<NodeId> = candidates
                        .iter()
                        .copied()
                        .filter(|p| self.lag_of(*p) == Some(agg))
                        .collect();
                    let fars: Vec<Option<NodeId>> = links
                        .iter()
                        .map(|p| {
                            self.cable_chain(*p, None)
                                .ok()
                                .and_then(|(_, f)| self.g.device_of(f))
                        })
                        .collect();
                    let one_far = fars[0].is_some() && fars.iter().all(|f| *f == fars[0]);
                    if links.len() > 1 && one_far {
                        let far_name = fars[0].map_or(String::new(), |d| display_name(self.g, d));
                        let note = format!(
                            "{} bundles {} links to {far_name} ({}); which link a given flow hashes onto is not read",
                            display_name(self.g, agg),
                            links.len(),
                            links
                                .iter()
                                .map(|p| display_name(self.g, *p))
                                .collect::<Vec<_>>()
                                .join(", ")
                        );
                        ways.push((links, Some(note)));
                    } else {
                        // Links to different devices (MLAG, or a mistake) are separate ways.
                        ways.extend(links.into_iter().map(|p| (vec![p], None)));
                    }
                }
                Some(_) => {}
                None => ways.push((vec![*c], None)),
            }
        }

        let mut paths: Vec<(Vec<Hop>, NodeId)> = Vec::new();
        let mut errs: Vec<Miss> = Vec::new();
        for (links, note) in &ways {
            // A bundle is followed by its first link that arrives; the others are the same way.
            let mut got = None;
            let mut first_err = None;
            for out in links {
                match self.search(*out, next, hint, &on_path) {
                    Ok(r) => {
                        got = Some((*out, r));
                        break;
                    }
                    Err(e) => {
                        first_err.get_or_insert(e);
                    }
                }
            }
            match got {
                Some((out, (mut rest, hp))) => {
                    let mut all: Vec<Hop> = mk(out, note.as_deref()).into_iter().collect();
                    if all.is_empty() {
                        if let (Some(n), Some(first)) = (note, rest.first_mut()) {
                            first.detail.push(n.clone());
                        }
                    }
                    all.append(&mut rest);
                    paths.push((all, hp));
                }
                None => errs.extend(first_err),
            }
        }
        if self.steps.get() > SEARCH_BUDGET {
            return Err(Miss::plain("the switches here form more paths than this trace searches; could not establish the path through them"));
        }
        let within = vlan.map_or(String::new(), |v| format!(" in VLAN {v}"));
        // A further switch with more than one way on is more than one way on from here too.
        let deeper = errs.iter().find(|e| e.kind == MissKind::Ambiguous);
        if paths.len() > 1 || (!paths.is_empty() && deeper.is_some()) {
            return Err(Miss {
                text: format!(
                    "more than one path from {dev_name}{within} leads to {next}; could not establish which one the flow takes (redundant links are not ranked: spanning tree is not read)"
                ),
                kind: MissKind::Ambiguous,
            });
        }
        if let Some(d) = deeper {
            return Err(d.clone());
        }
        if paths.len() == 1 {
            return Ok(paths.remove(0));
        }
        // No way on. When exactly one way was tried to its end, its reason is the one to give.
        let ends: Vec<&Miss> = errs.iter().filter(|e| e.kind == MissKind::Plain).collect();
        match ends.as_slice() {
            [one] => Err((*one).clone()),
            _ => Err(Miss::plain(format!(
                "no port of {dev_name}{within} leads to a device holding {next}"
            ))),
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

        let mut here = 0;
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
                Place::Here => {
                    here += 1;
                    hop.policies.extend(lines);
                }
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
        if here > 1 {
            hop.detail.push(
                "More than one policy set applies; the order between sets is not read, so rows from different sets are not ranked against each other".to_owned(),
            );
        }
        if hop.policies.is_empty() && hop.unplaced.is_empty() && zin.is_some() && zout.is_some() {
            hop.detail.push(
                "No policy set between these zones is in the design; could not establish what the device does with this flow".to_owned(),
            );
        }
        hop.detail.push("NAT is not read".to_owned());
        hop.detail
            .push("Policies are listed as stored; qualifiers the config uses but Fathom does not read are not shown".to_owned());
    }

    /// A policy's object by the name the config gave it; `display_name` has no case for these kinds.
    fn label(&self, n: NodeId) -> String {
        let name = self.g.node(n).and_then(|node| match n.kind {
            NodeKind::AddressObject => address_object::name(node).ok().map(|i| i.0.clone()),
            NodeKind::AddressSet => address_set::name(node).ok().map(|i| i.0.clone()),
            NodeKind::Application => application::name(node).ok().map(|i| i.0.clone()),
            _ => None,
        });
        name.unwrap_or_else(|| display_name(self.g, n))
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
            let (st, mut why) = combine(&parts);
            if st == "matches" && self.source_of(p, "SecurityPolicy.name") == PASTED {
                why.push_str(
                    " (as read from the config; a deactivated policy or a qualifier Fathom does not read is not shown)",
                );
            }
            (st, why)
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
            let name = self.label(o);
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
        // A set read from a config may hold sets inside it, which the paste does not bind.
        if cant.is_none() {
            let parsed_set = children(self.g, p, edge).into_iter().find(|t| {
                t.kind == NodeKind::AddressSet && self.source_of(*t, "AddressSet.name") == PASTED
            });
            if let Some(set) = parsed_set {
                cant = Some(format!(
                    "{} was read from a config, and sets inside sets are not read",
                    self.label(set)
                ));
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
            let name = self.label(a);
            match self.g.node(a).and_then(|n| application::l4(n).ok()) {
                Some(L4Spec::Any) => {
                    return (State::Matches, format!("{name} covers any protocol"))
                }
                Some(L4Spec::Protocol {
                    protocol,
                    source_ports,
                    destination_ports,
                }) => {
                    if protocol.0 == flow.protocol && !source_ports.is_empty() {
                        cant.get_or_insert(format!(
                            "{name} also names source ports, and the flow's source port was not given"
                        ));
                        continue;
                    }
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
            Some(Origin::Parsed { .. }) => PASTED.to_owned(),
            Some(Origin::Hand) => "entered by hand".to_owned(),
            None => String::new(),
        }
    }
}

const PASTED: &str = "read from a pasted config";

/// Why one branch of the switch search did not arrive.
#[derive(Clone)]
struct Miss {
    text: String,
    kind: MissKind,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum MissKind {
    /// The design does not say; the text says what.
    Plain,
    /// More than one way on.
    Ambiguous,
    /// The branch came back to a switch already crossed: not a way on, and not a reason.
    Back,
}

impl Miss {
    fn plain(text: impl Into<String>) -> Miss {
        Miss {
            text: text.into(),
            kind: MissKind::Plain,
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

fn parents(g: &Graph, n: NodeId, k: EdgeKind) -> Vec<NodeId> {
    let mut v: Vec<NodeId> = g
        .inn(n, k)
        .filter(|e| e.absent_since.is_none())
        .map(|e| e.from)
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
