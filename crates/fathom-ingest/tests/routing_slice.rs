//! The routing slice: `set protocols ospf …`, `set protocols bgp …` and
//! `set routing-options router-id …` become `RoutingProtocol` and
//! `ProtocolAdjacency` nodes (2026-08-15).
//!
//! `RoutingProtocol` and `ProtocolAdjacency` had inventory rows and a place in
//! the diagram's layer model from 2026-08-11 and nothing built them, because
//! the dictionary had no entry under `protocols`. These tests are the floor
//! under the claim that it now does: they assert on the *fragment*, which is
//! what the store weld consumes, so a regression shows up here before it shows
//! up as an empty table.
//!
//! Everything asserted below is a statement form read off Juniper's own
//! documentation on 2026-08-15 — the URLs are in
//! `corpus/dict/junos-srx/protocols-ospf.yaml` and `protocols-bgp.yaml`
//! beside the entries (ADR-0034).

use std::path::{Path, PathBuf};

use fathom_ingest::bind::{BoundValue, FragNode, FragNodeId, Fragment};
use fathom_ingest::dict::Dictionary;
use fathom_ingest::frame::LineOutcome;
use fathom_ingest::{ingest, IngestOutput};
use fathom_ir::generated::ir_types::{
    NodeKind, ProtocolAdjacencyNetworkType, RoutingProtocolProtocol,
};
use fathom_ir::scalar;

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .nth(2)
        .expect("the crate lives two levels under the repo root")
        .to_path_buf()
}

fn run(paste: &str) -> IngestOutput {
    let dict = Dictionary::load(&repo_root()).expect("the shipped dictionary loads");
    ingest(paste.as_bytes(), &dict).expect("within the caps")
}

fn nodes_of(f: &Fragment, kind: NodeKind) -> Vec<(FragNodeId, &FragNode)> {
    f.nodes
        .iter()
        .enumerate()
        .filter(|(_, n)| n.kind == kind)
        .map(|(i, n)| (FragNodeId(i as u32), n))
        .collect()
}

/// Does this node carry this exact value in some field? The field key is not
/// asserted directly because it comes from the registry, and the registry is
/// the thing the dictionary loader already proves it can read.
fn has(node: &FragNode, want: &BoundValue) -> bool {
    node.fields.iter().any(|f| &f.value == want)
}

/// A branch SRX with both protocols on it, in the set form `show configuration
/// | display set` produces. Deliberately includes the group-level `peer-as`
/// and the global `autonomous-system`, both of which are documented and
/// neither of which binds — see `protocols-bgp.yaml`'s header.
const BRANCH: &str = "\
set system host-name srx-branch-01
set routing-options router-id 10.0.0.1
set routing-options autonomous-system 65001
set protocols ospf reference-bandwidth 100000000000
set protocols ospf area 0.0.0.0 interface ge-0/0/0.0
set protocols ospf area 0.0.0.0 interface ge-0/0/0.0 metric 100
set protocols ospf area 0.0.0.0 interface ge-0/0/1.0 passive
set protocols ospf area 0.0.0.1 interface st0.0 interface-type p2p
set protocols bgp local-as 65001
set protocols bgp group ISP-EDGE type external
set protocols bgp group ISP-EDGE peer-as 64512
set protocols bgp group ISP-EDGE neighbor 203.0.113.1
set protocols bgp group ISP-EDGE neighbor 203.0.113.1 peer-as 64512
";

// ---------------------------------------------------------------------------
// The shape: one instance, two protocols, the right number of neighbours
// ---------------------------------------------------------------------------

/// The containment chain the schema forces. `HasRoutingProtocol` runs from
/// `RoutingInstance` and NOT from `Device`, so without the instance hop the
/// weld would refuse the whole paste with `NoContainmentEdge` — this is the
/// test that would have caught that before a browser did.
#[test]
fn one_default_routing_instance_owns_both_protocols() {
    let out = run(BRANCH);
    let instances = nodes_of(&out.fragment, NodeKind::RoutingInstance);
    assert_eq!(
        instances.len(),
        1,
        "every routing statement here is in the default instance, so there is one"
    );
    let (instance_id, instance) = instances[0];
    assert_eq!(
        instance.owner, None,
        "the weld derives Device as its parent"
    );
    assert!(
        has(
            instance,
            &BoundValue::Ip4Addr(scalar::Ip4Addr("10.0.0.1".parse().expect("a dotted quad")))
        ),
        "`set routing-options router-id` binds on the instance, where Junos puts it"
    );

    let protocols = nodes_of(&out.fragment, NodeKind::RoutingProtocol);
    assert_eq!(protocols.len(), 2, "ospf and bgp, not one merged node");
    for (_, p) in &protocols {
        assert_eq!(p.owner, Some(instance_id));
    }
}

