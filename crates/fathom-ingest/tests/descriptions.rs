//! The three entries added on 2026-08-10, and the one thing they could each get
//! quietly wrong.
//!
//! `set system domain-name` and `description` were residue on a real branch
//! config for want of dictionary lines. Adding them is cheap; adding them
//! *wrongly* is cheap too, and invisible — a unit's description silently
//! recorded against its parent interface reads perfectly on screen and is a
//! fact about the wrong object. Each test below is one such confusion.

use std::path::{Path, PathBuf};

use fathom_ingest::bind::BoundValue;
use fathom_ingest::dict::Dictionary;
use fathom_ingest::frame::LineOutcome;
use fathom_ingest::{ingest, IngestOutput};
use fathom_ir::bag::FieldKey;
use fathom_ir::generated::ir_types::{
    DeviceField, InterfaceField, LogicalUnitField, NodeKind, TunnelInterfaceField,
};

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

fn render(v: &BoundValue) -> String {
    match v {
        BoundValue::Text(t) => t.0.clone(),
        BoundValue::Fqdn(f) => f.0.clone(),
        BoundValue::InterfaceName(n) => n.0.clone(),
        BoundValue::U32(n) => n.to_string(),
        other => format!("{other:?}"),
    }
}

/// One field's value on the first fragment node of `kind`.
///
/// The key is taken from the generated field enum rather than written as a
/// number or a string, so a schema change that moves a field breaks the
/// compile instead of quietly making these tests assert nothing.
fn value_of(out: &IngestOutput, kind: NodeKind, key: FieldKey) -> Option<String> {
    out.fragment
        .nodes
        .iter()
        .find(|n| n.kind == kind)?
        .fields
        .iter()
        .find(|a| a.key == key)
        .map(|a| render(&a.value))
}

#[test]
fn a_domain_name_binds_to_the_device() {
    let out =
        run("set system host-name srx-branch-01\nset system domain-name branch.example.net\n");
    assert_eq!(
        value_of(&out, NodeKind::Device, DeviceField::DomainName.key()).as_deref(),
        Some("branch.example.net")
    );
    assert!(out.residue.is_empty(), "{:?}", out.residue);
}

/// `Fqdn::parse` lower-cases and rejects non-ASCII. A domain it cannot parse
/// must not become a half-bound `Device` — the statement carries no other
/// field, so a parse failure has to be visible as an unbound value rather than
/// as a silently absent one.
#[test]
fn a_domain_name_is_canonicalised_not_stored_raw() {
    let out = run("set system host-name h\nset system domain-name BRANCH.Example.NET\n");
    assert_eq!(
        value_of(&out, NodeKind::Device, DeviceField::DomainName.key()).as_deref(),
        Some("branch.example.net"),
        "Fqdn folds case on parse; the stored value is the canonical one"
    );
}

/// The confusion this pair of entries exists to avoid. Junos accepts
/// `description` at the interface level and at the unit level, and they are
/// facts about different objects.
#[test]
fn interface_and_unit_descriptions_land_on_different_objects() {
    let out = run(concat!(
        "set system host-name h\n",
        "set interfaces ge-0/0/0 description \"WAN to ISP\"\n",
        "set interfaces ge-0/0/0 unit 0 description \"transit /30\"\n",
    ));

    assert_eq!(
        value_of(&out, NodeKind::Interface, InterfaceField::Description.key()).as_deref(),
        Some("WAN to ISP"),
        "the port's description belongs to the port"
    );
    assert_eq!(
        value_of(
            &out,
            NodeKind::LogicalUnit,
            LogicalUnitField::Description.key()
        )
        .as_deref(),
        Some("transit /30"),
        "the unit's description belongs to the unit"
    );
    assert!(out.residue.is_empty(), "{:?}", out.residue);
}

/// Quotes are the lexer's business and must be gone by the time a value binds:
/// what is stored is the operator's sentence, not its Junos spelling. An escaped
/// inner quote survives as a quote.
#[test]
fn quotes_are_stripped_and_escapes_resolved() {
    let out = run(concat!(
        "set system host-name h\n",
        "set interfaces ge-0/0/0 description \"link to \\\"core\\\" switch\"\n",
    ));
    assert_eq!(
        value_of(&out, NodeKind::Interface, InterfaceField::Description.key()).as_deref(),
        Some("link to \"core\" switch")
    );
}

/// The interface-name prefix decides the kind, and a description must not be
/// the thing that breaks that: `st0` is a `TunnelInterface` whether or not it
/// is the statement carrying an address.
#[test]
fn a_description_respects_the_interface_kind_resolver() {
    let out = run("set system host-name h\nset interfaces st0 description \"tunnels\"\n");
    assert_eq!(
        value_of(
            &out,
            NodeKind::TunnelInterface,
            TunnelInterfaceField::Description.key()
        )
        .as_deref(),
        Some("tunnels")
    );
    assert!(
        value_of(&out, NodeKind::Interface, InterfaceField::Description.key()).is_none(),
        "st0 is not a plain Interface"
    );
}

/// `14`'s deferral of logical systems is deliberate and must stay visible.
/// `[edit logical-systems … interfaces …]` is a real Junos hierarchy for this
/// statement and binding it here would attach another system's interface to
/// this device.
#[test]
fn a_logical_systems_description_stays_residue() {
    let out = run(concat!(
        "set system host-name h\n",
        "set logical-systems LS1 interfaces ge-0/0/0 description \"not this device\"\n",
    ));
    assert_eq!(out.residue.len(), 1, "{:?}", out.residue);
    assert!(
        matches!(out.residue[0].outcome, LineOutcome::Unmapped { .. }),
        "{:?}",
        out.residue[0].outcome
    );
    assert!(
        value_of(&out, NodeKind::Interface, InterfaceField::Description.key()).is_none(),
        "another logical system's interface must not reach this device"
    );
}
