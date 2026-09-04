//! `OP_INSIDE` — the zoom ladder's fourth rung, driven through the shell the
//! way the page drives it (`57` §7).
//!
//! The properties these hold, in order of what losing one would cost:
//!
//! 1. **The policy band is in the order the device reads it.** First-match is
//!    the whole semantics of a firewall rule list, and a list shown out of
//!    order is worse than no list because an operator reads the first
//!    matching row and stops.
//! 2. **Nothing says permitted or denied.** `57` §6.3. The reply carries the
//!    stored `action` token and no verdict of any kind; there is no rules
//!    engine and nothing here pretends otherwise.
//! 3. **The zone of an interface is read, never inferred.** It comes from a
//!    live `ZoneMember` edge or it is empty.
//! 4. **A count is a count.** Every number in the head is a count of live
//!    elements the projection walked.
//! 5. **What the schema cannot record comes back empty**, so the page can say
//!    so — rather than coming back with `(no renderer)`, which is a defect
//!    marker aimed at a developer.

mod common;

use fathom_wasm::protocol::{
    decode_reply, FaceRowView, ReplyView, ERR_NOT_INITIALISED, ERR_NO_ELEMENT, FACE_INSIDE,
    FACE_IN_IFACE, FACE_IN_POLICY, FACE_IN_PROTO, FACE_IN_ROUTE, FACE_IN_SET, FACE_IN_TUNNEL,
    FACE_IN_UNIT, FACE_IN_ZONE, FACE_PASTE,
};
use fathom_wasm::shell::Shell;
use fathom_wasm::{OP_INSIDE, OP_PASTE};

const TS: u64 = 1_786_147_200_000;
const ENTROPY: u128 = 0x0000_0000_0000_0000_2026;
const ENTROPY_2: u128 = 0x0000_0000_0000_0000_4000_0000;

/// The same SRX paste `paste.rs` uses, extended with the two statements this
/// rung is about: a second zone member and an OSPF adjacency. Everything in it
/// is a statement `corpus/dict/junos-srx` declares, so it is a config this
/// build genuinely reads rather than a fixture written to make a test pass.
const SRX: &str = "\
set system host-name srx-branch-01
set interfaces ge-0/0/0 unit 0 family inet address 203.0.113.2/30
set interfaces ge-0/0/1 unit 0 family inet address 10.0.0.1/24
set interfaces ge-0/0/1 unit 10 family inet address 10.0.10.1/24
set interfaces ge-0/0/2 description spare
set interfaces st0 unit 0 family inet address 10.255.0.1/30
set security ike proposal ike-prop authentication-method pre-shared-keys
set security ike policy ike-pol proposals ike-prop
set security ike gateway gw-hq ike-policy ike-pol
set security ike gateway gw-hq address 198.51.100.10
set security ipsec proposal ipsec-prop protocol esp
set security ipsec policy ipsec-pol proposals ipsec-prop
set security ipsec vpn hq-vpn ike gateway gw-hq
set security ipsec vpn hq-vpn bind-interface st0.0
set security zones security-zone trust interfaces ge-0/0/1.0
set security zones security-zone untrust interfaces ge-0/0/0.0
set security zones security-zone vpn interfaces st0.0
set protocols ospf area 0.0.0.0 interface ge-0/0/1.0
set protocols ospf area 0.0.0.0 interface ge-0/0/0.0
";

/// A four-rule OPNsense export, reduced the same way `paste.rs` reduces it and
/// with the exporter's own values. **Rule sequences are deliberately NOT in
/// file order relative to their uuids** — the `31` row sits above the `11` row
/// here — so `policies_come_back_in_the_order_the_device_reads_them` is
/// testing a sort and not an accident of insertion.
const RULES_CSV: &str = "\
@uuid;enabled;sequence;action;interface;direction;protocol;description;source_net;destination_net;destination_port
d40b7c98-5e33-41aa-b0c7-6a2e1f8d9c07;1;31;reject;lan;out;UDP;Reject v6 DNS;any;any;53
8f1d0d3e-1c6a-4a4e-9a2f-19f7b0c6d4a1;1;1;pass;lan;in;any;Default allow LAN to any;lan;any;
2c772765-4c1e-4c61-9f34-0b7926bbf8db;0;21;pass;opt2;in;any;Disabled Plex rule;192.168.210.0/24;any;
b3a55e21-77f2-4c19-8de1-2f0c4b9a7e55;1;11;block;wan;in;TCP;Block inbound RDP;any;192.168.1.0/24;3389
";

