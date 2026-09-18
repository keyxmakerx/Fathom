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
    /// The `Capture` node this apply attached, `Some` only on the
    /// `apply_into_device` path (ADR-0052 §3, scoped as this function's own
    /// doc explains). Its `NodeId.ulid` equals `capture.0`.
    pub capture_node: Option<NodeId>,
    /// `nodes[0]` — the device this apply wrote to. A fresh node for
    /// `apply_new_device`; the operator's placed node, unchanged, for
    /// `apply_into_device`.
    pub device: NodeId,
    /// Index-aligned with `Fragment.nodes`.
    pub nodes: Vec<NodeId>,
    /// Index-aligned with `Fragment.edges`.
    pub edges: Vec<EdgeId>,
    /// The containment edges materialised for every node but `nodes[0]`, in
    /// the order §4.4 step 4 mints them: from `FragNode.owner` where the
    /// fragment declared one, and from the parent kind the schema determines
    /// where it did not (§10 item 10).
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
    /// `apply_into_device`'s target does not resolve to a live `Device` — the
    /// display id named something else, or named a device that has been
    /// tombstoned since the operator chose it.
    TargetNotDevice,
    /// `apply_into_device`'s target already carries a live `Capture`
    /// (ADR-0052 §3). Every non-root fragment node is minted fresh
    /// (`apply_into_device`'s own doc: "this is not reconciliation") — a
    /// second paste has nothing to supersede the first paste's children
    /// with, so it would duplicate them rather than update them. ADR-0010
    /// requires re-identification to be a proposal to a human, so this door
    /// does not guess which of the target's existing children the new
    /// fragment's nodes are; it refuses until that reconciliation exists
    /// (`11` §10.4, still unimplemented — WO-09 §10 item 1).
    AlreadyCaptured,
}

impl From<MintError> for WeldError {
    fn from(e: MintError) -> WeldError {
        WeldError::Mint(e)
    }
}

/// Which store node the fragment's root (index 0, always `Device`) becomes.
///
/// The two public entry points below are this one choice: `apply_new_device`
/// mints a fresh node for it, `apply_into_device` (ADR-0052 §4) reuses a
/// `Device` the operator already placed. Everything after the root — every
/// other node, every edge, every field — is written identically either way,
/// which is why this is a fork inside one function rather than two parallel
/// copies of WO-09 §4.5's ten steps.
enum Root {
    New,
    Existing(NodeId),
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
    apply(graph, ingest, manifest, Root::New)
}

/// Apply one ingest's fragment onto `graph`, writing every field the capture
/// states onto a `Device` the operator has already placed (ADR-0052 §4).
///
/// **This is not reconciliation.** `11` §10.4's re-identification question —
/// "is this a second reading of a box the design already holds?" — does not
/// arise here, because nothing is being guessed: the operator chose this exact
/// faceplate to paste under, which is ADR-0010's own answer to "who decides two
/// readings are the same box" (*"a proposal to a human, not an automatic
/// merge"*) — already decided, by the human, before this function runs. So
/// `shell::identity_clash` is never called on this path.
///
/// `device` must name a live (`absent_since.is_none()`) `Device` node already
/// in `graph`; anything else is `WeldError::TargetNotDevice`. `device` must
/// also carry no live `Capture` yet; a second paste is
/// `WeldError::AlreadyCaptured` — every non-root fragment node below still
/// mints fresh, so a second paste has nothing to supersede its predecessor's
/// children with, and would duplicate the whole subtree the way
/// `apply_new_device`'s own doc warns against.
///
/// On success the fragment's root (fragment index 0) resolves to `device`
/// rather than to a freshly minted node: no existence record is written for
/// it (it already has one) and no id is minted for it. Every field the fragment asserts on the
/// root — `Device.hostname` included — is written through the same
/// `set_field_boxed` door `OP_FIELD_SET` uses, so where the device already
/// carries a value for that field the store archives the old slot and fills
/// `supersedes` from it (`Graph::check_prov`, `11` §8.6): the write is a
/// supersession, never a silent overwrite, and the history keeps both.
pub fn apply_into_device(
    graph: &mut Graph,
    ingest: &IngestOutput,
    manifest: &Manifest<'_>,
    device: NodeId,
) -> Result<WeldOutput, WeldError> {
    if device.kind != NodeKind::Device {
        return Err(WeldError::TargetNotDevice);
    }
    match graph.node(device) {
        Some(n) if n.absent_since.is_none() => {}
        _ => return Err(WeldError::TargetNotDevice),
    }
    let already_captured = graph
        .out(device, EdgeKind::HasCapture)
        .any(|e| e.absent_since.is_none());
    if already_captured {
        return Err(WeldError::AlreadyCaptured);
    }
    apply(graph, ingest, manifest, Root::Existing(device))
}

