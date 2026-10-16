//! `corpus/dict/linux-host/` through `crates/fathom-ingest/src/iproute.rs`: a
//! realistic synthetic capture of what a Linux host prints about its own
//! network (`ip -d link show`, `ip -4 -6 addr show`, `ip route show`, `bridge
//! vlan show`) binds its interfaces, VLANs and addresses, and the redaction
//! gate still destroys a pasted WireGuard private key or IPsec keys on contact.
//! Through the set-form shaper (`fathom_ingest::ingest`) the same paste still
//! binds nothing, which is why the front end exists (README-linux-host.md).
//!
//! CREDENTIAL SHAPE, CLAUDE.md rule 2 ("test a safety gate against what a
//! real device accepts, not against what the detector needs"). A WireGuard
//! private key is not a length a human chooses — it is a 32-byte Curve25519
//! scalar, always base64-encoded to exactly 44 characters with one trailing
//! `=` pad. Confirmed 2026-09-19 from two independent sources: `man7.org`'s
//! WireGuard reference material and the `WireGuard/wireguard-vyatta-ubnt`
//! project's own key-validation issue #138 ("Key is not valid 44-character
//! (32-bytes) base64"), which states the identical shape independently. The
//! value used below is exactly that shape — 44 characters, one trailing `=`
//! — not a value chosen because the detector needs it.
//!
//! The synthetic host: two bonds (`bond0` trunking three 802.1Q VLAN
//! sub-interfaces, `bond1` a separate uplink), a VLAN-filtering bridge
//! (`br0`) whose `bridge vlan show` table carries PVID/untagged access ports
//! and a tagged trunk, three VLAN sub-interfaces (`bond0.10`/`.20`/`.30`),
//! and a dozen container `veth` pairs bridged onto `br0` — the shapes named
//! in the brief.

use std::path::{Path, PathBuf};

use fathom_ingest::dict::Dictionary;
use fathom_ingest::frame::{LineOutcome, ShapeError};
use fathom_ingest::iproute::{ingest_iproute, looks_like_iproute};
use fathom_ir::generated::ir_types::NodeKind;

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .nth(2)
        .expect("the crate lives two levels under the repo root")
        .to_path_buf()
}

fn dict() -> Dictionary {
    Dictionary::load_platform(&repo_root(), "linux-host").expect("the linux-host dictionary loads")
}

