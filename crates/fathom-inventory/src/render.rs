//! Value rendering — WO-08 §4.3's one closed table, and nothing else.
//!
//! Every cell in this face is produced here: the three presence states, the
//! scalar canonical forms (bound by *calling* `Scalar::canonical()`, never by
//! restating a format — WO-01 owns those), the generated enums' schema tokens,
//! the integer forms, and the two structured value types the demo estate
//! reaches. A `TypeId` outside the table is unreachable over the demo estate
//! (WO-08 §7 trigger 5).
//!
//! Dates are **stored values rendered as stored** (invariant 9): `ymd` is pure
//! integer civil-from-days arithmetic over the timestamp the provenance record
//! carries. Nothing here reads a clock, and nothing computes an age.

use core::any::TypeId;

use fathom_graph::{ElementId, Graph, NodeId, StoredPresence};
use fathom_ir::bag::{typed, FieldBag, FieldKey};
use fathom_ir::generated::accessors::slot_type;
use fathom_ir::generated::ir_types;
use fathom_ir::scalar::{self, Scalar};
use fathom_ir::value;

/// The Unknown cell (WO-08 §4.3 row 1). Not a value; the absence of a slot.
pub(crate) const UNKNOWN: &str = "—";

/// The wire key of a field named `Kind.field` in the generated registry.
/// No key number is ever hand-copied into this crate (ADR-0008).
pub(crate) fn key(name: &'static str) -> FieldKey {
    let (_, k) = ir_types::FIELD_KEYS
        .iter()
        .find(|(n, _)| *n == name)
        .unwrap_or_else(|| panic!("`{name}` is not a declared field"));
    FieldKey(*k)
}

/// The bare field name of a wire key — `Device.hostname` -> `hostname`. The
/// registry entry is `'static`, so the slice is too.
pub(crate) fn field_name(k: FieldKey) -> &'static str {
    let (n, _) = ir_types::FIELD_KEYS
        .iter()
        .find(|(_, v)| *v == k.0)
        .unwrap_or_else(|| panic!("key {} is not in the field registry", k.0));
    match n.split_once('.') {
        Some((_, field)) => field,
        None => n,
    }
}

/// `ms` since the Unix epoch -> `YYYY-MM-DD`, UTC. Howard Hinnant's
/// civil-from-days, in integer arithmetic only: no clock, no locale, no
/// floating point (invariant 9).
pub(crate) fn ymd(ms: u64) -> String {
    let days = (ms / 86_400_000) as i64;
    // Shift the era so that March 1st opens the year: leap day lands last.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!("{y:04}-{m:02}-{d:02}")
}

/// `hand · YYYY-MM-DD` — the origin word and the stored assertion date.
fn stamp(g: &Graph, prov: fathom_graph::ProvenanceId) -> String {
    let Some(rec) = g.provenance(prov) else {
        return UNKNOWN.to_owned();
    };
    let origin = match rec.origin {
        fathom_graph::Origin::Hand => "hand",
        fathom_graph::Origin::Parsed { .. } => "parsed",
    };
    format!("{origin} · {}", ymd(rec.asserted_at.0))
}

/// One field of one node, rendered: the value cell and the provenance cell
/// (WO-08 §4.3). `Unknown` is `—` / `unset`; `Absent` is `absent` /
/// `absent — asserted · hand · <date>`; `Set` is the table above.
pub(crate) fn field_cell(g: &Graph, id: NodeId, k: FieldKey) -> (String, String) {
    let element = ElementId::Node(id);
    let info = g
        .presence(element, k)
        .expect("a declared field of a live node");
    match info.presence {
        StoredPresence::Unknown => (UNKNOWN.to_owned(), "unset".to_owned()),
        StoredPresence::Absent => {
            let s = info.prov.map(|p| stamp(g, p)).unwrap_or_default();
            ("absent".to_owned(), format!("absent — asserted · {s}"))
        }
        StoredPresence::Set => {
            let node = g.node(id).expect("a live node");
            let s = info.prov.map(|p| stamp(g, p)).unwrap_or_default();
            (render_set(node, k), s)
        }
    }
}

/// The value half alone — the inventory's cells, which carry no provenance
/// column.
pub(crate) fn value_cell(g: &Graph, id: NodeId, k: FieldKey) -> String {
    field_cell(g, id, k).0
}

macro_rules! as_scalar {
    ($tid:expr, $bag:expr, $key:expr, $($t:ident),+ $(,)?) => {
        $(
            if $tid == TypeId::of::<scalar::$t>() {
                return typed::<scalar::$t, _>($bag, $key)
                    .map(Scalar::canonical)
                    .unwrap_or_default();
            }
        )+
    };
}

macro_rules! as_token {
    ($tid:expr, $bag:expr, $key:expr, $($t:ident),+ $(,)?) => {
        $(
            if $tid == TypeId::of::<ir_types::$t>() {
                return typed::<ir_types::$t, _>($bag, $key)
                    .map(|v| v.token().to_owned())
                    .unwrap_or_default();
            }
        )+
    };
}

