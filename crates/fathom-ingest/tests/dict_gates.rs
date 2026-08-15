//! WO-03 §4.7's dictionary validation gates — the checkable subset of
//! `14` §6.5.
//!
//! Every gate named below runs inside `Dictionary::load`, which is why most
//! of these tests assert against the shipped dictionary rather than against a
//! synthetic violation: a gate failure is a load failure, so `load` returning
//! `Ok` *is* the gate passing. The negative cases — a dictionary that trips
//! each gate — are unit tests inside `src/dict.rs`, which can reach the
//! filesystem-free load path; the public surface WO-03 §4.7 fixes for this
//! crate deliberately does not expose it.

use std::path::{Path, PathBuf};

use fathom_ingest::dict::Dictionary;
use fathom_ingest::frame::LineOutcome;
use fathom_ingest::ingest;

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .nth(2)
        .expect("the crate lives two levels under the repo root")
        .to_path_buf()
}

fn dict() -> Dictionary {
    Dictionary::load(&repo_root()).expect("the shipped dictionary loads")
}

/// All eight files parse under `Profile::Corpus`; `platform` is `junos-srx` in
/// each (a disagreement is a load error).
#[test]
fn dictionary_loads() {
    assert_eq!(dict().platform(), "junos-srx");
}

/// WO-03 §4.7's table of 39, plus every entry added since. The count is pinned
/// rather than computed so that growing the vocabulary is always a deliberate
/// diff — the number moving is the whole signal.
///
/// +3 on 2026-08-10: `system domain-name`, and `description` at both the
/// interface and the unit level. Each was verified against Juniper's own CLI
/// reference on that date rather than recalled, with the URL in the dictionary
/// file beside the entry (ADR-0034 §5).
///
/// +27 on 2026-08-15: zone-level `host-inbound-traffic` (both
/// `system-services` and `protocols`), zone `description` / `screen` /
/// `tcp-rst` / `application-tracking`, the whole of `vlans`, the four
/// `security flow tcp-mss` clamps, interface and unit `disable`, unit
/// `vlan-id`, `family ethernet-switching vlan members`, `system time-zone`,
/// `system ntp server`, and six bare-stanza entries under `security ike` and
/// `security ipsec`. Chosen by the measurement in `branch_coverage.rs`, not by
/// taste; sourced per ADR-0034 with the URL and read date beside each entry.
///
/// +12 on 2026-08-15: the routing slice — `protocols-ospf.yaml` (5),
/// `protocols-bgp.yaml` (6, of which three are `secret:`-only catalogue entries
/// for the BGP TCP-MD5 key at its three documented hierarchy levels and bind
/// nothing) and `routing-options.yaml` (1). Every form read off Juniper's own
/// documentation on that date, URL and quoted syntax beside the entry.
#[test]
fn entry_count_is_81() {
    assert_eq!(dict().entry_count(), 81);
}

/// `14` §6.5: no entry's path is a strict prefix of another's unless the
/// shorter carries `partial: true`. Observable through the two zone entries,
/// the one declared pair: the shorter binds on its own and the longer wins
/// when its extra segments are present.
#[test]
fn shadowing_requires_partial() {
    let d = dict();
    let out = ingest(
        b"set security zones security-zone VPN interfaces st0.0\n\
          set security zones security-zone WAN interfaces reth0.0 host-inbound-traffic system-services ike\n",
        &d,
    )
    .expect("within the caps");
    assert!(matches!(
        out.ledger.lines[0].outcome,
        LineOutcome::Bound { edges: 1, .. }
    ));
    assert!(matches!(
        out.ledger.lines[1].outcome,
        LineOutcome::Bound { edges: 1, .. }
    ));
    let with_service = out
        .fragment
        .pending
        .iter()
        .filter(|e| !e.fields.is_empty())
        .count();
    assert_eq!(with_service, 1, "only the deeper entry carries the service");
}

/// Every `$name` used in `binds` appears in `path`; a dangling reference is a
/// load error (`14` §6.5's capture-arity gate).
#[test]
fn capture_arity_total() {
    assert!(Dictionary::load(&repo_root()).is_ok());
}

/// Every kind and edge resolves via `from_name`, every field name has a wire
/// key, and every `scalar:`/enum name is one `BoundValue` carries. Observable
/// end to end: a bound line writes assertions under real wire keys.
#[test]
fn kinds_fields_types_resolve() {
    let d = dict();
    let out = ingest(b"set security ike proposal IKE-P1 dh-group group14\n", &d)
        .expect("within the caps");
    let proposal = out
        .fragment
        .nodes
        .iter()
        .find(|n| n.fields.len() == 2)
        .expect("the proposal bound");
    // IkeProposal.name is 147 and IkeProposal.dh_group is 149 in
    // schema/field-keys.yaml.
    let keys: Vec<u32> = proposal.fields.iter().map(|f| f.key.0).collect();
    assert_eq!(keys, vec![147, 149]);
}

/// `14` §9.11 gate 2, widened to the detector's own rule (WO-03 §12 item 9):
/// a secret-word segment before a capture forces the entry to declare
/// `secret:` or `secret_exempt:`. The consequence is observable — every
/// catalogued secret path drops, and the one exempted path does not.
#[test]
fn secret_coupling_word_list() {
    let d = dict();
    let out = ingest(
        b"set security ike policy IKE-POL pre-shared-key ascii-text \"aVerySecretValue1\"\n\
          set system tacplus-server 192.0.2.7 secret aVerySecretValue2\n\
          set snmp community aVerySecretValue3\n\
          set security ipsec policy IPSEC-POL perfect-forward-secrecy keys group14\n",
        &d,
    )
    .expect("within the caps");
    assert_eq!(out.drops.entries.len(), 3, "three catalogued, one exempt");
    assert!(
        out.drops.entries.iter().all(|e| e.ordinal.0 < 3),
        "the exempt line never drops"
    );
}

/// `14` §6.3's CI constant, read as a per-entry backtracking allowance
/// (WO-03 §12 item 11): an entry's own-path lookup costs its straight-line
/// walk plus at most 8 extra visits, and no lookup exceeds the 64-visit
/// runtime budget. Measured exactly by `dict::tests::lookup_budget_within_8`,
/// which can see the trie; enforced here by the gate inside `load`.
#[test]
fn lookup_budget_within_8() {
    assert!(Dictionary::load(&repo_root()).is_ok());
}

/// Building the trie twice yields byte-identical output (invariant 9).
#[test]
fn trie_deterministic() {
    let a = format!("{:?}", dict());
    let b = format!("{:?}", dict());
    assert_eq!(a, b);
}
