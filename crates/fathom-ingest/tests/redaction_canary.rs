//! `14` §9.11's canary proof, in this slice's form.
//!
//! Every secret-bearing position in the fixture holds a distinctive canary.
//! The test serialises the entire `IngestOutput` — capture text, ledger,
//! residue, fragment and drop manifest in one sweep — and asserts the canary
//! appears nowhere. Not *"check the capture"*: the point is to catch the path
//! nobody thought of.

use std::path::{Path, PathBuf};

use fathom_ingest::bind::FragNodeId;
use fathom_ingest::dict::Dictionary;
use fathom_ingest::frame::{LineOutcome, ShapeError};
use fathom_ingest::redact::DetectorSet;
use fathom_ingest::{ingest, IngestOutput};

use fathom_ir::generated::ir_types::NodeKind;

const CANARY: &str = "FATHOMCANARY";

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .nth(2)
        .expect("the crate lives two levels under the repo root")
        .to_path_buf()
}

fn dict() -> Dictionary {
    Dictionary::load(&repo_root()).expect("the shipped dictionary loads")
}

fn fixture_run() -> IngestOutput {
    let text = std::fs::read(
        Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/junos-srx-s0-synthetic.txt"),
    )
    .expect("the fixture is checked in");
    ingest(&text, &dict()).expect("within the caps")
}

#[test]
fn no_canary_survives_anywhere() {
    let out = fixture_run();
    let serialised = format!("{out:?}");
    assert!(
        !serialised.contains(CANARY),
        "a canary survived into the ingest output"
    );
}

#[test]
fn pre_redacted_not_counted_as_drop() {
    let out = fixture_run();
    // The `hexadecimal "<REDACTED>"` line: the user redacted it themselves,
    // so it is recorded, bound, and not reported as a drop (`14` §9.6).
    assert_eq!(out.drops.already_redacted.len(), 1);
    let ordinal = out.drops.already_redacted[0];
    assert!(
        out.drops.entries.iter().all(|e| e.ordinal != ordinal),
        "a user pre-redaction was counted as a drop"
    );
    assert!(out.capture.text().contains("<REDACTED>"));
}

#[test]
fn quarantine_destroys_unshaped_secret_line() {
    let out = fixture_run();
    let (idx, orig_len) = out
        .ledger
        .lines
        .iter()
        .enumerate()
        .find_map(|(i, e)| match e.outcome {
            LineOutcome::Quarantined { orig_len, .. } => Some((i, orig_len)),
            _ => None,
        })
        .expect("the clipped head is quarantined");
    assert!(
        orig_len > 0,
        "the original length is recorded IN SESSION — `14` §9.5 allows that and \
         forbids persisting it"
    );
    let span = out.ledger.lines[idx].span;
    let sketch = &out.capture.text()[span.start as usize..span.end as usize];
    // The shape sketch: the first two tokens were not kept (`ecurity` is not
    // a known dictionary segment), so no character of any token survives.
    //
    // AND NO LENGTH SURVIVES EITHER, as of 2026-08-21. This assertion used to
    // read `<word:7> <word:3> ... <quoted:21>` and that string was the defect:
    // the capture is welded into the workspace, so it persisted the exact byte
    // length of a value the gate had just destroyed. See `redact::sketch`.
    assert_eq!(sketch, "<word> <word> <word> <word> <word> <word> <quoted>");
    for token in ["ecurity", "IKE-POL", "pre-shared-key", "ascii-text", CANARY] {
        assert!(!sketch.contains(token), "`{token}` survived the sketch");
    }
}

