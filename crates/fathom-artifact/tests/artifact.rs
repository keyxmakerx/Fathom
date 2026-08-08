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
