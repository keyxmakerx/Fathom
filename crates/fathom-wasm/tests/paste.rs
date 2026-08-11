//! `OP_PASTE`: the on-ramp, end to end, through the same shell the browser
//! calls.
//!
//! This is the first test in the tree that runs the whole product in one call —
//! text in, a typed store out, rendered as the bytes a page reads. It is native
//! (the rlib half), the pattern WO-07 §4.6 set: one process, the shell path,
//! every byte the hand-authored JS reader will see pinned here because no
//! compiler checks that reader.
//!
//! What it does **not** claim: that the shipped `.wasm` behaves the same. That
//! is `artifact_gates.rs`'s job for the module's shape, and a browser's for the
//! page. Native parity is necessary and not sufficient, and saying so is
//! cheaper than discovering it.

use fathom_inventory::InvKind;
use fathom_wasm::protocol::{
    decode_reply, ErrorView, FaceRowView, ReplyView, ERR_BAD_FRAME, ERR_INGEST_REFUSED,
    ERR_NOTHING_UNDERSTOOD, ERR_PASTE_FRAME, FACE_HEADER, FACE_PASTE, FACE_RESIDUE,
    FACE_UNRESOLVED,
};
use fathom_wasm::shell::Shell;
use fathom_wasm::{OP_INV_ROWS, OP_PASTE};

/// 2026-08-08T00:00:00Z. A stored value, like every timestamp in this tree.
const TS: u64 = 1_786_147_200_000;
const ENTROPY: u128 = 0x0000_0000_0000_0000_2026;

/// Route-based IPsec on an SRX, in the set form a `show configuration
/// | display set` produces. Deliberately mixed: statements the dictionary
/// knows, statements it does not (the routing options and the policy), and one
/// pre-shared key, which must never survive the call.
const PASTE: &str = "\
set system host-name srx-branch-01
set interfaces ge-0/0/0 unit 0 family inet address 203.0.113.2/30
set interfaces st0 unit 0 family inet address 10.255.0.1/30
set security ike proposal ike-prop authentication-method pre-shared-keys
set security ike proposal ike-prop dh-group group14
set security ike proposal ike-prop encryption-algorithm aes-256-cbc
set security ike policy ike-pol proposals ike-prop
set security ike policy ike-pol pre-shared-key ascii-text \"SuperSecret123\"
set security ike gateway gw-hq ike-policy ike-pol
set security ike gateway gw-hq address 198.51.100.10
set security ike gateway gw-hq external-interface ge-0/0/0.0
set security ipsec proposal ipsec-prop protocol esp
set security ipsec policy ipsec-pol proposals ipsec-prop
set security ipsec vpn hq-vpn ike gateway gw-hq
set security ipsec vpn hq-vpn ike ipsec-policy ipsec-pol
set security ipsec vpn hq-vpn bind-interface st0.0
set security zones security-zone trust interfaces ge-0/0/0.0
set security zones security-zone vpn interfaces st0.0
set routing-options static route 10.10.0.0/16 next-hop st0.0
set security policies from-zone trust to-zone vpn policy allow match source-address any
";

fn frame(at: u64, entropy: u128, text: &str) -> Vec<u8> {
    let mut f = Vec::with_capacity(24 + text.len());
    f.extend_from_slice(&at.to_le_bytes());
    f.extend_from_slice(&entropy.to_le_bytes());
    f.extend_from_slice(text.as_bytes());
    f
}

fn face(reply: &[u8]) -> Vec<FaceRowView> {
    match decode_reply(reply).expect("a well-formed reply") {
        ReplyView::FaceRows(rows) => rows,
        other => panic!("expected FaceRows, got {other:?}"),
    }
}

fn error(reply: &[u8]) -> ErrorView {
    match decode_reply(reply).expect("a well-formed reply") {
        ReplyView::Error(e) => e,
        other => panic!("expected Error, got {other:?}"),
    }
}

fn pasted() -> (Shell, Vec<FaceRowView>) {
    let mut shell = Shell::new();
    let reply = shell.handle(OP_PASTE, &frame(TS, ENTROPY, PASTE));
    let rows = face(&reply);
    (shell, rows)
}

