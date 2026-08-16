//! `OP_RACK_PLACE` / `OP_RACK_ELEVATION` — ADR-0036's physical placement,
//! driven through the shell the way the page drives it.
//!
//! The properties these hold, in order of what losing one would cost:
//!
//! 1. **The numbering direction is never guessed.** A rack drawn upside down
//!    is wrong in every position while looking entirely plausible, and no
//!    source establishes a universal convention (ADR-0036 §3). So the field is
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
    /// THREE states on the wire, and the third is the point: `Some(true)` U1 at
    /// the floor, `Some(false)` U1 at the top, `None` this build cannot read
    /// the stored token and will not guess a direction from it.
    ascending: Option<bool>,
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
        ascending: match head.strings[4].as_str() {
            "1" => Some(true),
            "0" => Some(false),
            _ => None,
        },
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
    assert_eq!(e.ascending, Some(true));
    assert_eq!(
        e.slots,
        vec![(5u8, "2".to_owned(), "front".to_owned(), false)]
    );
    assert_eq!(e.clashes, 0);
}

/// The property ADR-0036's whole numbering field exists for. Both directions
/// are stored and BOTH produce a different drawn position for the same U, so a
/// build that quietly defaulted one of them would fail here rather than ship a
/// picture that is upside down and plausible.
///
/// **WHAT THIS TEST DOES NOT DO, said here because believing otherwise is how
/// the first version of this view shipped a defect.** `top_row` below is a
/// RE-IMPLEMENTATION of the page's arithmetic, not the page's arithmetic. It
/// can prove that the two directions differ and that the module carries the
/// token; it cannot see `renderRack`'s lane packing, its frame declaration, or
/// its DOM at all. A renderer bug that drew every box in the wrong column, or
/// dropped one entirely, passes this test — and one did, at 100%, until a
/// browser driver looked at the accessible tree.
/// `docs/80-review/evidence/2026-08-15-rack-view-ax.mjs` is where the picture
/// is actually checked. This is a check on the WIRE.
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

    assert_eq!(up.ascending, Some(true));
    assert_eq!(down.ascending, Some(false));
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
    assert_eq!(
        e.ascending,
        Some(true),
        "and the direction it was created with"
    );
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

/// `schema/schema.yaml` declares `range: { min: 1, max: 100 }` on the three
/// unit-count fields and **nothing carries it into the generated types** —
/// `fathom-schemagen` drops `range:` on the floor, which a review demonstrated
/// by storing a 0U rack (drawn with zero rows, its only box reported as outside
/// the frame) and a 200U one (two hundred DOM rows).
///
/// `shell.rs` therefore checks the bound at the door, from two hand-written
/// constants, and this is what stops those constants becoming a second opinion:
/// it reads the DECLARED range out of the YAML and fails if the door and the
/// schema disagree. ADR-0008 still decides — the schema is the source — and the
/// drift is now a red test rather than a bound that silently means nothing.
///
/// A text scan and not a parse, deliberately: `fathom-schema`'s tree does not
/// model `constraints:` at all, so there is nothing to ask. The scan is exact
/// about what it looks for and fails loudly if the declaration is reworded,
/// which is the correct behaviour — a reworded declaration needs a human.
#[test]
fn the_declared_range_is_the_range_the_door_enforces() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(|p| p.parent())
        .expect("the workspace root is two levels up from the crate")
        .join("schema/schema.yaml");
    let text = std::fs::read_to_string(&root).expect("schema/schema.yaml is checked in");

    // Every `range:` line in the file, so a fourth field declaring a different
    // bound cannot slip past by not being in a list here.
    let ranges: Vec<&str> = text
        .lines()
        .map(str::trim)
        .filter(|l| l.starts_with("range:"))
        .collect();
    assert_eq!(
        ranges.len(),
        3,
        "the schema declares {} range constraints; this test knows about the three \
         unit-count fields. A new one needs a decision about who enforces it, not a \
         bigger number here.",
        ranges.len()
    );
    for line in ranges {
        assert_eq!(
            line, "range: { min: 1, max: 100, platforms: [] }",
            "the declared range moved; shell.rs's RACK_U_MIN/RACK_U_MAX still say 1..=100"
        );
    }
}

/// The door refuses a rack with no units. A 0U frame holds nothing by
/// definition, so every box in it is reported as outside the frame — a picture
/// that is technically honest and completely useless, produced from a typo.
#[test]
fn a_rack_of_zero_units_is_refused() {
    let mut shell = Shell::new();
    let c = a_box(&mut shell, 1_700_000_000_000, "srx-a", "0");
    let mut f = rack_fields("R1", "0", "ascending");
    f.push((MountedInField::PositionU.key().0, "1"));
    let reply = shell.handle(OP_RACK_PLACE, &place_frame(1_700_000_000_100, 1, &c, &f));
    assert_eq!(is_error(&reply), Some(ERR_FIELD_VALUE));
    let text = error_text(&reply);
    assert!(
        text.contains("Rack.height_u is 0") && text.contains("1..=100"),
        "the refusal must name the field, the value and the declared range: {text}"
    );
    // And it refused BEFORE the store: no rack exists.
    let rows = shell.handle(OP_INV_ROWS, &[kind_byte("Rack")]);
    let Ok(ReplyView::FaceRows(rows)) = decode_reply(&rows) else {
        panic!("the inventory must answer with a face table")
    };
    assert_eq!(
        rows.iter()
            .filter(|r| r.role == fathom_wasm::protocol::FACE_INV)
            .count(),
        0,
        "a refused placement must leave no rack behind"
    );
}

