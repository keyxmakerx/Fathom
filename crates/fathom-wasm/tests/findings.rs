//! `OP_FINDINGS` — what the estate does not know yet, driven through the shell
//! the way the page drives it (`57` §13.5 consequence 3).
//!
//! The properties these hold, in order of what losing one would cost:
//!
//! 1. **A count is a count.** Every number in the reply is a count of live
//!    elements the store actually holds. A view whose numbers are approximate
//!    is worse than no view, because an operator works a list down to zero and
//!    a wrong zero is a lie he acts on.
//! 2. **The required half comes from the schema.** No test below names a
//!    required field by writing one out; each asks
//!    `ir_types::field_required` and would follow `schema/` if the `card:`
//!    column moved (ADR-0008).
//! 3. **The list moves with the graph**, and never carries a number over from
//!    the last answer.
//! 4. **Zero because there are none is not zero because they are complete.**
//!    A kind the estate holds nothing of is named, so the view cannot be read
//!    as saying the cabling is finished.
//! 5. **A row that cannot be acted on says so**, rather than reading as work
//!    somebody could do today.
//!
//! The three-state presence rule itself — `Set`, `Absent`, `Unknown` — is
//! asserted in `fathom-inventory`'s own tests against a real `Graph`, because
//! two of the three states have no route in through the shell. See
//! `the_list_moves_with_the_graph` for why.

mod common;

use fathom_ir::bag::FieldKey;
use fathom_ir::generated::ir_types::{self, ChassisField, DeviceField, NodeKind};
use fathom_wasm::protocol::{
    decode_reply, ReplyView, ERR_BAD_FRAME, ERR_NOT_INITIALISED, FACE_GAP, FACE_GAP_EMPTY,
    FACE_GAP_HEAD, FACE_GAP_ITEM, FACE_INV,
};
use fathom_wasm::shell::Shell;
use fathom_wasm::{OP_ELEMENT_REMOVE, OP_EQUIP_ADD, OP_FINDINGS, OP_INV_ROWS, OP_PASTE};

fn equip_frame(at_ms: u64, entropy: u128, fields: &[(u32, &str)]) -> Vec<u8> {
    let mut v = Vec::new();
    v.extend_from_slice(&at_ms.to_le_bytes());
    v.extend_from_slice(&entropy.to_le_bytes());
    v.push(fields.len() as u8);
    for (key, text) in fields {
        v.extend_from_slice(&(*key as u16).to_le_bytes());
        v.extend_from_slice(&(text.len() as u16).to_le_bytes());
        v.extend_from_slice(text.as_bytes());
    }
    v
}

fn is_error(reply: &[u8]) -> Option<u16> {
    match decode_reply(reply) {
        Ok(ReplyView::Error(e)) => Some(e.code),
        _ => None,
    }
}

fn kind_byte(label: &str) -> u8 {
    fathom_inventory::InvKind::ALL
        .iter()
        .position(|k| k.label() == label)
        .unwrap_or_else(|| panic!("`{label}` is not an InvKind")) as u8
}

struct GapRow {
    kind: String,
    field: String,
    missing: usize,
    population: usize,
    carried: usize,
    sentence: String,
    authorable: bool,
    /// The display ids the group carried, in reply order.
    items: Vec<String>,
}

struct View {
    groups: usize,
    facts: usize,
    checked: usize,
    kinds_present: usize,
    gaps: Vec<GapRow>,
    empty: Vec<(String, usize)>,
}

impl View {
    fn gap(&self, kind: &str, field: &str) -> Option<&GapRow> {
        self.gaps
            .iter()
            .find(|g| g.kind == kind && g.field == field)
    }
}

