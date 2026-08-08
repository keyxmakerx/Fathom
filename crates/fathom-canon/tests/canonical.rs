//! The canonical byte contract, both directions (WO-05 §4.5).
//!
//! The headline is `parse_emit_identity_on_accepted_vectors`: the parser's
//! definition is *"exactly the emitter's output set"*, so every accepted byte
//! string must re-emit itself. The refusal tests are the other half — each
//! names one second spelling the parser must not silently normalise.

use fathom_canon::{Json, ParseReason, MAX_DEPTH};
use std::collections::BTreeMap;

fn obj(pairs: &[(&str, Json)]) -> Json {
    let mut m = BTreeMap::new();
    for (k, v) in pairs {
        m.insert((*k).to_owned(), v.clone());
    }
    Json::Obj(m)
}

fn s(v: &str) -> Json {
    Json::Str(v.to_owned())
}

/// Every canonical vector this crate is expected to survive, emitter side.
fn vectors() -> Vec<Json> {
    vec![
        Json::Null,
        Json::Bool(true),
        Json::Bool(false),
        Json::Int(0),
        Json::Int(-1),
        Json::Int(i64::MAX),
        Json::Int(i64::MIN),
        s(""),
        s("a\"b\\c\nd\u{1}e — ✓"),
        s("\u{08}\u{0c}\r\t\u{1f}"),
        Json::Arr(vec![]),
        Json::Arr(vec![Json::Bool(true), Json::Null, Json::Int(2)]),
        obj(&[]),
        obj(&[
            ("a", Json::Arr(vec![Json::Bool(true), Json::Null])),
            ("b", Json::Int(2)),
        ]),
        obj(&[
            (
                "nested",
                obj(&[("deep", Json::Arr(vec![obj(&[("k", s("v"))])]))]),
            ),
            ("z", Json::Int(-7)),
        ]),
    ]
}

#[test]
fn emitter_vectors_survive_the_move() {
    // The two byte assertions that lived in fathom-schemagen's json.rs.
    let mut m = BTreeMap::new();
    m.insert("b".to_owned(), Json::Int(2));
    m.insert(
        "a".to_owned(),
        Json::Arr(vec![Json::Bool(true), Json::Null]),
    );
    assert_eq!(
        Json::Obj(m).to_canonical_bytes(),
        b"{\"a\":[true,null],\"b\":2}\n"
    );
    assert_eq!(
        std::str::from_utf8(&s("a\"b\\c\nd\u{1}e — ✓").to_canonical_bytes()).unwrap(),
        "\"a\\\"b\\\\c\\nd\\u0001e — ✓\"\n"
    );
}

#[test]
fn parse_emit_identity_on_accepted_vectors() {
    for v in vectors() {
        let bytes = v.to_canonical_bytes();
        let parsed = Json::parse_canonical(&bytes)
            .unwrap_or_else(|e| panic!("{:?} must parse: {e:?}", String::from_utf8_lossy(&bytes)));
        assert_eq!(parsed, v, "value survives the round trip");
        assert_eq!(
            parsed.to_canonical_bytes(),
            bytes,
            "bytes survive the round trip"
        );
    }
}

#[test]
fn whitespace_refused() {
    for input in [
        &b"{\"a\": 1}\n"[..],
        &b"{ \"a\":1}\n"[..],
        &b"[1, 2]\n"[..],
        &b" 1\n"[..],
        &b"\t1\n"[..],
        &b"{\"a\":1}\n\n"[..],
    ] {
        let err = Json::parse_canonical(input)
            .unwrap_err_or_else(|| format!("{:?} must refuse", String::from_utf8_lossy(input)));
        assert!(
            matches!(
                err.reason,
                ParseReason::UnexpectedByte | ParseReason::TrailingBytes
            ),
            "{:?} refused for {:?}",
            String::from_utf8_lossy(input),
            err.reason
        );
    }
}

#[test]
fn unsorted_or_duplicate_keys_refused() {
    for input in [&b"{\"b\":1,\"a\":2}\n"[..], &b"{\"a\":1,\"a\":2}\n"[..]] {
        let err = Json::parse_canonical(input).expect_err("second spelling");
        assert_eq!(err.reason, ParseReason::UnsortedKey);
    }
}

