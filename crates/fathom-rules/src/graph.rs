//! The real store behind the rule engine's two traits.
//!
//! **What a rule may read is decided here, once.** A field's static type comes from the
//! generated `slot_type`; secrets (`SecretPlaceholder`) and free-text captures and notes
//! are `Ty::Secret`, which the checker refuses to compile even as a presence test. Nothing a
//! redaction gate destroyed is ever in the store, and nothing the gate would have flagged
//! is readable by a rule (CLAUDE.md rule 4).

use std::any::{Any, TypeId};
use std::sync::OnceLock;

use fathom_graph::{EdgeId as GEdgeId, ElementId, Graph, NodeId, Op, StoredPresence};
use fathom_ir::bag::{typed, FieldBag, FieldKey};
use fathom_ir::generated::accessors::slot_type;
use fathom_ir::generated::ir_types::{self as ir, EdgeKind, NodeKind, FIELD_KEYS};
use fathom_ir::scalar;

use crate::compile::Owner;
use crate::engine::Delta;
use crate::schema::{EdgeInfo, FieldInfo, Schema, World};
use crate::value::{parse_ip, parse_net, EdgeId, EnumId, Field, FieldId, KindId, Scalar, Ty};

macro_rules! enums {
    ($($t:ident),+ $(,)?) => {
        struct EnumRow {
            name: &'static str,
            tid: TypeId,
            tokens: &'static [&'static str],
            read: fn(&dyn FieldBag, FieldKey) -> Option<String>,
        }
        fn enum_table() -> &'static [EnumRow] {
            static T: OnceLock<Vec<EnumRow>> = OnceLock::new();
            T.get_or_init(|| {
                vec![$(EnumRow {
                    name: stringify!($t),
                    tid: TypeId::of::<ir::$t>(),
                    tokens: &ir::$t::DECLARED,
                    read: |bag, k| typed::<ir::$t, _>(bag, k).ok().map(|v| v.token().to_owned()),
                }),+]
            })
        }
    };
}

enums!(
    AddressFamily,
    AggregateInterfaceLacpPeriodic,
    CableEnd,
    CableMedia,
    CableOwnership,
    ConformanceState,
    DeviceRole,
    EstablishTunnels,
    Family,
    HostProtocol,
    HostService,
    IkePolicyMode,
    InterfaceDuplex,
    InterfaceForm,
    IpsecProposalProtocol,
    IpsecVpnDfBit,
    LacpMode,
    LinkMedia,
    NatRuleSetNatType,
    PassiveNodeForm,
    PathSegmentBoundaryReason,
    PathSegmentCorroboration,
    PathSegmentWarpTechnology,
    PeersWithRedundancy,
    PhysicalPortConnector,
    PhysicalPortService,
    PolicyAction,
    PolicySetEvaluation,
    PremisesForm,
    ProtocolAdjacencyNetworkType,
    RoutingInstanceIsolation,
    RoutingProtocolProtocol,
    SegmentKind,
    ServiceEndpointRole,
    ServicePathRole,
    ServiceReach,
    ServiceTypeUniScope,
    SiteCriticality,
    TenantKind,
    TunnelEndpointSide,
    TunnelIntendedState,
    TunnelInterfaceTechnology,
    VlanMemberMode,
    VpnMode,
);

#[derive(Clone, Copy)]
enum Reader {
    Bool,
    Uint,
    /// A scalar whose canonical text is a decimal integer.
    Decimal,
    Text,
    Addr,
    Prefix,
    Iface,
    Enum(usize),
    Present,
}

fn last_segment(name: &str) -> &str {
    name.rsplit("::").next().unwrap_or(name)
}

