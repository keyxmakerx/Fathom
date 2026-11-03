//! Rust-made vectors for the browser's plain-face reader
//! (`readPlain` in `client/src/document/plain.ts`): what it opens, what it
//! refuses, and why.
//!
//! Each case below is read here with [`read_plain`], and the outcome is
//! written to `client/src/document/vectors/plain.vectors`, one canonical JSON
//! object per line: `{"name", "input", "expect"}`, or `"input_hex"` where the
//! input is not valid UTF-8. `expect` is either `{"kind":"opens"}` or the
//! refusal in `PlainErrorReason`'s own shape. The version cases are built from
//! the generated `since:` tables rather than typed in, so a kind added at the
//! next bump gets its boundary vectors without anyone remembering to add them.
//!
//! `client/src/document/plain.vectors.test.ts` holds plain.ts to every line.
//! Regenerate after changing this list, the reader, or the schema:
//!
//! ```text
//! cargo test -p fathom-workspace --test client_plain_vectors -- --ignored --nocapture
//! ```

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::PathBuf;

use fathom_canon::{Json, ParseReason};
use fathom_graph::{
    Actor, BatchId, Confidence, Graph, Origin, ProvenanceId, ProvenanceRecord, Timestamp, UserId,
};
use fathom_id::Ulid;
use fathom_ir::generated::ir_types::{
    EdgeKind, Layer, NodeKind, ACCEPTED_OLDER_SCHEMA_VERSIONS, SCHEMA_VERSION,
};
use fathom_workspace::{read_plain, write_plain, PlainError, PLAIN_WARNING};

const AT: u64 = 1_700_000_000_000;

fn ulid(n: u128) -> Ulid {
    Ulid::from_parts(AT, n).expect("48-bit timestamp")
}

fn prov(n: u128) -> ProvenanceRecord {
    ProvenanceRecord {
        id: ProvenanceId(ulid(1_000_000 + n)),
        origin: Origin::Hand,
        asserted_at: Timestamp(AT),
        asserted_by: Actor::User(UserId(ulid(u128::MAX))),
        confidence: Confidence::Asserted,
        supersedes: None,
    }
}

/// A design holding `nodes` and, for each of `edges`, one edge between fresh
/// nodes of its first allowed endpoint kinds.
fn design(nodes: &[NodeKind], edges: &[EdgeKind]) -> String {
    let mut g = Graph::new();
    let mut n: u128 = 0;
    let mut next = || {
        n += 1;
        n
    };
    g.begin_batch(BatchId(ulid(0)), "build").expect("open");
    for &kind in nodes {
        let i = next();
        g.insert_node(kind, ulid(i), prov(i)).expect("node");
    }
    for &kind in edges {
        let (from, to) = endpoints(kind).expect("an edge with design endpoints");
        let (a, b, e) = (next(), next(), next());
        let from = g.insert_node(from, ulid(a), prov(a)).expect("from");
        let to = g.insert_node(to, ulid(b), prov(b)).expect("to");
        g.insert_edge(kind, ulid(e), from, to, prov(e))
            .expect("edge");
    }
    g.end_batch().expect("close");
    String::from_utf8(write_plain(&g).expect("writes")).expect("UTF-8")
}

/// The oldest design kinds an edge may join, so the edge itself is what a
/// version case is about wherever the schema allows it.
fn endpoints(kind: EdgeKind) -> Option<(NodeKind, NodeKind)> {
    let pick = |ks: &[NodeKind]| {
        ks.iter()
            .copied()
            .filter(|k| k.layer() != Layer::Plan)
            .min_by_key(|k| k.since_minor().unwrap_or(0))
    };
    Some((pick(kind.from_kinds())?, pick(kind.to_kinds())?))
}

fn at_version(text: &str, version: &str) -> String {
    let out = text.replacen(
        &format!("schema {SCHEMA_VERSION}"),
        &format!("schema {version}"),
        1,
    );
    assert!(
        version == SCHEMA_VERSION || out != text,
        "the header substitution must land"
    );
    out
}

fn minor(v: &str) -> u32 {
    v.strip_prefix("0.")
        .and_then(|m| m.parse().ok())
        .expect("0.N")
}

fn oldest() -> &'static str {
    ACCEPTED_OLDER_SCHEMA_VERSIONS[0]
}

/// `0.N` for a minor, if a header may declare it.
fn readable(m: u32) -> Option<String> {
    let v = format!("0.{m}");
    (v == SCHEMA_VERSION || ACCEPTED_OLDER_SCHEMA_VERSIONS.contains(&v.as_str())).then_some(v)
}

