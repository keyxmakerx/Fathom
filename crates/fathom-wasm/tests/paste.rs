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
    ERR_NOTHING_UNDERSTOOD, ERR_PASTE_CHOICE, ERR_PASTE_FRAME, FACE_HEADER, FACE_INV, FACE_PASTE,
    FACE_RESIDUE, FACE_UNRESOLVED,
};
use fathom_wasm::shell::Shell;
use fathom_wasm::{OP_EQUIP_ADD, OP_INV_ROWS, OP_PASTE};

/// The dictionary is handed in over `OP_DICT` since 2026-08-15, so every shell
/// below is booted rather than merely new. See `common/mod.rs`.
mod common;

/// 2026-08-08T00:00:00Z. A stored value, like every timestamp in this tree.
const TS: u64 = 1_786_147_200_000;
const ENTROPY: u128 = 0x0000_0000_0000_0000_2026;
/// Two more entropy values, FAR APART from the first and from each other.
///
/// The mint walks a counter up from `entropy & (2^80 - 1)`, so two pastes whose
/// bases sit within `minted` of one another produce overlapping id ranges and
/// the second is refused. A real host draws sixteen bytes from a CSPRNG and
/// never lands that close; a test that derives one constant from another very
/// easily does, and an earlier draft of this file did it twice.
const ENTROPY_2: u128 = 0x0000_0000_0000_0000_4000_0000;
const ENTROPY_3: u128 = 0x0000_0000_0000_0000_8000_0000;

/// Route-based IPsec on an SRX, in the set form a `show configuration
/// | display set` produces. Deliberately mixed: statements the dictionary
/// knows, one it does not at all (the routing options), one it only half
/// understands (the policy's `match source-address any` binds, its
/// `match application any` does not — `SecurityPolicy` has no
/// `match_any_application` field, see `corpus/dict/junos-srx/security-policies.yaml`),
/// and one pre-shared key, which must never survive the call.
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
set security policies from-zone trust to-zone vpn policy allow match application any
";

/// The wire frame. 25 bytes of prefix since 2026-08-21: the clock, the
/// entropy, and one CONFIRM byte. `0` is "refuse if this names a device the
/// design already holds"; `1` is the operator having said they are different
/// boxes. Every existing test sends `0`, which is the behaviour they were
/// written against — a first paste into an empty estate cannot clash.
fn frame(at: u64, entropy: u128, text: &str) -> Vec<u8> {
    frame_confirmed(at, entropy, text, false)
}

fn frame_confirmed(at: u64, entropy: u128, text: &str, confirm: bool) -> Vec<u8> {
    let mut f = Vec::with_capacity(25 + text.len());
    f.extend_from_slice(&at.to_le_bytes());
    f.extend_from_slice(&entropy.to_le_bytes());
    f.push(u8::from(confirm));
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
    let mut shell = common::booted_shell();
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
/// is *named*, not dropped. The routing statement is entirely outside the
/// dictionary; the `match application any` policy line is only PARTIALLY
/// understood (the policy it names is real, its application match is not) —
/// both must still be visible as residue.
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
        "the policy's unmodelled `match application` tail must be named: {text:?}"
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
    // Two chrome records to skip: the header and `FACE_INV_KEY`.
    let cells: Vec<String> = devices
        .iter()
        .skip(2)
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
    let mut a = common::booted_shell();
    let mut b = common::booted_shell();
    let f = frame(TS, ENTROPY, PASTE);
    assert_eq!(a.handle(OP_PASTE, &f), b.handle(OP_PASTE, &f));

    // And a different clock changes it, which is what proves the first
    // assertion is about determinism rather than about a constant.
    let mut c = common::booted_shell();
    assert_ne!(
        a.handle(OP_PASTE, &f),
        c.handle(OP_PASTE, &frame(TS + 1, ENTROPY, PASTE))
    );
}

