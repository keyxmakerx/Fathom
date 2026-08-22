//! Inside the box — the zoom ladder's fourth rung (`57` §7, §14.1 item A2).
//!
//! # The gap this fills, and the one it does not
//!
//! `57` §7 is titled *"THE GAP: nobody designed the inside of a box"* and its
//! finding is that rung 3 is a **faceplate** — `Chassis → PhysicalPort`, the
//! outside. The path *through* the box appeared in all five trace designs only
//! as a list in a side panel. This module is that path as data.
//!
//! It is a projection and nothing more: every join, walk and count happens
//! here and the page renders strings (ADR-0019, and this crate's own module
//! doc). No clock, no entropy, no hash-ordered iteration — the same estate
//! projects the same bands every time (invariant 9).
//!
//! # What the graph can answer exactly, and what it cannot
//!
//! `57` §6.3 is the sentence this rung exists to serve, and it is worth
//! restating because getting it wrong is the one way to make this view a
//! liability:
//!
//! > **Never say permitted or denied.** There is no rules engine — zero lines.
//! > From the interface traffic entered by and the one it leaves by, the graph
//! > names the two `Zone`s, the `PolicySet` between them, and that set's
//! > policies **in the order the device reads them**.
//!
//! Three clauses. Measured against `schema/` and the shipped dictionaries on
//! 2026-08-21, **two of the three are answerable today and the middle one is
//! not**:
//!
//! | clause | state |
//! |---|---|
//! | which zone an interface is in | **exact.** `ZoneMember` (`Zone → LogicalUnit`) is declared, reverse-indexed, and `corpus/dict/junos-srx/security-zones.yaml` writes it from `set security zones security-zone … interfaces …` |
//! | which policy set governs that pair | **not recordable.** `PolicySet.scope` is typed `PolicyScope`, and `fathom_ir::value::PolicyScope` is `pub struct PolicyScope;` — a unit struct, carrying no zone ids at all. `crates/fathom-ingest/tests/opnsense_csv.rs` asserts this in as many words: *"the PolicySet asserts nothing"* |
//! | that set's policies in order | **exact.** `SecurityPolicy.ordinal` is `card: "1"`, and `HasPolicy` hangs them off the set |
//!
//! So this module reports the two it can and **draws no edge for the one it
//! cannot**. [`SetBand::scope`] is empty whenever the stored value carries
//! nothing readable, and the page says so in words. Inventing a zone pair from
//! the policies' names, or from the order the sets arrived in, would produce
//! precisely the confident wrong answer `57` §6.3 was written to forbid.
//!
//! **This is a schema gap and it is filed as a report item, not patched here**
//! — ADR-0008: a field that is not in `schema/` does not exist, and needing one
//! is somebody's decision to take.
//!
//! # Why a paste fills less of this than `57` §7 assumed
//!
//! `57` §7 says the schema *"supports it richly"* and lists nine kinds. It
//! does. What it does not say is which of them anything **builds**, and the
//! answer, read off `corpus/dict/` on 2026-08-21, is uncomfortable:
//!
//! | band | built by a junos-srx paste | built by an opnsense rules paste |
//! |---|---|---|
//! | interfaces, units, addresses | yes | no |
//! | zones and their members | yes | no |
//! | policy sets and policies | **no — the dictionary has no `security policies` entry at all** | yes |
//! | routing instances, protocols, adjacencies | yes | no |
//! | ipsec vpns | yes | no |
//!
//! `NatRuleSet`, `NatRule`, `AddressObject`, `Application` and `StaticRoute`
//! are declared in `schema/` and **nothing builds any of them**, on any
//! platform, today. They are therefore not bands here: a band that is empty on
//! every estate in existence is furniture that teaches a reader to ignore the
//! column it is in.
//!
//! The consequence is stated rather than hidden: on a junos-srx estate the
//! policy band is empty and the view says the design holds no policy set for
//! this device — which is true, and is the honest form of `57` §6.3's
//! narrowing when there is nothing to narrow.

