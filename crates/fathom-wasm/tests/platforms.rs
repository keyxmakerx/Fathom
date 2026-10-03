//! Several dictionaries held at once: Junos SRX, Junos EX, EdgeOS and the OPNsense
//! rules CSV. A paste names its platform or has it detected, an unsure paste is
//! refused with the candidates, and the gate runs for every platform with
//! real-length secrets in that platform's own syntax (CLAUDE.md rules 2 and 4).

use fathom_ir::generated::ir_types::DeviceField;
use fathom_wasm::protocol::{
    decode_reply, ReplyView, ERR_NOTHING_UNDERSTOOD, ERR_PASTE_FRAME, ERR_PLATFORM_CHOICE,
    PASTE_PLATFORMS,
};
use fathom_wasm::shell::Shell;
use fathom_wasm::{OP_EQUIP_ADD, OP_EXPORT_PLAIN, OP_PASTE, OP_PASTE_INTO, OP_REDACT_TEXT};

#[allow(dead_code)]
mod common;

const TS: u64 = 1_786_147_200_000;

/// A new entropy per call: a design refuses a reused identifier.
fn fresh() -> u128 {
    static N: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(100);
    u128::from(N.fetch_add(10_000, std::sync::atomic::Ordering::Relaxed))
}

fn frame(flags: u8, text: &str) -> Vec<u8> {
    let mut f = Vec::new();
    f.extend_from_slice(&TS.to_le_bytes());
    f.extend_from_slice(&fresh().to_le_bytes());
    f.push(flags);
    f.extend_from_slice(text.as_bytes());
    f
}

/// The platform flag for `OP_PASTE`'s byte 24.
fn named(platform: &str) -> u8 {
    let i = PASTE_PLATFORMS.iter().position(|p| *p == platform).unwrap();
    ((i + 1) << 1) as u8
}

fn into_frame(flags: u8, display: &str, text: &str) -> Vec<u8> {
    let mut f = Vec::new();
    f.extend_from_slice(&TS.to_le_bytes());
    f.extend_from_slice(&fresh().to_le_bytes());
    f.push(flags);
    f.extend_from_slice(&(display.len() as u16).to_le_bytes());
    f.extend_from_slice(display.as_bytes());
    f.extend_from_slice(text.as_bytes());
    f
}

/// A bare device placed by hand, as the page does before a paste-into; returns its display id.
fn place(shell: &mut Shell, platform: &str) -> String {
    let mut v = Vec::new();
    v.extend_from_slice(&TS.to_le_bytes());
    v.extend_from_slice(&fresh().to_le_bytes());
    let fields = [
        (DeviceField::Hostname.key().0, "placeholder"),
        (DeviceField::Platform.key().0, platform),
    ];
    v.push(fields.len() as u8);
    for (k, val) in fields {
        v.extend_from_slice(&(k as u16).to_le_bytes());
        v.extend_from_slice(&(val.len() as u16).to_le_bytes());
        v.extend_from_slice(val.as_bytes());
    }
    match decode_reply(&shell.handle(OP_EQUIP_ADD, &v)).expect("well-formed") {
        ReplyView::FaceRows(rows) => rows[0].strings[0].clone(),
        other => panic!("{other:?}"),
    }
}

fn contains(hay: &[u8], needle: &str) -> bool {
    hay.windows(needle.len()).any(|w| w == needle.as_bytes())
}

// Real-length values, in each platform's own syntax.
const EX_ROOT: &str = "$6$rounds=5000$saltEX01$odJFCrnl2edlBDdz1C5Jau2RJtBRnlWmTSHf6pWkLUyifDLkDmWJ6UuVTAIjvFu7WICPhDeOZIiBOB/Y6sHrFH";
const EX_SNMP: &str = "R3adOnlyCommunity2026";
const EX_BGP: &str = "Tr0ubador-BGP-MD5-Key-Tr0ubador-BGP-MD5-Key-Tr0ubador-BGP-MD5-Key-Tr0ubador-BGP-MD5-Key-Tr0ubador-BGP-MD";
const EDGE_PLAIN: &str = "Correct-Horse-Battery-2026";
const EDGE_CRYPT: &str = "$6$rounds=5000$saltsalt12$AbCdEfGhIjKlMnOpQrStUvWxYz0123456789AbCdEfGhIjKlMnOpQrStUvWxYz0123456789AbCdEfGh";
const EDGE_PSK: &str = "Correct-Horse-Site-To-Site-Key-99";
const EDGE_PPPOE: &str = "isp-Pw93xnQ2";

