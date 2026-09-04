//! WO-10 — DHCP relay and BOOTP, at the fragment (2026-08-29).
//!
//! Five things are under test, and each is one of the order's gates or one of
//! the decisions taken to unblock it: G3 (a `helpers bootp server` line builds
//! a relay the device contains, address bound, not residue); G4 (a
//! `server-group` of three is three nodes sharing one `group_name`); the
//! owner's route (i) — a `routing-instance` qualifier writes `RelayServerIn`
//! and its ABSENCE writes nothing, because absent means the default instance
//! and never "unknown"; the `interface` form's `RelaysFor`, real when the unit
//! is declared and Pending when it is not; and WO-10 §11 item 4's decision
//! that the five undecided forms are NAMED residue rather than a guess.

use std::path::{Path, PathBuf};

use fathom_ingest::bind::{BoundValue, FragNodeId, PendingTarget};
use fathom_ingest::dict::Dictionary;
use fathom_ingest::frame::LineOutcome;
use fathom_ingest::{ingest, IngestOutput};
use fathom_ir::generated::ir_types::{EdgeKind, NodeKind};
use fathom_ir::scalar;

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .nth(2)
        .expect("the crate lives two levels under the repo root")
        .to_path_buf()
}

fn dict() -> Dictionary {
    Dictionary::load(&repo_root()).expect("the shipped dictionary loads")
}

fn run(text: &str) -> IngestOutput {
    ingest(text.as_bytes(), &dict()).expect("within the caps")
}

/// One field's value on a fragment node by its `Kind.field` wire name; a
/// schema field that moves fails here at compile time rather than asserting
/// nothing.
fn field<'a>(out: &'a IngestOutput, node: usize, name: &str) -> Option<&'a BoundValue> {
    let key = fathom_ir::generated::ir_types::FIELD_KEYS
        .iter()
        .find(|(n, _)| *n == name)
        .map(|(_, k)| fathom_ir::bag::FieldKey(*k))?;
    out.fragment
        .nodes
        .get(node)?
        .fields
        .iter()
        .find(|f| f.key == key)
        .map(|f| &f.value)
}

fn relays(out: &IngestOutput) -> Vec<usize> {
    out.fragment
        .nodes
        .iter()
        .enumerate()
        .filter(|(_, n)| n.kind == NodeKind::DhcpRelay)
        .map(|(i, _)| i)
        .collect()
}

fn residue_lines(out: &IngestOutput) -> Vec<String> {
    let text = out.capture.text();
    out.residue
        .iter()
        .filter(|r| matches!(r.outcome, LineOutcome::Unmapped { .. }))
        .map(|r| {
            text.get(r.span.start as usize..r.span.end as usize)
                .unwrap_or_default()
                .to_owned()
        })
        .collect()
}

fn server_of(out: &IngestOutput, node: usize) -> String {
    format!(
        "{:?}",
        field(out, node, "DhcpRelay.server").expect("server is bound")
    )
}

/// **G3.** The bootp server line builds ONE relay, owned by the implicit
/// Device (nodes[0]), with the address bound, and it is not on the residue
/// list.
#[test]
fn g3_a_bootp_server_line_builds_a_relay_the_device_contains() {
    let out = run("set forwarding-options helpers bootp server 172.16.0.3\n");
    let r = relays(&out);
    assert_eq!(r.len(), 1, "one relay: {:?}", out.fragment.nodes);
    let node = &out.fragment.nodes[r[0]];
    assert_eq!(out.fragment.nodes[0].kind, NodeKind::Device);
    assert_eq!(
        node.owner,
        Some(FragNodeId(0)),
        "HasDhcpRelay runs Device -> DhcpRelay, so the owner is the device"
    );
    assert!(
        server_of(&out, r[0]).contains("172.16.0.3"),
        "the address is bound: {:?}",
        node.fields
    );
    assert!(
        residue_lines(&out).is_empty(),
        "a fully modelled line is not residue: {:?}",
        residue_lines(&out)
    );
}

/// **G4.** A server-group of three addresses is three nodes sharing one
/// `group_name` — because the reasoning in WO-10 §1 asks "is there a route to
/// THIS address" one address at a time, and a single node with three servers
/// could not answer it.
#[test]
fn g4_a_server_group_of_three_is_three_relays_sharing_one_group_name() {
    let out = run(
        "set forwarding-options dhcp-relay server-group DHCP-GRP 10.0.0.5\n\
                   set forwarding-options dhcp-relay server-group DHCP-GRP 10.0.0.6\n\
                   set forwarding-options dhcp-relay server-group DHCP-GRP 10.0.0.7\n",
    );
    let r = relays(&out);
    assert_eq!(
        r.len(),
        3,
        "three addresses, three nodes: {:?}",
        out.fragment.nodes
    );
    let want = BoundValue::Identifier(scalar::Identifier("DHCP-GRP".to_owned()));
    for &i in &r {
        assert_eq!(
            field(&out, i, "DhcpRelay.group_name"),
            Some(&want),
            "every node names the group"
        );
        assert_eq!(out.fragment.nodes[i].owner, Some(FragNodeId(0)));
    }
    let mut servers: Vec<String> = r.iter().map(|&i| server_of(&out, i)).collect();
    servers.sort();
    servers.dedup();
    assert_eq!(
        servers.len(),
        3,
        "three DISTINCT servers, not one node upserted thrice"
    );
    assert!(residue_lines(&out).is_empty(), "{:?}", residue_lines(&out));
}

