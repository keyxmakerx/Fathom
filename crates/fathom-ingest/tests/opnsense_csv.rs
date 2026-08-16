//! The OPNsense firewall-rules CSV, end to end through the crate.
//!
//! Three things are under test and they are different things: that a real
//! export becomes real `SecurityPolicy` nodes; that **every cell** of that
//! export is either bound or named on the residue list, which is `14`'s law
//! stated at the granularity a table actually has; and that the redaction gate
//! runs on this path at all.

use std::path::{Path, PathBuf};

use fathom_ingest::bind::BoundValue;
use fathom_ingest::csv::{ingest_csv, looks_like_rules_csv};
use fathom_ingest::dict::Dictionary;
use fathom_ingest::frame::LineOutcome;
use fathom_ir::generated::ir_types::{NodeKind, PolicyAction};
use fathom_ir::scalar;

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .nth(2)
        .expect("the crate lives two levels under the repo root")
        .to_path_buf()
}

fn dict() -> Dictionary {
    Dictionary::load_platform(&repo_root(), "opnsense").expect("the opnsense dictionary loads")
}

fn fixture() -> Vec<u8> {
    std::fs::read(
        Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/opnsense-rules-export.csv"),
    )
    .expect("the fixture is checked in")
}

fn field<'a>(
    out: &'a fathom_ingest::IngestOutput,
    node: usize,
    name: &str,
) -> Option<&'a BoundValue> {
    let key = fathom_ir::generated::ir_types::FIELD_KEYS
        .iter()
        .find(|(n, _)| *n == name)
        .map(|(_, k)| fathom_ir::bag::FieldKey(*k))?;
    out.fragment
        .nodes
        .get(node)?
        .fields
        .iter()
        .find(|f| f.key == key)
        .map(|f| &f.value)
}

/// A second, independent `;`-split with RFC 4180 quoting, written differently
/// from the one under test on purpose: a recount that shares an implementation
/// with the thing it is recounting proves nothing. This one keeps the quotes,
/// because that is what a residue span carries.
fn split(row: &str) -> Vec<String> {
    let mut out = vec![String::new()];
    let mut quoted = false;
    for ch in row.chars() {
        match ch {
            '"' => {
                quoted = !quoted;
                if let Some(last) = out.last_mut() {
                    last.push('"');
                }
            }
            ';' if !quoted => out.push(String::new()),
            other => {
                if let Some(last) = out.last_mut() {
                    last.push(other);
                }
            }
        }
    }
    out
}

fn rule_node(out: &fathom_ingest::IngestOutput, uuid: &str) -> usize {
    let want = BoundValue::Identifier(scalar::Identifier(uuid.to_owned()));
    out.fragment
        .nodes
        .iter()
        .position(|n| {
            n.kind == NodeKind::SecurityPolicy && n.fields.iter().any(|f| f.value == want)
        })
        .unwrap_or_else(|| panic!("no SecurityPolicy named {uuid}"))
}

#[test]
fn the_dictionary_compiles_and_declares_its_platform() {
    let d = dict();
    assert_eq!(d.platform(), "opnsense");
    assert_eq!(d.entry_count(), 6);
}

/// The sniff must never claim a Junos paste. Cheap to check and expensive to
/// get wrong: choosing the wrong dictionary replaces the operator's estate.
#[test]
fn a_junos_paste_is_not_a_table() {
    let junos = std::fs::read(
        Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/junos-srx-s0-synthetic.txt"),
    )
    .expect("the junos fixture is checked in");
    assert!(!looks_like_rules_csv(&junos));
    assert!(looks_like_rules_csv(&fixture()));
}

