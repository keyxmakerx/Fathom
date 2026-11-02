//! NAT in a trace (schema 0.38, sign-off r104: static, destination and source NAT on a
//! firewall, each a line on the firewall's hop).
//!
//! The order is Juniper's, from the NAT overview read 2026-11-02: for a flow's first packet,
//! static NAT, destination NAT, route lookup, security policy lookup, reverse static NAT, then
//! source NAT; static rules take precedence over destination rules. So [`Walk::nat_in`] runs
//! before the route lookup (the route and the policies see the translated destination) and
//! [`Walk::nat_out`] after the policies.
//!
//! Which rule applies, as far as a source says it: Juniper's destination and static NAT topics
//! (read 2026-11-02) say that when rule sets overlap "the most specific rule is chosen", an
//! interface being more specific than a zone. Nothing read says how rules of equal standing are
//! ranked, so when two such rules both match and translate differently the trace stops with
//! "could not establish" rather than pick one. A rule whose match the design cannot settle (no
//! zone read for the interface, no source address, no port given) stops the trace the same way,
//! unless a more specific rule that does match outranks it.

use std::net::IpAddr;

use fathom_graph::{ElementId, NodeId};
use fathom_ir::generated::accessors::{nat_pool, nat_rule, nat_rule_set};
use fathom_ir::generated::ir_types::{EdgeKind, NatPoolNatType, NatRuleSetNatType, NodeKind};
use fathom_ir::scalar::IpPrefix;
use fathom_ir::value::{NatAction, NatScope};

use super::{children, live, mask, prefix_has, Flow, Walk};
use crate::element::display_name;

/// Whether a scope or a match holds for this flow.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Tri {
    Yes,
    No,
    /// The design does not say.
    Unknown,
}

fn and(a: Tri, b: Tri) -> Tri {
    match (a, b) {
        (Tri::No, _) | (_, Tri::No) => Tri::No,
        (Tri::Unknown, _) | (_, Tri::Unknown) => Tri::Unknown,
        _ => Tri::Yes,
    }
}

/// One rule that could apply to this flow.
struct Candidate {
    set_name: String,
    rule_name: String,
    tri: Tri,
    /// 2 for a rule set scoped to an interface, 1 for a zone (Juniper: the interface is more specific).
    rank: u8,
    /// What it does to the address, or why that could not be read.
    out: Result<Translation, String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum Translation {
    /// `off`: the rule says not to translate.
    Off,
    To {
        addr: IpAddr,
        port: Option<u16>,
    },
    /// A pool of more than one address, or an interface holding several: which one is not read.
    OneOf(String),
}

/// What NAT did on one hop: the new address and a line for the hop.
pub(super) struct Applied {
    pub addr: Option<IpAddr>,
    pub line: String,
}

impl Walk<'_> {
    /// The device's NAT rules, for a hop that says none are in the design.
    pub(super) fn nat_rule_count(&self, dev: NodeId) -> usize {
        children(self.g, dev, EdgeKind::HasNatRuleSet)
            .into_iter()
            .map(|s| children(self.g, s, EdgeKind::HasNatRule).len())
            .sum()
    }

    /// Static, then destination NAT, on a flow arriving on `ingress`. `Ok(None)` when no rule
    /// applies (or the device has none); an `Err` stops the trace.
    pub(super) fn nat_in(
        &mut self,
        dev: NodeId,
        ingress: Option<NodeId>,
        src: Option<IpAddr>,
        dest: IpAddr,
    ) -> Result<Option<Applied>, String> {
        if self.nat_rule_count(dev) == 0 {
            return Ok(None);
        }
        // Static NAT first; when one applies, destination NAT is not looked at.
        for (kind, what) in [
            (NatRuleSetNatType::Static, "static NAT"),
            (NatRuleSetNatType::Destination, "destination NAT"),
        ] {
            let cs = self.candidates(dev, kind, ingress, None, src, dest);
            if let Some((c, t)) = self.decide(what, &cs)? {
                // A flow reaches one address; a pool of several does not say which.
                let several = matches!(t, Translation::OneOf(_));
                let a = self.applied_dest(what, &c, t, dest);
                if several {
                    return Err(a.line);
                }
                return Ok(Some(a));
            }
        }
        Ok(None)
    }

