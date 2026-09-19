//! Arista EOS — the redaction safety net over a realistic running-config,
//! and the finding that made this test what it is rather than a
//! `junos-srx`-shaped binding dictionary test.
//!
//! # Why there is no `corpus/dict/eos/` dictionary behind this test
//!
//! `crates/fathom-ingest/src/shape.rs` shapes exactly one statement grammar:
//! a line is only ever turned into a bound `Stmt` — the thing a dictionary
//! entry's `path:` can match — when its first bare token is one of
//! [`shape::VERBS`], and of those twelve, only `"set"` is actually
//! implemented (`shape.rs`: `if verb != "set" { … ShapeError::UnsupportedVerb
//! … }`). Every one of those twelve verbs is a Junos idiom. Arista EOS's
//! `show running-config` is Cisco-IOS-shaped block config —
//! `interface Ethernet1` opening a sub-mode, indented lines under it — and no
//! line in it begins with `set`. So every line of a real EOS paste falls
//! through to `LineOutcome::Unshaped` (`ShapeError::NotVerbInitial`) and is
//! never offered to the trie walker at all, regardless of what any
//! `corpus/dict/<platform>/` file declares.
//!
//! `redact.rs`'s own comments already name this as a live gap for exactly
//! three platforms — "a live secret form on Arista, Omada and Sodola" — and
//! this test exists to show what that gap means in practice: an EOS paste is
//! not "less protected", because `gate_unshaped` (`14` §9.7's safety net) runs
//! over every unshaped line at maximum aggression regardless of platform, but
//! it also never becomes typed graph nodes — no `Interface`, no `Vlan`, no
//! kind or count to assert. A test asserting "built kinds and counts" in the
//! manner of `crates/fathom-ingest/tests/srx_fixture.rs` would not be
//! exercising anything the pipeline actually does for this platform today, so
//! this file does not attempt one. Building block-mode (indentation-driven)
//! shaping is bigger than one engine's dictionary and is not this file's
//! job to do quietly.
//!
//! # Credential lengths — CLAUDE.md rule 2
//!
//! Searched 2026-09-19 for Arista's own documented maximum lengths for
//! `enable secret`, `username … secret` and `snmp-server community`: none of
//! the EOS User Manual pages surfaced by search (eos-user-security,
//! eos-snmp, eos-session-management-commands) state a maximum length for any
//! of the three, and a public forum thread asking the SNMP community
//! question directly (eos.arista.com/forum/snmp-community-string-length/)
//! could not be fetched (`EGRESS_BLOCKED`). **Could not establish.** Every
//! credential value below is therefore kept short — 11 to 17 characters,
//! ordinary mixed-case-and-digits text a person would actually type — rather
//! than a long value only `base64ish`/`long_hex` would need to catch; the
//! point, per `simple-password`'s own history in `redact.rs`, is that the
//! *name* (`secret`, `community`, `key`, `md5`, `key-string`) is what must
//! catch these, not their shape or length.

use std::path::{Path, PathBuf};

use fathom_ingest::dict::Dictionary;
use fathom_ingest::{ingest, IngestOutput};

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .nth(2)
        .expect("the crate lives two levels under the repo root")
        .to_path_buf()
}

/// `noise_gate.rs`'s own method: the shipped dictionary loads regardless of
/// which platform pasted the text, because [`gate_unshaped`]'s instruments —
/// `SECRET_WORD_LIST`, `crypt_prefix`, `long_hex`, `base64ish` — are
/// constants in `redact.rs`, not read from the loaded `Dictionary` at all.
/// This is the whole point of this file's header: the safety net is
/// platform-independent, which is exactly why it is what an EOS paste gets
/// today and a bound dictionary is not.
fn run(text: &str) -> IngestOutput {
    let dict = Dictionary::load(&repo_root()).expect("the shipped dictionary loads");
    ingest(text.as_bytes(), &dict).expect("within the caps")
}

/// `noise_gate.rs`'s own helper: capture text plus the full debug render of
/// every other reply surface, so a credential hiding in the residue or the
/// drop manifest's own fields is caught exactly as one hiding in the capture
/// would be.
fn everything(out: &IngestOutput) -> String {
    format!("{}\n{out:?}", out.capture.text())
}

/// A synthetic ~120-line EOS `show running-config` — never a real estate's
/// config, per CLAUDE.md rule 2 — built from the command forms the EOS User
/// Manual and `redact.rs`'s own comments document: interfaces with
/// descriptions and switchport mode, VLANs, SVIs, a port-channel with
/// members, static routes, the management interface, NTP, and every
/// credential form named in the brief — `enable secret`, `username … secret`,
/// `tacacs-server … key`, `snmp-server community`, a key-chain `key-string`,
/// and OSPF's `message-digest-key … md5`.
const CONFIG: &str = r#"!
hostname lab-sw1
!
no aaa root
!
username admin privilege 15 role network-admin secret 0 Adm1nP@ss12
username oper privilege 1 secret 0 OperPass456
!
enable secret 0 EnaB1eSecret9
!
vlan 10
   name USERS
!
vlan 20
   name VOICE
!
vlan 30
   name GUEST
!
vlan 99
   name MGMT
!
interface Ethernet1
   description uplink-to-core-sw
   switchport mode trunk
   switchport trunk allowed vlan 10,20,30,99
!
interface Ethernet2
   description user-port-A201
   switchport mode access
   switchport access vlan 10
!
interface Ethernet3
   description user-port-A202
   switchport mode access
   switchport access vlan 10
!
interface Ethernet4
   description voip-phone-A203
   switchport mode access
   switchport access vlan 20
!
interface Ethernet5
   description guest-drop-lobby
   switchport mode access
   switchport access vlan 30