fn cases() -> Vec<(String, Vec<u8>)> {
    let mut out: Vec<(String, Vec<u8>)> = Vec::new();
    let mut add = |name: String, bytes: Vec<u8>| out.push((name, bytes));
    let one = design(&[NodeKind::Device], &[]);

    // The header, line by line.
    add("current".into(), one.clone().into_bytes());
    add(
        "oldest-readable".into(),
        at_version(&one, oldest()).into_bytes(),
    );
    let mut sealed = b"FTHM\x1fREC".to_vec();
    sealed.extend_from_slice(&[0x01, 0x01, 0x00, 0x00]);
    add("sealed-magic".into(), sealed);
    add("plain-text-file".into(), b"hello\n\n\n\n{}\n".to_vec());
    add("empty-file".into(), Vec::new());
    add("magic-without-space".into(), b"fathom-plain\n".to_vec());
    add(
        "face-version-2".into(),
        one.replacen("fathom-plain 1", "fathom-plain 2", 1)
            .into_bytes(),
    );
    add(
        "face-version-01".into(),
        one.replacen("fathom-plain 1", "fathom-plain 01", 1)
            .into_bytes(),
    );
    add(
        "banner-missing".into(),
        one.replacen(PLAIN_WARNING, "# nothing to see here", 1)
            .into_bytes(),
    );
    add(
        "banner-nudged".into(),
        one.replacen(PLAIN_WARNING, &PLAIN_WARNING.replace('.', "!"), 1)
            .into_bytes(),
    );
    add(
        "banner-trailing-space".into(),
        one.replacen(PLAIN_WARNING, &format!("{PLAIN_WARNING} "), 1)
            .into_bytes(),
    );
    add(
        "schema-line-misspelt".into(),
        one.replacen("schema ", "scheme ", 1).into_bytes(),
    );
    let mut bad_utf8 = one.clone().into_bytes();
    let at = one
        .find(&format!("schema {SCHEMA_VERSION}"))
        .expect("line 3")
        + "schema ".len();
    bad_utf8[at] = 0xff;
    add("schema-line-not-utf8".into(), bad_utf8);
    let before_oldest = format!("0.{}", minor(oldest()) - 1);
    let next = format!("0.{}", minor(SCHEMA_VERSION) + 1);
    for (name, v) in [
        ("schema-before-oldest", before_oldest.as_str()),
        ("schema-0.1", "0.1"),
        ("schema-next", next.as_str()),
        ("schema-1.0", "1.0"),
        ("schema-empty", ""),
        (
            "schema-leading-zero",
            &format!("0.0{}", minor(SCHEMA_VERSION)),
        ),
        ("schema-trailing-space", &format!("{SCHEMA_VERSION} ")),
    ] {
        add(name.into(), at_version(&one, v).into_bytes());
    }
    add(
        "blank-line-not-blank".into(),
        one.replacen(
            &format!("{SCHEMA_VERSION}\n\n"),
            &format!("{SCHEMA_VERSION}\nx\n"),
            1,
        )
        .into_bytes(),
    );
    add(
        "header-cut-at-line-2".into(),
        format!("fathom-plain 1\n{PLAIN_WARNING}").into_bytes(),
    );
    add(
        "header-cut-at-line-4".into(),
        format!("fathom-plain 1\n{PLAIN_WARNING}\nschema {SCHEMA_VERSION}\n").into_bytes(),
    );

    // The body's canonical JSON.
    let mut trailing = one.clone().into_bytes();
    trailing.push(b'x');
    add("body-trailing-byte".into(), trailing);
    add(
        "body-no-final-newline".into(),
        one.trim_end_matches('\n').as_bytes().to_vec(),
    );
    add(
        "body-space-after-colon".into(),
        one.replacen("\"edges\":", "\"edges\": ", 1).into_bytes(),
    );
    add(
        "body-unsorted-keys".into(),
        one.replacen("{\"batches\":", "{\"zz\":0,\"batches\":", 1)
            .into_bytes(),
    );

    // The IP plan store's kinds: refused in a design at any version, and
    // ahead of the version check.
    for kind in NodeKind::ALL
        .iter()
        .copied()
        .filter(|k| k.layer() == Layer::Plan)
    {
        let text = design(&[kind], &[]);
        add(format!("plan-{}", kind.name()), text.clone().into_bytes());
        add(
            format!("plan-{}-at-{}", kind.name(), oldest()),
            at_version(&text, oldest()).into_bytes(),
        );
    }

    // Each kind newer than the oldest readable header: refused one minor
    // before its `since:`, opened at it.
    let mut opens_at: BTreeMap<u32, (Vec<NodeKind>, Vec<EdgeKind>)> = BTreeMap::new();
    for kind in NodeKind::ALL
        .iter()
        .copied()
        .filter(|k| k.layer() != Layer::Plan)
    {
        let Some(since) = kind.since_minor() else {
            continue;
        };
        let text = design(&[kind], &[]);
        if let Some(v) = readable(since - 1) {
            add(
                format!("node-{}-at-{v}", kind.name()),
                at_version(&text, &v).into_bytes(),
            );
        }
        opens_at.entry(since).or_default().0.push(kind);
    }
    for kind in EdgeKind::ALL.iter().copied() {
        let Some(since) = kind.since_minor() else {
            continue;
        };
        if endpoints(kind).is_none() {
            continue;
        }
        let text = design(&[], &[kind]);
        if let Some(v) = readable(since - 1) {
            add(
                format!("edge-{}-at-{v}", kind.name()),
                at_version(&text, &v).into_bytes(),
            );
        }
        opens_at.entry(since).or_default().1.push(kind);
    }
    for (since, (nodes, edges)) in opens_at {
        if let Some(v) = readable(since) {
            let text = design(&nodes, &edges);
            add(
                format!("kinds-of-{v}-at-{v}"),
                at_version(&text, &v).into_bytes(),
            );
        }
    }
    out
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

fn obj(pairs: &[(&str, Json)]) -> Json {
    Json::Obj(
        pairs
            .iter()
            .map(|(k, v)| ((*k).to_owned(), v.clone()))
            .collect(),
    )
}

fn s(v: &str) -> Json {
    Json::Str(v.to_owned())
}

/// The outcome in `PlainErrorReason`'s shape.
fn expect(name: &str, bytes: &[u8]) -> Json {
    let err = match read_plain(bytes) {
        Ok(g) => {
            // An older header reads like a current one and writes at the
            // current version; the client test checks the same of plain.ts.
            let text = std::str::from_utf8(bytes).expect("an opened file is UTF-8");
            let declared = text.lines().nth(2).and_then(|l| l.strip_prefix("schema "));
            let current = at_version_from(text, declared.expect("line 3"));
            assert_eq!(
                write_plain(&g).expect("writes"),
                current.into_bytes(),
                "{name}: opens and writes back at the current version"
            );
            return obj(&[("kind", s("opens"))]);
        }
        Err(e) => e,
    };
    let kind = |k: &str| ("kind", s(k));
    match err {
        PlainError::NotPlainFace => obj(&[kind("not-plain-face")]),
        PlainError::UnsupportedFaceVersion { found } => {
            obj(&[kind("unsupported-face-version"), ("found", s(&found))])
        }
        PlainError::MissingPlaintextBanner => obj(&[kind("missing-plaintext-banner")]),
        PlainError::SchemaVersionMismatch { found, supported } => obj(&[
            kind("schema-version-mismatch"),
            ("found", s(&found)),
            ("supported", s(supported)),
        ]),
        PlainError::KindNotInDeclaredVersion {
            declared_version,
            element_kind,
        } => obj(&[
            kind("kind-not-in-declared-version"),
            ("declaredVersion", s(&declared_version)),
            ("elementKind", s(element_kind)),
        ]),
        PlainError::PlanRecordInDesign { element_kind } => obj(&[
            kind("plan-record-in-design"),
            ("elementKind", s(element_kind)),
        ]),
        PlainError::MalformedHeader { line } => {
            obj(&[kind("malformed-header"), ("line", Json::Int(line.into()))])
        }
        // canon.ts's own message for the same refusal.
        PlainError::Json(e) => obj(&[
            kind("json"),
            (
                "message",
                s(&format!(
                    "canonical JSON: {} at byte {}",
                    kebab(&e.reason),
                    e.offset
                )),
            ),
        ]),
        other => panic!("{name}: no client shape for {other:?}; pick another input"),
    }
}

fn at_version_from(text: &str, declared: &str) -> String {
    text.replacen(
        &format!("schema {declared}\n"),
        &format!("schema {SCHEMA_VERSION}\n"),
        1,
    )
}

fn file() -> String {
    let mut out = String::new();
    for (name, bytes) in cases() {
        let input = match std::str::from_utf8(&bytes) {
            Ok(t) => ("input", s(t)),
            Err(_) => (
                "input_hex",
                s(&bytes.iter().map(|b| format!("{b:02x}")).collect::<String>()),
            ),
        };
        let line = obj(&[("name", s(&name)), input, ("expect", expect(&name, &bytes))]);
        out.push_str(std::str::from_utf8(&line.to_canonical_bytes()).expect("UTF-8"));
    }
    out
}

fn vectors_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../client/src/document/vectors/plain.vectors")
}