/// The capture that keeps them apart. `protocol` is card 1, so a single
/// RoutingProtocol node asserted twice would be a conflict diagnostic and a
/// lost value; keying on the captured protocol word is what prevents it.
#[test]
fn ospf_and_bgp_are_two_nodes_each_stating_its_own_protocol() {
    let out = run(BRANCH);
    let protocols = nodes_of(&out.fragment, NodeKind::RoutingProtocol);
    assert!(
        protocols.iter().any(|(_, p)| has(
            p,
            &BoundValue::RoutingProtocolProtocol(RoutingProtocolProtocol::Ospf)
        )),
        "the ospf statements made an ospf RoutingProtocol"
    );
    assert!(
        protocols.iter().any(|(_, p)| has(
            p,
            &BoundValue::RoutingProtocolProtocol(RoutingProtocolProtocol::Bgp)
        )),
        "the bgp statements made a bgp RoutingProtocol"
    );
}

/// Junos spells OSPFv3 `ospf3`; the schema spells it `ospf_v3`. The token map
/// is the join, and a third node is the proof that `ospf` and `ospf3` are not
/// silently the same protocol instance.
#[test]
fn ospf3_maps_to_the_schemas_ospf_v3_and_is_its_own_node() {
    let out = run("set protocols ospf area 0.0.0.0 interface ge-0/0/0.0\n\
                   set protocols ospf3 area 0.0.0.0 interface ge-0/0/0.0\n");
    let protocols = nodes_of(&out.fragment, NodeKind::RoutingProtocol);
    assert_eq!(protocols.len(), 2);
    assert!(protocols.iter().any(|(_, p)| has(
        p,
        &BoundValue::RoutingProtocolProtocol(RoutingProtocolProtocol::OspfV3)
    )));
}

// ---------------------------------------------------------------------------
// OSPF
// ---------------------------------------------------------------------------

/// Junos `display set` collapses a container that has children into the
/// children's full paths: a config whose only statement about an interface is
/// `metric 100` emits ONE line and no bare `interface` line. So every OSPF
/// entry re-binds `area` from its own path — this is the test of that, and it
/// is the difference between a populated area column and an empty one on the
/// most common shape of config there is.
#[test]
fn the_area_binds_from_a_deeper_statement_with_no_bare_interface_line() {
    let out = run("set protocols ospf area 0.0.0.7 interface ge-0/0/5.0 metric 42\n");
    let adjacencies = nodes_of(&out.fragment, NodeKind::ProtocolAdjacency);
    assert_eq!(adjacencies.len(), 1);
    let (_, adj) = adjacencies[0];
    assert!(
        has(adj, &BoundValue::OspfAreaId(scalar::OspfAreaId(7))),
        "area 0.0.0.7 is 7 as a 32-bit value"
    );
    assert!(has(adj, &BoundValue::U32(42)), "the metric is the cost");
}

/// Two statements about one interface make one adjacency, not two rows.
#[test]
fn one_ospf_interface_is_one_adjacency_however_many_statements() {
    let out = run(BRANCH);
    let adjacencies = nodes_of(&out.fragment, NodeKind::ProtocolAdjacency);
    // ge-0/0/0.0 (two statements), ge-0/0/1.0, st0.0, and the BGP neighbour.
    assert_eq!(
        adjacencies.len(),
        4,
        "three OSPF interfaces and one BGP peer"
    );
}

