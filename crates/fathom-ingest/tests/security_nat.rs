//! `set security nat …` — schema 0.39, sign-off r104 (NAT A: source,
//! destination and static NAT on an SRX, read and traced).
//!
//! The pastes are the `set` lines Juniper's own examples print (read
//! 2026-11-02; the sources are listed at the top of
//! `corpus/dict/junos-srx/security-nat.yaml`). Each test is a way the reader
//! could get NAT quietly wrong: a pool of the wrong namespace, a scope that
//! names the wrong thing, a rule list that loses its order, or a line the
//! reader did not understand reported as read.

use std::path::{Path, PathBuf};

use fathom_ingest::bind::{BoundNatScope, BoundValue};
use fathom_ingest::dict::Dictionary;
use fathom_ingest::frame::LineOutcome;
use fathom_ingest::{ingest, IngestOutput};
use fathom_ir::generated::ir_types::{NatPoolNatType, NatRuleSetNatType, NodeKind};
use fathom_ir::scalar::{self, Scalar};
use fathom_ir::value::NatAction;

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .nth(2)
        .expect("the crate lives two levels under the repo root")
        .to_path_buf()
}

fn run(text: &str) -> IngestOutput {
    let dict = Dictionary::load(&repo_root()).expect("the shipped dictionary loads");
    ingest(text.as_bytes(), &dict).expect("within the caps")
}

fn field<'a>(out: &'a IngestOutput, node: usize, name: &str) -> Option<&'a BoundValue> {
    let key = fathom_ir::generated::ir_types::FIELD_KEYS
        .iter()
        .find(|(n, _)| *n == name)
        .map(|(_, k)| fathom_ir::bag::FieldKey(*k))?;
    out.fragment
        .nodes
        .get(node)?
        .fields
        .iter()
        .find(|f| f.key == key)
        .map(|f| &f.value)
}

fn named(out: &IngestOutput, kind: NodeKind, name: &str) -> usize {
    let want = BoundValue::Identifier(scalar::Identifier(name.to_owned()));
    let field_name = format!("{}.name", kind.name());
    out.fragment
        .nodes
        .iter()
        .enumerate()
        .position(|(at, n)| n.kind == kind && field(out, at, &field_name) == Some(&want))
        .unwrap_or_else(|| panic!("no {} named {name}", kind.name()))
}

fn prefix(text: &str) -> scalar::IpPrefix {
    scalar::IpPrefix::parse(text).unwrap()
}

fn all_bound(out: &IngestOutput) {
    let left: Vec<_> = out
        .residue
        .iter()
        .map(|r| {
            out.capture
                .text()
                .lines()
                .nth(r.ordinal.0 as usize)
                .unwrap_or("")
                .to_owned()
        })
        .collect();
    assert!(left.is_empty(), "lines left unread: {left:?}");
}

