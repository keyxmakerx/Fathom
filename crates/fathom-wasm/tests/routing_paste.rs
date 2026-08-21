//! Paste a config with OSPF and BGP in it and read the two inventory tables
//! back — through the same shell the browser calls (2026-08-15).
//!
//! `routing_slice.rs` in `fathom-ingest` proves the fragment. This proves the
//! whole path: text → gate → bind → weld → typed store → the bytes
//! `OP_INV_ROWS` hands the page. The two are deliberately separate, because
//! the failure they catch is different — a fragment can be perfect and still
//! reach an empty table if the containment chain, the slot type or the cell
//! walk is wrong, and each of those three broke at least once while this was
//! being written.
//!
//! Native (the rlib half), the pattern `paste.rs` set. It does not claim the
//! shipped `.wasm` behaves the same; a browser run is recorded in the session
//! report for that.

use fathom_inventory::InvKind;
use fathom_wasm::protocol::{decode_reply, FaceRowView, ReplyView, FACE_HEADER, FACE_PASTE};
use fathom_wasm::shell::Shell;
use fathom_wasm::{OP_INV_ROWS, OP_PASTE};

mod common;

/// 2026-08-08T00:00:00Z. A stored value, like every timestamp in this tree.
const TS: u64 = 1_786_147_200_000;
const ENTROPY: u128 = 0x0000_0000_0000_0000_2026;

/// A branch SRX running OSPF to the LAN and eBGP to an ISP, in the set form a
/// `show configuration | display set` produces. Every statement form here was
/// read off Juniper's own documentation on 2026-08-15 — URLs beside the
/// entries in `corpus/dict/junos-srx/protocols-*.yaml`.
///
/// It carries a BGP TCP-MD5 key, because a config with BGP on it usually does
/// and invariant 3 has to hold at this boundary too.
const PASTE: &str = "\
set system host-name srx-branch-07
set routing-options router-id 10.0.0.7
set protocols ospf reference-bandwidth 100000000000
set protocols ospf area 0.0.0.0 interface ge-0/0/1.0 metric 100
set protocols ospf area 0.0.0.0 interface ge-0/0/2.0 passive
set protocols ospf area 0.0.0.1 interface st0.0 interface-type p2p
set protocols bgp local-as 65001
set protocols bgp group ISP-EDGE type external
set protocols bgp group ISP-EDGE neighbor 203.0.113.1 peer-as 64512
set protocols bgp group ISP-EDGE neighbor 203.0.113.1 authentication-key Tr0ub4dor
";