fn read(shell: &mut Shell) -> View {
    let reply = shell.handle(OP_FINDINGS, &[]);
    assert_eq!(is_error(&reply), None, "OP_FINDINGS: {reply:?}");
    let Ok(ReplyView::FaceRows(rows)) = decode_reply(&reply) else {
        panic!("the findings view must answer with a face table")
    };
    let head = rows.first().expect("a head row");
    assert_eq!(head.role, FACE_GAP_HEAD, "the head row is always record 0");

    let mut gaps: Vec<GapRow> = Vec::new();
    let mut empty: Vec<(String, usize)> = Vec::new();
    for r in rows.iter().skip(1) {
        match r.role {
            FACE_GAP => gaps.push(GapRow {
                kind: r.strings[0].clone(),
                field: r.strings[1].clone(),
                missing: r.strings[2].parse().expect("a decimal count"),
                population: r.strings[3].parse().expect("a decimal count"),
                carried: r.strings[4].parse().expect("a decimal count"),
                sentence: r.strings[5].clone(),
                authorable: r.strings[6] == "1",
                items: Vec::new(),
            }),
            FACE_GAP_ITEM => {
                let group: usize = r.strings[3].parse().expect("a decimal group index");
                assert!(group < gaps.len(), "an item names a group that came later");
                gaps[group].items.push(r.strings[0].clone());
            }
            FACE_GAP_EMPTY => empty.push((
                r.strings[0].clone(),
                r.strings[1].parse().expect("a decimal count"),
            )),
            other => panic!("unexpected role {other} in a findings reply"),
        }
    }
    View {
        groups: head.strings[0].parse().expect("a decimal count"),
        facts: head.strings[1].parse().expect("a decimal count"),
        checked: head.strings[2].parse().expect("a decimal count"),
        kinds_present: head.strings[3].parse().expect("a decimal count"),
        gaps,
        empty,
    }
}

/// Add one device by hand, stating only what the form makes mandatory, and
/// answer with its device display id.
fn a_device(shell: &mut Shell, at: u64, hostname: &str) -> String {
    let reply = shell.handle(
        OP_EQUIP_ADD,
        &equip_frame(
            at,
            at as u128,
            &[
                (DeviceField::Hostname.key().0, hostname),
                (DeviceField::Platform.key().0, "junos-srx"),
                (ChassisField::MemberIndex.key().0, "0"),
            ],
        ),
    );
    assert_eq!(is_error(&reply), None, "adding {hostname}: {reply:?}");
    let rows = shell.handle(OP_INV_ROWS, &[kind_byte("Device")]);
    let Ok(ReplyView::FaceRows(rows)) = decode_reply(&rows) else {
        panic!("the device inventory must answer with a face table")
    };
    rows.iter()
        .find(|r| r.role == FACE_INV && r.strings[1] == hostname)
        .unwrap_or_else(|| panic!("no inventory row for {hostname}"))
        .strings[0]
        .clone()
}

// --- 1. the empty state ------------------------------------------------------

/// No estate is NOT "nothing is missing", and the wire keeps them apart.
///
/// Rendering the two the same way would tell an operator who has pasted
/// nothing that his estate is complete, which is the worst sentence this view
/// could produce.
#[test]
fn no_estate_is_refused_not_answered_with_zero() {
    let mut shell = Shell::new();
    assert_eq!(
        is_error(&shell.handle(OP_FINDINGS, &[])),
        Some(ERR_NOT_INITIALISED)
    );
}

#[test]
fn the_opcode_takes_no_request_bytes() {
    let mut shell = Shell::new();
    assert_eq!(
        is_error(&shell.handle(OP_FINDINGS, b"x")),
        Some(ERR_BAD_FRAME)
    );
}

// --- 2. the counts are the graph's ------------------------------------------

