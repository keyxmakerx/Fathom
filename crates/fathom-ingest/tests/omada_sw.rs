//! `corpus/dict/omada-sw/` through `crates/fathom-ingest/src/blockcfg.rs`: two
//! real TP-Link switch configs, as their owners posted them to TP-Link's
//! community forum, bind their VLANs, interfaces and hostname, and every
//! credential line TP-Link documents is destroyed before anything is stored.
//!
//! THE CONFIGS. Rebuilt line by line from the posts, which lost their leading
//! whitespace on the way to the page (README-omada-sw.md, "Indentation"):
//! - a T2600G-28TS V3, posted 2020-01-09
//!   (community.tp-link.com/en/business/forum/topic/184910, page 2);
//! - a T1700G-28TQ Rev2 on firmware 2.0.1 Build 20180206, posted 2018-12-10
//!   as its "Actual Config.cfg" (community.tp-link.com/en/home/forum/topic/150823).
//!
//! Both read 2026-10-16. The posters' own hashes are not reproduced; the
//! values below are stand-ins of the shape the fetch reported.
//!
//! CREDENTIAL SHAPE, CLAUDE.md rule 2 ("test a safety gate against what a
//! real device accepts, not against what the detector needs"). The limits are
//! TP-Link's, from its configuration guides and the TL-SG3428 CLI reference
//! (sources in README-omada-sw.md, read 2026-10-16): a user password of 6 to
//! 31 characters, an SNMP community of 1 to 16, SNMPv3 `cpwd`/`epwd` of 1 to
//! 16, a RADIUS or TACACS+ key of at most 31. The values below sit at those
//! lengths, short ones included, and `user name tplink privilege admin
//! password 0 admin` is TP-Link's own example.

use std::path::{Path, PathBuf};

use fathom_ingest::blockcfg::{ingest_blockcfg, looks_like_tplink};
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
    Dictionary::load_platform(&repo_root(), "omada-sw").expect("the omada-sw dictionary loads")
}

fn read(paste: &str) -> fathom_ingest::IngestOutput {
    ingest_blockcfg(paste.as_bytes(), &dict()).expect("within the caps")
}

/// The T2600G-28TS config (topic 184910), with the poster's masked user name
/// kept and a stand-in for the 27-character secret that arrived with no type
/// digit.
const T2600G: &str = "!T2600G-28TS\n\
#\n\
vlan 10\n\
name \"ISPLAN\"\n\
#\n\
vlan 30\n\
name \"CAM\"\n\
#\n\
vlan 70\n\
name \"PCLAN\"\n\
#\n\
vlan 100\n\
name \"testvlan100\"\n\
#\n\
#\n\
#\n\
serial_port baud_rate 38400\n\
#\n\
logging host index 1 192.168.2.1 0\n\
#\n\
system-time ntp UTC+08:00 133.100.9.2 139.78.100.163 12\n\
no system-time dst\n\
#\n\
user name xxxxxx privilege admin secret @Q<7>:R;2!K)9=M'4}X8P1Z6W3N\n\
#\n\
service dhcp server\n\
ip dhcp server pool \"testvlan\"\n\
network 192.168.100.0 255.255.255.0\n\
default-gateway 192.168.100.1\n\
dns-server 192.168.100.1\n\
#\n\
snmp-server\n\
#\n\
ip route 0.0.0.0 0.0.0.0 192.168.2.254\n\
#\n\
service dhcp relay\n\
#\n\
interface vlan 10\n\
ip address-alloc dhcp\n\
description \"ISPROUTE\"\n\
no ipv6 enable\n\
#\n\
interface vlan 30\n\
ip address 192.168.30.1 255.255.255.0\n\
description \"CAM\"\n\
no ipv6 enable\n\
#\n\
interface gigabitEthernet 1/0/1\n\
switchport general allowed vlan 70 untagged\n\
switchport pvid 70\n\
\n\
#\n\
interface gigabitEthernet 1/0/2\n\
switchport general allowed vlan 10 untagged\n\
switchport pvid 10\n\
no switchport general allowed vlan 1\n\
\n\
#\n\
interface gigabitEthernet 1/0/28\n\
\n\
#\n\
end\n";

