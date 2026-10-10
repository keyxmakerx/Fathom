//! `corpus/dict/routeros/` through `fathom_ingest::routeros` — a RouterOS
//! `/export` in the shape a real box prints, asserting what binds and that
//! every credential is gone from the stored capture before anything else
//! reads it (CLAUDE.md rule 4).
//!
//! Credential values are real-world shapes, not detector-shaped ones
//! (CLAUDE.md rule 2): the WireGuard key is the 44-character base64 form
//! `wg genkey` prints (this one is the example key from the `wg(8)` manual
//! page), passwords are ordinary hand-typed lengths, and the SNMP community
//! is a short word a person would pick. Sources for every parameter name are
//! in `corpus/dict/README-routeros.md`.

use std::path::{Path, PathBuf};

use fathom_ingest::bind::{BoundValue, FragNode, Fragment};
use fathom_ingest::dict::Dictionary;
use fathom_ingest::frame::LineOutcome;
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

fn dict() -> Dictionary {
    Dictionary::load_platform(&repo_root(), "routeros").expect("routeros dictionary loads")
}

fn run(paste: &str) -> fathom_ingest::IngestOutput {
    fathom_ingest::routeros::ingest_routeros(paste.as_bytes(), &dict()).expect("within the caps")
}

fn nodes_of(f: &Fragment, kind: NodeKind) -> Vec<&FragNode> {
    f.nodes.iter().filter(|n| n.kind == kind).collect()
}

fn has(node: &FragNode, want: &BoundValue) -> bool {
    node.fields.iter().any(|f| &f.value == want)
}

fn iface(name: &str) -> BoundValue {
    BoundValue::InterfaceName(scalar::InterfaceName::parse(name).expect("valid name"))
}

const WG_KEY: &str = "yAnz5TF+lXXJte14tji3zlMNq+hd2rYUIgJBgB3fBmk=";
const WG_PSK: &str = "FpCyhws9cxwWoV4xELtfJvjJN+zQVRPISllRWgeopVE=";

/// The mockup's paste (r15-f2), filled out to what a home-lab box carries.
fn capture() -> String {
    format!(
        r#"# 2026-10-01 09:12:44 by RouterOS 7.15.3
# software id = AB12-CD34
#
# model = RB5009UG+S+
# serial number = HF0123ABCDE
/interface bridge
add name=bridge1 vlan-filtering=yes
/interface ethernet
set [ find default-name=ether1 ] comment="WAN uplink" name=wan
set [ find default-name=ether5 ] disabled=yes
/interface wireguard
add listen-port=13231 mtu=1420 name=wg0 private-key="{WG_KEY}"
/interface vlan
add interface=bridge1 name=iot vlan-id=30
add interface=bridge1 name=staff vlan-id=20
/interface pppoe-client
add add-default-route=yes interface=wan name=pppoe-out1 password=isp-Pw93xnQ2 user=home@example-isp.net
/interface wifi security
add authentication-types=wpa2-psk,wpa3-psk name=home passphrase="Correct Horse Battery 2026"
/snmp community
add addresses=10.0.20.0/24 name=R3adOnlyHome
/ppp secret
add name=road password=Rw-71kQzP2 profile=default-encryption service=l2tp
/interface bridge port
add bridge=bridge1 interface=ether2
add bridge=bridge1 interface=ether3
/interface wireguard peers
add allowed-address=10.0.99.2/32 interface=wg0 preshared-key="{WG_PSK}" public-key="xTIBA5rboUvnH4htodjb6e697QjLERt1NAB4mZqp8Dg="
/ip address
add address=10.0.20.1/24 interface=staff
add address=10.0.30.1/24 interface=iot
/system identity
set name=R1
/system script
add name=mail-report source="/tool e-mail send to=ops@example.net password=Mail-Pw-4471 \
    subject=report"
/user
add group=full name=admin password=Correct-Horse-Admin-26
"#
    )
}

const SECRETS: [&str; 9] = [
    WG_KEY,
    WG_PSK,
    "isp-Pw93xnQ2",
    "Correct Horse Battery 2026",
    "R3adOnlyHome",
    "Rw-71kQzP2",
    "Mail-Pw-4471",
    "Correct-Horse-Admin-26",
    "Horse Battery",
];

