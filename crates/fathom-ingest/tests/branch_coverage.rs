//! The bind-rate measurement: what fraction of a realistic SRX branch
//! configuration does the dictionary actually understand, by section?
//!
//! This exists because nobody had the number. `00-ROUTE-TO-WORKABLE.md`
//! counts the dictionary's *entries* (42 statement forms); an entry count says
//! nothing about coverage, because one entry can carry a tenth of a real
//! config and forty can carry none of it. The denominator here is a
//! configuration, not a wish list.
//!
//! # The corpus under measurement
//!
//! `tests/fixtures/junos-srx-branch-documented.txt` is assembled from
//! Juniper's own documented examples. It is **not** a capture of any real
//! device and must never be described as one. Every statement form in it was
//! read off a Juniper page on **2026-08-15** (ADR-0034: the source and the
//! date, never recall):
//!
//! - Guided Setup, *Configure Secure Local Branch Connectivity* — VLANs, IRB
//!   units, `family ethernet-switching vlan members`, zones,
//!   `security policies`, `security nat source`,
//!   `system services dhcp-local-server`, `access address-assignment pool`.
//!   <https://www.juniper.net/documentation/us/en/software/guided-setup/branch-srx-gs/topics/topic-map/step-1-p2-secure_local.html>
//! - Guided Setup, *Configure an IPsec VPN* — the branch-office half: `st0`,
//!   `routing-options static route`, `security ike`, `security ipsec`, the
//!   `trust`→`vpn` policy, the `untrust` zone's `system-services ike`.
//!   <https://www.juniper.net/documentation/us/en/software/guided-setup/branch-srx-gs/topics/topic-map/step-2-p1-add-ipsec-vpn.html>
//! - Day One+ SRX300, *Step 2: Up and Running* — `system host-name`,
//!   `system root-authentication`, `system services ssh root-login`.
//!   <https://www.juniper.net/documentation/us/en/day-one-plus/srx300/id-step-2-up-and-running.html>
//! - CLI Reference statement pages, for the forms the guided setup does not
//!   show: `mtu (Interfaces)`, `vlan-id (VLANs / logical interface)`,
//!   `l3-interface (VLAN)`, `time-zone`, `name-server (System Services)`,
//!   `server (NTP)`, `user (Access)` (`class`, `authentication`),
//!   `application (Applications)`, `static (Routing Options)`,
//!   `link-mode`, `disable (Interfaces)`, `security-zone`,
//!   `host-inbound-traffic`, `screen`, `tcp-rst`, `application-tracking`,
//!   `tcp-mss (Security Flow)`, `address-book`, `community (SNMP)`,
//!   `trap-group (SNMP)`. All under
//!   <https://www.juniper.net/documentation/us/en/software/junos/cli-reference/topics/ref/statement/>
//!
//! Values (addresses, names, hashes) are the documents' own where the
//! document gives one and obviously-fake placeholders where it does not. No
//! statement *form* is invented; invariant 10 and ADR-0034 forbid it, and a
//! measurement taken against invented syntax would measure nothing.
//!
//! # What is counted
//!
//! The denominator is the lines the framer classified as **statements** —
//! `Bound | Unmapped | Unshaped | Quarantined`. Prompt echoes and blanks are
//! excluded because they are not configuration. A line counts as **bound**
//! only on `LineOutcome::Bound`; `Unmapped` (the dictionary has no entry) and
//! `Quarantined` (the gate destroyed the line) are both misses, and
//! quarantine is deliberately a miss — a destroyed credential is correct
//! behaviour and still leaves the operator's statement unmodelled.
//!
//! Run the table with:
//! `cargo test -p fathom-ingest --test branch_coverage -- --nocapture`

use fathom_ingest::dict::Dictionary;
use fathom_ingest::frame::LineOutcome;
use fathom_ingest::{ingest, IngestOutput};

const FIXTURE: &str = include_str!("fixtures/junos-srx-branch-documented.txt");

fn repo_root() -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .nth(2)
        .expect("the crate lives two levels under the repo root")
        .to_path_buf()
}

fn run() -> IngestOutput {
    let dict = Dictionary::load(&repo_root()).expect("the shipped dictionary loads");
    ingest(FIXTURE.as_bytes(), &dict).expect("within the caps")
}

/// Section attribution, longest-prefix-first over the raw `set` line.
///
/// Sections are the operator's mental hierarchy, not the trie's: `security
/// policies` and `security nat` are different jobs even though both hang off
/// `security`. Ordered longest-first so `security ike` never falls into
/// `security`.
const SECTIONS: &[(&str, &str)] = &[
    ("set security address-book ", "security address-book"),
    ("set security policies ", "security policies"),
    ("set security nat ", "security nat"),
    ("set security zones ", "security zones"),
    ("set security ike ", "security ike"),
    ("set security ipsec ", "security ipsec"),
    ("set security flow ", "security flow"),
    ("set system services ", "system services"),
    ("set system login ", "system login"),
    ("set system syslog ", "system syslog"),
    ("set system ntp ", "system ntp"),
    ("set system ", "system"),
    ("set interfaces ", "interfaces"),
    ("set vlans ", "vlans"),
    ("set routing-options ", "routing-options"),
    ("set access ", "access"),
    ("set applications ", "applications"),
    ("set snmp ", "snmp"),
];