/// Three hand-added devices, and the numbers are checked against what the
/// store holds rather than against a remembered total.
///
/// `Device.role` is `card: "0..1"` and `Device.platform` is `card: "1"`, so
/// the un-stated role must NOT appear and the un-stated ones that are required
/// must. Neither fact is written out below: the test asks the generated table.
#[test]
fn every_count_is_a_count_of_what_the_store_holds() {
    let mut shell = Shell::new();
    for (i, host) in ["sw-core-01", "sw-core-02", "fw-edge-01"]
        .iter()
        .enumerate()
    {
        a_device(&mut shell, 1_700_000_000_000 + i as u64, host);
    }

    let v = read(&mut shell);
    assert_eq!(
        v.groups,
        v.gaps.len(),
        "the head row counts the groups it sent"
    );
    assert_eq!(
        v.facts,
        v.gaps.iter().map(|g| g.missing).sum::<usize>(),
        "the head row's fact count is the sum of the groups'"
    );
    // Three devices and three chassis: `OP_EQUIP_ADD` makes both.
    assert_eq!(v.checked, 6, "three devices and their three chassis");
    assert_eq!(v.kinds_present, 2, "Device and Chassis");

    // `Device.name_conformance` is required and the hand-entry form does not
    // ask for it, so all three devices lack it.
    let key = DeviceField::NameConformance.key();
    assert!(
        ir_types::field_required(key),
        "this test is only meaningful while the schema declares it required"
    );
    let g = v
        .gap("Device", "name_conformance")
        .expect("three devices with no name_conformance");
    assert_eq!(g.missing, 3);
    assert_eq!(g.population, 3);
    assert_eq!(g.sentence, "3 of 3 Device nodes have no name_conformance");

    // Hostname and platform WERE stated, so neither is a gap.
    assert!(v.gap("Device", "hostname").is_none());
    assert!(v.gap("Device", "platform").is_none());

    // `role` is optional. An optional field nobody stated is not a gap, or the
    // list would be every unset field in the schema and unworkable.
    assert!(
        !ir_types::field_required(DeviceField::Role.key()),
        "this test is only meaningful while the schema declares role optional"
    );
    assert!(v.gap("Device", "role").is_none());
}

/// The order is a work list: biggest first, and ties in schema declaration
/// order. Determinism is invariant 9, so the same estate is asked twice.
#[test]
fn the_biggest_gap_is_first_and_the_order_never_moves() {
    let mut shell = Shell::new();
    for (i, host) in ["a", "b", "c", "d"].iter().enumerate() {
        a_device(&mut shell, 1_700_000_000_000 + i as u64, host);
    }
    // One chassis of the four gets a model, so Chassis.model — if it were
    // required — would sit below name_conformance. It is not required; what
    // this asserts is the ordering rule itself.
    let v = read(&mut shell);
    let counts: Vec<usize> = v.gaps.iter().map(|g| g.missing).collect();
    let mut sorted = counts.clone();
    sorted.sort_unstable_by(|a, b| b.cmp(a));
    assert_eq!(counts, sorted, "the list must run biggest gap first");

    let again = read(&mut shell);
    let a: Vec<String> = v.gaps.iter().map(|g| g.sentence.clone()).collect();
    let b: Vec<String> = again.gaps.iter().map(|g| g.sentence.clone()).collect();
    assert_eq!(a, b, "the same estate answers the same way every time");
}

// --- 3. the list moves with the graph ---------------------------------------

/// The list tracks the estate: adding a device grows a gap, removing it
/// shrinks the same gap, and the numbers are never carried over from the last
/// answer.
///
/// **Removal, not a field write, and that is a finding in itself.** The
/// property this test wanted was *"state the fact and the gap goes"*, and no
/// route through the shell can produce it: `OP_EQUIP_ADD` refuses a device
/// without `hostname` or `platform`, fills `Chassis.member_index` with `"0"`
/// when the form omits it, and the two required fields that remain unstated —
/// `Device.name_conformance` and `Interface.form` — are both refused by
/// `OP_FIELD_SET` as not authorable. So the fill-it round trip is exercised
/// against a real `Graph` in `fathom-inventory`'s own tests, where a value can
/// be written, and what is asserted HERE is the half the browser can reach.
#[test]
fn the_list_moves_with_the_graph() {
    let mut shell = Shell::new();
    a_device(&mut shell, 1_700_000_000_000, "sw-core-01");
    let one = read(&mut shell);
    let g = one
        .gap("Device", "name_conformance")
        .expect("a device with no name_conformance");
    assert_eq!(g.missing, 1);
    assert_eq!(g.sentence, "1 of 1 Device nodes has no name_conformance");

    let id = a_device(&mut shell, 1_700_000_000_001, "sw-core-02");
    let two = read(&mut shell);
    assert_eq!(two.gap("Device", "name_conformance").unwrap().missing, 2);
    assert_eq!(two.checked, one.checked + 2, "a device brings its chassis");

    let mut frame = Vec::new();
    frame.extend_from_slice(&1_700_000_000_002u64.to_le_bytes());
    frame.extend_from_slice(&11u128.to_le_bytes());
    frame.extend_from_slice(id.as_bytes());
    let reply = shell.handle(OP_ELEMENT_REMOVE, &frame);
    assert_eq!(is_error(&reply), None, "removing {id}: {reply:?}");

    let after = read(&mut shell);
    assert_eq!(
        after.gap("Device", "name_conformance").unwrap().missing,
        1,
        "a removed element is not work anybody has left to do"
    );
    assert_eq!(after.checked, one.checked, "and it is no longer walked");
}