use fathom_graph::{Graph, NodeId};
use fathom_ir::generated::ir_types::{EdgeKind, NodeKind};

use crate::element::display_name;
use crate::render::{field_text, key, UNRENDERED};

/// One device, taken apart into the bands the page draws left to right.
///
/// Every `Vec` is sorted by something a person reads — a name, an ordinal —
/// and never by insertion order, because a picture that reshuffles when a
/// second paste lands is a picture nobody trusts. Ties break on the display
/// id, which is a ULID and therefore total: two interfaces with the same name
/// still sort the same way on every run (invariant 9).
pub struct Inside {
    /// The device's display id — what the page descended into.
    pub device: String,
    /// Its hostname, or `—` where nobody has said.
    pub name: String,
    /// Band 1: the ways in and out.
    pub ways: Vec<Way>,
    /// Band 2: the zones this device holds.
    pub zones: Vec<ZoneBand>,
    /// Band 3: the policy sets, each with its policies in the device's order.
    pub sets: Vec<SetBand>,
    /// Band 4: routing instances and what runs in them.
    pub routes: Vec<RouteBand>,
    /// Band 4, lower half: the tunnels, and the unit each is bound to.
    pub tunnels: Vec<TunnelBand>,
}

impl Inside {
    /// Units across every interface. The page prints it, so it is counted
    /// here — `55` §1.4's rule read the other way round: a number a reader is
    /// shown is a number this crate computed.
    pub fn unit_count(&self) -> usize {
        self.ways.iter().map(|w| w.units.len()).sum()
    }

    /// Policies across every set.
    pub fn policy_count(&self) -> usize {
        self.sets.iter().map(|s| s.policies.len()).sum()
    }

    /// Units this device holds that no zone claims.
    ///
    /// Not a defect and never rendered as one: a management unit, a loopback
    /// and every unit on a switch that has no security zones at all are all
    /// legitimately zoneless. It is reported because *"which of my interfaces
    /// is not in a zone"* is a real question an operator asks of a firewall,
    /// and because the alternative — a blank cell — reads as a rendering bug.
    pub fn unzoned(&self) -> usize {
        self.ways
            .iter()
            .flat_map(|w| w.units.iter())
            .filter(|u| u.zone.is_empty())
            .count()
    }
}

/// One interface, of any of the four `InterfaceLike` kinds.
pub struct Way {
    pub id: String,
    /// `ge-0/0/0`. `name` is `card: "1"` on all four kinds, so this is bound
    /// on anything a parser built; a hand-made one could still be `—`.
    pub name: String,
    /// `Interface` / `AggregateInterface` / `RethInterface` /
    /// `TunnelInterface` — the schema's word, not a friendly synonym, for the
    /// reason `.dokind` already gives on the Outline row.
    pub kind_word: &'static str,
    /// Its units, by index. **An interface with none is kept**: `set
    /// interfaces ge-0/0/1 description …` builds exactly that, and an
    /// interface that carries no traffic yet is a fact about the estate rather
    /// than a row to drop.
    pub units: Vec<Unit>,
}

/// One `LogicalUnit` — the thing traffic actually enters and leaves by, and
/// the only node in this whole projection that a `ZoneMember` can point at.
pub struct Unit {
    pub id: String,
    /// `ge-0/0/0.0`, rendered by `display_name`'s `LogicalUnit` arm and never
    /// stored joined (`schema/schema.yaml`, `LogicalUnit`).
    pub label: String,
    /// Every `Address` under this unit, in canonical form. Empty is normal:
    /// an `ethernet-switching` unit has no L3 address and never will.
    pub addresses: Vec<String>,
    /// The zone's display id, or empty. **Not `Option`, and not an em dash**:
    /// this crosses the wire as a string and the page decides how to say
    /// "none", which keeps one convention for absence instead of two.
    pub zone: String,
    /// The zone's name, for printing beside the unit so the reader does not
    /// have to hold the second band in their head.
    pub zone_name: String,
    /// The `IpsecVpn` bound to this unit by `BindsInterface`, by name, or
    /// empty. This is the fourth band pointing back at the first, and it is
    /// how `st0.0` stops being just another unit.
    pub tunnel: String,
}

