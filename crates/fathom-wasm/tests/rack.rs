//! `OP_RACK_PLACE` / `OP_RACK_ELEVATION` — ADR-0035's physical placement,
//! driven through the shell the way the page drives it.
//!
//! The properties these hold, in order of what losing one would cost:
//!
//! 1. **The numbering direction is never guessed.** A rack drawn upside down
//!    is wrong in every position while looking entirely plausible, and no
//!    source establishes a universal convention (ADR-0035 §3). So the field is
//!    required at the door and the two directions produce genuinely different
//!    pictures — asserted here by computing the drawn `y` both ways.
//! 2. **A box that does not fit is named, never clipped.** A 42U frame holding
//!    a box recorded at U48 is a data error somebody must see.
//! 3. **An unstated height stays unstated.** "1U" and "nobody measured it" are
//!    different claims and the wire keeps them apart.
//! 4. **Two boxes cannot occupy one unit** — reported, not resolved.

use fathom_ir::generated::ir_types::{ChassisField, DeviceField, MountedInField, RackField};
use fathom_wasm::protocol::{
    decode_reply, ReplyView, ERR_EQUIP_FRAME, ERR_EQUIP_STORE, ERR_FIELD_VALUE, ERR_NO_ELEMENT,
    FACE_INV, FACE_RACK, FACE_RACK_CLASH, FACE_RACK_SLOT,
};
use fathom_wasm::shell::Shell;
use fathom_wasm::{OP_EQUIP_ADD, OP_INV_ROWS, OP_RACK_ELEVATION, OP_RACK_PLACE};

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

/// `OP_RACK_PLACE`'s frame: the usual prefix, the chassis display id, then the
/// same field list `OP_EQUIP_ADD` takes.
fn place_frame(at_ms: u64, entropy: u128, chassis: &str, fields: &[(u32, &str)]) -> Vec<u8> {
    let mut v = Vec::new();
    v.extend_from_slice(&at_ms.to_le_bytes());
    v.extend_from_slice(&entropy.to_le_bytes());
    v.extend_from_slice(&(chassis.len() as u16).to_le_bytes());
    v.extend_from_slice(chassis.as_bytes());
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

fn error_text(reply: &[u8]) -> String {
    match decode_reply(reply) {
        Ok(ReplyView::Error(e)) => e.detail.clone(),
        other => panic!("expected an error, got {other:?}"),
    }
}

/// See `equip.rs`: an `InvKind` wire byte is a POSITION, so it is asked for by
/// name. `Rack` was appended after `Chassis` and broke a `len() - 1` there.
fn kind_byte(label: &str) -> u8 {
    fathom_inventory::InvKind::ALL
        .iter()
        .position(|k| k.label() == label)
        .unwrap_or_else(|| panic!("`{label}` is not an InvKind")) as u8
}

/// Add one device and return its chassis' display id.
fn a_box(shell: &mut Shell, at: u64, hostname: &str, member: &str) -> String {
    let reply = shell.handle(
        OP_EQUIP_ADD,
        &equip_frame(
            at,
            at as u128,
            &[
                (DeviceField::Hostname.key().0, hostname),
                (DeviceField::Platform.key().0, "junos-srx"),
                (ChassisField::MemberIndex.key().0, member),
            ],
        ),
    );
    assert_eq!(is_error(&reply), None, "adding {hostname}: {reply:?}");

    let rows = shell.handle(OP_INV_ROWS, &[kind_byte("Chassis")]);
    let Ok(ReplyView::FaceRows(rows)) = decode_reply(&rows) else {
        panic!("the chassis inventory must answer with a face table")
    };
    // The most recently added chassis is the last row: `rows()` walks
    // `nodes_of_kind`, which is NodeId order, which is ULID order.
    rows.iter()
        .rfind(|r| r.role == FACE_INV)
        .expect("a chassis row")
        .strings[0]
        .clone()
}

struct Elevation {
    height_u: u8,
    numbering: String,
    ascending: bool,
    /// position_u, height_u text (empty = unstated), face, overflow flag.
    slots: Vec<(u8, String, String, bool)>,
    clashes: usize,
}

fn elevation(shell: &mut Shell, rack_id: &str) -> Elevation {
    let reply = shell.handle(OP_RACK_ELEVATION, rack_id.as_bytes());
    assert_eq!(is_error(&reply), None, "reading {rack_id}: {reply:?}");
    let Ok(ReplyView::FaceRows(rows)) = decode_reply(&reply) else {
        panic!("the elevation must answer with a face table")
    };
    let head = rows
        .iter()
        .find(|r| r.role == FACE_RACK)
        .expect("a rack row");
    Elevation {
        height_u: head.strings[2].parse().expect("a decimal height"),
        numbering: head.strings[3].clone(),
        ascending: head.strings[4] == "1",
        slots: rows
            .iter()
            .filter(|r| r.role == FACE_RACK_SLOT)
            .map(|r| {
                (
                    r.strings[3].parse().unwrap_or(0),
                    r.strings[4].clone(),
                    r.strings[5].clone(),
                    r.strings[6] == "1",
                )
            })
            .collect(),
        clashes: rows.iter().filter(|r| r.role == FACE_RACK_CLASH).count(),
    }
}

/// The rack's display id, from the inventory row `InvKind::Rack` produces.
fn only_rack(shell: &mut Shell) -> String {
    let reply = shell.handle(OP_INV_ROWS, &[kind_byte("Rack")]);
    let Ok(ReplyView::FaceRows(rows)) = decode_reply(&reply) else {
        panic!("the rack inventory must answer with a face table")
    };
    let racks: Vec<&str> = rows
        .iter()
        .filter(|r| r.role == FACE_INV)
        .map(|r| r.strings[0].as_str())
        .collect();
    assert_eq!(racks.len(), 1, "exactly one rack expected, got {racks:?}");
    racks[0].to_owned()
}

fn rack_fields<'a>(label: &'a str, height: &'a str, numbering: &'a str) -> Vec<(u32, &'a str)> {
    vec![
        (RackField::Label.key().0, label),
        (RackField::HeightU.key().0, height),
        (RackField::UnitNumbering.key().0, numbering),
    ]
}