#[test]
fn four_rules_come_out_of_four_rows() {
    let out = ingest_csv(&fixture(), &dict()).expect("within the caps");

    let policies = out
        .fragment
        .nodes
        .iter()
        .filter(|n| n.kind == NodeKind::SecurityPolicy)
        .count();
    assert_eq!(policies, 4, "one SecurityPolicy per data row");

    // One PolicySet, fieldless — see the dictionary's own comment for why
    // `scope` and `evaluation` are unset rather than invented.
    let sets: Vec<_> = out
        .fragment
        .nodes
        .iter()
        .filter(|n| n.kind == NodeKind::PolicySet)
        .collect();
    assert_eq!(sets.len(), 1);
    assert!(
        sets[0].fields.is_empty(),
        "the PolicySet asserts nothing: PolicyScope is an empty struct and \
         OPNsense's evaluation order has no token in the schema"
    );

    // The pf action vocabulary, mapped through the token map.
    let allow = rule_node(&out, "8f1d0d3e-1c6a-4a4e-9a2f-19f7b0c6d4a1");
    let block = rule_node(&out, "b3a55e21-77f2-4c19-8de1-2f0c4b9a7e55");
    let off = rule_node(&out, "2c772765-4c1e-4c61-9f34-0b7926bbf8db");
    let rej = rule_node(&out, "d40b7c98-5e33-41aa-b0c7-6a2e1f8d9c07");
    assert_eq!(
        field(&out, allow, "SecurityPolicy.action"),
        Some(&BoundValue::PolicyAction(PolicyAction::Permit))
    );
    assert_eq!(
        field(&out, block, "SecurityPolicy.action"),
        Some(&BoundValue::PolicyAction(PolicyAction::Deny))
    );
    assert_eq!(
        field(&out, rej, "SecurityPolicy.action"),
        Some(&BoundValue::PolicyAction(PolicyAction::Reject))
    );

    // The column that matters most. OPNsense issue #10595 reports disabled
    // legacy rules going missing; a rule Fathom showed as live when the file
    // says `0` would repeat that failure with worse consequences.
    assert_eq!(
        field(&out, allow, "SecurityPolicy.enabled"),
        Some(&BoundValue::Bool(true))
    );
    assert_eq!(
        field(&out, off, "SecurityPolicy.enabled"),
        Some(&BoundValue::Bool(false)),
        "the disabled rule must be disabled"
    );

    // 11, not 2. `list_legacy_rules.php` starts `$sequence` at 1 and does
    // `$sequence += 10` per rule (read 2026-08-16), which is the pf convention
    // of leaving room to insert. The fixture used to number 1,2,3,4 — a shape
    // the cited exporter does not emit, in a file whose whole claim is that it
    // is what the cited exporter emits.
    assert_eq!(
        field(&out, block, "SecurityPolicy.ordinal"),
        Some(&BoundValue::U32(11))
    );
    assert_eq!(
        field(&out, block, "SecurityPolicy.description"),
        Some(&BoundValue::Text(scalar::Text(
            "Block inbound RDP".to_owned()
        )))
    );

    // `any` is the one source/destination fact the schema can hold, and the
    // vendor writes it as the literal string. A real network cannot be held at
    // all — see the residue test below.
    assert_eq!(
        field(&out, allow, "SecurityPolicy.match_any_destination"),
        Some(&BoundValue::Bool(true))
    );
    assert_eq!(
        field(&out, allow, "SecurityPolicy.match_any_source"),
        None,
        "source_net is `lan`, not `any` — nothing may be asserted"
    );
    assert_eq!(
        field(&out, block, "SecurityPolicy.match_any_source"),
        Some(&BoundValue::Bool(true))
    );
}

/// A quoted field carrying the delimiter is one of the two things RFC 4180
/// quoting exists for, and the operator's own sentence must survive it whole.
#[test]
fn a_quoted_description_keeps_its_delimiter() {
    let out = ingest_csv(&fixture(), &dict()).expect("within the caps");
    let rej = rule_node(&out, "d40b7c98-5e33-41aa-b0c7-6a2e1f8d9c07");
    assert_eq!(
        field(&out, rej, "SecurityPolicy.description"),
        Some(&BoundValue::Text(scalar::Text(
            "Reject v6 DNS; see change CHG-4471".to_owned()
        )))
    );
}