fn classify(key: FieldKey) -> (Ty, Reader) {
    let Some((tid, tname)) = slot_type(key) else {
        return (Ty::Opaque, Reader::Present);
    };
    if let Some(i) = enum_table().iter().position(|e| e.tid == tid) {
        return (Ty::Enum(EnumId(i as u16)), Reader::Enum(i));
    }
    // The tail of the type path is the scalar's schema name (`crate::scalar::Bandwidth`).
    match last_segment(tname) {
        "bool" => (Ty::Bool, Reader::Bool),
        "u8" | "u16" | "u32" | "u64" => (Ty::Int, Reader::Uint),
        "Bandwidth" | "VlanId" | "Seconds" | "Kilobytes" | "L4Port" => (Ty::Int, Reader::Decimal),
        "Text" | "Identifier" | "InterfaceName" | "Fqdn" | "PlatformId" | "OsVersion" => {
            (Ty::Str, Reader::Text)
        }
        "IpAddr" | "Ip4Addr" | "Ip6Addr" => (Ty::Addr, Reader::Addr),
        "IpPrefix" => (Ty::Prefix, Reader::Prefix),
        "InterfaceAddress" => (Ty::Iface, Reader::Iface),
        "SecretPlaceholder" => (Ty::Secret, Reader::Present),
        _ => (Ty::Opaque, Reader::Present),
    }
}

fn read_value(bag: &dyn FieldBag, key: FieldKey) -> Option<Scalar> {
    let (tid, _) = slot_type(key)?;
    let (_, reader) = classify(key);
    macro_rules! canon {
        ($($t:ty),+) => {$(
            if tid == TypeId::of::<$t>() {
                return typed::<$t, _>(bag, key).ok().map(scalar::Scalar::canonical);
            }
        )+};
    }
    macro_rules! uint {
        ($($t:ty),+) => {$(
            if tid == TypeId::of::<$t>() {
                return typed::<$t, _>(bag, key)
                    .ok()
                    .and_then(|v| i64::try_from(*v).ok())
                    .map(Scalar::Int);
            }
        )+};
    }
    let text = || -> Option<String> {
        canon!(
            scalar::Text,
            scalar::Identifier,
            scalar::InterfaceName,
            scalar::Fqdn,
            scalar::PlatformId,
            scalar::OsVersion,
            scalar::IpAddr,
            scalar::Ip4Addr,
            scalar::Ip6Addr,
            scalar::IpPrefix,
            scalar::InterfaceAddress,
            scalar::Bandwidth,
            scalar::VlanId,
            scalar::Seconds,
            scalar::Kilobytes,
            scalar::L4Port
        );
        None
    };
    Some(match reader {
        Reader::Bool => Scalar::Bool(*typed::<bool, _>(bag, key).ok()?),
        Reader::Uint => {
            uint!(u8, u16, u32, u64);
            return None;
        }
        Reader::Decimal => Scalar::Int(text()?.parse().ok()?),
        Reader::Text => Scalar::Str(text()?),
        Reader::Addr => Scalar::Addr(parse_ip(&text()?)?),
        Reader::Prefix => {
            let (a, l) = parse_net(&text()?)?;
            Scalar::Prefix(a, l)
        }
        Reader::Iface => {
            let (a, l) = parse_net(&text()?)?;
            Scalar::Iface(a, l)
        }
        Reader::Enum(i) => Scalar::Str((enum_table().get(i)?.read)(bag, key)?),
        Reader::Present => Scalar::Present,
    })
}

struct OneSlot(FieldKey, Box<dyn Any>);

impl FieldBag for OneSlot {
    fn field(&self, key: FieldKey) -> Option<&dyn Any> {
        (key == self.0).then_some(&*self.1)
    }
}

/// A value about to be written, as a rule would read it: the gesture dry run's
/// field override. `Unset` when the value has no reading a rule can use.
pub fn field_from_boxed(key: FieldKey, value: Box<dyn Any>) -> Field {
    read_value(&OneSlot(key, value), key).map_or(Field::Unset, Field::Set)
}

/// The schema as `fathom-ir` generated it.
pub struct IrSchema;

fn field_name_key(owner: &str, name: &str) -> Option<FieldKey> {
    let full = format!("{owner}.{name}");
    FIELD_KEYS
        .iter()
        .find(|(n, _)| *n == full)
        .map(|(_, k)| FieldKey(*k))
}

fn kind_of_id(k: KindId) -> Option<NodeKind> {
    NodeKind::ALL.get(usize::from(k.0)).copied()
}

fn kind_id(k: NodeKind) -> KindId {
    KindId(k.index() as u16)
}