fn section_of(line: &str) -> &'static str {
    for (prefix, name) in SECTIONS {
        if line.starts_with(prefix) {
            return name;
        }
    }
    "(other)"
}

struct Row {
    name: &'static str,
    bound: usize,
    total: usize,
}

/// (rows in first-appearance order, bound, total)
fn measure(out: &IngestOutput) -> (Vec<Row>, usize, usize) {
    let text = out.capture.text();
    let mut rows: Vec<Row> = Vec::new();
    let (mut bound, mut total) = (0usize, 0usize);
    for entry in &out.ledger.lines {
        let counted = matches!(
            entry.outcome,
            LineOutcome::Bound { .. }
                | LineOutcome::Unmapped { .. }
                | LineOutcome::Unshaped { .. }
                | LineOutcome::Quarantined { .. }
        );
        if !counted {
            continue;
        }
        let (lo, hi) = (entry.span.start as usize, entry.span.end as usize);
        let line = text.get(lo..hi).unwrap_or("");
        let name = section_of(line);
        let is_bound = matches!(entry.outcome, LineOutcome::Bound { .. });
        total += 1;
        if is_bound {
            bound += 1;
        }
        match rows.iter_mut().find(|r| r.name == name) {
            Some(row) => {
                row.total += 1;
                if is_bound {
                    row.bound += 1;
                }
            }
            None => rows.push(Row {
                name,
                bound: usize::from(is_bound),
                total: 1,
            }),
        }
    }
    (rows, bound, total)
}

/// The pinned overall bind rate. A change here is the point of the test: it
/// must be a deliberate edit accompanied by a re-measured number, never a
/// silent drift. Widening the dictionary raises `BOUND`; nothing else may.
///
/// | measured | statements | bound | rate |
/// |---|---|---|---|
/// | 2026-08-15, before (42 entries) | 122 | 29 | 23.8% |
/// | 2026-08-15, after (69 entries)  | 122 | 58 | 47.5% |
///
/// The after-number is two lower than the widening alone produced. Binding
/// the bare `security ike gateway <name>` stanza made `… gateway ike-gw
/// local-identity hostname branch` match a four-segment entry, and reporting
/// that `Bound` would have hidden `local-identity hostname branch` from the
/// residue list. `bind::bind_statement` now calls a partial match residue, so
/// those two lines are counted as the misses they are. A coverage number that
/// went up by lying would be worth less than no number.
const STATEMENTS: usize = 122;
const BOUND: usize = 58;

#[test]
fn branch_configuration_bind_rate_is_pinned() {
    let out = run();
    let (rows, bound, total) = measure(&out);

    println!("\n  section                    bound / statements   rate");
    println!("  ---------------------------------------------------------");
    let mut sorted: Vec<&Row> = rows.iter().collect();
    sorted.sort_by(|a, b| {
        (b.total - b.bound)
            .cmp(&(a.total - a.bound))
            .then(a.name.cmp(b.name))
    });
    for row in sorted {
        println!(
            "  {:<26} {:>5} / {:<10} {:>5.1}%",
            row.name,
            row.bound,
            row.total,
            100.0 * row.bound as f64 / row.total as f64
        );
    }
    println!("  ---------------------------------------------------------");
    println!(
        "  {:<26} {:>5} / {:<10} {:>5.1}%\n",
        "TOTAL",
        bound,
        total,
        100.0 * bound as f64 / total as f64
    );

    assert_eq!(total, STATEMENTS, "the fixture's statement count moved");
    assert_eq!(bound, BOUND, "the bind rate moved: re-measure and re-pin");
}

/// The gate still runs on this fixture. A coverage fixture that quietly
/// stopped exercising redaction would be the worst kind of green test: the
/// two credential-bearing lines here (`root-authentication
/// encrypted-password` and `ike policy … pre-shared-key ascii-text`) are the
/// canaries, and `snmp community` is a third.
#[test]
fn the_gate_still_fires_on_the_branch_fixture() {
    let out = run();
    assert!(
        out.drops.entries.len() >= 3,
        "expected at least three redactions, got {}",
        out.drops.entries.len()
    );
    let text = out.capture.text();
    assert!(!text.contains("EXAMPLEnotArealHash00000"));
    assert!(!text.contains("EXAMPLEnotArealHash11111"));
    assert!(!text.contains("EXAMPLEnotARealKey01234"));
    assert!(!text.contains("EXAMPLE-READ-ONLY-COMMUNITY"));
}