    /// Reverse static, then source NAT, on a flow leaving by `egress`. The returned address is the
    /// new source (`None` when it becomes one of several).
    pub(super) fn nat_out(
        &self,
        dev: NodeId,
        ingress: Option<NodeId>,
        egress: NodeId,
        src: Option<IpAddr>,
        dest: IpAddr,
    ) -> Result<Option<Applied>, String> {
        if self.nat_rule_count(dev) == 0 {
            return Ok(None);
        }
        let reverse = match src {
            Some(s) => self.reverse_static(dev, egress, s)?,
            None => None,
        };
        let sources = self.candidates(
            dev,
            NatRuleSetNatType::Source,
            ingress,
            Some(egress),
            src,
            dest,
        );
        let source = self.decide("source NAT", &sources)?;
        match (reverse, source) {
            (Some(r), Some((c, t))) if t != Translation::Off => Err(format!(
                "both a static NAT rule ({}) and source NAT rule {} in rule set {} match this flow's source; which one {} applies is not read",
                r.line,
                c.rule_name,
                c.set_name,
                display_name(self.g, dev)
            )),
            (Some(r), _) => Ok(Some(r)),
            (None, Some((c, t))) => Ok(Some(self.applied_src(&c, t, src))),
            (None, None) => Ok(None),
        }
    }

    // ---- which rules ------------------------------------------------------

    fn candidates(
        &self,
        dev: NodeId,
        kind: NatRuleSetNatType,
        ingress: Option<NodeId>,
        egress: Option<NodeId>,
        src: Option<IpAddr>,
        dest: IpAddr,
    ) -> Vec<Candidate> {
        let mut out = Vec::new();
        for set in children(self.g, dev, EdgeKind::HasNatRuleSet) {
            let Some(node) = self.g.node(set) else {
                continue;
            };
            if nat_rule_set::nat_type(node).ok() != Some(&kind) {
                continue;
            }
            let set_name = nat_rule_set::name(node)
                .map(|n| n.0.clone())
                .unwrap_or_default();
            let from = nat_rule_set::from(node).ok();
            let (mut scope, rank) = self.scope_tri(from, ingress);
            if kind == NatRuleSetNatType::Source {
                let to = nat_rule_set::to(node).ok();
                scope = and(scope, self.scope_tri(to, egress).0);
            }
            if scope == Tri::No {
                continue;
            }
            let mut rules: Vec<(u32, NodeId)> = children(self.g, set, EdgeKind::HasNatRule)
                .into_iter()
                .map(|r| {
                    let o = self
                        .g
                        .node(r)
                        .and_then(|n| nat_rule::ordinal(n).ok().copied())
                        .unwrap_or(u32::MAX);
                    (o, r)
                })
                .collect();
            rules.sort();
            for (_, r) in rules {
                let Some(rn) = self.g.node(r) else { continue };
                let tri = and(scope, self.rule_tri(r, src, dest));
                if tri == Tri::No {
                    continue;
                }
                out.push(Candidate {
                    set_name: set_name.clone(),
                    rule_name: nat_rule::name(rn).map(|n| n.0.clone()).unwrap_or_default(),
                    tri,
                    rank,
                    out: self.translation(dev, r, kind.clone(), dest, egress),
                });
            }
        }
        out
    }

    /// Whether a rule set's `from` (or `to`) holds for the unit the flow is on, and how specific
    /// the scope is.
    fn scope_tri(&self, scope: Option<&NatScope>, unit: Option<NodeId>) -> (Tri, u8) {
        match scope {
            None => (Tri::Unknown, 0),
            Some(NatScope::Interface(r)) => {
                let tri = match (self.g.resolve_ref(*r), unit) {
                    (Some(ElementId::Node(n)), Some(u)) if live(self.g, n) => {
                        if n == u {
                            Tri::Yes
                        } else {
                            Tri::No
                        }
                    }
                    _ => Tri::Unknown,
                };
                (tri, 2)
            }
            Some(NatScope::Zone(r)) => {
                let tri = match (self.g.resolve_ref(*r), unit.and_then(|u| self.unit_zone(u))) {
                    (Some(ElementId::Node(z)), Some(uz)) if live(self.g, z) => {
                        if z == uz {
                            Tri::Yes
                        } else {
                            Tri::No
                        }
                    }
                    _ => Tri::Unknown,
                };
                (tri, 1)
            }
            // Named routing instances are not read, so this scope cannot be settled.
            Some(NatScope::RoutingInstance(_)) => (Tri::Unknown, 1),
        }
    }