impl Schema for IrSchema {
    fn kind(&self, name: &str) -> Option<KindId> {
        NodeKind::from_name(name).map(kind_id)
    }

    fn kind_name(&self, k: KindId) -> String {
        kind_of_id(k).map_or_else(|| "?".to_owned(), |k| k.name().to_owned())
    }

    fn node_field(&self, k: KindId, name: &str) -> Option<FieldInfo> {
        let kind = kind_of_id(k)?;
        let key = field_name_key(kind.name(), name)?;
        let (mut ty, _) = classify(key);
        // Pasted prose and notes are free text a person typed; no rule reads them.
        if matches!(kind, NodeKind::Capture | NodeKind::Note) && name == "text" {
            ty = Ty::Secret;
        }
        kind.fields().contains(&key).then_some(FieldInfo {
            id: FieldId(key.0),
            ty,
        })
    }

    fn edge(&self, name: &str) -> Option<EdgeInfo> {
        let e = EdgeKind::from_name(name)?;
        Some(EdgeInfo {
            id: EdgeId(e.index() as u16),
            from: e.from_kinds().iter().map(|k| kind_id(*k)).collect(),
            to: e.to_kinds().iter().map(|k| kind_id(*k)).collect(),
        })
    }

    fn edge_field(&self, e: EdgeId, name: &str) -> Option<FieldInfo> {
        let kind = EdgeKind::ALL.get(usize::from(e.0))?;
        let key = field_name_key(kind.name(), name)?;
        let (ty, _) = classify(key);
        Some(FieldInfo {
            id: FieldId(key.0),
            ty,
        })
    }

    fn enum_tokens(&self, e: EnumId) -> Option<Vec<String>> {
        enum_table()
            .get(usize::from(e.0))
            .map(|r| r.tokens.iter().map(|t| (*t).to_owned()).collect())
    }
}

/// A rule's view of one `Graph`. Tombstoned nodes and edges are invisible.
pub struct GraphWorld<'a> {
    pub g: &'a Graph,
}

fn live_node(g: &Graph, n: NodeId) -> bool {
    g.node(n).is_some_and(|x| x.absent_since.is_none())
}

fn field_of(g: &Graph, el: ElementId, key: FieldKey, bag: Option<&dyn FieldBag>) -> Field {
    let Ok(info) = g.presence(el, key) else {
        return Field::Unset;
    };
    match info.presence {
        StoredPresence::Unknown => Field::Unset,
        StoredPresence::Absent => Field::Absent,
        StoredPresence::Set => bag
            .and_then(|b| read_value(b, key))
            .map_or(Field::Unset, Field::Set),
    }
}

impl World for GraphWorld<'_> {
    type Node = NodeId;
    type Edge = GEdgeId;

    fn nodes(&self, kind: KindId, out: &mut Vec<NodeId>) {
        if let Some(k) = kind_of_id(kind) {
            out.extend(
                self.g
                    .nodes_of_kind(k)
                    .filter(|n| n.absent_since.is_none())
                    .map(|n| n.id),
            );
        }
    }

    fn hop(&self, n: NodeId, edge: EdgeId, rev: bool, out: &mut Vec<(NodeId, GEdgeId)>) {
        let Some(&k) = EdgeKind::ALL.get(usize::from(edge.0)) else {
            return;
        };
        if rev {
            out.extend(
                self.g
                    .inn(n, k)
                    .filter(|e| e.absent_since.is_none() && live_node(self.g, e.from))
                    .map(|e| (e.from, e.id)),
            );
        } else {
            out.extend(
                self.g
                    .out(n, k)
                    .filter(|e| e.absent_since.is_none() && live_node(self.g, e.to))
                    .map(|e| (e.to, e.id)),
            );
        }
        out.sort_by_key(|(m, _)| *m);
    }

    fn field(&self, n: NodeId, f: FieldId) -> Field {
        let bag = self.g.node(n).map(|x| x as &dyn FieldBag);
        field_of(self.g, ElementId::Node(n), FieldKey(f.0), bag)
    }

    fn edge_field(&self, e: GEdgeId, f: FieldId) -> Field {
        let bag = self.g.edge(e).map(|x| x as &dyn FieldBag);
        field_of(self.g, ElementId::Edge(e), FieldKey(f.0), bag)
    }

    fn kind_of(&self, n: NodeId) -> KindId {
        kind_id(n.kind)
    }
}