fn summary(rows: &[FaceRowView]) -> &FaceRowView {
    let head = rows.first().expect("a reply always carries its summary");
    assert_eq!(head.role, FACE_PASTE, "record 0 is the summary");
    assert_eq!(head.slot_count, 8);
    head
}

fn count(rows: &[FaceRowView], slot: usize) -> usize {
    summary(rows).strings[slot]
        .parse()
        .unwrap_or_else(|e| panic!("slot {slot} is a decimal count: {e}"))
}

#[test]
fn a_paste_becomes_an_estate() {
    let (_shell, rows) = pasted();
    let head = summary(&rows);

    assert!(count(&rows, 0) > 0, "the paste built nodes");
    assert!(count(&rows, 1) > 0, "the paste built edges");
    assert_eq!(head.strings[7], "junos-srx", "the platform is stamped");
    assert!(
        !head.strings[5].is_empty(),
        "the device has a display id the page can open"
    );
    assert_eq!(
        head.strings[6], "srx-branch-01",
        "the hostname is read off the config, not invented"
    );
}

/// Invariant 3, at the one boundary that can breach it. The key is in the
/// paste; it must be in nothing that comes back.
#[test]
fn the_pre_shared_key_never_comes_back() {
    let (mut shell, rows) = pasted();
    assert_eq!(count(&rows, 3), 1, "exactly one secret was taken out");

    let mut seen: Vec<String> = rows
        .iter()
        .flat_map(|r| r.strings.iter().cloned())
        .collect();
    // Everything the page can reach afterwards, not just the paste reply.
    for kind in 0u8..3 {
        let reply = shell.handle(OP_INV_ROWS, &[kind]);
        seen.extend(face(&reply).iter().flat_map(|r| r.strings.iter().cloned()));
    }
    for s in &seen {
        assert!(
            !s.contains("SuperSecret123"),
            "the pre-shared key reached the page in: {s}"
        );
    }
}

/// `14`'s governing rule at the reply boundary: a line the parser did not bind
/// is *named*, not dropped. The routing statement and the policy statement are
/// outside the dictionary and both must be visible as residue.
#[test]
fn what_was_not_understood_is_named() {
    let (_shell, rows) = pasted();
    let residue: Vec<&FaceRowView> = rows.iter().filter(|r| r.role == FACE_RESIDUE).collect();

    assert_eq!(
        residue.len(),
        count(&rows, 2),
        "the rows and the summary count agree when nothing is capped"
    );
    assert!(!residue.is_empty(), "this paste has residue");

    for r in &residue {
        assert_eq!(r.slot_count, 3);
        assert!(
            r.strings[0].parse::<u32>().is_ok(),
            "slot 0 is a line number, got {:?}",
            r.strings[0]
        );
        assert!(!r.strings[1].is_empty(), "slot 1 carries the line");
        assert!(!r.strings[2].is_empty(), "slot 2 says why");
    }

    let text: Vec<&str> = residue.iter().map(|r| r.strings[1].as_str()).collect();
    assert!(
        text.iter().any(|t| t.contains("routing-options")),
        "the routing statement is outside the dictionary and must be named: {text:?}"
    );
    assert!(
        text.iter().any(|t| t.contains("security policies")),
        "the policy statement is outside the dictionary and must be named: {text:?}"
    );
}

/// A reference the capture named and did not contain is carried out, with the
/// name intact. `reth0.0`-shaped: here `ge-0/0/0.0` is named by a zone before
/// any `unit 0` under `ge-0/0/0`… which this paste *does* declare, so the
/// interesting assertion is the weaker, true one — every unresolved row that
/// exists names something.
#[test]
fn unresolved_references_keep_their_names() {
    let (_shell, rows) = pasted();
    let unresolved: Vec<&FaceRowView> = rows.iter().filter(|r| r.role == FACE_UNRESOLVED).collect();
    assert_eq!(unresolved.len(), count(&rows, 4));

    for u in &unresolved {
        assert_eq!(u.slot_count, 3);
        assert!(!u.strings[0].is_empty(), "the reference keeps its name");
        assert!(!u.strings[1].is_empty(), "the edge kind is named");
        assert!(u.strings[2].parse::<u32>().is_ok(), "slot 2 is a line");
    }
}

