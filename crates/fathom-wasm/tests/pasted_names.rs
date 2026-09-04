//! **The name the graph holds is the name the operator sees** — asserted over
//! a REAL paste, through the wire, for every element the paste produced.
//!
//! `fathom-inventory/tests/projection.rs` pins the same rule two ways: over
//! the demo estate (`a_bound_name_is_never_rendered_as_a_ulid`) and over the
//! schema (`every_kind_whose_schema_names_it_shows_that_name`). This file is
//! the third leg and the one CLAUDE.md's "chooser" bullet asks for: the demo
//! estate holds no `SecurityPolicy`, so on 2026-09-04 the first test was green
//! while a policy from `junos-srx-branch-documented.txt` titled its inspector
//! `security-policy:01M1…`. Nothing here names a kind it expects to find — it
//! reads what the paste built and holds every element of it to the rule.
//!
//! It also pins the one kind that stays a ULID on purpose. A `PolicySet` is
//! keyed on its zone pair at ingest and the pair is dropped with the
//! fragment; `PolicyScope` is a unit struct; no `PolicySet → Zone` edge is
//! declared. The findings row *"4 of 4 PolicySet nodes have no scope"* and
//! the ULID it lists under itself are the same fact stated twice, and this
//! test says so rather than letting a future reader mistake it for the defect
//! above.

mod common;

use fathom_inventory::InvKind;
use fathom_wasm::protocol::{
    decode_reply, FaceRowView, ReplyView, FACE_FIELD, FACE_GAP, FACE_GAP_ITEM, FACE_HEADER,
    FACE_INV,
};
use fathom_wasm::shell::Shell;
use fathom_wasm::{OP_ELEMENT, OP_FINDINGS, OP_INV_ROWS, OP_PASTE};

/// 2026-08-08T00:00:00Z, a stored value like every timestamp in this tree.
const TS: u64 = 1_786_147_200_000;
const ENTROPY: u128 = 0x0000_0000_0000_0000_2026;

fn frame(at: u64, entropy: u128, text: &[u8]) -> Vec<u8> {
    let mut f = Vec::with_capacity(25 + text.len());
    f.extend_from_slice(&at.to_le_bytes());
    f.extend_from_slice(&entropy.to_le_bytes());
    f.push(0);
    f.extend_from_slice(text);
    f
}

fn face(reply: &[u8]) -> Vec<FaceRowView> {
    match decode_reply(reply).expect("a well-formed reply") {
        ReplyView::FaceRows(rows) => rows,
        other => panic!("expected FaceRows, got {other:?}"),
    }
}

/// The documented SRX branch fixture, pasted through the shell exactly as the
/// page pastes it.
fn pasted_fixture() -> Shell {
    let text = std::fs::read(
        common::repo_root()
            .join("crates/fathom-ingest/tests/fixtures/junos-srx-branch-documented.txt"),
    )
    .expect("the branch fixture is checked in");
    let mut shell = common::booted_shell();
    let reply = shell.handle(OP_PASTE, &frame(TS, ENTROPY, &text));
    assert!(
        matches!(decode_reply(&reply), Ok(ReplyView::FaceRows(_))),
        "the paste must succeed: {reply:?}"
    );
    shell
}

/// A value the inspector renders for a field that is actually set — the same
/// three exclusions `fathom_inventory::element::bound` makes.
fn is_bound(value: &str) -> bool {
    !value.is_empty() && value != "—" && value != "absent"
}

fn kind_byte(kind: InvKind) -> u8 {
    InvKind::ALL
        .iter()
        .position(|k| *k == kind)
        .expect("every InvKind is in ALL") as u8
}