fn apply(
    graph: &mut Graph,
    ingest: &IngestOutput,
    manifest: &Manifest<'_>,
    root: Root,
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
    //    `Root::Existing` skips both the existence record and the mint for
    //    index 0 — the node already exists and already has one.
    let mut spans: Vec<CaptureSpan> = Vec::with_capacity(fragment.nodes.len());
    let mut nodes: Vec<NodeId> = Vec::with_capacity(fragment.nodes.len());
    for (index, node) in fragment.nodes.iter().enumerate() {
        let span = node.fields.first().map_or(whole, |a| span_of(a.prov.span));
        if index == 0 {
            if let Root::Existing(id) = root {
                nodes.push(id);
                spans.push(span);
                continue;
            }
        }
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

    // 5. Containment. Where the fragment declares an `owner`, that node is the
    //    parent; where it does not, the schema already determines the parent
    //    from the child's kind (WO-09 §10 item 10), so nothing is guessed.
    //    6. `nodes[0]` is the one node with no containment in-edge: `Site` is
    //    not in the fragment and this WO does not invent one. A `Device` with
    //    no `HasDevice` in-edge is L0-valid — `11` §7.2's rule is an upper
    //    bound at write time.
    let root_kind = fragment
        .nodes
        .first()
        .map(|n| n.kind)
        .ok_or(WeldError::NotDeviceRooted)?;
    let mut containment: Vec<EdgeId> = Vec::with_capacity(fragment.nodes.len());
    for (index, node) in fragment.nodes.iter().enumerate() {
        if index == 0 {
            continue;
        }
        // `validate` proved a declared `owner` points at an earlier existing
        // index, so every lookup below answers; refused rather than assumed.
        let at = match node.owner {
            Some(owner) => usize::try_from(owner.0).unwrap_or(usize::MAX),
            None => derived_owner(root_kind, node.kind)?,
        };
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

    // 9b. The capture node (ADR-0052 §3) — ONLY on the `apply_into_device`
    //     path. Scoped there deliberately: attaching it to every
    //     `apply_new_device`/`OP_PASTE` call as well is §3's fuller shape and
    //     is not this change's job (ADR-0052 §2 and §4 are), and doing it here
    //     unconditionally would change the node/edge count of every existing
    //     paste this tree already tests against.
    let capture_node = match root {
        Root::Existing(_) => Some(attach_capture(
            graph,
            &mut mint,
            manifest,
            capture,
            device,
            ingest.capture.text(),
        )?),
        Root::New => None,
    };

    // 10. Close.
    let batch = graph.end_batch().map_err(WeldError::Store)?;
    Ok(WeldOutput {
        batch,
        capture,
        capture_node,
        device,
        nodes,
        edges,
        containment,
        unresolved,
        minted: mint.issued(),
    })
}

/// ADR-0052 §3: one `Capture` node, owned by `device`, holding the redacted
/// text, the platform, and the line count. **Its node id IS `capture`'s own
/// ULID** — schema's own doc on `NodeKind::Capture` says so — never a
/// separately minted one, so every field's `Origin::Parsed { capture, .. }`
/// resolves to this node with no join.
fn attach_capture(
    graph: &mut Graph,
    mint: &mut Mint,
    manifest: &Manifest<'_>,
    capture: CaptureId,
    device: NodeId,
    text: &str,
) -> Result<NodeId, WeldError> {
    let whole = whole_capture(text);
    let existence = prov::existence(mint, manifest, capture, whole)?;
    let node = graph
        .insert_node(NodeKind::Capture, capture.0, existence)
        .map_err(WeldError::Store)?;

    let edge_record = prov::existence(mint, manifest, capture, whole)?;
    let edge_ulid = mint.next()?;
    graph
        .insert_edge(EdgeKind::HasCapture, edge_ulid, device, node, edge_record)
        .map_err(WeldError::Store)?;

    let text_record = prov::derived(mint, manifest, capture, whole)?;
    graph
        .set_field(
            ElementId::Node(node),
            field_key("Capture.text"),
            fathom_ir::scalar::Text(text.to_owned()),
            text_record,
        )
        .map_err(field_error)?;

    let platform_record = prov::derived(mint, manifest, capture, whole)?;
    graph
        .set_field(
            ElementId::Node(node),
            field_key("Capture.platform"),
            manifest.platform.clone(),
            platform_record,
        )
        .map_err(field_error)?;

    let count_record = prov::derived(mint, manifest, capture, whole)?;
    let line_count = u32::try_from(text.lines().count()).unwrap_or(u32::MAX);
    graph
        .set_field(
            ElementId::Node(node),
            field_key("Capture.line_count"),
            line_count,
            count_record,
        )
        .map_err(field_error)?;

    Ok(node)
}

/// The fragment index of the containment parent for a node that declares no
/// `owner` — WO-09 §10 item 10's answer, which is a derivation and not a
/// default: the schema already fixes which kind may contain a given kind, so
/// the fragment never had to say it.
///
/// A first application writes one device and everything else the capture
/// stated about it, so the only parent such a node can have is `nodes[0]`.
/// The schema must agree twice over: exactly one kind may contain `child`,
/// and that kind is the fragment root's. Anything else — no parent kind, or
/// more than one — is refused with `NoContainmentEdge`, which names the root
/// kind it could not place the child under. Refusing rather than choosing is
/// the answer's own instruction: an ambiguous containment edge is a schema
/// change nobody has thought through, not a case to guess at.
fn derived_owner(root_kind: NodeKind, child: NodeKind) -> Result<usize, WeldError> {
    match crate::sole_containment_parent(child) {
        Some(parent) if parent == root_kind => Ok(0),
        _ => Err(WeldError::NoContainmentEdge {
            owner: root_kind,
            child,
        }),
    }
}

/// `Device.platform`'s wire key (§4.5 step 4).
fn platform_key() -> FieldKey {
    field_key("Device.platform")
}

/// A wire key by its `Kind.field` name, read from the generated registry and
/// never written as a literal (ADR-0008). Field keys are 1-based and
/// append-only, so the unassignable `0` is the honest fallback: a registry
/// that stopped naming the field surfaces as the store's `UndeclaredField`
/// rather than as a silent skip.
fn field_key(name: &str) -> FieldKey {
    FieldKey(
        FIELD_KEYS
            .iter()
            .find(|(n, _)| *n == name)
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
