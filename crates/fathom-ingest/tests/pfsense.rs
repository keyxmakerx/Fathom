//! `corpus/dict/pfsense/` through `fathom_ingest::xml` — a pfSense
//! `config.xml` in the shape the box writes, asserting what binds and that no
//! credential reaches the stored capture or the fragment (CLAUDE.md rule 4).
//!
//! Real shapes (CLAUDE.md rule 2), sources in `corpus/dict/README-pfsense.md`:
//! the bcrypt hash is the `$2y$10$` form `auth.inc` writes (this one is from a
//! real exported config kept as a test fixture by pfsensible/core); private
//! keys, the OpenVPN static key, the PPP password and the ACME account key are
//! base64-encoded the way pfSense stores them, so no word or shape detector
//! sees a password in them; the PPPoE-server entry is `user:` + base64.

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
        Dictionary::load_platform(&repo_root(), "pfsense").expect("pfsense dictionary loads");
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

const BCRYPT: &str = "$2y$10$AMCpA.Z.RNaferLp1yzFq.BvaGgfqaJKtQug7OErbocyNagsEK6xW";
const PRV: &str = "LS0tLS1CRUdJTiBQUklWQVRFIEtFWS0tLS0tCk1JSUV2UUlCQURBTkJna3Foa2lHOXcwQkFRRUZBQVNDQktjd2dnU2pBZ0VBQW9JQkFRQzdWSlRVdDlVczhjS2oKTXpFZll5amlXQTRSNC9NMmJTMUdCNHQ3TlhwOThDM1NDNmRWTXZEdWljdEdldXJUOGpOYnZKWkh0Q1N1WUV2dQotLS0tLUVORCBQUklWQVRFIEtFWS0tLS0tCg==";
const PPP: &str = "aXNwLVB3OTN4blEy";
const OVPN: &str = "IwojIDIwNDggYml0IE9wZW5WUE4gc3RhdGljIGtleQojCi0tLS0tQkVHSU4gT3BlblZQTiBTdGF0aWMga2V5IFYxLS0tLS0KZTY4NWJkYWY2NTlhMjVhMjAwZTJiOWU2YTJkN2ZmMTkKLS0tLS1FTkQgT3BlblZQTiBTdGF0aWMga2V5IFYxLS0tLS0K";
const ACME: &str = "LS0tLS1CRUdJTiBSU0EgUFJJVkFURSBLRVktLS0tLQpNSUlFb3dJQkFBS0NBUUVBdUYwUwotLS0tLUVORCBSU0EgUFJJVkFURSBLRVktLS0tLQo=";
const PSK: &str = "Correct-Horse-Site-To-Site-Key-99";
const WG: &str = "yAnz5TF+lXXJte14tji3zlMNq+hd2rYUIgJBgB3fBmk=";
const SNMP: &str = "R3adOnlyHome";
const PUSHOVER: &str = "azGDORePK8gMaC0QOYAMyEEuzJnyUi";
const PPPOE: &str = "UHBwb2UtVXNlci1QdzE=";
const SMTP: &str = "Smtp-Relay-Pw-55";

fn config() -> String {
    format!(
        r#"<?xml version="1.0"?>
<pfsense>
	<version>23.3</version>
	<system>
		<hostname>fw1</hostname>
		<domain>home.arpa</domain>
		<user>
			<name>admin</name>
			<descr><![CDATA[System Administrator]]></descr>
			<scope>system</scope>
			<groupname>admins</groupname>
			<bcrypt-hash>{BCRYPT}</bcrypt-hash>
			<uid>0</uid>
			<priv>user-shell-access</priv>
		</user>
	</system>
	<interfaces>
		<wan>
			<enable></enable>
			<if>igb0</if>
			<descr><![CDATA[WAN]]></descr>
			<ipaddr>pppoe</ipaddr>
		</wan>
		<lan>
			<enable></enable>
			<if>igb1</if>
			<descr><![CDATA[LAN &amp; servers]]></descr>
			<ipaddr>192.168.1.1</ipaddr>
			<subnet>24</subnet>
		</lan>
		<opt1>
			<if>igb1.10</if>
			<descr><![CDATA[IOT]]></descr>
			<ipaddr>10.0.10.1</ipaddr>
			<subnet>24</subnet>
		</opt1>
	</interfaces>
	<vlans>
		<vlan>
			<if>igb1</if>
			<tag>10</tag>
			<pcp></pcp>
			<descr><![CDATA[IoT VLAN]]></descr>
			<vlanif>igb1.10</vlanif>
		</vlan>
	</vlans>
	<ppps>
		<ppp>
			<ptpid>0</ptpid>
			<type>pppoe</type>
			<if>pppoe0</if>
			<ports>igb0</ports>
			<username><![CDATA[home@example-isp.net]]></username>
			<password><![CDATA[{PPP}]]></password>
		</ppp>
	</ppps>
	<ipsec>
		<phase1>
			<ikeid>1</ikeid>
			<remote-gateway>203.0.113.9</remote-gateway>
			<authentication_method>pre_shared_key</authentication_method>
			<pre-shared-key>{PSK}</pre-shared-key>
		</phase1>
	</ipsec>
	<openvpn>
		<openvpn-server>
			<vpnid>1</vpnid>
			<shared_key>{OVPN}</shared_key>
		</openvpn-server>
	</openvpn>
	<cert>
		<refid>5f3a1b2c4d5e6</refid>
		<descr><![CDATA[webConfigurator default]]></descr>
		<crt>LS0tLS1CRUdJTiBDRVJUSUZJQ0FURS0tLS0tCk1JSUQ=</crt>
		<prv>{PRV}</prv>
	</cert>
	<snmpd>
		<syslocation></syslocation>
		<rocommunity>{SNMP}</rocommunity>
	</snmpd>
	<notifications>
		<smtp>
			<password><![CDATA[{SMTP}]]></password>
		</smtp>
		<pushover>
			<apikey>{PUSHOVER}</apikey>
		</pushover>
	</notifications>
	<pppoes>
		<pppoe>
			<pppoeid>1</pppoeid>
			<username><![CDATA[alice:{PPPOE}]]></username>
		</pppoe>
	</pppoes>
	<installedpackages>
		<wireguard>
			<tunnels>
				<item>
					<name>tun_wg0</name>
					<privatekey>{WG}</privatekey>
				</item>
			</tunnels>
		</wireguard>
		<acme>
			<accountkeys>
				<item>
					<name>le</name>
					<accountkey>{ACME}</accountkey>
				</item>
			</accountkeys>
		</acme>
	</installedpackages>
</pfsense>
"#
    )
}