/// The T1700G-28TQ export (topic 150823), with a 40-character stand-in for
/// the `secret 5` value in the shape the fetch reported: `$1$`, three `$`, no
/// lower case, and `> @ = / ' } .` among its characters.
const T1700G: &str = "!T1700G-28TQRev2\r\n\
#\r\n\
#\r\n\
vlan 3998\r\n\
name \"CLI_A\"\r\n\
#\r\n\
vlan 4084\r\n\
name \"GERENCIA4084\"\r\n\
#\r\n\
\r\n\
#\r\n\
switch 1 provision T1700G-28TQRev2\r\n\
ip igmp snooping\r\n\
ip route 0.0.0.0 0.0.0.0 10.12.255.254\r\n\
user name admin privilege admin secret 5 $1$K>@=/'}.Q7R2K9M4X8P1Z6W3N5B0LJHG$T2Y.\r\n\
ip ssh server\r\n\
hostname \"SW_ALIANCA00\"\r\n\
location \"POP-CLICK.COM\"\r\n\
contact-info \"ADMIN\"\r\n\
system-time ntp UTC-03:00 10.12.255.254 139.78.100.163 12\r\n\
\r\n\
#\r\n\
interface vlan 4084\r\n\
ip address 10.12.255.113 255.255.255.0\r\n\
description \"GERENCIA4084\"\r\n\
\x20\x20\r\n\
#\r\n\
interface gigabitEthernet 1/0/1\r\n\
jumbo\r\n\
shutdown\r\n\
#\r\n\
interface ten-gigabitEthernet 1/0/28\r\n\
jumbo\r\n\
#\r\n\
#\r\n";

/// Every credential line TP-Link documents, at real lengths.
const CREDENTIALS: &str = "user name tplink privilege admin password 0 admin\n\
user name ops privilege operator password 0 Qz7#pw\n\
user name noc password 7 0D4E1B3C2A5F6E7D8C9B0A1F2E3D4C5B\n\
user name sre privilege admin password 0 Nine-Ten-Eleven-Twelve-Thirteen\n\
enable password 0 abc123\n\
enable admin password 0 En4ble-Me\n\
enable admin secret 5 $1$K>@=/'}.Q7R2K9M4X8P1Z6W3N5B0LJHG$T2Y.\n\
snmp-server community x read-only\n\
snmp-server community fathom-rw-16chr read-write\n\
snmp-server user ops local grp smode v3 slev authPriv cmode SHA cpwd Abc12345 emode DES epwd Def67890\n\
snmp-server host 192.0.2.9 162 pr1vate smode v2c slev noAuthNoPriv type trap\n\
radius-server host 192.0.2.5 auth-port 1812 acct-port 1813 key 0 Rad-Key-31-chars-long-exactly!!\n\
radius-server host 192.0.2.7 key 7 9F3C2B1A0E\n\
tacacs-server host 192.0.2.6 port 49 timeout 5 key 0 TacK3y\n";

/// The stored line that starts with `prefix`.
fn stored_line(out: &fathom_ingest::IngestOutput, prefix: &str) -> String {
    out.capture
        .text()
        .lines()
        .find(|l| l.trim_start().starts_with(prefix))
        .unwrap_or_else(|| panic!("no stored line starts {prefix:?}:\n{}", out.capture.text()))
        .to_owned()
}

fn kinds(out: &fathom_ingest::IngestOutput) -> Vec<NodeKind> {
    out.fragment.nodes.iter().map(|n| n.kind).collect()
}

fn count(out: &fathom_ingest::IngestOutput, k: NodeKind) -> usize {
    kinds(out).iter().filter(|x| **x == k).count()
}

#[test]
fn both_configs_are_sniffed() {
    assert!(looks_like_tplink(T2600G.as_bytes()));
    assert!(looks_like_tplink(T1700G.as_bytes()));
    let echoed = format!("T2600G-28TS#show running-config\n{T2600G}");
    assert!(looks_like_tplink(echoed.as_bytes()));
}

#[test]
fn the_t2600g_binds_its_vlans_and_interfaces() {
    let out = read(T2600G);
    assert_eq!(count(&out, NodeKind::Vlan), 4, "{:?}", kinds(&out));
    // vlan10, vlan30 and three gigabit ports.
    assert_eq!(count(&out, NodeKind::Interface), 5, "{:?}", kinds(&out));
    let s = format!("{:?}", out.fragment);
    for want in [
        "\"ISPLAN\"",
        "\"testvlan100\"",
        "\"gigabitEthernet1/0/2\"",
        "\"vlan30\"",
        "\"ISPROUTE\"",
    ] {
        assert!(s.contains(want), "{want} not bound:\n{s}");
    }
}

#[test]
fn the_t1700g_binds_its_hostname_and_a_shut_port() {
    let out = read(T1700G);
    assert_eq!(count(&out, NodeKind::Vlan), 2);
    assert_eq!(count(&out, NodeKind::Interface), 3, "{:?}", kinds(&out));
    let s = format!("{:?}", out.fragment);
    assert!(s.contains("SW_ALIANCA00"), "{s}");
    assert!(s.contains("\"ten-gigabitEthernet1/0/28\""), "{s}");
    assert!(s.contains("Bool(false)"), "{s}");
}