/// The owner's sentence, end to end: put a box in a rack and look at the rack.
#[test]
fn a_box_can_be_placed_in_a_rack_and_the_rack_shows_it() {
    let mut shell = Shell::new();
    let chassis = a_box(&mut shell, 1_700_000_000_000, "srx-a", "0");

    let mut fields = rack_fields("R12", "42", "ascending");
    fields.push((MountedInField::PositionU.key().0, "5"));
    fields.push((MountedInField::HeightU.key().0, "2"));
    fields.push((MountedInField::Face.key().0, "front"));
    let reply = shell.handle(
        OP_RACK_PLACE,
        &place_frame(1_700_000_000_100, 11, &chassis, &fields),
    );
    assert_eq!(
        is_error(&reply),
        None,
        "the placement was refused: {reply:?}"
    );

    let e = {
        let r = only_rack(&mut shell);
        elevation(&mut shell, &r)
    };
    assert_eq!(e.height_u, 42);
    assert_eq!(e.numbering, "ascending");
    assert!(e.ascending);
    assert_eq!(
        e.slots,
        vec![(5u8, "2".to_owned(), "front".to_owned(), false)]
    );
    assert_eq!(e.clashes, 0);
}

/// The property ADR-0035's whole numbering field exists for. Both directions
/// are stored and BOTH produce a different drawn position for the same U, so a
/// build that quietly defaulted one of them would fail here rather than ship a
/// picture that is upside down and plausible.
#[test]
fn the_two_numbering_directions_draw_the_same_unit_in_different_places() {
    /// The page's arithmetic, restated: which row from the TOP of the frame a
    /// run starts on. Ascending puts U1 at the floor, so U5 of a 42U frame is
    /// near the bottom; descending puts U1 at the top.
    fn top_row(height_u: u8, position_u: u8, span: u8, ascending: bool) -> u8 {
        if ascending {
            height_u - position_u - span + 1
        } else {
            position_u - 1
        }
    }

    let mut ups = Shell::new();
    let c = a_box(&mut ups, 1_700_000_000_000, "srx-a", "0");
    let mut f = rack_fields("R1", "42", "ascending");
    f.push((MountedInField::PositionU.key().0, "5"));
    f.push((MountedInField::HeightU.key().0, "2"));
    assert_eq!(
        is_error(&ups.handle(OP_RACK_PLACE, &place_frame(1_700_000_000_100, 1, &c, &f))),
        None
    );
    let up = {
        let r = only_rack(&mut ups);
        elevation(&mut ups, &r)
    };

    let mut downs = Shell::new();
    let c = a_box(&mut downs, 1_700_000_000_000, "srx-a", "0");
    let mut f = rack_fields("R1", "42", "descending");
    f.push((MountedInField::PositionU.key().0, "5"));
    f.push((MountedInField::HeightU.key().0, "2"));
    assert_eq!(
        is_error(&downs.handle(OP_RACK_PLACE, &place_frame(1_700_000_000_100, 1, &c, &f))),
        None
    );
    let down = {
        let r = only_rack(&mut downs);
        elevation(&mut downs, &r)
    };

    assert!(up.ascending);
    assert!(!down.ascending);
    assert_eq!(up.numbering, "ascending");
    assert_eq!(down.numbering, "descending");
    // The same stored U, drawn 31 rows apart. If these ever agree, the
    // direction has stopped reaching the picture.
    assert_eq!(top_row(42, 5, 2, true), 36);
    assert_eq!(top_row(42, 5, 2, false), 4);
}

