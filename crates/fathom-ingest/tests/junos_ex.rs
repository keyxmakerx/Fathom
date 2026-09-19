//! `corpus/dict/junos-ex/` — a synthetic Junos EX switching capture,
//! asserting what binds (VLANs, access/trunk ports, an aggregated Ethernet
//! member pair, an IRB routed VLAN interface, OSPF/BGP adjacencies) and
//! that every credential is gone from the stored (redacted) text (`14`'s
//! governing rule: "nothing secret is ever kept").
//!
//! CREDENTIAL LENGTHS, CLAUDE.md rule 2 ("test a safety gate against what a
//! real device accepts, not against what the detector needs") — every
//! length below is cited at the dictionary entry that destroys it
//! (`corpus/dict/junos-ex/system.yaml`, `corpus/dict/junos-ex/
//! protocols.yaml`):
//!   * root/login plain-text password: 6-128 chars documented; this capture
//!     uses 19.
//!   * root/login encrypted password: a real glibc `$6$` SHA-512 `crypt()`
//!     string (rounds + salt + 86-character hash), the same shape
//!     `crates/fathom-ingest/tests/edgeos.rs` already uses and cites.
//!   * SNMP community: no Junos-specific maximum could be established
//!     (system.yaml's header); this capture uses a representative,
//!     non-maximal, human-typed value.
//!   * OSPF `simple-password`: documented 1-8 chars; this capture uses
//!     exactly 8, the real maximum.
//!   * OSPF `md5` key: documented 1-16 chars; this capture uses exactly 16.
//!   * BGP `authentication-key`: documented up to 126 chars; this capture
//!     uses exactly 126.

use std::path::{Path, PathBuf};

use fathom_ingest::bind::{BoundValue, FragNode, FragNodeId, Fragment};
use fathom_ingest::dict::Dictionary;
use fathom_ir::generated::ir_types::NodeKind;
use fathom_ir::scalar;
use fathom_ir::scalar::Scalar;

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .nth(2)
        .expect("the crate lives two levels under the repo root")
        .to_path_buf()
}

fn run(paste: &str) -> fathom_ingest::IngestOutput {
    let dict =
        Dictionary::load_platform(&repo_root(), "junos-ex").expect("junos-ex dictionary loads");
    fathom_ingest::ingest(paste.as_bytes(), &dict).expect("within the caps")
}

fn nodes_of(f: &Fragment, kind: NodeKind) -> Vec<(FragNodeId, &FragNode)> {
    f.nodes
        .iter()
        .enumerate()
        .filter(|(_, n)| n.kind == kind)
        .map(|(i, n)| (FragNodeId(i as u32), n))
        .collect()
}

fn has(node: &FragNode, want: &BoundValue) -> bool {
    node.fields.iter().any(|f| &f.value == want)
}

/// The credential values, named once so the binding assertions and the
/// redaction assertions below cannot drift apart.
const ROOT_ENCRYPTED: &str = "$6$rounds=5000$saltEX01$odJFCrnl2edlBDdz1C5Jau2RJtBRnlWmTSHf6pWkLUyifDLkDmWJ6UuVTAIjvFu7WICPhDeOZIiBOB/Y6sHrFH";
const ROOT_PLAIN: &str = "CorrectHorseBatt22";
const LOGIN_PLAIN: &str = "Staff-Netadmin-Pass9";
const SNMP_COMMUNITY: &str = "R3adOnlyCommunity2026";
const OSPF_SIMPLE: &str = "S3cr3tPW"; // 8 chars, the documented maximum
const OSPF_MD5: &str = "MD5Sixteenchars1"; // 16 chars, the documented maximum
const BGP_KEY: &str = "Tr0ubador-BGP-MD5-Key-Tr0ubador-BGP-MD5-Key-Tr0ubador-BGP-MD5-Key-Tr0ubador-BGP-MD5-Key-Tr0ubador-BGP-MD5-Key-Tr0ubador-BGP-MD"; // 126 chars, the documented maximum

