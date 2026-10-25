//! `corpus/dict/unifi-sw/` through `crates/fathom-ingest/src/blockcfg.rs`
//! (dialect `UNIFI`): a UniFi switch's `show running-config`, pasted with the
//! session that produced it, binds its interfaces, VLAN names and hostname, and
//! every credential line the EdgeSwitch CLI documents is destroyed before
//! anything is stored.
//!
//! THE CAPTURE IS PARTLY SYNTHETIC, AND SAYS WHERE. No complete real UniFi
//! running-config was found (README-unifi-sw.md). Real UniFi text, read
//! 2026-10-16, is used where it exists:
//! - the session and header, from a USW-48P-500 (jcutrer.com, "unifi switch
//!   cli config ssh", undated);
//! - the interface block and the closing `exit` and `quit`, from US-series
//!   switches (ytti/oxidized issue 1003, 2017-08-30; a dan.langille.org reader
//!   comment, 2020-11-04).
//!
//! The rest follows Broadcom EFOS's real output shape (ytti/oxidized spec data
//! `efos#BES-53248_3.12.0.1`), which prints nothing indented and closes every
//! block with `exit`, and the EdgeSwitch CLI Command Reference's syntax.
//!
//! CREDENTIAL SHAPE, CLAUDE.md rule 2. The limits are the EdgeSwitch CLI
//! Command Reference's (help.uisp.com article 22591720570135; manualslib
//! 858408), read 2026-10-16:
//! - user, enable and line passwords: 8 to 64 characters;
//! - their `encrypted` form: exactly 128 hexadecimal characters;
//! - SNMP community: up to 16; `community-group` and `snmp-server host`: 1 to 20;
//! - SNMPv3 passwords: 1 to 32; `auth-sha-key`: 48 characters;
//! - TACACS+ keys: 0 to 128.
//!
//! The encrypted form exists to "transfer local user passwords between devices
//! without having to know the passwords", so it is a credential and is
//! destroyed like one.

use std::path::{Path, PathBuf};

use fathom_ingest::blockcfg::{ingest_unifi, looks_like_tplink, looks_like_unifi};
use fathom_ingest::dict::Dictionary;
use fathom_ingest::frame::LineOutcome;
use fathom_ir::generated::ir_types::NodeKind;

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .nth(2)
        .expect("the crate lives two levels under the repo root")
        .to_path_buf()
}

fn dict() -> Dictionary {
    Dictionary::load_platform(&repo_root(), "unifi-sw").expect("the unifi-sw dictionary loads")
}

fn read(paste: &str) -> fathom_ingest::IngestOutput {
    ingest_unifi(paste.as_bytes(), &dict()).expect("within the caps")
}

/// 128 hexadecimal characters: the `encrypted` form's documented length.
const HEX128_A: &str = "DE0AFC3B05E98A53ADD2B32A72AD2D88FD4CC95C3BAE6453B21F45711E4AC039787093CEE1353C6A713F3C097443FDB6EEFB3F2BC24A28799E28C66CC9DFB6D6";
const HEX128_B: &str = "6e89b5b29622e284e07223e075272bbcd8907b79b93e173b83e14886b8bda25c3b9e0b44b2eb11d225804bd7edf0a9b976e3a38e8cfa3e2831dfacbd4be4cac6";
/// 48 characters: `auth-sha-key`'s documented length.
const HEX48: &str = "997967947b5763f17237abc8a46e104a8ee3546a7531870d";