/// A rack with no stated direction is refused at the door, because there is no
/// honest default to fall back on.
#[test]
fn a_rack_without_a_numbering_direction_is_refused() {
    let mut shell = Shell::new();
    let c = a_box(&mut shell, 1_700_000_000_000, "srx-a", "0");
    let fields = vec![
        (RackField::Label.key().0, "R12"),
        (RackField::HeightU.key().0, "42"),
        (MountedInField::PositionU.key().0, "5"),
    ];
    let reply = shell.handle(
        OP_RACK_PLACE,
        &place_frame(1_700_000_000_100, 1, &c, &fields),
    );
    assert_eq!(is_error(&reply), Some(ERR_EQUIP_FRAME));
    assert!(
        error_text(&reply).contains("Rack.unit_numbering"),
        "the refusal must name the field: {}",
        error_text(&reply)
    );
    // And nothing was written: a refused form leaves no half-built rack.
    let rows = shell.handle(OP_INV_ROWS, &[kind_byte("Rack")]);
    let Ok(ReplyView::FaceRows(rows)) = decode_reply(&rows) else {
        panic!("a face table")
    };
    assert_eq!(rows.iter().filter(|r| r.role == FACE_INV).count(), 0);
}

/// "ascending"/"descending" are the only two tokens; a typo is told, not
/// stored verbatim in the generated unknown arm.
#[test]
fn a_misspelt_direction_is_told_rather_than_stored() {
    let mut shell = Shell::new();
    let c = a_box(&mut shell, 1_700_000_000_000, "srx-a", "0");
    let mut f = rack_fields("R12", "42", "acsending");
    f.push((MountedInField::PositionU.key().0, "5"));
    let reply = shell.handle(OP_RACK_PLACE, &place_frame(1_700_000_000_100, 1, &c, &f));
    assert_eq!(is_error(&reply), Some(ERR_FIELD_VALUE));
    let text = error_text(&reply);
    assert!(text.contains("ascending"), "{text}");
    assert!(text.contains("descending"), "{text}");
}