/// `ip -d link show` — two bonds, three VLAN sub-interfaces on `bond0`, the
/// VLAN-filtering bridge, and a dozen veths bridged onto it.
fn ip_link_show() -> String {
    let mut s = String::new();
    s.push_str(
        "2: eth0: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500 qdisc mq state UP mode DEFAULT group default qlen 1000\n\
         \x20\x20\x20\x20link/ether 52:54:00:12:34:56 brd ff:ff:ff:ff:ff:ff\n\
         3: eth1: <BROADCAST,MULTICAST,SLAVE,UP,LOWER_UP> mtu 1500 qdisc mq master bond0 state UP mode DEFAULT group default qlen 1000\n\
         \x20\x20\x20\x20link/ether 52:54:00:aa:bb:01 brd ff:ff:ff:ff:ff:ff\n\
         4: eth2: <BROADCAST,MULTICAST,SLAVE,UP,LOWER_UP> mtu 1500 qdisc mq master bond0 state UP mode DEFAULT group default qlen 1000\n\
         \x20\x20\x20\x20link/ether 52:54:00:aa:bb:01 brd ff:ff:ff:ff:ff:ff\n\
         5: bond0: <BROADCAST,MULTICAST,MASTER,UP,LOWER_UP> mtu 1500 qdisc noqueue state UP mode DEFAULT group default qlen 1000\n\
         \x20\x20\x20\x20link/ether 52:54:00:aa:bb:01 brd ff:ff:ff:ff:ff:ff\n\
         6: eth3: <BROADCAST,MULTICAST,SLAVE,UP,LOWER_UP> mtu 1500 qdisc mq master bond1 state UP mode DEFAULT group default qlen 1000\n\
         \x20\x20\x20\x20link/ether 52:54:00:cc:dd:01 brd ff:ff:ff:ff:ff:ff\n\
         7: eth4: <BROADCAST,MULTICAST,SLAVE,UP,LOWER_UP> mtu 1500 qdisc mq master bond1 state UP mode DEFAULT group default qlen 1000\n\
         \x20\x20\x20\x20link/ether 52:54:00:cc:dd:01 brd ff:ff:ff:ff:ff:ff\n\
         8: bond1: <BROADCAST,MULTICAST,MASTER,UP,LOWER_UP> mtu 1500 qdisc noqueue state UP mode DEFAULT group default qlen 1000\n\
         \x20\x20\x20\x20link/ether 52:54:00:cc:dd:01 brd ff:ff:ff:ff:ff:ff\n\
         9: bond0.10@bond0: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500 qdisc noqueue state UP mode DEFAULT group default qlen 1000\n\
         \x20\x20\x20\x20link/ether 52:54:00:aa:bb:01 brd ff:ff:ff:ff:ff:ff\n\
         \x20\x20\x20\x20vlan protocol 802.1Q id 10 <REORDER_HDR>\n\
         10: bond0.20@bond0: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500 qdisc noqueue state UP mode DEFAULT group default qlen 1000\n\
         \x20\x20\x20\x20link/ether 52:54:00:aa:bb:01 brd ff:ff:ff:ff:ff:ff\n\
         \x20\x20\x20\x20vlan protocol 802.1Q id 20 <REORDER_HDR>\n\
         11: bond0.30@bond0: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500 qdisc noqueue state UP mode DEFAULT group default qlen 1000\n\
         \x20\x20\x20\x20link/ether 52:54:00:aa:bb:01 brd ff:ff:ff:ff:ff:ff\n\
         \x20\x20\x20\x20vlan protocol 802.1Q id 30 <REORDER_HDR>\n\
         12: br0: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500 qdisc noqueue state UP mode DEFAULT group default qlen 1000\n\
         \x20\x20\x20\x20link/ether 52:54:00:ee:ff:01 brd ff:ff:ff:ff:ff:ff\n",
    );
    for i in 0..12u32 {
        s.push_str(&format!(
            "{idx}: veth{i}@if{peer}: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500 qdisc noqueue master br0 state UP mode DEFAULT group default qlen 1000\n\
             \x20\x20\x20\x20link/ether 3a:1b:2c:3d:4e:{i:02x} brd ff:ff:ff:ff:ff:ff link-netnsid {i}\n",
            idx = 13 + i,
            i = i,
            peer = 100 + i,
        ));
    }
    s
}

/// `ip -4 -6 addr show` — addresses on the physical uplink, the trunk bond
/// and its three VLAN sub-interfaces.
fn ip_addr_show() -> &'static str {
    "2: eth0: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500 qdisc mq state UP group default qlen 1000\n\
     \x20\x20\x20\x20inet 192.0.2.10/24 brd 192.0.2.255 scope global eth0\n\
     \x20\x20\x20\x20\x20\x20\x20valid_lft forever preferred_lft forever\n\
     \x20\x20\x20\x20inet6 2001:db8::10/64 scope global\n\
     \x20\x20\x20\x20\x20\x20\x20valid_lft forever preferred_lft forever\n\
     5: bond0: <BROADCAST,MULTICAST,MASTER,UP,LOWER_UP> mtu 1500 qdisc noqueue state UP group default qlen 1000\n\
     \x20\x20\x20\x20inet 198.51.100.5/24 brd 198.51.100.255 scope global bond0\n\
     \x20\x20\x20\x20\x20\x20\x20valid_lft forever preferred_lft forever\n\
     9: bond0.10@bond0: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500 qdisc noqueue state UP group default qlen 1000\n\
     \x20\x20\x20\x20inet 10.10.10.1/24 brd 10.10.10.255 scope global bond0.10\n\
     \x20\x20\x20\x20\x20\x20\x20valid_lft forever preferred_lft forever\n\
     10: bond0.20@bond0: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500 qdisc noqueue state UP group default qlen 1000\n\
     \x20\x20\x20\x20inet 10.10.20.1/24 brd 10.10.20.255 scope global bond0.20\n\
     \x20\x20\x20\x20\x20\x20\x20valid_lft forever preferred_lft forever\n\
     11: bond0.30@bond0: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500 qdisc noqueue state UP group default qlen 1000\n\
     \x20\x20\x20\x20inet 10.10.30.1/24 brd 10.10.30.255 scope global bond0.30\n\
     \x20\x20\x20\x20\x20\x20\x20valid_lft forever preferred_lft forever\n"
}