/// A Junos flag statement — the whole content is its own presence, so there is
/// nothing to capture and the entry states the value.
#[test]
fn passive_is_a_flag_statement_and_binds_true() {
    let out = run("set protocols ospf area 0.0.0.0 interface ge-0/0/1.0 passive\n");
    let adjacencies = nodes_of(&out.fragment, NodeKind::ProtocolAdjacency);
    assert_eq!(adjacencies.len(), 1);
    assert!(has(adjacencies[0].1, &BoundValue::Bool(true)));
}

/// `p2p` is the vendor's spelling of the schema's `point_to_point`.
#[test]
fn interface_type_p2p_maps_to_point_to_point() {
    let out = run("set protocols ospf area 0.0.0.1 interface st0.0 interface-type p2p\n");
    let adjacencies = nodes_of(&out.fragment, NodeKind::ProtocolAdjacency);
    assert!(has(
        adjacencies[0].1,
        &BoundValue::ProtocolAdjacencyNetworkType(ProtocolAdjacencyNetworkType::PointToPoint)
    ));
}

/// `p2mp-over-lan` is a real, documented Junos interface-type with no
/// counterpart in `schema/schema.yaml`. Refusing it is the rule the rest of
/// the binder already follows: never store a vendor token the schema does not
/// declare, because a stored `Unknown` is a typo persisted with `Asserted`
/// confidence.
#[test]
fn an_interface_type_the_schema_does_not_declare_is_refused_not_stored() {
    let out =
        run("set protocols ospf area 0.0.0.0 interface ge-0/0/0.0 interface-type p2mp-over-lan\n");
    let adjacencies = nodes_of(&out.fragment, NodeKind::ProtocolAdjacency);
    assert_eq!(
        adjacencies.len(),
        1,
        "the adjacency and its area still bind"
    );
    assert!(
        !adjacencies[0]
            .1
            .fields
            .iter()
            .any(|f| matches!(f.value, BoundValue::ProtocolAdjacencyNetworkType(_))),
        "no network type was stored"
    );
}

/// Junos documents `reference-bandwidth` in bits per second, which is exactly
/// the schema's `Bandwidth` unit — no conversion anywhere, which is the only
/// way a number survives a round trip.
#[test]
fn reference_bandwidth_is_bits_per_second_unconverted() {
    let out = run("set protocols ospf reference-bandwidth 100000000000\n");
    let protocols = nodes_of(&out.fragment, NodeKind::RoutingProtocol);
    assert!(has(
        protocols[0].1,
        &BoundValue::Bandwidth(scalar::Bandwidth(100_000_000_000))
    ));
}

// ---------------------------------------------------------------------------
// BGP
// ---------------------------------------------------------------------------

#[test]
fn a_bgp_neighbour_binds_its_address_and_its_peer_as() {
    let out = run(BRANCH);
    let adjacencies = nodes_of(&out.fragment, NodeKind::ProtocolAdjacency);
    let peer = adjacencies
        .iter()
        .find(|(_, a)| {
            has(
                a,
                &BoundValue::IpAddr(scalar::IpAddr("203.0.113.1".parse().expect("an address"))),
            )
        })
        .expect("the neighbour bound its address");
    assert!(
        has(peer.1, &BoundValue::Asn(scalar::Asn(64512))),
        "the neighbour-level peer-as bound"
    );
}

#[test]
fn the_bgp_instance_local_as_binds_on_the_protocol() {
    let out = run(BRANCH);
    let protocols = nodes_of(&out.fragment, NodeKind::RoutingProtocol);
    assert!(
        protocols
            .iter()
            .any(|(_, p)| has(p, &BoundValue::Asn(scalar::Asn(65001)))),
        "`set protocols bgp local-as` is the protocol-instance AS"
    );
}

/// The honest half, pinned so nobody later mistakes it for an oversight. A
/// Junos BGP *group* is not a kind in `schema/schema.yaml`, so a group-level
/// `peer-as` is a fact about every neighbour in the group with nowhere correct
/// to live; propagating it would take a pass the per-statement binder does not
/// have. It stays visible as residue. `protocols-bgp.yaml`'s header carries the
/// reasoning and this test carries the consequence.
#[test]
fn a_group_level_peer_as_is_residue_and_not_guessed_onto_a_neighbour() {
    let out = run("set protocols bgp group ISP-EDGE peer-as 64512\n");
    assert!(
        nodes_of(&out.fragment, NodeKind::ProtocolAdjacency).is_empty(),
        "no neighbour was invented from a group statement"
    );
    assert!(
        matches!(
            out.ledger.lines[0].outcome,
            LineOutcome::Unmapped { .. } | LineOutcome::Unshaped { .. }
        ),
        "the line is named as not understood, not silently dropped: {:?}",
        out.ledger.lines[0].outcome
    );
}