fn capture() -> String {
    format!(
        r#"set system host-name ex-access-01
set system root-authentication encrypted-password "{ROOT_ENCRYPTED}"
set system login user backupadm authentication plain-text-password "{ROOT_PLAIN}"
set system login user netadmin authentication plain-text-password "{LOGIN_PLAIN}"
set snmp community {SNMP_COMMUNITY} authorization read-only
set vlans staff vlan-id 10
set vlans guests vlan-id 20
set vlans guests description "Guest wifi VLAN"
set interfaces ge-0/0/1 description "Access port - staff"
set interfaces ge-0/0/1 unit 0 family ethernet-switching interface-mode access
set interfaces ge-0/0/1 unit 0 family ethernet-switching vlan members staff
set interfaces ge-0/0/2 description "Trunk to access point"
set interfaces ge-0/0/2 unit 0 family ethernet-switching interface-mode trunk
set interfaces ge-0/0/2 unit 0 family ethernet-switching vlan members staff
set interfaces ge-0/0/2 unit 0 family ethernet-switching vlan members guests
set interfaces ge-0/0/5 ether-options 802.3ad ae0
set interfaces ge-0/0/6 ether-options 802.3ad ae0
set interfaces ae0 aggregated-ether-options lacp active
set interfaces ae0 unit 0 family ethernet-switching interface-mode trunk
set interfaces ae0 unit 0 family ethernet-switching vlan members staff
set interfaces irb unit 10 description "Staff L3 gateway"
set interfaces irb unit 10 family inet address 10.0.10.1/24
set interfaces irb unit 20 family inet address 10.0.20.1/24
set virtual-chassis member 0 role routing-engine
set protocols ospf area 0.0.0.0 interface irb.10
set protocols ospf area 0.0.0.0 interface irb.10 authentication simple-password "{OSPF_SIMPLE}"
set protocols ospf area 0.0.0.0 interface irb.20 authentication md5 1 key "{OSPF_MD5}"
set protocols bgp group CORE neighbor 10.0.10.254 peer-as 65000
set protocols bgp group CORE neighbor 10.0.10.254 authentication-key {BGP_KEY}
"#
    )
}

#[test]
fn hostname_binds_to_device() {
    let out = run(&capture());
    let devices = nodes_of(&out.fragment, NodeKind::Device);
    assert_eq!(devices.len(), 1, "one Device node");
    let want = scalar::Identifier::parse("ex-access-01").expect("valid identifier");
    assert!(has(devices[0].1, &BoundValue::Identifier(want)));
}

#[test]
fn vlans_bind_with_ids_and_description() {
    let out = run(&capture());
    let vlans = nodes_of(&out.fragment, NodeKind::Vlan);
    assert_eq!(vlans.len(), 2, "staff and guests");
    assert!(vlans.iter().any(|(_, n)| has(
        n,
        &BoundValue::VlanId(scalar::VlanId::parse("10").expect("vlan id"))
    )));
    assert!(vlans.iter().any(|(_, n)| has(
        n,
        &BoundValue::Text(scalar::Text::parse("Guest wifi VLAN").expect("text"))
    )));
}

#[test]
fn vlan_membership_edges_bind_for_the_trunk_port() {
    let out = run(&capture());
    // ge-0/0/1.0 -> staff, ge-0/0/2.0 -> staff, ge-0/0/2.0 -> guests,
    // ae0.0 -> staff: four VlanMember edges, one of them off an aggregated
    // Ethernet unit — the same entry handles both physical and `ae`
    // interfaces via `@interface_like`.
    let members = out
        .fragment
        .edges
        .iter()
        .filter(|e| format!("{:?}", e.kind).contains("VlanMember"))
        .count();
    assert_eq!(
        members, 4,
        "three physical + one aggregated-Ethernet membership"
    );
}