fn capture() -> String {
    format!(
        "BusyBox v1.19.4 (2017-07-12 21:42:26 PDT) built-in shell (ash)\n\
Enter 'help' for a list of built-in commands.\n\
US.v3.8.6# telnet localhost\n\
Entering character mode\n\
Escape character is '^]'.\n\
Warning! The changes may break controller settings and only be effective until reboot.\n\
(UBNT) >enable\n\
(UBNT) #show run\n\
!Current Configuration:\n\
!\n\
!System Description \"USW-48P-500,, Linux 3.6.5\"\n\
!System Software Version \"\"\n\
!System Up Time \"61 days 16 hrs 24 mins 2 secs\"\n\
!Additional Packages QOS,IPv6 Management\n\
!\n\
hostname \"rack-sw-1\"\n\
vlan database\n\
vlan 10,20,30\n\
vlan name 10 \"Servers\"\n\
vlan name 20 \"Cameras\"\n\
exit\n\
\n\
configure\n\
username \"admin\" password {HEX128_A} level 15 encrypted\n\
username \"ops\" password Op3rator!x level 1\n\
enable password Sixty-Four-Characters-Long-Enable-Password-0123456789-abcdefghi\n\
line console\n\
password {HEX128_B} encrypted\n\
exit\n\
\n\
line telnet\n\
exit\n\
\n\
snmp-server community \"c\" ro\n\
snmp-server community \"public-16chars-x\" rw\n\
snmp-server community-group \"cg-20-characters-xx\" grp1\n\
snmp-server host 192.0.2.9 \"trap-community-20chr\"\n\
snmp-server user u1 grp1 auth-sha AuthPass1 priv-des PrivPass1\n\
snmp-server user u2 grp1 auth-sha-key {HEX48}\n\
snmp-server user u3 grp1 auth-md5 z\n\
radius server key auth 192.0.2.5 encrypted {HEX128_A}\n\
tacacs-server key encrypted {HEX128_B}\n\
tacacs-server keystring TacKeyString9\n\
interface 0/1\n\
description \"uplink\"\n\
voice vlan dot1p 0\n\
switchport mode trunk\n\
vlan participation include 10,20\n\
vlan tagging 10,20\n\
port-security max-dynamic 3\n\
exit\n\
\n\
interface 0/2\n\
description \"camera-1\"\n\
vlan pvid 20\n\
vlan participation include 20\n\
exit\n\
\n\
interface 0/3\n\
shutdown\n\
exit\n\
\n\
monitor session 1 destination interface 0/16\n\
monitor session 1 source interface 0/2\n\
monitor session 1 mode\n\
exit\n\
\n\
\n\
(UBNT) #quitConnection closed by foreign host\n\
US.v3.8.6#\n"
    )
}

const SECRETS: [&str; 15] = [
    HEX128_A,
    HEX128_B,
    HEX48,
    "Op3rator!x",
    "Sixty-Four-Characters-Long-Enable-Password",
    "public-16chars-x",
    "cg-20-characters-xx",
    "trap-community-20chr",
    "AuthPass1",
    "PrivPass1",
    "TacKeyString9",
    // Pieces, so a partial survival is caught too.
    "DE0AFC3B05E98A53",
    "4be4cac6",
    "0123456789-abcdefghi",
    "a46e104a8ee",
];

#[test]
fn the_capture_is_sniffed_as_unifi_and_not_tplink() {
    assert!(looks_like_unifi(capture().as_bytes()));
    assert!(!looks_like_tplink(capture().as_bytes()));
}

#[test]
fn interfaces_vlan_names_and_the_hostname_bind() {
    let out = read(&capture());
    let kinds: Vec<NodeKind> = out.fragment.nodes.iter().map(|n| n.kind).collect();
    let count = |k: NodeKind| kinds.iter().filter(|x| **x == k).count();
    assert_eq!(count(NodeKind::Interface), 3, "{kinds:?}");
    assert_eq!(count(NodeKind::Vlan), 2, "{kinds:?}");
    let s = format!("{:?}", out.fragment);
    for want in [
        "rack-sw-1",
        "\"0/2\"",
        "\"camera-1\"",
        "\"Cameras\"",
        "Bool(false)",
    ] {
        assert!(s.contains(want), "{want} not bound:\n{s}");
    }
    // `vlan pvid 20` inside an interface is not a block of its own: the
    // description after it still belongs to the interface.
    assert!(!s.contains("pvid"));
}

#[test]
fn every_documented_credential_is_destroyed() {
    let out = read(&capture());
    let text = out.capture.text();
    let frag = format!("{:?}", out.fragment);
    for secret in SECRETS {
        assert!(!text.contains(secret), "{secret:?} survived:\n{text}");
        assert!(!frag.contains(secret), "{secret:?} reached the fragment");
    }
    // Short values are whole words on a real device: a one-character
    // community, and a one-character SNMPv3 password.
    for line in text.lines() {
        let w: Vec<&str> = line.split_whitespace().collect();
        assert!(!w.contains(&"\"c\""), "{line}");
        assert!(
            !(w.first() == Some(&"snmp-server") && w.last() == Some(&"z")),
            "{line}"
        );
    }
    // What is not a credential survives.
    assert!(text.contains("rack-sw-1"));
    assert!(text.contains("interface 0/2"));
}