/// **A QUARANTINED LINE'S TEXT MUST NOT REACH THE GRAPH.** Invariant 3.
///
/// This is the hole the test above could not see, and the reason it could not
/// is worth stating: it asserts on `out.capture.text()` and nothing else, so a
/// secret that was destroyed in the capture and kept in the FRAGMENT looked
/// identical to one that was destroyed everywhere. `no_canary_survives_anywhere`
/// serialises the whole output, which is the right shape — but the fixture it
/// runs has no quarantined line carrying a bindable field, so it never reached
/// this path either.
///
/// The mechanism: a quarantine `Edit` carries `node: None`, so unlike a value
/// redaction the gate never re-points the tree segment at a marker. The segment
/// still held the original text, and `bind` — which runs after the gate — read
/// it, stored it, and overwrote the line's outcome back to `Bound`.
///
/// **The probe is a value a real device produces**, not one shaped to trip a
/// detector. `64` §7 records that an OPNsense `//system/backup/*` subtree holds
/// sftp and git `privkey` elements containing **plaintext SSH private keys**,
/// and OpenSSH writes those with a `-----BEGIN OPENSSH PRIVATE KEY-----` banner.
/// A Junos `description` is free text and will hold whatever was pasted into it.
/// The body is only 30 characters — well under `base64ish`'s 24-character floor
/// per line but chosen so that if the banner detector were removed, nothing else
/// would carry the test.
#[test]
fn a_quarantined_line_does_not_bind_its_own_text() {
    let key = "-----BEGIN OPENSSH PRIVATE KEY-----FATHOMCANARYb3BlbnNzaA";
    let text = format!("set interfaces ge-0/0/0 description \"{key}\"\n");
    let out = ingest(text.as_bytes(), &dict()).expect("within the caps");

    assert!(
        out.ledger
            .lines
            .iter()
            .any(|l| matches!(l.outcome, LineOutcome::Quarantined { .. })),
        "the PEM banner quarantines the line: {:?}",
        out.ledger.lines
    );
    // The capture was always clean. The fragment was not.
    assert!(!out.capture.text().contains(CANARY));
    assert!(
        !format!("{:?}", out.fragment).contains(CANARY),
        "a quarantined line's text reached the graph: {:?}",
        out.fragment
    );
    // And the whole output, which is the assertion that generalises.
    assert!(!format!("{out:?}").contains(CANARY));
}

#[test]
fn pfs_keys_group_not_redacted() {
    let out = fixture_run();
    // `keys` is in the secret-word list; without `secret_exempt` the field
    // card's own PFS line would lose its DH group (§12 item 2).
    assert!(out
        .capture
        .text()
        .contains("perfect-forward-secrecy keys group14"));
    let bound = out
        .fragment
        .nodes
        .iter()
        .any(|n| n.kind == NodeKind::IpsecPolicy && n.fields.len() == 2);
    assert!(
        bound,
        "IPSEC-POL bound both name and perfect_forward_secrecy"
    );
}

/// §4.6's read-path proof: a bound entry's key capture that trips a
/// value-shape detector never reaches the fragment from pre-redaction text,
/// and the marker it was replaced by is not mistaken for a name.
#[test]
fn redacted_key_never_binds() {
    let out = ingest(
        b"set security ike gateway $9$FATHOMCANARY-F66666 ike-policy IKE-POL\n",
        &dict(),
    )
    .expect("within the caps");
    assert_eq!(
        out.ledger.lines[0].outcome,
        LineOutcome::Unshaped {
            reason: ShapeError::KeyUnparsable
        }
    );
    assert!(
        !out.fragment
            .nodes
            .iter()
            .any(|n| n.kind == NodeKind::IkeGateway),
        "a redacted key minted a node"
    );
    assert_eq!(out.fragment.nodes.len(), 1, "only the root Device");
    assert_eq!(out.fragment.nodes[0].owner, None);
    assert_eq!(out.drops.entries.len(), 1);
    assert!(
        out.drops.entries[0].detectors.0 & DetectorSet::CRYPT_PREFIX != 0,
        "the crypt-prefix detector is what caught it"
    );
    assert!(!format!("{out:?}").contains(CANARY));
    // The line bound nothing, so the ledger names no node.
    assert!(!matches!(
        out.ledger.lines[0].outcome,
        LineOutcome::Bound {
            node: FragNodeId(_),
            ..
        }
    ));
}

/// The hole a partial dictionary entry opened in the leaf-name detector,
/// pinned so it cannot reopen.
///
/// When a statement matched an entry, the leaf-name walk ran over the ENTRY's
/// path. For a `partial: true` entry that stops short of the line, the tail of
/// the line was outside that path — so a secret word appearing only in the
/// tail was invisible to the detector, and the credential after it survived
/// with the entry's own detectors saying nothing about it.
///
/// The shipped `security zones security-zone <z> interfaces <unit>` entry is
/// six segments and `partial`, so the line below matches it, and the walk saw
/// a path ending in `interfaces` rather than the word `secret` one token
/// before the value. The fix unions the raw-line walk in for tokens past the
/// end of the matched entry's path.
///
/// The statement is not valid Junos and is not meant to be: the point is that
/// the gate must not depend on the dictionary having modelled the stanza. The
/// whole class of unmodelled sub-statement is what `14` §9.4's safety net is
/// for, and a dictionary match must not switch it off.
#[test]
fn a_secret_word_in_an_unmodelled_tail_is_still_caught() {
    let line = b"set security zones security-zone Z interfaces ge-0/0/0.0 \
                 vendor-extension secret FATHOMCANARY-TAIL-99999\n";
    let out = ingest(line, &dict()).expect("within the caps");
    let serialised = format!("{out:?}");
    assert!(
        !serialised.contains(CANARY),
        "a credential in an unmodelled tail survived the gate: {serialised}"
    );
    assert!(
        !out.drops.entries.is_empty(),
        "the gate recorded no drop for the tail credential"
    );
    assert!(
        out.drops
            .entries
            .iter()
            .any(|e| e.detectors.0 & DetectorSet::LEAF_NAME != 0),
        "the leaf-name detector is what should have caught it, got {:?}",
        out.drops.entries
    );
}

