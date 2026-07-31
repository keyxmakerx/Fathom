//! Each failure gate must actually fire. A gate that only ever passes is
//! untested by definition; every case here corrupts a minimal tree one way
//! and asserts the exact code that catches it.

use fathom_schema::{check, Severity};
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};

static N: AtomicU32 = AtomicU32::new(0);

/// Builds a minimal valid tree in a scratch dir, applies one corruption via
/// the callback, and returns every finding.
fn run_with(mutate: impl FnOnce(&PathBuf)) -> Vec<(String, Severity)> {
    let dir = std::env::temp_dir()
        .join("fathom-schema-fixture")
        .join(format!(
            "{}-{}",
            std::process::id(),
            N.fetch_add(1, Ordering::SeqCst)
        ));
    fs::create_dir_all(dir.join("enums")).unwrap();

    fs::write(
        dir.join("schema.yaml"),
        r#"schema:
  version: "0.1"
scalars:
  - { name: Text, impl: fathom_ir::scalar::Text }
  - { name: Identifier, impl: fathom_ir::scalar::Identifier }
classes:
  - class: PortHost
    members: [Device]
kinds:
  - kind: Device
    layer: config
    emits: true
    doc: |
      A device.
    fields:
      - { name: hostname, type: Identifier, card: "1", emit: R }
    identity:
      - [ hostname ]
  - kind: Widget
    layer: physical
    emits: false
    doc: |
      A widget.
    fields:
      - { name: label, type: Text, card: "1", emit: "—" }
    identity:
      - [ owner(Device), label ]
edges:
  - edge: HasWidget
    class: containment
    from: [Device]
    to: [Widget]
    out: "0..n"
    in: "1"
    reverse_index: true
    fields: []
scopes:
  import:
    - format: WidgetList
      kinds: [Widget]
      tiers: [1]
      absence: nothing
naming_eligible:
  - Device.hostname
"#,
    )
    .unwrap();
    fs::write(
        dir.join("enums/mode.yaml"),
        "variants: [a, b]\ndoc: |\n  Modes.\n",
    )
    .unwrap();
    fs::write(
        dir.join("platforms.yaml"),
        "vendors:\n  acme: {}\nplatforms:\n  acme-os: { vendor: acme, family: acme, version_scheme: semver }\n",
    )
    .unwrap();
    fs::write(
        dir.join("field-keys.yaml"),
        "fields:\n  Device.hostname: 1\n  Widget.label: 2\n",
    )
    .unwrap();

    mutate(&dir);
    let (_, findings) = check(&dir).expect("fixture loads");
    findings.into_iter().map(|f| (f.code, f.severity)).collect()
}

fn codes(findings: &[(String, Severity)]) -> Vec<&str> {
    findings.iter().map(|(c, _)| c.as_str()).collect()
}

#[test]
fn baseline_fixture_is_clean() {
    let f = run_with(|_| {});
    let failures: Vec<_> = f.iter().filter(|(_, s)| *s == Severity::Failure).collect();
    assert!(
        failures.is_empty(),
        "baseline must be clean, got {failures:?}"
    );
}

#[test]
fn subset_violation_fires() {
    let f = run_with(|d| {
        fs::write(
            d.join("enums/bad.yaml"),
            "variants: [a,\n  b]\ndoc: |\n  x\n",
        )
        .unwrap();
    });
    assert!(codes(&f).contains(&"schema.yaml.subset"), "{f:?}");
}

#[test]
fn toplevel_order_fires() {
    let f = run_with(|d| {
        let p = d.join("schema.yaml");
        let s = fs::read_to_string(&p).unwrap();
        // Move `scalars` after `kinds` by renaming blocks in place.
        let s = s.replacen("scalars:", "\u{0}TMP\u{0}:", 1);
        let s = s.replacen("kinds:", "scalars:", 1);
        let s = s.replacen("\u{0}TMP\u{0}:", "kinds:", 1);
        fs::write(&p, s).unwrap();
    });
    assert!(codes(&f).contains(&"schema.order.toplevel"), "{f:?}");
}