/// `14`'s law at the granularity a table has.
///
/// On the Junos path a line is bound or it is residue. Here a row of fifty
/// columns can have six understood and four not, and reporting the row as
/// "bound" would be true and useless. So this asserts the strong form: **every
/// non-empty cell of the file is either bound by a dictionary entry or present
/// on the residue list, by byte span**, and the two sets do not overlap.
#[test]
fn every_non_empty_cell_is_bound_or_named() {
    let out = ingest_csv(&fixture(), &dict()).expect("within the caps");
    let text = out.capture.text();

    // Recount the file independently of the parser under test.
    let mut lines = text.split('\n');
    let header: Vec<&str> = lines.next().expect("a header").split(';').collect();
    assert_eq!(header.len(), 50);
    assert_eq!(header[0], "@uuid");

    let mut expected: Vec<String> = Vec::new();
    let mut bound_cells = 0usize;
    // The four columns with a dictionary entry, plus the two `any` literals.
    let bindable = ["enabled", "sequence", "action", "description"];
    for row in lines.filter(|l| !l.is_empty()) {
        for (col, value) in split(row).into_iter().enumerate() {
            if value.is_empty() || col == 0 {
                continue;
            }
            let name = header.get(col).copied().unwrap_or("");
            let is_any_match =
                (name == "source_net" || name == "destination_net") && value == "any";
            if bindable.contains(&name) || is_any_match {
                bound_cells += 1;
            } else {
                expected.push(value);
            }
        }
    }
    assert!(bound_cells > 0 && !expected.is_empty(), "a useful fixture");

    let named: Vec<String> = out
        .residue
        .iter()
        .map(|r| {
            text.get(r.span.start as usize..r.span.end as usize)
                .unwrap_or_default()
                .to_owned()
        })
        .collect();
    assert_eq!(named, expected);

    // Every residue entry names real bytes of the operator's own file, and
    // every one says why.
    for entry in &out.residue {
        let slice = text
            .get(entry.span.start as usize..entry.span.end as usize)
            .expect("a residue span slices the capture");
        assert!(!slice.is_empty(), "an empty residue span teaches nothing");
        assert!(matches!(entry.outcome, LineOutcome::Unmapped { .. }));
    }

    // The header row is neither bound nor residue: it is the line that gave
    // every other line its meaning, and it has its own outcome.
    assert!(matches!(
        out.ledger.lines[0].outcome,
        LineOutcome::Header { columns: 50 }
    ));
    assert!(
        out.residue.iter().all(|r| r.ordinal.0 != 0),
        "the header is not residue"
    );
}

/// The three columns the IR cannot hold, named rather than dropped.
///
/// This is the finding the work order asked to be checked before scoping:
/// `AddressValue`, `L4Spec`, `PolicyScope`, `NatScope` and `NatAction` are
/// still empty structs in `crates/fathom-ir/src/value.rs`, so a rule's source
/// network, destination network and destination port have nowhere to go. They
/// are on the residue list with their own bytes, which is the honest answer.
#[test]
fn the_matches_the_ir_cannot_hold_are_on_the_list() {
    let out = ingest_csv(&fixture(), &dict()).expect("within the caps");
    let text = out.capture.text();
    let named: Vec<&str> = out
        .residue
        .iter()
        .map(|r| {
            text.get(r.span.start as usize..r.span.end as usize)
                .unwrap_or_default()
        })
        .collect();
    for wanted in [
        "192.168.1.0/24", // a destination network — AddressValue is empty
        "192.168.210.0/24",
        "3389", // a destination port — L4Spec is empty
        "53",
        "TCP", // a protocol — L4Spec again
        "wan", // an interface — PolicyScope is empty
        "in",  // a direction — PolicyScope again
    ] {
        assert!(
            named.contains(&wanted),
            "{wanted} is neither bound nor named; residue = {named:?}"
        );
    }
}

/// **The gate runs on this path, and it is not tested against what the
/// detector needs** (CLAUDE.md rule 0).
///
/// A firewall-rules CSV should carry no credential: the fifty columns are rule
/// metadata and the exporter builds every one of them from rule fields
/// (`list_legacy_rules.php`, opnsense/core master, read 2026-08-15). The first
/// assertion below is that claim, checked rather than assumed — a real export
/// produces zero drops, so the gate costs the operator nothing.
///
/// The second is the case that matters. Pasting the wrong OPNsense file into
/// the rules box is a **documented event, not a hypothesis**: issue #9861
/// (25 Feb 2026) records an operator importing a backup configuration into the
/// rules importer and creating roughly 80,000 rules. So the test drives a
/// column named `password` — and the value is **four characters**, shorter than
/// every content detector's floor (24 for base64, 32 for hex, 8 for the mask
/// rule). Nothing about it suits a detector. If it survives, the only thing
/// that could have caught it — the column name — is not wired in.
#[test]
fn the_gate_runs_on_the_table_path() {
    let d = dict();

    let clean = ingest_csv(&fixture(), &d).expect("within the caps");
    assert_eq!(
        clean.drops.entries.len(),
        0,
        "a real rules export carries no credential and must lose nothing"
    );
    assert!(clean.capture.text().contains("Block inbound RDP"));

    let mis_paste = b"@uuid;enabled;password\n\
                      8f1d0d3e-1c6a-4a4e-9a2f-19f7b0c6d4a1;1;abc1\n"
        .to_vec();
    let out = ingest_csv(&mis_paste, &d).expect("within the caps");
    assert!(
        !out.capture.text().contains("abc1"),
        "a four-character value under a column named `password` survived: {}",
        out.capture.text()
    );
    assert_eq!(out.drops.entries.len(), 1);
    assert_eq!(out.drops.entries[0].orig_len, 4);
}