/// What the batches at `log[from..]` touched. A graph that is a different instance, or
/// whose log is shorter than `from`, is the caller's `Dirty::All`.
pub fn delta_since(g: &Graph, from: usize) -> Delta {
    let mut d = Delta::default();
    for batch in g.log().iter().skip(from) {
        for op in &batch.ops {
            match op {
                Op::AddNode { node, .. } => {
                    d.kinds.insert(kind_id(node.kind));
                }
                Op::AddEdge { edge, .. } => {
                    d.edges.insert(EdgeId(edge.kind.index() as u16));
                }
                Op::SetField { element, key, .. } => {
                    d.fields.insert((owner_of(*element), FieldId(key.0)));
                }
                Op::Tombstone { element, .. } | Op::Revive { element, .. } => match element {
                    ElementId::Node(n) => {
                        d.kinds.insert(kind_id(n.kind));
                    }
                    ElementId::Edge(e) => {
                        d.edges.insert(EdgeId(e.kind.index() as u16));
                    }
                },
            }
        }
    }
    d
}

fn owner_of(el: ElementId) -> Owner {
    match el {
        ElementId::Node(n) => Owner::Node(kind_id(n.kind)),
        ElementId::Edge(e) => Owner::Edge(EdgeId(e.kind.index() as u16)),
    }
}

/// A boxed value for a field, from text — the fixtures' way in. Covers the types the
/// first rule set reads; anything else is a fixture error, not a guess.
pub fn box_from_text(key: FieldKey, text: &str) -> Result<Box<dyn Any>, String> {
    let (tid, tname) = slot_type(key).ok_or("not a declared field")?;
    macro_rules! sc {
        ($($t:ty),+) => {$(
            if tid == TypeId::of::<$t>() {
                return <$t as scalar::Scalar>::parse(text).map(|v| Box::new(v) as Box<dyn Any>).map_err(|e| format!("{e:?}"));
            }
        )+};
    }
    sc!(
        scalar::Text,
        scalar::Identifier,
        scalar::InterfaceName,
        scalar::Bandwidth,
        scalar::VlanId,
        scalar::InterfaceAddress,
        scalar::IpAddr,
        scalar::IpPrefix,
        scalar::PlatformId
    );
    if let Some(row) = enum_table().iter().find(|e| e.tid == tid) {
        if !row.tokens.contains(&text) {
            return Err(format!(
                "`{text}` is not a {} token ({})",
                row.name,
                row.tokens.join(", ")
            ));
        }
        macro_rules! tok {
            ($($t:ident),+) => {$(
                if tid == TypeId::of::<ir::$t>() {
                    return Ok(Box::new(ir::$t::from_token(text)));
                }
            )+};
        }
        tok!(
            AddressFamily,
            CableEnd,
            CableMedia,
            DeviceRole,
            InterfaceForm,
            PhysicalPortConnector,
            PhysicalPortService,
            VlanMemberMode,
            InterfaceDuplex
        );
        return Err(format!("fixtures cannot set {} yet", row.name));
    }
    match last_segment(tname) {
        "bool" => text
            .parse::<bool>()
            .map(|b| Box::new(b) as Box<dyn Any>)
            .map_err(|e| e.to_string()),
        "u8" => text
            .parse::<u8>()
            .map(|b| Box::new(b) as Box<dyn Any>)
            .map_err(|e| e.to_string()),
        "u16" => text
            .parse::<u16>()
            .map(|b| Box::new(b) as Box<dyn Any>)
            .map_err(|e| e.to_string()),
        "u32" => text
            .parse::<u32>()
            .map(|b| Box::new(b) as Box<dyn Any>)
            .map_err(|e| e.to_string()),
        "Transceiver" => Ok(Box::new(fathom_ir::value::Transceiver)),
        other => Err(format!("fixtures cannot set a {other} yet")),
    }
}
