//! `secret_exempt` is a grant made in core, never in a dictionary file
//! (ADR-0044 §7, 2026-09-19). A dictionary may still ASK — `secret_exempt: {
//! reason: "…" }` — but only a path shape `dict::SECRET_EXEMPT_ALLOWLIST`
//! names is honoured, and an honoured exemption must still bind its
//! exempted capture with a closed scalar.
//!
//! These are the exact three rogue dictionaries an independent verifier
//! built to prove the hole existed end to end: a `secret_exempt` accepted on
//! any entry that carries a written `reason`, vetoing the leaf-name walk for
//! a real SRX credential statement. `Summer2026!` is a length and shape a
//! real Junos `plain-text-password` accepts (6-128 characters) — CLAUDE.md
//! rule 2: a safety gate is tested against what a device accepts, never
//! against what the detector needs.

use std::path::{Path, PathBuf};

use fathom_ingest::dict::{DictGate, Dictionary};
use fathom_ingest::hosted::dictionary_from_host;
use fathom_ingest::ingest;

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .nth(2)
        .expect("the crate lives two levels under the repo root")
        .to_path_buf()
}

fn field_keys_text() -> String {
    std::fs::read_to_string(repo_root().join("schema").join("field-keys.yaml"))
        .expect("schema/field-keys.yaml is checked in")
}

fn header() -> &'static str {
    "platform: junos-srx\nsource: { cite: \"test fixture\", read_on: \"2026-09-19\" }\n\
     reviewed_by: x\n"
}

/// (a) The verifier's rogue dictionary — `secret_exempt` on the SRX
/// plain-text-password statement, with a written `reason` that reads
/// plausibly ("this field is a display name") and is false. Refused at load,
/// never at ingest, because the path shape is not in core's allowlist.
#[test]
fn a_rogue_plain_text_password_exemption_fails_to_load() {
    let keys = field_keys_text();
    let rogue = format!(
        "{}entries:\n  \
         - id: rogue/plain-text-password\n    \
           path: [system, login, user, \"$u\", authentication, plain-text-password, \"$v\"]\n    \
           secret_exempt: {{ reason: \"reviewed: this field is a display name\" }}\n    \
           binds:\n      \
             nodes:\n        \
               - {{ as: n0, kind: Device, fields: [ {{ field: hostname, from: \"$u\", scalar: Identifier }}, \
                    {{ field: os_version, from: \"$v\", scalar: Text }} ] }}\n    \
           versions: \"*\"\n    reviewed_by: x\n",
        header()
    );
    let sources = vec![("rogue.yaml".to_owned(), rogue)];
    let e = dictionary_from_host(&sources, "schema/field-keys.yaml", &keys)
        .expect_err("an unallowlisted secret_exempt must not load");
    assert_eq!(e.gate, DictGate::SecretCoupling);
}

/// (b) The same entry with `secret_exempt` removed and no `secret:` either —
/// the pre-existing coupling gate `gate_secret_coupling` still catches it,
/// proving this fix did not weaken that half. `plain-text-password` is a
/// whole-string member of `SECRET_WORD_LIST`.
#[test]
fn the_same_entry_with_no_exemption_and_no_secret_label_is_also_refused() {
    let keys = field_keys_text();
    let rogue = format!(
        "{}entries:\n  \
         - id: rogue/plain-text-password-unlabelled\n    \
           path: [system, login, user, \"$u\", authentication, plain-text-password, \"$v\"]\n    \
           binds:\n      \
             nodes:\n        \
               - {{ as: n0, kind: Device, fields: [ {{ field: hostname, from: \"$u\", scalar: Identifier }} ] }}\n    \
           versions: \"*\"\n    reviewed_by: x\n",
        header()
    );
    let sources = vec![("rogue.yaml".to_owned(), rogue)];
    let e = dictionary_from_host(&sources, "schema/field-keys.yaml", &keys)
        .expect_err("a secret-word leaf with neither secret: nor secret_exempt: must not load");
    assert_eq!(e.gate, DictGate::SecretCoupling);
}

/// (c) A second rogue shape — `system root-authentication plain-text-password`
/// — proving the allowlist refuses by SHAPE, not by memorising one path.
#[test]
fn a_rogue_root_authentication_exemption_fails_to_load() {
    let keys = field_keys_text();
    let rogue = format!(
        "{}entries:\n  \
         - id: rogue/root-authentication\n    \
           path: [system, root-authentication, plain-text-password, \"$v\"]\n    \
           secret_exempt: {{ reason: \"reviewed: this is not actually a secret\" }}\n    \
           binds:\n      \
             nodes:\n        \
               - {{ as: n0, kind: Device, fields: [ {{ field: os_version, from: \"$v\", scalar: Text }} ] }}\n    \
           versions: \"*\"\n    reviewed_by: x\n",
        header()
    );
    let sources = vec![("rogue.yaml".to_owned(), rogue)];
    let e = dictionary_from_host(&sources, "schema/field-keys.yaml", &keys)
        .expect_err("root-authentication's plain-text-password is not an allowlisted shape");
    assert_eq!(e.gate, DictGate::SecretCoupling);
}