/// **The compound secret-name class, on this path** (rule 0, second pass).
///
/// The canary above drives `password` — the one spelling that is IN
/// `SECRET_WORD_LIST` — so it passed while every compound spelling stayed open.
/// The column names a wrong-file paste carries are not whole-string anything.
/// `64` §7 lists what an OPNsense configuration actually holds: API keys, LDAP
/// bind passwords, RADIUS secrets, `otp_seed`, WireGuard keys, X.509 private
/// keys as bare base64 with no PEM banner.
///
/// **THE COLUMN NAMES ARE THE VENDOR'S, NOT PLAUSIBLE-LOOKING INVENTIONS.**
/// Every one below was read out of `opnsense/core` master on 2026-08-16 —
/// `Auth/LDAP.php`'s `$confMap` (`ldap_binddn`, `ldap_bindpw`),
/// `Auth/Radius.php`'s (`radius_secret`), and the manual's *"OTP seed"* field
/// for `otp_seed`. Inventing a config key would have made this test pass
/// against a spelling no OPNsense box writes, which is rule 0's failure in a
/// different costume.
///
/// **THE VALUES ARE SHORT ON PURPOSE, AND THE BOUND IS LOOKED UP RATHER THAN
/// ASSUMED** (ADR-0034). OPNsense's password length constraint is an OPTIONAL
/// policy, not a floor the product enforces: `docs.opnsense.org/manual/users.html`
/// describes the Local Database's *"Enable password policy constraints"* and
/// *"Minimum password length to require"* as settings an administrator turns on
/// (read 2026-08-16), and `opnsense/core` issue #2390 — *"system: password policy
/// brush-up"*, opened 4 May 2018, closed, milestone 18.7 — records that length
/// was not enforced at login at all and asks for **smaller** configurable
/// minimums (read 2026-08-16). So a six-character account password is a value a
/// real OPNsense box really holds, and no probe here reaches any content
/// detector's floor: 24 characters for base64, 32 for hex, 8 for the mask rule.
///
/// If one survives, the column-name coupling is what failed. Nothing here is
/// shaped to suit a detector; every probe is shaped to defeat all of them.
///
/// Four of the six pass because of the MERGE rather than because of this
/// branch: `dict::is_secret_word` became component-matching at the tip
/// (*"Close the compound-secret-name class — six live credentials were reaching
/// the export"*), and `raw_walk` calls it, so this path inherited the fix the
/// moment the two histories joined. The remaining two are concatenations no
/// component split can reach and are named members of the list — see
/// `SECRET_WORD_LIST`'s own note on what that does and does not close.
#[test]
fn a_compound_credential_column_does_not_survive_the_gate() {
    let d = dict();
    let probes = [
        ("user_password", "hunt3r"),
        ("ipsec_psk", "s3cret"),
        ("radius_secret", "r4d1us"),
        ("ldap_bindpw", "b1ndpw"),
        ("api.key", "ak0091"),
        ("otp_seed", "JBSWY3"),
    ];
    for (column, value) in probes {
        let paste = format!(
            "@uuid;enabled;{column}\n\
             8f1d0d3e-1c6a-4a4e-9a2f-19f7b0c6d4a1;1;{value}\n"
        );
        let out = ingest_csv(paste.as_bytes(), &d).expect("within the caps");
        assert!(
            !out.capture.text().contains(value),
            "`{value}` survived under a column named `{column}`: {}",
            out.capture.text()
        );
        assert!(
            !format!("{:?}", out.fragment).contains(value),
            "`{value}` reached the graph fragment under `{column}`"
        );
        assert_eq!(out.drops.entries.len(), 1, "column `{column}`");
    }
}