/// The estate the inventory face renders is the pasted one, not the demo.
#[test]
fn the_inventory_face_renders_the_pasted_estate() {
    let (mut shell, rows) = pasted();
    let hostname = summary(&rows).strings[6].clone();

    let devices = face(&shell.handle(OP_INV_ROWS, &[0]));
    let cells: Vec<String> = devices
        .iter()
        .skip(1)
        .flat_map(|r| r.strings.iter().cloned())
        .collect();
    assert!(
        cells.contains(&hostname),
        "the device table shows the pasted box: {cells:?}"
    );
    assert!(
        !cells.iter().any(|c| c.contains("Demo")),
        "no demo estate leaked in: {cells:?}"
    );
}

/// Invariant 9 at this boundary: the frame carries the only two nondeterministic
/// inputs, so the same frame must produce the same bytes.
#[test]
fn the_same_frame_gives_the_same_bytes() {
    let mut a = Shell::new();
    let mut b = Shell::new();
    let f = frame(TS, ENTROPY, PASTE);
    assert_eq!(a.handle(OP_PASTE, &f), b.handle(OP_PASTE, &f));

    // And a different clock changes it, which is what proves the first
    // assertion is about determinism rather than about a constant.
    let mut c = Shell::new();
    assert_ne!(
        a.handle(OP_PASTE, &f),
        c.handle(OP_PASTE, &frame(TS + 1, ENTROPY, PASTE))
    );
}

#[test]
fn a_short_frame_is_refused_by_code() {
    let mut shell = Shell::new();
    let e = error(&shell.handle(OP_PASTE, &[0u8; 23]));
    assert_eq!(e.code, ERR_PASTE_FRAME);
    assert!(e.detail.contains("24"), "{}", e.detail);
}

#[test]
fn a_paste_that_is_not_utf8_is_refused_by_code() {
    let mut shell = Shell::new();
    let mut f = frame(TS, ENTROPY, "");
    f.push(0xff);
    let e = error(&shell.handle(OP_PASTE, &f));
    assert_eq!(e.code, ERR_INGEST_REFUSED);
    assert!(e.detail.contains("offset 0"), "{}", e.detail);
}

/// A refusal does not cost the user the estate they already had.
#[test]
fn a_refused_paste_leaves_the_previous_estate_alone() {
    let (mut shell, rows) = pasted();
    let before = shell.handle(OP_INV_ROWS, &[0]);
    assert!(!before.is_empty());

    let mut bad = frame(TS, ENTROPY, "");
    bad.push(0xff);
    let e = error(&shell.handle(OP_PASTE, &bad));
    assert_eq!(e.code, ERR_INGEST_REFUSED);

    assert_eq!(
        shell.handle(OP_INV_ROWS, &[0]),
        before,
        "the estate survived a refused paste"
    );
    let _ = rows;
}

// --- the estate-destruction defect (found 2026-08-10) ------------------------
//
// From the day `OP_PASTE` landed until this fix, a paste that understood
// *nothing* still replaced the estate. The binder seeds a `Device` root before
// it reads a statement, so `plan::validate`'s device-rooted check passed, the
// weld succeeded, and `self.estate = Some(graph)` fired — leaving the operator
// looking at an empty device where their real one had been, with no error and
// a cheerful "0 names not found".
//
// The two inputs below are not adversarial. They are the two most likely wrong
// pastes in the world: a config from a different vendor, and Junos in the form
// `show configuration` prints when you forget `| display set`.

const GOOD: &str = "\
set system host-name srx-good
set interfaces ge-0/0/0 unit 0 family inet address 10.0.0.1/30
";

const CISCO: &str = "\
hostname core-rtr-01
!
interface GigabitEthernet0/0
 ip address 192.0.2.1 255.255.255.0
!
end
";

const CURLY_JUNOS: &str = "\
system {
    host-name srx-curly;
}
interfaces {
    ge-0/0/0 {
        unit 0;
    }
}
";