    pub(super) fn unit_zone(&self, u: NodeId) -> Option<NodeId> {
        self.g
            .inn(u, EdgeKind::ZoneMember)
            .filter(|e| e.absent_since.is_none())
            .map(|e| e.from)
            .find(|z| live(self.g, *z) && z.kind == NodeKind::Zone)
    }

    fn rule_tri(&self, rule: NodeId, src: Option<IpAddr>, dest: IpAddr) -> Tri {
        let Some(n) = self.g.node(rule) else {
            return Tri::No;
        };
        let within = |ps: &[IpPrefix], ip: IpAddr| ps.iter().any(|p| prefix_has(p.addr, p.len, ip));
        let mut tri = Tri::Yes;
        if let Ok(ds) = nat_rule::match_destination(n) {
            if !ds.is_empty() && !within(ds, dest) {
                return Tri::No;
            }
        }
        if let Ok(ss) = nat_rule::match_source(n) {
            if !ss.is_empty() {
                tri = match src {
                    Some(s) if within(ss, s) => tri,
                    Some(_) => return Tri::No,
                    None => Tri::Unknown,
                };
            }
        }
        if let Ok(ports) = nat_rule::match_destination_port(n) {
            if !ports.is_empty() {
                tri = match self.flow {
                    Some(Flow { port, .. }) if ports.iter().any(|p| p.0 == port) => tri,
                    Some(_) => return Tri::No,
                    None => Tri::Unknown,
                };
            }
        }
        tri
    }

    /// The candidates that stand once a more specific scope outranks a less specific one, then one
    /// translation, or a stop when the design does not settle which.
    fn decide(
        &self,
        what: &str,
        cs: &[Candidate],
    ) -> Result<Option<(CandidateRef, Translation)>, String> {
        let top_yes = cs
            .iter()
            .filter(|c| c.tri == Tri::Yes)
            .map(|c| c.rank)
            .max();
        let standing: Vec<&Candidate> = cs
            .iter()
            .filter(|c| top_yes.is_none_or(|r| c.rank >= r))
            .collect();
        if standing.is_empty() {
            return Ok(None);
        }
        if let Some(c) = standing.iter().find(|c| c.tri == Tri::Unknown) {
            return Err(format!(
                "{what} rule {} in rule set {} may apply to this flow, but the design does not say whether it matches (the zone of the interface, the source address or the port is not known)",
                c.rule_name, c.set_name
            ));
        }
        let first = standing[0];
        let t = first.out.clone()?;
        if let Some(other) = standing[1..]
            .iter()
            .find(|c| c.out.as_ref().ok() != Some(&t))
        {
            return Err(format!(
                "{what} rules {} (rule set {}) and {} (rule set {}) both match this flow and translate it differently; which one applies is not read",
                first.rule_name, first.set_name, other.rule_name, other.set_name
            ));
        }
        Ok(Some((
            CandidateRef {
                set_name: first.set_name.clone(),
                rule_name: first.rule_name.clone(),
            },
            t,
        )))
    }