/// The other half of rule 0, and the half that is easy to forget: **a gate that
/// destroys a real export is as broken as one that keeps a real secret.**
///
/// Every one of the fifty column names the exporter emits is checked against the
/// compound rule the test above requires. The list is not retyped from memory —
/// it is the fixture's own header, which is byte-identical to the header pasted
/// verbatim in `opnsense/core` #9861 and to the keys
/// `src/opnsense/scripts/filter/list_legacy_rules.php` builds, in order (read
/// 2026-08-16; `64` §1.1 carries both URLs).
///
/// Two of the fifty are near misses worth naming: `tag` and `tagged` are pf
/// PACKET tags, and `token` is on the secret-word list — but `tag` is not
/// `token`, and neither splits into it. `max-src-conn-rate` splits into `max`,
/// `src`, `conn`, `rate`. None of the fifty carries a secret word in any part.
#[test]
fn no_real_column_name_is_read_as_a_credential() {
    let d = dict();
    let raw = fixture();
    let text = String::from_utf8(raw).expect("the fixture is UTF-8");
    let header: Vec<&str> = text
        .lines()
        .next()
        .expect("the fixture has a header")
        .split(';')
        .collect();
    assert_eq!(header.len(), 50, "the real export's column count");

    // One row, one column at a time, with a value that would be destroyed the
    // instant the column name were read as a credential — and kept otherwise.
    for column in &header {
        if *column == "@uuid" {
            continue;
        }
        let paste = format!(
            "@uuid;{column}\n\
             8f1d0d3e-1c6a-4a4e-9a2f-19f7b0c6d4a1;keepme\n"
        );
        let out = ingest_csv(paste.as_bytes(), &d).expect("within the caps");
        assert_eq!(
            out.drops.entries.len(),
            0,
            "column `{column}` of a REAL export was read as a credential and its \
             value destroyed; the operator loses a rule field to a false positive"
        );
        assert!(out.capture.text().contains("keepme"), "column `{column}`");
    }
}

/// **The blocker: a row wider than its header.**
///
/// Both ways of producing one are real. This drives the first — an unquoted `;`
/// inside `description`, which is possible on every free-text cell of every
/// export because `64` §5 records that the writer's quoting rule is established
/// NOWHERE. The row widens by one and every column after the stray delimiter
/// shifts left by one.
///
/// Four things are asserted, and the last is the point:
///
/// 1. The row is refused whole, with its cell count and the header's.
/// 2. Its bytes are on the residue list — the promise the page makes.
/// 3. Its cells reach the gate, at the maximum aggression a line Fathom could
///    not shape already gets. Before the fix a data row entered NO sweep and a
///    secret in an overflow cell survived with `drops = 0`.
/// 4. **Nothing from it is bound.** This is what the old code got wrong in the
///    dangerous direction rather than the lossy one: it bound the cells that
///    happened to pair with a header name, so a row whose columns had all
///    shifted was documented with `source_net` read out of the previous
///    column's slot. A rule that says `any` where the file says a network is a
///    firewall document that is worse than no document.
#[test]
fn a_row_wider_than_its_header_binds_nothing_and_is_named() {
    let d = dict();
    // Header: 4 columns. Row: 5 cells, because the description carries a `;`.
    // Read straight, the row would bind `source_net` = `any` — which is the
    // NEXT column's value, and the exact lie this refusal exists to prevent.
    let paste = b"@uuid;action;description;source_net\n\
                  8f1d0d3e-1c6a-4a4e-9a2f-19f7b0c6d4a1;pass;Reject v6 DNS; see CHG-4471;any\n"
        .to_vec();
    let out = ingest_csv(&paste, &d).expect("within the caps");

    let refused: Vec<&LineOutcome> = out
        .ledger
        .lines
        .iter()
        .map(|l| &l.outcome)
        .filter(|o| matches!(o, LineOutcome::Unshaped { .. }))
        .collect();
    assert_eq!(
        refused,
        vec![&LineOutcome::Unshaped {
            reason: fathom_ingest::frame::ShapeError::RowWidth {
                cells: 5,
                columns: 4
            }
        }],
        "the row is refused by width, and the numbers are said out loud"
    );

    let text = out.capture.text();
    let named: Vec<&str> = out
        .residue
        .iter()
        .map(|r| {
            text.get(r.span.start as usize..r.span.end as usize)
                .unwrap_or_default()
        })
        .collect();
    assert_eq!(named.len(), 1, "the whole row, once: {named:?}");
    assert!(named[0].contains("CHG-4471"), "{named:?}");

    // Nothing bound. Specifically NOT `match_any_source`, which the old code
    // would have set from the shifted `any`.
    assert_eq!(
        out.fragment
            .nodes
            .iter()
            .filter(|n| n.kind == NodeKind::SecurityPolicy)
            .count(),
        0,
        "a row whose column mapping is unknown may not assert a firewall rule"
    );
}

