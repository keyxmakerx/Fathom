//! `OP_FIELD_SET`'s CLEAR — the refusals that run BEFORE a batch opens.
//!
//! The clear shipped on 2026-09-05 (commit 1e0465a: an empty value runs
//! `Graph::clear_field`) and a skeptic broke it the same day, three ways. All
//! three were one hole seen from three sides: `parse_into_slot` is the one
//! place `is_authorable` was enforced, and a clear skipped it because there
//! was nothing to parse.
//!
//! 1. A journal `field` entry with an EMPTY value on a key nothing can type
//!    (`SecurityPolicy.action`) replayed as a clear — *"3 steps replayed"* —
//!    and blanked a value the parser had set, which no editor in the product
//!    could refill; the same entry with a value was refused *"cannot be typed
//!    in yet"*. The journal is the file an operator keeps, and ADR-0038's
//!    as-built note is the rule: a tampered record is refused, never guessed
//!    through.
//! 2. An empty value on a key the element's kind does not declare (9999, or
//!    `Interface.form` on a `Device`) opened a batch, was refused by the store
//!    as `UndeclaredField { … }` in Rust debug text (code 13), and left an
//!    EMPTY batch in the log — where the same key with a value was refused in
//!    English (code 11) before any batch. `Chassis.member_index` on a
//!    `Device` — a key the table CAN parse, on a kind that does not declare
//!    it — went the same way on BOTH paths, value or no value.
//! 3. Nothing stopped a clear of the one field the add door demands, so a box
//!    the door would have refused — no hostname, no platform — was two steps
//!    away, and a hostname-less `junos-srx` box made every junos-srx paste
//!    ask *"this may be that box"*.
//!
//! Every test here asserts the op log did not grow. A refusal writes nothing,
//! and `Graph::end_batch` pushes an empty batch as readily as a full one, so
//! "no error code" is not the same fact as "nothing was written".
//!
//! Each of these FAILS against 1e0465a. The first two were checked by running
//! them against that commit's `shell.rs`; the third by the driver
//! `2026-09-04-a-server-is-not-a-juniper-firewall.mjs`, which blanks the
//! hostname cell in Chromium and, on that build, gets *"cleared — now unset"*.

use fathom_ir::generated::ir_types::{
    ChassisField, DeviceField, InterfaceField, SecurityPolicyField,
};
use fathom_wasm::protocol::{
    decode_reply, ReplyView, ERR_EQUIP_FRAME, ERR_FIELD_VALUE, FACE_HEADER, FACE_INV,
};
use fathom_wasm::shell::Shell;
use fathom_wasm::{OP_EQUIP_ADD, OP_FIELD_SET, OP_INV_ROWS, OP_PASTE};

/// The dictionary is handed in over `OP_DICT`, so the pasting test below
/// boots the shell the way the page does. See `common/mod.rs`.
mod common;

/// 2026-08-08T00:00:00Z, the clock every paste test in this crate uses.
const TS: u64 = 1_786_147_200_000;
/// The paste's entropy, and a base for the edits FAR from it: the mint walks a
/// counter up from the entropy, and a second base inside the first's minted
/// range is a collision the store refuses (`paste.rs` learned this twice).
const PASTE_ENTROPY: u128 = 0x2026;
const EDIT_ENTROPY: u128 = 0x0000_0000_0000_0000_4000_0000;

/// `[u64 at][u128 entropy][u32 key][u16 id_len][id][value]` — `OP_FIELD_SET`'s
/// frame, duplicated from `equip.rs` for the same reason every test file
/// duplicates it: a shared helper crate would be a fourth place the wire
/// layout is written.
fn edit_frame(at_ms: u64, entropy: u128, key: u32, id: &str, value: &str) -> Vec<u8> {
    let mut v = Vec::new();
    v.extend_from_slice(&at_ms.to_le_bytes());
    v.extend_from_slice(&entropy.to_le_bytes());
    v.extend_from_slice(&key.to_le_bytes());
    v.extend_from_slice(&(id.len() as u16).to_le_bytes());
    v.extend_from_slice(id.as_bytes());
    v.extend_from_slice(value.as_bytes());
    v
}