/// The other end of the same bound. 200U was accepted before this check and
/// drew two hundred DOM rows.
#[test]
fn a_rack_taller_than_the_declared_range_is_refused() {
    let mut shell = Shell::new();
    let c = a_box(&mut shell, 1_700_000_000_000, "srx-a", "0");
    let mut f = rack_fields("R1", "200", "ascending");
    f.push((MountedInField::PositionU.key().0, "1"));
    let reply = shell.handle(OP_RACK_PLACE, &place_frame(1_700_000_000_100, 1, &c, &f));
    assert_eq!(is_error(&reply), Some(ERR_FIELD_VALUE));
    assert!(error_text(&reply).contains("Rack.height_u is 200"));
}

/// `position_u` is on the same bound, and U0 is not a unit in any rack: the
/// lowest-numbered unit of a 19-inch frame is U1 under both directions.
#[test]
fn a_position_of_zero_is_refused() {
    let mut shell = Shell::new();
    let c = a_box(&mut shell, 1_700_000_000_000, "srx-a", "0");
    let mut f = rack_fields("R1", "42", "ascending");
    f.push((MountedInField::PositionU.key().0, "0"));
    let reply = shell.handle(OP_RACK_PLACE, &place_frame(1_700_000_000_100, 1, &c, &f));
    assert_eq!(is_error(&reply), Some(ERR_FIELD_VALUE));
    assert!(error_text(&reply).contains("MountedIn.position_u is 0"));
}

/// A box height of zero. `drawn()` clamps it to 1 for the picture, which is
/// right for drawing and wrong for storing: a 0U box is not a thing, and
/// storing one means the picture and the record disagree forever after.
#[test]
fn a_box_height_of_zero_is_refused() {
    let mut shell = Shell::new();
    let c = a_box(&mut shell, 1_700_000_000_000, "srx-a", "0");
    let mut f = rack_fields("R1", "42", "ascending");
    f.push((MountedInField::PositionU.key().0, "5"));
    f.push((MountedInField::HeightU.key().0, "0"));
    let reply = shell.handle(OP_RACK_PLACE, &place_frame(1_700_000_000_100, 1, &c, &f));
    assert_eq!(is_error(&reply), Some(ERR_FIELD_VALUE));
    assert!(error_text(&reply).contains("MountedIn.height_u is 0"));
}

/// The direction slot on the wire has THREE states, and the third is the one
/// that matters: an unreadable token must not be indistinguishable from a rack
/// numbered from the top.
///
/// It had two. Empty meant "descending", so the page could not tell "U1 is at
/// the top" from "this build does not understand the stored token" and drew
/// both — one of them upside down. `crates/fathom-inventory/tests/rack_numbering.rs`
/// proves the model returns no direction; this proves the wire carries that
/// distinction to the page, which is where the picture is decided.
///
/// The unreadable rack is built through the store rather than through the door,
/// because no door produces one — that is the state's whole nature, and its
/// reachability is a future schema's, not today's input's.
#[test]
fn the_direction_slot_tells_no_direction_apart_from_descending() {
    use fathom_graph::{
        Actor, BatchId, Confidence, ElementId, Graph, Origin, ProvenanceId, ProvenanceRecord,
        Timestamp, UserId,
    };
    use fathom_id::Ulid;
    use fathom_ir::generated::ir_types::{NodeKind, RackUnitNumbering, FIELD_KEYS};
    use fathom_wasm::protocol::{encode_rack_reply, FACE_RACK};

    const TS0: u64 = 1_785_456_000_000;
    let ulid = |k: u128| Ulid::from_parts(TS0, k).expect("TS0 fits 48 bits");
    let prov = || ProvenanceRecord {
        id: ProvenanceId(ulid(1)),
        origin: Origin::Hand,
        asserted_at: Timestamp(TS0),
        asserted_by: Actor::User(UserId(ulid(0))),
        confidence: Confidence::Asserted,
        supersedes: None,
    };
    let key = |n: &str| {
        let (_, k) = FIELD_KEYS
            .iter()
            .find(|(name, _)| *name == n)
            .unwrap_or_else(|| panic!("`{n}` is not a declared field"));
        fathom_ir::bag::FieldKey(*k)
    };

    let direction = |numbering: RackUnitNumbering| {
        let mut g = Graph::new();
        g.begin_batch(BatchId(ulid(2)), "a rack for one test")
            .expect("a fresh graph takes a batch");
        let r = g
            .insert_node(NodeKind::Rack, ulid(3), prov())
            .expect("Rack is a declared kind");
        g.set_field(
            ElementId::Node(r),
            key("Rack.label"),
            fathom_ir::scalar::Text("R1".to_owned()),
            prov(),
        )
        .expect("label is Text");
        g.set_field(ElementId::Node(r), key("Rack.height_u"), 10u8, prov())
            .expect("height_u is u8");
        g.set_field(
            ElementId::Node(r),
            key("Rack.unit_numbering"),
            numbering,
            prov(),
        )
        .expect("unit_numbering takes its own enum");
        g.end_batch().expect("the batch closes");

        let e = fathom_inventory::elevation(&g, r).expect("a rack has an elevation");
        let bytes = encode_rack_reply(Some(&e));
        let Ok(ReplyView::FaceRows(rows)) = decode_reply(&bytes) else {
            panic!("the elevation encodes as a face table")
        };
        rows.iter()
            .find(|r| r.role == FACE_RACK)
            .expect("a frame record")
            .strings[4]
            .clone()
    };

    assert_eq!(direction(RackUnitNumbering::Ascending), "1");
    assert_eq!(direction(RackUnitNumbering::Descending), "0");
    assert_eq!(
        direction(RackUnitNumbering::Unknown("from-the-hinge-side".to_owned())),
        "",
        "three states; the page branches on this one to draw no frame at all"
    );
}