const SECRETS: [&str; 11] = [
    BCRYPT, PRV, PPP, OVPN, ACME, PSK, WG, SNMP, PUSHOVER, PPPOE, SMTP,
];

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
    let out = run(&config());
    let dump = format!("{:?}", out.fragment);
    for secret in SECRETS {
        assert!(!dump.contains(secret), "{secret} reached the fragment");
    }
}

#[test]
fn known_credentials_carry_their_label() {
    let out = run(&config());
    let text = out.capture.text();
    for want in [
        "<bcrypt-hash><REDACTED:password></bcrypt-hash>",
        "<pre-shared-key><REDACTED:psk></pre-shared-key>",
        "<rocommunity><REDACTED:snmp-community></rocommunity>",
    ] {
        assert!(text.contains(want), "no {want} in:\n{text}");
    }
}

#[test]
fn what_the_dictionary_describes_stays_readable() {
    let out = run(&config());
    let text = out.capture.text();
    for kept in [
        "<hostname>fw1</hostname>",
        "<if>igb1</if>",
        "<ipaddr>192.168.1.1</ipaddr>",
        "<tag>10</tag>",
        "<vlanif>igb1.10</vlanif>",
    ] {
        assert!(text.contains(kept), "{kept} was destroyed:\n{text}");
    }
}

#[test]
fn interfaces_and_vlans_bind() {
    let out = run(&config());
    let f = &out.fragment;
    let ifaces = nodes_of(f, NodeKind::Interface);
    for name in ["igb0", "igb1", "igb1.10"] {
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
    let vlans = nodes_of(f, NodeKind::Vlan);
    let ten = BoundValue::VlanId(scalar::VlanId::parse("10").unwrap());
    assert!(vlans.iter().any(|n| has(n, &ten)));
    let device = nodes_of(f, NodeKind::Device);
    assert!(has(
        device[0],
        &BoundValue::Identifier(scalar::Identifier::parse("fw1").unwrap())
    ));
}

/// An encrypted backup (`crypt.inc`'s armour around AES-256-CBC base64) cannot
/// be read: nothing binds, and every line of it is swept.
#[test]
fn an_encrypted_backup_binds_nothing_and_keeps_no_body() {
    let body = "U2FsdGVkX1+vupppZksvRf5pq5g5XjFRIipRkwB0K1Y96Qsv2Lm+31cmzaAILwyt";
    let out = run(&format!(
        "---- BEGIN config.xml ----\n{body}\n{body}\n---- END config.xml ----\n"
    ));
    assert!(out.fragment.nodes.iter().all(|n| n.fields.is_empty()));
    assert!(!out.capture.text().contains(body));
}

#[test]
fn a_broken_document_is_swept_and_binds_nothing() {
    let out = run(
        "<pfsense>\n<system>\n<hostname>fw1</hostname>\n<password>Broken-Doc-Pw-1</password>\n",
    );
    assert!(out.fragment.nodes.iter().all(|n| n.fields.is_empty()));
    assert!(!out.capture.text().contains("Broken-Doc-Pw-1"));
}

/// A value wrapped over several lines (a pasted certificate, a CDATA script)
/// is one line to the gate and goes whole.
#[test]
fn a_value_over_several_lines_goes_whole() {
    let out = run(
        "<pfsense>\n<system><hostname>fw1</hostname></system>\n<cert>\n<refid>a1</refid>\n<prv>LS0tLS1CRUdJTiBQUklWQVRFIEtFWS0tLS0t\nCk1JSUV2UUlCQURBTkJna3Foa2lHOXcwQkFR\nRUZBQVNDQktjd2dnU2pBZ0VBQW9JQkFRQzdW</prv>\n</cert>\n</pfsense>\n",
    );
    let text = out.capture.text();
    for part in [
        "LS0tLS1CRUdJTiBQUklWQVRFIEtFWS0tLS0t",
        "Ck1JSUV2UUlCQURBTkJna3Foa2lHOXcwQkFR",
        "RUZBQVNDQktjd2dnU2pBZ0VBQW9JQkFRQzdW",
    ] {
        assert!(!text.contains(part), "{text}");
    }
}