    /// What one rule does to the address it translates.
    fn translation(
        &self,
        dev: NodeId,
        rule: NodeId,
        kind: NatRuleSetNatType,
        dest: IpAddr,
        egress: Option<NodeId>,
    ) -> Result<Translation, String> {
        let n = self.g.node(rule).ok_or("the rule is not in the design")?;
        let name = nat_rule::name(n).map(|i| i.0.clone()).unwrap_or_default();
        match nat_rule::then(n) {
            Err(_) => Err(format!("what NAT rule {name} does is not in the design")),
            Ok(NatAction::Off) => Ok(Translation::Off),
            Ok(NatAction::Static(to)) => {
                let from = nat_rule::match_destination(n)
                    .ok()
                    .and_then(|ds| ds.iter().find(|p| prefix_has(p.addr, p.len, dest)).copied())
                    .ok_or_else(|| {
                        format!("static NAT rule {name} matches no destination prefix")
                    })?;
                shift(from, *to, dest)
                    .map(|addr| Translation::To { addr, port: None })
                    .ok_or_else(|| {
                        format!(
                            "static NAT rule {name} maps {} to {}, which are not the same size",
                            show(&from),
                            show(to)
                        )
                    })
            }
            Ok(NatAction::Pool(pool)) => {
                let want = match kind {
                    NatRuleSetNatType::Source => NatPoolNatType::Source,
                    _ => NatPoolNatType::Destination,
                };
                let p = children(self.g, dev, EdgeKind::HasNatPool)
                    .into_iter()
                    .filter_map(|p| self.g.node(p))
                    .find(|p| {
                        nat_pool::name(*p).ok() == Some(pool)
                            && nat_pool::nat_type(*p).ok() == Some(&want)
                    })
                    .ok_or_else(|| format!("NAT pool {} is not in the design", pool.0))?;
                let port = nat_pool::port(p).ok().map(|p| p.0);
                let addr = nat_pool::address(p)
                    .map_err(|_| format!("NAT pool {}'s address is not in the design", pool.0))?;
                let to = nat_pool::address_to(p).ok();
                let single = (addr.len == 32 && addr.addr.is_ipv4()) || addr.len == 128;
                match to {
                    None if single => Ok(Translation::To {
                        addr: addr.addr,
                        port,
                    }),
                    Some(t) if t.addr == addr.addr => Ok(Translation::To {
                        addr: addr.addr,
                        port,
                    }),
                    Some(t) => Ok(Translation::OneOf(format!(
                        "one of {} to {} (pool {})",
                        addr.addr, t.addr, pool.0
                    ))),
                    None => Ok(Translation::OneOf(format!(
                        "an address in {} (pool {})",
                        show(addr),
                        pool.0
                    ))),
                }
            }
            Ok(NatAction::Interface) => {
                let Some(u) = egress else {
                    return Err(format!(
                        "NAT rule {name} translates to an interface, which only source NAT does"
                    ));
                };
                let same: Vec<IpAddr> = self
                    .unit_addrs(u)
                    .into_iter()
                    .filter(|a| a.is_ipv4() == dest.is_ipv4())
                    .collect();
                match same.as_slice() {
                    [a] => Ok(Translation::To {
                        addr: *a,
                        port: None,
                    }),
                    [] => Err(format!(
                        "source NAT rule {name} uses {}'s address, and it has none in the design",
                        display_name(self.g, u)
                    )),
                    _ => Ok(Translation::OneOf(format!(
                        "an address of {} (it holds more than one)",
                        display_name(self.g, u)
                    ))),
                }
            }
        }
    }

    /// The reverse of a static rule: a flow whose source is inside the rule's translated prefix,
    /// leaving toward the rule set's `from`, takes the matching address on the other side.
    fn reverse_static(
        &self,
        dev: NodeId,
        egress: NodeId,
        src: IpAddr,
    ) -> Result<Option<Applied>, String> {
        let mut found: Vec<(Tri, Applied)> = Vec::new();
        for set in children(self.g, dev, EdgeKind::HasNatRuleSet) {
            let Some(node) = self.g.node(set) else {
                continue;
            };
            if nat_rule_set::nat_type(node).ok() != Some(&NatRuleSetNatType::Static) {
                continue;
            }
            let set_name = nat_rule_set::name(node)
                .map(|n| n.0.clone())
                .unwrap_or_default();
            let (scope, _) = self.scope_tri(nat_rule_set::from(node).ok(), Some(egress));
            if scope == Tri::No {
                continue;
            }
            for r in children(self.g, set, EdgeKind::HasNatRule) {
                let Some(rn) = self.g.node(r) else { continue };
                let Ok(NatAction::Static(inside)) = nat_rule::then(rn) else {
                    continue;
                };
                if !prefix_has(inside.addr, inside.len, src) {
                    continue;
                }
                let rule_name = nat_rule::name(rn).map(|n| n.0.clone()).unwrap_or_default();
                let outside = match nat_rule::match_destination(rn).ok().map(Vec::as_slice) {
                    Some([one]) => *one,
                    _ => {
                        return Err(format!(
                            "static NAT rule {rule_name} in rule set {set_name} covers this flow's source, but its outside address is not one prefix"
                        ))
                    }
                };
                let addr = shift(*inside, outside, src).ok_or_else(|| {
                    format!("static NAT rule {rule_name} maps prefixes that are not the same size")
                })?;
                found.push((
                    scope,
                    Applied {
                        addr: Some(addr),
                        line: format!(
                            "static NAT, return direction: source {src} becomes {addr} (rule set {set_name}, rule {rule_name})"
                        ),
                    },
                ));
            }
        }
        match found.len() {
            0 => Ok(None),
            1 => {
                let (tri, a) = found.remove(0);
                if tri == Tri::Unknown {
                    return Err(format!(
                        "a static NAT rule covers this flow's source, but whether the flow leaves toward the rule set's zone or interface is not known ({})",
                        a.line
                    ));
                }
                Ok(Some(a))
            }
            _ => Err("more than one static NAT rule covers this flow's source; which one applies is not read".to_owned()),
        }
    }