/// A command typed at the EdgeSwitch prompt carries its value in clear.
#[test]
fn a_credential_typed_at_the_prompt_is_destroyed() {
    let paste = format!(
        "(UBNT) (Config)#snmp-server user u9 grp1 auth-sha Typed-Auth-1 priv-des Typed-Priv-1\n\
(UBNT) (Config)#username \"bob\" password Typed-Pass-99 level 1\n{}",
        capture()
    );
    assert!(looks_like_unifi(paste.as_bytes()));
    let out = read(&paste);
    for secret in ["Typed-Auth-1", "Typed-Priv-1", "Typed-Pass-99"] {
        assert!(!out.capture.text().contains(secret), "{secret} survived");
    }
}

/// EdgeSwitch's pager, run together with the next line of output.
#[test]
fn a_credential_after_the_pager_is_destroyed() {
    let paste = capture().replace(
        "snmp-server community \"c\" ro\n",
        "--More-- or (q)uitsnmp-server user u7 grp1 auth-sha Pager-Auth-1\n",
    );
    let out = read(&paste);
    assert!(
        !out.capture.text().contains("Pager-Auth-1"),
        "{}",
        out.capture.text()
    );
}

#[test]
fn the_set_form_shaper_reads_nothing_of_it() {
    let out = fathom_ingest::ingest(capture().as_bytes(), &dict()).expect("within the caps");
    assert_eq!(out.fragment.nodes.len(), 1, "only the implicit Device root");
}

#[test]
fn the_ledger_names_every_line() {
    let out = read(&capture());
    assert_eq!(out.ledger.lines.len(), capture().split('\n').count());
    let bound = out
        .ledger
        .lines
        .iter()
        .filter(|e| matches!(e.outcome, LineOutcome::Bound { .. }))
        .count();
    // The hostname, two VLAN names, three interfaces and three lines under them.
    assert_eq!(bound, 9);
}

/// The UniFi header and then `body`, as a paste.
fn with_header(body: &str) -> String {
    format!(
        "!Current Configuration:\n\
!\n\
!System Description \"USW-48P-500,, Linux 3.6.5\"\n\
!\n\
hostname \"rack-sw-1\"\n{body}\n"
    )
}

/// `line`, cut into the 80-column pieces a hard-wrapping terminal prints.
fn wrap80(line: &str) -> String {
    let chars: Vec<char> = line.chars().collect();
    chars
        .chunks(80)
        .map(|c| c.iter().collect::<String>())
        .collect::<Vec<_>>()
        .join("\n")
}

fn assert_gone(paste: &str, secrets: &[&str]) {
    assert!(looks_like_unifi(paste.as_bytes()));
    let out = read(paste);
    let text = out.capture.text();
    let frag = format!("{:?}", out.fragment);
    for secret in secrets {
        assert!(!text.contains(secret), "{secret:?} survived:\n{text}");
        assert!(!frag.contains(secret), "{secret:?} reached the fragment");
    }
}