/// `ip route show`.
fn ip_route_show() -> &'static str {
    "default via 192.0.2.1 dev eth0 proto static\n\
     10.10.10.0/24 dev bond0.10 proto kernel scope link src 10.10.10.1\n\
     10.10.20.0/24 dev bond0.20 proto kernel scope link src 10.10.20.1\n\
     10.10.30.0/24 dev bond0.30 proto kernel scope link src 10.10.30.1\n\
     192.0.2.0/24 dev eth0 proto kernel scope link src 192.0.2.10\n\
     198.51.100.0/24 dev bond0 proto kernel scope link src 198.51.100.5\n"
}

/// `bridge vlan show` — the trunk carries all three VLANs tagged; each veth
/// is an untagged access port in one of them (four veths per VLAN).
fn bridge_vlan_show() -> String {
    let mut s = String::from("port              vlan-id\n");
    s.push_str(
        "bond0             10\n\
         \x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x2020\n\
         \x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x2030\n",
    );
    for i in 0..12u32 {
        let vlan = 10 * (1 + (i % 3));
        s.push_str(&format!(
            "veth{i}             {vlan} PVID Egress Untagged\n"
        ));
    }
    s
}

/// A `wg showconf wg0`-style paste stitched onto the end of the capture, the
/// way an operator diagnosing a tunnel would paste both outputs together in
/// one box. The private key is the 44-character/32-byte shape documented in
/// this file's header.
const WIREGUARD_SNIPPET: &str = "[Interface]\n\
     ListenPort = 51820\n\
     PrivateKey = 4iYvm1BObqDhNfcLJGZxkFpPRlfj4CVEerX2YhlkRh8=\n\
     [Peer]\n\
     PublicKey = o+ZpGg2EFbDvcdmGWXBRs6C8eTh3STZRflHJuaNyEbE=\n\
     AllowedIPs = 0.0.0.0/0\n";

fn full_capture() -> String {
    let mut s = String::new();
    s.push_str(&ip_link_show());
    s.push_str(ip_addr_show());
    s.push_str(ip_route_show());
    s.push_str(&bridge_vlan_show());
    s.push_str(WIREGUARD_SNIPPET);
    s
}

/// The set-form shaper still reads none of it: every line fails its verb
/// check. That is the finding README-linux-host.md records, and why
/// `iproute.rs` exists rather than more dictionary entries.
#[test]
fn the_set_form_shaper_reads_no_line_of_it() {
    let d = dict();
    let out = fathom_ingest::ingest(full_capture().as_bytes(), &d).expect("within the caps");
    assert_eq!(out.fragment.nodes.len(), 1, "only the implicit Device root");
    assert_eq!(out.fragment.nodes[0].kind, NodeKind::Device);
    let not_verb_initial = out
        .ledger
        .lines
        .iter()
        .filter(|e| {
            matches!(
                e.outcome,
                LineOutcome::Unshaped {
                    reason: ShapeError::NotVerbInitial
                }
            )
        })
        .count();
    assert!(not_verb_initial > 40, "got {not_verb_initial}");
}