/// The second way to get a width disagreement, and it needs no operator error
/// at all: `list_legacy_rules.php` appends the six `source_*`/`destination_*`
/// keys **conditionally** — `if (!empty($rule[$field]))` — so records genuinely
/// carry different key sets and an assembler taking its header from the first
/// record emits a header NARROWER than later rows (source read 2026-08-16).
///
/// A narrow row is refused on the same terms as a wide one. It would be
/// tempting to bind it, since the conditional keys are appended LAST and the
/// leading columns therefore line up — but that reasoning is an inference about
/// one exporter's key order, and a row that is short because a MIDDLE value was
/// lost looks identical from inside the file.
#[test]
fn a_row_narrower_than_its_header_binds_nothing_and_is_named() {
    let d = dict();
    let paste = b"@uuid;action;enabled;description;source_net;destination_net\n\
                  8f1d0d3e-1c6a-4a4e-9a2f-19f7b0c6d4a1;pass;1\n"
        .to_vec();
    let out = ingest_csv(&paste, &d).expect("within the caps");
    assert!(out.ledger.lines.iter().any(|l| l.outcome
        == LineOutcome::Unshaped {
            reason: fathom_ingest::frame::ShapeError::RowWidth {
                cells: 3,
                columns: 6
            }
        }));
    assert_eq!(out.residue.len(), 1);
    assert_eq!(
        out.fragment
            .nodes
            .iter()
            .filter(|n| n.kind == NodeKind::SecurityPolicy)
            .count(),
        0
    );
}

/// A secret in an overflow cell. The reviewer's case (c), driven directly.
///
/// Before the fix this value was seen by no detector of any kind: it produced
/// no statement, so `gate_statement` never looked at it, and data rows never
/// entered `gate_unshaped`, so the safety net never looked either. `drops` came
/// back `0` and the value sat in the sealed capture verbatim.
///
/// The value is deliberately below every content detector's floor again — six
/// characters — so what catches it is the column-name coupling running over the
/// row at maximum aggression, not a length heuristic.
#[test]
fn a_secret_in_an_overflow_cell_is_destroyed() {
    let d = dict();
    let paste = b"@uuid;action;description\n\
                  8f1d0d3e-1c6a-4a4e-9a2f-19f7b0c6d4a1;pass;note;psk;s3cret\n"
        .to_vec();
    let out = ingest_csv(&paste, &d).expect("within the caps");
    assert!(
        !out.capture.text().contains("s3cret"),
        "an overflow cell's secret survived: {}",
        out.capture.text()
    );
    assert!(
        !out.drops.entries.is_empty(),
        "the overflow cell reached no detector at all"
    );
}

