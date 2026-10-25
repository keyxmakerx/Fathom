//! `corpus/dict/opnsense/config-xml.yaml` through `fathom_ingest::xml`: an
//! OPNsense `config.xml` in the shape the box writes, asserting what binds and
//! that no credential reaches the stored capture or the fragment (CLAUDE.md
//! rule 4).
//!
//! Real shapes (CLAUDE.md rule 2), read 2026-10-25 from opnsense/core master:
//! the `$2y$10$` bcrypt hash `config.xml.sample` carries for root; the MVC
//! sections (`Vlan.xml`, `IPsec.xml`, net-snmp's `General.xml`) written as
//! records with a `uuid` attribute; a flag written `<enable>1</enable>`. The
//! private key is base64 PEM, as a key pair's `privateKey` is pasted. The
//! WireGuard and OpenVPN tags are not confirmed (README-config-xml.md section
//! 1): they are here to show the allowlist destroys what nobody listed.

use std::path::{Path, PathBuf};

use fathom_ingest::bind::{BoundValue, FragNode, Fragment};
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
        Dictionary::load_platform(&repo_root(), "opnsense").expect("opnsense dictionary loads");
    fathom_ingest::xml::ingest_xml(paste.as_bytes(), &dict).expect("within the caps")
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

const BCRYPT: &str = "$2y$10$YRVoF4SgskIsrXOvOQjGieB9XqHPRra9R7d80B3BZdbY/j21TwBfS";
const PSK: &str = "Painite-Site-To-Site-PSK-0f3e9a1c7b2d4e6f8a0b1c2d3e4f5a6b7c8d9e0f";
const PRV: &str = "LS0tLS1CRUdJTiBQUklWQVRFIEtFWS0tLS0tCk1JSUV2UUlCQURBTkJna3Foa2lHOXcwQkFRRUZBQVNDQktjd2dnU2pBZ0VBQW9JQkFRQzdWSlRVdDlVczhjS2oKLS0tLS1FTkQgUFJJVkFURSBLRVktLS0tLQo=";
const SNMP: &str = "Painite-RO-Community-7Hq2xWm9Lp4Zr";
const WG: &str = "yAnz5TF+lXXJte14tji3zlMNq+hd2rYUIgJBgB3fBmk=";
const OVPN: &str = "IwojIDIwNDggYml0IE9wZW5WUE4gc3RhdGljIGtleQotLS0tLUJFR0lOIE9wZW5WUE4gU3RhdGljIGtleSBWMS0tLS0tCg==";
const SHORT: &str = "hunter22";

fn config() -> String {
    format!(
        r#"<?xml version="1.0"?>
<opnsense>
  <theme>opnsense</theme>
  <system>
    <hostname>painite</hostname>
    <domain>home.arpa</domain>
    <user>
      <name>root</name>
      <descr>System Administrator</descr>
      <scope>system</scope>
      <groupname>admins</groupname>
      <password>{BCRYPT}</password>
      <uid>0</uid>
    </user>
    <user>
      <name>backup</name>
      <password>{SHORT}</password>
      <uid>2000</uid>
    </user>
  </system>
  <interfaces>
    <wan>
      <enable>1</enable>
      <if>igb0</if>
      <descr/>
      <ipaddr>dhcp</ipaddr>
    </wan>
    <lan>
      <enable>1</enable>
      <if>igb1</if>
      <descr>LAN &amp; servers</descr>
      <ipaddr>192.168.1.1</ipaddr>
      <subnet>24</subnet>
    </lan>
    <opt1>
      <if>vlan0.10</if>
      <descr>IOT</descr>
    </opt1>
  </interfaces>
  <vlans version="1.0.0">
    <vlan uuid="4c0f5d2e-8a7b-4c3d-9e1f-2a3b4c5d6e7f">
      <if>igb1</if>
      <tag>10</tag>
      <pcp>0</pcp>
      <proto/>
      <descr>IoT VLAN</descr>
      <vlanif>vlan0.10</vlanif>
    </vlan>
  </vlans>
  <filter>
    <rule uuid="9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d">
      <type>pass</type>
      <interface>lan</interface>
      <ipprotocol>inet</ipprotocol>
      <action>pass</action>
      <description>Default allow LAN to any rule</description>
    </rule>
  </filter>
  <OPNsense>
    <IPsec version="1.0.4">
      <preSharedKeys>
        <preSharedKey uuid="1b2c3d4e-5f60-4718-9a0b-1c2d3e4f5a6b">
          <ident>203.0.113.9</ident>
          <keyType>PSK</keyType>
          <Key>{PSK}</Key>
        </preSharedKey>
      </preSharedKeys>
      <keyPairs>
        <keyPair uuid="2c3d4e5f-6071-4829-8b1c-2d3e4f5a6b7c">
          <name>site-b</name>
          <privateKey>{PRV}</privateKey>
        </keyPair>
      </keyPairs>
    </IPsec>
    <netsnmp>
      <general version="1.0.0">
        <enabled>1</enabled>
        <community>{SNMP}</community>
      </general>
    </netsnmp>
    <wireguard>
      <server version="1.0.0">
        <servers>
          <server uuid="3d4e5f60-7182-493a-9c2d-3e4f5a6b7c8d">
            <name>wg0</name>
            <privkey>{WG}</privkey>
          </server>
        </servers>
      </server>
    </wireguard>
    <OpenVPN version="1.0.0">
      <StaticKeys>
        <StaticKey uuid="4e5f6071-8293-4a4b-8d3e-4f5a6b7c8d9e">
          <key>{OVPN}</key>
        </StaticKey>
      </StaticKeys>
    </OpenVPN>
  </OPNsense>
</opnsense>
"#
    )
}

