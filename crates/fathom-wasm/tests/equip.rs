//! `OP_EQUIP_ADD` — the second door into the estate, and the first that does
//! not destroy what is already there.
//!
//! The three properties these exist to hold, in order of what they would cost:
//!
//! 1. **Adding does not replace.** Every write before this opcode installed a
//!    fresh `Graph`. If that ever becomes true here, adding a second device
//!    deletes the first, silently, and the operator's work is gone. `OP_PASTE`
//!    shipped with exactly that defect and it was live for a day.
//! 2. **A refusal writes nothing.** A half-built device the user then has to
//!    find and remove is worse than a rejected form.
//! 3. **No estate is needed first.** The whole point of this door is that you
//!    can start from an empty page, with no config to paste.

use fathom_ir::generated::ir_types::{ChassisField, DeviceField};
use fathom_wasm::protocol::{
    decode_reply, ReplyView, ERR_EQUIP_FRAME, ERR_FIELD_VALUE, ERR_NOT_INITIALISED, FACE_INV,
};
use fathom_wasm::shell::Shell;
use fathom_wasm::{OP_EQUIP_ADD, OP_INV_ROWS};

/// The wire frame: 24-byte clock+entropy prefix, then `[u8 count]` and
/// `count` x `[u16 key][u16 len][utf8]`.
fn frame(at_ms: u64, entropy: u128, fields: &[(u32, &str)]) -> Vec<u8> {
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

/// The error code, or `None` when the reply is a face table. Read through the
/// module's own decoder so these tests exercise the same path the page does.
fn is_error(reply: &[u8]) -> Option<u16> {
    match decode_reply(reply) {
        Ok(ReplyView::Error(e)) => Some(e.code),
        _ => None,
    }
}

/// How many device rows the inventory reports. `FACE_INV` rows are the table's
/// body; `FACE_HEADER` is the column titles and is not a device.
///
/// `ERR_NOT_INITIALISED` counts as zero, and deliberately: after a refused add
/// there is no estate at all, which is exactly the state "nothing was written"
/// describes. Treating it as a test failure would make the strongest assertion
/// here -- that a refusal leaves nothing behind -- impossible to write.
fn rows_for(shell: &mut Shell, kind: u8) -> usize {
    let reply = shell.handle(OP_INV_ROWS, &[kind]);
    match decode_reply(&reply) {
        Ok(ReplyView::FaceRows(rows)) => rows.iter().filter(|r| r.role == FACE_INV).count(),
        Ok(ReplyView::Error(e)) if e.code == ERR_NOT_INITIALISED => 0,
        other => panic!("the inventory must answer with a face table, got {other:?}"),
    }
}

const DEVICE_KIND_BYTE: u8 = 0;

/// The owner's sentence, end to end: add a device, set its type and model, with
/// no config pasted and no estate to begin with.
#[test]
fn adds_a_device_with_a_model_from_nothing() {
    let mut shell = Shell::new();
    let reply = shell.handle(
        OP_EQUIP_ADD,
        &frame(
            1_700_000_000_000,
            0x0123_4567_89ab_cdef_0123_4567_89ab_cdef,
            &[
                (DeviceField::Hostname.key().0, "srx-hq-01"),
                (DeviceField::Platform.key().0, "junos-srx"),
                (DeviceField::Role.key().0, "firewall"),
                (ChassisField::Model.key().0, "SRX345"),
            ],
        ),
    );
    assert_eq!(is_error(&reply), None, "the add was refused: {reply:?}");
    assert_eq!(
        rows_for(&mut shell, DEVICE_KIND_BYTE),
        1,
        "one hand-added device should be one inventory row"
    );
}

/// THE regression this opcode exists to avoid. `OP_PASTE` and `OP_ESTATE_DEMO`
/// both replace the estate; if this one ever does, the operator loses work with
/// no error and no undo.
#[test]
fn a_second_device_does_not_delete_the_first() {
    let mut shell = Shell::new();
    for (i, name) in ["srx-hq-01", "srx-branch-02", "mx-core-03"]
        .iter()
        .enumerate()
    {
        let reply = shell.handle(
            OP_EQUIP_ADD,
            &frame(
                1_700_000_000_000 + i as u64,
                0x1111_2222_3333_4444_5555_6666_7777_8888 + i as u128,
                &[
                    (DeviceField::Hostname.key().0, name),
                    (DeviceField::Platform.key().0, "junos-srx"),
                ],
            ),
        );
        assert_eq!(is_error(&reply), None, "add {i} refused: {reply:?}");
        assert_eq!(
            rows_for(&mut shell, DEVICE_KIND_BYTE),
            i + 1,
            "after {} adds the inventory must hold {}",
            i + 1,
            i + 1
        );
    }
}

/// Hand entry must not destroy a pasted estate either — the two doors share one
/// room.
#[test]
fn adding_to_a_demo_estate_keeps_it() {
    let mut shell = Shell::new();
    shell.handle(fathom_wasm::OP_ESTATE_DEMO, &[]);
    let before = rows_for(&mut shell, DEVICE_KIND_BYTE);
    assert!(before > 0, "the demo estate should hold devices");

    let reply = shell.handle(
        OP_EQUIP_ADD,
        &frame(
            1_700_000_000_000,
            0xdead_beef_dead_beef_dead_beef_dead_beef,
            &[
                (DeviceField::Hostname.key().0, "added-by-hand"),
                (DeviceField::Platform.key().0, "junos-srx"),
            ],
        ),
    );
    assert_eq!(is_error(&reply), None, "refused: {reply:?}");
    assert_eq!(
        rows_for(&mut shell, DEVICE_KIND_BYTE),
        before + 1,
        "the demo devices must survive a hand-added one"
    );
}

/// A typo in one field must leave the estate untouched — not a device with
/// three of its four fields set that the user has to find and delete.
#[test]
fn a_refused_value_writes_nothing() {
    let mut shell = Shell::new();
    let reply = shell.handle(
        OP_EQUIP_ADD,
        &frame(
            1_700_000_000_000,
            7,
            &[
                (DeviceField::Hostname.key().0, "srx-hq-01"),
                (DeviceField::Platform.key().0, "junos-srx"),
                (DeviceField::Role.key().0, "frewall"),
            ],
        ),
    );
    assert_eq!(
        is_error(&reply),
        Some(ERR_FIELD_VALUE),
        "a misspelt role must be ERR_FIELD_VALUE"
    );
    assert_eq!(
        rows_for(&mut shell, DEVICE_KIND_BYTE),
        0,
        "a refused add must leave no partial device behind"
    );
}

/// Both identity tuples need `platform`, and the schema declares it required.
/// A device without one can never be reconciled with a later paste of the same
/// box, so it is refused at the door.
#[test]
fn a_device_without_a_platform_is_refused() {
    let mut shell = Shell::new();
    let reply = shell.handle(
        OP_EQUIP_ADD,
        &frame(
            1_700_000_000_000,
            7,
            &[(DeviceField::Hostname.key().0, "srx-hq-01")],
        ),
    );
    assert_eq!(is_error(&reply), Some(ERR_EQUIP_FRAME));
    assert_eq!(rows_for(&mut shell, DEVICE_KIND_BYTE), 0);
}

/// A truncated frame is refused rather than read past its end.
#[test]
fn a_short_frame_is_refused() {
    let mut shell = Shell::new();
    for len in [0usize, 1, 23, 24] {
        let reply = shell.handle(OP_EQUIP_ADD, &vec![0u8; len]);
        assert_eq!(
            is_error(&reply),
            Some(ERR_EQUIP_FRAME),
            "a {len}-byte frame must be refused"
        );
    }
}

/// A field list whose declared length overruns the buffer is refused, not read
/// out of bounds.
#[test]
fn a_lying_length_is_refused() {
    let mut shell = Shell::new();
    let mut f = frame(1_700_000_000_000, 7, &[]);
    f.pop(); // drop the count
    f.push(1); // claim one field
    f.extend_from_slice(&(DeviceField::Hostname.key().0 as u16).to_le_bytes());
    f.extend_from_slice(&999u16.to_le_bytes()); // claim 999 bytes
    f.extend_from_slice(b"short");
    assert_eq!(
        is_error(&shell.handle(OP_EQUIP_ADD, &f)),
        Some(ERR_EQUIP_FRAME)
    );
}

/// Determinism (invariant 9): the same frame twice must build the same bytes.
/// The module has no clock and no RNG, so nothing may vary between two runs
/// given one clock value and one entropy value.
#[test]
fn the_same_frame_builds_the_same_estate_twice() {
    let build = || {
        let mut shell = Shell::new();
        let reply = shell.handle(
            OP_EQUIP_ADD,
            &frame(
                1_700_000_000_000,
                0xabcd_ef01_2345_6789_abcd_ef01_2345_6789,
                &[
                    (DeviceField::Hostname.key().0, "srx-hq-01"),
                    (DeviceField::Platform.key().0, "junos-srx"),
                    (ChassisField::Model.key().0, "SRX345"),
                ],
            ),
        );
        (reply, shell.handle(OP_INV_ROWS, &[DEVICE_KIND_BYTE]))
    };
    assert_eq!(build(), build(), "two identical frames diverged");
}

// --- correcting and removing -------------------------------------------------

use fathom_wasm::{OP_ELEMENT_REMOVE, OP_FIELD_SET};

/// `[u64 at][u128 entropy][u32 key][u16 id_len][id][value]`
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

fn remove_frame(at_ms: u64, entropy: u128, id: &str) -> Vec<u8> {
    let mut v = Vec::new();
    v.extend_from_slice(&at_ms.to_le_bytes());
    v.extend_from_slice(&entropy.to_le_bytes());
    v.extend_from_slice(id.as_bytes());
    v
}

/// The display id of the one device in the estate.
fn only_device_id(shell: &mut Shell) -> String {
    let reply = shell.handle(OP_INV_ROWS, &[DEVICE_KIND_BYTE]);
    match decode_reply(&reply) {
        Ok(ReplyView::FaceRows(rows)) => rows
            .iter()
            .find(|r| r.role == FACE_INV)
            .map(|r| r.strings[0].clone())
            .expect("one device row"),
        other => panic!("expected a face table, got {other:?}"),
    }
}

fn add_one(shell: &mut Shell, at: u64, name: &str) {
    let reply = shell.handle(
        OP_EQUIP_ADD,
        &frame(
            at,
            0x2026_0811_0000_0000_0000_0000_0000_0001,
            &[
                (DeviceField::Hostname.key().0, name),
                (DeviceField::Platform.key().0, "junos-srx"),
            ],
        ),
    );
    assert_eq!(is_error(&reply), None, "setup add refused: {reply:?}");
}

/// A hostname that parsed but was wrong must be correctable. Before
/// `OP_FIELD_SET` nothing in the product could change a stored value at all.
#[test]
fn a_stored_field_can_be_corrected() {
    let mut shell = Shell::new();
    add_one(&mut shell, 1_700_000_000_000, "srx-typo-01");
    let id = only_device_id(&mut shell);

    let reply = shell.handle(
        OP_FIELD_SET,
        &edit_frame(
            1_700_000_000_001,
            9,
            DeviceField::Hostname.key().0,
            &id,
            "srx-hq-01",
        ),
    );
    assert_eq!(
        is_error(&reply),
        None,
        "the correction was refused: {reply:?}"
    );
    assert_eq!(
        rows_for(&mut shell, DEVICE_KIND_BYTE),
        1,
        "correcting a field must not add or remove a device"
    );
}

/// Two corrections inside one millisecond is ordinary -- one keystroke apart.
/// Deriving the batch and provenance ids from the clock alone made the second
/// collide with the first and be refused as reused, which is why they come off
/// the mint instead.
#[test]
fn two_corrections_in_the_same_millisecond_both_land() {
    let mut shell = Shell::new();
    add_one(&mut shell, 1_700_000_000_000, "srx-a");
    let id = only_device_id(&mut shell);

    for (n, value) in [(1u128, "srx-first"), (2, "srx-second")] {
        let reply = shell.handle(
            OP_FIELD_SET,
            &edit_frame(
                1_700_000_000_777,
                n,
                DeviceField::Hostname.key().0,
                &id,
                value,
            ),
        );
        assert_eq!(
            is_error(&reply),
            None,
            "correction {n} in the same millisecond was refused: {reply:?}"
        );
    }
}

/// A correction that does not parse changes nothing.
#[test]
fn a_bad_correction_leaves_the_old_value() {
    let mut shell = Shell::new();
    add_one(&mut shell, 1_700_000_000_000, "srx-hq-01");
    let id = only_device_id(&mut shell);

    let reply = shell.handle(
        OP_FIELD_SET,
        &edit_frame(
            1_700_000_000_001,
            9,
            DeviceField::Role.key().0,
            &id,
            "frewall",
        ),
    );
    assert_eq!(is_error(&reply), Some(ERR_FIELD_VALUE));
    assert_eq!(rows_for(&mut shell, DEVICE_KIND_BYTE), 1);
}

/// A display id nobody has is refused rather than silently doing nothing.
#[test]
fn correcting_an_unknown_element_is_refused() {
    let mut shell = Shell::new();
    add_one(&mut shell, 1_700_000_000_000, "srx-hq-01");
    let reply = shell.handle(
        OP_FIELD_SET,
        &edit_frame(
            1_700_000_000_001,
            9,
            DeviceField::Hostname.key().0,
            "device:0000000000000000000000",
            "srx-hq-02",
        ),
    );
    assert!(is_error(&reply).is_some(), "an unknown id must be refused");
}

/// Removing a device removes it from the inventory. `Graph::tombstone` cascades
/// to the subtree, so the chassis goes with it -- a chassis with no device is
/// not a fact anyone asserted.
#[test]
fn a_device_can_be_removed_and_its_chassis_goes_with_it() {
    let mut shell = Shell::new();
    add_one(&mut shell, 1_700_000_000_000, "srx-hq-01");
    add_one(&mut shell, 1_700_000_000_001, "mx-core-02");
    assert_eq!(rows_for(&mut shell, DEVICE_KIND_BYTE), 2);

    let reply = shell.handle(OP_INV_ROWS, &[DEVICE_KIND_BYTE]);
    let id = match decode_reply(&reply) {
        Ok(ReplyView::FaceRows(rows)) => rows
            .iter()
            .find(|r| r.role == FACE_INV)
            .map(|r| r.strings[0].clone())
            .expect("a device row"),
        other => panic!("{other:?}"),
    };

    let gone = shell.handle(OP_ELEMENT_REMOVE, &remove_frame(1_700_000_000_002, 5, &id));
    assert_eq!(is_error(&gone), None, "the removal was refused: {gone:?}");
    assert_eq!(
        rows_for(&mut shell, DEVICE_KIND_BYTE),
        1,
        "the removed device must leave the inventory and the other must stay"
    );
    // CHASSIS_KIND_BYTE is InvKind::ALL's last index; one device remains, so one
    // chassis must remain.
    let chassis = fathom_inventory::InvKind::ALL.len() as u8 - 1;
    assert_eq!(
        rows_for(&mut shell, chassis),
        1,
        "the removed device's chassis must go with it"
    );
}

/// Removing the same element twice is refused rather than silently accepted --
/// the second call is asking for something that is already true, and answering
/// "done" to it would hide a page defect.
#[test]
fn removing_twice_is_refused() {
    let mut shell = Shell::new();
    add_one(&mut shell, 1_700_000_000_000, "srx-hq-01");
    let id = only_device_id(&mut shell);
    assert_eq!(
        is_error(&shell.handle(OP_ELEMENT_REMOVE, &remove_frame(1_700_000_000_001, 5, &id))),
        None
    );
    assert!(
        is_error(&shell.handle(OP_ELEMENT_REMOVE, &remove_frame(1_700_000_000_002, 6, &id)))
            .is_some(),
        "a second removal must be refused"
    );
}