/// Every element of every inventory kind the fixture produced: if its own
/// `OP_ELEMENT` field table shows a bound `name`, `label` or `hostname`, the
/// header's name is not the header's id.
#[test]
fn every_pasted_element_with_a_bound_name_is_headed_by_it() {
    let mut shell = pasted_fixture();
    let mut checked = 0usize;
    let mut named = 0usize;
    let mut offenders: Vec<String> = Vec::new();
    let mut policies_seen: Vec<String> = Vec::new();

    for kind in InvKind::ALL {
        let rows = face(&shell.handle(OP_INV_ROWS, &[kind_byte(kind)]));
        for row in rows.iter().filter(|r| r.role == FACE_INV) {
            let id = row.strings[0].clone();
            let records = face(&shell.handle(OP_ELEMENT, id.as_bytes()));
            let head = records.first().expect("a header record");
            assert_eq!(head.role, FACE_HEADER, "{id}");
            assert_eq!(head.strings[2], id, "the header carries the id in full");
            let name = head.strings[1].clone();
            checked += 1;

            let has_bound_name = records.iter().skip(1).any(|f| {
                f.role == FACE_FIELD
                    && matches!(f.strings[0].as_str(), "name" | "label" | "hostname")
                    && is_bound(&f.strings[1])
            });
            if !has_bound_name {
                continue;
            }
            named += 1;
            if kind == InvKind::SecurityPolicy {
                policies_seen.push(name.clone());
            }
            if name == id {
                offenders.push(format!("{} {id} is headed by its own id", kind.label()));
            }
        }
    }

    // The fixture has four policies and every one of them is named on the
    // wire (`corpus/dict/junos-srx/security-policies.yaml` binds `name` on
    // every entry). Pinned so the loop above cannot pass by finding nothing.
    let mut expected = vec![
        "guests-to-untrust".to_owned(),
        "trust-to-contractors".to_owned(),
        "trust-to-untrust".to_owned(),
        "trust-to-vpn".to_owned(),
    ];
    expected.sort();
    policies_seen.sort();
    assert_eq!(
        policies_seen, expected,
        "the four policies the fixture declares, each headed by its own name"
    );
    assert!(
        checked >= 20,
        "only {checked} elements walked — the paste is thinner than the fixture"
    );
    assert!(
        named >= 12,
        "only {named} named elements — the rule was barely exercised"
    );
    assert!(
        offenders.is_empty(),
        "a kind whose name IS in the graph is showing the operator a ULID: {offenders:#?}"
    );
}

/// The findings view over the same paste: every listed example whose kind
/// declares a name is named, and `PolicySet` — the one kind the graph holds
/// nothing to name — is listed by its id, deliberately, under the very row
/// that says why.
#[test]
fn the_findings_rows_name_what_can_be_named_and_say_which_cannot() {
    let mut shell = pasted_fixture();
    let rows = face(&shell.handle(OP_FINDINGS, &[]));

    // Group index -> (kind, sentence). Items name their group by index in
    // slot 3, never by record order (`protocol.rs`, `FACE_GAP_ITEM`).
    let groups: Vec<(String, String)> = rows
        .iter()
        .filter(|r| r.role == FACE_GAP)
        .map(|r| (r.strings[0].clone(), r.strings[5].clone()))
        .collect();
    let items: Vec<&FaceRowView> = rows.iter().filter(|r| r.role == FACE_GAP_ITEM).collect();
    assert!(
        !items.is_empty(),
        "the fixture leaves gaps; a list with none is a different bug"
    );

    let scope_row = groups
        .iter()
        .find(|(k, s)| k == "PolicySet" && s.ends_with("have no scope"))
        .map(|(_, s)| s.clone())
        .expect("the fixture's four policy sets have no scope, and the view says so");
    assert_eq!(scope_row, "4 of 4 PolicySet nodes have no scope");

    // `PolicySet` declares TWO required fields nothing sets — `scope` and
    // `evaluation` — so the view carries two rows over the same four sets.
    // Counted per group rather than in total, so a third required field
    // arriving in `schema/` moves this by four and not by a number nobody
    // can read a cause off.
    let policy_set_groups = groups.iter().filter(|(k, _)| k == "PolicySet").count();
    assert!(policy_set_groups >= 1);
    let mut policy_set_items = 0usize;
    for it in items {
        let (id, name, kind) = (&it.strings[0], &it.strings[1], &it.strings[2]);
        if kind == "PolicySet" {
            policy_set_items += 1;
            assert_eq!(
                name, id,
                "a PolicySet is its id until PolicyScope has a shape — see display_name"
            );
            continue;
        }
        // Every other kind the fixture leaves a gap on either declares a name
        // (and the example must carry it) or composes one; none may be bare.
        assert_ne!(name, id, "{kind} example {id} is listed by its ULID");
    }
    assert_eq!(
        policy_set_items,
        4 * policy_set_groups,
        "all four sets are listed under each of their {policy_set_groups} gap rows, none capped"
    );
}