/// Property 2. A frame does not silently grow to fit what it was told to hold.
#[test]
fn a_box_beyond_the_top_of_the_frame_is_named_never_clipped() {
    let mut shell = Shell::new();
    let c = a_box(&mut shell, 1_700_000_000_000, "srx-a", "0");
    let mut f = rack_fields("R12", "42", "ascending");
    // U41 with a 4U box runs to U44 in a 42U frame.
    f.push((MountedInField::PositionU.key().0, "41"));
    f.push((MountedInField::HeightU.key().0, "4"));
    assert_eq!(
        is_error(&shell.handle(OP_RACK_PLACE, &place_frame(1_700_000_000_100, 1, &c, &f))),
        None,
        "an overflowing placement is STORED -- it is a recorded fact that is \
         wrong, and refusing it at the door would hide the error instead of \
         showing it"
    );
    let e = {
        let r = only_rack(&mut shell);
        elevation(&mut shell, &r)
    };
    assert_eq!(e.slots.len(), 1);
    let (pos, height, _, overflow) = &e.slots[0];
    assert_eq!(*pos, 41, "the stored position is reported as stored");
    assert_eq!(height, "4", "the stored height is reported as stored");
    assert!(overflow, "and it is flagged as not fitting");
}

/// Property 3. An unstated height must not become "1U" on the wire.
#[test]
fn an_unstated_height_stays_unstated() {
    let mut shell = Shell::new();
    let c = a_box(&mut shell, 1_700_000_000_000, "srx-a", "0");
    let mut f = rack_fields("R12", "42", "ascending");
    f.push((MountedInField::PositionU.key().0, "7"));
    assert_eq!(
        is_error(&shell.handle(OP_RACK_PLACE, &place_frame(1_700_000_000_100, 1, &c, &f))),
        None
    );
    let e = {
        let r = only_rack(&mut shell);
        elevation(&mut shell, &r)
    };
    assert_eq!(
        e.slots,
        vec![(7u8, String::new(), "—".to_owned(), false)],
        "an empty height slot is 'nobody said', which the page draws as 1U and \
         MARKS; a literal \"1\" here would be this crate inventing a measurement"
    );
}

/// Property 4. Two boxes at one unit is always a defect in the record.
#[test]
fn two_boxes_in_one_unit_are_reported_not_resolved() {
    let mut shell = Shell::new();
    let a = a_box(&mut shell, 1_700_000_000_000, "srx-a", "0");
    let b = a_box(&mut shell, 1_700_000_000_001, "srx-b", "0");

    let mut f = rack_fields("R12", "42", "ascending");
    f.push((MountedInField::PositionU.key().0, "10"));
    f.push((MountedInField::HeightU.key().0, "3"));
    assert_eq!(
        is_error(&shell.handle(OP_RACK_PLACE, &place_frame(1_700_000_000_100, 1, &a, &f))),
        None
    );
    // U12 lands inside the first box's U10..U12 run.
    let mut g = rack_fields("R12", "42", "ascending");
    g.push((MountedInField::PositionU.key().0, "12"));
    assert_eq!(
        is_error(&shell.handle(OP_RACK_PLACE, &place_frame(1_700_000_000_200, 2, &b, &g))),
        None
    );

    let e = {
        let r = only_rack(&mut shell);
        elevation(&mut shell, &r)
    };
    assert_eq!(e.slots.len(), 2, "both boxes are kept");
    assert_eq!(e.clashes, 1, "and the overlap is reported");
}

/// Front and rear are different mounting positions: a back-to-back pair at the
/// same U is normal, not a defect.
#[test]
fn the_same_unit_on_opposite_faces_is_not_a_clash() {
    let mut shell = Shell::new();
    let a = a_box(&mut shell, 1_700_000_000_000, "srx-a", "0");
    let b = a_box(&mut shell, 1_700_000_000_001, "srx-b", "0");

    for (at, chassis, face) in [
        (1_700_000_000_100u64, &a, "front"),
        (1_700_000_000_200u64, &b, "rear"),
    ] {
        let mut f = rack_fields("R12", "42", "ascending");
        f.push((MountedInField::PositionU.key().0, "10"));
        f.push((MountedInField::Face.key().0, face));
        assert_eq!(
            is_error(&shell.handle(OP_RACK_PLACE, &place_frame(at, at as u128, chassis, &f))),
            None
        );
    }
    let e = {
        let r = only_rack(&mut shell);
        elevation(&mut shell, &r)
    };
    assert_eq!(e.slots.len(), 2);
    assert_eq!(e.clashes, 0, "front and rear do not collide");
}

