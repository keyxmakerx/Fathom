//! What the weld refuses before it writes, and the one place a bound value
//! becomes a typed store write (WO-09 §5 step 7).
//!
//! Two functions and no state. `validate` is §4.5 step 1: everything the weld
//! can refuse it refuses **before** the batch opens, because `fathom-graph`
//! cannot roll a batch back (§4.5's atomicity DECISION). `write_field` is the
//! dispatch over `BoundValue`'s 32 variants — an exhaustive `match`, so a new
//! variant upstream is a compile error here, which is the point (§9 failure
//! mode 6). (The count read 22 until 2026-08-15 and had been wrong since
//! `Text` and `Fqdn` landed: a hand-maintained number in a doc comment goes
//! stale silently, which is why the exhaustive `match` and not the number is
//! the control.)
//!
//! No write escapes this module without a provenance record: `write_field`
//! takes one by value and hands it straight to the store.

use fathom_graph::{ElementId, Graph, WriteError};
use fathom_ingest::bind::{BoundValue, FieldAssertion, Fragment};
use fathom_ir::generated::ir_types::NodeKind;

use crate::apply::WeldError;

/// §4.5 step 1. `nodes[0]` exists and is a `Device`; every `owner` points at a
/// strictly earlier index. WO-03 §4.8 contract item 2 makes the second
/// unreachable and the fragment's own shape makes the first unreachable; both
/// are refused rather than assumed.
pub(crate) fn validate(fragment: &Fragment) -> Result<(), WeldError> {
    match fragment.nodes.first() {
        Some(root) if root.kind == NodeKind::Device => {}
        _ => return Err(WeldError::NotDeviceRooted),
    }
    for (index, node) in fragment.nodes.iter().enumerate() {
        let Some(owner) = node.owner else { continue };
        let index = u32::try_from(index).unwrap_or(u32::MAX);
        if owner.0 >= index {
            return Err(WeldError::OwnerNotEarlier { node: index });
        }
    }
    Ok(())
}

/// One assertion, one `set_field`, one record. The `match` moves each payload
/// into the store's generic parameter; the store checks it against the schema
/// slot type the generated registry declares, and a mismatch is
/// `WriteError::WrongType`, which `apply` turns into `WeldError::SlotType`
/// so a broken WO-03 §4.8 contract item 1 names the field rather than the
/// value.
pub(crate) fn write_field(
    graph: &mut Graph,
    element: ElementId,
    assertion: &FieldAssertion,
    record: fathom_graph::ProvenanceRecord,
) -> Result<(), WriteError> {
    let key = assertion.key;
    // ONE call, through the boxed door, rather than one `set_field::<T>` per
    // variant.
    //
    // WHY, AND IT IS BYTES. `Graph::set_field` is generic over the payload, so
    // every arm below used to monomorphise the whole of it -- the slot lookup,
    // the intern, the archive, the B-tree insert and the journal record. The
    // byte census measured 46 copies costing 26 217 bytes of a module with
    // 13 679 to spare, and each of this round's ten new value types was
    // minting another ~550. Routed through `set_field_boxed` the copies
    // collapse to one and a new value type costs its own parser and nothing
    // else. Measured on this tree: 910 421 -> the figure in the commit
    // message, with both dictionary widenings still whole.
    //
    // THE TYPE CHECK IS NOT WEAKENED, ONLY MOVED, which is `set_field_boxed`'s
    // own stated contract: `set_field` compares `TypeId::of::<T>()` against
    // `slot_type(key)` at compile time, `set_field_boxed` compares
    // `(*value).type_id()` against the same `slot_type(key)` at run time, and
    // a wrong box is the same `WriteError::WrongType` a wrong `T` was. The
    // page's hand-authoring path has gone through that door since it landed.
    // The `Box` is not new work either: `set_field` boxed the value anyway on
    // the line that stored it.
    //
    // The match stays EXHAUSTIVE on purpose. A new `BoundValue` variant that
    // ingest can produce and the weld cannot store would be a value parsed,
    // accepted and then dropped between two crates -- the silent loss `14`'s
    // preamble forbids. Compilation fails here instead.
    let value: Box<dyn core::any::Any> = match &assertion.value {
        BoundValue::Identifier(v) => Box::new(v.clone()),
        BoundValue::InterfaceName(v) => Box::new(v.clone()),
        BoundValue::AuthMethod(v) => Box::new(*v),
        BoundValue::DhGroup(v) => Box::new(*v),
        BoundValue::IntegrityAlgorithm(v) => Box::new(*v),
        BoundValue::EncryptionAlgorithm(v) => Box::new(*v),
        BoundValue::Seconds(v) => Box::new(*v),
        BoundValue::Kilobytes(v) => Box::new(*v),
        BoundValue::IkeVersion(v) => Box::new(*v),
        BoundValue::IpPrefix(v) => Box::new(*v),
        BoundValue::InterfaceAddress(v) => Box::new(*v),
        BoundValue::Secret(v) => Box::new(v.clone()),
        BoundValue::Peer(v) => Box::new(v.clone()),
        BoundValue::U8(v) => Box::new(*v),
        BoundValue::U32(v) => Box::new(*v),
        BoundValue::IkePolicyMode(v) => Box::new(v.clone()),
        BoundValue::IpsecProposalProtocol(v) => Box::new(v.clone()),
        BoundValue::EstablishTunnels(v) => Box::new(v.clone()),
        BoundValue::DfBit(v) => Box::new(v.clone()),
        BoundValue::AddressFamily(v) => Box::new(v.clone()),
        BoundValue::FamilySet(v) => Box::new(v.clone()),
        BoundValue::HostServiceSet(v) => Box::new(v.clone()),
        BoundValue::Text(v) => Box::new(v.clone()),
        BoundValue::Fqdn(v) => Box::new(v.clone()),
        BoundValue::Bool(v) => Box::new(*v),
        BoundValue::VlanId(v) => Box::new(*v),
        BoundValue::TzName(v) => Box::new(v.clone()),
        BoundValue::IpAddr(v) => Box::new(*v),
        BoundValue::U16(v) => Box::new(*v),
        BoundValue::HostProtocolSet(v) => Box::new(v.clone()),
        BoundValue::Ip4Addr(v) => Box::new(*v),
        BoundValue::Asn(v) => Box::new(*v),
        BoundValue::OspfAreaId(v) => Box::new(*v),
        BoundValue::Bandwidth(v) => Box::new(*v),
        BoundValue::RoutingProtocolProtocol(v) => Box::new(v.clone()),
        BoundValue::ProtocolAdjacencyNetworkType(v) => Box::new(v.clone()),
    };
    graph.set_field_boxed(element, key, value, record)
}