#[test]
fn every_credential_is_gone_from_the_redacted_capture() {
    let out = run(&capture());
    let text = out.capture.text();
    for secret in SECRETS {
        assert!(
            !text.contains(secret),
            "{secret} survived the gate:\n{text}"
        );
    }
    assert!(!out.drops.entries.is_empty());
}

#[test]
fn no_credential_reaches_the_fragment() {
    let out = run(&capture());
    let dump = format!("{:?}", out.fragment);
    for secret in SECRETS {
        assert!(!dump.contains(secret), "{secret} reached the fragment");
    }
}

#[test]
fn the_network_survives_the_gate() {
    let out = run(&capture());
    let text = out.capture.text();
    for kept in [
        "bridge1",
        "vlan-id=30",
        "10.0.20.1/24",
        "wg0",
        "ether2",
        "staff",
    ] {
        assert!(text.contains(kept), "{kept} was destroyed");
    }
}

#[test]
fn interfaces_vlans_and_addresses_bind() {
    let out = run(&capture());
    let f = &out.fragment;
    let ifaces = nodes_of(f, NodeKind::Interface);
    for name in [
        "bridge1", "wan", "ether5", "wg0", "iot", "staff", "ether2", "ether3",
    ] {
        assert!(
            ifaces.iter().any(|n| has(n, &iface(name))),
            "no Interface {name}"
        );
    }
    let wan = ifaces.iter().find(|n| has(n, &iface("wan"))).unwrap();
    assert!(has(
        wan,
        &BoundValue::Text(scalar::Text::parse("WAN uplink").unwrap())
    ));
    let ether5 = ifaces.iter().find(|n| has(n, &iface("ether5"))).unwrap();
    assert!(has(ether5, &BoundValue::Bool(false)));

    let vlans = nodes_of(f, NodeKind::Vlan);
    for id in [20u16, 30] {
        let want = BoundValue::VlanId(scalar::VlanId::parse(&id.to_string()).unwrap());
        assert!(vlans.iter().any(|n| has(n, &want)), "no VLAN {id}");
    }

    let addrs = nodes_of(f, NodeKind::Address);
    assert_eq!(addrs.len(), 2);
    let units = nodes_of(f, NodeKind::LogicalUnit);
    assert!(units.iter().all(|u| has(u, &BoundValue::U32(0))));

    let device = nodes_of(f, NodeKind::Device);
    assert!(has(
        device[0],
        &BoundValue::Identifier(scalar::Identifier::parse("R1").unwrap())
    ));
}

#[test]
fn the_ledger_names_every_line() {
    let cap = capture();
    let out = run(&cap);
    // The header comments are residue and the menu lines are headers.
    assert!(matches!(
        out.ledger.lines[0].outcome,
        LineOutcome::Unmapped { .. }
    ));
    assert!(matches!(
        out.ledger.lines[5].outcome,
        LineOutcome::Header { .. }
    ));
    assert!(out
        .ledger
        .lines
        .iter()
        .any(|l| matches!(l.outcome, LineOutcome::Bound { .. })));
}

#[test]
fn an_unknown_menu_is_still_gated() {
    let out = run("/tool something-new\nadd name=x secret=Zq8-unknown-77 shared=yes\n");
    assert!(!out.capture.text().contains("Zq8-unknown-77"));
}

#[test]
fn a_line_with_no_menu_is_refused_and_swept() {
    let out = run("add name=x password=Lone-Pw-881\n");
    assert!(matches!(
        out.ledger.lines[0].outcome,
        LineOutcome::Unshaped { .. } | LineOutcome::Quarantined { .. }
    ));
    assert!(!out.capture.text().contains("Lone-Pw-881"));
}

#[test]
fn a_one_line_command_carries_its_own_menu() {
    let out = run("/ip address add address=192.0.2.1/24 interface=ether2\n");
    assert_eq!(nodes_of(&out.fragment, NodeKind::Address).len(), 1);
}

#[test]
fn the_gate_runs_on_an_unterminated_string() {
    let out = run("/user\nadd name=a password=\"Open-Pw-5512\n");
    assert!(!out.capture.text().contains("Open-Pw-5512"));
}

/// The labels a reader sees come from the dictionary, not the safety net.
#[test]
fn credentials_carry_their_label() {
    let out = run(&capture());
    let text = out.capture.text();
    for want in [
        "private-key=<REDACTED:cert-key>",
        "preshared-key=<REDACTED:psk>",
        "passphrase=<REDACTED:psk>",
        "name=<REDACTED:snmp-community>",
        "source=<REDACTED:unknown>",
    ] {
        assert!(text.contains(want), "no {want} in:\n{text}");
    }
}