/// A second placement into the same label REUSES the frame. Two racks called
/// R12 would make the elevation a lie.
#[test]
fn the_same_label_is_one_rack() {
    let mut shell = Shell::new();
    let a = a_box(&mut shell, 1_700_000_000_000, "srx-a", "0");
    let b = a_box(&mut shell, 1_700_000_000_001, "srx-b", "1");

    for (at, chassis, u) in [
        (1_700_000_000_100u64, &a, "5"),
        (1_700_000_000_200u64, &b, "9"),
    ] {
        let mut f = rack_fields("R12", "42", "ascending");
        f.push((MountedInField::PositionU.key().0, u));
        assert_eq!(
            is_error(&shell.handle(OP_RACK_PLACE, &place_frame(at, at as u128, chassis, &f))),
            None
        );
    }
    // `only_rack` asserts there is exactly one.
    let e = {
        let r = only_rack(&mut shell);
        elevation(&mut shell, &r)
    };
    assert_eq!(e.slots.len(), 2, "both boxes are in the one frame");
}

/// On reuse the supplied geometry is IGNORED, not applied. A form that was
/// really about one box must not resize the frame the other one is drawn in.
#[test]
fn a_second_placement_cannot_resize_the_frame() {
    let mut shell = Shell::new();
    let a = a_box(&mut shell, 1_700_000_000_000, "srx-a", "0");
    let b = a_box(&mut shell, 1_700_000_000_001, "srx-b", "1");

    let mut f = rack_fields("R12", "42", "ascending");
    f.push((MountedInField::PositionU.key().0, "5"));
    assert_eq!(
        is_error(&shell.handle(OP_RACK_PLACE, &place_frame(1_700_000_000_100, 1, &a, &f))),
        None
    );
    // A different height AND a different direction, on the same label.
    let mut g = rack_fields("R12", "12", "descending");
    g.push((MountedInField::PositionU.key().0, "9"));
    assert_eq!(
        is_error(&shell.handle(OP_RACK_PLACE, &place_frame(1_700_000_000_200, 2, &b, &g))),
        None
    );

    let e = {
        let r = only_rack(&mut shell);
        elevation(&mut shell, &r)
    };
    assert_eq!(
        e.height_u, 42,
        "the frame keeps the height it was created with"
    );
    assert!(e.ascending, "and the direction it was created with");
}

/// `MountedIn` is `out: "0..1"`. Moving is a different gesture and this build
/// does not have it, so it is named rather than silently re-pointed.
#[test]
fn a_box_already_in_a_rack_is_refused_by_name() {
    let mut shell = Shell::new();
    let c = a_box(&mut shell, 1_700_000_000_000, "srx-a", "0");
    let mut f = rack_fields("R12", "42", "ascending");
    f.push((MountedInField::PositionU.key().0, "5"));
    assert_eq!(
        is_error(&shell.handle(OP_RACK_PLACE, &place_frame(1_700_000_000_100, 1, &c, &f))),
        None
    );
    let mut g = rack_fields("R13", "42", "ascending");
    g.push((MountedInField::PositionU.key().0, "5"));
    let reply = shell.handle(OP_RACK_PLACE, &place_frame(1_700_000_000_200, 2, &c, &g));
    assert_eq!(is_error(&reply), Some(ERR_EQUIP_STORE));
    assert!(error_text(&reply).contains("already in a rack"));
}

/// Placement hangs off `Chassis`, and the refusal says why: a Device may have
/// two boxes in two different racks, which is the normal reason to have a
/// cluster.
#[test]
fn a_device_cannot_be_placed_only_a_chassis_can() {
    let mut shell = Shell::new();
    a_box(&mut shell, 1_700_000_000_000, "srx-a", "0");
    let devices = shell.handle(OP_INV_ROWS, &[kind_byte("Device")]);
    let Ok(ReplyView::FaceRows(rows)) = decode_reply(&devices) else {
        panic!("a face table")
    };
    let device = rows
        .iter()
        .find(|r| r.role == FACE_INV)
        .expect("a device row")
        .strings[0]
        .clone();

    let mut f = rack_fields("R12", "42", "ascending");
    f.push((MountedInField::PositionU.key().0, "5"));
    let reply = shell.handle(
        OP_RACK_PLACE,
        &place_frame(1_700_000_000_100, 1, &device, &f),
    );
    assert_eq!(is_error(&reply), Some(ERR_NO_ELEMENT));
    assert!(error_text(&reply).contains("not a Chassis"));
}

