//! `OP_CABLE` — a cable is drawn by hand, and its ports are minted by the
//! gesture (ADR-0038).
//!
//! Modelled on `tests/link.rs` and `tests/equip.rs`: frame builders that
//! mirror the page's own encoder, reply decoders, then the behavioural
//! properties in order of what they would cost if they broke.
//!
//! The five properties these exist to hold:
//!
//! 1. **`OP_CABLE` is dispatched at all.** `Shell::handle`'s match has a
//!    catch-all `_ => ERR_UNKNOWN_OP`, so a forgotten arm compiles clean and
//!    only fails at runtime — nothing else catches that.
//! 2. **A cable is never a `PassThrough`.** The only reference edge the
//!    schema admits directly between two `PhysicalPort`s is `PassThrough` —
//!    "these two holes are the same hole" — and routing this gesture
//!    through `OP_LINK`'s one-candidate rule would silently write that
//!    instead of a cable (ADR-0038 D2).
//! 3. **Ports and chassis are minted only when missing**, silently, by the
//!    gesture (D1, D5) — a hand-added box already has a `Chassis` and no
//!    ports; a pasted box has neither.
//! 4. **A cut is a tombstone of the cable AND both `Terminates` edges**
//!    (D8), and a removed cable stops reporting as cabled on either end.
//! 5. **A refusal writes nothing**, including leaving no batch open.

use fathom_ir::generated::ir_types::DeviceField;
use fathom_wasm::protocol::{
    decode_reply, ReplyView, ERR_BAD_UTF8, ERR_CABLE_COUNT, ERR_CABLE_END, ERR_EQUIP_FRAME,
    ERR_NO_CABLE, ERR_UNKNOWN_OP, FACE_INV, FACE_PORT,
};
use fathom_wasm::shell::Shell;
use fathom_wasm::{
    OP_CABLE, OP_ELEMENT_REMOVE, OP_EQUIPMENT, OP_EQUIP_ADD, OP_INV_ROWS, OP_LINK, OP_PASTE,
};

/// The dictionary is handed in over `OP_DICT`, so pasting tests boot through
/// `common::booted_shell()`. See `tests/paste.rs`.
mod common;

// --- frames ------------------------------------------------------------------

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

/// `OP_PASTE`'s frame: the usual prefix, one confirm byte, the text. Every
/// call here sends `confirm = 0` — a first paste into an empty estate cannot
/// clash with anything.
fn paste_frame(at_ms: u64, entropy: u128, text: &str) -> Vec<u8> {
    let mut v = Vec::with_capacity(25 + text.len());
    v.extend_from_slice(&at_ms.to_le_bytes());
    v.extend_from_slice(&entropy.to_le_bytes());
    v.push(0);
    v.extend_from_slice(text.as_bytes());
    v
}

/// One end spec, ADR-0038 §4: `tag(u8)` then the tag's own bytes.
enum End<'a> {
    /// Tag 0: an existing port, by display id.
    Port(&'a str),
    /// Tag 1: mint a port on this box (a `Device` or a `Chassis`), with this
    /// label (empty = unlabelled).
    Mint(&'a str, &'a str),
    /// Tag 2: unknown far end. Legal only on the far end.
    Unknown,
    /// Tag 3: reserved (`ExternalPeer`), refused in this cut.
    Reserved,
}

fn push_end(v: &mut Vec<u8>, end: &End<'_>) {
    match end {
        End::Port(id) => {
            v.push(0);
            v.push(id.len() as u8);
            v.extend_from_slice(id.as_bytes());
        }
        End::Mint(boxid, label) => {
            v.push(1);
            v.push(boxid.len() as u8);
            v.extend_from_slice(boxid.as_bytes());
            v.push(label.len() as u8);
            v.extend_from_slice(label.as_bytes());
        }
        End::Unknown => v.push(2),
        End::Reserved => v.push(3),
    }
}