/// A script body goes whole, whatever is in it: RouterOS never hides one, and
/// a credential in it need not be spelled `key=value`.
#[test]
fn a_script_body_is_destroyed_whole() {
    let out = run(r#"/system scheduler
add name=s on-event=":local pw \"Sch3d-Pw-77\"; /tool fetch url=x"
"#);
    assert!(!out.capture.text().contains("Sch3d-Pw-77"));
}

/// `/export` can wrap so the value sits alone on the next line (7.12.1,
/// `public-key=\` then `    "UrQi…="`, README-routeros.md).
#[test]
fn a_value_wrapped_onto_its_own_line_is_read_whole() {
    let paste = format!(
        "/interface wireguard\nadd listen-port=13231 name=wg0 private-key=\\\n    \"{WG_KEY}\"\n"
    );
    let out = run(&paste);
    let text = out.capture.text();
    assert!(!text.contains(WG_KEY), "{text}");
    assert!(text.contains("private-key=<REDACTED:cert-key>"), "{text}");
}

/// A terminal copy can cut a long line mid-word with no backslash
/// (README-routeros.md: `start-date=2018-08-26 st` / `art-time=…`). A
/// password cut that way is joined back and destroyed whole.
#[test]
fn a_secret_cut_mid_word_by_a_terminal_is_destroyed_whole() {
    let out = run(
        "/interface pppoe-client\nadd interface=ether1 name=pppoe-out1 passw\nord=Split-Pw-9931 user=me\n",
    );
    let text = out.capture.text();
    assert!(!text.contains("9931"), "{text}");
    let out = run(
        "/interface pppoe-client\nadd interface=ether1 name=pppoe-out1 password=Split-P\nw-9931 user=me\n",
    );
    let text = out.capture.text();
    assert!(!text.contains("9931"), "{text}");
}

/// v7 Wi-Fi writes dotted names and a leading-dot shorthand
/// (`security.authentication-types=… .passphrase=…`, 7.23.1).
#[test]
fn a_dotted_secret_name_is_destroyed() {
    let out = run(
        "/interface wifi\nadd configuration.mode=ap name=wifi1 security.authentication-types=wpa2-psk .passphrase=Dotted-Pw-2026\n",
    );
    assert!(!out.capture.text().contains("Dotted-Pw-2026"));
}

/// Names the secret-word floor cannot see are caught by the dictionary.
#[test]
fn a_pin_and_a_macsec_key_are_destroyed() {
    let out = run(
        "/interface lte\nset [ find default-name=lte1 ] pin=4821\n/interface macsec\nadd cak=71b2c4d5e6f708192a3b4c5d6e7f8091 ckn=a1 interface=ether2 name=macsec1\n",
    );
    let text = out.capture.text();
    assert!(!text.contains("4821"), "{text}");
    assert!(!text.contains("71b2c4d5e6f708192a3b4c5d6e7f8091"), "{text}");
}

/// v6's default `/export` prints secrets, and its header is the old date form
/// (6.48.1 header and 6.48.6 bridge lines, README-routeros.md).
#[test]
fn a_v6_export_is_read_and_gated() {
    let paste = "# may/31/2024 22:36:40 by RouterOS 6.48.1\n# software id = Q7UY-TG8N\n#\n# model = RouterBOARD 750 r2\n/interface bridge\nadd frame-types=admit-only-vlan-tagged ingress-filtering=yes name=bridge1 \\\n    protocol-mode=none vlan-filtering=yes\n/interface vlan\nadd interface=bridge1 name=vlan200 vlan-id=200\n/interface wireless security-profiles\nadd authentication-types=wpa2-psk mode=dynamic-keys name=home wpa2-pre-shared-key=V6-Wpa2-Key-2024\n";
    assert!(fathom_ingest::routeros::looks_like_routeros(
        paste.as_bytes()
    ));
    let out = run(paste);
    assert!(!out.capture.text().contains("V6-Wpa2-Key-2024"));
    let ifaces = nodes_of(&out.fragment, NodeKind::Interface);
    assert!(ifaces.iter().any(|n| has(n, &iface("vlan200"))));
    assert!(ifaces.iter().any(|n| has(n, &iface("bridge1"))));
}
