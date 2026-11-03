//! Retired edge kinds (`retired: true` in `schema/schema.yaml`): what keeps a
//! new one out, and the change that turns an old `Link` into a `Cable`.
//!
//! A retired kind stays in the vocabulary because the change log is the sealed
//! record. Every op in it must still name an element the design holds, so a
//! design whose history added a `Link` keeps that `Link`, tombstoned, for good.
//! What stops is new ones: [`refuse_retired_kinds`] runs where a change is
//! submitted, never where stored changes are replayed, so old history keeps
//! reading.
//!
//! [`links_to_cables`] builds the one change that closes every live `Link` and
//! puts a `Cable` in its place. The server makes it under its own system
//! account, never the account of whoever opened the design.

use std::any::Any;

use fathom_canon::Json;
use fathom_graph::{
    Actor, BatchId, Confidence, EdgeId, ElementId, Graph, NodeId, Op, Origin, ProvenanceId,
    ProvenanceRecord, Timestamp,
};
use fathom_id::Ulid;
use fathom_ir::bag::{typed, FieldKey};
use fathom_ir::generated::accessors::slot_to_canon;
use fathom_ir::generated::ir_types::{
    CableEnd, CableField, CableMedia, DeviceField, EdgeKind, InterfaceField, LinkField, LinkMedia,
    NodeKind, TerminatesField,
};
use fathom_ir::scalar::{Identifier, InterfaceName, Text};

use crate::change::{Change, ChangeError};

/// The label on the change [`links_to_cables`] builds, as history shows it.
pub const LINKS_TO_CABLES_LABEL: &str = "Fathom: old links turned into cables";

/// Refuse a submitted change that adds an edge of a retired kind. Run where a
/// change arrives from a person or an app; stored changes are replayed without
/// it, because history written before the kind retired must still read.
pub fn refuse_retired_kinds(change: &Change) -> Result<(), ChangeError> {
    for op in &change.batch.ops {
        if let Op::AddEdge { edge, .. } = op {
            if edge.kind.retired() {
                return Err(ChangeError::RetiredKind {
                    kind: edge.kind.name(),
                });
            }
        }
    }
    Ok(())
}

/// Every live `Link` in `graph`: not tombstoned, and both ends live.
pub fn live_links(graph: &Graph) -> Vec<EdgeId> {
    let live = |n: NodeId| graph.node(n).is_some_and(|x| x.absent_since.is_none());
    graph
        .edges_of_kind(EdgeKind::Link)
        .filter(|e| e.absent_since.is_none() && live(e.from) && live(e.to))
        .map(|e| e.id)
        .collect()
}