/// One `Zone`, and how many units it claims.
pub struct ZoneBand {
    pub id: String,
    pub name: String,
    /// Live `ZoneMember` edges out of it. A count and not a list, because the
    /// units are already drawn in band 1 and each one names its zone there —
    /// the same fact twice, in the direction each band is read.
    pub members: usize,
}

/// One `PolicySet`.
pub struct SetBand {
    pub id: String,
    /// **What the graph can say about which zone pair this set governs, or
    /// empty.**
    ///
    /// Empty is the state on every estate this build can produce, and the
    /// module doc says why: `PolicyScope` is a unit struct. It is read rather
    /// than assumed so that the day the type grows a shape, this band starts
    /// telling the truth without anyone remembering to come back here.
    ///
    /// `UNRENDERED` is filtered out deliberately. `(no renderer)` is a defect
    /// marker aimed at a developer reading the inventory; printing it in a
    /// picture aimed at an operator would say "Fathom is broken" where the
    /// true sentence is "nothing recorded this".
    pub scope: String,
    /// Its policies, **in the order the device reads them** — `ordinal`
    /// ascending. This is the one clause of `57` §6.3 that is both exact and
    /// buildable, and it is the reason this band exists at all.
    pub policies: Vec<PolicyRow>,
}

/// One `SecurityPolicy`.
pub struct PolicyRow {
    pub id: String,
    /// As stored, decimal. Empty where unstated — and `schema/` makes it
    /// `card: "1"`, so an empty one is a gap the findings view will also be
    /// reporting, not something to paper over with a zero.
    pub ordinal: String,
    pub name: String,
    /// `permit` / `deny` / `reject`, the schema's own tokens.
    ///
    /// **Never coloured.** `51` reserves `--safe` / `--caution` / `--danger`
    /// for the risk enum — ReadOnly, ChangesConfig, Disruptive — and a green
    /// `permit` beside a red `deny` would spend three reserved colours on a
    /// different axis and, worse, read as Fathom's verdict on the rule. The
    /// word is the whole treatment, exactly as `by hand` is on a link.
    pub action: String,
    /// Empty when nobody has said, `1` for enabled, `0` for a rule the vendor
    /// file marked disabled. Three states, never collapsed to two: OPNsense
    /// issue #10595 is disabled rules going missing, and this build will not
    /// repeat it by defaulting.
    pub enabled: String,
    /// What a person wrote about this rule, or empty.
    ///
    /// Carried because of what the band looked like without it. OPNsense names
    /// every rule by its `@uuid`, so `SecurityPolicy.name` is
    /// `8f1d0d3e-1c6a-4a4e-9a2f-19f7b0c6d4a1` and a column of those is a
    /// column nobody can read — while `Default allow LAN to any` is sitting in
    /// the same row of the same export. The name stays the name (it is what
    /// identifies the rule on the device); the description is what it is FOR.
    pub description: String,
}

/// One `RoutingInstance` and the protocols under it.
pub struct RouteBand {
    pub id: String,
    /// `display_name`'s arm, which says *"routing instance (unnamed)"* for the
    /// default instance rather than showing a ULID.
    pub name: String,
    pub protocols: Vec<ProtoRow>,
}

/// One `RoutingProtocol`.
pub struct ProtoRow {
    pub id: String,
    /// `ospf` / `bgp` / … — the stored token, or empty.
    pub protocol: String,
    /// Live `HasAdjacency` children. A count: the adjacencies themselves are
    /// inventory rows and this band is about the shape of the box, not a
    /// second listing of them.
    pub adjacencies: usize,
}

/// One `IpsecVpn`.
pub struct TunnelBand {
    pub id: String,
    pub name: String,
    /// The unit `BindsInterface` points at, by label, or empty. `19` records
    /// that mode decides whether the edge is required or forbidden, so empty
    /// is a legitimate state and is not marked as missing here.
    pub unit: String,
}

