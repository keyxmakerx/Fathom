//! What the weld refuses before it writes, and the one place a bound value
//! becomes a typed store write (WO-09 §5 step 7).
//!
//! Two functions and no state. `validate` is §4.5 step 1: everything the weld
//! can refuse it refuses **before** the batch opens, because `fathom-graph`
//! cannot roll a batch back (§4.5's atomicity DECISION). `write_field` is the
//! dispatch over `BoundValue`'s 22 variants — an exhaustive `match`, so a new
//! variant upstream is a compile error here, which is the point (§9 failure
//! mode 6).
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
    match &assertion.value {
        BoundValue::Identifier(v) => graph.set_field(element, key, v.clone(), record),
        BoundValue::InterfaceName(v) => graph.set_field(element, key, v.clone(), record),
        BoundValue::AuthMethod(v) => graph.set_field(element, key, *v, record),
        BoundValue::DhGroup(v) => graph.set_field(element, key, *v, record),
        BoundValue::IntegrityAlgorithm(v) => graph.set_field(element, key, *v, record),
        BoundValue::EncryptionAlgorithm(v) => graph.set_field(element, key, *v, record),
        BoundValue::Seconds(v) => graph.set_field(element, key, *v, record),
        BoundValue::Kilobytes(v) => graph.set_field(element, key, *v, record),
        BoundValue::IkeVersion(v) => graph.set_field(element, key, *v, record),
        BoundValue::IpPrefix(v) => graph.set_field(element, key, *v, record),
        BoundValue::InterfaceAddress(v) => graph.set_field(element, key, *v, record),
        BoundValue::Secret(v) => graph.set_field(element, key, v.clone(), record),
        BoundValue::Peer(v) => graph.set_field(element, key, v.clone(), record),
        BoundValue::U8(v) => graph.set_field(element, key, *v, record),
        BoundValue::U32(v) => graph.set_field(element, key, *v, record),
        BoundValue::IkePolicyMode(v) => graph.set_field(element, key, v.clone(), record),
        BoundValue::IpsecProposalProtocol(v) => graph.set_field(element, key, v.clone(), record),
        BoundValue::EstablishTunnels(v) => graph.set_field(element, key, v.clone(), record),
        BoundValue::DfBit(v) => graph.set_field(element, key, v.clone(), record),
        BoundValue::AddressFamily(v) => graph.set_field(element, key, v.clone(), record),
        BoundValue::FamilySet(v) => graph.set_field(element, key, v.clone(), record),
        BoundValue::HostServiceSet(v) => graph.set_field(element, key, v.clone(), record),
        BoundValue::Text(v) => graph.set_field(element, key, v.clone(), record),
        BoundValue::Fqdn(v) => graph.set_field(element, key, v.clone(), record),
        BoundValue::Bool(v) => graph.set_field(element, key, *v, record),
        BoundValue::PolicyAction(v) => graph.set_field(element, key, v.clone(), record),
    }
}