/// The second half of the same defect, and a straight invariant-3 regression
/// if it reopens: the BASE64 detector was switched off by a dictionary match.
///
/// `gate_statement` had TWO detectors judging a trailing token by the matched
/// ENTRY instead of by the STATEMENT. The leaf-name walk (the test above) was
/// one. The other read `entry.is_none() && base64ish(text)`, so teaching the
/// dictionary ANY prefix of a statement disarmed base64 for the whole line —
/// including the tokens the entry never described.
///
/// The line below is documented Junos. `authentication { … simple-password
/// key ; … }` sits at exactly `[edit protocols ospf area area-id interface
/// interface-name ]`:
/// https://www.juniper.net/documentation/us/en/software/junos/cli-reference/topics/ref/statement/authentication-edit-protocols-ospf.html
/// read 2026-08-15. It is inside the subtree the OSPF entries teach, so the
/// six-segment `… area $a interface $if` entry matches and `authentication`
/// and the key are trailing tokens.
///
/// WHY THIS TEST CAN CATCH IT, WHICH THE ONE IT SITS BESIDE COULD NOT. The
/// leaf-name regression test uses `shared-secret` precisely BECAUSE that word
/// is in `SECRET_WORD_LIST` — which is what makes it blind here.
/// `simple-password` is NOT in that list: `is_secret_word` is whole-string
/// equality after case and underscore folding, `password` is a member and
/// `simple-password` is not. So the leaf-name walk says clean over both
/// `simple-password` and `authentication`, no `secret:` entry catalogues the
/// path, and the ONLY detector that can destroy this value is base64. Revert
/// the `described_by_entry` line in `redact.rs` and this test fails while
/// every other redaction test still passes.
///
/// Measured both ways before it was written: destroyed at baseline `adbb590`
/// (nothing under `protocols` matched, so `entry` was `None` and base64 was
/// armed), stored verbatim once the OSPF entries landed. The widening is what
/// armed the hole; the widening is what has to close it.
#[test]
fn a_base64ish_secret_past_a_matched_entrys_path_is_still_destroyed() {
    // 34 characters, all in base64's alphabet: over `base64ish`'s 24-character
    // floor without padding, so the detector's own shape rule is met.
    let secret = "FATHOMCANARYOSPFsimplepw0123456789";
    assert!(secret.len() >= 24, "the probe must clear the base64 floor");
    let line = format!(
        "set protocols ospf area 0.0.0.0 interface ge-0/0/0.0 \
         authentication simple-password {secret}\n"
    );
    let out = ingest(line.as_bytes(), &dict()).expect("within the caps");
    let serialised = format!("{out:?}");
    assert!(
        !serialised.contains(CANARY),
        "an OSPF plaintext password survived the gate: {serialised}"
    );
    assert!(
        out.drops
            .entries
            .iter()
            .any(|e| e.detectors.0 & DetectorSet::BASE64 != 0),
        "the base64 detector is the only one that can catch this, got {:?}",
        out.drops.entries
    );
}