fn frame(at: u64, entropy: u128, text: &str) -> Vec<u8> {
    let mut f = Vec::with_capacity(25 + text.len());
    f.extend_from_slice(&at.to_le_bytes());
    f.extend_from_slice(&entropy.to_le_bytes());
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

/// Paste, then read back the display id the paste itself reported — the same
/// two steps the page takes, and never a ULID written into this file.
fn pasted(text: &str, entropy: u128) -> (Shell, String) {
    let mut shell = common::booted_shell();
    let rows = face(&shell.handle(OP_PASTE, &frame(TS, entropy, text)));
    let head = rows.first().expect("a paste always summarises itself");
    assert_eq!(head.role, FACE_PASTE);
    let device = head.strings[5].clone();
    assert!(!device.is_empty(), "the paste names the device it built");
    (shell, device)
}

fn inside(shell: &mut Shell, device: &str) -> Vec<FaceRowView> {
    face(&shell.handle(OP_INSIDE, device.as_bytes()))
}

fn rows_of(rows: &[FaceRowView], role: u8) -> Vec<&FaceRowView> {
    rows.iter().filter(|r| r.role == role).collect()
}

fn head(rows: &[FaceRowView]) -> &FaceRowView {
    let h = rows.first().expect("a reply always carries its head");
    assert_eq!(h.role, FACE_INSIDE, "record 0 is the head");
    h
}

/// Slot 7's three space-separated decimals — routing instances, tunnels,
/// unzoned units. See `FACE_INSIDE`.
fn tail(rows: &[FaceRowView]) -> (usize, usize, usize) {
    let t = head(rows).strings[7].clone();
    let parts: Vec<usize> = t
        .split(' ')
        .map(|p| p.parse().unwrap_or_else(|e| panic!("slot 7 is `{t}`: {e}")))
        .collect();
    assert_eq!(parts.len(), 3, "slot 7 carries exactly three counts");
    (parts[0], parts[1], parts[2])
}

// --- the bands ---------------------------------------------------------------

#[test]
fn a_device_comes_apart_into_bands() {
    let (mut shell, device) = pasted(SRX, ENTROPY);
    let rows = inside(&mut shell, &device);
    let h = head(&rows);

    assert_eq!(h.strings[0], device, "the head names what was asked for");
    assert_eq!(
        h.strings[1], "srx-branch-01",
        "the hostname is read off the store, not off the request"
    );

    // Four interfaces: ge-0/0/0, ge-0/0/1, ge-0/0/2 and st0. The third has no
    // unit at all and is still a row — an interface that carries no traffic
    // yet is a fact about the estate.
    assert_eq!(h.strings[2], "4", "interfaces");
    let ifaces = rows_of(&rows, FACE_IN_IFACE);
    assert_eq!(ifaces.len(), 4);
    let names: Vec<&str> = ifaces.iter().map(|r| r.strings[1].as_str()).collect();
    assert_eq!(
        names,
        vec!["ge-0/0/0", "ge-0/0/1", "ge-0/0/2", "st0"],
        "by name, so the picture does not reshuffle when a second paste lands"
    );
    let spare = ifaces
        .iter()
        .find(|r| r.strings[1] == "ge-0/0/2")
        .expect("the description-only interface is a row");
    assert_eq!(spare.strings[3], "0", "and it says it has no unit");

    // Four units: .0 on each of the three that have one, plus ge-0/0/1.10.
    assert_eq!(h.strings[3], "4", "units");
    assert_eq!(rows_of(&rows, FACE_IN_UNIT).len(), 4);

    assert_eq!(h.strings[4], "3", "zones");
    assert_eq!(rows_of(&rows, FACE_IN_ZONE).len(), 3);

    let (routes, tunnels, unzoned) = tail(&rows);
    assert_eq!(tunnels, 1, "hq-vpn");
    assert_eq!(rows_of(&rows, FACE_IN_TUNNEL).len(), 1);
    assert!(routes >= 1, "ospf builds a routing instance to hang off");
    assert_eq!(
        unzoned, 1,
        "ge-0/0/1.10 is in no zone, and that is reported rather than blank"
    );
}

/// Property 3. The zone on a unit is a live `ZoneMember` edge or it is empty.
#[test]
fn a_units_zone_is_read_not_inferred() {
    let (mut shell, device) = pasted(SRX, ENTROPY);
    let rows = inside(&mut shell, &device);
    let units = rows_of(&rows, FACE_IN_UNIT);

    let by_label = |label: &str| -> &FaceRowView {
        units
            .iter()
            .find(|r| r.strings[2] == label)
            .unwrap_or_else(|| panic!("no unit `{label}`"))
    };

    assert_eq!(by_label("ge-0/0/0.0").strings[5], "untrust");
    assert_eq!(by_label("ge-0/0/1.0").strings[5], "trust");
    assert_eq!(by_label("st0.0").strings[5], "vpn");
    // The config never says which zone this one is in, so neither does Fathom.
    let ten = by_label("ge-0/0/1.10");
    assert_eq!(ten.strings[4], "", "no zone id");
    assert_eq!(ten.strings[5], "", "and no zone name invented for it");

    // Every zone a unit names is a zone the band also carries, by id — so the
    // picture cannot draw a line to a box that is not there.
    let zone_ids: Vec<&str> = rows_of(&rows, FACE_IN_ZONE)
        .iter()
        .map(|r| r.strings[0].as_str())
        .collect();
    for u in &units {
        if !u.strings[4].is_empty() {
            assert!(
                zone_ids.contains(&u.strings[4].as_str()),
                "unit {} names zone {} which is in no band row",
                u.strings[2],
                u.strings[4]
            );
        }
    }
}

/// The addresses under a unit, joined by the module and never by the page.
#[test]
fn a_unit_carries_its_addresses() {
    let (mut shell, device) = pasted(SRX, ENTROPY);
    let rows = inside(&mut shell, &device);
    let unit = rows_of(&rows, FACE_IN_UNIT)
        .into_iter()
        .find(|r| r.strings[2] == "ge-0/0/0.0")
        .expect("ge-0/0/0.0");
    assert_eq!(unit.strings[3], "203.0.113.2/30");
}

/// The fourth band pointing back at the first: `st0.0` is not just another
/// unit, and the reader should not have to cross the picture to learn it.
#[test]
fn the_tunnel_names_the_unit_it_binds() {
    let (mut shell, device) = pasted(SRX, ENTROPY);
    let rows = inside(&mut shell, &device);

    let tunnel = rows_of(&rows, FACE_IN_TUNNEL)
        .into_iter()
        .next()
        .expect("hq-vpn");
    assert_eq!(tunnel.strings[1], "hq-vpn");
    assert_eq!(tunnel.strings[2], "st0.0");

    let st0 = rows_of(&rows, FACE_IN_UNIT)
        .into_iter()
        .find(|r| r.strings[2] == "st0.0")
        .expect("st0.0");
    assert_eq!(st0.strings[6], "hq-vpn", "and the unit names it back");
}

/// A protocol's adjacencies are counted, not listed — and the count is of
/// live children rather than of anything the parser reported.
#[test]
fn a_routing_protocol_counts_its_adjacencies() {
    let (mut shell, device) = pasted(SRX, ENTROPY);
    let rows = inside(&mut shell, &device);

    let instances = rows_of(&rows, FACE_IN_ROUTE);
    assert!(!instances.is_empty(), "ospf hangs off a routing instance");
    let protos = rows_of(&rows, FACE_IN_PROTO);
    let ospf = protos
        .iter()
        .find(|r| r.strings[2] == "ospf")
        .expect("the ospf row");
    assert_eq!(
        ospf.strings[3], "2",
        "two `area … interface` statements, two adjacencies"
    );
    // Every protocol names an instance the reply also carries.
    let ids: Vec<&str> = instances.iter().map(|r| r.strings[0].as_str()).collect();
    for p in &protos {
        assert!(ids.contains(&p.strings[1].as_str()));
    }
}

// --- the policy band, which is the whole point -------------------------------

/// **Property 1.** `sequence` 1, 11, 21, 31 — and the rows are in the file in
/// the order 31, 1, 21, 11.
#[test]
fn policies_come_back_in_the_order_the_device_reads_them() {
    let (mut shell, device) = pasted(RULES_CSV, ENTROPY_2);
    let rows = inside(&mut shell, &device);

    assert_eq!(head(&rows).strings[5], "1", "one policy set");
    assert_eq!(head(&rows).strings[6], "4", "four policies");

    let policies = rows_of(&rows, FACE_IN_POLICY);
    let ordinals: Vec<&str> = policies.iter().map(|r| r.strings[2].as_str()).collect();
    assert_eq!(
        ordinals,
        vec!["1", "11", "21", "31"],
        "ascending by ordinal, numerically — `11` sorts before `21` and a \
         string compare would agree here only by luck"
    );

    // And every policy names the set it is in, so the page never has to infer
    // the tree from record order.
    let set = rows_of(&rows, FACE_IN_SET)
        .into_iter()
        .next()
        .expect("the set");
    for p in &policies {
        assert_eq!(p.strings[1], set.strings[0]);
    }
    assert_eq!(set.strings[2], "4", "and the set counts them");
}

/// **Property 2.** The reply carries the stored token and nothing that reads
/// as an opinion. Nothing anywhere in it says permitted, denied, allowed,
/// blocked, safe or risky.
#[test]
fn nothing_in_the_reply_says_permitted_or_denied() {
    let (mut shell, device) = pasted(RULES_CSV, ENTROPY_2);
    let rows = inside(&mut shell, &device);

    let actions: Vec<&str> = rows_of(&rows, FACE_IN_POLICY)
        .iter()
        .map(|r| r.strings[4].as_str())
        .collect();
    assert_eq!(
        actions,
        vec!["permit", "deny", "permit", "reject"],
        "`schema/enums/policy_action.yaml`'s own three tokens, in ordinal order"
    );

    // `permit` and `deny` ARE the schema's tokens for the action a rule
    // declares, so they are legitimate here; the words this view must never
    // produce are the ones that would read as Fathom's judgement of a packet.
    let all: String = rows
        .iter()
        .flat_map(|r| r.strings.iter())
        .cloned()
        .collect::<Vec<_>>()
        .join("\u{1f}")
        .to_lowercase();
    for word in [
        "permitted",
        "denied",
        "allowed",
        "blocked",
        "would match",
        "evaluat",
    ] {
        assert!(
            !all.contains(word),
            "the reply contains `{word}`, which is a verdict this build has no \
             engine to reach (`57` §6.3)"
        );
    }
}

/// A rule is NAMED by the device and DESCRIBED by a person, and the band needs
/// both. OPNsense names every rule by its `@uuid`, so a projection that carried
/// only `name` would hand the page a column of
/// `8f1d0d3e-1c6a-4a4e-9a2f-19f7b0c6d4a1` while `Default allow LAN to any` sat
/// unread in the same row of the same export.
#[test]
fn a_policy_carries_both_its_uuid_and_what_a_person_wrote() {
    let (mut shell, device) = pasted(RULES_CSV, ENTROPY_2);
    let rows = inside(&mut shell, &device);
    let first = rows_of(&rows, FACE_IN_POLICY)
        .into_iter()
        .next()
        .expect("the first policy");
    assert_eq!(first.strings[3], "8f1d0d3e-1c6a-4a4e-9a2f-19f7b0c6d4a1");
    assert_eq!(first.strings[6], "Default allow LAN to any");
}

/// Three states on `enabled`, never two. OPNsense issue #10595 is disabled
/// rules going missing; a build that defaulted an unread flag to enabled would
/// repeat it with worse consequences.
#[test]
fn a_disabled_rule_says_so_and_is_still_a_row() {
    let (mut shell, device) = pasted(RULES_CSV, ENTROPY_2);
    let rows = inside(&mut shell, &device);
    let policies = rows_of(&rows, FACE_IN_POLICY);
    assert_eq!(policies.len(), 4, "the disabled rule is still drawn");
    let off = policies
        .iter()
        .find(|r| r.strings[2] == "21")
        .expect("sequence 21 is the `enabled=0` row");
    assert_eq!(off.strings[5], "0");
    for on in policies.iter().filter(|r| r.strings[2] != "21") {
        assert_eq!(on.strings[5], "1");
    }
}

/// **Property 5, and the honest half of `57` §6.3.**
///
/// `PolicySet.scope` is typed `PolicyScope`, and `fathom_ir::value::PolicyScope`
/// is a unit struct — so a policy set **cannot say which zone pair it
/// governs**, on any platform, in this build. The reply says nothing rather
/// than saying `(no renderer)`, which is a defect marker aimed at a developer
/// reading the inventory and would read to an operator as "Fathom is broken".
///
/// This test is the tripwire on the schema gap: the day `PolicyScope` grows a
/// shape and the projection starts carrying one, this fails and somebody
/// reads the two lines above.
#[test]
fn a_policy_set_cannot_name_the_zone_pair_it_governs() {
    let (mut shell, device) = pasted(RULES_CSV, ENTROPY_2);
    let rows = inside(&mut shell, &device);
    let set = rows_of(&rows, FACE_IN_SET)
        .into_iter()
        .next()
        .expect("the set");
    assert_eq!(
        set.strings[1], "",
        "if this is no longer empty, `PolicyScope` has grown a shape and the \
         page's standing sentence about the missing middle clause is now wrong"
    );
}

/// A junos-srx paste builds zones and no policy set, because
/// `corpus/dict/junos-srx` has no `security policies` entry — the coverage
/// measurement in `66` lists it on the residue. The band is therefore empty on
/// a real SRX config, and the view has to be able to say so.
#[test]
fn an_srx_paste_builds_zones_and_no_policy_set() {
    let (mut shell, device) = pasted(SRX, ENTROPY);
    let rows = inside(&mut shell, &device);
    assert_eq!(head(&rows).strings[4], "3", "three zones");
    assert_eq!(
        head(&rows).strings[5],
        "0",
        "and no policy set — nothing in this build parses `set security policies`"
    );
    assert!(rows_of(&rows, FACE_IN_SET).is_empty());
    assert!(rows_of(&rows, FACE_IN_POLICY).is_empty());
}

// --- the empty states --------------------------------------------------------

#[test]
fn an_unloaded_shell_refuses_rather_than_answering_emptily() {
    let mut shell = Shell::new();
    let reply = shell.handle(OP_INSIDE, b"device:whatever");
    match decode_reply(&reply).expect("a well-formed reply") {
        ReplyView::Error(e) => assert_eq!(e.code, ERR_NOT_INITIALISED),
        other => panic!("expected an error, got {other:?}"),
    }
}

#[test]
fn a_display_id_that_names_nothing_is_an_error() {
    let (mut shell, _) = pasted(SRX, ENTROPY);
    let reply = shell.handle(OP_INSIDE, b"device:not-a-real-ulid");
    match decode_reply(&reply).expect("a well-formed reply") {
        ReplyView::Error(e) => assert_eq!(e.code, ERR_NO_ELEMENT),
        other => panic!("expected an error, got {other:?}"),
    }
}

/// A live element that is not a `Device` is the EMPTY state, not an error —
/// see `Shell::inside`. The page can only descend from a device box, so this
/// is a stale id after a paste rather than a fault, and the remedy is to climb
/// out rather than to show a diagnostic.
#[test]
fn a_live_non_device_comes_back_empty() {
    let (mut shell, device) = pasted(SRX, ENTROPY);
    let rows = inside(&mut shell, &device);
    let zone = rows_of(&rows, FACE_IN_ZONE)
        .into_iter()
        .next()
        .expect("a zone")
        .strings[0]
        .clone();
    let empty = inside(&mut shell, &zone);
    assert!(
        empty.is_empty(),
        "a zone is not a box you can be inside; got {} records",
        empty.len()
    );
}

/// Invariant 9, at the boundary that matters for a picture: two shells fed the
/// same bytes project the same bands, record for record and slot for slot.
#[test]
fn the_same_estate_projects_the_same_bands() {
    let (mut a, da) = pasted(SRX, ENTROPY);
    let (mut b, db) = pasted(SRX, ENTROPY);
    assert_eq!(da, db);
    let ra = inside(&mut a, &da);
    let rb = inside(&mut b, &db);
    assert_eq!(ra.len(), rb.len());
    for (x, y) in ra.iter().zip(rb.iter()) {
        assert_eq!(x.role, y.role);
        assert_eq!(x.strings, y.strings);
    }
}
