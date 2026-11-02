//! `corpus/dict/eos/` through `crates/fathom-ingest/src/blockcfg.rs`'s `EOS`
//! dialect: an Arista `show running-config` in, interfaces, VLANs, SVIs,
//! Port-Channels, trunks, VRFs and static routes out, and no credential
//! anywhere in what comes back.
//!
//! The body is cut from a real EOS config, one Arista's AVD generated for its
//! own example fabric (github.com/aristanetworks/avd, `examples/single-dc-l3ls/
//! intended/configs/dc1-leaf1a.cfg`, read 2026-11-02), with its hash and its
//! type-7 BGP passwords replaced by the short credentials below. CLAUDE.md
//! rule 2: every credential is short, the length a person types, because a
//! keyword and not a value's shape is what must catch it. Arista's own maximum
//! lengths could not be established (`tests/arista_eos.rs`, 2026-09-19).

use std::path::{Path, PathBuf};

use fathom_ingest::blockcfg::{ingest_eos, looks_like_eos, looks_like_tplink, looks_like_unifi};
use fathom_ingest::dict::Dictionary;
use fathom_ingest::frame::LineOutcome;
use fathom_ingest::IngestOutput;
use fathom_ir::generated::ir_types::{EdgeKind, NodeKind};

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .nth(2)
        .expect("the crate lives two levels under the repo root")
        .to_path_buf()
}

fn read(paste: &str) -> IngestOutput {
    let dict = Dictionary::load_platform(&repo_root(), "eos").expect("the eos dictionary loads");
    ingest_eos(paste.as_bytes(), &dict).expect("within the caps")
}

const CONFIG: &str = "!
no aaa root
!
username admin privilege 15 role network-admin secret 0 Adm1nPass9
username c privilege 1 secret 0 z
enable secret 0 EnaB1e9
aaa root secret 0 R00tPw1
!
vlan internal order ascending range 1006 1199
!
hostname dc1-leaf1a
!
spanning-tree mode mstp
!
vlan 11
   name VRF10_VLAN11
!
vlan 12
   name VRF10_VLAN12
!
vlan 21
!
vlan 4094
   name MLAG
   trunk group MLAG
!
vrf instance MGMT
!
vrf instance VRF10
!
interface Port-Channel5
   description SERVER_dc1-leaf1-server1_Bond1
   no shutdown
   switchport trunk native vlan 4092
   switchport trunk allowed vlan 11-12,21
   switchport mode trunk
   switchport
   mlag 5
!
interface Ethernet1
   description P2P dc1-spine1 Ethernet1
   no shutdown
   mtu 9214
   no switchport
   ip address 10.255.255.1/31
   isis authentication key 0 IsK1
!
interface Ethernet5
   description SERVER_dc1-leaf1-server1_PCI1
   no shutdown
   channel-group 5 mode active
!
interface Ethernet6
   description printer
   shutdown
   switchport access vlan 12
!
interface Ethernet7
   switchport trunk allowed vlan 1-4094
!
interface Management1
   description OOB_MANAGEMENT
   no shutdown
   vrf MGMT
   ip address 172.16.1.101/24
!
interface Vlan11
   description VRF10_VLAN11
   no shutdown
   vrf VRF10
   ip address virtual 10.10.11.1/24
   ip ospf message-digest-key 1 md5 0 OsMd51
   ip ospf authentication-key 0 OsAk1
!
interface Vlan21
   ip address 10.10.21.1/24
   vrrp 1 peer authentication text VrTxt1
!
ip routing
!
ip route 0.0.0.0/0 10.255.255.0
ip route 10.99.0.0/16 Null0
ip route vrf MGMT 0.0.0.0/0 172.16.1.1
!
ntp authentication-key 1 md5 0 NtpK3y
snmp-server community c RO
snmp-server community Rc0mm RW
snmp-server user ops grp1 v3 auth sha Au7hPw1 priv aes Pr1vPw1
tacacs-server host 192.0.2.100 key 7 Tk3y1
radius-server host 192.0.2.101 key 0 Rk3y1
!
key chain OSPF-AUTH
   key 1
      key-string 0 KcStr1
!
router bgp 65101
   router-id 10.255.0.3
   neighbor 10.255.255.0 remote-as 65100
   neighbor 10.255.255.0 password 0 BgpPw1
   !
   vlan 11
      rd 10.255.0.3:10011
      route-target both 10011:10011
   !
   vrf VRF10
      rd 10.255.0.3:10
!
end
";

const SECRETS: [&str; 16] = [
    "Adm1nPass9",
    "EnaB1e9",
    "R00tPw1",
    "IsK1",
    "OsMd51",
    "OsAk1",
    "VrTxt1",
    "NtpK3y",
    "Rc0mm",
    "Au7hPw1",
    "Pr1vPw1",
    "Tk3y1",
    "Rk3y1",
    "KcStr1",
    "BgpPw1",
    // The SNMP algorithm names go with the credential after `auth`.
    "sha Au7",
];

