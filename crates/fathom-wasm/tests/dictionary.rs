//! `OP_DICT`: the statement dictionary, handed in by the page.
//!
//! The dictionary was compiled into this module until 2026-08-15 — 29 670 bytes
//! of YAML in the data section, against `44` §5.2's 900 000-byte ceiling that
//! fails the merge, with every further platform costing its own. It arrives
//! over the byte protocol now, the way `OP_INIT` already carried commands,
//! explainers and rules.
//!
//! That move creates a state the module never had: **a paste with no
//! dictionary**. The two wrong answers are a panic and a silent empty parse,
//! and the second is the dangerous one — an empty dictionary matches nothing,
//! so a perfectly good config comes back as *"none of these lines is one Fathom
//! knows"* and the operator is blamed for a boot the page did not finish. The
//! first test below is that refusal; the rest are the frame's own gates.

use fathom_wasm::dictframe::{pack_dict, ROLE_DICT_SOURCE, ROLE_FIELD_KEYS};
use fathom_wasm::protocol::{
    decode_reply, ErrorView, ReplyView, ERR_BAD_FRAME, ERR_CORPUS_LOAD, ERR_NO_DICTIONARY,
};
use fathom_wasm::shell::Shell;
use fathom_wasm::{OP_DICT, OP_PASTE};

mod common;

const TS: u64 = 1_786_147_200_000;
const ENTROPY: u128 = 0x0000_0000_0000_0000_2026;

const PASTE: &str = "set system host-name srx-branch-01\n";

fn paste_frame(text: &str) -> Vec<u8> {
    let mut f = Vec::with_capacity(24 + text.len());
    f.extend_from_slice(&TS.to_le_bytes());
    f.extend_from_slice(&ENTROPY.to_le_bytes());
    f.extend_from_slice(text.as_bytes());
    f
}

fn error(reply: &[u8]) -> ErrorView {
    match decode_reply(reply).expect("a well-formed reply") {
        ReplyView::Error(e) => e,
        other => panic!("expected Error, got {other:?}"),
    }
}

/// The refusal this whole change makes necessary. Typed, not a panic; distinct,
/// not `ERR_NOT_INITIALISED`, which already means two other things.
#[test]
fn a_paste_before_the_dictionary_is_refused_by_its_own_code() {
    let mut shell = Shell::new();
    let e = error(&shell.handle(OP_PASTE, &paste_frame(PASTE)));
    assert_eq!(e.code, ERR_NO_DICTIONARY);
    assert!(
        e.detail.contains("OP_DICT"),
        "the refusal names the call the page missed: {}",
        e.detail
    );
}

/// And the estate is untouched: refusing is not the same as clearing.
#[test]
fn a_paste_before_the_dictionary_builds_nothing() {
    let mut shell = Shell::new();
    shell.handle(OP_PASTE, &paste_frame(PASTE));
    // No estate was ever loaded, so every face opcode still says so rather than
    // answering out of an empty graph the failed paste created.
    let e = error(&shell.handle(fathom_wasm::OP_INV_ROWS, &[0]));
    assert_eq!(e.code, fathom_wasm::protocol::ERR_NOT_INITIALISED);
}

/// The whole point: hand it in, and the paste works.
#[test]
fn the_handed_in_dictionary_makes_a_paste_work() {
    let mut shell = common::booted_shell();
    let reply = shell.handle(OP_PASTE, &paste_frame(PASTE));
    match decode_reply(&reply).expect("a well-formed reply") {
        ReplyView::FaceRows(rows) => {
            let head = rows.first().expect("the summary row");
            assert_eq!(head.strings[7], "junos-srx", "the platform is stamped");
            assert_eq!(head.strings[6], "srx-branch-01");
        }
        other => panic!("the paste did not build an estate: {other:?}"),
    }
}