const SECRETS: [&str; 7] = [BCRYPT, PSK, PRV, SNMP, WG, OVPN, SHORT];

#[test]
fn every_credential_is_gone_from_the_redacted_capture() {
    let out = run(&config());
    let text = out.capture.text();
    for secret in SECRETS {
        assert!(
            !text.contains(secret),
            "{secret} survived the gate:\n{text}"
        );
    }
}

#[test]
fn no_credential_reaches_the_fragment() {
    let dump = format!("{:?}", run(&config()).fragment);
    for secret in SECRETS {
        assert!(!dump.contains(secret), "{secret} reached the fragment");
    }
}

#[test]
fn known_credentials_carry_their_label() {
    let out = run(&config());
    let text = out.capture.text();
    for want in [
        "<password><REDACTED:password></password>",
        "<Key><REDACTED:psk></Key>",
        "<privateKey><REDACTED:cert-key></privateKey>",
        "<community><REDACTED:snmp-community></community>",
    ] {
        assert!(text.contains(want), "no {want} in:\n{text}");
    }
}

#[test]
fn what_the_dictionary_describes_stays_readable() {
    let out = run(&config());
    let text = out.capture.text();
    for kept in [
        "<hostname>painite</hostname>",
        "<if>igb1</if>",
        "<ipaddr>192.168.1.1</ipaddr>",
        "<tag>10</tag>",
        "<vlanif>vlan0.10</vlanif>",
    ] {
        assert!(text.contains(kept), "{kept} was destroyed:\n{text}");
    }
    assert!(
        !text.contains("4c0f5d2e-8a7b"),
        "an undescribed uuid survived:\n{text}"
    );
}

#[test]
fn interfaces_and_vlans_bind() {
    let out = run(&config());
    let f = &out.fragment;
    let ifaces = nodes_of(f, NodeKind::Interface);
    for name in ["igb0", "igb1", "vlan0.10"] {
        assert!(
            ifaces.iter().any(|n| has(n, &iface(name))),
            "no Interface {name}"
        );
    }
    let lan = ifaces.iter().find(|n| has(n, &iface("igb1"))).unwrap();
    assert!(has(
        lan,
        &BoundValue::Text(scalar::Text::parse("LAN & servers").unwrap())
    ));
    assert!(has(lan, &BoundValue::Bool(true)));
    let ten = BoundValue::VlanId(scalar::VlanId::parse("10").unwrap());
    assert!(nodes_of(f, NodeKind::Vlan).iter().any(|n| has(n, &ten)));
    let device = nodes_of(f, NodeKind::Device);
    assert!(has(
        device[0],
        &BoundValue::Identifier(scalar::Identifier::parse("painite").unwrap())
    ));
}

/// The rules CSV shares the dictionary. A `<filter><rule>` in the XML must not
/// be read as a CSV row: no policy binds from it.
#[test]
fn the_rules_csv_entries_do_not_read_the_xml() {
    let out = run(&config());
    let f = &out.fragment;
    assert!(nodes_of(f, NodeKind::SecurityPolicy).is_empty());
    assert!(nodes_of(f, NodeKind::PolicySet).is_empty());
}

/// OPNsense's encrypted backup cannot be read: nothing binds, and its body is swept.
#[test]
fn an_encrypted_backup_binds_nothing_and_keeps_no_body() {
    let body = "U2FsdGVkX1+vupppZksvRf5pq5g5XjFRIipRkwB0K1Y96Qsv2Lm+31cmzaAILwyt";
    let out = run(&format!("---- BEGIN config.xml ----\nVersion: OPNsense 25.7\nCipher: AES-256-CBC\n\n{body}\n{body}\n---- END config.xml ----\n"));
    assert!(out.fragment.nodes.iter().all(|n| n.fields.is_empty()));
    assert!(!out.capture.text().contains(body));
}