/// An allowlisted shape (the shipped PFS one) with the exempted capture
/// re-bound as `Text` instead of `DhGroup` is refused — item 3's closed-scalar
/// requirement, proven against the one real allowlisted shape rather than a
/// synthetic one.
#[test]
fn an_allowlisted_shape_bound_with_a_free_text_scalar_is_refused() {
    let keys = field_keys_text();
    let rogue = format!(
        "{}entries:\n  \
         - id: rogue/pfs-as-text\n    \
           path: [security, ipsec, policy, \"$pol\", perfect-forward-secrecy, keys, \"$v\"]\n    \
           secret_exempt: {{ reason: \"the argument is a Diffie-Hellman group, not a key\" }}\n    \
           binds:\n      \
             nodes:\n        \
               - {{ as: n0, kind: IpsecPolicy, key: \"$pol\", fields: [ {{ field: name, from: \"$pol\", scalar: Identifier }}, \
                    {{ field: description, from: \"$v\", scalar: Text }} ] }}\n    \
           versions: \"*\"\n    reviewed_by: x\n",
        header()
    );
    let sources = vec![("rogue.yaml".to_owned(), rogue)];
    let e = dictionary_from_host(&sources, "schema/field-keys.yaml", &keys)
        .expect_err("an allowlisted exemption bound as Text must still be refused");
    assert_eq!(e.gate, DictGate::SecretCoupling);
}

/// An allowlisted shape whose exempted capture is not bound to any field at
/// all is refused too — "must bind", not "may bind".
#[test]
fn an_allowlisted_shape_that_leaves_the_exempted_capture_unbound_is_refused() {
    let keys = field_keys_text();
    let rogue = format!(
        "{}entries:\n  \
         - id: rogue/pfs-unbound\n    \
           path: [security, ipsec, policy, \"$pol\", perfect-forward-secrecy, keys, \"$v\"]\n    \
           secret_exempt: {{ reason: \"the argument is a Diffie-Hellman group, not a key\" }}\n    \
           binds:\n      \
             nodes:\n        \
               - {{ as: n0, kind: IpsecPolicy, key: \"$pol\", fields: [ {{ field: name, from: \"$pol\", scalar: Identifier }} ] }}\n    \
           versions: \"*\"\n    reviewed_by: x\n",
        header()
    );
    let sources = vec![("rogue.yaml".to_owned(), rogue)];
    let e = dictionary_from_host(&sources, "schema/field-keys.yaml", &keys)
        .expect_err("an allowlisted exemption that binds nothing must still be refused");
    assert_eq!(e.gate, DictGate::SecretCoupling);
}

/// End to end, with the shipped dictionary and the real password: because the
/// rogue entry above can never load, the SHIPPED `junos-srx` catalogue is what
/// a real paste is judged against — and it already declares this exact path
/// `secret: { label: password }` (`corpus/dict/junos-srx/system.yaml`, entry
/// `junos-srx/system.login.user.plain-text-password`), no exemption at all.
/// `Summer2026!` is 11 characters, inside Junos's own 6-128 character range
/// for `plain-text-password` — CLAUDE.md rule 2: tested against what a real
/// SRX accepts, not against what the detector needs.
#[test]
fn the_shipped_dictionary_destroys_a_real_plain_text_password() {
    let d = Dictionary::load(&repo_root()).expect("the shipped dictionary loads");
    let out = ingest(
        b"set system login user ge-0/0/0 authentication plain-text-password Summer2026!\n",
        &d,
    )
    .expect("within the caps");
    assert!(
        !out.capture.text().contains("Summer2026!"),
        "the password must never survive in the redacted capture"
    );
    for node in &out.fragment.nodes {
        for field in &node.fields {
            assert!(
                format!("{field:?}") != "Summer2026!"
                    && !format!("{field:?}").contains("Summer2026!"),
                "the password must never bind into a fragment field"
            );
        }
    }
    assert_eq!(
        format!("{out:?}").matches("Summer2026!").count(),
        0,
        "the password must not appear anywhere in the ingest output"
    );
}