/// `OP_CABLE` mode 1 (draw). Written out here rather than shared with the
/// shell, so a change to one has to be made twice and noticed once.
fn draw_frame(at_ms: u64, entropy: u128, near: &End<'_>, far: &End<'_>, label: &str) -> Vec<u8> {
    let mut v = Vec::new();
    v.extend_from_slice(&at_ms.to_le_bytes());
    v.extend_from_slice(&entropy.to_le_bytes());
    v.push(1); // mode: draw
    v.push(1); // count: exactly one record (D7)
    push_end(&mut v, near);
    push_end(&mut v, far);
    v.push(label.len() as u8);
    v.extend_from_slice(label.as_bytes());
    v
}

/// `OP_CABLE` mode 0 (cut).
fn cut_frame(at_ms: u64, entropy: u128, cable_id: &str) -> Vec<u8> {
    let mut v = Vec::new();
    v.extend_from_slice(&at_ms.to_le_bytes());
    v.extend_from_slice(&entropy.to_le_bytes());
    v.push(0); // mode: cut
    v.push(1); // count
    v.push(cable_id.len() as u8);
    v.extend_from_slice(cable_id.as_bytes());
    v
}

/// `OP_LINK`'s frame — used only to prove property 2 (no `PassThrough`).
fn link_frame(at_ms: u64, entropy: u128, mode: u8, a: &str, b: &str, kind: &str) -> Vec<u8> {
    let mut v = Vec::new();
    v.extend_from_slice(&at_ms.to_le_bytes());
    v.extend_from_slice(&entropy.to_le_bytes());
    v.push(mode);
    v.extend_from_slice(&(a.len() as u16).to_le_bytes());
    v.extend_from_slice(&(b.len() as u16).to_le_bytes());
    v.extend_from_slice(a.as_bytes());
    v.extend_from_slice(b.as_bytes());
    v.extend_from_slice(kind.as_bytes());
    v
}

// --- reading replies -----------------------------------------------------

fn error_code(reply: &[u8]) -> Option<u16> {
    match decode_reply(reply) {
        Ok(ReplyView::Error(e)) => Some(e.code),
        _ => None,
    }
}

/// One slot of the summary row `cable_reply` writes: `[0]` the word, `[1]`
/// the cable id, `[2..=5]` the minted ids (empty where nothing was minted).
fn reply_slot(reply: &[u8], i: usize) -> String {
    match decode_reply(reply) {
        Ok(ReplyView::FaceRows(rows)) => rows
            .first()
            .map(|r| r.strings[i].clone())
            .unwrap_or_default(),
        other => panic!("expected a face reply, got {other:?}"),
    }
}

fn reply_word(reply: &[u8]) -> String {
    reply_slot(reply, 0)
}

// --- a two-device lab, built by hand ---------------------------------------

fn two_devices() -> (Shell, String, String) {
    let mut shell = Shell::new();
    for (i, name) in ["switch-lab-01", "fw-lab-01"].iter().enumerate() {
        let reply = shell.handle(
            OP_EQUIP_ADD,
            &equip_frame(
                1_700_000_000_000 + i as u64,
                0x1111_2222_3333_4444_5555_6666_7777_8888 + i as u128,
                &[
                    (DeviceField::Hostname.key().0, name),
                    (DeviceField::Platform.key().0, "junos-srx"),
                ],
            ),
        );
        assert_eq!(error_code(&reply), None, "add {i} refused: {reply:?}");
    }
    let ids = inv_ids(&mut shell, "Device");
    assert_eq!(ids.len(), 2, "two adds should be two devices");
    (shell, ids[0].clone(), ids[1].clone())
}

/// Every row's display id for one `InvKind`, by its label — asked by name
/// rather than by a position that moves when a kind is appended (`Cable`
/// itself is the newest such append, ADR-0038 D14).
fn inv_ids(shell: &mut Shell, label: &str) -> Vec<String> {
    let byte = fathom_inventory::InvKind::ALL
        .iter()
        .position(|k| k.label() == label)
        .unwrap_or_else(|| panic!("{label} is an InvKind")) as u8;
    match decode_reply(&shell.handle(OP_INV_ROWS, &[byte])) {
        Ok(ReplyView::FaceRows(rows)) => rows
            .iter()
            .filter(|r| r.role == FACE_INV)
            .map(|r| r.strings[0].clone())
            .collect(),
        other => panic!("the inventory must answer with a face table, got {other:?}"),
    }
}