#[test]
fn nonminimal_escape_refused() {
    for input in [
        &b"\"\\u0041\"\n"[..], // "A" spelled long
        &b"\"\\u000a\"\n"[..], // \n has a shorter form
        &b"\"\\u0009\"\n"[..], // \t has a shorter form
        &b"\"\\/\"\n"[..],     // a legal JSON escape the emitter never writes
        &b"\"\\u00E9\"\n"[..], // upper-case hex, and above 0x20
    ] {
        let err = Json::parse_canonical(input)
            .unwrap_err_or_else(|| format!("{:?} must refuse", String::from_utf8_lossy(input)));
        assert_eq!(
            err.reason,
            ParseReason::NonMinimalEscape,
            "{:?}",
            String::from_utf8_lossy(input)
        );
    }
    // The one `\u` form the emitter does write: a control character with no
    // shorter spelling.
    assert_eq!(
        Json::parse_canonical(b"\"\\u0001\"\n").expect("0x01 has no short form"),
        s("\u{1}")
    );
}

#[test]
fn raw_control_refused() {
    assert_eq!(
        Json::parse_canonical(b"\"a\nb\"\n")
            .expect_err("raw LF inside a string")
            .reason,
        ParseReason::RawControl
    );
    assert_eq!(
        Json::parse_canonical(b"\"a\x01b\"\n")
            .expect_err("raw 0x01")
            .reason,
        ParseReason::RawControl
    );
}

#[test]
fn nonshortest_int_refused() {
    for input in [&b"01\n"[..], &b"-0\n"[..], &b"00\n"[..], &b"-01\n"[..]] {
        let err = Json::parse_canonical(input)
            .unwrap_err_or_else(|| format!("{:?} must refuse", String::from_utf8_lossy(input)));
        assert_eq!(err.reason, ParseReason::NonShortestInt);
    }
    // A plus sign is not part of the grammar at all.
    assert_eq!(
        Json::parse_canonical(b"+1\n").expect_err("plus").reason,
        ParseReason::UnexpectedByte
    );
}

#[test]
fn int_overflow_refused() {
    assert_eq!(
        Json::parse_canonical(b"99999999999999999999\n")
            .expect_err("above i64")
            .reason,
        ParseReason::IntOutOfRange
    );
}

#[test]
fn float_refused() {
    for input in [&b"0.75\n"[..], &b"1e3\n"[..], &b"-2.5\n"[..], &b"1E3\n"[..]] {
        let err = Json::parse_canonical(input)
            .unwrap_err_or_else(|| format!("{:?} must refuse", String::from_utf8_lossy(input)));
        assert_eq!(err.reason, ParseReason::FloatRefused);
    }
}

#[test]
fn trailing_bytes_refused() {
    assert_eq!(
        Json::parse_canonical(b"1\nx")
            .expect_err("a byte after the final LF")
            .reason,
        ParseReason::TrailingBytes
    );
    assert_eq!(
        Json::parse_canonical(b"1\n\n")
            .expect_err("a second LF")
            .reason,
        ParseReason::TrailingBytes
    );
}

#[test]
fn missing_final_newline_refused() {
    assert_eq!(
        Json::parse_canonical(b"1").expect_err("no final LF").reason,
        ParseReason::MissingFinalNewline
    );
    assert_eq!(
        Json::parse_canonical(b"{\"a\":1}")
            .expect_err("no final LF")
            .reason,
        ParseReason::MissingFinalNewline
    );
}

#[test]
fn depth_cap_refused() {
    let deep = |n: usize| {
        let mut v = "[".repeat(n);
        v.push_str(&"]".repeat(n));
        v.push('\n');
        v.into_bytes()
    };
    // The outermost value sits at depth 0, so MAX_DEPTH + 1 nested arrays is
    // the deepest accepted shape.
    assert!(Json::parse_canonical(&deep(MAX_DEPTH + 1)).is_ok());
    assert_eq!(
        Json::parse_canonical(&deep(MAX_DEPTH + 2))
            .expect_err("beyond the cap")
            .reason,
        ParseReason::DepthExceeded
    );
}

/// `Result::expect_err` needs `T: Debug`; `Json` has it, but the message is
/// more useful with the offending bytes in it.
trait UnwrapErrOrElse<E> {
    fn unwrap_err_or_else(self, msg: impl FnOnce() -> String) -> E;
}

impl<T, E> UnwrapErrOrElse<E> for Result<T, E> {
    fn unwrap_err_or_else(self, msg: impl FnOnce() -> String) -> E {
        match self {
            Ok(_) => panic!("{}", msg()),
            Err(e) => e,
        }
    }
}
