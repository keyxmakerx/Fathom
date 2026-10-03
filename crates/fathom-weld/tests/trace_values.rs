//! Schema 0.17: the values a path trace reads, written through the weld.
//!
//! A zone pair, a static route's next hops and an address object's prefix are
//! bound in the fragment as fragment indices and become store ids here. This
//! file proves each one lands on the node it names, on the documented branch
//! fixture and not on a toy.

use std::path::{Path, PathBuf};

use fathom_graph::{Actor, BatchId, ElementId, Graph, Timestamp, UserId};
use fathom_id::Ulid;
use fathom_ingest::dict::Dictionary;
use fathom_ingest::ingest;
use fathom_ir::generated::accessors::{address_object, policy_set, static_route};
use fathom_ir::generated::ir_types::{EdgeKind, NodeKind};
use fathom_ir::scalar::{IpAddr, IpPrefix, PlatformId, Scalar};
use fathom_ir::value::{AddressValue, NextHop, PolicyScope};
use fathom_weld::{apply_new_device, Manifest};

const TS: u64 = 1_786_147_200_000;

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .nth(2)
        .expect("two levels under the repo root")
        .to_path_buf()
}

fn applied(text: &str) -> Graph {
    let dict = Dictionary::load(&repo_root()).expect("the shipped dictionary loads");
    let ingest = ingest(text.as_bytes(), &dict).expect("within the caps");
    let mut graph = Graph::new();
    let manifest = Manifest {
        at: Timestamp(TS),
        entropy: 0x2026,
        actor: Actor::User(UserId(Ulid::from_parts(TS, 1).expect("in range"))),
        batch: BatchId(Ulid::from_parts(TS, 2).expect("in range")),
        label: "path trace values",
        platform: PlatformId("junos-srx".to_owned()),
    };
    apply_new_device(&mut graph, &ingest, &manifest).expect("applies");
    graph
}

fn branch() -> Graph {
    let text = std::fs::read_to_string(
        repo_root().join("crates/fathom-ingest/tests/fixtures/junos-srx-branch-documented.txt"),
    )
    .expect("the branch fixture is checked in");
    applied(&text)
}

fn zone_name(graph: &Graph, r: fathom_id::NodeId) -> String {
    match graph.resolve_ref(r) {
        Some(ElementId::Node(n)) if n.kind == NodeKind::Zone => {
            let node = graph.node(n).expect("live");
            fathom_ir::generated::accessors::zone::name(node)
                .expect("a zone has its name")
                .0
                .clone()
        }
        other => panic!("a scope must name a zone of this design, got {other:?}"),
    }
}

#[test]
fn every_policy_set_names_two_zones_of_the_design() {
    let graph = branch();
    let mut pairs = Vec::new();
    for node in graph.nodes_of_kind(NodeKind::PolicySet) {
        match policy_set::scope(node).expect("a scope is stored") {
            PolicyScope::ZonePair { from, to } => {
                pairs.push((zone_name(&graph, *from), zone_name(&graph, *to)))
            }
            other => panic!("a Junos set is a zone pair: {other:?}"),
        }
    }
    pairs.sort();
    assert_eq!(
        pairs,
        vec![
            ("guests".to_owned(), "untrust".to_owned()),
            ("trust".to_owned(), "contractors".to_owned()),
            ("trust".to_owned(), "untrust".to_owned()),
            ("trust".to_owned(), "vpn".to_owned()),
        ]
    );
}

#[test]
fn static_routes_carry_their_next_hops() {
    let graph = branch();
    let mut seen = Vec::new();
    for node in graph.nodes_of_kind(NodeKind::StaticRoute) {
        let dest = static_route::destination(node)
            .expect("destination")
            .canonical();
        let hops = static_route::next_hop(node).expect("a next hop").clone();
        seen.push((dest, hops));
    }
    seen.sort_by(|a, b| a.0.cmp(&b.0));
    assert_eq!(seen.len(), 3);
    let (d0, h0) = &seen[0];
    assert_eq!(d0, "0.0.0.0/0");
    assert_eq!(
        h0,
        &vec![NextHop::Address(
            IpAddr::parse("172.16.1.1").expect("parses")
        )]
    );
    let (d1, h1) = &seen[1];
    assert_eq!(d1, "172.16.200.0/24");
    // `next-hop st0.0`: a unit of the paste, by id.
    match h1.as_slice() {
        [NextHop::Interface(unit)] => match graph.resolve_ref(*unit) {
            Some(ElementId::Node(n)) => assert_eq!(n.kind, NodeKind::LogicalUnit),
            other => panic!("the hop must name a live unit: {other:?}"),
        },
        other => panic!("expected one interface hop, got {other:?}"),
    }
    let (d2, h2) = &seen[2];
    assert_eq!(d2, "198.51.100.0/24");
    assert_eq!(h2, &vec![NextHop::Discard]);
    // The routes hang off the one default instance.
    assert_eq!(graph.nodes_of_kind(NodeKind::RoutingInstance).count(), 1);
}

#[test]
fn address_objects_keep_their_prefix_and_policies_reach_them_by_edge() {
    let graph = branch();
    let mut by_name = Vec::new();
    for node in graph.nodes_of_kind(NodeKind::AddressObject) {
        let name = address_object::name(node).expect("name").0.clone();
        let value = address_object::value(node).expect("value").clone();
        by_name.push((name, value));
    }
    by_name.sort_by(|a, b| a.0.cmp(&b.0));
    assert_eq!(by_name.len(), 3);
    assert_eq!(by_name[0].0, "branch-lan");
    assert_eq!(
        by_name[0].1,
        AddressValue::Prefix(IpPrefix::parse("192.168.2.0/24").expect("parses"))
    );
    // The set contains two of them.
    assert_eq!(graph.edges_of_kind(EdgeKind::Contains).count(), 2);
}

#[test]
fn a_hop_to_a_unit_the_paste_never_defines_is_not_written() {
    let graph = applied("set routing-options static route 10.2.0.0/16 next-hop st9.0\n");
    let route = graph
        .nodes_of_kind(NodeKind::StaticRoute)
        .next()
        .expect("the route exists");
    assert!(
        static_route::next_hop(route).is_err(),
        "a route to a unit nobody said exists is a guess, so no hop is stored"
    );
}

#[test]
fn a_redacted_zone_name_binds_no_scope() {
    // A policy whose zone capture the gate redacts must not bind a pair.
    let graph = applied(
        "set security policies from-zone $9$EXAMPLEnotARealKey01234 to-zone untrust policy p then permit\n",
    );
    assert_eq!(graph.nodes_of_kind(NodeKind::PolicySet).count(), 0);
}