/// One device's port rows, through `OP_EQUIPMENT` — the same surface the
/// operator's equipment page reads, so a fact `cabled_peer` computes but the
/// wire never carries does not count as read back.
struct PortRow {
    cabled_text: String,
    far_device: String,
}

fn port_rows(shell: &mut Shell, device: &str) -> Vec<PortRow> {
    match decode_reply(&shell.handle(OP_EQUIPMENT, device.as_bytes())) {
        Ok(ReplyView::FaceRows(rows)) => rows
            .iter()
            .filter(|r| r.role == FACE_PORT)
            .map(|r| PortRow {
                cabled_text: r.strings[5].clone(),
                far_device: r.strings[6].clone(),
            })
            .collect(),
        other => panic!("OP_EQUIPMENT must answer with a face table, got {other:?}"),
    }
}

// --- the tests ---------------------------------------------------------------

/// **Property 1.** Nothing else in this suite would catch a forgotten
/// dispatch arm: `Shell::handle`'s catch-all compiles clean and only fails
/// at runtime.
#[test]
fn op_cable_is_dispatched_not_unknown() {
    let mut shell = Shell::new();
    let reply = shell.handle(OP_CABLE, &[0u8; 4]);
    assert_ne!(
        error_code(&reply),
        Some(ERR_UNKNOWN_OP),
        "OP_CABLE is not wired into Shell::handle"
    );
}

/// **The owner's sentence, end to end, and D1/D5 together.** Two devices
/// added by hand from an empty page — each with a `Chassis` and ZERO ports —
/// connected by pointing at both boxes. The gesture mints a port on each
/// silently, and the far end reads back correctly through the same walk
/// `equipment_page`/`cabled_peer` gives an operator.
#[test]
fn two_hand_added_devices_with_no_ports_can_be_cabled_and_read_back() {
    let (mut shell, a, b) = two_devices();
    assert!(
        port_rows(&mut shell, &a).is_empty(),
        "a hand-added device starts with no ports, or this test proves nothing"
    );

    let reply = shell.handle(
        OP_CABLE,
        &draw_frame(
            1_700_000_001_000,
            0x9999_8888_7777_6666,
            &End::Mint(&a, "ge-0/0/0"),
            &End::Mint(&b, "ge-0/0/1"),
            "",
        ),
    );
    assert_eq!(error_code(&reply), None, "the draw was refused: {reply:?}");
    assert_eq!(
        reply_word(&reply),
        "1",
        "a fresh cable is a draw, not a no-op"
    );
    // A cable id, and both ports, were minted — the chassis slots stay
    // empty, because `OP_EQUIP_ADD` already gave each device one.
    assert!(
        !reply_slot(&reply, 1).is_empty(),
        "no cable id in the reply"
    );
    assert!(!reply_slot(&reply, 2).is_empty(), "no near port minted");
    assert!(!reply_slot(&reply, 3).is_empty(), "no far port minted");
    assert!(
        reply_slot(&reply, 4).is_empty() && reply_slot(&reply, 5).is_empty(),
        "a chassis was minted where both devices already had one: {reply:?}"
    );

    let a_ports = port_rows(&mut shell, &a);
    assert_eq!(
        a_ports.len(),
        1,
        "the gesture must mint exactly one port on A"
    );
    assert_ne!(a_ports[0].cabled_text, "—", "A's port must read as cabled");
    assert!(
        a_ports[0].cabled_text.contains("fw-lab-01"),
        "A's port must name B's hostname: {}",
        a_ports[0].cabled_text
    );
    assert!(!a_ports[0].far_device.is_empty());

    let b_ports = port_rows(&mut shell, &b);
    assert_eq!(
        b_ports.len(),
        1,
        "the gesture must mint exactly one port on B"
    );
    assert!(
        b_ports[0].cabled_text.contains("switch-lab-01"),
        "B's port must name A's hostname: {}",
        b_ports[0].cabled_text
    );
}