/// **The owner's route (i), both directions.** A qualified server line writes
/// `RelayServerIn` to the named instance — Pending today, because nothing yet
/// builds a `RoutingInstance` from a paste, and Pending is the honest state
/// rather than a silently dropped fact. An UNQUALIFIED line writes nothing:
/// absent means the default instance, and rendering it as unknown would
/// collapse 19 §6.3's three states.
#[test]
fn a_qualified_server_links_to_its_routing_instance_and_an_unqualified_one_does_not() {
    let out = run("set forwarding-options helpers bootp server 172.16.0.3 routing-instance c3\n");
    let r = relays(&out);
    assert_eq!(r.len(), 1, "{:?}", out.fragment.nodes);
    let pend: Vec<_> = out
        .fragment
        .pending
        .iter()
        .filter(|p| p.kind == EdgeKind::RelayServerIn)
        .collect();
    assert_eq!(
        pend.len(),
        1,
        "one Pending RelayServerIn: {:?}",
        out.fragment.pending
    );
    assert_eq!(pend[0].from, FragNodeId(r[0] as u32), "from the relay");
    match &pend[0].target {
        PendingTarget::ByName { kind, name } => {
            assert_eq!(*kind, NodeKind::RoutingInstance);
            assert_eq!(name, &scalar::Identifier("c3".to_owned()));
        }
        other => panic!("the target is the instance by name, got {other:?}"),
    }
    assert!(
        residue_lines(&out).is_empty(),
        "the qualified line is fully modelled now: {:?}",
        residue_lines(&out)
    );

    let bare = run("set forwarding-options helpers bootp server 172.16.0.3\n");
    assert!(
        !bare
            .fragment
            .pending
            .iter()
            .any(|p| p.kind == EdgeKind::RelayServerIn)
            && !bare
                .fragment
                .edges
                .iter()
                .any(|e| e.kind == EdgeKind::RelayServerIn),
        "no qualifier, no edge — absent is the default instance, not unknown: {:?}",
        bare.fragment.pending
    );
}

/// **The interface form.** `RelaysFor` is a real fragment edge when the unit
/// is declared in the same paste, and a Pending reference when it is not — the
/// `reth0.0` behaviour, never a dropped line.
#[test]
fn the_interface_form_relays_for_a_declared_unit_and_pends_for_an_undeclared_one() {
    let declared = run(
        "set interfaces ge-0/0/1 unit 0 family inet address 10.20.0.1/24\n\
         set forwarding-options helpers bootp interface ge-0/0/1.0 server 172.16.0.3\n",
    );
    let r = relays(&declared);
    assert_eq!(r.len(), 1, "{:?}", declared.fragment.nodes);
    let real: Vec<_> = declared
        .fragment
        .edges
        .iter()
        .filter(|e| e.kind == EdgeKind::RelaysFor)
        .collect();
    assert_eq!(
        real.len(),
        1,
        "one real RelaysFor: {:?}",
        declared.fragment.edges
    );
    assert_eq!(real[0].from, FragNodeId(r[0] as u32));
    assert_eq!(
        declared.fragment.nodes[real[0].to.0 as usize].kind,
        NodeKind::LogicalUnit,
        "it lands on the unit"
    );
    assert!(
        residue_lines(&declared).is_empty(),
        "{:?}",
        residue_lines(&declared)
    );

    let undeclared =
        run("set forwarding-options helpers bootp interface ge-0/0/1.0 server 172.16.0.3\n");
    assert_eq!(relays(&undeclared).len(), 1);
    assert!(
        undeclared
            .fragment
            .pending
            .iter()
            .any(|p| p.kind == EdgeKind::RelaysFor
                && matches!(p.target, PendingTarget::InterfaceUnit { .. })),
        "an undeclared unit is a Pending reference, not a dropped edge: {:?}",
        undeclared.fragment.pending
    );
}

/// The qualified INTERFACE form carries both edges at once.
#[test]
fn the_qualified_interface_form_carries_both_edges() {
    let out = run(
        "set forwarding-options helpers bootp interface ge-0/0/1.0 server 172.16.0.3 routing-instance c3\n",
    );
    assert_eq!(relays(&out).len(), 1);
    let kinds: Vec<EdgeKind> = out.fragment.pending.iter().map(|p| p.kind).collect();
    assert!(kinds.contains(&EdgeKind::RelaysFor), "{kinds:?}");
    assert!(kinds.contains(&EdgeKind::RelayServerIn), "{kinds:?}");
    assert!(residue_lines(&out).is_empty(), "{:?}", residue_lines(&out));
}

/// **WO-10 §11 item 4, by decision.** The five forms the one-line binder
/// cannot honestly express are NAMED residue — byte for byte, on the list the
/// operator reads — and build no relay at all. This is the assertion that
/// stops a future entry from half-reading them.
#[test]
fn the_five_undecided_forms_are_named_residue_and_build_nothing() {
    let lines = [
        "set forwarding-options dhcp-relay active-server-group DHCP-GRP",
        "set forwarding-options dhcp-relay group FLOOR-2 active-server-group DHCP-GRP",
        "set forwarding-options dhcp-relay group FLOOR-2 interface ge-0/0/2.0",
        "set forwarding-options helpers bootp maximum-hop-count 4",
        "set forwarding-options helpers bootp minimum-wait-time 2",
    ];
    let out = run(&(lines.join("\n") + "\n"));
    let residue = residue_lines(&out);
    for line in lines {
        assert!(
            residue.iter().any(|r| r == line),
            "expected on the residue list, byte-for-byte: {line}\nhave: {residue:?}"
        );
    }
    assert!(
        relays(&out).is_empty(),
        "none of these names a server address, so none may invent a relay: {:?}",
        out.fragment.nodes
    );
}