#[test]
fn names_are_unique() {
    let names: Vec<_> = cases().into_iter().map(|(n, _)| n).collect();
    let unique: BTreeSet<_> = names.iter().collect();
    assert_eq!(unique.len(), names.len());
}

#[test]
fn every_refusal_the_client_mirrors_has_a_vector() {
    let f = file();
    for kind in [
        "opens",
        "not-plain-face",
        "unsupported-face-version",
        "missing-plaintext-banner",
        "schema-version-mismatch",
        "kind-not-in-declared-version",
        "plan-record-in-design",
        "malformed-header",
        "json",
    ] {
        assert!(
            f.contains(&format!("\"kind\":\"{kind}\"")),
            "no vector expects {kind}"
        );
    }
}

#[test]
fn every_kind_newer_than_the_oldest_header_has_its_boundary() {
    let f = file();
    for kind in NodeKind::ALL.iter().filter(|k| k.layer() != Layer::Plan) {
        if let Some(since) = kind.since_minor() {
            if readable(since - 1).is_some() {
                assert!(f.contains(&format!("\"name\":\"node-{}-at-", kind.name())));
            }
        }
    }
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
    assert!(
        on_disk == file(),
        "{} is stale; regenerate it",
        path.display()
    );
}

#[test]
#[ignore = "writes client/src/document/vectors/plain.vectors -- run explicitly"]
fn write_plain_vectors() {
    fs::write(vectors_path(), file()).unwrap();
    println!("wrote {}", vectors_path().display());
}