/// **The ADR's headline guard (D2).** The only reference edge the schema
/// admits directly between two `PhysicalPort`s is `PassThrough`. If
/// `OP_CABLE` ever routed through `hand_link_candidates`, it would write
/// that instead of a cable — silently, because it is the sole candidate.
///
/// Proved through the wire: after `OP_CABLE` draws between two existing
/// ports, `OP_LINK` is asked to draw between the SAME two ports. If a
/// `PassThrough` already existed, `OP_LINK` would answer "already there"
/// (`2`); it must instead answer "drew" (`1`), proving none did.
#[test]
fn a_cable_between_two_ports_never_produces_a_passthrough() {
    let (mut shell, a, b) = two_devices();
    let draw = shell.handle(
        OP_CABLE,
        &draw_frame(
            1_700_000_001_000,
            0x9999_8888_7777_6666,
            &End::Mint(&a, "ge-0/0/0"),
            &End::Mint(&b, "ge-0/0/1"),
            "",
        ),
    );
    assert_eq!(error_code(&draw), None, "the draw was refused: {draw:?}");
    let port_a = reply_slot(&draw, 2);
    let port_b = reply_slot(&draw, 3);

    let probe = shell.handle(
        OP_LINK,
        &link_frame(1_700_000_002_000, 0x1234_5678, 1, &port_a, &port_b, ""),
    );
    assert_eq!(
        error_code(&probe),
        None,
        "the PassThrough probe was refused: {probe:?}"
    );
    match decode_reply(&probe) {
        Ok(ReplyView::FaceRows(rows)) => {
            let word = rows
                .first()
                .map(|r| r.strings[1].clone())
                .unwrap_or_default();
            assert_eq!(
                word, "1",
                "a PassThrough already existed between the two ports OP_CABLE just \
                 joined, which means OP_CABLE wrote one"
            );
        }
        other => panic!("expected a face reply, got {other:?}"),
    }
}

/// **Replay determinism (ADR-0038 §4's journal record).** The journal stores
/// the RAW request — tag, id text, label — never the ids a draw minted, so a
/// replay re-sends the same frame and must re-mint the same ids through the
/// same `(clock, entropy)` header. Proved here without a browser: two
/// independently built shells, given byte-identical inputs at every step
/// (the same fixed `at`/`entropy` `two_devices()` always uses, then the same
/// draw frame), must mint identical cable, port and chassis ids — the
/// property `docs/80-review/evidence/2026-08-29-cabling-drive.mjs`'s
/// unlabelled-port replay case will exercise through the page's own import
/// arm, which is not this crate's to write.
#[test]
fn replaying_a_draw_with_the_same_header_mints_the_same_ids() {
    let (mut shell_1, a1, b1) = two_devices();
    let reply_1 = shell_1.handle(
        OP_CABLE,
        &draw_frame(
            1_700_000_001_000,
            0x9999_8888_7777_6666,
            &End::Mint(&a1, "ge-0/0/0"),
            &End::Mint(&b1, "ge-0/0/1"),
            "",
        ),
    );
    assert_eq!(error_code(&reply_1), None);

    let (mut shell_2, a2, b2) = two_devices();
    assert_eq!(
        a1, a2,
        "two_devices() must itself be deterministic, or this test proves nothing"
    );
    assert_eq!(b1, b2);
    let reply_2 = shell_2.handle(
        OP_CABLE,
        &draw_frame(
            1_700_000_001_000,
            0x9999_8888_7777_6666,
            &End::Mint(&a2, "ge-0/0/0"),
            &End::Mint(&b2, "ge-0/0/1"),
            "",
        ),
    );
    assert_eq!(error_code(&reply_2), None);

    for slot in 1..=5 {
        assert_eq!(
            reply_slot(&reply_1, slot),
            reply_slot(&reply_2, slot),
            "slot {slot} diverged between two byte-identical replays"
        );
    }
}