/// Not tombstoned. `11` §10.5: a tombstoned node is not deleted, and
/// `Graph::is_effective` — which applies the same test to both endpoints of an
/// edge — is private, so every view repeats it (see `agg.rs`, `order.rs`,
/// `inventory.rs`). Repeated here rather than at each of the eight walks
/// below.
fn live(g: &Graph, n: NodeId) -> bool {
    g.node(n).is_some_and(|node| node.absent_since.is_none())
}

/// Live children of `n` over one containment or reference edge.
fn children(g: &Graph, n: NodeId, k: EdgeKind) -> Vec<NodeId> {
    g.out(n, k)
        .filter(|e| e.absent_since.is_none())
        .map(|e| e.to)
        .filter(|t| live(g, *t))
        .collect()
}

/// A bound field's text, or empty. `field_text` already returns `None` for
/// both the em dash and the empty string, which is the distinction this whole
/// projection depends on: `—` is an answer to a different question.
fn text(g: &Graph, n: NodeId, name: &'static str) -> String {
    field_text(g, n, key(name)).unwrap_or_default()
}

/// Everything inside one device.
///
/// `None` when the id is not a live `Device`. That is the empty state and not
/// an error — the same convention `elevation` and `equipment_page` use — and
/// the page prints it rather than showing a diagnostic.
pub fn inside(g: &Graph, id: NodeId) -> Option<Inside> {
    if id.kind != NodeKind::Device || !live(g, id) {
        return None;
    }

    // Which zone each unit is in, built ONCE by walking the zones outward
    // rather than per-unit by walking `inn` inward. Both are correct; this one
    // is a single pass over a small set and it also gives the member counts
    // band 2 needs, so the two facts cannot disagree about which edges are
    // live.
    let mut zones: Vec<ZoneBand> = Vec::new();
    let mut unit_zone: Vec<(NodeId, String, String)> = Vec::new();
    for z in children(g, id, EdgeKind::HasZone) {
        let zid = z.to_string();
        let name = display_name(g, z);
        let members = children(g, z, EdgeKind::ZoneMember);
        for m in &members {
            unit_zone.push((*m, zid.clone(), name.clone()));
        }
        zones.push(ZoneBand {
            id: zid,
            name,
            members: members.len(),
        });
    }
    zones.sort_by(|a, b| a.name.cmp(&b.name).then(a.id.cmp(&b.id)));

    // Which tunnel each unit carries, same shape and for the same reason.
    let mut tunnels: Vec<TunnelBand> = Vec::new();
    let mut unit_tunnel: Vec<(NodeId, String)> = Vec::new();
    for v in children(g, id, EdgeKind::HasIpsecVpn) {
        let name = display_name(g, v);
        let bound = children(g, v, EdgeKind::BindsInterface);
        for u in &bound {
            unit_tunnel.push((*u, name.clone()));
        }
        tunnels.push(TunnelBand {
            id: v.to_string(),
            name: name.clone(),
            unit: bound
                .first()
                .map(|u| display_name(g, *u))
                .unwrap_or_default(),
        });
    }
    tunnels.sort_by(|a, b| a.name.cmp(&b.name).then(a.id.cmp(&b.id)));

    let mut ways: Vec<Way> = Vec::new();
    for iface in children(g, id, EdgeKind::HasInterface) {
        // Keyed by `LogicalUnit.index` read from the store, so the sort below
        // is numeric on the number the config states rather than on the
        // rendered label. `.0` must come before `.10`, and a string sort puts
        // it after — which is how a config file is emphatically not read. An
        // unstated index sorts LAST rather than being given a 0 that would put
        // it first.
        let mut units: Vec<(u32, Unit)> = Vec::new();
        for u in children(g, iface, EdgeKind::HasUnit) {
            let (zone, zone_name) = unit_zone
                .iter()
                .find(|(n, _, _)| *n == u)
                .map(|(_, z, zn)| (z.clone(), zn.clone()))
                .unwrap_or_default();
            let mut addresses: Vec<String> = children(g, u, EdgeKind::HasAddress)
                .into_iter()
                .map(|a| display_name(g, a))
                .collect();
            addresses.sort();
            let index = text(g, u, "LogicalUnit.index")
                .parse::<u32>()
                .unwrap_or(u32::MAX);
            units.push((
                index,
                Unit {
                    id: u.to_string(),
                    label: display_name(g, u),
                    addresses,
                    zone,
                    zone_name,
                    tunnel: unit_tunnel
                        .iter()
                        .find(|(n, _)| *n == u)
                        .map(|(_, t)| t.clone())
                        .unwrap_or_default(),
                },
            ));
        }
        units.sort_by(|a, b| a.0.cmp(&b.0).then(a.1.id.cmp(&b.1.id)));
        ways.push(Way {
            id: iface.to_string(),
            name: display_name(g, iface),
            kind_word: iface.kind.name(),
            units: units.into_iter().map(|(_, u)| u).collect(),
        });
    }
    ways.sort_by(|a, b| a.name.cmp(&b.name).then(a.id.cmp(&b.id)));

    let mut sets: Vec<SetBand> = Vec::new();
    for s in children(g, id, EdgeKind::HasPolicySet) {
        let mut policies: Vec<PolicyRow> = children(g, s, EdgeKind::HasPolicy)
            .into_iter()
            .map(|p| PolicyRow {
                id: p.to_string(),
                ordinal: text(g, p, "SecurityPolicy.ordinal"),
                name: text(g, p, "SecurityPolicy.name"),
                action: text(g, p, "SecurityPolicy.action"),
                description: text(g, p, "SecurityPolicy.description"),
                enabled: match text(g, p, "SecurityPolicy.enabled").as_str() {
                    "true" => "1".to_owned(),
                    "false" => "0".to_owned(),
                    // Anything else — unset, or a spelling this build does not
                    // know — is "nobody said". Never defaulted to enabled.
                    _ => String::new(),
                },
            })
            .collect();
        // THE ORDER THE DEVICE READS THEM IN, which is the entire point of
        // this band (`57` §6.3). `ordinal` is stored as a decimal string, so
        // it is parsed rather than string-compared: `10` sorts after `9` on a
        // firewall and before it in ASCII, and a policy list in the wrong
        // order is worse than no policy list because first-match is the whole
        // semantics. An unparseable or unstated ordinal sorts LAST and keeps
        // its blank cell, rather than being given a 0 that would put it first.
        policies.sort_by(|a, b| {
            let ka = a.ordinal.parse::<u64>().unwrap_or(u64::MAX);
            let kb = b.ordinal.parse::<u64>().unwrap_or(u64::MAX);
            ka.cmp(&kb).then(a.id.cmp(&b.id))
        });
        let scope = text(g, s, "PolicySet.scope");
        sets.push(SetBand {
            id: s.to_string(),
            scope: if scope == UNRENDERED {
                String::new()
            } else {
                scope
            },
            policies,
        });
    }
    sets.sort_by(|a, b| a.id.cmp(&b.id));

    let mut routes: Vec<RouteBand> = Vec::new();
    for ri in children(g, id, EdgeKind::HasRoutingInstance) {
        let mut protocols: Vec<ProtoRow> = children(g, ri, EdgeKind::HasRoutingProtocol)
            .into_iter()
            .map(|p| ProtoRow {
                id: p.to_string(),
                protocol: text(g, p, "RoutingProtocol.protocol"),
                adjacencies: children(g, p, EdgeKind::HasAdjacency).len(),
            })
            .collect();
        protocols.sort_by(|a, b| a.protocol.cmp(&b.protocol).then(a.id.cmp(&b.id)));
        routes.push(RouteBand {
            id: ri.to_string(),
            name: display_name(g, ri),
            protocols,
        });
    }
    routes.sort_by(|a, b| a.name.cmp(&b.name).then(a.id.cmp(&b.id)));

    Some(Inside {
        device: id.to_string(),
        name: crate::render::value_cell(g, id, key("Device.hostname")),
        ways,
        zones,
        sets,
        routes,
        tunnels,
    })
}