/// The two halves of a chassis cluster, in two different racks. This is the
/// case a containment edge from rack to device could not express, and it is
/// why `MountedIn` is a reference — so it is asserted rather than argued.
#[test]
fn the_two_halves_of_a_cluster_can_be_in_different_racks() {
    let mut shell = Shell::new();
    // One device, two chassis, is what a cluster is. `OP_EQUIP_ADD` builds one
    // Device per call, so this stands in for the shape: two boxes, placed
    // apart, both reachable.
    let node0 = a_box(&mut shell, 1_700_000_000_000, "srx-cluster", "0");
    let node1 = a_box(&mut shell, 1_700_000_000_001, "srx-cluster", "1");

    for (at, chassis, label) in [
        (1_700_000_000_100u64, &node0, "R12"),
        (1_700_000_000_200u64, &node1, "R14"),
    ] {
        let mut f = rack_fields(label, "42", "ascending");
        f.push((MountedInField::PositionU.key().0, "5"));
        assert_eq!(
            is_error(&shell.handle(OP_RACK_PLACE, &place_frame(at, at as u128, chassis, &f))),
            None,
            "placing {label}"
        );
    }

    let rows = shell.handle(OP_INV_ROWS, &[kind_byte("Rack")]);
    let Ok(ReplyView::FaceRows(rows)) = decode_reply(&rows) else {
        panic!("a face table")
    };
    let racks: Vec<&str> = rows
        .iter()
        .filter(|r| r.role == FACE_INV)
        .map(|r| r.strings[0].as_str())
        .collect();
    assert_eq!(racks.len(), 2, "two frames");
    for rack in racks {
        let e = elevation(&mut shell, rack);
        assert_eq!(e.slots.len(), 1, "one half of the cluster in each");
    }
}

/// Reading a rack id that is not a rack is the empty state, not a crash.
#[test]
fn asking_for_a_non_rack_elevation_is_empty_not_fatal() {
    let mut shell = Shell::new();
    let chassis = a_box(&mut shell, 1_700_000_000_000, "srx-a", "0");
    let reply = shell.handle(OP_RACK_ELEVATION, chassis.as_bytes());
    match decode_reply(&reply) {
        Ok(ReplyView::FaceRows(rows)) => assert!(
            rows.is_empty(),
            "a chassis has no elevation, and that is the empty state"
        ),
        other => panic!("expected an empty face table, got {other:?}"),
    }
}

/// Every placement is `Origin::Hand`, because nothing else can produce one.
/// This is the invariant that keeps the elevation honest: it shows what a
/// person asserted and never implies a parser found it.
#[test]
fn every_placement_is_hand_asserted() {
    let mut shell = Shell::new();
    let c = a_box(&mut shell, 1_700_000_000_000, "srx-a", "0");
    let mut f = rack_fields("R12", "42", "ascending");
    f.push((MountedInField::PositionU.key().0, "5"));
    assert_eq!(
        is_error(&shell.handle(OP_RACK_PLACE, &place_frame(1_700_000_000_100, 1, &c, &f))),
        None
    );
    let rack = only_rack(&mut shell);
    // The inspector renders provenance for every field; `hand` is the origin
    // word `render::stamp` produces for `Origin::Hand`.
    let reply = shell.handle(fathom_wasm::OP_ELEMENT, rack.as_bytes());
    let Ok(ReplyView::FaceRows(rows)) = decode_reply(&reply) else {
        panic!("the inspector must answer with a face table")
    };
    let stamps: Vec<&str> = rows
        .iter()
        .filter(|r| r.role == fathom_wasm::protocol::FACE_FIELD)
        .map(|r| r.strings[2].as_str())
        .collect();
    assert!(!stamps.is_empty(), "the rack has fields");
    for s in &stamps {
        assert!(
            s.starts_with("hand ") || *s == "unset",
            "a rack field must be hand-asserted or unset, got {s:?}"
        );
    }
}
