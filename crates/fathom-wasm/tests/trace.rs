//! `OP_TRACE` through the shell, the way the page calls it (ADR-0061 item 9).
//!
//! A paste makes one device with no cables, so a trace of it walks the route and
//! the firewall hop and then stops at the first thing the design does not state:
//! the port behind the interface. The cabled walk is asserted in
//! `fathom-inventory`'s own tests; this file holds the wire.

mod common;

use fathom_wasm::protocol::{
    decode_reply, FaceRowView, ReplyView, ERR_BAD_FRAME, ERR_NOT_INITIALISED, FACE_PASTE,
    FACE_TR_HEAD, FACE_TR_HOP, FACE_TR_POL,
};
use fathom_wasm::shell::Shell;
use fathom_wasm::{OP_PASTE, OP_TRACE};

const TS: u64 = 1_786_147_200_000;
const ENTROPY: u128 = 0x0000_0000_0000_0000_2026;

const SRX: &str = "\
set system host-name srx-branch-01
set interfaces ge-0/0/0 unit 0 family inet address 203.0.113.2/30
set interfaces ge-0/0/1 unit 0 family inet address 10.0.0.1/24
set routing-options static route 198.51.100.0/24 next-hop 203.0.113.1
set security zones security-zone trust interfaces ge-0/0/1.0
set security zones security-zone untrust interfaces ge-0/0/0.0
set security policies from-zone trust to-zone untrust policy allow-web match source-address any
set security policies from-zone trust to-zone untrust policy allow-web match destination-address any
set security policies from-zone trust to-zone untrust policy allow-web match application junos-https
set security policies from-zone trust to-zone untrust policy allow-web then permit
";

fn frame(text: &str) -> Vec<u8> {
    let mut f = Vec::with_capacity(25 + text.len());
    f.extend_from_slice(&TS.to_le_bytes());
    f.extend_from_slice(&ENTROPY.to_le_bytes());
    f.push(0);
    f.extend_from_slice(text.as_bytes());
    f
}

fn face(reply: &[u8]) -> Vec<FaceRowView> {
    match decode_reply(reply).expect("a well-formed reply") {
        ReplyView::FaceRows(rows) => rows,
        other => panic!("expected FaceRows, got {other:?}"),
    }
}

fn pasted() -> (Shell, String) {
    let mut shell = common::booted_shell();
    let rows = face(&shell.handle(OP_PASTE, &frame(SRX)));
    let device = rows.first().expect("a head").strings[5].clone();
    assert_eq!(rows[0].role, FACE_PASTE);
    (shell, device)
}

fn trace(shell: &mut Shell, from: &str, to: &str, flow: &str) -> Vec<FaceRowView> {
    face(&shell.handle(OP_TRACE, format!("{from}\n{to}\n{flow}").as_bytes()))
}

#[test]
fn a_trace_names_the_route_and_stops_where_the_design_stops() {
    let (mut shell, device) = pasted();
    let rows = trace(&mut shell, &device, "198.51.100.77", "6 443");
    let head = &rows[0];
    assert_eq!(head.role, FACE_TR_HEAD);
    assert_eq!(head.strings[1], "198.51.100.77");
    assert_eq!(head.strings[2], "TCP 443");
    assert!(
        head.strings[3].contains("is not tied to a port"),
        "stops at the port behind the interface: {}",
        head.strings[3]
    );

    let hops: Vec<&FaceRowView> = rows.iter().filter(|r| r.role == FACE_TR_HOP).collect();
    let kinds: Vec<&str> = hops.iter().map(|h| h.strings[1].as_str()).collect();
    assert_eq!(kinds, ["start", "device", "stop"]);
    let device_hop = hops[1];
    assert!(device_hop.strings[3].contains("static route 198.51.100.0/24 via 203.0.113.1"));
    // The firewall hop reads its zones: no ingress interface was named.
    assert!(device_hop.strings[7].starts_with("no ingress interface to untrust"));
}

#[test]
fn a_policy_row_carries_the_stored_action_and_a_match_state_never_a_verdict() {
    let (mut shell, device) = pasted();
    let rows = trace(&mut shell, &device, "198.51.100.77", "6 443");
    let pols: Vec<&FaceRowView> = rows.iter().filter(|r| r.role == FACE_TR_POL).collect();
    // The set is for trust to untrust; with no ingress interface it is not placed on the hop, but
    // it is listed as "can't tell" with the gap named.
    assert!(
        !pols.is_empty(),
        "the set ending in the egress zone is listed"
    );
    for p in &pols {
        assert_eq!(p.strings[5], "can't tell");
        assert_eq!(p.strings[7], "unplaced");
    }
    let all: String = rows
        .iter()
        .flat_map(|r| r.strings.iter().cloned())
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase();
    for banned in ["allowed", "denied", "blocked", "reachable", "permitted"] {
        assert!(!all.contains(banned), "`{banned}` in {all}");
    }
}

#[test]
fn a_trace_from_an_unreadable_start_says_so_in_the_head() {
    let (mut shell, _) = pasted();
    let rows = trace(&mut shell, "not an id", "198.51.100.77", "");
    assert!(rows[0].strings[3].contains("could not read"));
}

#[test]
fn no_estate_and_a_bad_frame_are_errors_not_traces() {
    let mut shell = common::booted_shell();
    let reply = shell.handle(OP_TRACE, b"a\nb\n");
    match decode_reply(&reply).expect("a reply") {
        ReplyView::Error(e) => assert_eq!(e.code, ERR_NOT_INITIALISED),
        other => panic!("expected an error, got {other:?}"),
    }
    let (mut shell, _) = pasted();
    let reply = shell.handle(OP_TRACE, b"just one line");
    match decode_reply(&reply).expect("a reply") {
        ReplyView::Error(e) => assert_eq!(e.code, ERR_BAD_FRAME),
        other => panic!("expected an error, got {other:?}"),
    }
}
