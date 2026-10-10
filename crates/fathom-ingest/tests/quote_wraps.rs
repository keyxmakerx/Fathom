//! #104: secrets that leaked past the gate through broken or wrapped quoting.
//!
//! Each paste is driven through every set-form dictionary, by `ingest` (the paste box)
//! and by `redact_only` (the note box), and also through every dictionary in turn the
//! way `OP_REDACT_TEXT` chains them, since the order of those passes was item 3's leak.
//!
//! CLAUDE.md rule 2: the values are a hand-typed passphrase split as a terminal or an
//! editor would split it, not detector-shaped strings. No piece trips a shape detector
//! on its own, so only the gate's handling of the quoting can catch it.
//!
//! How EdgeOS `show configuration commands` prints a value holding `'` or `\` is NOT
//! established (item 6). Searched 2026-10-10: VyOS, EdgeOS's sibling Vyatta fork,
//! refuses `'` in a value at `set` time ("Cannot use the single quote (') character in
//! a value string", https://vyos.dev/T1001); no EdgeOS source was found. These tests
//! therefore assert destruction whatever the quoting means, which holds either way.

use std::path::{Path, PathBuf};

use fathom_ingest::dict::Dictionary;

const PLATFORMS: [&str; 4] = ["edgeos", "junos-ex", "junos-srx", "linux-host"];

fn dicts() -> Vec<Dictionary> {
    let root: PathBuf = Path::new(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .nth(2)
        .expect("the crate lives two levels under the repo root")
        .to_path_buf();
    PLATFORMS
        .iter()
        .map(|p| Dictionary::load_platform(&root, p).expect("ships"))
        .collect()
}

/// Asserts no word of `secret` survives any door.
fn assert_gone(paste: &str, secret: &[&str]) {
    let dicts = dicts();
    let mut outputs = Vec::new();
    for (name, d) in PLATFORMS.iter().zip(&dicts) {
        let a = fathom_ingest::ingest(paste.as_bytes(), d).expect("within the caps");
        outputs.push((format!("{name} ingest"), format!("{a:?}")));
        let b = fathom_ingest::redact_only(paste.as_bytes(), d).expect("within the caps");
        outputs.push((format!("{name} redact_only"), b.text.text().to_owned()));
    }
    let mut chained = paste.as_bytes().to_vec();
    for d in &dicts {
        let out = fathom_ingest::redact_only(&chained, d).expect("within the caps");
        chained = out.text.text().as_bytes().to_vec();
    }
    outputs.push((
        "chained note pass".to_owned(),
        String::from_utf8(chained).expect("utf-8"),
    ));
    for (door, text) in outputs {
        for word in secret {
            assert!(!text.contains(word), "`{word}` survived {door}:\n{text}");
        }
    }
}

const HEAD: &str = "set vpn ipsec site-to-site peer 203.0.113.9 authentication pre-shared-secret";

/// Item 1: the tail of a single-quoted value wrapped onto its own line.
#[test]
fn wrapped_tail_after_single_quote() {
    assert_gone(
        &format!("{HEAD} 'Correct-Horse\nbattery-staple'\nset system host-name gw\n"),
        &["Correct-Horse", "battery-staple"],
    );
}

/// Item 1, double quotes: the tail lexes as a word and then an open quote.
#[test]
fn wrapped_tail_after_double_quote() {
    assert_gone(
        &format!("{HEAD} \"Correct-Horse\nbattery-staple\"\n"),
        &["Correct-Horse", "battery-staple"],
    );
}

/// Item 1, backslash inside the quote: the framer rightly does not join, so the tail
/// lands alone.
#[test]
fn wrapped_tail_after_backslash_in_quote() {
    assert_gone(
        &format!("{HEAD} 'Correct-Horse \\\nbattery-staple'\n"),
        &["Correct-Horse", "battery-staple"],
    );
}

/// Item 1: a value wrapped over three lines loses every line of it.
#[test]
fn wrapped_tail_over_three_lines() {
    assert_gone(
        &format!("{HEAD} 'Correct\nHorse-battery\nstaple-zebra'\n"),
        &["Correct", "Horse-battery", "staple-zebra"],
    );
}

/// The run stops at the next statement: a verb-initial line after the tail binds.
#[test]
fn wrapped_tail_does_not_swallow_the_next_statement() {
    let d = &dicts()[0];
    let out = fathom_ingest::ingest(
        format!("{HEAD} 'Correct-Horse\nbattery-staple'\nset system host-name home-gw-01\n")
            .as_bytes(),
        d,
    )
    .expect("within the caps");
    assert!(out
        .capture
        .text()
        .contains("set system host-name home-gw-01"));
}

/// Item 2: an apostrophe then two or more spaces inside the value.
#[test]
fn apostrophe_then_spaces() {
    assert_gone(
        &format!("{HEAD} 'it's  horse  staple'\n"),
        &["horse", "staple"],
    );
}

/// Item 3: the Junos form with a glued quote, which the note door's EdgeOS pass used
/// to relabel before the Junos pass could see it.
#[test]
fn glued_quote_in_junos_psk() {
    assert_gone(
        "set security ike policy P pre-shared-key ascii-text 'horse'battery staple\n",
        &["horse", "battery", "staple"],
    );
}

/// The tail rule fires only on a line that lost a secret: an ordinary quoted
/// description keeps every word.
#[test]
fn ordinary_apostrophe_is_kept() {
    let d = &dicts()[0];
    let out = fathom_ingest::redact_only(
        b"set interfaces ethernet eth0 description 'Bob's uplink to core'\n",
        d,
    )
    .expect("within the caps");
    assert!(
        out.text.text().contains("uplink to core"),
        "{}",
        out.text.text()
    );
}