/// A row that cannot be acted on says so, rather than reading as a job.
///
/// This is the least comfortable assertion in the file and it is the one worth
/// keeping: **both** gaps this build can produce are fields nothing can type
/// in. A view that quietly presented them as work would send an operator
/// looking for an editor that is not there.
#[test]
fn a_gap_says_whether_it_can_be_typed_in() {
    let mut shell = Shell::new();
    a_device(&mut shell, 1_700_000_000_000, "sw-core-01");
    let v = read(&mut shell);
    let g = v.gap("Device", "name_conformance").expect("the gap");
    assert_eq!(
        g.authorable,
        fathom_inventory::is_authorable(DeviceField::NameConformance.key()),
        "the row's mark is the same answer the inspector gives for the field"
    );
    assert!(
        !g.authorable,
        "name_conformance has no parser, and the row must not pretend otherwise"
    );
}

// --- 4. zero because there are none -----------------------------------------

/// `Cable` and `PhysicalPort` are declared, have required fields, and nothing
/// in this build creates either (`57` §6.2). The view must SAY the estate
/// holds none rather than report a silent zero that reads as "complete".
#[test]
fn a_kind_the_estate_holds_none_of_is_named() {
    let mut shell = Shell::new();
    a_device(&mut shell, 1_700_000_000_000, "sw-core-01");
    let v = read(&mut shell);

    for kind in ["Cable", "PhysicalPort"] {
        assert!(
            v.empty.iter().any(|(k, _)| k == kind),
            "{kind} is empty and must be named, not passed over: {:?}",
            v.empty.iter().map(|(k, _)| k.as_str()).collect::<Vec<_>>()
        );
        assert!(
            v.gaps.iter().all(|g| g.kind != kind),
            "{kind} has no elements, so it can have no gaps"
        );
    }

    // The count beside each is how many required fields went unchecked, and it
    // is read from the schema, not written here.
    let (_, n) = v
        .empty
        .iter()
        .find(|(k, _)| k == "PhysicalPort")
        .expect("PhysicalPort");
    let declared = NodeKind::PhysicalPort
        .fields()
        .iter()
        .filter(|k| ir_types::field_required(**k))
        .count();
    assert_eq!(*n, declared, "the unchecked count is the schema's own");
    assert!(
        declared > 0,
        "PhysicalPort declares at least one card 1 field"
    );

    // `Cable` declares NO required field at all, and it is still named. This
    // is the assertion that would have been lost to a "only kinds with
    // something to check" filter, which is the natural way to write this and
    // drops exactly the kind `57` §6.2 is about.
    let (_, cable) = v.empty.iter().find(|(k, _)| k == "Cable").expect("Cable");
    assert_eq!(
        *cable, 0,
        "Cable declares nothing at card 1, and the row says so rather than \
         omitting the kind"
    );

    // A kind the estate DOES hold is never in the empty list — the two sets
    // partition the schema's kinds between them.
    assert!(
        !v.empty.iter().any(|(k, _)| k == "Device"),
        "a populated kind cannot be reported as empty"
    );
    assert_eq!(
        v.empty.len() + v.kinds_present,
        NodeKind::ALL.len(),
        "every declared kind is either present or reported empty; nothing falls \
         between the two"
    );
}