/// Destination NAT topic, Example 2 (2026-11-02): a pool with a port, a rule
/// set from a zone, and a rule that matches an address and a port.
#[test]
fn destination_nat_with_a_port_reads_whole() {
    let out = run("\
set security nat destination pool dst-nat-pool-1 address 192.168.1.200/32 port 80
set security nat destination rule-set rs1 from zone untrust
set security nat destination rule-set rs1 rule r1 match destination-address 203.0.113.200/32
set security nat destination rule-set rs1 rule r1 match destination-port 80
set security nat destination rule-set rs1 rule r1 then destination-nat pool dst-nat-pool-1
");
    all_bound(&out);
    let pool = named(&out, NodeKind::NatPool, "dst-nat-pool-1");
    assert_eq!(
        field(&out, pool, "NatPool.nat_type"),
        Some(&BoundValue::NatPoolNatType(NatPoolNatType::Destination))
    );
    assert_eq!(
        field(&out, pool, "NatPool.address"),
        Some(&BoundValue::IpPrefix(prefix("192.168.1.200/32")))
    );
    assert_eq!(
        field(&out, pool, "NatPool.port"),
        Some(&BoundValue::L4Port(scalar::L4Port(80)))
    );

    let set = named(&out, NodeKind::NatRuleSet, "rs1");
    assert_eq!(
        field(&out, set, "NatRuleSet.nat_type"),
        Some(&BoundValue::NatRuleSetNatType(
            NatRuleSetNatType::Destination
        ))
    );
    match field(&out, set, "NatRuleSet.from") {
        Some(BoundValue::NatScope(BoundNatScope::Zone(z))) => {
            assert_eq!(out.fragment.nodes[z.0 as usize].kind, NodeKind::Zone);
            assert_eq!(
                field(&out, z.0 as usize, "Zone.name"),
                Some(&BoundValue::Identifier(scalar::Identifier(
                    "untrust".into()
                )))
            );
        }
        other => panic!("from is not a zone: {other:?}"),
    }
    let rule = named(&out, NodeKind::NatRule, "r1");
    assert_eq!(
        out.fragment.nodes[rule].owner.map(|o| o.0 as usize),
        Some(set)
    );
    assert_eq!(
        field(&out, rule, "NatRule.match_destination"),
        Some(&BoundValue::IpPrefixes(vec![prefix("203.0.113.200/32")]))
    );
    assert_eq!(
        field(&out, rule, "NatRule.match_destination_port"),
        Some(&BoundValue::L4Ports(vec![scalar::L4Port(80)]))
    );
    assert_eq!(
        field(&out, rule, "NatRule.then"),
        Some(&BoundValue::NatAction(NatAction::Pool(scalar::Identifier(
            "dst-nat-pool-1".into()
        ))))
    );
}

/// `from interface ge-0/0/0.0` names a unit the paste defines AFTER the NAT
/// lines (display-set prints `security` before `interfaces`), so the scope
/// waits for the whole paste, as a next hop's unit does.
#[test]
fn from_interface_resolves_a_unit_defined_later() {
    let out = run("\
set security nat destination rule-set rs1 from interface ge-0/0/0.0
set security nat destination rule-set rs1 rule r1 match destination-address 203.0.113.200/32
set security nat destination rule-set rs1 rule r1 then destination-nat off
set interfaces ge-0/0/0 unit 0 family inet address 203.0.113.1/24
");
    all_bound(&out);
    let set = named(&out, NodeKind::NatRuleSet, "rs1");
    match field(&out, set, "NatRuleSet.from") {
        Some(BoundValue::NatScope(BoundNatScope::Interface(u))) => {
            assert_eq!(out.fragment.nodes[u.0 as usize].kind, NodeKind::LogicalUnit);
        }
        other => panic!("from is not the unit: {other:?}"),
    }
    let rule = named(&out, NodeKind::NatRule, "r1");
    assert_eq!(
        field(&out, rule, "NatRule.then"),
        Some(&BoundValue::NatAction(NatAction::Off))
    );
}

/// A unit the paste never defines is not guessed: the field stays empty and
/// the line is residue.
#[test]
fn from_interface_to_a_missing_unit_is_residue() {
    let out = run("set security nat destination rule-set rs1 from interface ge-0/0/9.0\n");
    let set = named(&out, NodeKind::NatRuleSet, "rs1");
    assert_eq!(field(&out, set, "NatRuleSet.from"), None);
    assert!(out
        .residue
        .iter()
        .any(|e| matches!(e.outcome, LineOutcome::Unmapped { .. })));
}

/// Static NAT topic (2026-11-02).
#[test]
fn static_nat_reads_whole() {
    let out = run("\
set security nat static rule-set rs1 from zone untrust
set security nat static rule-set rs1 rule r1 match destination-address 203.0.113.200/32
set security nat static rule-set rs1 rule r1 then static-nat prefix 192.168.1.200/32
");
    all_bound(&out);
    let set = named(&out, NodeKind::NatRuleSet, "rs1");
    assert_eq!(
        field(&out, set, "NatRuleSet.nat_type"),
        Some(&BoundValue::NatRuleSetNatType(NatRuleSetNatType::Static))
    );
    let rule = named(&out, NodeKind::NatRule, "r1");
    assert_eq!(
        field(&out, rule, "NatRule.then"),
        Some(&BoundValue::NatAction(NatAction::Static(prefix(
            "192.168.1.200/32"
        ))))
    );
}

/// Juniper "207 source NAT" (2026-11-02): interface NAT, then a pool with a
/// range, and two rule sets whose rules keep their order.
#[test]
fn source_nat_interface_and_pool_read_whole() {
    let out = run("\
set security nat source pool src_nat_pool_napt address 100.100.100.20/32 to 100.100.100.29/32
set security nat source rule-set 1 from zone trust
set security nat source rule-set 1 to zone untrust
set security nat source rule-set 1 rule 1A match source-address 10.0.0.0/8
set security nat source rule-set 1 rule 1A then source-nat pool src_nat_pool_napt
set security nat source rule-set 1 rule 1B match source-address 0.0.0.0/0
set security nat source rule-set 1 rule 1B then source-nat interface
");
    all_bound(&out);
    let pool = named(&out, NodeKind::NatPool, "src_nat_pool_napt");
    assert_eq!(
        field(&out, pool, "NatPool.nat_type"),
        Some(&BoundValue::NatPoolNatType(NatPoolNatType::Source))
    );
    assert_eq!(
        field(&out, pool, "NatPool.address_to"),
        Some(&BoundValue::IpPrefix(prefix("100.100.100.29/32")))
    );
    let set = named(&out, NodeKind::NatRuleSet, "1");
    assert!(matches!(
        field(&out, set, "NatRuleSet.to"),
        Some(BoundValue::NatScope(BoundNatScope::Zone(_)))
    ));
    let a = named(&out, NodeKind::NatRule, "1A");
    let b = named(&out, NodeKind::NatRule, "1B");
    assert_eq!(field(&out, a, "NatRule.ordinal"), Some(&BoundValue::U32(0)));
    assert_eq!(field(&out, b, "NatRule.ordinal"), Some(&BoundValue::U32(1)));
    assert_eq!(
        field(&out, b, "NatRule.then"),
        Some(&BoundValue::NatAction(NatAction::Interface))
    );
}

/// A source pool and a destination pool may share a name: they are separate
/// on the device, and a rule's `pool P` means the one of its own type.
#[test]
fn source_and_destination_pools_of_one_name_stay_apart() {
    let out = run("\
set security nat source pool P address 100.100.100.20/32
set security nat destination pool P address 192.168.1.200/32
");
    all_bound(&out);
    let pools = out
        .fragment
        .nodes
        .iter()
        .filter(|n| n.kind == NodeKind::NatPool)
        .count();
    assert_eq!(pools, 2);
}

/// `static pool` is not a Junos statement: the type word refuses the node
/// rather than storing a pool of an unknown type.
#[test]
fn a_type_word_the_pool_refuses_binds_nothing() {
    let out = run("set security nat static pool P address 192.168.1.200/32\n");
    assert!(!out
        .fragment
        .nodes
        .iter()
        .any(|n| n.kind == NodeKind::NatPool));
    assert!(!out.residue.is_empty());
}

/// The statements not read stay residue, with their bytes, never reported
/// as read.
#[test]
fn unread_nat_statements_are_residue() {
    let out = run("\
set security nat destination rule-set rs1 from routing-instance VR1
set security nat static rule-set rs1 rule r1 then static-nat prefix 192.168.1.200/32 mapped-port 8080
set security nat proxy-arp interface ge-0/0/0.0 address 203.0.113.200/32
");
    assert_eq!(out.residue.len(), 3);
}

/// No NAT line carries a credential, so none is redacted, and an address on
/// a NAT line survives the gate untouched (a gate that ate addresses would
/// leave the trace nothing to translate to).
#[test]
fn nat_lines_pass_the_gate_unchanged() {
    let text = "\
set security nat destination pool dst-nat-pool-1 address 192.168.1.200/32 port 80
set security nat source rule-set 1 rule 1A then source-nat interface
";
    let out = run(text);
    assert_eq!(out.capture.text(), text);
}