fn ex_config() -> String {
    format!(
        "set system host-name ex-access-01\n\
         set system root-authentication encrypted-password \"{EX_ROOT}\"\n\
         set snmp community {EX_SNMP} authorization read-only\n\
         set vlans staff vlan-id 10\n\
         set interfaces ge-0/0/1 unit 0 family ethernet-switching interface-mode access\n\
         set interfaces ge-0/0/1 unit 0 family ethernet-switching vlan members staff\n\
         set interfaces ge-0/0/2 unit 0 family ethernet-switching interface-mode trunk\n\
         set interfaces ge-0/0/2 unit 0 family ethernet-switching vlan members staff\n\
         set interfaces ge-0/0/5 ether-options 802.3ad ae0\n\
         set interfaces ge-0/0/6 ether-options 802.3ad ae0\n\
         set interfaces ae0 aggregated-ether-options lacp active\n\
         set interfaces irb unit 10 family inet address 10.0.10.1/24\n\
         set protocols bgp group CORE neighbor 10.0.10.254 authentication-key {EX_BGP}\n"
    )
}

fn edge_config() -> String {
    format!(
        "set system host-name home-gw-01\n\
         set system login user admin authentication plaintext-password \"{EDGE_PLAIN}\"\n\
         set system login user bk authentication encrypted-password \"{EDGE_CRYPT}\"\n\
         set interfaces ethernet eth0 description \"WAN uplink\"\n\
         set interfaces ethernet eth0 pppoe 0 password \"{EDGE_PPPOE}\"\n\
         set interfaces switch switch0 vif 20 address 172.16.20.1/24\n\
         set vpn ipsec site-to-site peer 203.0.113.9 authentication pre-shared-secret \"{EDGE_PSK}\"\n"
    )
}

const SRX_PSK: &str = "Srx-IKE-Pre-Shared-Key-Of-A-Realistic-Length-0042";
const SHORT: &str = "hunter22";

fn srx_config() -> String {
    format!("set system host-name srx-branch-01\n\
     set security ike policy P1 pre-shared-key ascii-text \"{SRX_PSK}\"\n\
     set snmp community {SHORT} authorization read-only\n\
     set security zones security-zone trust interfaces ge-0/0/1.0\n\
     set security zones security-zone untrust interfaces ge-0/0/0.0\n\
     set security policies from-zone trust to-zone untrust policy allow-out match source-address any\n\
     set security policies from-zone trust to-zone untrust policy allow-out then permit\n")
}

fn platform_of(reply: &[u8]) -> String {
    match decode_reply(reply).expect("well-formed") {
        ReplyView::FaceRows(rows) => rows[0].strings[7].clone(),
        other => panic!("expected an estate, got {other:?}"),
    }
}

fn refusal(reply: &[u8]) -> (u16, String) {
    match decode_reply(reply).expect("well-formed") {
        ReplyView::Error(e) => (e.code, e.detail),
        other => panic!("expected a refusal, got {other:?}"),
    }
}

#[test]
fn each_platform_is_detected_with_all_four_booted() {
    for (text, want) in [
        (srx_config(), "junos-srx"),
        (ex_config(), "junos-ex"),
        (edge_config(), "edgeos"),
    ] {
        let mut shell = common::all_booted_shell();
        let got = platform_of(&shell.handle(OP_PASTE, &frame(0, &text)));
        assert_eq!(got, want);
    }
}

#[test]
fn a_named_platform_is_used_and_detection_is_skipped() {
    let mut shell = common::all_booted_shell();
    let flag = named("junos-ex");
    let got = platform_of(&shell.handle(OP_PASTE, &frame(flag, &ex_config())));
    assert_eq!(got, "junos-ex");
}

#[test]
fn an_unsure_paste_is_refused_with_candidates_and_stores_nothing() {
    // Names, interfaces and addresses read about equally under SRX and EX.
    let text = "set system host-name sw1\nset interfaces ge-0/0/1 description uplink\n";
    let mut shell = common::all_booted_shell();
    platform_of(&shell.handle(OP_PASTE, &frame(0, &srx_config())));
    let before = shell.handle(OP_EXPORT_PLAIN, &[]);
    let (code, detail) = refusal(&shell.handle(OP_PASTE, &frame(0, text)));
    assert_eq!(code, ERR_PLATFORM_CHOICE);
    assert_eq!(
        shell.handle(OP_EXPORT_PLAIN, &[]),
        before,
        "a refusal stores nothing"
    );
    assert!(
        detail.contains("junos-srx") && detail.contains("junos-ex"),
        "{detail}"
    );
    // Answering the question works.
    let got = platform_of(&shell.handle(OP_PASTE, &frame(named("junos-srx"), text)));
    assert_eq!(got, "junos-srx");
}