fn read(paste: &str) -> fathom_ingest::IngestOutput {
    ingest_iproute(paste.as_bytes(), &dict()).expect("within the caps")
}

fn interfaces(out: &fathom_ingest::IngestOutput) -> Vec<String> {
    let s = format!("{:?}", out.fragment);
    let mut names: Vec<String> = [
        "eth0", "bond0", "bond0.10", "bond0.20", "bond0.30", "br0", "veth11", "lo",
    ]
    .iter()
    .filter(|n| s.contains(&format!("\"{n}\"")))
    .map(|n| n.to_string())
    .collect();
    names.sort();
    names
}

#[test]
fn the_capture_is_sniffed_as_ip_output() {
    assert!(looks_like_iproute(full_capture().as_bytes()));
    assert!(looks_like_iproute(ip_addr_show().as_bytes()));
    assert!(!looks_like_iproute(ip_route_show().as_bytes()));
    assert!(!looks_like_iproute(bridge_vlan_show().as_bytes()));
}

#[test]
fn interfaces_vlans_and_addresses_bind() {
    let out = read(&full_capture());
    let kinds: Vec<NodeKind> = out.fragment.nodes.iter().map(|n| n.kind).collect();
    let count = |k: NodeKind| kinds.iter().filter(|x| **x == k).count();
    // eth0..eth4, bond0, bond1, three VLAN sub-interfaces, br0, twelve veths.
    assert_eq!(count(NodeKind::Interface), 23, "{kinds:?}");
    assert_eq!(count(NodeKind::Vlan), 3);
    // eth0 v4 and v6, bond0, and the three VLAN sub-interfaces.
    assert_eq!(count(NodeKind::Address), 6);
    let s = format!("{:?}", out.fragment);
    assert!(s.contains("addr: 10.10.20.1,"));
    assert!(s.contains("addr: 2001:db8::10,"));
    // `bond0.10@bond0` is named `bond0.10`; `veth0@if100` is named `veth0`.
    assert!(!s.contains("bond0.10@bond0"));
    assert!(!s.contains("@if100"));
    assert!(interfaces(&out).contains(&"veth11".to_owned()));
}

#[test]
fn the_wireguard_key_is_destroyed_and_the_network_survives() {
    let out = read(&full_capture());
    let text = out.capture.text();
    assert!(!text.contains("4iYvm1BObqDhNfcLJGZxkFpPRlfj4CVEerX2YhlkRh8="));
    assert!(!out.drops.entries.is_empty());
    assert!(text.contains("bond0.10"));
    assert!(text.contains("192.0.2.10/24"));
    assert!(text.contains("10.10.30.0/24"));
}

/// `ip xfrm state` prints an SA's keys as `0x`-prefixed hex, as a strongSwan
/// user's output shows (lists.strongswan.org users, 2017-08, message 011358,
/// read 2026-10-16): `auth-trunc hmac(sha256) 0x6f7a…4314 128` and
/// `enc cbc(aes) 0x77bb…522e`. Pasted under an `ip addr` record, its indented
/// lines must not be read as that interface's attributes, and the keys must
/// not survive. Key lengths are the real ones: 256-bit HMAC and AES keys.
#[test]
fn ipsec_keys_pasted_under_a_record_are_destroyed() {
    let paste = "2: eth0: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500 qdisc mq state UP group default qlen 1000\n\
    \x20\x20\x20\x20inet 192.0.2.10/24 brd 192.0.2.255 scope global eth0\n\
    src 192.0.2.10 dst 203.0.113.7\n\
    \tproto esp spi 0xc1a2b3c4 reqid 1 mode tunnel\n\
    \treplay-window 0 flag af-unspec\n\
    \tauth-trunc hmac(sha256) 0x6f7a3562e5e18fafa95683bf589c6c98c2be237732a5403e22a3e48c65654314 128\n\
    \tenc cbc(aes) 0x77bbcc462b7217af56052a6cb6c008af4052542a13d674e1d6136f6df9c8522e\n\
    3: eth1: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500 qdisc mq state UP group default qlen 1000\n\
    \tauth-trunc hmac(sha256) 0x37110356f80804e83ceb23ecb4e7be5508445a4fdd0eb4814dbdde00dffa6033 128\n";
    let out = read(paste);
    let text = out.capture.text();
    for key in [
        "6f7a3562e5e18fafa95683bf589c6c98c2be237732a5403e22a3e48c65654314",
        "77bbcc462b7217af56052a6cb6c008af4052542a13d674e1d6136f6df9c8522e",
        "37110356f80804e83ceb23ecb4e7be5508445a4fdd0eb4814dbdde00dffa6033",
    ] {
        assert!(!text.contains(key), "an SA key survived:\n{text}");
        assert!(!format!("{:?}", out.fragment).contains(key));
    }
    assert!(text.contains("192.0.2.10/24"));
}