/// **A LEGAL OSPF simple-password — eight characters — is destroyed.**
///
/// The canary above is honest about its own construction and wrong about the
/// world. It reaches for a 34-character probe *because* `base64ish` needs 24,
/// and it says in as many words that base64 is "the only detector that can
/// catch this". Both statements are true of the code. Neither asks the question
/// that decides whether the gate works: **is a 34-character value one this
/// statement can hold?**
///
/// It is not. Juniper, two independent pages, both read 2026-08-15:
///
/// - <https://www.juniper.net/documentation/us/en/software/junos/ospf/topics/topic-map/configuring-ospf-authentication.html>
///   — *"The simple key can be from 1 through 8 characters and can include
///   ASCII strings."*
/// - <https://www.juniper.net/documentation/us/en/software/junos/ospf/topics/ref/statement/authentication-edit-protocols-ospf.html>
///   — the four authentication forms, with the MD5 bound stated separately at
///   1 to 16 characters.
///
/// So the maximum a real device accepts is a third of the minimum the detector
/// needs, and the test above passes on a value **no Junos box would take**. The
/// hole it was written to close was still open for every value that could
/// actually appear, and it was closed by putting `simple-password` in
/// `SECRET_WORD_LIST` — the name, not the length, being the right instrument
/// for a short secret.
///
/// Found by pasting a plausible key into the shipped artifact in Chromium and
/// reading it back out of the EXPORTED JOURNAL, which is the file an operator
/// would have kept. A Rust test asserts on a function; that asserted on the
/// product.
///
/// This one uses eight characters, so it cannot be satisfied by base64 and it
/// fails the moment `simple-password` leaves the list.
#[test]
fn an_eight_character_ospf_password_is_destroyed_because_of_its_name() {
    let secret = "Fath0m8x";
    assert_eq!(
        secret.len(),
        8,
        "the probe must be a length Junos actually accepts"
    );
    assert!(
        !crate_base64_floor_would_catch(secret),
        "if base64 can catch this the test proves nothing about the name"
    );
    let line = format!(
        "set protocols ospf area 0.0.0.0 interface ge-0/0/0.0 \
         authentication simple-password {secret}\n"
    );
    let out = ingest(line.as_bytes(), &dict()).expect("within the caps");
    let serialised = format!("{out:?}");
    assert!(
        !serialised.contains(secret),
        "a LEGAL OSPF plaintext password survived the gate: {serialised}"
    );
    assert!(
        out.drops
            .entries
            .iter()
            .any(|e| e.detectors.0 & DetectorSet::LEAF_NAME != 0),
        "the leaf-name walk is what must catch a short secret, got {:?}",
        out.drops.entries
    );
}

/// `base64ish` is private, so this restates its floor rather than reaching in.
/// Only the floor matters here: the assertion is that the probe is BELOW it.
fn crate_base64_floor_would_catch(text: &str) -> bool {
    text.trim_end_matches('=').chars().count() >= 24
}

/// The same defect stated as a rule rather than as one line: for every
/// statement the dictionary matches only a PREFIX of, a long opaque argument
/// in the tail is destroyed.
///
/// Three shapes, each under a different matched entry, so the guard is not
/// pinned to OSPF. None of these are statements Fathom models; that is the
/// point — `14` §9.4's safety net exists for the stanza nobody catalogued, and
/// a dictionary match may not switch it off.
#[test]
fn base64ish_tails_are_destroyed_under_every_matched_entry() {
    let probes = [
        // under the OSPF area/interface entry
        "set protocols ospf area 0.0.0.0 interface ge-0/0/0.0 \
         vendor-extension opaque FATHOMCANARYaaaaaaaaaaaaaaaaaaaa",
        // under the BGP group/neighbor entry
        "set protocols bgp group G neighbor 203.0.113.1 \
         vendor-extension opaque FATHOMCANARYbbbbbbbbbbbbbbbbbbbb",
        // under the shipped security-zone interfaces partial entry
        "set security zones security-zone Z interfaces ge-0/0/0.0 \
         vendor-extension opaque FATHOMCANARYcccccccccccccccccccc",
    ];
    for probe in probes {
        let out = ingest(format!("{probe}\n").as_bytes(), &dict()).expect("within the caps");
        let serialised = format!("{out:?}");
        assert!(
            !serialised.contains(CANARY),
            "a long opaque tail argument survived: {probe}"
        );
    }
}