/// `OP_EQUIP_ADD`'s frame: the 24-byte prefix, `[u8 count]`, then
/// `count` x `[u16 key][u16 len][utf8]`.
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

/// `OP_PASTE`'s frame: the prefix, one confirm byte (0), the text.
fn paste_frame(at_ms: u64, entropy: u128, text: &str) -> Vec<u8> {
    let mut f = Vec::with_capacity(25 + text.len());
    f.extend_from_slice(&at_ms.to_le_bytes());
    f.extend_from_slice(&entropy.to_le_bytes());
    f.push(0);
    f.extend_from_slice(text.as_bytes());
    f
}

/// The error code, or `None` when the reply is a face table — read through
/// the module's own decoder, the path the page takes.
fn is_error(reply: &[u8]) -> Option<u16> {
    match decode_reply(reply) {
        Ok(ReplyView::Error(e)) => Some(e.code),
        _ => None,
    }
}

/// The refusal's sentence, or empty when the reply was not a refusal — so a
/// test can say what it expected in the sentence AND fail legibly when the
/// op went through instead.
fn detail(reply: &[u8]) -> String {
    match decode_reply(reply) {
        Ok(ReplyView::Error(e)) => e.detail,
        _ => String::new(),
    }
}

/// The wire byte of an `InvKind`, found BY NAME (`equip.rs` says why a
/// position is never derived from the length).
fn kind_byte(label: &str) -> u8 {
    fathom_inventory::InvKind::ALL
        .iter()
        .position(|k| k.label() == label)
        .unwrap_or_else(|| panic!("`{label}` is not an InvKind")) as u8
}

/// How many batches the op log holds. Zero with no estate, which is exactly
/// what "nothing was written" means before the first add.
fn log_len(shell: &Shell) -> usize {
    shell.estate_for_test().map_or(0, |g| g.log().len())
}

/// One cell of one row of one row set, by KIND LABEL, ROW ID and COLUMN
/// LABEL — never by position. Returns the id with it, so the first row's id
/// can be discovered and then re-read.
fn cell(shell: &mut Shell, kind: &str, id: Option<&str>, column: &str) -> (String, String) {
    let reply = shell.handle(OP_INV_ROWS, &[kind_byte(kind)]);
    let Ok(ReplyView::FaceRows(rows)) = decode_reply(&reply) else {
        panic!("the {kind} inventory must answer with a face table, got {reply:?}")
    };
    let head = rows
        .iter()
        .find(|r| r.role == FACE_HEADER)
        .expect("a header row");
    let ci = head
        .strings
        .iter()
        .position(|h| h == column)
        .unwrap_or_else(|| panic!("no `{column}` column in {:?}", head.strings));
    let row = rows
        .iter()
        .filter(|r| r.role == FACE_INV)
        .find(|r| id.is_none_or(|want| r.strings[0] == want))
        .unwrap_or_else(|| panic!("no {kind} row for {id:?}"));
    (row.strings[0].clone(), row.strings[ci].clone())
}

/// A hand-added box, as the form adds it: hostname and a borrowed platform.
fn add_device(shell: &mut Shell, name: &str) -> String {
    let reply = shell.handle(
        OP_EQUIP_ADD,
        &equip_frame(
            1_700_000_000_000,
            0x2026_0905_0000_0000_0000_0000_0000_0001,
            &[
                (DeviceField::Hostname.key().0, name),
                (DeviceField::Platform.key().0, "junos-srx"),
            ],
        ),
    );
    assert_eq!(is_error(&reply), None, "setup add refused: {reply:?}");
    cell(shell, "Device", None, "hostname").0
}

// --- 1. the gate --------------------------------------------------------------