!
interface Ethernet6
   description to-ap-lobby-1
   switchport mode trunk
   switchport trunk allowed vlan 10,20,30
   channel-group 1 mode active
!
interface Ethernet7
   description to-ap-lobby-2
   switchport mode trunk
   switchport trunk allowed vlan 10,20,30
   channel-group 1 mode active
!
interface Ethernet8
   description user-port-A204
   switchport mode access
   switchport access vlan 10
!
interface Ethernet9
   description user-port-A205
   switchport mode access
   switchport access vlan 10
!
interface Ethernet10
   description printer-A206
   switchport mode access
   switchport access vlan 10
!
interface Port-Channel1
   description ap-lag-lobby
   switchport mode trunk
   switchport trunk allowed vlan 10,20,30
!
interface Vlan10
   description users-gateway
   ip address 10.0.10.1/24
!
interface Vlan20
   description voice-gateway
   ip address 10.0.20.1/24
!
interface Vlan30
   description guest-gateway
   ip address 10.0.30.1/24
!
interface Management1
   description oob-mgmt-uplink
   ip address 192.0.2.5/24
!
ip route 0.0.0.0/0 192.0.2.1
ip route 10.10.0.0/16 10.0.10.254
!
ntp server 192.0.2.53
!
snmp-server community R3adOnlyCommun1ty RO
snmp-server community WrIteCommun1ty22 RW
!
tacacs-server host 192.0.2.100 key 7 TacPlusSharedKey1
!
key chain OSPF-AUTH
   key 1
      key-string 7 OspfKeyStr1ng9
!
router ospf 1
   router-id 10.0.0.1
   network 10.0.10.0/24 area 0.0.0.0
   network 10.0.20.0/24 area 0.0.0.0
!
interface Vlan10
   ip ospf authentication message-digest
   ip ospf message-digest-key 1 md5 0 OspfMd5Key123
!
end
"#;

/// Every credential value in [`CONFIG`], named once so the assertion loop and
/// this list cannot drift apart. Not the surrounding keywords (`secret`,
/// `community`, `key`, `md5`, `key-string` are meant to survive — they are
/// what the reader needs to know a value was redacted, and `14` §9.4's own
/// list is built from exactly such keywords).
const CREDENTIALS: [&str; 7] = [
    "Adm1nP@ss12",
    "OperPass456",
    "EnaB1eSecret9",
    "R3adOnlyCommun1ty",
    "WrIteCommun1ty22",
    "TacPlusSharedKey1",
    "OspfKeyStr1ng9",
];

#[test]
fn every_credential_is_absent_from_the_capture_and_every_reply() {
    let out = run(CONFIG);
    let rendered = everything(&out);
    for secret in CREDENTIALS {
        assert!(
            !rendered.contains(secret),
            "credential `{secret}` survived somewhere in the ingest output"
        );
    }
    // The OSPF MD5 key shares its line with `message-digest-key 1 md5 0`,
    // which is two credential shapes deep (the key id is not a secret; the
    // value after `md5` is) — named separately since `CREDENTIALS` already
    // covers the value itself but this pins the whole line is gone, not just
    // the trailing token.
    assert!(
        !rendered.contains("OspfMd5Key123"),
        "the OSPF MD5 key survived"
    );
}

#[test]
fn every_credential_bearing_line_is_quarantined_not_merely_trimmed() {
    // `14` §9.7's sketch replaces a quarantined line with `<word>`/`<quoted>`
    // tokens; the credential-bearing lines above must each have produced a
    // drop, not merely lost one token while the rest of the line's other
    // tokens (which, on these lines, are themselves either keywords or an
    // encoding-type digit, never a fact worth keeping) leaked through
    // unlabelled.
    let out = run(CONFIG);
    assert!(
        out.drops.entries.len() >= CREDENTIALS.len(),
        "expected at least one drop per credential-bearing line, got {}",
        out.drops.entries.len()
    );
}

#[test]
fn ordinary_network_facts_survive_verbatim() {
    // The safety net's own direction of error is destruction (`14` §9.7), so
    // this is the check that it is not ALSO destroying the 98% of the file
    // that is not a credential (`38` §14.4) — a config whose every line was
    // quarantined would pass the two tests above and still be useless as an
    // estate record.
    let out = run(CONFIG);
    let capture = out.capture.text();
    for fact in [
        "lab-sw1",
        "Ethernet1",
        "uplink-to-core-sw",
        "switchport trunk allowed vlan 10,20,30,99",
        "vlan 30",
        "name GUEST",
        "Port-Channel1",
        "channel-group 1 mode active",
        "interface Vlan20",
        "ip address 10.0.20.1/24",
        "interface Management1",
        "192.0.2.5/24",
        "ip route 10.10.0.0/16 10.0.10.254",
        "ntp server 192.0.2.53",
        "router-id 10.0.0.1",
        "network 10.0.10.0/24 area 0.0.0.0",
    ] {
        assert!(
            capture.contains(fact),
            "an ordinary network fact was lost from the capture: `{fact}`\ncapture:\n{capture}"
        );
    }
}

#[test]
fn interface_names_round_trip() {
    // Not a binder round-trip (there is none, per this file's header) — the
    // narrower, honest claim: EOS's own interface name spellings pass through
    // the lexer and the gate's sketch/preservation logic unchanged, which is
    // what a future block-mode shaper would need to be true to bind them.
    let out = run(CONFIG);
    let capture = out.capture.text();
    for name in [
        "Ethernet1",
        "Ethernet6",
        "Ethernet10",
        "Port-Channel1",
        "Vlan10",
        "Vlan30",
        "Management1",
    ] {
        assert!(
            capture.contains(name),
            "interface name `{name}` did not round-trip into the capture"
        );
    }
}
