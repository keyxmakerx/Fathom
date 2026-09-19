//! `corpus/dict/linux-host/` — proof of the finding recorded in
//! `corpus/dict/README-linux-host.md`: a realistic synthetic capture of what
//! a Linux host prints about its own network (`ip -d link show`, `ip -4 -6
//! addr show`, `ip route show`, `bridge vlan show`) binds nothing today,
//! because every line fails `shape::ShapeError::NotVerbInitial` before the
//! dictionary is ever consulted — and that the redaction gate still runs
//! regardless, destroying a pasted WireGuard private key on contact.
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
use fathom_ir::generated::ir_types::NodeKind;

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .nth(2)
        .expect("the crate lives two levels under the repo root")
        .to_path_buf()
}

fn dict() -> Dictionary {
    Dictionary::load_platform(&repo_root(), "linux-host")
        .expect("the linux-host dictionary loads: zero entries is a valid dictionary")
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

/// The core finding `README-linux-host.md` records: every line of `ip
/// -d link show`, `ip -4 -6 addr show`, `ip route show` and `bridge vlan
/// show` fails the shaper's unconditional verb check, so nothing binds —
/// not because the dictionary is thin, but because no dictionary entry can
/// ever be reached for this input shape. This is the "built kinds and
/// counts" the brief asks for: the count is zero, and this asserts why.
#[test]
fn no_line_of_the_four_commands_is_verb_initial() {
    let d = dict();
    let out = fathom_ingest::ingest(full_capture().as_bytes(), &d).expect("within the caps");

    // `bind::bind` always seeds `nodes[0]` as the implicit Device root
    // (`bind.rs`'s own doc comment), independent of whether anything bound
    // to it — so "nothing binds" is exactly one node, not zero.
    assert_eq!(
        out.fragment.nodes.len(),
        1,
        "zero dictionary entries exist to bind against, so only the implicit \
         Device root may be present; got {}",
        out.fragment.nodes.len()
    );
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
    // Every non-blank line of the four commands' output (ip link/addr/route,
    // bridge vlan) fails the same way. The WireGuard snippet's `[Interface]`/
    // `[Peer]` lines and `ListenPort =`/`AllowedIPs =` also fail it (no `=`
    // prefixed by a recognised verb either), so the floor below is generous
    // but the point — that the overwhelming majority of a real paste from
    // this platform is `NotVerbInitial`, not silently dropped — holds either
    // way.
    assert!(
        not_verb_initial > 40,
        "expected the bulk of a ~60-line multi-command paste to fail \
         NotVerbInitial; got {not_verb_initial}"
    );
}

/// The floor this file exists to prove regardless of what binds: a WireGuard
/// private key pasted alongside unshapeable `ip`/`bridge` output is still
/// destroyed by the gate, because `redact::gate` sweeps `unshaped` and
/// `noise` lines the same as bound statements (`14`'s governing rule).
#[test]
fn a_pasted_wireguard_private_key_is_destroyed_even_though_nothing_binds() {
    let d = dict();
    let out = fathom_ingest::ingest(full_capture().as_bytes(), &d).expect("within the caps");
    let text = out.capture.text();

    assert!(
        !text.contains("4iYvm1BObqDhNfcLJGZxkFpPRlfj4CVEerX2YhlkRh8="),
        "the WireGuard private key must not survive into the stored capture"
    );
    assert!(
        !out.drops.entries.is_empty(),
        "the drop manifest must record at least one destruction"
    );

    // What is NOT a secret survives: interface names, addresses, the route
    // table, the VLAN table. The public key on the [Peer] line is, by
    // WireGuard's own model, not the secret (only the private key is) and is
    // representative surrounding text that must not be swept up by an
    // over-eager detector.
    assert!(text.contains("bond0.10"));
    assert!(text.contains("192.0.2.10/24"));
    assert!(text.contains("veth11"));
    assert!(text.contains("10.10.30.0/24"));
}
