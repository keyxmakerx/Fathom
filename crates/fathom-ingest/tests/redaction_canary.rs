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
    assert!(orig_len > 0, "the original length is recorded");
    let span = out.ledger.lines[idx].span;
    let sketch = &out.capture.text()[span.start as usize..span.end as usize];
    // The shape sketch: the first two tokens were not kept (`ecurity` is not
    // a known dictionary segment), so no character of any token survives.
    assert_eq!(
        sketch,
        "<word:7> <word:3> <word:6> <word:7> <word:14> <word:10> <quoted:21>"
    );
    for token in ["ecurity", "IKE-POL", "pre-shared-key", "ascii-text", CANARY] {
        assert!(!sketch.contains(token), "`{token}` survived the sketch");
    }
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