/// The table path's half of the quarantine hole — see
/// `redaction_canary.rs::a_quarantined_line_does_not_bind_its_own_text` for the
/// mechanism and for the proof that it is NOT this front end's bug.
///
/// What this path added was reach. `description` is the one column here that
/// binds free text, and it binds it out of an arbitrary vendor column, so
/// whatever an operator typed into a rule description on a box whose backup was
/// pasted by mistake went straight into `SecurityPolicy.description` while the
/// capture showed `<quoted:NN>` and the ledger said the line was understood.
#[test]
fn a_quarantined_row_binds_nothing() {
    let d = dict();
    let key = "-----BEGIN OPENSSH PRIVATE KEY-----FATHOMCANARYb3BlbnNzaA";
    let paste = format!(
        "@uuid;action;description\n\
         8f1d0d3e-1c6a-4a4e-9a2f-19f7b0c6d4a1;pass;{key}\n"
    );
    let out = ingest_csv(paste.as_bytes(), &d).expect("within the caps");

    assert!(
        out.ledger
            .lines
            .iter()
            .any(|l| matches!(l.outcome, LineOutcome::Quarantined { .. })),
        "{:?}",
        out.ledger.lines
    );
    assert!(!format!("{out:?}").contains("FATHOMCANARY"));
    assert_eq!(
        out.fragment
            .nodes
            .iter()
            .filter(|n| n.kind == NodeKind::SecurityPolicy)
            .count(),
        0,
        "a quarantined row asserts no rule at all — not even the `pass` that \
         was in a different cell, because the row's text is gone and a rule \
         with an action and no identity is not a rule"
    );
}

/// The empty-export refusal. OPNsense issue #10595 (22 July 2026, open and
/// unanswered — state re-established independently on 2026-08-16, see below)
/// reports the Migration assistant writing a 0-byte
/// file while reporting 47 rules found. An empty export and a firewall with no
/// rules are the same file, so Fathom refuses instead of welding a device with
/// no policies.
#[test]
fn a_header_with_no_records_is_refused() {
    let d = dict();
    assert_eq!(
        ingest_csv(b"@uuid;enabled;action\n", &d).err(),
        Some(fathom_ingest::IngestRefusal::EmptyTable { columns: 3 })
    );
    assert_eq!(
        ingest_csv(b"", &d).err(),
        Some(fathom_ingest::IngestRefusal::EmptyTable { columns: 0 })
    );
}

/// Invariant 9, on this path: the same bytes twice produce the same everything.
#[test]
fn the_read_is_deterministic() {
    let d = dict();
    let a = ingest_csv(&fixture(), &d).expect("within the caps");
    let b = ingest_csv(&fixture(), &d).expect("within the caps");
    assert_eq!(a.fragment, b.fragment);
    assert_eq!(a.capture, b.capture);
    assert_eq!(a.drops, b.drops);
    assert_eq!(format!("{a:?}"), format!("{b:?}"));
}

/// The handed-in dictionary reads what the on-disk one reads.
///
/// This test was written against a compiled-in copy, which no longer exists:
/// on the merge with the tip (2026-08-15) the dictionary stopped being
/// `include_str!`'d and started arriving over `OP_DICT` from the page, and this
/// dictionary followed it rather than being the one exception. So the thing
/// under test changed with it — not *"are the embedded bytes the disk's bytes"*,
/// which the compiler used to guarantee and the artifact assembler now guards
/// (`fathom-artifact`'s `tests/artifact.rs`), but *"does the route the browser
/// actually takes read the same"*. `dictionary_from_host` never opens the schema
/// tree, so equal bytes are not by themselves equal behaviour.
#[test]
fn the_handed_in_opnsense_dictionary_reads_what_the_disk_reads() {
    let dir = repo_root().join("corpus").join("dict").join("opnsense");
    let mut paths: Vec<PathBuf> = std::fs::read_dir(&dir)
        .expect("the dictionary directory is checked in")
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.extension().map(|x| x == "yaml").unwrap_or(false))
        .collect();
    paths.sort();
    let sources: Vec<(String, String)> = paths
        .iter()
        .map(|p| {
            (
                p.file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or_default(),
                std::fs::read_to_string(p).unwrap_or_else(|e| panic!("{}: {e}", p.display())),
            )
        })
        .collect();
    let keys = std::fs::read_to_string(repo_root().join("schema").join("field-keys.yaml"))
        .expect("schema/field-keys.yaml is checked in");

    let hosted =
        fathom_ingest::hosted::dictionary_from_host(&sources, "schema/field-keys.yaml", &keys)
            .expect("the handed-in dictionary loads");
    let disk = dict();

    assert_eq!(hosted.platform(), "opnsense");
    assert_eq!(hosted.entry_count(), disk.entry_count());
    let a = ingest_csv(&fixture(), &disk).expect("within the caps");
    let b = ingest_csv(&fixture(), &hosted).expect("within the caps");
    assert_eq!(format!("{a:?}"), format!("{b:?}"));
}
