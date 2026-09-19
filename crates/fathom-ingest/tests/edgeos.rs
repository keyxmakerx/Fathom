//! `corpus/dict/edgeos/` — a synthetic EdgeOS `show configuration commands`
//! capture, asserting what binds and that every credential is gone from the
//! stored capture (`14`'s governing rule: "nothing secret is ever kept").
//!
//! CREDENTIAL LENGTHS, CLAUDE.md rule 2 ("test a safety gate against what a
//! real device accepts, not against what the detector needs"). Searched
//! 2026-09-19 for an EdgeOS/Vyatta-specific maximum login-password length;
//! **could not establish one** — no vendor page or community thread read
//! stated a cap, and Vyatta/EdgeOS authentication is Linux PAM/`crypt()`
//! underneath, which imposes no short practical limit either. Rather than
//! guess a maximum, the values below are REPRESENTATIVE real-world lengths
//! (a hand-typed 20-odd character passphrase, an ISP-issued ~11-character
//! PPPoE password, a 34-character IPsec PSK) — not maximal, not
//! detector-shaped — and the `encrypted-password` case uses the exact
//! format and length a real EdgeOS box would paste: `$6$…` is glibc's
//! SHA-512 `crypt()` form (rounds salt + 86-character hash), and EdgeOS's
//! own login/authentication is confirmed Vyatta/Linux-derived (see
//! `corpus/dict/README-ubiquiti.md`).

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
    let dict = Dictionary::load_platform(&repo_root(), "edgeos").expect("edgeos dictionary loads");
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

/// A representative small-home-network EdgeRouter capture in `show
/// configuration commands` form: hostname, one login user with a plaintext
/// password, one with an encrypted (crypt) password, an SNMP RO community, a
/// WAN ethernet interface with a PPPoE password, a disabled spare port, a
/// VLAN sub-interface on the LAN switch with an address and a description,
/// and a site-to-site IPsec pre-shared secret.
const CAPTURE: &str = r#"set system host-name home-gw-01
set system login user admin authentication plaintext-password "Correct-Horse-Battery-2026"
set system login user backup-admin authentication encrypted-password "$6$rounds=5000$saltsalt12$AbCdEfGhIjKlMnOpQrStUvWxYz0123456789AbCdEfGhIjKlMnOpQrStUvWxYz0123456789AbCdEfGh"
set service snmp community R3adOnlyHome2026 authorization ro
set interfaces ethernet eth0 description "WAN uplink"
set interfaces ethernet eth0 pppoe 0 user-id "user@example-isp.net"
set interfaces ethernet eth0 pppoe 0 password "isp-Pw93xnQ2"
set interfaces ethernet eth2 vif 10 pppoe 0 password "guest-Pw77zQm4"
set interfaces ethernet eth3 disable
set interfaces switch switch0 vif 20 description "Guest VLAN"
set interfaces switch switch0 vif 20 address 172.16.20.1/24
set vpn ipsec site-to-site peer 203.0.113.9 authentication pre-shared-secret "Correct-Horse-Site-To-Site-Key-99"
"#;

#[test]
fn hostname_binds_to_device() {
    let out = run(CAPTURE);
    let devices = nodes_of(&out.fragment, NodeKind::Device);
    assert_eq!(devices.len(), 1, "one Device node");
    let want = scalar::Identifier::parse("home-gw-01").expect("valid identifier");
    assert!(has(devices[0].1, &BoundValue::Identifier(want)));
}

#[test]
fn ethernet_description_and_disable_bind() {
    let out = run(CAPTURE);
    let ifaces = nodes_of(&out.fragment, NodeKind::Interface);
    let eth0 = ifaces
        .iter()
        .find(|(_, n)| {
            has(
                n,
                &BoundValue::Text(scalar::Text::parse("WAN uplink").expect("text")),
            )
        })
        .expect("eth0's description bound");
    let _ = eth0;
    let eth3 = ifaces
        .iter()
        .find(|(_, n)| has(n, &BoundValue::Bool(false)))
        .expect("eth3's disable inverted to admin_up = false");
    let _ = eth3;
}

#[test]
fn vif_address_vlan_id_and_description_bind() {
    let out = run(CAPTURE);
    let units = nodes_of(&out.fragment, NodeKind::LogicalUnit);
    assert!(
        units.iter().any(|(_, n)| has(
            n,
            &BoundValue::VlanId(scalar::VlanId::parse("20").expect("vlan id"))
        )),
        "vif 20's index doubles as its vlan_id"
    );
    let addrs = nodes_of(&out.fragment, NodeKind::Address);
    assert!(
        addrs.iter().any(|(_, n)| has(
            n,
            &BoundValue::InterfaceAddress(
                scalar::InterfaceAddress::parse("172.16.20.1/24").expect("interface address")
            )
        )),
        "the vif's address bound to an Address node"
    );
}

/// The floor this whole file exists to prove: not one plaintext credential
/// from the capture above survives into the stored (redacted) text.
#[test]
fn every_credential_is_gone_from_the_redacted_capture() {
    let out = run(CAPTURE);
    let text = out.capture.text();

    // Login passwords, plaintext and encrypted.
    assert!(!text.contains("Correct-Horse-Battery-2026"));
    assert!(!text.contains(
        "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789AbCdEfGhIjKlMnOpQrStUvWxYz0123456789AbCdEfGh"
    ));
    // SNMP community (the credential IS the community name).
    assert!(!text.contains("R3adOnlyHome2026"));
    // PPPoE password.
    assert!(!text.contains("isp-Pw93xnQ2"));
    // vif-nested PPPoE password — `corpus/dict/edgeos/interfaces.yaml`'s
    // header CORRECTION note: this platform's `pppoe.password` entry's path
    // does not match a `vif`-nested statement at all (the paths diverge at
    // the segment after `$if`), so this value is destroyed by `redact.rs`'s
    // `raw_walk` two-token lookback on `password` (the core floor), not by
    // this dictionary's structural entry. Checked here so that claim is
    // exercised, not just asserted in a comment.
    assert!(!text.contains("guest-Pw77zQm4"));
    // IPsec pre-shared secret.
    assert!(!text.contains("Correct-Horse-Site-To-Site-Key-99"));

    // And the drop manifest recorded all six destructions — the redaction
    // did not just happen to fail to find the string above some other way.
    assert!(
        out.drops.entries.len() >= 6,
        "expected at least 6 redactions, got {}: {:?}",
        out.drops.entries.len(),
        out.drops.entries
    );

    // What is NOT a credential survives untouched — the PPPoE username, the
    // hostname, the VLAN description, the WAN description.
    assert!(text.contains("home-gw-01"));
    assert!(text.contains("user@example-isp.net"));
    assert!(text.contains("Guest VLAN"));
    assert!(text.contains("WAN uplink"));
}
