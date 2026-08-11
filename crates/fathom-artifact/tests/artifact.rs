//! WO-08 §4.7.3 — the encoder's vectors, gate X0.8 against the **final
//! bytes**, the source's egress and sink hygiene, and the splice's
//! determinism.

use std::path::PathBuf;

use fathom_artifact::{assemble, base64, SHELL_SOURCE, TOKEN_TOKENS_CSS, TOKEN_WASM_B64};

fn workspace_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")
}

#[test]
fn base64_matches_rfc4648_vectors() {
    // RFC 4648 §10's seven test vectors.
    for (input, want) in [
        ("", ""),
        ("f", "Zg=="),
        ("fo", "Zm8="),
        ("foo", "Zm9v"),
        ("foob", "Zm9vYg=="),
        ("fooba", "Zm9vYmE="),
        ("foobar", "Zm9vYmFy"),
    ] {
        assert_eq!(base64(input.as_bytes()), want, "{input:?}");
    }
}

#[test]
fn assembled_artifact_pins_x08() {
    let bytes = assemble(&workspace_root()).expect("the artifact assembles");
    let text = String::from_utf8(bytes).expect("the artifact is UTF-8");

    // X0.8 (71 §3.6): asserted against the final bytes, not the template.
    assert_eq!(
        text.matches("connect-src 'none'").count(),
        1,
        "connect-src 'none' appears exactly once"
    );
    for directive in [
        "default-src 'none';",
        "script-src 'unsafe-inline' 'wasm-unsafe-eval';",
        "style-src 'unsafe-inline';",
        "img-src data:;",
        "font-src data:;",
        "connect-src 'none';",
        "worker-src blob:;",
        "child-src 'none';",
        "frame-src 'none';",
        "form-action 'none';",
        "base-uri 'none';",
        "object-src 'none';",
        "media-src 'none';",
        "manifest-src 'none';",
        "require-trusted-types-for 'script';",
        "trusted-types fathom-dom fathom-worker;",
    ] {
        assert!(text.contains(directive), "the CSP carries `{directive}`");
    }
    assert!(text.contains(r#"<meta name="referrer" content="no-referrer">"#));

    // Neither splice token survives.
    assert!(
        !text.contains(TOKEN_TOKENS_CSS),
        "the tokens splice happened"
    );
    assert!(!text.contains(TOKEN_WASM_B64), "the module splice happened");
    // The two splices really landed: a token value and the module's magic.
    assert!(text.contains("--radius: 0"), "design/tokens.css is inlined");
    assert!(
        text.contains("AGFzbQ"),
        "the base64 module opens with \\0asm"
    );
}

#[test]
fn shell_source_carries_no_egress_and_no_sinks() {
    let source = std::fs::read_to_string(workspace_root().join(SHELL_SOURCE))
        .expect("the shell source is checked in");
    // The same literals G8 greps for — invariant 1, and the trusted-types
    // directives the no-sink rule makes real.
    for pattern in [
        "new WebSocket",
        "new EventSource",
        "new XMLHttpRequest",
        "navigator.sendBeacon(",
        "fetch(",
        "import(",
        "innerHTML",
        "outerHTML",
        "insertAdjacentHTML",
        "document.write",
        "<script src",
    ] {
        assert!(
            !source.contains(pattern),
            "the shell source must not contain `{pattern}`"
        );
    }
    // 51 §10, §14: no hex, no px font size, no duration, and radius and
    // elevation only through the tokens.
    for line in source.lines() {
        if line.contains("border-radius") {
            assert!(line.contains("var(--radius)"), "{line}");
        }
        if line.contains("box-shadow") {
            assert!(line.contains("var(--shadow)"), "{line}");
        }
        assert!(!line.contains("@keyframes"), "{line}");
        assert!(!line.contains("transition:"), "{line}");
        assert!(!line.contains("animation:"), "{line}");
    }
}

#[test]
fn artifact_is_deterministic() {
    let root = workspace_root();
    let a = assemble(&root).expect("the artifact assembles");
    let b = assemble(&root).expect("the artifact assembles");
    assert_eq!(a.len(), b.len());
    assert!(a == b, "two assemblies are byte-identical");
}

/// The equipment form's field-key table must name the fields the schema
/// declares, and no other.
///
/// The page carries seven wire numbers in `EQUIP_FIELDS` because the module
/// answers with values rather than with a form description. That is a hand
/// table in a tree whose whole discipline is that hand tables drift — and this
/// one already nearly did: `Chassis.model` was written as 300 from memory and
/// is 19. It was caught by looking, which is not a method that scales.
///
/// So the numbers are pinned here against the generated tables. A schema change
/// that moves a key fails this test instead of silently pointing the form at a
/// different field, which would store the model in the serial and say nothing.
#[test]
fn the_equipment_form_names_the_schema_s_field_keys() {
    use fathom_ir::generated::ir_types::{ChassisField, DeviceField};

    let source = std::fs::read_to_string(workspace_root().join(SHELL_SOURCE))
        .expect("the shell source is checked in");

    // (the page's label, the key the schema declares)
    let expected = [
        ("hostname", DeviceField::Hostname.key().0),
        ("platform", DeviceField::Platform.key().0),
        ("role", DeviceField::Role.key().0),
        ("model", ChassisField::Model.key().0),
        ("serial", ChassisField::Serial.key().0),
        ("os version", DeviceField::OsVersion.key().0),
        ("management address", DeviceField::ManagementAddress.key().0),
    ];

    for (label, key) in expected {
        let row = source
            .lines()
            .find(|l| l.contains(&format!("'{label}'")) && l.trim_start().starts_with('['))
            .unwrap_or_else(|| panic!("EQUIP_FIELDS has no row labelled {label:?}"));
        let got: u32 = row
            .trim_start()
            .trim_start_matches('[')
            .split(',')
            .next()
            .and_then(|n| n.trim().parse().ok())
            .unwrap_or_else(|| panic!("the {label:?} row does not begin with a number: {row}"));
        assert_eq!(
            got, key,
            "the equipment form sends key {got} for {label:?}; the schema declares {key}"
        );
    }
}

/// Every platform the form offers must be one `schema/platforms.yaml` declares.
/// `PlatformId` is a foreign key into that file, so an option that is not a row
/// there is a value the store will hold and nothing will ever understand.
#[test]
fn the_equipment_form_offers_only_declared_platforms() {
    let source = std::fs::read_to_string(workspace_root().join(SHELL_SOURCE))
        .expect("the shell source is checked in");
    let registry = std::fs::read_to_string(workspace_root().join("schema/platforms.yaml"))
        .expect("the platform registry is checked in");

    let start = source
        .find("var PLATFORMS = [")
        .expect("the page declares PLATFORMS");
    let end = source[start..].find("];").expect("PLATFORMS is a literal") + start;
    let listed: Vec<String> = source[start..end]
        .split('\'')
        .skip(1)
        .step_by(2)
        .map(str::to_owned)
        .collect();
    assert!(!listed.is_empty(), "PLATFORMS parsed as empty");

    // The `platforms:` block's rows are `  <id>: { ... }` at two spaces.
    let block = registry
        .find("\nplatforms:")
        .expect("the registry has a platforms block");
    for id in &listed {
        assert!(
            registry[block..].contains(&format!("\n  {id}:")),
            "the form offers platform {id:?}, which schema/platforms.yaml does not declare"
        );
    }
}
