//! `OP_CHECKS` and `OP_CHECK_GESTURE` (ADR-0061 §5), through the wire.

#![allow(dead_code)]

use fathom_ir::generated::ir_types::DeviceField;
use fathom_wasm::checks::RULES;
use fathom_wasm::protocol::{
    decode_reply, ReplyView, ERR_NOT_INITIALISED, FACE_CHECK, FACE_CHECK_HEAD, FACE_INV, FACE_PORT,
};
use fathom_wasm::shell::Shell;
use fathom_wasm::{OP_CABLE, OP_CHECKS, OP_CHECK_GESTURE, OP_EQUIPMENT, OP_EQUIP_ADD, OP_INV_ROWS};

mod common;

// --- frames (as tests/cable.rs; the page's encoder, written out) ---

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

// --- the tests ---

type Rows = Vec<Vec<String>>;

fn rows(reply: &[u8]) -> Rows {
    match decode_reply(reply) {
        Ok(ReplyView::FaceRows(r)) => r
            .iter()
            .filter(|r| r.role == FACE_CHECK)
            .map(|r| r.strings.to_vec())
            .collect(),
        other => panic!("expected face rows, got {other:?}"),
    }
}

fn head(reply: &[u8]) -> Vec<String> {
    match decode_reply(reply) {
        Ok(ReplyView::FaceRows(r)) => r
            .iter()
            .find(|r| r.role == FACE_CHECK_HEAD)
            .map(|r| r.strings.to_vec())
            .expect("a head row"),
        other => panic!("expected face rows, got {other:?}"),
    }
}

fn gesture(near: &End<'_>, far: &End<'_>, media: &str) -> Vec<u8> {
    let mut v = vec![0u8];
    push_end(&mut v, near);
    push_end(&mut v, far);
    v.push(media.len() as u8);
    v.extend_from_slice(media.as_bytes());
    v
}

#[test]
fn no_estate_is_an_error_not_a_clean_bill() {
    let mut shell = Shell::new();
    assert_eq!(
        error_code(&shell.handle(OP_CHECKS, &[])),
        Some(ERR_NOT_INITIALISED)
    );
    assert!(rows(&shell.handle(OP_CHECK_GESTURE, &[0])).is_empty());
}

#[test]
fn the_baked_rules_are_the_corpus_directory() {
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../corpus/rules");
    let mut on_disk: Vec<String> = std::fs::read_dir(dir)
        .unwrap()
        .filter_map(Result::ok)
        .filter(|e| e.path().is_dir())
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .collect();
    on_disk.sort();
    let baked: Vec<&str> = RULES.iter().map(|(id, _)| *id).collect();
    assert_eq!(on_disk, baked);
}

#[test]
fn a_second_cable_on_one_port_is_refused_ahead_of_time_and_stands_once_drawn() {
    let (mut shell, a, b) = two_devices();
    let first = shell.handle(
        OP_CABLE,
        &draw_frame(
            1_700_000_001_000,
            0x11,
            &End::Mint(&a, "ge-0/0/0"),
            &End::Mint(&b, "ge-0/0/1"),
            "",
        ),
    );
    assert_eq!(error_code(&first), None);
    let (cable1, a_port) = (reply_slot(&first, 1), reply_slot(&first, 2));

    let reply = shell.handle(OP_CHECKS, &[]);
    assert_eq!(head(&reply)[..3], ["0", "0", "0"]);
    assert!(rows(&reply).is_empty(), "one cable on each port is fine");

    // Mint-to-mint: nothing to say. Existing port again: refused, with a reason and fix.
    assert!(rows(&shell.handle(
        OP_CHECK_GESTURE,
        &gesture(&End::Mint(&a, "x"), &End::Mint(&b, "y"), "")
    ))
    .is_empty());
    let refused = rows(&shell.handle(
        OP_CHECK_GESTURE,
        &gesture(&End::Port(&a_port), &End::Mint(&b, "y"), ""),
    ));
    assert_eq!(refused.len(), 1);
    assert_eq!(refused[0][0], "phy.port.already-cabled");
    assert_eq!(refused[0][1], "refuse");
    assert!(!refused[0][3].is_empty(), "a refusal carries its fix");
    assert!(
        refused[0][7].contains(&a_port),
        "and names the port: {:?}",
        refused[0][7]
    );
    // The dry run wrote nothing.
    assert!(rows(&shell.handle(OP_CHECKS, &[])).is_empty());

    // Draw it anyway (OP_CABLE does not gate; the page does): now it stands, then a cut clears it.
    let second = shell.handle(
        OP_CABLE,
        &draw_frame(
            1_700_000_002_000,
            0x22,
            &End::Port(&a_port),
            &End::Mint(&b, "ge-0/0/2"),
            "",
        ),
    );
    assert_eq!(error_code(&second), None);
    let reply = shell.handle(OP_CHECKS, &[]);
    assert_eq!(head(&reply)[..3], ["1", "0", "0"]);
    assert_eq!(rows(&reply)[0][0], "phy.port.already-cabled");
    let cable2 = reply_slot(&second, 1);
    let _ = cable1;
    let mut cut = Vec::new();
    cut.extend_from_slice(&1_700_000_003_000u64.to_le_bytes());
    cut.extend_from_slice(&0x33u128.to_le_bytes());
    cut.push(0);
    cut.push(1);
    cut.push(cable2.len() as u8);
    cut.extend_from_slice(cable2.as_bytes());
    assert_eq!(error_code(&shell.handle(OP_CABLE, &cut)), None);
    assert!(
        rows(&shell.handle(OP_CHECKS, &[])).is_empty(),
        "the cut cleared it"
    );
}

#[test]
fn a_frame_that_does_not_parse_answers_no_rows() {
    let (mut shell, a, _) = two_devices();
    for frame in [
        vec![],
        vec![9],
        vec![0],
        vec![0, 0],
        vec![1, 1, 2],
        vec![0, 3, 3, 0],
    ] {
        assert!(
            rows(&shell.handle(OP_CHECK_GESTURE, &frame)).is_empty(),
            "{frame:?}"
        );
    }
    let _ = a;
}