/// **EVERY COMPOUND JUNOS SECRET LEAF NAME, AT A LENGTH THE DEVICE ACCEPTS.**
///
/// The class, not an instance. Three days before this test, the gate's word list
/// was patched with the single word `simple-password` and the class stayed open;
/// six statements below then came back VERBATIM in the exported journal when the
/// shipped artifact was driven in Chromium — the file an operator keeps, on the
/// same screen as the product's own sentence saying secrets are destroyed before
/// anything is stored.
///
/// Junos leaf names are compound. `hello-authentication-key` is not
/// `authentication-key`; `chap-secret` is not `secret`. Whole-string equality
/// misses all of them, and `base64ish`'s 24-character floor cannot help because
/// every value here is 8 to 11 characters, which is what these statements hold.
///
/// EVERY FORM AND EVERY LENGTH BELOW WAS READ OFF JUNIPER'S DOCUMENTATION on
/// 2026-08-15 — rule 0 in CLAUDE.md: a safety gate is tested against what a
/// device accepts, never against what the detector needs.
///
/// The two controls at the end must keep passing: they are the forms the two
/// previous fixes closed, and a regression in either would mean this fix traded
/// one hole for another.
#[test]
fn every_compound_secret_leaf_name_is_destroyed() {
    // (label, statement head, a value of a legal length)
    let cases: &[(&str, &str, &str)] = &[
        (
            "IS-IS hello-authentication-key",
            "set protocols isis interface ge-0/0/2.0 level 2 hello-authentication-key",
            "IsisHel1",
        ),
        (
            "SNMPv3 authentication-password",
            "set snmp v3 usm local-engine user u1 authentication-sha authentication-password",
            "Snmpv3Auth1",
        ),
        (
            "SNMPv3 privacy-password",
            "set snmp v3 usm local-engine user u1 privacy-aes128 privacy-password",
            "Snmpv3Priv1",
        ),
        (
            "access profile chap-secret",
            "set access profile p1 client c1 chap-secret",
            "ChapSec123",
        ),
        (
            "access profile pap-password",
            "set access profile p1 client c1 pap-password",
            "PapPass123",
        ),
        (
            "ppp-options default-chap-secret",
            "set interfaces ge-0/0/0 unit 0 ppp-options chap default-chap-secret",
            "DefChap123",
        ),
        // --- the controls: previously closed holes that must stay closed -----
        (
            "CONTROL: ike pre-shared-key",
            "set security ike policy p1 pre-shared-key ascii-text",
            "Psk12345",
        ),
        (
            "CONTROL: ospf simple-password",
            "set protocols ospf area 0.0.0.0 interface ge-0/0/0.0 authentication simple-password",
            "Fath0m8x",
        ),
    ];

    let mut leaked: Vec<&str> = Vec::new();
    for (label, head, secret) in cases {
        assert!(
            secret.len() < 24,
            "{label}: a probe at or above the base64 floor would pass for the \
             wrong reason — the point is that these values are SHORT"
        );
        let line = format!("{head} {secret}\n");
        let out = ingest(line.as_bytes(), &dict()).expect("within the caps");
        if format!("{out:?}").contains(secret) {
            leaked.push(label);
        }
    }
    assert!(
        leaked.is_empty(),
        "these credentials survived the gate and would reach the operator's \
         exported journal: {leaked:?}"
    );
}

/// A key chain's NAME is not a key, and component matching must not eat it.
///
/// The cost of matching by component is that `authentication-key-chain` contains
/// `key`. The argument there is an ordinary identifier the operator needs —
/// destroying it severs the protocol from its keys while protecting nothing,
/// because the material itself lives under
/// `[edit security authentication-key-chains ... key ...]` where the `key`
/// segment catches it on its own. Checked against Juniper's statement page,
/// 2026-08-15; the exemption list in `dict.rs` carries the URL.
#[test]
fn a_key_chain_name_survives_component_matching() {
    let line = "set protocols bgp group G authentication-key-chain core-chain-1\n";
    let out = ingest(line.as_bytes(), &dict()).expect("within the caps");
    let serialised = format!("{out:?}");
    assert!(
        serialised.contains("core-chain-1"),
        "the key chain's NAME was destroyed; component matching over-reached \
         and the operator lost the link between the protocol and its keys: \
         {serialised}"
    );
}

