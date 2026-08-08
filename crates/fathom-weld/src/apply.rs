//! The weld itself: one ingest fragment onto the store as one new device
//! (WO-09 §4.5).
//!
//! The steps below run in the order §4.5 states, which is also the order
//! §4.4's mint consumes ids — that pairing is what makes two applies of one
//! ingest byte-identical (invariant 9).

use fathom_graph::{BatchId, CaptureId, CaptureSpan, EdgeId, ElementId, Graph, NodeId, WriteError};
use fathom_ingest::bind::{FragNodeId, PendingTarget};
use fathom_ingest::frame::{ByteSpan, LineOrdinal};
use fathom_ingest::IngestOutput;
use fathom_ir::bag::FieldKey;
use fathom_ir::generated::ir_types::{EdgeKind, NodeKind, FIELD_KEYS};

use crate::mint::{Mint, MintError};
use crate::{containment_edge, plan, prov, Manifest};

/// A reference the fragment could not resolve within itself. Carried out of
/// the apply, never written: `14` §7.3 — *"recorded, not materialised, retried
/// on every future ingest for this device. Never a finding"*.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Unresolved {
    /// The store node the reference is from — already written.
    pub from: NodeId,
    pub kind: EdgeKind,
    /// Carried verbatim from the fragment.
    pub target: PendingTarget,
    pub line: LineOrdinal,
    pub span: CaptureSpan,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WeldOutput {
    pub batch: BatchId,
    pub capture: CaptureId,
    /// `nodes[0]` — the device this apply created.
    pub device: NodeId,
    /// Index-aligned with `Fragment.nodes`.
    pub nodes: Vec<NodeId>,
    /// Index-aligned with `Fragment.edges`.
    pub edges: Vec<EdgeId>,
    /// The containment edges materialised from `FragNode.owner`, in the
    /// order §4.4 step 4 mints them.
    pub containment: Vec<EdgeId>,
    /// Every `Fragment.pending` entry, in fragment order. Never lost, never
    /// materialised, never an error (`14` §7.3).
    pub unresolved: Vec<Unresolved>,
    pub minted: u32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WeldError {
    /// `fragment.nodes` is empty, or `nodes[0].kind != Device`. WO-03 §4.8
    /// makes both unreachable; refused rather than assumed. It also covers
    /// the one other way the node vector can fail to answer — an edge
    /// endpoint naming an index the fragment does not have — which WO-03
    /// §4.8's within-the-fragment resolution makes equally unreachable.
    NotDeviceRooted,
    /// `FragNode.owner` does not point at a strictly earlier index
    /// (WO-03 §4.8 contract item 2).
    OwnerNotEarlier {
        node: u32,
    },
    /// No containment edge kind is declared for this (owner, child) pair.
    /// A schema gap, not a bug in the caller: it names both kinds.
    NoContainmentEdge {
        owner: NodeKind,
        child: NodeKind,
    },
    /// The declared slot type and the `BoundValue` payload disagree — the
    /// WO-03 §4.8 contract item 1 guarantee has broken. Names the key.
    SlotType {
        key: FieldKey,
    },
    Mint(MintError),
    /// Any refusal from the store, carried whole so the L0 declaration that
    /// refused is never lost.
    Store(WriteError),
}

impl From<MintError> for WeldError {
    fn from(e: MintError) -> WeldError {
        WeldError::Mint(e)
    }
}

/// Apply one ingest's fragment onto `graph` as a **new** device.
///
/// First application only: it never looks for an existing device and never
/// reconciles (`11` §10.4 is not implemented anywhere — WO-09 §10 item 1).
/// Applying two captures of the same box produces two `Device` nodes, which is
/// the duplication reconciliation exists to prevent; the name says so.
///
/// On any error the graph is left with the partial batch **open** and the ops
/// written so far recorded — `fathom-graph` has no rollback, so WO-09 §4.5's
/// atomicity DECISION states the cost instead of hiding it. Everything the
/// weld can refuse it refuses before the first write.
pub fn apply_new_device(
    graph: &mut Graph,
    ingest: &IngestOutput,
    manifest: &Manifest<'_>,
) -> Result<WeldOutput, WeldError> {
    let fragment = &ingest.fragment;

    // 1. Validate, before any write.
    plan::validate(fragment)?;

    // The mint's first id is the capture's (§4.4 step 1). Minting it here,
    // before the batch opens, keeps a bad `at` a pre-write refusal too.
    let mut mint = Mint::new(manifest.at, manifest.entropy)?;
    let whole = whole_capture(ingest.capture.text());
    let capture = CaptureId(mint.next()?);

    // 2. Open the batch. Every op below lands in it (`53` §7.2).
    graph
        .begin_batch(manifest.batch, manifest.label)
        .map_err(WeldError::Store)?;

    // 3. Nodes. Existence spans the node's first assertion, or the whole
    //    capture where the statement that named the object asserted no field.
    let mut spans: Vec<CaptureSpan> = Vec::with_capacity(fragment.nodes.len());
    let mut nodes: Vec<NodeId> = Vec::with_capacity(fragment.nodes.len());
    for node in &fragment.nodes {
        let span = node.fields.first().map_or(whole, |a| span_of(a.prov.span));
        let record = prov::existence(&mut mint, manifest, capture, span)?;
        let ulid = mint.next()?;
        nodes.push(
            graph
                .insert_node(node.kind, ulid, record)
                .map_err(WeldError::Store)?,
        );
        spans.push(span);
    }
    let device = *nodes.first().ok_or(WeldError::NotDeviceRooted)?;

    // 4. `Device.platform`, `Derived`: no statement asserts it, it follows
    //    necessarily from which dictionary parsed the capture (`11` §8.3).
    let record = prov::derived(&mut mint, manifest, capture, whole)?;
    graph
        .set_field(
            ElementId::Node(device),
            platform_key(),
            manifest.platform.clone(),
            record,
        )
        .map_err(field_error)?;

    // 5. Containment, from `FragNode.owner`. 6. `nodes[0]` has no owner and
    //    therefore no containment in-edge: `Site` is not in the fragment and
    //    this WO does not invent one. A `Device` with no `HasDevice` in-edge
    //    is L0-valid — `11` §7.2's rule is an upper bound at write time.
    let mut containment: Vec<EdgeId> = Vec::with_capacity(fragment.nodes.len());
    for (index, node) in fragment.nodes.iter().enumerate() {
        let Some(owner) = node.owner else { continue };
        // `validate` proved `owner` points at an earlier existing index, so
        // every lookup below answers; refused rather than assumed.
        let at = usize::try_from(owner.0).unwrap_or(usize::MAX);
        let owner_kind = fragment
            .nodes
            .get(at)
            .map(|n| n.kind)
            .ok_or(WeldError::NotDeviceRooted)?;
        let kind = containment_edge(owner_kind, node.kind).ok_or(WeldError::NoContainmentEdge {
            owner: owner_kind,
            child: node.kind,
        })?;
        let from = *nodes.get(at).ok_or(WeldError::NotDeviceRooted)?;
        let to = *nodes.get(index).ok_or(WeldError::NotDeviceRooted)?;
        let span = *spans.get(index).ok_or(WeldError::NotDeviceRooted)?;
        let record = prov::existence(&mut mint, manifest, capture, span)?;
        let ulid = mint.next()?;
        containment.push(
            graph
                .insert_edge(kind, ulid, from, to, record)
                .map_err(WeldError::Store)?,
        );
    }

    // 7. Node fields, one record per assertion (§12 item 3).
    for (node, id) in fragment.nodes.iter().zip(nodes.iter()) {
        let element = ElementId::Node(*id);
        for assertion in &node.fields {
            let record = prov::field(&mut mint, manifest, capture, span_of(assertion.prov.span))?;
            plan::write_field(graph, element, assertion, record).map_err(field_error)?;
        }
    }

    // 8. Fragment edges, then their fields by the same dispatch.
    let mut edges: Vec<EdgeId> = Vec::with_capacity(fragment.edges.len());
    for edge in &fragment.edges {
        let from = resolve(&nodes, edge.from)?;
        let to = resolve(&nodes, edge.to)?;
        let record = prov::existence(&mut mint, manifest, capture, span_of(edge.prov.span))?;
        let ulid = mint.next()?;
        let id = graph
            .insert_edge(edge.kind, ulid, from, to, record)
            .map_err(WeldError::Store)?;
        edges.push(id);
        for assertion in &edge.fields {
            let record = prov::field(&mut mint, manifest, capture, span_of(assertion.prov.span))?;
            plan::write_field(graph, ElementId::Edge(id), assertion, record)
                .map_err(field_error)?;
        }
    }

    // 9. Pending references: carried out, not written (`14` §7.3).
    let mut unresolved: Vec<Unresolved> = Vec::with_capacity(fragment.pending.len());
    for pending in &fragment.pending {
        unresolved.push(Unresolved {
            from: resolve(&nodes, pending.from)?,
            kind: pending.kind,
            target: pending.target.clone(),
            line: pending.prov.line,
            span: span_of(pending.prov.span),
        });
    }

    // 10. Close.
    let batch = graph.end_batch().map_err(WeldError::Store)?;
    Ok(WeldOutput {
        batch,
        capture,
        device,
        nodes,
        edges,
        containment,
        unresolved,
        minted: mint.issued(),
    })
}

/// `Device.platform`'s wire key, read from the generated registry and never
/// written as a literal (§4.5 step 4; ADR-0008). Field keys are 1-based and
/// append-only, so the unassignable `0` is the honest fallback: a registry
/// that stopped naming the field surfaces as the store's `UndeclaredField`
/// rather than as a silent skip.
fn platform_key() -> FieldKey {
    FieldKey(
        FIELD_KEYS
            .iter()
            .find(|(name, _)| *name == "Device.platform")
            .map_or(0, |(_, key)| *key),
    )
}

/// The parser's span type and the store's are the same shape and deliberately
/// distinct types (§12 item 2); this is the one place they meet.
fn span_of(span: ByteSpan) -> CaptureSpan {
    CaptureSpan {
        start: span.start,
        end: span.end,
    }
}

/// `[0, len)` over the redacted capture. A paste is capped at 32 MiB
/// (`fathom_ingest::MAX_PASTE_BYTES`), so the saturation below is unreachable
/// and is written rather than asserted.
fn whole_capture(text: &str) -> CaptureSpan {
    CaptureSpan {
        start: 0,
        end: u32::try_from(text.len()).unwrap_or(u32::MAX),
    }
}

/// A fragment index to the store node it became. In range by construction —
/// WO-03 §4.8 resolves edge targets within the fragment only.
fn resolve(nodes: &[NodeId], id: FragNodeId) -> Result<NodeId, WeldError> {
    let at = usize::try_from(id.0).unwrap_or(usize::MAX);
    nodes.get(at).copied().ok_or(WeldError::NotDeviceRooted)
}

/// A field write's refusal. `WrongType` names the key rather than the value,
/// so a broken WO-03 §4.8 contract item 1 is legible; everything else is an
/// L0 declaration refusing, carried whole.
fn field_error(e: WriteError) -> WeldError {
    match e {
        WriteError::WrongType { key, .. } => WeldError::SlotType { key },
        other => WeldError::Store(other),
    }
}