fn names(out: &IngestOutput, kind: NodeKind) -> Vec<String> {
    out.fragment
        .nodes
        .iter()
        .filter(|n| n.kind == kind)
        .map(|n| format!("{:?}", n.fields))
        .collect()
}

fn index_of(out: &IngestOutput, kind: NodeKind, has: &str) -> u32 {
    out.fragment
        .nodes
        .iter()
        .position(|n| n.kind == kind && format!("{:?}", n.fields).contains(has))
        .unwrap_or_else(|| panic!("no {kind:?} with {has}")) as u32
}

fn edge(out: &IngestOutput, kind: EdgeKind, from: u32, to: u32) -> bool {
    out.fragment
        .edges
        .iter()
        .any(|e| e.kind == kind && e.from.0 == from && e.to.0 == to)
}

/// The unit an interface owns, by the interface's index.
fn unit_of(out: &IngestOutput, iface: u32) -> u32 {
    out.fragment
        .nodes
        .iter()
        .position(|n| n.kind == NodeKind::LogicalUnit && n.owner.map(|o| o.0) == Some(iface))
        .unwrap_or_else(|| panic!("node {iface} has no unit")) as u32
}

#[test]
fn the_sniff_takes_eos_and_nothing_else() {
    assert!(looks_like_eos(CONFIG.as_bytes()));
    assert!(!looks_like_tplink(CONFIG.as_bytes()));
    assert!(!looks_like_unifi(CONFIG.as_bytes()));
    // Cisco IOS: `Port-channel` with a small c, slashed ports, a `version` line.
    let ios = "version 15.2\n!\nhostname r1\n!\ninterface Port-channel1\n!\ninterface GigabitEthernet0/1\n channel-group 1 mode active\n!\nend\n";
    assert!(!looks_like_eos(ios.as_bytes()));
    // NX-OS: `Ethernet1/1` and `port-channel1`, `mgmt0`, and a `version` line.
    let nxos = "!Command: show running-config\nversion 9.3(8)\nhostname n1\ninterface port-channel1\ninterface Ethernet1/1\ninterface mgmt0\n";
    assert!(!looks_like_eos(nxos.as_bytes()));
    // An EOS config with a `version` line is refused too: the rule is exact.
    let mut with_version = String::from("version 4.30\n");
    with_version.push_str(CONFIG);
    assert!(!looks_like_eos(with_version.as_bytes()));
}

#[test]
fn every_credential_is_destroyed() {
    let out = read(CONFIG);
    let text = out.capture.text();
    let all = format!("{text}\n{out:?}");
    for secret in SECRETS {
        assert!(!all.contains(secret), "{secret:?} survived:\n{text}");
    }
    // One-character values are whole words on a real device.
    for line in text.lines() {
        let w: Vec<&str> = line.split_whitespace().collect();
        assert!(
            !(w.first() == Some(&"snmp-server") && w.get(2) == Some(&"c")),
            "{line}"
        );
        assert!(
            !(w.first() == Some(&"username") && w.last() == Some(&"z")),
            "{line}"
        );
    }
    // What is not a credential survives.
    for kept in [
        "dc1-leaf1a",
        "interface Vlan11",
        "neighbor 10.255.255.0 remote-as 65100",
    ] {
        assert!(text.contains(kept), "{kept} was destroyed");
    }
}

#[test]
fn interfaces_vlans_and_addresses_are_read() {
    let out = read(CONFIG);
    let s = format!("{:?}", out.fragment);
    for want in [
        "\"dc1-leaf1a\"",
        "VlanId(11)",
        "\"VRF10_VLAN11\"",
        "\"Ethernet1\"",
        // The rest of the line, spaces and all, is the description.
        "\"P2P dc1-spine1 Ethernet1\"",
        "addr: 10.255.255.1, prefix_len: 31",
        "addr: 10.10.21.1, prefix_len: 24",
        // The anycast gateway is the SVI's address.
        "addr: 10.10.11.1, prefix_len: 24",
    ] {
        assert!(s.contains(want), "{want} not bound:\n{s}");
    }
    // `vlan internal order …` is not VLAN `internal`, and `vlan 11` under
    // `router bgp` is not a second VLAN 11.
    assert_eq!(
        names(&out, NodeKind::Vlan).len(),
        4,
        "{:?}",
        names(&out, NodeKind::Vlan)
    );
    let internal = out
        .ledger
        .lines
        .iter()
        .find(|e| {
            out.capture
                .text()
                .get(e.span.start as usize..e.span.end as usize)
                == Some("vlan internal order ascending range 1006 1199")
        })
        .expect("the line is in the ledger");
    assert!(!matches!(internal.outcome, LineOutcome::Bound { .. }));
    // `shutdown` and `no shutdown` both read.
    let e6 = &out.fragment.nodes[index_of(&out, NodeKind::Interface, "\"Ethernet6\"") as usize];
    assert!(format!("{:?}", e6.fields).contains("Bool(false)"));
}

#[test]
fn a_port_channel_and_its_links_are_read() {
    let out = read(CONFIG);
    let po = index_of(&out, NodeKind::AggregateInterface, "\"Port-Channel5\"");
    let e5 = index_of(&out, NodeKind::Interface, "\"Ethernet5\"");
    assert!(
        edge(&out, EdgeKind::MemberOfAggregate, e5, po),
        "Ethernet5 is a link of Port-Channel5"
    );
}