/// **D5, the paste half.** A pasted device has zero `Chassis` — nothing in
/// `fathom-ingest`/`fathom-weld` constructs one (confirmed by the scout: no
/// site under `corpus/dict/junos-srx/` or call in `fathom-weld` ever builds
/// one) — so the gesture must mint one silently, exactly as it does for a
/// hand-added box with no ports at all. The far end is a hand-added device,
/// which already has its `OP_EQUIP_ADD` chassis, so ONLY the near chassis
/// slot should be minted — proving the mint is conditional, not automatic.
#[test]
fn a_pasted_device_with_no_chassis_gets_one_minted() {
    let mut shell = common::booted_shell();
    let pasted = shell.handle(
        OP_PASTE,
        &paste_frame(
            1_700_000_000_000,
            0x2026,
            "set system host-name pasted-01\n",
        ),
    );
    assert_eq!(
        error_code(&pasted),
        None,
        "the paste was refused: {pasted:?}"
    );
    let device_ids = inv_ids(&mut shell, "Device");
    assert_eq!(device_ids.len(), 1, "one bound line should be one device");
    let pasted_device = device_ids[0].clone();
    assert!(
        port_rows(&mut shell, &pasted_device).is_empty(),
        "a pasted device starts with no ports, or this test proves nothing"
    );

    // OP_EQUIP_ADD does not replace the held estate (`OP_PASTE`'s own door),
    // so the hand-added device lands alongside the pasted one.
    let equip = shell.handle(
        OP_EQUIP_ADD,
        &equip_frame(
            1_700_000_001_000,
            0x1111_2222_3333_4444,
            &[
                (DeviceField::Hostname.key().0, "hand-lab-01"),
                (DeviceField::Platform.key().0, "junos-srx"),
            ],
        ),
    );
    assert_eq!(
        error_code(&equip),
        None,
        "the equip add was refused: {equip:?}"
    );
    let hand_device = inv_ids(&mut shell, "Device")
        .into_iter()
        .find(|id| *id != pasted_device)
        .expect("a second device");

    let reply = shell.handle(
        OP_CABLE,
        &draw_frame(
            1_700_000_002_000,
            0x9999_8888_7777_6666,
            &End::Mint(&pasted_device, "ge-0/0/0"),
            &End::Mint(&hand_device, "fab"),
            "",
        ),
    );
    assert_eq!(error_code(&reply), None, "the draw was refused: {reply:?}");
    assert_eq!(reply_word(&reply), "1");
    assert!(
        !reply_slot(&reply, 4).is_empty(),
        "the pasted device has no chassis and one must be minted: {reply:?}"
    );
    assert!(
        reply_slot(&reply, 5).is_empty(),
        "the hand-added device already has a chassis and none should be minted: {reply:?}"
    );

    let ports = port_rows(&mut shell, &pasted_device);
    assert_eq!(ports.len(), 1);
    assert!(ports[0].cabled_text.contains("hand-lab-01"));
}

/// **A one-ended cable (D4).** An unknown far end is legal, writes one
/// `Terminates` edge, and `cabled_peer` — read through the same wire an
/// operator's equipment page uses — says so in words rather than inventing
/// a placeholder far port.
#[test]
fn a_one_ended_cable_with_a_label_reads_as_unmodelled() {
    let (mut shell, a, _b) = two_devices();
    let reply = shell.handle(
        OP_CABLE,
        &draw_frame(
            1_700_000_001_000,
            0x9999_8888_7777_6666,
            &End::Mint(&a, "ge-0/0/0"),
            &End::Unknown,
            "to the ISP, ask the NOC",
        ),
    );
    assert_eq!(error_code(&reply), None, "the draw was refused: {reply:?}");
    assert_eq!(reply_word(&reply), "1");
    assert!(!reply_slot(&reply, 2).is_empty(), "no near port minted");
    assert!(
        reply_slot(&reply, 3).is_empty(),
        "an unknown far end must mint nothing: {reply:?}"
    );

    let ports = port_rows(&mut shell, &a);
    assert_eq!(ports.len(), 1);
    assert!(
        ports[0].cabled_text.contains("far end unmodelled"),
        "a one-ended cable must say so: {}",
        ports[0].cabled_text
    );
    assert!(
        ports[0].cabled_text.contains("to the ISP, ask the NOC"),
        "the label must round-trip into the cabled-to cell: {}",
        ports[0].cabled_text
    );
}