/// Likewise `set routing-options autonomous-system`. `RoutingInstance` has no
/// AS field and routing it to `RoutingProtocol.local_as` would mean asserting
/// `protocol: bgp` from a statement that never says BGP.
#[test]
fn the_global_autonomous_system_is_residue_and_never_invents_a_bgp_instance() {
    let out = run("set routing-options autonomous-system 65001\n");
    assert!(nodes_of(&out.fragment, NodeKind::RoutingProtocol).is_empty());
}

// ---------------------------------------------------------------------------
// Invariant 3 — the BGP credential
// ---------------------------------------------------------------------------

/// `authentication-key` is BGP's TCP-MD5 key and it is a device credential.
/// Both documented levels are catalogued as `secret:` entries, which is
/// `14` §9.1's rule that the dictionary IS the redaction catalogue.
#[test]
fn a_bgp_authentication_key_never_reaches_the_fragment() {
    for line in [
        "set protocols bgp group ISP-EDGE authentication-key Tr0ub4dor\n",
        "set protocols bgp group ISP-EDGE neighbor 203.0.113.1 authentication-key Tr0ub4dor\n",
    ] {
        let out = run(line);
        assert!(
            !out.capture.text().contains("Tr0ub4dor"),
            "the key survived in the stored capture: {line}"
        );
        for node in &out.fragment.nodes {
            for field in &node.fields {
                assert!(
                    !format!("{:?}", field.value).contains("Tr0ub4dor"),
                    "the key reached a field: {line}"
                );
            }
        }
    }
}

/// The regression this slice would have introduced without the fix in
/// `redact.rs`. Before it, a token PAST the end of the matched entry's path
/// was judged by walking back through the ENTRY's path rather than the
/// statement's, so `… neighbor 203.0.113.1 authentication-key <key>` matched
/// the six-segment `neighbor $n` entry, the walk looked back over `neighbor`
/// and `group`, and the key was declared clean. This asserts the general case
/// — an undocumented trailing statement the dictionary catalogues nowhere —
/// so the guard survives even if the two `secret:` entries above are ever
/// removed.
///
/// `shared-secret` rather than `authentication-key` on purpose: it is in
/// `SECRET_WORD_LIST`, it is under a path the dictionary matches, and no
/// `secret:` entry catalogues it — so the only thing that can destroy the value
/// is the leaf-name walk, judged against the statement. Reverting `redact.rs`'s
/// `at < e.path.len()` arm makes this test fail and the two above still pass,
/// which is the whole point of writing it separately.
#[test]
fn a_secret_in_tokens_past_a_matched_entrys_path_is_still_destroyed() {
    let out = run("set protocols bgp group G neighbor 203.0.113.1 shared-secret Hunter2\n");
    assert!(
        !out.capture.text().contains("Hunter2"),
        "a trailing secret survived: {}",
        out.capture.text()
    );
}

// ---------------------------------------------------------------------------
// `where:` — the capture that claimed statements it was never written for
// ---------------------------------------------------------------------------