#[test]
fn duplicate_kind_fires() {
    let f = run_with(|d| {
        let p = d.join("schema.yaml");
        let mut s = fs::read_to_string(&p).unwrap();
        s = s.replacen("  - kind: Widget", "  - kind: Device", 1);
        fs::write(&p, s).unwrap();
    });
    assert!(codes(&f).contains(&"schema.kind.duplicate"), "{f:?}");
}

#[test]
fn reserved_enum_variant_fires() {
    let f = run_with(|d| {
        fs::write(
            d.join("enums/mode.yaml"),
            "variants: [a, unknown]\ndoc: |\n  Modes.\n",
        )
        .unwrap();
    });
    assert!(codes(&f).contains(&"schema.enum.reserved-variant"), "{f:?}");
}

#[test]
fn identity_ext_term_fires() {
    let f = run_with(|d| {
        let p = d.join("schema.yaml");
        let s = fs::read_to_string(&p)
            .unwrap()
            .replacen("- [ hostname ]", "- [ ext.serial ]", 1);
        fs::write(&p, s).unwrap();
    });
    assert!(codes(&f).contains(&"schema.identity.ext-term"), "{f:?}");
}

#[test]
fn identity_ambiguous_edge_fires() {
    let f = run_with(|d| {
        let p = d.join("schema.yaml");
        let s = fs::read_to_string(&p).unwrap().replacen(
            "- [ owner(Device), label ]",
            "- [ edge(HasWidget) ]",
            1,
        );
        fs::write(&p, s).unwrap();
    });
    // HasWidget's out is 0..n from Device — but the term sits on Widget, and
    // the gate reads the edge's declared out-bound: 0..n is not 1/0..1.
    assert!(
        codes(&f).contains(&"schema.identity.ambiguous-edge"),
        "{f:?}"
    );
}

#[test]
fn scope_absence_fires() {
    let f = run_with(|d| {
        let p = d.join("schema.yaml");
        let s =
            fs::read_to_string(&p)
                .unwrap()
                .replacen("absence: nothing", "absence: tombstone", 1);
        fs::write(&p, s).unwrap();
    });
    assert!(
        codes(&f).contains(&"schema.scope.absent-unshipped"),
        "{f:?}"
    );
}

#[test]
fn emit_on_inert_fires() {
    let f = run_with(|d| {
        let p = d.join("schema.yaml");
        let s = fs::read_to_string(&p).unwrap().replacen(
            r#"{ name: label, type: Text, card: "1", emit: "—" }"#,
            r#"{ name: label, type: Text, card: "1", emit: R }"#,
            1,
        );
        fs::write(&p, s).unwrap();
    });
    assert!(codes(&f).contains(&"schema.emit.on-inert"), "{f:?}");
}

#[test]
fn fieldkey_reuse_fires() {
    let f = run_with(|d| {
        fs::write(
            d.join("field-keys.yaml"),
            "fields:\n  Device.hostname: 1\n  Widget.label: 1\n",
        )
        .unwrap();
    });
    assert!(
        codes(&f).contains(&"proposed:schema.fieldkey.reused"),
        "{f:?}"
    );
}

#[test]
fn fieldkey_missing_fires() {
    let f = run_with(|d| {
        fs::write(d.join("field-keys.yaml"), "fields:\n  Device.hostname: 1\n").unwrap();
    });
    assert!(
        codes(&f).contains(&"proposed:schema.fieldkey.missing"),
        "{f:?}"
    );
}

#[test]
fn unknown_vendor_fires() {
    let f = run_with(|d| {
        fs::write(
            d.join("platforms.yaml"),
            "vendors:\n  acme: {}\nplatforms:\n  other-os: { vendor: nadir, family: x, version_scheme: semver }\n",
        )
        .unwrap();
    });
    assert!(
        codes(&f).contains(&"schema.platform.unknown-vendor"),
        "{f:?}"
    );
}

#[test]
fn unexercised_tier_warns() {
    let f = run_with(|d| {
        let p = d.join("schema.yaml");
        let s = fs::read_to_string(&p)
            .unwrap()
            .replacen("tiers: [1]", "tiers: [1, 3]", 1);
        fs::write(&p, s).unwrap();
    });
    assert!(
        f.iter()
            .any(|(c, s)| c == "schema.identity.unexercised" && *s == Severity::Warning),
        "{f:?}"
    );
}