/// **Pressing it twice is not two facts.** The second draw between the same
/// two existing ports finds the live cable and answers "already there"
/// (`2`), writing nothing — the same end-state reasoning `OP_LINK`'s draw
/// and `OP_PLACE`'s mode 0 both use.
#[test]
fn drawing_the_same_cable_twice_answers_already_there_and_writes_nothing() {
    let (mut shell, a, b) = two_devices();
    let first = shell.handle(
        OP_CABLE,
        &draw_frame(
            1_700_000_001_000,
            0x9999_8888_7777_6666,
            &End::Mint(&a, "ge-0/0/0"),
            &End::Mint(&b, "ge-0/0/1"),
            "",
        ),
    );
    assert_eq!(error_code(&first), None);
    assert_eq!(reply_word(&first), "1");
    let cable_id = reply_slot(&first, 1);
    let port_a = reply_slot(&first, 2);
    let port_b = reply_slot(&first, 3);

    // The second draw names the two PORTS THIS CALL JUST MINTED, not the
    // boxes — an existing-port draw, which is exactly the shape the
    // "already there" check exists to catch.
    let second = shell.handle(
        OP_CABLE,
        &draw_frame(
            1_700_000_002_000,
            0x1111_2222_3333,
            &End::Port(&port_a),
            &End::Port(&port_b),
            "",
        ),
    );
    assert_eq!(
        error_code(&second),
        None,
        "the redraw was refused: {second:?}"
    );
    assert_eq!(reply_word(&second), "2", "a live cable was already there");
    assert_eq!(
        reply_slot(&second, 1),
        cable_id,
        "the already-there reply must name the EXISTING cable"
    );
    assert_eq!(
        port_rows(&mut shell, &a).len(),
        1,
        "two draws must not make two ports"
    );
}

/// **Drawing from either direction is one fact, not two.** The same two
/// existing ports, named in the opposite order, must be recognised as
/// already cabled — proving the store does not key the fact on which end
/// the operator happened to click first (ADR-0038 D6's observable
/// consequence: the wire carries no way to read `Terminates.end` back
/// directly, so this is the strongest property available through it).
#[test]
fn drawing_a_to_b_then_b_to_a_is_the_same_cable() {
    let (mut shell, a, b) = two_devices();
    let first = shell.handle(
        OP_CABLE,
        &draw_frame(
            1_700_000_001_000,
            0x9999_8888_7777_6666,
            &End::Mint(&a, "ge-0/0/0"),
            &End::Mint(&b, "ge-0/0/1"),
            "",
        ),
    );
    assert_eq!(error_code(&first), None);
    let port_a = reply_slot(&first, 2);
    let port_b = reply_slot(&first, 3);

    let reversed = shell.handle(
        OP_CABLE,
        &draw_frame(
            1_700_000_002_000,
            0x1111_2222_3333,
            &End::Port(&port_b),
            &End::Port(&port_a),
            "",
        ),
    );
    assert_eq!(
        error_code(&reversed),
        None,
        "the reversed draw was refused: {reversed:?}"
    );
    assert_eq!(
        reply_word(&reversed),
        "2",
        "B-then-A must find the SAME cable A-then-B drew, not write a second one"
    );
}

/// **The first mistake must not be permanent, and it must leave the
/// picture** (D8). Cut removes the cable, and `cabled_peer` — read the same
/// way an operator reads it — stops reporting either end as cabled.
#[test]
fn a_cut_cable_stops_reporting_as_cabled() {
    let (mut shell, a, b) = two_devices();
    let draw = shell.handle(
        OP_CABLE,
        &draw_frame(
            1_700_000_001_000,
            0x9999_8888_7777_6666,
            &End::Mint(&a, "ge-0/0/0"),
            &End::Mint(&b, "ge-0/0/1"),
            "",
        ),
    );
    assert_eq!(error_code(&draw), None);
    let cable_id = reply_slot(&draw, 1);

    let cut = shell.handle(
        OP_CABLE,
        &cut_frame(1_700_000_002_000, 0x4444_3333_2222_1111, &cable_id),
    );
    assert_eq!(error_code(&cut), None, "the cut was refused: {cut:?}");
    assert_eq!(reply_word(&cut), "0");
    assert_eq!(reply_slot(&cut, 1), cable_id);

    for (device, other_host) in [(&a, "fw-lab-01"), (&b, "switch-lab-01")] {
        let ports = port_rows(&mut shell, device);
        assert_eq!(ports.len(), 1, "the port itself is not removed by a cut");
        assert_eq!(
            ports[0].cabled_text, "—",
            "{other_host}'s port must stop reading as cabled after the cut"
        );
        assert!(ports[0].far_device.is_empty());
    }

    // And a second cut says there is nothing there, rather than pretending.
    let again = shell.handle(
        OP_CABLE,
        &cut_frame(1_700_000_003_000, 0x5555_6666_7777_8888, &cable_id),
    );
    assert_eq!(error_code(&again), Some(ERR_NO_CABLE));
}