/// The wire byte for a kind: its index in `InvKind::ALL`, which is what the
/// module indexes. Derived so a growing strip cannot silently repoint a test.
fn kind_byte(kind: InvKind) -> u8 {
    InvKind::ALL
        .iter()
        .position(|k| *k == kind)
        .and_then(|i| u8::try_from(i).ok())
        .expect("a declared kind")
}

fn devices(shell: &mut Shell) -> Vec<[String; 8]> {
    face(&shell.handle(OP_INV_ROWS, &[kind_byte(InvKind::Device)]))
        .into_iter()
        .skip(1)
        .map(|r| r.strings)
        .collect()
}

fn loaded_with_good() -> Shell {
    let mut shell = Shell::new();
    let rows = face(&shell.handle(OP_PASTE, &frame(TS, ENTROPY, GOOD)));
    assert_eq!(summary(&rows).strings[6], "srx-good");
    shell
}

#[test]
fn a_paste_that_binds_nothing_is_refused() {
    for (what, text) in [
        ("a Cisco config", CISCO),
        ("curly-brace Junos", CURLY_JUNOS),
    ] {
        let mut shell = Shell::new();
        let e = error(&shell.handle(OP_PASTE, &frame(TS, ENTROPY, text)));
        assert_eq!(
            e.code, ERR_NOTHING_UNDERSTOOD,
            "{what} should be refused by its own code"
        );
    }
}

/// The whole point: the refusal exists to protect what is already loaded.
#[test]
fn a_paste_that_binds_nothing_leaves_the_estate_alone() {
    for (what, text) in [
        ("a Cisco config", CISCO),
        ("curly-brace Junos", CURLY_JUNOS),
    ] {
        let mut shell = loaded_with_good();
        let before = devices(&mut shell);
        assert_eq!(before.len(), 1, "one device before");

        let e = error(&shell.handle(OP_PASTE, &frame(TS, ENTROPY, text)));
        assert_eq!(e.code, ERR_NOTHING_UNDERSTOOD);

        let after = devices(&mut shell);
        assert_eq!(after, before, "{what} destroyed the estate");
        assert_eq!(
            after[0][1], "srx-good",
            "{what} replaced the hostname with an empty device"
        );
    }
}

/// The refusal must be actionable. A Juniper engineer who pasted the wrong form
/// needs to be told which form to use, not that something went wrong.
#[test]
fn curly_brace_junos_is_named_and_the_fix_is_given() {
    let mut shell = Shell::new();
    let e = error(&shell.handle(OP_PASTE, &frame(TS, ENTROPY, CURLY_JUNOS)));
    assert!(
        e.detail.contains("display set"),
        "the remedy must be in the message: {}",
        e.detail
    );
    assert!(
        e.detail.contains("still loaded") || e.detail.contains("Nothing was changed"),
        "the message must say the estate survived: {}",
        e.detail
    );
}

/// A different vendor gets a different sentence — Fathom says what it knows
/// rather than pretending the Junos advice applies.
#[test]
fn another_vendors_config_says_so() {
    let mut shell = Shell::new();
    let e = error(&shell.handle(OP_PASTE, &frame(TS, ENTROPY, CISCO)));
    assert!(
        e.detail.contains("Juniper SRX today"),
        "the message should name what Fathom does know: {}",
        e.detail
    );
    assert!(
        !e.detail.contains("display set"),
        "a Cisco config is not fixed by `| display set`: {}",
        e.detail
    );
}

/// The refusal is exact, not a heuristic: **one** bound line is enough to be an
/// estate. This is the assertion that stops the fix from becoming the worse bug
/// the audit warned about — a guess that rejects a legitimate paste.
#[test]
fn one_understood_line_is_enough() {
    let mut shell = Shell::new();
    let rows = face(&shell.handle(
        OP_PASTE,
        &frame(
            TS,
            ENTROPY,
            "set system host-name lonely\nthis line is not Junos at all\n! nor is this\n",
        ),
    ));
    assert_eq!(summary(&rows).strings[6], "lonely");
    assert_eq!(
        count(&rows, 2),
        2,
        "the two unreadable lines are still named"
    );
}