/// Re-handing the dictionary is permitted and replaces the held one, mirroring
/// `OP_INIT`. Pinned because a page that reloads without a fresh module would
/// otherwise be a coin toss.
#[test]
fn the_dictionary_can_be_handed_in_twice() {
    let mut shell = common::booted_shell();
    assert!(shell.handle(OP_DICT, &common::dict_frame()).is_empty());
    let reply = shell.handle(OP_PASTE, &paste_frame(PASTE));
    assert!(matches!(
        decode_reply(&reply).expect("a well-formed reply"),
        ReplyView::FaceRows(_)
    ));
}

/// Determinism (invariant 9): the frame is a pure function of its inputs, and
/// two shells given the same one answer the same bytes.
#[test]
fn the_same_dictionary_frame_gives_the_same_bytes() {
    assert_eq!(common::dict_frame(), common::dict_frame());
    let mut a = common::booted_shell();
    let mut b = common::booted_shell();
    assert_eq!(
        a.handle(OP_PASTE, &paste_frame(PASTE)),
        b.handle(OP_PASTE, &paste_frame(PASTE))
    );
}

// --- the frame's gates -------------------------------------------------------

#[test]
fn a_truncated_frame_is_refused() {
    let mut shell = Shell::new();
    let full = common::dict_frame();
    let short = full.get(..full.len() / 2).expect("half a frame").to_vec();
    assert_eq!(error(&shell.handle(OP_DICT, &short)).code, ERR_BAD_FRAME);
}

#[test]
fn trailing_bytes_are_refused() {
    let mut shell = Shell::new();
    let mut frame = common::dict_frame();
    frame.push(0);
    let e = error(&shell.handle(OP_DICT, &frame));
    assert_eq!(e.code, ERR_BAD_FRAME);
    assert!(e.detail.contains("trailing"), "{}", e.detail);
}

#[test]
fn an_unknown_role_byte_is_refused() {
    let mut shell = Shell::new();
    let frame = pack_dict(&[(7, "x.yaml", "platform: junos-srx\n")]);
    let e = error(&shell.handle(OP_DICT, &frame));
    assert_eq!(e.code, ERR_BAD_FRAME);
    assert!(e.detail.contains("role byte 7"), "{}", e.detail);
}

/// A frame with no `role: 1` file would build a dictionary with no wire keys,
/// which fails the field gate with a message about the corpus rather than about
/// the frame. Naming the real cause is the difference between a five-minute fix
/// and an afternoon.
#[test]
fn a_frame_without_the_field_key_registry_is_refused() {
    let mut shell = Shell::new();
    let sources = common::dict_sources();
    let files: Vec<(u8, &str, &str)> = sources
        .iter()
        .map(|(n, t)| (ROLE_DICT_SOURCE, n.as_str(), t.as_str()))
        .collect();
    let e = error(&shell.handle(OP_DICT, &pack_dict(&files)));
    assert_eq!(e.code, ERR_BAD_FRAME);
    assert!(e.detail.contains("field-key registry"), "{}", e.detail);
}

#[test]
fn a_frame_with_no_dictionary_source_is_refused() {
    let mut shell = Shell::new();
    let keys = common::field_keys();
    let frame = pack_dict(&[(ROLE_FIELD_KEYS, "schema/field-keys.yaml", keys.as_str())]);
    let e = error(&shell.handle(OP_DICT, &frame));
    assert_eq!(e.code, ERR_BAD_FRAME);
    assert!(e.detail.contains("no dictionary source"), "{}", e.detail);
}

#[test]
fn two_field_key_registries_are_refused() {
    let mut shell = Shell::new();
    let sources = common::dict_sources();
    let keys = common::field_keys();
    let mut files: Vec<(u8, &str, &str)> = sources
        .iter()
        .map(|(n, t)| (ROLE_DICT_SOURCE, n.as_str(), t.as_str()))
        .collect();
    files.push((ROLE_FIELD_KEYS, "a.yaml", keys.as_str()));
    files.push((ROLE_FIELD_KEYS, "b.yaml", keys.as_str()));
    let e = error(&shell.handle(OP_DICT, &pack_dict(&files)));
    assert_eq!(e.code, ERR_BAD_FRAME);
    assert!(
        e.detail.contains("two field-key registries"),
        "{}",
        e.detail
    );
}