/// Junos RIP must not mint a BGP peer.
///
/// `[protocols, $proto, group, $g, neighbor, $n]` was written for BGP, and a
/// free `$proto` claimed every protocol word in that position. Junos RIP uses
/// the identical shape — `neighbor neighbor-name { … }` at
/// `[edit protocols rip group group-name ]`, and the page's Options read
/// "neighbor-name —Name of an interface over which a routing device
/// communicates to its neighbors":
/// https://www.juniper.net/documentation/us/en/software/junos/cli-reference/topics/ref/statement/neighbor-edit-protocols-rip.html
/// read 2026-08-15. `rip` is a member of the schema's `RoutingProtocol.protocol`
/// enum, so it bound.
///
/// One legal RIP line therefore produced a `rip` `RoutingProtocol` AND a
/// `ProtocolAdjacency` with no fields at all — the interface name is correctly
/// refused as an `IpAddr`, so nothing landed on it. A peer that does not exist,
/// in the register the product asks to be trusted. The estate of record is the
/// product; a phantom row in it is worse than a missing one, because a missing
/// row is visible on the residue list and a phantom row is not.
///
/// The line must now be residue. Not bound-and-empty: residue, which is where
/// a statement Fathom does not model belongs.
#[test]
fn a_rip_neighbor_line_does_not_mint_a_bgp_peer() {
    let out = run("set protocols rip group RIP-GRP neighbor ge-0/0/9.0\n");
    assert!(
        !out.fragment
            .nodes
            .iter()
            .any(|n| n.kind == NodeKind::ProtocolAdjacency),
        "a RIP line built a ProtocolAdjacency: {:?}",
        out.fragment.nodes
    );
    assert!(
        !out.fragment
            .nodes
            .iter()
            .any(|n| n.kind == NodeKind::RoutingProtocol),
        "a RIP line built a RoutingProtocol: {:?}",
        out.fragment.nodes
    );
    assert!(
        matches!(out.ledger.lines[0].outcome, LineOutcome::Unmapped { .. }),
        "the RIP line should be residue, got {:?}",
        out.ledger.lines[0].outcome
    );
}

/// The two smaller over-matches, same mechanism: a statement that is not legal
/// Junos bound a field because the capture did not care which protocol it was
/// under. `local-as` is documented at `[edit protocols bgp]` and `[edit
/// protocols bgp group …]`; `reference-bandwidth` at
/// `[edit protocols ( ospf | ospf3 )]`. Neither belongs to the other protocol.
#[test]
fn a_statement_under_the_wrong_protocol_binds_nothing() {
    for paste in [
        "set protocols ospf local-as 65001\n",
        "set protocols bgp reference-bandwidth 100000000\n",
    ] {
        let out = run(paste);
        assert!(
            out.fragment.nodes.iter().all(|n| n.fields.is_empty()),
            "{paste:?} asserted a field it has no documented right to: {:?}",
            out.fragment.nodes
        );
        assert!(
            matches!(out.ledger.lines[0].outcome, LineOutcome::Unmapped { .. }),
            "{paste:?} should be residue, got {:?}",
            out.ledger.lines[0].outcome
        );
    }
}

/// `where:` narrows what an entry claims; it must not narrow what the gate
/// destroys. A statement that fails a `where:` matches no entry, which means
/// the gate treats every token past the known prefix as an argument and runs
/// the raw secret-word walk over the physical line — strictly more destruction
/// than a match, never less.
#[test]
fn a_where_rejected_statement_is_still_gated() {
    let out =
        run("set protocols rip group G neighbor ge-0/0/9.0 authentication-key Tr0ub4dorRIP\n");
    assert!(
        !format!("{out:?}").contains("Tr0ub4dorRIP"),
        "narrowing a capture let a credential through: {out:?}"
    );
}

/// Both protocols the OSPF entries are written for still bind. `ospf3` is the
/// reason `where:` lists two tokens rather than one, and it is also the reason
/// `$proto` stays a capture instead of becoming a path literal: `key: "$proto"`
/// is what keeps OSPFv2 and OSPFv3 on separate `RoutingProtocol` nodes.
#[test]
fn where_admits_every_token_it_lists() {
    let out = run("set protocols ospf area 0.0.0.0 interface ge-0/0/0.0\n\
         set protocols ospf3 area 0.0.0.1 interface ge-0/0/1.0\n");
    let protocols: Vec<&RoutingProtocolProtocol> = out
        .fragment
        .nodes
        .iter()
        .filter(|n| n.kind == NodeKind::RoutingProtocol)
        .flat_map(|n| n.fields.iter())
        .filter_map(|f| match &f.value {
            BoundValue::RoutingProtocolProtocol(p) => Some(p),
            _ => None,
        })
        .collect();
    assert!(
        protocols.contains(&&RoutingProtocolProtocol::Ospf),
        "ospf did not bind: {protocols:?}"
    );
    assert!(
        protocols.contains(&&RoutingProtocolProtocol::OspfV3),
        "ospf3 did not bind: {protocols:?}"
    );
}