fn frame(at: u64, entropy: u128, text: &str) -> Vec<u8> {
    let mut f = Vec::with_capacity(25 + text.len());
    f.extend_from_slice(&at.to_le_bytes());
    f.extend_from_slice(&entropy.to_le_bytes());
    // The confirm byte (2026-08-21). 0 = refuse if this names a device the
    // design already holds.
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

fn pasted() -> Shell {
    // `booted_shell`, not `Shell::new`: since 2026-08-15 the dictionary is
    // handed in by the page over `OP_DICT` rather than compiled into the
    // module, and a shell that has not been given one refuses to paste at all.
    let mut shell = common::booted_shell();
    let reply = shell.handle(OP_PASTE, &frame(TS, ENTROPY, PASTE));
    let rows = face(&reply);
    assert_eq!(
        rows.first().map(|r| r.role),
        Some(FACE_PASTE),
        "record 0 is the paste summary"
    );
    shell
}

/// The data rows of one inventory table: everything after the header record.
fn table(shell: &mut Shell, kind: InvKind) -> Vec<FaceRowView> {
    let byte = InvKind::ALL
        .iter()
        .position(|k| *k == kind)
        .expect("the kind is in ALL") as u8;
    let rows = face(&shell.handle(OP_INV_ROWS, &[byte]));
    assert_eq!(
        rows.first().map(|r| r.role),
        Some(FACE_HEADER),
        "record 0 of an inventory reply is its header"
    );
    rows.into_iter().skip(1).collect()
}

/// One cell of one inventory row by COLUMN index.
///
/// `encode_inv_reply` puts the element's display id in slot 0 and the cells
/// after it, so column *n* is slot *n + 1*. Named here once rather than
/// written as `strings[n + 1]` at every use: an off-by-one in a wire offset is
/// the kind of mistake that produces a passing test asserting the wrong thing.
fn cell(row: &FaceRowView, column: usize) -> &str {
    row.strings
        .get(column + 1)
        .map(String::as_str)
        .unwrap_or_default()
}

/// The columns are `protocol, router_id, local_as, reference_bandwidth,
/// device` (`inventory.rs`). Reading them by index rather than by name is what
/// the page does, so it is what this asserts.
#[test]
fn a_paste_with_ospf_and_bgp_fills_the_routing_protocol_table() {
    let mut shell = pasted();
    let rows = table(&mut shell, InvKind::RoutingProtocol);
    assert_eq!(
        rows.len(),
        2,
        "one row for OSPF and one for BGP, got {rows:?}"
    );

    let protocols: Vec<&str> = rows.iter().map(|r| cell(r, 0)).collect();
    assert!(protocols.contains(&"ospf"), "got {protocols:?}");
    assert!(protocols.contains(&"bgp"), "got {protocols:?}");

    let ospf = rows
        .iter()
        .find(|r| cell(r, 0) == "ospf")
        .expect("an ospf row");
    let bgp = rows
        .iter()
        .find(|r| cell(r, 0) == "bgp")
        .expect("a bgp row");

    assert_eq!(cell(bgp, 2), "65001", "`local-as` is the BGP row's AS");
    // `set protocols ospf reference-bandwidth 100000000000`, in bits per
    // second exactly as Juniper documents the option and as the schema's
    // `Bandwidth` stores it. No conversion anywhere on the path.
    assert_eq!(cell(ospf, 3), "100000000000");

    // The router id is `set routing-options router-id`, which Junos puts on
    // the routing instance and both protocols use. Without the stated walk in
    // `inventory.rs` this column would read `—` on every Junos paste forever.
    for row in [ospf, bgp] {
        assert_eq!(
            cell(row, 1),
            "10.0.0.7",
            "the router id reaches the protocol row: {row:?}"
        );
    }

    // The owning device, found by walking containment up through the
    // RoutingInstance. A row that cannot say which box it is on is not an
    // estate of record.
    for row in [ospf, bgp] {
        assert_eq!(cell(row, 4), "srx-branch-07");
    }
}

/// Columns: `peer_address, peer_as, area, cost, network_type, device`.
#[test]
fn a_paste_with_ospf_and_bgp_fills_the_protocol_adjacency_table() {
    let mut shell = pasted();
    let rows = table(&mut shell, InvKind::ProtocolAdjacency);
    assert_eq!(
        rows.len(),
        4,
        "three OSPF interfaces and one BGP neighbour, got {rows:?}"
    );

    // The BGP half.
    let peer = rows
        .iter()
        .find(|r| cell(r, 0) == "203.0.113.1")
        .expect("the neighbour's address is the row's identity");
    assert_eq!(cell(peer, 1), "64512", "the neighbour-level peer-as");
    assert_eq!(cell(peer, 2), "—", "a BGP peer has no OSPF area");

    // The OSPF half. `OspfAreaId` canonicalises to a dotted quad, which is how
    // an engineer writes an area and therefore how it must read back.
    let areas: Vec<&str> = rows.iter().map(|r| cell(r, 2)).collect();
    assert_eq!(
        areas.iter().filter(|a| **a == "0.0.0.0").count(),
        2,
        "two interfaces in the backbone area, got {areas:?}"
    );
    assert!(areas.contains(&"0.0.0.1"), "got {areas:?}");

    let costed = rows
        .iter()
        .find(|r| cell(r, 3) == "100")
        .expect("`metric 100` is the cost column");
    assert_eq!(
        cell(costed, 2),
        "0.0.0.0",
        "the area bound from the same statement as the metric, with no bare \
         `interface` line in the paste to lean on"
    );

    let p2p = rows
        .iter()
        .find(|r| cell(r, 4) == "point_to_point")
        .expect("`interface-type p2p` reaches the network type column");
    assert_eq!(cell(p2p, 2), "0.0.0.1");

    for row in &rows {
        assert_eq!(cell(row, 5), "srx-branch-07");
    }
}

/// Invariant 3 at the boundary that can breach it, for BGP's own credential.
/// The key is in the paste; it must be in nothing the page can reach.
#[test]
fn the_bgp_authentication_key_never_comes_back() {
    let mut shell = pasted();
    let mut seen: Vec<String> = Vec::new();
    for byte in 0..InvKind::ALL.len() as u8 {
        seen.extend(
            face(&shell.handle(OP_INV_ROWS, &[byte]))
                .iter()
                .flat_map(|r| r.strings.iter().cloned()),
        );
    }
    // The paste reply itself carries the residue lines verbatim, so it is the
    // most likely place for a key to survive.
    // A SECOND PASTE OF THE SAME CONFIG, which since 2026-08-21 is a question
    // rather than a silent replacement. The canary needs the reply, not the
    // refusal, so it answers the question the way an operator would when the
    // boxes really are different — fresh entropy, confirm set. NOTHING ABOUT
    // THE ASSERTION BELOW CHANGES: the residue lines are still scanned for the
    // key, which is the whole point of this test.
    let mut confirmed = frame(TS, ENTROPY.wrapping_add(1 << 40), PASTE);
    confirmed[24] = 1;
    seen.extend(
        face(&shell.handle(OP_PASTE, &confirmed))
            .iter()
            .flat_map(|r| r.strings.iter().cloned()),
    );
    for s in &seen {
        assert!(
            !s.contains("Tr0ub4dor"),
            "the BGP MD5 key reached the page in: {s}"
        );
    }
}