    // ---- lines ------------------------------------------------------------

    fn applied_dest(
        &mut self,
        what: &str,
        c: &CandidateRef,
        t: Translation,
        dest: IpAddr,
    ) -> Applied {
        let at = format!("(rule set {}, rule {})", c.set_name, c.rule_name);
        match t {
            Translation::Off => Applied {
                addr: None,
                line: format!("{what}: off, {dest} is not translated {at}"),
            },
            Translation::To { addr, port } => {
                let port_words = match (port, self.flow.as_mut()) {
                    (Some(p), Some(f)) if f.port != p => {
                        let was = f.port;
                        f.port = p;
                        format!(", port {was} becomes {p}")
                    }
                    (Some(p), None) => format!(", to port {p}"),
                    _ => String::new(),
                };
                Applied {
                    addr: Some(addr),
                    line: format!("{what}: {dest} becomes {addr}{port_words} {at}"),
                }
            }
            // Never for a destination: a flow has to reach one address. `decide` keeps it here so
            // the stop is said once.
            Translation::OneOf(words) => Applied {
                addr: None,
                line: format!("{what}: {dest} becomes {words}, and which one is not read {at}"),
            },
        }
    }

    fn applied_src(&self, c: &CandidateRef, t: Translation, src: Option<IpAddr>) -> Applied {
        let at = format!("(rule set {}, rule {})", c.set_name, c.rule_name);
        let was = src.map_or_else(|| "the source".to_owned(), |s| format!("source {s}"));
        match t {
            Translation::Off => Applied {
                addr: src,
                line: format!("source NAT: off, {was} is not translated {at}"),
            },
            Translation::To { addr, .. } => Applied {
                addr: Some(addr),
                line: format!("source NAT: {was} becomes {addr} {at}"),
            },
            Translation::OneOf(words) => Applied {
                addr: None,
                line: format!("source NAT: {was} becomes {words}; which one is not read {at}"),
            },
        }
    }
}

/// Which rule applied, by its names.
pub(super) struct CandidateRef {
    set_name: String,
    rule_name: String,
}

/// `ip`, inside `from`, moved to the same place inside `to`. Both prefixes must be one family
/// and one length.
fn shift(from: IpPrefix, to: IpPrefix, ip: IpAddr) -> Option<IpAddr> {
    if from.len != to.len || from.addr.is_ipv4() != to.addr.is_ipv4() {
        return None;
    }
    let base_from = mask(from.addr, from.len);
    let base_to = mask(to.addr, to.len);
    match (base_from, base_to, ip) {
        (IpAddr::V4(f), IpAddr::V4(t), IpAddr::V4(i)) => {
            let off = u32::from(i).wrapping_sub(u32::from(f));
            Some(IpAddr::V4(u32::from(t).wrapping_add(off).into()))
        }
        (IpAddr::V6(f), IpAddr::V6(t), IpAddr::V6(i)) => {
            let off = u128::from(i).wrapping_sub(u128::from(f));
            Some(IpAddr::V6(u128::from(t).wrapping_add(off).into()))
        }
        _ => None,
    }
}

fn show(p: &IpPrefix) -> String {
    format!("{}/{}", p.addr, p.len)
}