/// **A JOURNAL CLEAR OF A FIELD NOTHING CAN TYPE IS REFUSED, BEFORE ANY
/// BATCH, WITH THE SENTENCE A SET GETS.**
///
/// The parser sets `SecurityPolicy.action` from `then permit`; no editor can,
/// because `policy_action` is not in `author.rs`'s table. Until 2026-09-05 a
/// `field` entry `{key: action, value: ""}` replayed and blanked it — the
/// findings view then reported *"1 of 4 SecurityPolicy nodes has no action"*
/// with no way to fill it — while `{key: action, value: "deny"}` was refused.
/// Same key, same element, same journal file, opposite answers.
#[test]
fn a_journal_clear_of_a_field_nothing_can_type_is_refused_before_any_batch() {
    let mut shell = common::booted_shell();
    let fixture = std::fs::read_to_string(
        common::repo_root()
            .join("crates/fathom-ingest/tests/fixtures/junos-srx-branch-documented.txt"),
    )
    .expect("the documented SRX branch fixture is checked in");
    let reply = shell.handle(OP_PASTE, &paste_frame(TS, PASTE_ENTROPY, &fixture));
    assert!(
        matches!(decode_reply(&reply), Ok(ReplyView::FaceRows(_))),
        "the paste: {reply:?}"
    );

    let (id, action) = cell(&mut shell, "SecurityPolicy", None, "action");
    assert_eq!(action, "permit", "the premise: the parser set an action");
    let key = SecurityPolicyField::Action.key();
    assert!(
        !fathom_inventory::is_authorable(key),
        "the premise: nothing can type a policy action yet"
    );
    let batches = log_len(&shell);

    let cleared = shell.handle(
        OP_FIELD_SET,
        &edit_frame(TS + 1, EDIT_ENTROPY, key.0, &id, ""),
    );
    let set = shell.handle(
        OP_FIELD_SET,
        &edit_frame(TS + 2, EDIT_ENTROPY + 0x100, key.0, &id, "deny"),
    );
    assert_eq!(
        is_error(&cleared),
        Some(ERR_FIELD_VALUE),
        "the clear must be refused as a set is: {cleared:?}"
    );
    assert!(
        detail(&cleared).contains("cannot be typed in yet"),
        "{}",
        detail(&cleared)
    );
    assert_eq!(
        detail(&cleared),
        detail(&set),
        "the clear and the set must give the operator one sentence"
    );
    assert_eq!(
        log_len(&shell),
        batches,
        "a refusal must leave the log exactly as it was"
    );
    assert_eq!(
        cell(&mut shell, "SecurityPolicy", Some(&id), "action").1,
        "permit",
        "and the parser's value stands"
    );
}

// --- 2. an undeclared key, both paths -----------------------------------------

/// **A KEY THAT IS NOT A FIELD OF THE BOX IS REFUSED IN ENGLISH, CODE 11,
/// BEFORE ANY BATCH — WITH OR WITHOUT A VALUE.**
///
/// Three keys, three reasons, one answer each time. 9999 is in no schema.
/// `Interface.form` is real, on another kind, and nothing can type it.
/// `Chassis.member_index` is real, on another kind, and the table CAN parse
/// it — the case the first two do not cover, because it reaches the store,
/// and the store's `UndeclaredField` arrived as debug text with an empty
/// batch behind it. The empty-value column failed all three on 1e0465a; the
/// value column failed the third.
#[test]
fn an_undeclared_key_is_refused_in_english_before_any_batch_on_both_paths() {
    let mut shell = Shell::new();
    let id = add_device(&mut shell, "truenas-01");
    let batches = log_len(&shell);
    let mut entropy = EDIT_ENTROPY;
    let mut at = 1_700_000_000_001u64;

    for (key, value, word) in [
        (9999u32, "x", "not in the schema"),
        (InterfaceField::Form.key().0, "x", "cannot be typed in yet"),
        (
            ChassisField::MemberIndex.key().0,
            "3",
            "not a field of a Device",
        ),
    ] {
        let mut send = |text: &str| {
            entropy += 0x100;
            at += 1;
            shell.handle(OP_FIELD_SET, &edit_frame(at, entropy, key, &id, text))
        };
        let clear = send("");
        let set = send(value);
        for (which, reply) in [("clear", &clear), ("set", &set)] {
            assert_eq!(
                is_error(reply),
                Some(ERR_FIELD_VALUE),
                "key {key}, {which}: refused before the store, in English: {reply:?}"
            );
            assert!(
                detail(reply).contains(word),
                "key {key}, {which}: {}",
                detail(reply)
            );
            assert!(
                !detail(reply).contains("UndeclaredField"),
                "key {key}, {which}: a Rust debug string reached the page"
            );
        }
        assert_eq!(
            detail(&clear),
            detail(&set),
            "key {key}: the two paths must give one sentence"
        );
        assert_eq!(
            log_len(&shell),
            batches,
            "key {key}: a refusal left a batch in the log"
        );
    }
}

