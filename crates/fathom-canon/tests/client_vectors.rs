//! Rust-made vectors for the browser's mirror of this crate
//! (`client/src/document/canon.ts`).
//!
//! Each input below is run through [`Json::parse_canonical`] here, and the
//! verdict is written to `client/src/document/vectors/canon.vectors`, one line
//! per input:
//!
//! ```text
//! <name> accept - - <hex>              Rust accepts; the bytes re-emit themselves
//! <name> accept-wide - - <hex>         Rust accepts an integer JavaScript cannot
//!                                      hold exactly; canon.ts refuses it as
//!                                      int-out-of-range at the given offset
//! <name> refuse <reason> <offset> <hex>
//! ```
//!
//! `client/src/document/canon.vectors.test.ts` holds canon.ts to every line, so
//! the two parsers cannot drift apart without one of the two test runs going
//! red. Regenerate after changing this list or the parser:
//!
//! ```text
//! cargo test -p fathom-canon --test client_vectors -- --ignored --nocapture
//! ```

use std::fs;
use std::path::PathBuf;

use fathom_canon::{Json, ParseReason, MAX_DEPTH};

/// The largest integer a JavaScript number holds exactly (2^53 - 1).
const JS_SAFE: i64 = 9_007_199_254_740_991;

fn deep(n: usize) -> Vec<u8> {
    let mut v = "[".repeat(n);
    v.push_str(&"]".repeat(n));
    v.push('\n');
    v.into_bytes()
}

/// The inputs, by name. Accepted shapes first, then one or more second
/// spellings for every refusal reason.
fn inputs() -> Vec<(&'static str, Vec<u8>)> {
    let b = |s: &[u8]| s.to_vec();
    vec![
        // Accepted.
        ("null", b(b"null\n")),
        ("true", b(b"true\n")),
        ("false", b(b"false\n")),
        ("zero", b(b"0\n")),
        ("minus-one", b(b"-1\n")),
        ("js-safe-max", format!("{JS_SAFE}\n").into_bytes()),
        ("js-safe-min", format!("-{JS_SAFE}\n").into_bytes()),
        ("empty-string", b(b"\"\"\n")),
        ("short-escapes", b(b"\"a\\\"b\\\\c\\nd\\u0001e\"\n")),
        ("all-short-controls", b(b"\"\\b\\f\\r\\t\\u001f\"\n")),
        ("raw-utf8", "\"— ✓ é 𝄞\"\n".as_bytes().to_vec()),
        ("empty-array", b(b"[]\n")),
        ("array", b(b"[true,null,2]\n")),
        ("empty-object", b(b"{}\n")),
        ("object", b(b"{\"a\":[true,null],\"b\":2}\n")),
        (
            "nested",
            b(b"{\"nested\":{\"deep\":[{\"k\":\"v\"}]},\"z\":-7}\n"),
        ),
        // Byte order, not UTF-16 order: U+FF5E sorts before U+1D11E in UTF-16
        // code units but after it in UTF-8 bytes.
        (
            "keys-in-byte-order",
            "{\"\u{ff5e}\":1,\"\u{1d11e}\":2}\n".as_bytes().to_vec(),
        ),
        ("depth-at-cap", deep(MAX_DEPTH + 1)),
        // Accepted by Rust, out of JavaScript's exact range.
        ("i64-max", format!("{}\n", i64::MAX).into_bytes()),
        ("i64-min", format!("{}\n", i64::MIN).into_bytes()),
        (
            "js-safe-max-plus-one",
            format!("{}\n", JS_SAFE + 1).into_bytes(),
        ),
        // Whitespace and other bytes outside the grammar.
        ("space-after-colon", b(b"{\"a\": 1}\n")),
        ("space-after-brace", b(b"{ \"a\":1}\n")),
        ("space-after-comma", b(b"[1, 2]\n")),
        ("leading-space", b(b" 1\n")),
        ("leading-tab", b(b"\t1\n")),
        ("plus-sign", b(b"+1\n")),
        ("bare-minus", b(b"-\n")),
        ("truncated-true", b(b"tru\n")),
        ("empty-input", b(b"")),
        ("unterminated-string", b(b"\"abc")),
        ("trailing-comma", b(b"[1,]\n")),
        // Keys.
        ("unsorted-keys", b(b"{\"b\":1,\"a\":2}\n")),
        ("duplicate-keys", b(b"{\"a\":1,\"a\":2}\n")),
        (
            "utf16-order-keys",
            "{\"\u{1d11e}\":2,\"\u{ff5e}\":1}\n".as_bytes().to_vec(),
        ),
        // Integers.
        ("leading-zero", b(b"01\n")),
        ("minus-zero", b(b"-0\n")),
        ("double-zero", b(b"00\n")),
        ("minus-leading-zero", b(b"-01\n")),
        ("above-i64", b(b"99999999999999999999\n")),
        ("i64-max-plus-one", b(b"9223372036854775808\n")),
        ("i64-min-minus-one", b(b"-9223372036854775809\n")),
        ("float", b(b"0.75\n")),
        ("exponent", b(b"1e3\n")),
        ("negative-float", b(b"-2.5\n")),
        ("upper-exponent", b(b"1E3\n")),
        ("float-in-array", b(b"[1,2.0]\n")),
        // Escapes.
        ("long-a", b(b"\"\\u0041\"\n")),
        ("long-newline", b(b"\"\\u000a\"\n")),
        ("long-tab", b(b"\"\\u0009\"\n")),
        ("escaped-solidus", b(b"\"\\/\"\n")),
        ("upper-hex-escape", b(b"\"\\u00E9\"\n")),
        ("upper-hex-control", b(b"\"\\u001F\"\n")),
        ("surrogate-pair-escape", b(b"\"\\ud834\\udd1e\"\n")),
        ("unknown-escape", b(b"\"\\x\"\n")),
        // Raw controls and bad UTF-8.
        ("raw-newline-in-string", b(b"\"a\nb\"\n")),
        ("raw-0x01-in-string", b(b"\"a\x01b\"\n")),
        ("raw-tab-in-string", b(b"\"a\tb\"\n")),
        ("lone-continuation", b(b"\"\x80\"\n")),
        ("truncated-two-byte", b(b"\"\xc3\"\n")),
        ("overlong-slash", b(b"\"\xc0\xaf\"\n")),
        ("encoded-surrogate", b(b"\"\xed\xa0\x80\"\n")),
        ("above-u10ffff", b(b"\"\xf4\x90\x80\x80\"\n")),
        ("bad-utf8-in-key", b(b"{\"\xff\":1}\n")),
        // Depth.
        ("depth-over-cap", deep(MAX_DEPTH + 2)),
        // The end of the input.
        ("byte-after-newline", b(b"1\nx")),
        ("second-newline", b(b"1\n\n")),
        ("object-second-newline", b(b"{\"a\":1}\n\n")),
        ("no-final-newline", b(b"1")),
        ("object-no-final-newline", b(b"{\"a\":1}")),
        ("crlf", b(b"1\r\n")),
    ]
}