#[test]
fn the_real_configs_secrets_are_destroyed() {
    let a = read(T2600G);
    assert!(!a.capture.text().contains("@Q<7>:R;2!K)9=M'4}X8P1Z6W3N"));
    assert!(!format!("{:?}", a.fragment).contains("X8P1Z6W3N"));
    let b = read(T1700G);
    assert!(!b.capture.text().contains("Q7R2K9M4X8P1Z6W3N5B0LJHG"));
    assert!(!b.capture.text().contains("$T2Y."));
    assert!(!format!("{:?}", b.fragment).contains("X8P1Z6W3N"));
    // What is not a credential survives.
    assert!(b.capture.text().contains("SW_ALIANCA00"));
    assert!(b.capture.text().contains("10.12.255.113"));
}

#[test]
fn every_documented_credential_line_is_destroyed() {
    let paste = format!("!T2600G-28TS\n#\n{CREDENTIALS}#\nend\n");
    let out = read(&paste);
    let text = out.capture.text();
    let frag = format!("{:?}", out.fragment);
    for secret in [
        "Qz7#pw",
        "0D4E1B3C2A5F6E7D8C9B0A1F2E3D4C5B",
        "Nine-Ten-Eleven-Twelve-Thirteen",
        "abc123",
        "En4ble-Me",
        "Q7R2K9M4X8P1Z6W3N5B0LJHG",
        "$T2Y.",
        "fathom-rw-16chr",
        "Abc12345",
        "Def67890",
        "pr1vate",
        "Rad-Key-31-chars-long-exactly!!",
        "9F3C2B1A0E",
        "TacK3y",
    ] {
        assert!(!text.contains(secret), "{secret:?} survived:\n{text}");
        assert!(!frag.contains(secret), "{secret:?} reached the fragment");
    }
    // Short values are whole words on a real device: a one-character
    // community, and TP-Link's own example password `admin`.
    for line in text.lines() {
        let w: Vec<&str> = line.split_whitespace().collect();
        assert!(
            !(w.starts_with(&["snmp-server", "community"]) && w.get(2) == Some(&"x")),
            "{line}"
        );
        assert!(
            !(w.first() == Some(&"user") && w.last() == Some(&"admin")),
            "{line}"
        );
    }
    // Every line is accounted for, none of it bound.
    assert_eq!(out.fragment.nodes.len(), 1);
}

/// The words after a credential's first word go too: `cpwd` is followed by
/// `emode DES epwd …` on the same line, and nothing after `cpwd` survives,
/// whatever the safety-net sweep proposes for the first of those words.
#[test]
fn nothing_after_the_first_keyword_survives() {
    let paste = "!T2600G-28TS\n#\nsnmp-server user ops local grp smode v3 slev authPriv cmode SHA cpwd Abc12345 emode DES epwd Def67890\n#\n";
    let out = read(paste);
    let line = stored_line(&out, "snmp-server user");
    assert!(line.contains("cpwd "), "{line}");
    let after = line.split("cpwd ").nth(1).unwrap_or_default();
    for gone in ["Abc12345", "emode", "DES", "epwd", "Def67890"] {
        assert!(!after.contains(gone), "{gone} survived: {line}");
    }
}

#[test]
fn prompts_and_the_pager_are_not_read_as_config() {
    let paste = format!(
        "T2600G-28TS#show running-config\n{}Press any key to continue (Q to quit)\n{}",
        &T2600G[..T2600G.find("serial_port").unwrap()],
        &T2600G[T2600G.find("serial_port").unwrap()..]
    );
    let out = read(&paste);
    assert_eq!(count(&out, NodeKind::Vlan), 4);
    assert_eq!(count(&out, NodeKind::Interface), 5);
}

#[test]
fn the_set_form_shaper_reads_nothing_of_it() {
    let out = fathom_ingest::ingest(T2600G.as_bytes(), &dict()).expect("within the caps");
    assert_eq!(out.fragment.nodes.len(), 1, "only the implicit Device root");
}

#[test]
fn the_ledger_names_every_line() {
    let out = read(T2600G);
    assert_eq!(out.ledger.lines.len(), T2600G.split('\n').count());
    let bound = out
        .ledger
        .lines
        .iter()
        .filter(|e| matches!(e.outcome, LineOutcome::Bound { .. }))
        .count();
    assert!(bound >= 13, "got {bound}");
    let separators = out
        .ledger
        .lines
        .iter()
        .filter(|e| matches!(e.outcome, LineOutcome::Header { .. }))
        .count();
    assert!(separators > 15, "got {separators}");
}