/// A terminal that hard-wraps at 80 columns can split a credential line
/// anywhere: inside the value, onto a third line, at the keyword, inside the
/// keyword, or before a word that looks like a separator or an opener.
#[test]
fn a_credential_wrapped_by_the_terminal_is_destroyed() {
    // Onto a third line: 171 characters.
    let radius = format!("radius server key auth 192.0.2.5 encrypted {HEX128_A}");
    assert_gone(&with_header(&wrap80(&radius)), &["66CC9DFB6D6"]);
    let user = format!("(UBNT) (Config)#username \"admin\" password {HEX128_A} level 15 encrypted");
    assert_gone(&with_header(&wrap80(&user)), &["6CC9DFB6D6"]);
    // The keyword ends at the break.
    let name = "n".repeat(60);
    let at_break = format!("username \"{name}\" password");
    assert_eq!(at_break.len(), 80);
    assert_gone(
        &with_header(&format!("{at_break}\n Op3rator!xY level 1")),
        &["Op3rator!xY"],
    );
    // The keyword split by the break.
    let pad = "u".repeat(80 - "snmp-server user  grp1 auth-".len());
    let split = format!("snmp-server user {pad} grp1 auth-");
    assert_eq!(split.len(), 80);
    assert_gone(
        &with_header(&format!("{split}\nsha AuthPass1x priv-des PrivPass1x")),
        &["AuthPass1x", "PrivPass1x"],
    );
    let pad = "a".repeat(80 - "(UBNT) (Config)#username \"\" passw".len());
    let split = format!("(UBNT) (Config)#username \"{pad}\" passw");
    assert_eq!(split.len(), 80);
    assert_gone(
        &with_header(&format!("{split}\nord Op3rator!xY level 1")),
        &["Op3rator!xY"],
    );
    // The rest begins with `!`, or with an opener's word.
    let enable = format!("(UBNT) (Config)#enable password {}", "P".repeat(48));
    assert_gone(
        &with_header(&format!("{enable}\n!tail-secret-xyz")),
        &["tail-secret-xyz"],
    );
    let pad = "x".repeat(80 - "(UBNT) (Config)#username \"bob\" password \"".len());
    let quoted = format!("(UBNT) (Config)#username \"bob\" password \"{pad}");
    assert_eq!(quoted.len(), 80);
    assert_gone(
        &with_header(&format!("{quoted}\nline of my long passphrase\" level 1")),
        &["of my long passphrase"],
    );
}

/// What a session log or a copy from a web page leaves between words:
/// backspaces and escape codes from the pager, and no-break spaces.
#[test]
fn control_bytes_and_nbsp_do_not_hide_a_keyword() {
    let host = "snmp-server host 192.0.2.9 \"trap-community-20chr\"";
    for lead in [
        "--More-- or (q)uit\x08\x08\x08\x08\x08\x08",
        "\x1b[7m--More-- or (q)uit\x1b[m",
        "\x08\x08\x08\x08",
    ] {
        assert_gone(
            &with_header(&format!("{lead}{host}")),
            &["trap-community-20chr"],
        );
    }
    assert_gone(
        &with_header("snmp-server\u{a0}host 192.0.2.9 \"trap-community-20chr\""),
        &["trap-community-20chr"],
    );
    assert_gone(
        &with_header("snmp-server user u1 grp1 auth-sha\u{a0}AuthPass1x"),
        &["AuthPass1x"],
    );
}

/// A hostname this reader's prompt rule does not take still leaves the
/// `snmp-server host` rule in force.
#[test]
fn an_odd_prompt_does_not_hide_a_community() {
    for prompt in ["(SW#1) (Config)#", "(\"rack\") (Config)#"] {
        assert_gone(
            &with_header(&format!(
                "{prompt}snmp-server host 192.0.2.9 \"trap-community-20chr\""
            )),
            &["trap-community-20chr"],
        );
    }
}

/// FASTPATH-style forms not confirmed for UniFi, and SNMPv3 algorithm names
/// past the ones the EdgeSwitch reference lists.
#[test]
fn unconfirmed_credential_forms_are_destroyed() {
    assert_gone(
        &with_header(
            "interface 0/1\n\
ip ospf authentication simple OspfSimple3\n\
ip ospf authentication encrypt OspfEncr4 1\n\
ip rip authentication simple RipSimple5\n\
ip vrrp 1 authentication simple VrrpKey7\n\
exit\n\
users snmpv3 encryption \"admin\" des EncKey12345\n\
snmp-server user u4 grp1 auth-sha256 Sha256Pass1 priv-aes256 Aes256Pass1\n\
snmp-server user u5 grp1 auth-sha512 Sha512Pass1 priv-3des TripleDes1",
        ),
        &[
            "OspfSimple3",
            "OspfEncr4",
            "RipSimple5",
            "VrrpKey7",
            "EncKey12345",
            "Sha256Pass1",
            "Aes256Pass1",
            "Sha512Pass1",
            "TripleDes1",
        ],
    );
}
