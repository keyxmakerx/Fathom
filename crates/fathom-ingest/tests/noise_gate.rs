//! Three credential leaks found on 2026-08-10, each reproduced against the
//! shipped code before it was fixed, each pinned here.
//!
//! They share one shape and it is the shape that matters: **the gate did not
//! look**. Not a detector that scored a value wrongly — a value no detector was
//! ever offered. A test suite that only feeds the gate well-formed statements
//! cannot find that class, which is why every case below is deliberately a
//! paste somebody would really make rather than a crafted input.

use std::path::{Path, PathBuf};

use fathom_ingest::dict::Dictionary;
use fathom_ingest::{ingest, IngestOutput};

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .nth(2)
        .expect("the crate lives two levels under the repo root")
        .to_path_buf()
}

fn run(text: &str) -> IngestOutput {
    let dict = Dictionary::load(&repo_root()).expect("the shipped dictionary loads");
    ingest(text.as_bytes(), &dict).expect("within the caps")
}

/// The whole output, rendered — capture, ledger, residue, fragment and drop
/// manifest in one sweep, the method `redaction_canary.rs` uses and for its
/// reason: the point is to catch the path nobody thought of.
fn everything(out: &IngestOutput) -> String {
    format!("{}\n{out:?}", out.capture.text())
}

/// **Leak 1.** A prompt prefix is what copying out of a terminal session
/// produces by default, so this is the likeliest paste in the world. The line
/// classifies as `NoiseClass::Prompt`, and noise lines reached neither `stmts`
/// nor `unshaped` — so the gate never saw the key.
#[test]
fn a_prompt_prefixed_line_is_gated() {
    let out = run(
        "admin@srx-branch-01> set security ike policy P pre-shared-key ascii-text s3cr3tPSKvalue\n",
    );
    assert!(
        !everything(&out).contains("s3cr3tPSKvalue"),
        "a secret on a prompt-prefixed line survived: {}",
        out.capture.text()
    );
    assert_eq!(out.drops.entries.len(), 1, "and it is reported as a drop");
}

/// The other three noise classes go the same way — the fix is per-class in
/// nothing, so a future class added to `NoiseClass` must not reopen this.
#[test]
fn every_noise_class_is_gated() {
    for (what, text) in [
        (
            "a cluster banner",
            "{primary:node0}\nset security ike policy P pre-shared-key ascii-text bannerLeakValue\n",
        ),
        (
            "a command echo",
            "admin@srx> show configuration | display set\nset security ike policy P pre-shared-key ascii-text echoLeakValue\n",
        ),
    ] {
        let out = run(text);
        for canary in ["bannerLeakValue", "echoLeakValue"] {
            assert!(
                !everything(&out).contains(canary),
                "{what}: {canary} survived in {}",
                out.capture.text()
            );
        }
    }
}

/// **Leak 2.** Somebody pastes a private key to ask what it is. The
/// `-----BEGIN` armour line was caught; the key body underneath is a single
/// token on its own line, and the content detectors used to start at token 2.
#[test]
fn a_bare_private_key_body_is_gated() {
    let out = run(concat!(
        "-----BEGIN RSA PRIVATE KEY-----\n",
        "MIIEowIBAAKCAQEAsecretKeyMaterialGoesHereAndMustNotSurvive0123456\n",
        "-----END RSA PRIVATE KEY-----\n",
    ));
    assert!(
        !everything(&out).contains("secretKeyMaterialGoesHereAndMustNotSurvive"),
        "the key body survived under a caught armour line: {}",
        out.capture.text()
    );
}

/// **Leak 3.** `14` §9.6 trusts a value of two or fewer distinct characters as
/// a mask the operator typed. `1111` is four characters of one distinct value —
/// and it is a password, not a mask. It was kept verbatim AND reported as
/// `already_redacted`, which is the worst possible pair: stored, and described
/// as safe.
#[test]
fn a_weak_password_is_not_mistaken_for_a_mask() {
    let out = run("set security ike policy P pre-shared-key ascii-text 1111\n");
    assert!(
        !out.capture.text().contains("1111"),
        "a four-character password was kept: {}",
        out.capture.text()
    );
    assert!(
        out.drops.already_redacted.is_empty(),
        "and it was reported to the operator as something they had already redacted"
    );
    assert_eq!(out.drops.entries.len(), 1);
}

/// The floor cuts both ways and the other side must still hold: a real mask is
/// still recognised as one, still binds, and is still not counted as a secret
/// Fathom found. Without this, the fix above would be a blunt "destroy
/// everything" that loses `14` §9.6 entirely.
#[test]
fn a_real_mask_is_still_recognised() {
    let out = run("set security ike policy P pre-shared-key ascii-text xxxxxxxxxxxxxxxx\n");
    assert_eq!(
        out.drops.already_redacted.len(),
        1,
        "a sixteen-character mask is a mask"
    );
    assert!(
        out.drops.entries.is_empty(),
        "and is not counted as a secret Fathom removed"
    );
}

/// The angle-bracket form is unambiguous at any length and must not be caught
/// by the length floor.
#[test]
fn an_angle_bracket_placeholder_is_still_recognised() {
    let out = run("set security ike policy P pre-shared-key ascii-text <PSK>\n");
    assert_eq!(out.drops.already_redacted.len(), 1);
    assert!(out.drops.entries.is_empty());
}

/// Gating noise must not turn ordinary noise into residue or drops. A prompt
/// line with nothing secret on it is still just a prompt line.
#[test]
fn ordinary_noise_is_left_alone() {
    let out = run("admin@srx-branch-01> \nset system host-name srx-branch-01\n");
    assert!(out.drops.entries.is_empty(), "{:?}", out.drops.entries);
    assert!(
        out.capture.text().contains("admin@srx-branch-01>"),
        "the prompt itself is not a secret and must survive: {}",
        out.capture.text()
    );
}