/// **D7: the count byte is refused unless 1.**
#[test]
fn a_count_other_than_one_is_refused() {
    let (mut shell, a, b) = two_devices();
    for count in [0u8, 2u8] {
        let mut frame = draw_frame(
            1_700_000_001_000,
            0x9999_8888_7777_6666,
            &End::Mint(&a, "ge-0/0/0"),
            &End::Mint(&b, "ge-0/0/1"),
            "",
        );
        frame[25] = count;
        let reply = shell.handle(OP_CABLE, &frame);
        assert_eq!(
            error_code(&reply),
            Some(ERR_CABLE_COUNT),
            "count {count} should be refused"
        );
    }
}

/// **Tag 3 (`ExternalPeer`) is reserved and refused, on either end.**
#[test]
fn tag_three_is_refused() {
    let (mut shell, a, b) = two_devices();
    let near_reserved = shell.handle(
        OP_CABLE,
        &draw_frame(
            1_700_000_001_000,
            0x9999_8888,
            &End::Reserved,
            &End::Mint(&b, "ge-0/0/1"),
            "",
        ),
    );
    assert_eq!(error_code(&near_reserved), Some(ERR_CABLE_END));

    let far_reserved = shell.handle(
        OP_CABLE,
        &draw_frame(
            1_700_000_001_000,
            0x9999_8888,
            &End::Mint(&a, "ge-0/0/0"),
            &End::Reserved,
            "",
        ),
    );
    assert_eq!(error_code(&far_reserved), Some(ERR_CABLE_END));
}

/// **Tag 2 (unknown) is refused on the near end** — only the far end may be
/// unknown (D4).
#[test]
fn unknown_on_the_near_end_is_refused() {
    let (mut shell, _a, b) = two_devices();
    let reply = shell.handle(
        OP_CABLE,
        &draw_frame(
            1_700_000_001_000,
            0x9999_8888,
            &End::Unknown,
            &End::Mint(&b, "ge-0/0/1"),
            "",
        ),
    );
    assert_eq!(error_code(&reply), Some(ERR_CABLE_END));
}

/// **Both ends naming the same port is refused.**
#[test]
fn both_ends_naming_the_same_port_is_refused() {
    let (mut shell, a, _b) = two_devices();
    let first = shell.handle(
        OP_CABLE,
        &draw_frame(
            1_700_000_001_000,
            0x9999_8888,
            &End::Mint(&a, "ge-0/0/0"),
            &End::Unknown,
            "",
        ),
    );
    assert_eq!(error_code(&first), None);
    let port = reply_slot(&first, 2);

    let reply = shell.handle(
        OP_CABLE,
        &draw_frame(
            1_700_000_002_000,
            0x1111_2222,
            &End::Port(&port),
            &End::Port(&port),
            "",
        ),
    );
    assert_eq!(error_code(&reply), Some(ERR_CABLE_END));
}