/// **CAMELCASE AND RUN-TOGETHER CREDENTIAL NAMES, which is how OPNsense writes.**
///
/// The component split sees `-`, `_` and `.`. OPNsense's model tree is camelCase,
/// so it saw nothing: driven through the shipped artifact on 2026-08-16 at values
/// a real box holds, six names reached the exported journal with no name coupling
/// at all. Every one is listed in `64` §7 as a real credential.
///
/// Three are closed by splitting on case boundaries (`httpdPassword`,
/// `TlsDnsApiKey`, `preSharedKey`); two have neither a separator nor a case
/// boundary and are members of the list itself (`privkey`, `basicauthpass`).
///
/// **`mmonitUrl` IS DELIBERATELY NOT HERE AND IS NOT FIXED.** Its credential is
/// in the value — `https://user:pass@host:8443/collector` — and no name rule of
/// any kind can reach it. It is recorded as an open gap in `redact.rs` and in
/// `64` §1.1, because a false claim of protection is worse than a stated hole.
///
/// Values chosen SHORT on purpose: a long one is destroyed by `base64ish` and the
/// test would then pass without the name rule doing anything, which is rule 0's
/// failure mode arriving from the other direction.
#[test]
fn a_camelcase_credential_name_couples_to_its_value() {
    let cases: &[(&str, &str)] = &[
        ("httpdPassword", "M0nitPw12"),
        ("TlsDnsApiKey", "CaddyKey42"),
        ("preSharedKey", "IpsecPsk99"),
        ("privkey", "WgPrivK123"),
        ("basicauthpass", "BasicPw777"),
    ];
    let mut leaked = Vec::new();
    for (name, secret) in cases {
        assert!(
            secret.len() < 24,
            "{name}: the probe must be below the base64 floor"
        );
        // The `key=value` sweep, which is the shape a non-Junos paste arrives in.
        let line = format!("{name}={secret}\n");
        let out = ingest(line.as_bytes(), &dict()).expect("within the caps");
        if format!("{out:?}").contains(secret) {
            leaked.push(*name);
        }
    }
    assert!(
        leaked.is_empty(),
        "these OPNsense credential names still have no coupling to their \
         values: {leaked:?}"
    );
}

/// **EVERY DECLARED SECRET IS CAUGHT TWICE, AND `trap-group` WAS CAUGHT ONCE.**
///
/// The dictionary declares fourteen `secret:` paths and `14` §9.1's fourth
/// structural property makes that set the redaction catalogue. The leaf-name
/// walk is the second net under it, and the two are independent by design: a
/// dictionary that is stale, missing, or — the case that found this — REPLACED
/// by a hand-supplied engine still leaves the names.
///
/// Thirteen of the fourteen had a name on `SECRET_WORD_LIST`. `snmp.trap-group`
/// did not, so its community string had exactly one detector and the shipped
/// dictionary was the whole of its protection. Proved with a canary rather than
/// argued, on 2026-08-17.
///
/// The probe is EIGHT characters on purpose, and the reason is rule 0 in
/// `CLAUDE.md`: a gate is tested against what a device accepts, never against
/// what the detector needs. A 24-character probe would pass on `base64ish`
/// alone and prove nothing about the name — which is exactly how a live
/// credential leak survived four reviews on 2026-08-15.
#[test]
fn an_snmp_trap_group_community_is_destroyed_because_of_its_name() {
    let secret = "Fath0mTG";
    assert_eq!(
        secret.len(),
        8,
        "short enough that only the NAME can catch it"
    );
    assert!(
        !crate_base64_floor_would_catch(secret),
        "if base64 can catch this the test proves nothing about the name"
    );
    let line = format!("set snmp trap-group {secret}\n");
    let out = ingest(line.as_bytes(), &dict()).expect("within the caps");
    let serialised = format!("{out:?}");
    assert!(
        !serialised.contains(secret),
        "an SNMP trap-group community survived the gate: {serialised}"
    );
    assert!(
        out.drops
            .entries
            .iter()
            .any(|e| e.detectors.0 & DetectorSet::LEAF_NAME != 0),
        "the leaf-name walk must be one of the detectors, so the dictionary is \
         not the only thing standing between this value and the store: {:?}",
        out.drops.entries
    );
}