/// The change that tombstones every live `Link` in `graph` and adds one
/// `Cable` for each, or `None` when there is none.
///
/// The cable carries the link's `label`, `length_m` and `provider_circuit`.
/// `media` maps where the two vocabularies agree: `dac` is `twinax` and
/// `virtual` is `virtual`. `unknown` stays unset, which is how a cable says
/// "not known" (Cable dropped the unknown variant). `copper` and `fibre` name
/// no single cable media, so they stay unset too, and the cable's `notes`
/// say what the link said.
///
/// Each end lands on the port its interface occupies when there is exactly
/// one. Fathom never ties an interface to a port itself (Occupies is the
/// person's to make), so an end with no single port is left open and `notes`
/// name the interface it was.
///
/// Every record names `actor` and is `Derived`: the cable is read off the link,
/// not asserted afresh. `next_id` mints every id.
pub fn links_to_cables(
    graph: &Graph,
    batch: BatchId,
    actor: Actor,
    at: Timestamp,
    next_id: impl FnMut() -> Ulid,
) -> Result<Option<Change>, ChangeError> {
    let links = live_links(graph);
    if links.is_empty() {
        return Ok(None);
    }
    let mut b = Builder {
        g: graph.clone(),
        actor,
        at,
        next_id,
        provenance: Vec::new(),
        values: Vec::new(),
    };
    b.g.begin_batch(batch, LINKS_TO_CABLES_LABEL)?;
    for id in links {
        let link = graph.edge(id).expect("a live link").clone();
        b.g.tombstone(ElementId::Edge(id), at, actor)?;
        let rec = b.record();
        let ulid = (b.next_id)();
        let cable = b.g.insert_node(NodeKind::Cable, ulid, rec)?;
        let el = ElementId::Node(cable);

        if let Ok(v) = typed::<Text, _>(&link, LinkField::Label.key()) {
            b.set(el, CableField::Label.key(), v.clone())?;
        }
        if let Ok(v) = typed::<u32, _>(&link, LinkField::LengthM.key()) {
            b.set(el, CableField::LengthM.key(), *v)?;
        }
        if let Ok(v) = typed::<Text, _>(&link, LinkField::ProviderCircuit.key()) {
            b.set(el, CableField::ProviderCircuit.key(), v.clone())?;
        }
        let mut notes: Vec<String> = Vec::new();
        match typed::<LinkMedia, _>(&link, LinkField::Media.key()) {
            Ok(LinkMedia::Dac) => b.set(el, CableField::Media.key(), CableMedia::Twinax)?,
            Ok(LinkMedia::Virtual) => b.set(el, CableField::Media.key(), CableMedia::Virtual)?,
            Ok(LinkMedia::Copper) => notes.push("The old link said copper.".to_owned()),
            Ok(LinkMedia::Fibre) => notes.push("The old link said fibre.".to_owned()),
            Ok(LinkMedia::Unknown(_)) | Err(_) => {}
        }

        let mut ends: Vec<(CableEnd, NodeId)> = Vec::new();
        for (end, letter, iface) in [(CableEnd::A, "A", link.from), (CableEnd::B, "B", link.to)] {
            match single_port(graph, iface) {
                Some(port) => ends.push((end, port)),
                None => notes.push(format!(
                    "End {letter} was {}, which sits on no single port.",
                    describe(graph, iface)
                )),
            }
        }
        if !notes.is_empty() {
            b.set(el, CableField::Notes.key(), Text(notes.join(" ")))?;
        }
        for (end, port) in ends {
            let rec = b.record();
            let ulid = (b.next_id)();
            let t =
                b.g.insert_edge(EdgeKind::Terminates, ulid, cable, port, rec)?;
            b.set(ElementId::Edge(t), TerminatesField::End.key(), end)?;
        }
    }
    b.g.end_batch()?;

    let batch = b.g.log().last().cloned().expect("the batch just closed");
    b.provenance.sort_by_key(|r| r.id);
    Ok(Some(Change {
        batch,
        provenance: b.provenance,
        values: b.values,
    }))
}

struct Builder<F> {
    g: Graph,
    actor: Actor,
    at: Timestamp,
    next_id: F,
    provenance: Vec<ProvenanceRecord>,
    values: Vec<Json>,
}

impl<F: FnMut() -> Ulid> Builder<F> {
    fn record(&mut self) -> ProvenanceRecord {
        let rec = ProvenanceRecord {
            id: ProvenanceId((self.next_id)()),
            origin: Origin::Hand,
            asserted_at: self.at,
            asserted_by: self.actor,
            confidence: Confidence::Derived,
            supersedes: None,
        };
        self.provenance.push(rec.clone());
        rec
    }

    fn set<T: Any>(&mut self, el: ElementId, key: FieldKey, value: T) -> Result<(), ChangeError> {
        self.values
            .push(slot_to_canon(key, &value).map_err(ChangeError::Value)?);
        let rec = self.record();
        self.g.set_field(el, key, value, rec)?;
        Ok(())
    }
}

/// The one live port `iface` occupies, if exactly one.
fn single_port(graph: &Graph, iface: NodeId) -> Option<NodeId> {
    let mut ports = graph
        .out(iface, EdgeKind::Occupies)
        .filter(|e| e.absent_since.is_none())
        .map(|e| e.to)
        .filter(|p| graph.node(*p).is_some_and(|n| n.absent_since.is_none()));
    let first = ports.next()?;
    ports.next().is_none().then_some(first)
}

/// "core-sw1 ge-0/0/1", or as much of it as the design holds.
fn describe(graph: &Graph, iface: NodeId) -> String {
    let name = graph
        .node(iface)
        .and_then(|n| typed::<InterfaceName, _>(n, InterfaceField::Name.key()).ok())
        .map(|n| n.0.clone())
        .unwrap_or_else(|| "an unnamed interface".to_owned());
    let host = graph
        .device_of(iface)
        .and_then(|d| graph.node(d))
        .and_then(|d| typed::<Identifier, _>(d, DeviceField::Hostname.key()).ok())
        .map(|h| h.0.clone());
    match host {
        Some(h) => format!("{h} {name}"),
        None => name,
    }
}