#[test]
fn text_no_platform_understands_is_refused_before_storage() {
    let mut shell = common::all_booted_shell();
    platform_of(&shell.handle(OP_PASTE, &frame(0, &srx_config())));
    let before = shell.handle(OP_EXPORT_PLAIN, &[]);
    let secret = "UnrecognisedSecretValue-0123456789";
    let text = format!("hostname r1\nenable secret 9 {secret}\n");
    let (code, _) = refusal(&shell.handle(OP_PASTE, &frame(0, &text)));
    assert_eq!(code, ERR_NOTHING_UNDERSTOOD);
    assert_eq!(shell.handle(OP_EXPORT_PLAIN, &[]), before);
}

#[test]
fn an_unknown_platform_code_is_a_bad_frame() {
    let mut shell = common::all_booted_shell();
    let (code, _) = refusal(&shell.handle(OP_PASTE, &frame(0x0a, "set system host-name x\n")));
    assert_eq!(code, ERR_PASTE_FRAME);
}

#[test]
fn no_secret_survives_for_any_platform() {
    let cases: [(&str, String, &[&str]); 3] = [
        ("junos-ex", ex_config(), &[EX_ROOT, EX_SNMP, EX_BGP]),
        (
            "edgeos",
            edge_config(),
            &[EDGE_PLAIN, EDGE_CRYPT, EDGE_PSK, EDGE_PPPOE],
        ),
        ("junos-srx", srx_config(), &[SRX_PSK, SHORT]),
    ];
    for (platform, text, secrets) in cases {
        // Named and detected both: the gate is not a property of the route taken.
        for flags in [0, named(platform)] {
            let mut shell = common::all_booted_shell();
            let reply = shell.handle(OP_PASTE, &frame(flags, &text));
            assert_eq!(platform_of(&reply), platform);
            let stored = shell.handle(OP_EXPORT_PLAIN, &[]);
            for s in secrets {
                assert!(!contains(&reply, s), "{platform} reply leaks {s}");
                assert!(!contains(&stored, s), "{platform} stored design leaks {s}");
            }
        }
    }
}

#[test]
fn a_pasted_note_is_redacted_with_every_set_form_dictionary() {
    let note = format!("{}\n{}", ex_config(), edge_config());
    let mut shell = common::all_booted_shell();
    let reply = shell.handle(OP_REDACT_TEXT, note.as_bytes());
    for s in [
        EX_ROOT, EX_SNMP, EX_BGP, EDGE_PLAIN, EDGE_CRYPT, EDGE_PSK, EDGE_PPPOE,
    ] {
        assert!(!contains(&reply, s), "the note reply leaks {s}");
    }
}

/// The door that stores gated text (`Capture.text`): paste under a placed device, with a
/// hint and without. Secrets must be absent from the stored design and the reply.
#[test]
fn paste_into_gates_every_platform_and_stores_no_secret() {
    let cases: [(&str, String, Vec<&str>); 3] = [
        ("junos-ex", ex_config(), vec![EX_ROOT, EX_SNMP, EX_BGP]),
        (
            "edgeos",
            edge_config(),
            vec![EDGE_PLAIN, EDGE_CRYPT, EDGE_PSK, EDGE_PPPOE],
        ),
        ("junos-srx", srx_config(), vec![SRX_PSK, SHORT]),
    ];
    for (platform, text, secrets) in cases {
        for flags in [0, named(platform)] {
            let mut shell = common::all_booted_shell();
            let display = place(&mut shell, platform);
            let reply = shell.handle(OP_PASTE_INTO, &into_frame(flags, &display, &text));
            assert_eq!(platform_of(&reply), platform);
            let stored = shell.handle(OP_EXPORT_PLAIN, &[]);
            assert!(
                contains(&stored, "REDACTED"),
                "{platform}: the capture is stored, gated"
            );
            for s in &secrets {
                assert!(!contains(&reply, s), "{platform} reply leaks {s}");
                assert!(!contains(&stored, s), "{platform} stored capture leaks {s}");
            }
        }
    }
}

#[test]
fn a_pasted_note_is_redacted_once_per_secret_with_the_platforms_label() {
    let mut shell = common::all_booted_shell();
    let note = "set system login user admin authentication plaintext-password \"Hx7!pq2W-realistic-pass\"\n";
    let reply = shell.handle(OP_REDACT_TEXT, note.as_bytes());
    match decode_reply(&reply).expect("well-formed") {
        ReplyView::FaceRows(rows) => {
            let drops = rows
                .iter()
                .filter(|r| r.role == fathom_wasm::protocol::FACE_DROP)
                .count();
            assert_eq!(
                drops, 1,
                "one secret, one drop row, however many dictionaries ran"
            );
            assert!(!contains(&reply, "Hx7!pq2W"));
            assert!(
                !contains(&reply, "REDACTED:unknown"),
                "a later pass must not relabel"
            );
        }
        other => panic!("{other:?}"),
    }
}
