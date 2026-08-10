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

// --- the key=value class (found 2026-08-10, second pass) ---------------------
//
// The four content detectors are whole-token tests over a tokenizer whose only
// separators are space, tab, quote and brackets (`lex.rs`'s table contains no
// `=` and no `:`). That is right for Junos, which writes `… ascii-text $9$abc`
// with a space, and wrong for almost everything else — so on any `key=value`
// format the secret was never a token of its own and NOTHING FIRED.
//
// Every case below was demonstrated leaking verbatim with `drops = 0` against
// the shipped code before the fix. None of them is Linux-only: `key-string` is
// a live secret form on Arista, Omada and Sodola, and a clipped quote is what a
// wrapped terminal paste produces on any platform.

/// The whole class, in one table. Each canary must be gone and each line must
/// be reported as a drop — not silently dropped, not silently kept.
#[test]
fn key_value_secrets_are_gated() {
    let cases: [(&str, &str, &str); 6] = [
        (
            "a NetworkManager keyfile PSK",
            "psk=correcthorsebatteryZZ1\n",
            "correcthorsebatteryZZ1",
        ),
        (
            "a NetworkManager 802.1X password",
            "password=Sup3rSecretZZ2\n",
            "Sup3rSecretZZ2",
        ),
        (
            "an /etc/shadow line, colon-delimited",
            "root:$6$saltsalt$hashhashhashhashZZ3:19000:0:99999:7:::\n",
            "hashhashhashhashZZ3",
        ),
        (
            "docker compose config, which interpolates .env",
            "    DB_PASSWORD: hunter2secretZZ4\n",
            "hunter2secretZZ4",
        ),
        (
            "key-string, a live form on Arista, Omada and Sodola",
            "key-string MySharedKeyValueZZ5\n",
            "MySharedKeyValueZZ5",
        ),
        (
            "a clipped terminal paste with an unterminated quote",
            "set security ike policy P pre-shared-key ascii-text \"unterminatedZZ6\n",
            "unterminatedZZ6",
        ),
    ];

    for (what, text, canary) in cases {
        let out = run(text);
        assert!(
            !everything(&out).contains(canary),
            "{what}: `{canary}` survived in {}",
            out.capture.text()
        );
        assert!(
            !out.drops.entries.is_empty(),
            "{what}: destroyed but not reported"
        );
    }
}

/// A compound settings key names a secret by containing one — `DB_PASSWORD`,
/// `admin_password`, `TlsDnsApiKey`. `14` §9.4's list is exact-match, which is
/// right for a Junos path segment and wrong for a settings key.
#[test]
fn a_compound_key_name_still_names_a_secret() {
    for key in ["DB_PASSWORD", "admin_password", "ipsec-pre-shared-key"] {
        let out = run(&format!("{key}=valueThatMustNotSurviveZZ\n"));
        assert!(
            !everything(&out).contains("valueThatMustNotSurviveZZ"),
            "`{key}=` did not read as a secret: {}",
            out.capture.text()
        );
    }
}

/// The aggression must not reach the bound-statement path, where redaction is
/// driven by the dictionary and precision is the whole point. An ordinary
/// address, which contains a `:` in its v6 form and a `/`, must still bind.
#[test]
fn the_widened_net_does_not_catch_ordinary_config() {
    let out = run(concat!(
        "set system host-name srx-branch-01\n",
        "set interfaces ge-0/0/0 unit 0 family inet address 203.0.113.2/30\n",
        "set interfaces ge-0/0/0 description \"WAN to ISP\"\n",
    ));
    assert!(
        out.drops.entries.is_empty(),
        "ordinary config was redacted: {:?}",
        out.drops.entries
    );
    assert!(out.residue.is_empty(), "{:?}", out.residue);
    assert!(
        out.capture.text().contains("203.0.113.2/30"),
        "the address survived: {}",
        out.capture.text()
    );
}