/// **THE GATE MUST NOT EAT THE STATEMENT AFTER THE SECRET.**
///
/// The companion to the canary above, and the defect that one CAUSED. Adding
/// `trap-group` to `SECRET_WORD_LIST` on 2026-08-17 gave the community its
/// second detector — correctly — and simultaneously armed an unbounded sweep
/// that destroyed every remaining token on the line. Nobody saw it for twelve
/// days because the canary above uses `set snmp trap-group NAME` with NOTHING
/// AFTER IT, so the only shape that can show the defect was the one shape not
/// tested.
///
/// **This is the tail half of rule 0.** That rule says to test against what a
/// device accepts rather than what the detector needs, and the canary above
/// obeyed it about the secret's LENGTH while quietly disobeying it about the
/// statement's SHAPE: a real Junos trap-group is configured with `targets`,
/// `categories` and `version` clauses after the name, and a probe with no
/// tail is no more a real statement than a 28-character `simple-password`
/// was a real one.
///
/// Both directions are asserted here, because each alone is satisfiable by
/// breaking the other: the community still dies, AND the destination address
/// still lives.
///
/// The statement form is Juniper's own, from the `trap-group` configuration
/// statement page (juniper.net, Junos OS CLI reference, read 2026-08-29 while
/// investigating this defect): the group takes `targets <address>`,
/// `categories <category...>` and `version <v1|v2|all>` beneath its name.
#[test]
fn the_gate_destroys_the_trap_community_and_not_the_trap_destination() {
    let secret = "Fath0mTG";
    let target = "192.0.2.20";
    // A full statement, in the form Juniper documents — not a probe trimmed to
    // the one token under test.
    let line = format!(
        "set snmp trap-group {secret} targets {target} categories link routing version v2\n"
    );
    let out = ingest(line.as_bytes(), &dict()).expect("within the caps");
    let serialised = format!("{out:?}");

    // 1. The secret still dies. This half must never be traded for the other.
    assert!(
        !serialised.contains(secret),
        "the trap-group community survived: {serialised}"
    );

    // 2. And the network survives. The trap DESTINATION is an address the
    //    estate exists to record — `38` §14.4: the secrets are 2% of the file,
    //    the other 98% is the network. Destroying it is not erring toward
    //    safety, it is erring toward an estate that has lost what it is for.
    assert!(
        out.capture.text().contains(target),
        "the trap destination address was destroyed with the community — the \
         unbounded tail sweep is back. Capture: {:?}",
        out.capture.text()
    );

    // 3. The bound, stated as a number rather than left to the two assertions
    //    above to imply. Before the 2026-08-29 fix this line produced SIX drop
    //    entries: the community plus every one of the five trailing tokens.
    //    `targets` still goes, and that is `raw_walk`'s deliberate two-token
    //    proximity window rather than this defect — it sits immediately after
    //    the literal `trap-group`. Nothing beyond it may.
    let destroyed = out.drops.entries.len();
    assert!(
        destroyed <= 2,
        "the gate destroyed {destroyed} tokens on one trap-group line; only the \
         community and the keyword adjacent to `trap-group` may go: {:?}",
        out.drops.entries
    );

    // 4. Length is not a proxy for distance: a LONGER tail must not destroy
    //    more. This is the assertion that actually pins "unbounded" as fixed,
    //    because a fix that merely capped the sweep at five would pass 3.
    let longer = format!(
        "set snmp trap-group {secret} targets {target} categories link routing \
         authentication chassis configuration remote-operations rmon-alarm \
         services startup vrrp version v2\n"
    );
    let out2 = ingest(longer.as_bytes(), &dict()).expect("within the caps");
    assert_eq!(
        out2.drops.entries.len(),
        destroyed,
        "a longer tail on the same statement destroyed more tokens, so the \
         sweep is still growing with the line: {:?}",
        out2.drops.entries
    );
    assert!(
        !format!("{out2:?}").contains(secret),
        "the community survived on the longer form"
    );
}