#[test]
fn a_duplicate_dictionary_source_is_refused() {
    let mut shell = Shell::new();
    let sources = common::dict_sources();
    let keys = common::field_keys();
    let first = sources.first().expect("at least one source");
    let files: Vec<(u8, &str, &str)> = vec![
        (ROLE_DICT_SOURCE, first.0.as_str(), first.1.as_str()),
        (ROLE_DICT_SOURCE, first.0.as_str(), first.1.as_str()),
        (ROLE_FIELD_KEYS, "schema/field-keys.yaml", keys.as_str()),
    ];
    let e = error(&shell.handle(OP_DICT, &pack_dict(&files)));
    assert_eq!(e.code, ERR_BAD_FRAME);
    assert!(e.detail.contains("duplicate"), "{}", e.detail);
}

/// Entry indices are positional and `BindProv.entry` is a `u16` into them, so a
/// reordered frame would bind correctly and attribute every field to the wrong
/// dictionary entry. It is refused rather than sorted: sorting here measured
/// 5 096 bytes of module, and silently correcting a page that got it wrong is
/// how the page stays wrong.
#[test]
fn an_out_of_order_frame_is_refused_rather_than_sorted() {
    let mut shell = Shell::new();
    let mut sources = common::dict_sources();
    sources.reverse();
    let keys = common::field_keys();
    let mut files: Vec<(u8, &str, &str)> = sources
        .iter()
        .map(|(n, t)| (ROLE_DICT_SOURCE, n.as_str(), t.as_str()))
        .collect();
    files.push((ROLE_FIELD_KEYS, "schema/field-keys.yaml", keys.as_str()));
    let e = error(&shell.handle(OP_DICT, &pack_dict(&files)));
    assert_eq!(e.code, ERR_BAD_FRAME);
    assert!(e.detail.contains("sorted by name"), "{}", e.detail);
}

/// A frame that decodes and then fails a dictionary gate is a *corpus* fault,
/// not a page fault, and says so with a different code.
#[test]
fn a_dictionary_that_fails_its_gates_is_a_corpus_error() {
    let mut shell = Shell::new();
    let keys = common::field_keys();
    let shadowing = "platform: junos-srx\nentries:\n  \
         - { id: a, path: [security, ike], versions: \"*\", reviewed_by: x }\n  \
         - { id: b, path: [security, ike, mode], versions: \"*\", reviewed_by: x }\n";
    let frame = pack_dict(&[
        (ROLE_DICT_SOURCE, "t.yaml", shadowing),
        (ROLE_FIELD_KEYS, "schema/field-keys.yaml", keys.as_str()),
    ]);
    let e = error(&shell.handle(OP_DICT, &frame));
    assert_eq!(e.code, ERR_CORPUS_LOAD);
    assert!(e.detail.contains("strict prefix"), "{}", e.detail);
}

/// A refused dictionary must not become the held one. Otherwise a page that
/// mis-sends once is left holding half a dictionary for the rest of the
/// session, and every later paste is wrong in a way nothing reports.
#[test]
fn a_refused_dictionary_does_not_replace_the_held_one() {
    let mut shell = common::booted_shell();
    let bad = pack_dict(&[(7, "x.yaml", "")]);
    assert_eq!(error(&shell.handle(OP_DICT, &bad)).code, ERR_BAD_FRAME);
    let reply = shell.handle(OP_PASTE, &paste_frame(PASTE));
    assert!(
        matches!(
            decode_reply(&reply).expect("a well-formed reply"),
            ReplyView::FaceRows(_)
        ),
        "the dictionary handed in earlier still works"
    );
}