#[test]
fn the_one_line_forms_bind_the_same() {
    let paste = "1: lo    inet 127.0.0.1/8 scope host lo\\       valid_lft forever preferred_lft forever\n\
    2: eth0    inet 192.0.2.10/24 brd 192.0.2.255 scope global eth0\\       valid_lft forever preferred_lft forever\n\
    2: eth0    inet6 2001:db8::10/64 scope global \\       valid_lft forever preferred_lft forever\n\
    9: bond0.10@bond0: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 9000 qdisc noqueue state UP mode DEFAULT group default qlen 1000\\    link/ether 52:54:00:aa:bb:01 brd ff:ff:ff:ff:ff:ff\\    vlan protocol 802.1Q id 10 <REORDER_HDR> \n";
    assert!(looks_like_iproute(paste.as_bytes()));
    let out = read(paste);
    let kinds: Vec<NodeKind> = out.fragment.nodes.iter().map(|n| n.kind).collect();
    assert_eq!(
        kinds.iter().filter(|k| **k == NodeKind::Address).count(),
        3,
        "{kinds:?}"
    );
    assert_eq!(kinds.iter().filter(|k| **k == NodeKind::Vlan).count(), 1);
    let s = format!("{:?}", out.fragment);
    assert!(s.contains("\"bond0.10\""));
    assert!(s.contains("addr: 127.0.0.1,"));
}

#[test]
fn a_prompt_names_the_device() {
    let paste = format!("root@fw1:~# ip addr\n{}", ip_addr_show());
    let out = read(&paste);
    let s = format!("{:?}", out.fragment.nodes[0]);
    assert!(s.contains("fw1"), "{s}");
}

/// A password typed on the command line of the prompt is swept like any
/// other line. `sshpass -p` takes the password as an argument (sshpass(1)).
#[test]
fn a_secret_on_the_prompt_line_is_destroyed() {
    let paste = format!(
        "ops@jump:~$ sshpass -p 'Horse-Battery-77' ssh root@fw1 ip addr password=Horse-Battery-77\n{}",
        ip_addr_show()
    );
    let out = read(&paste);
    assert!(
        !out.capture.text().contains("Horse-Battery-77"),
        "{}",
        out.capture.text()
    );
    assert!(!format!("{:?}", out.fragment).contains("Horse-Battery-77"));
}

#[test]
fn the_ledger_names_every_line() {
    let out = read(&full_capture());
    let lines = full_capture().lines().count();
    assert!(out.ledger.lines.len() >= lines);
    let bound = out
        .ledger
        .lines
        .iter()
        .filter(|e| matches!(e.outcome, LineOutcome::Bound { .. }))
        .count();
    assert!(bound > 20, "got {bound}");
    let route_unshaped = out
        .ledger
        .lines
        .iter()
        .filter(|e| matches!(e.outcome, LineOutcome::Unshaped { .. }))
        .count();
    assert!(
        route_unshaped >= 6,
        "route and table lines are residue: {route_unshaped}"
    );
}