#[test]
fn a_short_frame_is_refused_by_code() {
    let mut shell = common::booted_shell();
    // 24 bytes was a COMPLETE frame until 2026-08-21 and is a short one now,
    // which is the sharper probe: it is the length the previous protocol
    // accepted, so it catches a module that quietly kept reading the old shape.
    let e = error(&shell.handle(OP_PASTE, &[0u8; 24]));
    assert_eq!(e.code, ERR_PASTE_FRAME);
    assert!(e.detail.contains("25"), "{}", e.detail);
}

#[test]
fn a_paste_that_is_not_utf8_is_refused_by_code() {
    let mut shell = common::booted_shell();
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

/// `skip(2)`, not `skip(1)`: an inventory reply opens with the header AND the
/// editable-column key row (`FACE_INV_KEY`), and neither is a device.
fn devices(shell: &mut Shell) -> Vec<[String; 8]> {
    face(&shell.handle(OP_INV_ROWS, &[kind_byte(InvKind::Device)]))
        .into_iter()
        .skip(2)
        .map(|r| r.strings)
        .collect()
}

fn loaded_with_good() -> Shell {
    let mut shell = common::booted_shell();
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
        let mut shell = common::booted_shell();
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
    let mut shell = common::booted_shell();
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
    let mut shell = common::booted_shell();
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
    let mut shell = common::booted_shell();
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
    let mut shell = common::booted_shell();
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
        assert!(rows.len() > 2, "{what} has no rows at kind byte {byte}");

        // Two chrome records to skip: the header and `FACE_INV_KEY`.
        let cells: Vec<String> = rows
            .iter()
            .skip(2)
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

// ---------------------------------------------------------------------------
// The second grammar. Same opcode, same shell, a table instead of a line
// grammar — added 2026-08-15 with the OPNsense firewall-rules CSV.
// ---------------------------------------------------------------------------

/// A four-rule export, REDUCED — eleven of the fifty columns, chosen as the ones
/// that carry values plus the ones that must land on the residue list. It is not
/// a verbatim export and is not described as one; the full 50-column file is
/// `crates/fathom-ingest/tests/fixtures/opnsense-rules-export.csv`, which is
/// what the browser driver pastes.
///
/// The VALUES are the exporter's, even though the column set is not.
/// `list_legacy_rules.php` starts `$sequence` at 1 and adds 10 per rule, and
/// defaults an unset `protocol` to `any` rather than leaving it empty (source
/// read 2026-08-16). A reduced fixture may carry fewer columns than the vendor
/// writes; it may not carry values the vendor never writes, or the assertions
/// beneath it are about a file that does not exist.
const RULES_CSV: &str = "\
@uuid;enabled;sequence;action;interface;direction;protocol;description;source_net;destination_net;destination_port
8f1d0d3e-1c6a-4a4e-9a2f-19f7b0c6d4a1;1;1;pass;lan;in;any;Default allow LAN to any;lan;any;
b3a55e21-77f2-4c19-8de1-2f0c4b9a7e55;1;11;block;wan;in;TCP;Block inbound RDP;any;192.168.1.0/24;3389
2c772765-4c1e-4c61-9f34-0b7926bbf8db;0;21;pass;opt2;in;any;Disabled Plex rule;192.168.210.0/24;any;
d40b7c98-5e33-41aa-b0c7-6a2e1f8d9c07;1;31;reject;lan;out;UDP;Reject v6 DNS;any;any;53
";

fn pasted_csv() -> (Shell, Vec<FaceRowView>) {
    let mut shell = common::booted_shell();
    let rows = face(&shell.handle(OP_PASTE, &frame(TS, ENTROPY, RULES_CSV)));
    (shell, rows)
}

/// The dictionary is chosen from the text, and the platform the estate is
/// stamped with is the one that actually read it — never a default.
#[test]
fn a_rules_csv_is_read_as_opnsense() {
    let (_shell, rows) = pasted_csv();
    let head = summary(&rows);
    assert_eq!(head.strings[7], "opnsense");
    // 1 Device + 1 PolicySet + 4 SecurityPolicy.
    assert_eq!(count(&rows, 0), 6);
    assert_eq!(count(&rows, 3), 0, "a rules export carries no credential");
}

/// The junos path is untouched by the sniff, and both dictionaries can be used
/// by one shell in one session without either standing in for the other.
#[test]
fn one_shell_reads_both_grammars() {
    let mut shell = common::booted_shell();
    // EACH PASTE GETS ITS OWN ENTROPY, because a real host draws fresh bytes
    // per call and the batch id is derived from them. This test sent one value
    // three times, which was harmless while a paste REPLACED the estate — the
    // graph it collided with was thrown away every time — and is a genuine
    // replay of one paste now that pastes accumulate.
    let junos = face(&shell.handle(OP_PASTE, &frame(TS, ENTROPY, PASTE)));
    assert_eq!(summary(&junos).strings[7], "junos-srx");
    let csv = face(&shell.handle(OP_PASTE, &frame(TS, ENTROPY_2, RULES_CSV)));
    assert_eq!(summary(&csv).strings[7], "opnsense");
    // THE THIRD PASTE IS THE SAME JUNOS CONFIG AGAIN, and as of 2026-08-21
    // that is a QUESTION rather than a silent replacement. This test passed
    // before only because the estate was being destroyed and rebuilt each
    // time — it was reading amnesia as if it were a re-read.
    let refused = error(&shell.handle(OP_PASTE, &frame(TS, ENTROPY, PASTE)));
    assert_eq!(
        refused.code, ERR_PASTE_CHOICE,
        "re-pasting a box the design already holds must ask, not overwrite: {}",
        refused.detail
    );

    // Confirmed, it welds as a second device — which is the honest outcome
    // when a person says these are different boxes that happen to match.
    // FRESH ENTROPY, because a real host supplies fresh entropy on every call
    // and the batch id is derived from it. Re-sending the identical frame is a
    // replay of one paste, not a second paste, and the store is right to refuse
    // it — which is what an earlier draft of this test discovered the hard way.
    let again = face(&shell.handle(OP_PASTE, &frame_confirmed(TS, ENTROPY_3, PASTE, true)));
    assert_eq!(summary(&again).strings[7], "junos-srx");
}

/// The rules reach a face. A parser whose output no view can show is a parser
/// nobody can check — which is exactly how `RoutingProtocol` sat empty.
#[test]
fn the_rules_appear_in_the_inventory() {
    let (mut shell, _) = pasted_csv();
    let byte = u8::try_from(
        InvKind::ALL
            .iter()
            .position(|k| *k == InvKind::SecurityPolicy)
            .expect("SecurityPolicy is a row set"),
    )
    .expect("fewer than 256 kinds");
    let rows = face(&shell.handle(OP_INV_ROWS, &[byte]));
    assert_eq!(rows[0].role, FACE_HEADER);
    assert_eq!(rows.len(), 6, "a header, the column keys, and four rules");

    let cells: Vec<Vec<String>> = rows
        .iter()
        .skip(2)
        .map(|r| r.strings[1..7].to_vec())
        .collect();
    let by_ordinal = |n: &str| {
        cells
            .iter()
            .find(|c| c[0] == n)
            .unwrap_or_else(|| panic!("no rule at ordinal {n}"))
    };
    assert_eq!(by_ordinal("1")[1], "permit");
    assert_eq!(
        by_ordinal("11")[1],
        "deny",
        "OPNsense `block` is Junos `deny`"
    );
    assert_eq!(by_ordinal("31")[1], "reject");
    // The one that matters: issue #10595 is about disabled rules disappearing.
    assert_eq!(by_ordinal("21")[2], "false");
    assert_eq!(by_ordinal("1")[2], "true");
    assert_eq!(
        by_ordinal("11")[3],
        "true",
        "source_net is the literal `any`"
    );
    assert_eq!(
        by_ordinal("1")[3],
        "—",
        "source_net is `lan`; nothing may be claimed about it"
    );
}

/// Residue at cell granularity: the matches the IR cannot hold are named with
/// their own bytes, not swallowed by a row that bound something else.
#[test]
fn the_cells_the_ir_cannot_hold_are_named() {
    let (_shell, rows) = pasted_csv();
    let residue: Vec<&FaceRowView> = rows.iter().filter(|r| r.role == FACE_RESIDUE).collect();
    let text: Vec<&str> = residue.iter().map(|r| r.strings[1].as_str()).collect();
    for wanted in ["192.168.1.0/24", "3389", "TCP", "wan", "in", "53"] {
        assert!(text.contains(&wanted), "`{wanted}` is not named: {text:?}");
    }
    // And nothing that DID bind is on the list twice over.
    assert!(!text.contains(&"Block inbound RDP"));
    assert!(!text.contains(&"reject"));
}

/// An export with a header and no records. Issue #10595's failure mode, refused
/// by name, with the held estate left alone.
#[test]
fn an_empty_export_is_refused_and_changes_nothing() {
    let (mut shell, _) = pasted_csv();
    let before = shell.handle(
        OP_INV_ROWS,
        &[u8::try_from(
            InvKind::ALL
                .iter()
                .position(|k| *k == InvKind::SecurityPolicy)
                .expect("SecurityPolicy is a row set"),
        )
        .expect("fewer than 256 kinds")],
    );
    let e = error(&shell.handle(OP_PASTE, &frame(TS, ENTROPY, "@uuid;enabled;action\n")));
    assert_eq!(e.code, ERR_INGEST_REFUSED);
    // The three things the operator must be told, asserted as three separate
    // claims because each fails differently: whose bug it is, that their
    // firewall is not in fact empty, and where the rules still are. A message
    // that named the issue but let "0 rules" stand as a statement about the
    // firewall would pass a `contains("10595")` check and still be the failure
    // this refusal exists to prevent.
    assert!(e.detail.contains("10595"), "{}", e.detail);
    assert!(
        e.detail
            .contains("DOES NOT MEAN YOUR FIREWALL HAS NO RULES"),
        "{}",
        e.detail
    );
    assert!(e.detail.contains("/conf/config.xml"), "{}", e.detail);
    assert!(e.detail.contains("not one rule under them"), "{}", e.detail);
    let after = shell.handle(
        OP_INV_ROWS,
        &[u8::try_from(
            InvKind::ALL
                .iter()
                .position(|k| *k == InvKind::SecurityPolicy)
                .expect("SecurityPolicy is a row set"),
        )
        .expect("fewer than 256 kinds")],
    );
    assert_eq!(before, after, "a refused paste must not disturb the estate");
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

// --- the journal capture (2026-08-15) ----------------------------------------

/// **Invariant 3, at the one boundary where the export file is decided.**
///
/// The page holds the RAW text the operator pasted. If it journalled that, the
/// pre-shared key would go into the export file and into whatever folder the
/// operator syncs it to. So the module hands back the text as the redaction gate
/// left it, and this test is the reason that row exists.
#[test]
fn the_capture_row_carries_redacted_text_not_the_secret() {
    let mut shell = common::booted_shell();
    let reply = shell.handle(OP_PASTE, &frame(TS, ENTROPY, PASTE));
    let rows = match decode_reply(&reply) {
        Ok(ReplyView::FaceRows(r)) => r,
        other => panic!("a paste answers with a face table, got {other:?}"),
    };
    let capture = rows
        .iter()
        .find(|r| r.role == fathom_wasm::protocol::FACE_CAPTURE)
        .map(|r| r.strings[0].clone())
        .expect("the paste reply carries the redacted capture");

    assert!(
        !capture.is_empty(),
        "the capture row must carry the whole paste"
    );
    assert!(
        !capture.contains("SuperSecret123"),
        "THE PRE-SHARED KEY SURVIVED INTO THE CAPTURE. Journalling this would \
         write it to the operator's export file. The capture must be the text \
         the redaction gate produced, never the raw paste."
    );
    assert!(
        capture.contains("set security ike gateway gw-hq address 198.51.100.10"),
        "the capture must still carry the lines that are not secret, or replay \
         would rebuild a smaller estate than the paste did"
    );
}

/// Replaying the capture must rebuild the same estate. This is the property the
/// whole journal route rests on: if the redacted text parses to something
/// different, an exported workspace is not the workspace that was exported.
#[test]
fn replaying_the_capture_rebuilds_the_same_estate() {
    let capture = {
        let mut shell = common::booted_shell();
        let reply = shell.handle(OP_PASTE, &frame(TS, ENTROPY, PASTE));
        match decode_reply(&reply) {
            Ok(ReplyView::FaceRows(r)) => r
                .iter()
                .find(|x| x.role == fathom_wasm::protocol::FACE_CAPTURE)
                .map(|x| x.strings[0].clone())
                .expect("capture row"),
            other => panic!("{other:?}"),
        }
    };

    // Same clock, same entropy: the mint is a pure function of both, so the
    // minted ids must match too.
    let original = {
        let mut s = common::booted_shell();
        s.handle(OP_PASTE, &frame(TS, ENTROPY, PASTE));
        s.handle(OP_INV_ROWS, &[0])
    };
    let replayed = {
        let mut s = common::booted_shell();
        s.handle(OP_PASTE, &frame(TS, ENTROPY, &capture));
        s.handle(OP_INV_ROWS, &[0])
    };
    assert_eq!(
        original, replayed,
        "replaying the redacted capture produced a different estate than the \
         original paste did"
    );
}

/// **PASTING A BOX THE DESIGN ALREADY HOLDS IS A QUESTION.**
///
/// `70` §16.3 settled the collision question by deferring it, and named the
/// thing that was standing in for the design: *"Until it is designed,
/// `OP_PASTE` replaces the held estate and says so, which is the behaviour that
/// cannot silently merge two boxes."* Making the paste additive removes that
/// guard, so the proposal has to exist — this asserts it does.
#[test]
fn a_second_reading_of_the_same_box_is_refused_and_named() {
    let mut shell = common::booted_shell();
    let first = shell.handle(OP_PASTE, &frame(TS, ENTROPY, PASTE));
    assert!(
        matches!(decode_reply(&first), Ok(ReplyView::FaceRows(_))),
        "the first paste should succeed: {:?}",
        decode_reply(&first)
    );

    let again = shell.handle(OP_PASTE, &frame(TS, ENTROPY_2, PASTE));
    let e = error(&again);
    assert_eq!(
        e.code, ERR_PASTE_CHOICE,
        "a second reading of the same box must ask, got: {}",
        e.detail
    );
    assert!(
        e.detail.contains("srx-branch-01"),
        "the refusal must name the box it found: {}",
        e.detail
    );
    // The detail is `sentence|display-id|hostname` so the page can offer the
    // answer without re-deriving any of it.
    assert_eq!(
        e.detail.split('|').count(),
        3,
        "the refusal carries the sentence, the id and the name: {}",
        e.detail
    );
}

// --- a hand-drawn box with no platform, and the paste of its real config -----

/// `OP_EQUIP_ADD`'s frame — the 24-byte prefix, then `[u8 count]` and `count`
/// x `[u16 key][u16 len][utf8]` — duplicated from `equip.rs` because
/// integration tests cannot share helpers without a module and `common/` is
/// the dictionary boot, not a frame kit.
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

/// Live device rows in the inventory.
fn device_rows(shell: &mut Shell) -> usize {
    let device = InvKind::ALL
        .iter()
        .position(|k| k.label() == "Device")
        .expect("a Device inventory kind") as u8;
    face(&shell.handle(OP_INV_ROWS, &[device]))
        .iter()
        .filter(|r| r.role == FACE_INV)
        .count()
}

/// Add one box by hand, exactly as the form sends it after 2026-09-05: a
/// hostname, a role, and — when `platform` is `None` — no platform at all.
fn hand_add(shell: &mut Shell, entropy: u128, hostname: &str, platform: Option<&str>) {
    use fathom_ir::generated::ir_types::DeviceField;
    let mut fields = vec![
        (DeviceField::Hostname.key().0, hostname),
        (DeviceField::Role.key().0, "server"),
    ];
    if let Some(p) = platform {
        fields.push((DeviceField::Platform.key().0, p));
    }
    let reply = shell.handle(OP_EQUIP_ADD, &equip_frame(TS, entropy, &fields));
    assert!(
        matches!(decode_reply(&reply), Ok(ReplyView::FaceRows(_))),
        "the hand add was refused: {:?}",
        decode_reply(&reply)
    );
}

/// **THE TRAP THE DOOR OPENED, CLOSED.** A box drawn by hand with no platform
/// — the state `OP_EQUIP_ADD` admits since 2026-09-05 — and then a paste of
/// that box's real config. Term by term the two never matched (`field_text`
/// answers `None` for `Unknown`), so the paste welded a SECOND box beside the
/// first, silently, under a page hint that promised it would ask. It asks.
///
/// Before the fix this test fails at the first assertion: the paste succeeds
/// and the design holds two `srx-branch-01`s.
#[test]
fn a_platform_less_hand_added_box_with_the_pasted_hostname_asks() {
    let mut shell = common::booted_shell();
    hand_add(&mut shell, ENTROPY, "srx-branch-01", None);
    assert_eq!(device_rows(&mut shell), 1);

    let refused = shell.handle(OP_PASTE, &frame(TS, ENTROPY_2, PASTE));
    let e = error(&refused);
    assert_eq!(
        e.code, ERR_PASTE_CHOICE,
        "a paste naming a platform-less box must ask, not weld a second: {}",
        e.detail
    );
    assert!(
        e.detail.contains("srx-branch-01"),
        "the question names the box: {}",
        e.detail
    );
    assert!(
        e.detail
            .contains("the same hostname, and its platform was never filled in"),
        "the question says WHY it exists — which term matched and which was never \
         stated: {}",
        e.detail
    );
    assert_eq!(
        e.detail.split('|').count(),
        3,
        "the detail is still `sentence|display-id|hostname`: {}",
        e.detail
    );
    assert_eq!(device_rows(&mut shell), 1, "a refused paste writes nothing");

    // The one answer that exists still works: these are different boxes.
    let again = face(&shell.handle(OP_PASTE, &frame_confirmed(TS, ENTROPY_3, PASTE, true)));
    assert_eq!(summary(&again).strings[7], "junos-srx");
    assert_eq!(device_rows(&mut shell), 2);
}

/// The question is asked about the box the hostname names, not about every
/// platform-less box in the design. A hand-drawn `proxmox-01` with no platform
/// says nothing about a pasted `srx-branch-01`.
#[test]
fn a_platform_less_box_with_another_hostname_does_not_ask() {
    let mut shell = common::booted_shell();
    hand_add(&mut shell, ENTROPY, "proxmox-01", None);
    let rows = face(&shell.handle(OP_PASTE, &frame(TS, ENTROPY_2, PASTE)));
    assert_eq!(summary(&rows).strings[7], "junos-srx");
    assert_eq!(device_rows(&mut shell), 2, "two boxes, two rows");
}

/// And the rule did not widen: a box whose platform IS stated and differs is a
/// different box, exactly as `schema/schema.yaml`'s identity comment says (*"a
/// `core-01` SRX and a `core-01` Nexus are two boxes"*). Only a platform nobody
/// has filled in is a question.
#[test]
fn a_stated_platform_that_differs_is_still_a_different_box() {
    let mut shell = common::booted_shell();
    hand_add(&mut shell, ENTROPY, "srx-branch-01", Some("panos"));
    let rows = face(&shell.handle(OP_PASTE, &frame(TS, ENTROPY_2, PASTE)));
    assert_eq!(summary(&rows).strings[7], "junos-srx");
    assert_eq!(device_rows(&mut shell), 2);
}

/// The all-equal sentence is unchanged to the character. The 2026-08-21
/// driver reads it by regex, so a wording drift there would pass every driver
/// and still be a different sentence than the one the record cites.
#[test]
fn the_all_equal_question_reads_as_it_did() {
    let mut shell = common::booted_shell();
    hand_add(&mut shell, ENTROPY, "srx-branch-01", Some("junos-srx"));
    let e = error(&shell.handle(OP_PASTE, &frame(TS, ENTROPY_2, PASTE)));
    assert_eq!(e.code, ERR_PASTE_CHOICE);
    assert!(
        e.detail
            .starts_with("srx-branch-01 is already in this design — the same hostname and platform. Fathom will not"),
        "{}",
        e.detail
    );
    assert!(
        !e.detail.contains("never filled in"),
        "an all-equal match must not claim a term was unfilled: {}",
        e.detail
    );
}

/// And two DIFFERENT boxes accumulate, which is the whole point of the change.
#[test]
fn two_different_boxes_both_survive() {
    let mut shell = common::booted_shell();
    shell.handle(OP_PASTE, &frame(TS, ENTROPY, PASTE));
    let second = shell.handle(
        OP_PASTE,
        &frame(TS, ENTROPY_2, "set system host-name srx-branch-99\n"),
    );
    assert!(
        matches!(decode_reply(&second), Ok(ReplyView::FaceRows(_))),
        "a different box must weld: {:?}",
        decode_reply(&second)
    );
    let byte = u8::try_from(
        InvKind::ALL
            .iter()
            .position(|k| *k == InvKind::Device)
            .expect("Device is a row set"),
    )
    .expect("fewer than 256 kinds");
    let rows = face(&shell.handle(OP_INV_ROWS, &[byte]));
    let devices = rows.iter().filter(|r| r.role == FACE_INV).count();
    assert_eq!(
        devices, 2,
        "the first paste must survive the second — this is the defect the \
         change exists to fix"
    );
}

/// **AN ID COLLISION IS REFUSED BEFORE THE ESTATE IS TOUCHED.**
///
/// `apply_new_device` opens its batch first and `fathom-graph` has no
/// rollback, so a collision hit MID-WELD leaves a partial batch in the
/// operator's estate. The pre-flight makes that unreachable: the dry run says
/// exactly which ids the real weld will claim, and every one is asked about,
/// read-only, before anything is written.
///
/// The probe reuses one entropy value for two different boxes — which a real
/// host never does, and which is therefore the exact hostile input the
/// pre-flight exists for.
#[test]
fn an_id_collision_is_refused_with_nothing_written() {
    let mut shell = common::booted_shell();
    let ok = shell.handle(OP_PASTE, &frame(TS, ENTROPY, PASTE));
    assert!(matches!(decode_reply(&ok), Ok(ReplyView::FaceRows(_))));

    // Different hostname (so the identity check passes), SAME entropy (so the
    // minted range overlaps the first paste's exactly).
    let clash = shell.handle(
        OP_PASTE,
        &frame(TS, ENTROPY, "set system host-name srx-clash-99\n"),
    );
    let e = error(&clash);
    assert!(
        e.detail.contains("nothing was added"),
        "the refusal must be the pre-flight's (before writing), not the \
         mid-weld fallback: {}",
        e.detail
    );

    // And nothing WAS added: the estate still holds exactly one device, and
    // the log holds exactly one batch — no partial second batch.
    let g = shell.estate_for_test().expect("an estate");
    assert_eq!(
        g.nodes_of_kind(fathom_ir::generated::ir_types::NodeKind::Device)
            .count(),
        1,
        "a refused paste wrote a device"
    );
    assert_eq!(g.log().len(), 1, "a refused paste left a batch in the log");
}