/// **THE SKETCH MUST NOT PUBLISH THE LENGTH OF WHAT THE GATE DESTROYED.**
///
/// Found 2026-08-21 by an adversarial review of the parse-server designs in
/// `38` §14, and it had been shipping since the sketch was written.
///
/// `sketch` emitted `<word:{len}>` where `len` was the token's exact byte
/// length. A quarantined line is by construction one the gate believes carries
/// a secret, so `set snmp community <word:12>` published the exact length of
/// that community string — and with `head_safe` keeping the first two tokens
/// verbatim, the reader got the statement's identity beside it.
///
/// It is not a theoretical leak. The capture is welded into the workspace as
/// `Origin::Parsed` provenance, so the number was written to the operator's own
/// disk — while `RedactionEntry::orig_len`, declared fifty lines above `sketch`
/// in the same file, carries `14` §9.5's rule that this exact quantity *"must
/// not be stored"*. First-party code was breaking a first-party rule, in one
/// file, in two places, for months.
///
/// This test is the guard. It uses secrets of THREE DIFFERENT LENGTHS in the
/// same shape of statement and asserts the three sketches are **byte-identical**
/// — which is the property that matters, and one no assertion on a fixed string
/// can express. A bucketed length would fail this too, deliberately: a bucket is
/// an oracle with fewer bits, not the absence of one.
#[test]
fn the_sketch_reveals_nothing_about_how_long_the_secret_was() {
    // Three lengths spanning the range a real key takes: an 8-character Junos
    // OSPF maximum, a 24-character passphrase, and a 63-character one — the
    // WPA2 pre-shared-key maximum, which is why 63 is a length worth probing.
    //
    // EVERY PROBE HAS VARIED CHARACTERS, and that is not decoration. A first
    // draft used `"F".repeat(63)` and the gate did not destroy it — correctly.
    // `pre_redacted` treats a value of two or fewer distinct characters as a
    // mask the operator typed themselves, which is what `xxxxxxxx` and
    // `********` are. Sixty-three identical characters is a mask, not a
    // secret, and a test that used one would be asserting against a value no
    // person would ever set — the exact defect rule 0 in `CLAUDE.md` exists to
    // prevent, arrived at from the opposite direction.
    let sketches: Vec<String> = [
        "Fath0m8x",
        "Fa7h0m-Pr3Sh4r3d-K3y-24c",
        "Fa7h0m-Pr3Sh4r3d-K3y-Th4t-Runs-To-Th3-WPA2-M4x1mum-0f-63-ch4rs",
    ]
    .iter()
    .map(|secret| {
        // NO `set` PREFIX, AND THAT ONE WORD IS THE WHOLE TEST. With it, the
        // line SHAPES as a statement and the raw pre-shared-key detector
        // destroys the value per-token (`<REDACTED:unknown>`) — a path that
        // was already length-blind, so a first version of this test passed
        // WITH THE DEFECT REINTRODUCED, proved by revert during the
        // 2026-08-28 review. Without `set` the line is unshaped — the clipped
        // head a real terminal paste produces, the same shape the fixture's
        // quarantined line has — and goes to `sketch`, the function this test
        // exists to guard. The assertion below the map pins that we actually
        // arrived there, so the probe cannot silently drift back onto the
        // other path.
        let line = format!("ecurity ike policy IKE-POL pre-shared-key ascii-text \"{secret}\"\n");
        let out = ingest(line.as_bytes(), &dict()).expect("within the caps");
        let text = out.capture.text().to_string();
        assert!(
            !text.contains(&secret[..]),
            "the secret itself survived: {text}"
        );
        assert!(
            text.contains("<word") && text.contains("<quoted"),
            "the probe no longer reaches the sketch path, so this test is \
             guarding nothing: {text}"
        );
        text
    })
    .collect();

    assert_eq!(
        sketches[0], sketches[1],
        "an 8-character secret and a 24-character secret produced different \
         sketches, so the sketch is a length oracle:\n  {}\n  {}",
        sketches[0], sketches[1]
    );
    assert_eq!(
        sketches[1], sketches[2],
        "a 24-character secret and a 63-character secret produced different \
         sketches, so the sketch is a length oracle:\n  {}\n  {}",
        sketches[1], sketches[2]
    );
    // AND NO MARKER ANYWHERE CARRIES A NUMBER. This is deliberately stated
    // over the whole capture rather than over the sketch, because the gate has
    // two ways to destroy a value and this line takes the one that was NOT
    // changed today: `<REDACTED:unknown>` per token, rather than a whole-line
    // sketch. Both must be length-blind, and asserting over the output rather
    // than over the path means a future third mechanism is covered too.
    //
    // The colon itself is legal — `<REDACTED:unknown>` uses one to carry the
    // label, which is a closed set of six words and reveals nothing. What must
    // never appear is a DIGIT in a marker.
    for text in &sketches {
        for marker in text.split('<').skip(1) {
            let marker = marker.split('>').next().unwrap_or_default();
            assert!(
                !marker.chars().any(|c| c.is_ascii_digit()),
                "a marker carries a number, which is a bound on the value it \
                 replaced: `<{marker}>` in `{text}`"
            );
        }
    }
}

/// The same property, on the OTHER destruction path — the whole-line shape
/// sketch, which is the one that carried the defect.
///
/// `quarantine_destroys_unshaped_secret_line` pins the sketch's exact text for
/// one fixture line. This asserts the property that text was an instance of,
/// so that a future change which alters the sketch's vocabulary cannot quietly
/// reintroduce a length while still looking correct.
#[test]
fn the_shape_sketch_carries_no_numbers() {
    let out = fixture_run();
    let quarantined: Vec<_> = out
        .ledger
        .lines
        .iter()
        .filter(|e| matches!(e.outcome, LineOutcome::Quarantined { .. }))
        .collect();
    assert!(
        !quarantined.is_empty(),
        "the fixture no longer quarantines anything, so this test is vacuous"
    );
    for line in quarantined {
        let sketch = &out.capture.text()[line.span.start as usize..line.span.end as usize];
        for marker in sketch.split('<').skip(1) {
            let marker = marker.split('>').next().unwrap_or_default();
            assert!(
                !marker.chars().any(|c| c.is_ascii_digit()),
                "the shape sketch published a length: `<{marker}>` in `{sketch}`"
            );
        }
    }
}