/// `lacp active` is NOT bound (see `aggregated-and-irb.yaml`'s header: the
/// shared ingest engine's `ValueTy` allowlist does not carry `LacpMode`
/// yet) — this test proves the MEMBERSHIP half still binds correctly
/// regardless, since `ae0` is reached via the `MemberOfAggregate` edges'
/// `by_name` resolution, not via the (absent) lacp entry.
#[test]
fn aggregate_member_joins_ae0() {
    let out = run(&capture());
    let aggs = nodes_of(&out.fragment, NodeKind::AggregateInterface);
    assert_eq!(aggs.len(), 1, "one ae0, resolved by name from its members");
    let members = out
        .fragment
        .edges
        .iter()
        .filter(|e| format!("{:?}", e.kind).contains("MemberOfAggregate"))
        .count();
    assert_eq!(members, 2, "ge-0/0/5 and ge-0/0/6 both join ae0");
}

/// `form: irb` is NOT bound (same `ValueTy`/`InterfaceForm` gap the
/// aggregated-Ethernet test above notes) — this asserts the rest of the
/// `irb` unit/address binding is correct regardless.
#[test]
fn irb_units_bind_as_interface_and_carry_addresses() {
    let out = run(&capture());
    let addrs = nodes_of(&out.fragment, NodeKind::Address);
    assert!(addrs.iter().any(|(_, n)| has(
        n,
        &BoundValue::InterfaceAddress(
            scalar::InterfaceAddress::parse("10.0.10.1/24").expect("interface address")
        )
    )));
    assert!(addrs.iter().any(|(_, n)| has(
        n,
        &BoundValue::InterfaceAddress(
            scalar::InterfaceAddress::parse("10.0.20.1/24").expect("interface address")
        )
    )));
    // The literal "irb" name binds to an Interface node (not a numbered
    // physical port): irb.10 and irb.20 coalesce onto ONE Interface node named
    // "irb" (two LogicalUnits under it), not two.
    let ifaces = nodes_of(&out.fragment, NodeKind::Interface);
    let irb_named = ifaces
        .iter()
        .filter(|(_, n)| {
            has(
                n,
                &BoundValue::InterfaceName(
                    scalar::InterfaceName::parse("irb").expect("interface name"),
                ),
            )
        })
        .count();
    assert_eq!(
        irb_named, 1,
        "irb.10 and irb.20 are two units of one Interface"
    );
}

#[test]
fn ospf_and_bgp_adjacencies_bind() {
    let out = run(&capture());
    let adjacencies = nodes_of(&out.fragment, NodeKind::ProtocolAdjacency);
    // irb.10 (OSPF) and 10.0.10.254 (BGP neighbor).
    assert_eq!(adjacencies.len(), 2);
}

/// The floor this whole file exists to prove: not one plaintext credential
/// from the capture above survives into the stored (redacted) text.
#[test]
fn every_credential_is_gone_from_the_redacted_capture() {
    let out = run(&capture());
    let text = out.capture.text();

    assert!(!text.contains(ROOT_ENCRYPTED));
    assert!(!text.contains(ROOT_PLAIN));
    assert!(!text.contains(LOGIN_PLAIN));
    assert!(!text.contains(SNMP_COMMUNITY));
    assert!(!text.contains(OSPF_SIMPLE));
    assert!(!text.contains(OSPF_MD5));
    assert!(!text.contains(BGP_KEY));

    // The drop manifest recorded all seven destructions.
    assert!(
        out.drops.entries.len() >= 7,
        "expected at least 7 redactions, got {}: {:?}",
        out.drops.entries.len(),
        out.drops.entries
    );

    // What is NOT a credential survives untouched.
    assert!(text.contains("ex-access-01"));
    assert!(text.contains("Guest wifi VLAN"));
    assert!(text.contains("Access port - staff"));
    assert!(text.contains("Staff L3 gateway"));
}