#[test]
fn trunk_and_access_vlans_are_memberships() {
    let out = read(CONFIG);
    let vlan = |v: &str| index_of(&out, NodeKind::Vlan, &format!("VlanId({v})"));
    let po_unit = unit_of(
        &out,
        index_of(&out, NodeKind::AggregateInterface, "\"Port-Channel5\""),
    );
    // `11-12,21`: three VLANs.
    for v in ["11", "12", "21"] {
        assert!(
            edge(&out, EdgeKind::VlanMember, po_unit, vlan(v)),
            "Port-Channel5 carries {v}"
        );
    }
    // The native VLAN is carried too; this paste never declares 4092, so the
    // membership waits for it rather than inventing it.
    assert!(out
        .fragment
        .pending
        .iter()
        .any(|p| p.kind == EdgeKind::VlanMember && format!("{:?}", p.target).contains("\"4092\"")));
    let e6_unit = unit_of(&out, index_of(&out, NodeKind::Interface, "\"Ethernet6\""));
    assert!(edge(&out, EdgeKind::VlanMember, e6_unit, vlan("12")));
    // `1-4094` says "every VLAN"; it is not read as 4094 memberships.
    let e7 = index_of(&out, NodeKind::Interface, "\"Ethernet7\"");
    assert!(!out
        .fragment
        .nodes
        .iter()
        .any(|n| n.kind == NodeKind::LogicalUnit && n.owner.map(|o| o.0) == Some(e7)));
    assert!(out.fragment.pending.len() < 5, "{:?}", out.fragment.pending);
}

#[test]
fn an_svi_routes_its_vlan() {
    let out = read(CONFIG);
    for (svi, vid) in [("\"Vlan11\"", "VlanId(11)"), ("\"Vlan21\"", "VlanId(21)")] {
        let unit = unit_of(&out, index_of(&out, NodeKind::Interface, svi));
        let vlan = index_of(&out, NodeKind::Vlan, vid);
        assert!(
            edge(&out, EdgeKind::L3Interface, vlan, unit),
            "{svi} routes {vid}"
        );
    }
}

#[test]
fn vrfs_are_kept_apart_and_vrf_routes_are_not_read_yet() {
    let out = read(CONFIG);
    let vrf10 = index_of(&out, NodeKind::RoutingInstance, "\"VRF10\"");
    let mgmt = index_of(&out, NodeKind::RoutingInstance, "\"MGMT\"");
    let svi_unit = unit_of(&out, index_of(&out, NodeKind::Interface, "\"Vlan11\""));
    let mgmt_unit = unit_of(&out, index_of(&out, NodeKind::Interface, "\"Management1\""));
    assert!(edge(&out, EdgeKind::InRoutingInstance, svi_unit, vrf10));
    assert!(edge(&out, EdgeKind::InRoutingInstance, mgmt_unit, mgmt));
    // The default table's routes are read; the VRF's route is residue.
    let routes = names(&out, NodeKind::StaticRoute);
    assert!(
        routes
            .iter()
            .any(|r| r.contains("0.0.0.0") && r.contains("10.255.255.0")),
        "{routes:?}"
    );
    assert!(
        !routes.iter().any(|r| r.contains("172.16.1.1")),
        "{routes:?}"
    );
    assert!(out.residue.iter().any(|r| out
        .capture
        .text()
        .get(r.span.start as usize..r.span.end as usize)
        == Some("ip route vrf MGMT 0.0.0.0/0 172.16.1.1")));
}

/// A paste that lost its indentation (copied from a web page, say) reads the
/// interface blocks the same: `!` still ends each one.
#[test]
fn a_paste_without_indentation_reads_the_same_blocks() {
    let flat: String = CONFIG
        .lines()
        .map(|l| format!("{}\n", l.trim_start()))
        .collect();
    let out = read(&flat);
    let po = index_of(&out, NodeKind::AggregateInterface, "\"Port-Channel5\"");
    let e5 = index_of(&out, NodeKind::Interface, "\"Ethernet5\"");
    assert!(edge(&out, EdgeKind::MemberOfAggregate, e5, po));
    let unit = unit_of(&out, index_of(&out, NodeKind::Interface, "\"Vlan11\""));
    assert!(edge(
        &out,
        EdgeKind::L3Interface,
        index_of(&out, NodeKind::Vlan, "VlanId(11)"),
        unit
    ));
    let text = out.capture.text();
    for secret in SECRETS {
        assert!(
            !text.contains(secret),
            "{secret:?} survived without indentation"
        );
    }
}

#[test]
fn a_null0_route_is_a_discard_route() {
    let out = read(CONFIG);
    let routes = names(&out, NodeKind::StaticRoute);
    let null = routes
        .iter()
        .find(|r| r.contains("10.99.0.0"))
        .expect("the Null0 route binds");
    assert!(null.contains("Discard"), "{null}");
}