// --- 3. the floor -------------------------------------------------------------

/// **WHAT THE DOOR DEMANDS CANNOT BE CLEARED.**
///
/// The add door refuses a device without a hostname; the clear now refuses to
/// take one away, reading the same list the door reads. The refusal names
/// the field and says what to do instead — a correction, which still works.
#[test]
fn what_the_door_demands_cannot_be_cleared() {
    let mut shell = Shell::new();
    let id = add_device(&mut shell, "truenas-01");
    let batches = log_len(&shell);
    let hostname = DeviceField::Hostname.key().0;

    let cleared = shell.handle(
        OP_FIELD_SET,
        &edit_frame(1_700_000_000_001, EDIT_ENTROPY, hostname, &id, ""),
    );
    assert_eq!(
        is_error(&cleared),
        Some(ERR_FIELD_VALUE),
        "blanking the hostname must be refused: {cleared:?}"
    );
    let why = detail(&cleared);
    assert!(
        why.contains("needs a hostname") && why.contains("instead of clearing"),
        "the sentence names the field and the way out: {why}"
    );
    assert_eq!(log_len(&shell), batches, "a refusal writes nothing");
    assert_eq!(
        cell(&mut shell, "Device", Some(&id), "hostname").1,
        "truenas-01",
        "the name is still there"
    );

    // The door and the floor are one list: an add without the field is
    // refused naming the same field the clear named.
    let door = shell.handle(
        OP_EQUIP_ADD,
        &equip_frame(
            1_700_000_000_002,
            EDIT_ENTROPY + 0x100,
            &[(DeviceField::Platform.key().0, "junos-srx")],
        ),
    );
    assert_eq!(is_error(&door), Some(ERR_EQUIP_FRAME), "{door:?}");
    assert!(
        detail(&door).contains("needs a hostname"),
        "{}",
        detail(&door)
    );

    // What the sentence tells the operator to do instead still works.
    let renamed = shell.handle(
        OP_FIELD_SET,
        &edit_frame(
            1_700_000_000_003,
            EDIT_ENTROPY + 0x200,
            hostname,
            &id,
            "truenas-02",
        ),
    );
    assert_eq!(is_error(&renamed), None, "a correction: {renamed:?}");
    assert_eq!(
        cell(&mut shell, "Device", Some(&id), "hostname").1,
        "truenas-02"
    );
    assert_eq!(log_len(&shell), batches + 1, "and it is one batch, not two");
}

/// The floor is the door's list and nothing wider: a field the door does not
/// demand still clears, so the deliverable 1e0465a shipped — taking a
/// borrowed `junos-srx` back out — is not lost to its repair.
#[test]
fn a_field_the_door_does_not_demand_still_clears() {
    let mut shell = Shell::new();
    let id = add_device(&mut shell, "truenas-01");
    let reply = shell.handle(
        OP_FIELD_SET,
        &edit_frame(
            1_700_000_000_001,
            EDIT_ENTROPY,
            DeviceField::Platform.key().0,
            &id,
            "",
        ),
    );
    assert_eq!(is_error(&reply), None, "the platform clear: {reply:?}");
    assert_eq!(cell(&mut shell, "Device", Some(&id), "platform").1, "—");
}
