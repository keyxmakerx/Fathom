//! The crate-side half of `schema.emit.unread` (`62` §10.3): every field of a
//! covered kind is either read by the emitter or carries a declared gap with a
//! reason string. The schema is loaded from `schema/` on every run, so a
//! marker change in the tree turns this red rather than drifting silently
//! (WO-04 §9 row 1).

use fathom_emit::junos::{
    GAPS_IKE_GATEWAY, GAPS_IKE_POLICY, GAPS_IKE_PROPOSAL, GAPS_IPSEC_POLICY, GAPS_IPSEC_PROPOSAL,
    GAPS_IPSEC_VPN, GAPS_TRAFFIC_SELECTOR, READS_IKE_GATEWAY, READS_IKE_POLICY, READS_IKE_PROPOSAL,
    READS_IPSEC_POLICY, READS_IPSEC_PROPOSAL, READS_IPSEC_VPN, READS_TRAFFIC_SELECTOR,
};
use fathom_ir::bag::FieldKey;
use fathom_schema::model::KindDecl;
use fathom_schema::SchemaTree;
use std::path::PathBuf;

/// One covered kind: its schema name, its read set, its gap ledger.
type Covered = (
    &'static str,
    &'static [FieldKey],
    &'static [(FieldKey, &'static str)],
);

/// The seven covered kinds, each with the read set and the gap ledger
/// `src/junos.rs` declares for it (WO-04 §4.6).
fn covered() -> Vec<Covered> {
    vec![
        ("IkeProposal", READS_IKE_PROPOSAL, GAPS_IKE_PROPOSAL),
        ("IkePolicy", READS_IKE_POLICY, GAPS_IKE_POLICY),
        ("IkeGateway", READS_IKE_GATEWAY, GAPS_IKE_GATEWAY),
        ("IpsecProposal", READS_IPSEC_PROPOSAL, GAPS_IPSEC_PROPOSAL),
        ("IpsecPolicy", READS_IPSEC_POLICY, GAPS_IPSEC_POLICY),
        ("IpsecVpn", READS_IPSEC_VPN, GAPS_IPSEC_VPN),
        (
            "TrafficSelector",
            READS_TRAFFIC_SELECTOR,
            GAPS_TRAFFIC_SELECTOR,
        ),
    ]
}

fn schema_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../schema")
}

fn tree() -> SchemaTree {
    SchemaTree::load(&schema_root()).expect("the shipped tree loads")
}

fn kind_decl<'t>(tree: &'t SchemaTree, name: &str) -> &'t KindDecl {
    tree.kinds
        .iter()
        .find(|k| k.name == name)
        .unwrap_or_else(|| panic!("{name} is declared in schema.yaml"))
}

/// `schema/field-keys.yaml` is the authoritative `(kind|edge).field -> key`
/// assignment; the crate's tables are built from the generated mirror of it,
/// so this is the join that proves the two agree.
fn key_of(tree: &SchemaTree, kind: &str, field: &str) -> FieldKey {
    let keys = tree.field_keys.as_ref().expect("field-keys.yaml parses");
    let dotted = format!("{kind}.{field}");
    let (_, key, _) = keys
        .entries
        .iter()
        .find(|(name, _, _)| *name == dotted)
        .unwrap_or_else(|| panic!("{dotted} has a wire key"));
    FieldKey(u32::try_from(*key).expect("wire keys are non-negative"))
}

#[test]
fn covered_kinds_partition_reads_and_gaps() {
    let tree = tree();
    for (name, reads, gaps) in covered() {
        let decl = kind_decl(&tree, name);
        assert_eq!(
            decl.emits,
            Some(true),
            "{name} must be an emitting kind for this crate to read it"
        );

        let mut declared: Vec<FieldKey> = decl
            .fields
            .iter()
            .map(|f| key_of(&tree, name, &f.name))
            .collect();
        declared.sort();

        let mut union: Vec<FieldKey> = reads.to_vec();
        union.extend(gaps.iter().map(|(k, _)| *k));
        union.sort();

        // reads ∩ gaps == ∅ — no duplicates survive the union.
        let mut deduped = union.clone();
        deduped.dedup();
        assert_eq!(deduped, union, "{name}: a field is both read and gapped");

        // reads ∪ gaps == fields
        assert_eq!(
            union, declared,
            "{name}: the emitter's read set and gap ledger do not partition the declared fields"
        );
    }
}

#[test]
fn every_emit_r_field_is_read_or_gapped() {
    let tree = tree();
    for (name, reads, gaps) in covered() {
        let decl = kind_decl(&tree, name);
        for field in &decl.fields {
            let marker = field.emit.as_deref().unwrap_or("");
            if marker != "R" && marker != "R*" {
                continue;
            }
            let key = key_of(&tree, name, &field.name);
            let read = reads.contains(&key);
            let gapped = gaps.iter().any(|(k, _)| *k == key);
            assert!(
                read || gapped,
                "{name}.{} declares emit `{marker}` and is neither read nor gapped",
                field.name
            );
        }
    }
}

#[test]
fn gap_tracking_strings_are_nonempty() {
    for (name, _, gaps) in covered() {
        for (key, tracking) in gaps {
            assert!(
                !tracking.trim().is_empty(),
                "{name}: gap {key:?} carries no reason"
            );
        }
    }
}