macro_rules! as_decimal {
    ($tid:expr, $bag:expr, $key:expr, $($t:ty),+ $(,)?) => {
        $(
            if $tid == TypeId::of::<$t>() {
                return typed::<$t, _>($bag, $key)
                    .map(ToString::to_string)
                    .unwrap_or_default();
            }
        )+
    };
}

/// WO-08 §4.3's table, dispatched on the schema-declared slot type. The
/// fallback carries **no** rendering: a slot type outside the table is
/// unreachable over the demo estate (§7 trigger 5), and an invented string
/// here would be a value the schema never declared.
fn render_set<B: FieldBag + ?Sized>(bag: &B, k: FieldKey) -> String {
    let Some((tid, _)) = slot_type(k) else {
        return String::new();
    };

    as_scalar!(
        tid,
        bag,
        k,
        Asn,
        AuthMethod,
        Bandwidth,
        Clli,
        Date,
        DhGroup,
        EncryptionAlgorithm,
        Fqdn,
        Identifier,
        IkeVersion,
        InferenceRuleId,
        IntegrityAlgorithm,
        InterfaceAddress,
        InterfaceName,
        Ip4Addr,
        Ip6Addr,
        IpAddr,
        IpPrefix,
        IpProtocol,
        IpRange,
        Kilobytes,
        L4Port,
        LatLon,
        MacAddress,
        OsVersion,
        OspfAreaId,
        PlatformId,
        PortRange,
        RouteDistinguisher,
        RouteTarget,
        Seconds,
        Text,
        Timestamp,
        TzName,
        VlanId,
    );

    as_token!(
        tid,
        bag,
        k,
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

    as_decimal!(tid, bag, k, bool, u8, u16, u32, u64);

    if tid == TypeId::of::<value::PostalAddress>() {
        return typed::<value::PostalAddress, _>(bag, k)
            .map(postal_address)
            .unwrap_or_default();
    }
    if tid == TypeId::of::<value::NameConformance>() {
        return typed::<value::NameConformance, _>(bag, k)
            .map(name_conformance)
            .unwrap_or_default();
    }
    // `IkeGateway.peer` — the far end of a tunnel, which is the single most
    // load-bearing value on the page for the job this product exists to do.
    // Added 2026-08-10: it rendered as an empty cell for as long as an
    // `IkeGateway` had been reachable, because it fell to the arm below.
    if tid == TypeId::of::<value::PeerSpec>() {
        return typed::<value::PeerSpec, _>(bag, k)
            .map(|p| match p {
                value::PeerSpec::Address(a) => a.canonical(),
                // `IkeId` is a unit struct — `11` §6.7's shape is stated
                // nowhere the corpus reads, so there is nothing to render but
                // the fact that the peer is dynamic. Saying so beats blank.
                value::PeerSpec::Dynamic(_) => "dynamic".to_owned(),
            })
            .unwrap_or_default();
    }

    // A slot type with no arm above. This USED to be unreachable — the comment
    // on this function said so, and it was true over the demo estate. A pasted
    // config reaches it, and the failure mode is the worst kind: a real value,
    // present and provenanced, rendered as an empty cell that reads exactly
    // like a field nobody filled in.
    //
    // So it names itself instead. `UNRENDERED` is deliberately ugly: it is a
    // defect marker, it should be seen, and the fix is one arm above.
    UNRENDERED.to_owned()
}

/// What a value renders as when its slot type has no arm in the table above.
/// Never a blank, never an em dash — both of those are already the *answers* to
/// different questions (`—` is Unknown, `absent` is asserted-Absent), and a
/// missing renderer is neither.
pub(crate) const UNRENDERED: &str = "(no renderer)";

/// Every `Set` member in declaration order, joined `, ` — a member-wise rule
/// because the structured value types carry no `canonical()` yet (WO-08 §3.2).
pub(crate) fn postal_address(a: &value::PostalAddress) -> String {
    let mut parts: Vec<&str> = a.lines.iter().map(|l| l.0.as_str()).collect();
    for t in [&a.locality, &a.region, &a.postcode, &a.country]
        .into_iter()
        .flatten()
    {
        parts.push(t.0.as_str());
    }
    parts.join(", ")
}

/// `state.token()`, then ` — ` + the reason where one is carried.
fn name_conformance(v: &value::NameConformance) -> String {
    match &v.reason {
        None => v.state.token().to_owned(),
        Some(r) => format!("{} — {}", v.state.token(), r.0),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ymd_pins_the_civil_conversion() {
        assert_eq!(ymd(0), "1970-01-01");
        assert_eq!(ymd(951_782_400_000), "2000-02-29");
        assert_eq!(ymd(1_785_456_000_000), "2026-07-31");
    }

    #[test]
    fn postal_address_joins_set_members_in_order() {
        let a = value::PostalAddress {
            lines: vec![scalar::Text("101 Riverside Dr".to_owned())],
            locality: Some(scalar::Text("Riverside".to_owned())),
            region: None,
            postcode: None,
            country: None,
        };
        assert_eq!(postal_address(&a), "101 Riverside Dr, Riverside");
    }
}