// --- 5. every row is actionable ---------------------------------------------

/// A row that names a count and nothing else is not work. Each group carries
/// the display ids of the elements it counted, capped, and the cap is stated
/// rather than silent.
#[test]
fn each_group_carries_the_elements_it_counted() {
    let mut shell = Shell::new();
    let mut ids: Vec<String> = Vec::new();
    for i in 0..3 {
        ids.push(a_device(
            &mut shell,
            1_700_000_000_000 + i,
            &format!("host-{i}"),
        ));
    }
    let v = read(&mut shell);
    let g = v.gap("Device", "name_conformance").expect("the gap");
    assert_eq!(
        g.carried,
        g.items.len(),
        "the row states how many it carried"
    );
    assert_eq!(g.items.len(), 3);
    for id in &ids {
        assert!(
            g.items.contains(id),
            "{id} is missing the field and must be listed"
        );
    }
}

/// The cap is real and it is not silent: `missing` stays the true count while
/// `carried` says how many ids came with it.
#[test]
fn the_example_cap_is_stated_never_hidden() {
    let mut shell = Shell::new();
    let n = fathom_inventory::EXAMPLES_PER_GAP + 5;
    for i in 0..n {
        a_device(
            &mut shell,
            1_700_000_000_000 + i as u64,
            &format!("host-{i}"),
        );
    }
    let v = read(&mut shell);
    let g = v.gap("Device", "name_conformance").expect("the gap");
    assert_eq!(g.missing, n, "the count is of the estate, not of the list");
    assert_eq!(g.carried, fathom_inventory::EXAMPLES_PER_GAP);
    assert_eq!(g.items.len(), fathom_inventory::EXAMPLES_PER_GAP);
    assert!(g.sentence.starts_with(&format!("{n} of {n} Device nodes")));
}

// --- 6. through a real paste -------------------------------------------------

/// The same walk over an estate the PARSER built, not one a test wrote.
///
/// A pasted config produces kinds hand entry never reaches, so this is the
/// only way to find out whether the view says anything useful about the input
/// the product actually has.
#[test]
fn a_pasted_config_reports_gaps_the_parser_left() {
    let mut shell = common::booted_shell();
    let config = "\
set system host-name fw-branch-01
set interfaces ge-0/0/0 unit 0 family inet address 10.1.1.1/24
set interfaces ge-0/0/1 unit 0 family inet address 10.1.2.1/24
set security zones security-zone trust interfaces ge-0/0/0.0
";
    let mut frame = Vec::new();
    frame.extend_from_slice(&1_700_000_000_000u64.to_le_bytes());
    frame.extend_from_slice(&9u128.to_le_bytes());
    frame.extend_from_slice(config.as_bytes());
    let reply = shell.handle(OP_PASTE, &frame);
    assert_eq!(
        is_error(&reply),
        None,
        "the paste must be understood: {reply:?}"
    );

    let v = read(&mut shell);
    assert!(v.checked > 0, "the paste built elements to walk");
    assert!(
        v.kinds_present > 1,
        "a config with interfaces and a zone builds more than one kind"
    );
    // Every group's numerator is bounded by its denominator, which is the one
    // arithmetic claim the whole view rests on.
    for g in &v.gaps {
        assert!(
            g.missing <= g.population && g.population > 0,
            "{}: {} of {} is not a count",
            g.kind,
            g.missing,
            g.population
        );
        assert!(
            ir_types::field_required(field_key(&g.kind, &g.field)),
            "{}.{} is reported as missing but the schema does not require it",
            g.kind,
            g.field
        );
    }
}

/// The wire key for `<kind>.<field>`, read out of the generated registry so
/// the assertion above cannot drift from `schema/`.
fn field_key(kind: &str, field: &str) -> FieldKey {
    let want = format!("{kind}.{field}");
    let (_, k) = ir_types::FIELD_KEYS
        .iter()
        .find(|(n, _)| *n == want)
        .unwrap_or_else(|| panic!("`{want}` is not a declared field"));
    FieldKey(*k)
}