#[test]
fn an_empty_paste_is_refused_without_pretending_to_know_why() {
    let mut shell = Shell::new();
    let e = error(&shell.handle(OP_PASTE, &frame(TS, ENTROPY, "\n\n   \n")));
    assert_eq!(e.code, ERR_NOTHING_UNDERSTOOD);
    assert!(e.detail.contains("empty"), "{}", e.detail);
}

/// Stage 4 of `00-ROUTE-TO-WORKABLE.md`, pinned. Before 2026-08-10 a pasted
/// config built nine kinds of object and the inventory offered three row sets,
/// none of which any of them appeared in — so an operator who pasted a working
/// tunnel saw one device and no way to reach the zones, the gateway or the VPN
/// that Fathom had understood perfectly.
///
/// This asserts by *content*, not by count: each kind must show the name that
/// was in the pasted text. A row rendering as `ikegateway:01KZ…` passes a count
/// assertion and fails the operator, which is exactly the defect this replaces.
#[test]
fn the_objects_a_config_builds_are_reachable_and_named() {
    let (mut shell, _) = pasted();

    // Looked up by label, never written as a literal byte: the byte is
    // `InvKind::ALL`'s index, and a literal here silently starts testing a
    // different kind the moment the strip grows. It did, within the hour.
    let want: [(InvKind, &str, &str); 7] = [
        (InvKind::Interface, "ge-0/0/0", "the WAN interface"),
        (InvKind::TunnelInterface, "st0", "the tunnel interface"),
        (InvKind::Zone, "trust", "a security zone"),
        (InvKind::IkeGateway, "gw-hq", "the IKE gateway"),
        (InvKind::IpsecVpn, "hq-vpn", "the IPsec VPN"),
        (InvKind::IkeProposal, "ike-prop", "the IKE proposal"),
        (InvKind::IpsecProposal, "ipsec-prop", "the IPsec proposal"),
    ];

    for (kind, name, what) in want {
        let byte = kind_byte(kind);
        let rows = face(&shell.handle(OP_INV_ROWS, &[byte]));
        assert!(rows.len() > 1, "{what} has no rows at kind byte {byte}");

        let cells: Vec<String> = rows
            .iter()
            .skip(1)
            .flat_map(|r| r.strings.iter().cloned())
            .collect();
        assert!(
            cells.iter().any(|c| c == name),
            "{what} does not show `{name}` — it renders as {cells:?}"
        );
        // Every row must carry the hostname of the box it came from, or the
        // table is a list of names with no estate behind it.
        assert!(
            cells.iter().any(|c| c == "srx-branch-01"),
            "{what} does not name its device: {cells:?}"
        );
    }
}

/// The header a kind advertises and the rows it returns must agree on width,
/// on the real pasted estate — the demo estate cannot check this for these
/// kinds because it contains none of them.
#[test]
fn every_pasted_kind_has_a_consistent_header() {
    let (mut shell, _) = pasted();
    for byte in 0..u8::try_from(InvKind::ALL.len()).expect("fewer than 256 kinds") {
        let rows = face(&shell.handle(OP_INV_ROWS, &[byte]));
        let head = &rows[0];
        assert_eq!(head.role, FACE_HEADER, "kind {byte}");
        // slot_count is `columns + 2` — the kind label and the opinions header.
        let cols = head.slot_count as usize - 2;
        assert!(cols > 0, "kind {byte} advertises no columns");
        for r in rows.iter().skip(1) {
            assert_eq!(r.slot_count, head.slot_count, "kind {byte} row width");
        }
    }
}

/// The kind byte is a wire value. Nine kinds exist; the tenth must still be a
/// typed refusal rather than a panic or a silently empty table.
#[test]
fn an_unknown_kind_byte_is_still_refused() {
    let (mut shell, _) = pasted();
    let past_the_end = u8::try_from(InvKind::ALL.len()).expect("fewer than 256 kinds");
    let e = error(&shell.handle(OP_INV_ROWS, &[past_the_end]));
    assert_eq!(e.code, ERR_BAD_FRAME);
}