/// **A refusal leaves no batch open.** The failure this guards is not the
/// refusal itself — it is the NEXT write failing with `BatchOpen`, which
/// reads to the operator as the page having died.
#[test]
fn no_refusal_leaves_the_store_wedged() {
    let (mut shell, a, b) = two_devices();
    let refusals: Vec<Vec<u8>> = vec![
        vec![0u8; 4],
        {
            let mut f = draw_frame(
                1_700_000_001_000,
                0x9999_8888,
                &End::Mint(&a, "ge-0/0/0"),
                &End::Mint(&b, "ge-0/0/1"),
                "",
            );
            f[25] = 7; // a bad count
            f
        },
        draw_frame(
            1_700_000_001_000,
            0x9999_8888,
            &End::Reserved,
            &End::Mint(&b, "ge-0/0/1"),
            "",
        ),
        draw_frame(
            1_700_000_001_000,
            0x9999_8888,
            &End::Port("device:nope"),
            &End::Mint(&b, "ge-0/0/1"),
            "",
        ),
        cut_frame(1_700_000_001_000, 0x9999_8888, "cable:nope"),
    ];
    for (i, frame) in refusals.iter().enumerate() {
        let reply = shell.handle(OP_CABLE, frame);
        assert!(
            error_code(&reply).is_some(),
            "refusal {i} was accepted: {reply:?}"
        );
    }
    let reply = shell.handle(
        OP_CABLE,
        &draw_frame(
            1_700_000_009_000,
            0x1234_5678_9abc,
            &End::Mint(&a, "ge-0/0/0"),
            &End::Mint(&b, "ge-0/0/1"),
            "",
        ),
    );
    assert_eq!(
        error_code(&reply),
        None,
        "a write after five refusals was refused, so a batch was left open: {reply:?}"
    );
}

/// A short frame, and a bad-UTF-8 label, are told apart from a refused
/// choice by their codes.
#[test]
fn frame_refusals_are_distinguishable() {
    let (mut shell, a, b) = two_devices();
    assert_eq!(
        error_code(&shell.handle(OP_CABLE, &[0u8; 4])),
        Some(ERR_EQUIP_FRAME)
    );
    let mut bad_utf8 = draw_frame(
        1_700_000_001_000,
        0x9999_8888,
        &End::Mint(&a, "ge-0/0/0"),
        &End::Mint(&b, "ge-0/0/1"),
        "",
    );
    // Force the label's single declared byte to claim a length that runs off
    // the end of the frame.
    let last = bad_utf8.len() - 1;
    bad_utf8[last] = 0xff;
    assert_eq!(
        error_code(&shell.handle(OP_CABLE, &bad_utf8)),
        Some(ERR_EQUIP_FRAME)
    );
}

/// A removed box cannot be cabled: the store would take a port minted on a
/// tombstoned device — `insert_node`/`insert_edge` check that a node exists,
/// not that it is still asserted — and the picture would draw nothing.
#[test]
fn a_removed_box_cannot_be_cabled() {
    let (mut shell, a, b) = two_devices();
    let mut remove = 1_700_000_005_000u64.to_le_bytes().to_vec();
    remove.extend_from_slice(&0xaaaa_bbbb_cccc_ddddu128.to_le_bytes());
    remove.extend_from_slice(b.as_bytes());
    let reply = shell.handle(OP_ELEMENT_REMOVE, &remove);
    assert_eq!(
        error_code(&reply),
        None,
        "the remove was refused: {reply:?}"
    );

    let reply = shell.handle(
        OP_CABLE,
        &draw_frame(
            1_700_000_006_000,
            0x9999_8888_7777_6666,
            &End::Mint(&a, "ge-0/0/0"),
            &End::Mint(&b, "ge-0/0/1"),
            "",
        ),
    );
    assert_eq!(error_code(&reply), Some(ERR_CABLE_END));
}

/// A malformed request is not merely refused, it is refused with a bad-UTF-8
/// or frame code and never as a codeless success.
#[test]
fn a_display_id_that_is_not_utf8_is_refused_as_bad_utf8() {
    let mut shell = Shell::new();
    let mut v = Vec::new();
    v.extend_from_slice(&1_700_000_000_000u64.to_le_bytes());
    v.extend_from_slice(&0u128.to_le_bytes());
    v.push(0); // mode: cut
    v.push(1); // count
    v.push(2); // 2-byte "id"
    v.extend_from_slice(&[0xff, 0xfe]); // not UTF-8
    let reply = shell.handle(OP_CABLE, &v);
    assert_eq!(error_code(&reply), Some(ERR_BAD_UTF8));
}