fn kebab(r: &ParseReason) -> &'static str {
    match r {
        ParseReason::UnexpectedByte => "unexpected-byte",
        ParseReason::Utf8 => "utf8",
        ParseReason::UnsortedKey => "unsorted-key",
        ParseReason::NonShortestInt => "non-shortest-int",
        ParseReason::IntOutOfRange => "int-out-of-range",
        ParseReason::FloatRefused => "float-refused",
        ParseReason::NonMinimalEscape => "non-minimal-escape",
        ParseReason::RawControl => "raw-control",
        ParseReason::DepthExceeded => "depth-exceeded",
        ParseReason::TrailingBytes => "trailing-bytes",
        ParseReason::MissingFinalNewline => "missing-final-newline",
    }
}

/// Where the first integer JavaScript cannot hold exactly starts, if any.
/// Emitted bytes put every integer at a findable place, so this walks the
/// value and the bytes together by re-emitting prefixes.
fn first_wide_int(bytes: &[u8], v: &Json) -> Option<usize> {
    fn walk(v: &Json, out: &mut Vec<i64>) {
        match v {
            Json::Int(i) if !(-JS_SAFE..=JS_SAFE).contains(i) => out.push(*i),
            Json::Arr(a) => a.iter().for_each(|x| walk(x, out)),
            Json::Obj(m) => m.values().for_each(|x| walk(x, out)),
            _ => {}
        }
    }
    let mut wide = Vec::new();
    walk(v, &mut wide);
    let first = wide.first()?;
    let needle = first.to_string();
    let text = std::str::from_utf8(bytes).ok()?;
    text.find(&needle)
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

fn line(name: &str, bytes: &[u8]) -> String {
    match Json::parse_canonical(bytes) {
        Ok(v) => {
            assert_eq!(
                v.to_canonical_bytes(),
                bytes,
                "{name}: an accepted input must re-emit itself"
            );
            match first_wide_int(bytes, &v) {
                None => format!("{name} accept - - {}", hex(bytes)),
                Some(at) => format!("{name} accept-wide int-out-of-range {at} {}", hex(bytes)),
            }
        }
        Err(e) => format!(
            "{name} refuse {} {} {}",
            kebab(&e.reason),
            e.offset,
            hex(bytes)
        ),
    }
}

fn file() -> String {
    let mut out = String::new();
    for (name, bytes) in inputs() {
        out.push_str(&line(name, &bytes));
        out.push('\n');
    }
    out
}

fn vectors_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../client/src/document/vectors/canon.vectors")
}

#[test]
fn every_refusal_reason_has_a_vector() {
    let f = file();
    for reason in [
        "unexpected-byte",
        "utf8",
        "unsorted-key",
        "non-shortest-int",
        "int-out-of-range",
        "float-refused",
        "non-minimal-escape",
        "raw-control",
        "depth-exceeded",
        "trailing-bytes",
        "missing-final-newline",
    ] {
        assert!(
            f.lines().any(|l| l.contains(&format!(" refuse {reason} "))),
            "no vector refuses with {reason}"
        );
    }
    assert!(f.lines().any(|l| l.contains(" accept-wide ")));
}

#[test]
fn names_are_unique() {
    let mut names: Vec<_> = inputs().into_iter().map(|(n, _)| n).collect();
    let all = names.len();
    names.sort_unstable();
    names.dedup();
    assert_eq!(names.len(), all);
}

#[test]
fn the_fixture_on_disk_is_what_the_engine_writes() {
    let path = vectors_path();
    let on_disk = fs::read_to_string(&path).unwrap_or_else(|_| {
        panic!(
            "{} is missing; run this file's generator (see its header)",
            path.display()
        )
    });
    assert_eq!(
        on_disk,
        file(),
        "{} is stale; regenerate it",
        path.display()
    );
}

#[test]
#[ignore = "writes client/src/document/vectors/canon.vectors -- run explicitly"]
fn write_canon_vectors() {
    fs::write(vectors_path(), file()).unwrap();
    println!("wrote {}", vectors_path().display());
}
