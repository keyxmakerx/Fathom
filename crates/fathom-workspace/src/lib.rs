//! `17`'s format home. Today it holds exactly one thing: the **plaintext dev
//! face**, and it says so on line two of every file it writes.
//!
//! > THIS FILE IS PLAINTEXT. EVERY PROTECTION THE WORKSPACE HAS ENDS HERE.
//!
//! That sentence (`17` §15.5) is not commentary. It is the second line of the
//! format, byte for byte, checked on read as well as on write: a file whose
//! warning has been edited away is refused, not tolerated.
//!
//! **Nothing here is a workspace.** `.context/conventions.md` defines a
//! workspace as *"one encrypted document"*, and this face is not encrypted.
//! The crate is `17`'s implementation home and the sealed container will land
//! in it; until then, no string, constant or sentence in this crate calls the
//! plain face a workspace.
//!
//! **There is no cryptography here, and no integrity field, on purpose.** The
//! primitives are specified (`32`), their implementation is deliberately not
//! hand-rolled (`32` §15), and the route to the crates that would implement
//! them is an owner decision nobody has taken (WO-05 §2.1). A plaintext
//! trailer digest would be theatre; a keyed one belongs to the sealed format.
//!
//! **Bytes in, bytes out.** No filesystem, no clock, no RNG, no path
//! discovery, no default location: the file lives where the caller — one day,
//! the user (`46` §1) — chose, and this crate never chooses.
//!
//! The format, in five lines:
//!
//! ```text
//! line 1   fathom-plain 1
//! line 2   THIS FILE IS PLAINTEXT. EVERY PROTECTION THE WORKSPACE HAS ENDS HERE.
//! line 3   schema 0.1
//! line 4   (empty)
//! line 5   <the snapshot as canonical JSON, one line, ending in the final LF>
//! ```
//!
//! Line 1 carries the face version and is checked before anything else, which
//! is `17` §2.2's rule: *"An old build must know it cannot read a file before
//! spending Argon2id on it."* Line 3 carries the generated schema version and
//! is matched exactly; migration policy is deliberately not this crate's
//! (WO-05 §10.2).

#![forbid(unsafe_code)]

use std::collections::BTreeMap;

use fathom_canon::Json;
use fathom_graph::{
    Actor, Batch, BatchId, Confidence, EdgeId, EdgeSnap, ElementId, FieldSnap, Graph,
    HistoryEntrySnap, HistorySnap, IdParseError, NodeId, NodeSnap, Op, Origin, ProvenanceId,
    ProvenanceRecord, Snapshot, SnapshotError, StoredPresence, Timestamp, UserId,
};
use fathom_id::Ulid;
use fathom_ir::bag::FieldKey;
use fathom_ir::generated::ir_types::{FIELD_KEYS, SCHEMA_VERSION};

/// Line 1's magic. Deliberately not `.fathom`'s: this face does not claim the
/// sealed container's name, and it does not claim `17` §15.2's `fathom-json`
/// either (WO-05 §10.3).
pub const PLAIN_MAGIC: &str = "fathom-plain";

/// The face format version. Checked for exact equality before anything else
/// is read (`17` §2.2).
pub const PLAIN_FACE_VERSION: u32 = 1;

/// `17` §15.5, verbatim. Line 2 of every file this crate writes, and a
/// condition of reading one.
pub const PLAIN_WARNING: &str =
    "THIS FILE IS PLAINTEXT. EVERY PROTECTION THE WORKSPACE HAS ENDS HERE.";

/// The extension a file of these bytes may wear — never `.fathom`, and never
/// any sealed extension (`17` §2.1, §12.2).
pub const PLAIN_EXTENSION: &str = "fplain";

/// Why the plain face refused.
#[derive(Debug)]
pub enum PlainError {
    /// Line 1 is not `fathom-plain <n>` — the sealed envelope magic included.
    NotPlainFace,
    UnsupportedFaceVersion {
        found: String,
    },
    /// Line 2 is not [`PLAIN_WARNING`], byte for byte.
    MissingPlaintextBanner,
    SchemaVersionMismatch {
        found: String,
        supported: &'static str,
    },
    MalformedHeader {
        line: u32,
    },
    Json(fathom_canon::ParseError),
    /// The body's structure is wrong at a named point.
    Shape {
        path: String,
        expected: &'static str,
    },
    Canon(fathom_ir::canon::CanonError),
    Snapshot(SnapshotError),
    Id(IdParseError),
    NotPlainExtension {
        name: String,
    },
    MasqueradingName {
        name: String,
    },
}

impl From<fathom_canon::ParseError> for PlainError {
    fn from(e: fathom_canon::ParseError) -> Self {
        PlainError::Json(e)
    }
}

impl From<SnapshotError> for PlainError {
    fn from(e: SnapshotError) -> Self {
        PlainError::Snapshot(e)
    }
}

impl From<IdParseError> for PlainError {
    fn from(e: IdParseError) -> Self {
        PlainError::Id(e)
    }
}

// ---------------------------------------------------------------------------
// The file

/// A graph as the five-line plaintext face. A pure function of the graph.
pub fn write_plain(graph: &Graph) -> Result<Vec<u8>, PlainError> {
    let snapshot = graph.to_snapshot()?;
    let mut out = String::new();
    out.push_str(PLAIN_MAGIC);
    out.push(' ');
    out.push_str(&PLAIN_FACE_VERSION.to_string());
    out.push('\n');
    out.push_str(PLAIN_WARNING);
    out.push('\n');
    out.push_str("schema ");
    out.push_str(SCHEMA_VERSION);
    out.push('\n');
    out.push('\n');
    let mut bytes = out.into_bytes();
    bytes.extend_from_slice(&snapshot_to_json(&snapshot).to_canonical_bytes());
    Ok(bytes)
}

/// The exact inverse of [`write_plain`], checking in the order that makes a
/// refusal deterministic: magic, face version, banner, schema version, the
/// blank line, then the body.
pub fn read_plain(bytes: &[u8]) -> Result<Graph, PlainError> {
    // 1 — the magic, before the file is even shaped into lines. The sealed
    // envelope's `FTHM\x1fREC` lands here, which is the point: a build must
    // know what it is not holding before it does anything with it.
    let mut magic = PLAIN_MAGIC.as_bytes().to_vec();
    magic.push(b' ');
    if !bytes.starts_with(&magic) {
        return Err(PlainError::NotPlainFace);
    }

    let (header, body) = split_header(bytes)?;

    // 2 — the face version, before anything expensive or refusable (17 §2.2).
    let version = String::from_utf8_lossy(&header[0][magic.len()..]).into_owned();
    if version != PLAIN_FACE_VERSION.to_string() {
        return Err(PlainError::UnsupportedFaceVersion { found: version });
    }

    // 3 — the banner, byte for byte.
    if header[1] != PLAIN_WARNING.as_bytes() {
        return Err(PlainError::MissingPlaintextBanner);
    }

    // 4 — the schema version, exact match. Migration policy is not this
    // crate's (WO-05 §10.2), so a difference is a refusal and nothing else.
    let line3 =
        core::str::from_utf8(header[2]).map_err(|_| PlainError::MalformedHeader { line: 3 })?;
    let declared = line3
        .strip_prefix("schema ")
        .ok_or(PlainError::MalformedHeader { line: 3 })?;
    if declared != SCHEMA_VERSION {
        return Err(PlainError::SchemaVersionMismatch {
            found: declared.to_owned(),
            supported: SCHEMA_VERSION,
        });
    }

    // 5 — the blank line.
    if !header[3].is_empty() {
        return Err(PlainError::MalformedHeader { line: 4 });
    }

    let json = Json::parse_canonical(body)?;
    let snapshot = snapshot_from_json(&json)?;
    Ok(Graph::from_snapshot(&snapshot)?)
}

/// The refuse-to-masquerade rule for anyone naming a file after these bytes:
/// the name must end `.fplain`, and must not contain `.fathom` anywhere, nor
/// end in any sealed extension (`17` §2.1, §12.2). Checks a name; opens
/// nothing.
pub fn check_plain_name(name: &str) -> Result<(), PlainError> {
    const SEALED: [&str; 3] = [".frec", ".fcap", ".fm"];
    if name.contains(".fathom") || SEALED.iter().any(|e| name.ends_with(e)) {
        return Err(PlainError::MasqueradingName {
            name: name.to_owned(),
        });
    }
    if !name.ends_with(&format!(".{PLAIN_EXTENSION}")) {
        return Err(PlainError::NotPlainExtension {
            name: name.to_owned(),
        });
    }
    Ok(())
}

/// The four header lines and the body that follows them.
fn split_header(bytes: &[u8]) -> Result<([&[u8]; 4], &[u8]), PlainError> {
    let mut lines: [&[u8]; 4] = [&[]; 4];
    let mut at = 0usize;
    for (i, slot) in lines.iter_mut().enumerate() {
        let end = bytes[at..]
            .iter()
            .position(|b| *b == b'\n')
            .map(|p| at + p)
            .ok_or(PlainError::MalformedHeader { line: i as u32 + 1 })?;
        *slot = &bytes[at..end];
        at = end + 1;
    }
    Ok((lines, &bytes[at..]))
}

// ---------------------------------------------------------------------------
// Snapshot -> JSON. Module-private free functions: the orphan rule bars trait
// impls here, and the shape is this crate's, not `fathom-graph`'s.

fn obj(pairs: Vec<(&str, Json)>) -> Json {
    let mut m = BTreeMap::new();
    for (k, v) in pairs {
        m.insert(k.to_owned(), v);
    }
    Json::Obj(m)
}

fn tagged(tag: &str, payload: Json) -> Json {
    obj(vec![(tag, payload)])
}

fn ulid_json(u: Ulid) -> Json {
    Json::Str(u.encode())
}

fn presence_token(p: StoredPresence) -> &'static str {
    match p {
        StoredPresence::Set => "set",
        StoredPresence::Absent => "absent",
        StoredPresence::Unknown => "unknown",
    }
}

fn field_name(key: FieldKey) -> Option<&'static str> {
    FIELD_KEYS
        .iter()
        .find(|(_, k)| *k == key.0)
        .map(|(n, _)| *n)
}

fn field_key(name: &str) -> Option<FieldKey> {
    FIELD_KEYS
        .iter()
        .find(|(n, _)| *n == name)
        .map(|(_, k)| FieldKey(*k))
}

/// A slot map, keyed by the registry wire name. `Unknown` never appears here:
/// the snapshot type does not admit it and `to_snapshot` refuses it.
fn fields_to_json(fields: &[FieldSnap]) -> Json {
    let mut m = BTreeMap::new();
    for f in fields {
        let mut entry = vec![
            ("presence", Json::Str(presence_token(f.presence).to_owned())),
            ("prov", ulid_json(f.prov.0)),
        ];
        if let Some(v) = &f.value {
            entry.push(("value", v.clone()));
        }
        // A key with no registry name cannot occur: the snapshot came from a
        // store that refused undeclared keys at write time. Rendering the
        // number keeps the function total without inventing a name.
        let name = field_name(f.key).map_or_else(|| f.key.0.to_string(), str::to_owned);
        m.insert(name, obj(entry));
    }
    Json::Obj(m)
}

fn node_to_json(n: &NodeSnap) -> Json {
    let mut pairs = vec![
        ("existence", ulid_json(n.existence.0)),
        ("fields", fields_to_json(&n.fields)),
        ("id", Json::Str(n.id.to_string())),
    ];
    if let Some(at) = n.absent_since {
        pairs.push(("absent_since", Json::Int(at.0 as i64)));
    }
    obj(pairs)
}

fn edge_to_json(e: &EdgeSnap) -> Json {
    let mut pairs = vec![
        ("fields", fields_to_json(&e.fields)),
        ("from", Json::Str(e.from.to_string())),
        ("id", Json::Str(e.id.to_string())),
        ("prov", ulid_json(e.prov.0)),
        ("to", Json::Str(e.to.to_string())),
    ];
    if let Some(at) = e.absent_since {
        pairs.push(("absent_since", Json::Int(at.0 as i64)));
    }
    obj(pairs)
}

fn provenance_to_json(r: &ProvenanceRecord) -> Json {
    let Actor::User(UserId(user)) = r.asserted_by;
    let confidence = match r.confidence {
        Confidence::Asserted => "asserted",
        Confidence::Derived => "derived",
        Confidence::Heuristic => "heuristic",
    };
    let origin = match r.origin {
        Origin::Hand => "hand",
    };
    let mut pairs = vec![
        ("asserted_at", Json::Int(r.asserted_at.0 as i64)),
        ("asserted_by", tagged("user", ulid_json(user))),
        ("confidence", Json::Str(confidence.to_owned())),
        ("id", ulid_json(r.id.0)),
        ("origin", Json::Str(origin.to_owned())),
    ];
    if let Some(s) = r.supersedes {
        pairs.push(("supersedes", ulid_json(s.0)));
    }
    obj(pairs)
}

fn history_entry_to_json(e: &HistoryEntrySnap) -> Json {
    let mut pairs = vec![
        ("presence", Json::Str(presence_token(e.presence).to_owned())),
        ("prov", ulid_json(e.prov.0)),
    ];
    if let Some(v) = &e.value {
        pairs.push(("value", v.clone()));
    }
    obj(pairs)
}

fn history_to_json(h: &HistorySnap) -> Json {
    obj(vec![
        ("element", Json::Str(h.element.to_string())),
        (
            "entries",
            Json::Arr(h.entries.iter().map(history_entry_to_json).collect()),
        ),
        (
            "field",
            Json::Str(field_name(h.key).map_or_else(|| h.key.0.to_string(), str::to_owned)),
        ),
        ("truncated", Json::Int(i64::from(h.truncated))),
    ])
}

fn op_to_json(op: &Op) -> Json {
    match op {
        Op::AddNode { node, prov } => tagged(
            "add_node",
            obj(vec![
                ("node", Json::Str(node.to_string())),
                ("prov", ulid_json(prov.0)),
            ]),
        ),
        Op::AddEdge {
            edge,
            from,
            to,
            prov,
        } => tagged(
            "add_edge",
            obj(vec![
                ("edge", Json::Str(edge.to_string())),
                ("from", Json::Str(from.to_string())),
                ("prov", ulid_json(prov.0)),
                ("to", Json::Str(to.to_string())),
            ]),
        ),
        Op::SetField {
            element,
            key,
            presence,
            prov,
        } => tagged(
            "set_field",
            obj(vec![
                ("element", Json::Str(element.to_string())),
                (
                    "key",
                    Json::Str(field_name(*key).map_or_else(|| key.0.to_string(), str::to_owned)),
                ),
                ("presence", Json::Str(presence_token(*presence).to_owned())),
                ("prov", ulid_json(prov.0)),
            ]),
        ),
        Op::Tombstone { element, at } => tagged(
            "tombstone",
            obj(vec![
                ("at", Json::Int(at.0 as i64)),
                ("element", Json::Str(element.to_string())),
            ]),
        ),
    }
}

fn batch_to_json(b: &Batch) -> Json {
    obj(vec![
        ("id", ulid_json(b.id.0)),
        ("label", Json::Str(b.label.clone())),
        ("ops", Json::Arr(b.ops.iter().map(op_to_json).collect())),
    ])
}

fn snapshot_to_json(s: &Snapshot) -> Json {
    obj(vec![
        (
            "batches",
            Json::Arr(s.batches.iter().map(batch_to_json).collect()),
        ),
        (
            "edges",
            Json::Arr(s.edges.iter().map(edge_to_json).collect()),
        ),
        (
            "history",
            Json::Arr(s.history.iter().map(history_to_json).collect()),
        ),
        (
            "nodes",
            Json::Arr(s.nodes.iter().map(node_to_json).collect()),
        ),
        (
            "provenance",
            Json::Arr(s.provenance.iter().map(provenance_to_json).collect()),
        ),
    ])
}

// ---------------------------------------------------------------------------
// JSON -> Snapshot

fn shape(path: &str, expected: &'static str) -> PlainError {
    PlainError::Shape {
        path: path.to_owned(),
        expected,
    }
}

fn get_obj<'a>(j: &'a Json, path: &str) -> Result<&'a BTreeMap<String, Json>, PlainError> {
    match j {
        Json::Obj(m) => Ok(m),
        _ => Err(shape(path, "a JSON object")),
    }
}

fn get_arr<'a>(j: &'a Json, path: &str) -> Result<&'a [Json], PlainError> {
    match j {
        Json::Arr(items) => Ok(items),
        _ => Err(shape(path, "a JSON array")),
    }
}

fn get_str<'a>(j: &'a Json, path: &str) -> Result<&'a str, PlainError> {
    match j {
        Json::Str(s) => Ok(s),
        _ => Err(shape(path, "a JSON string")),
    }
}

fn get_u64(j: &Json, path: &str) -> Result<u64, PlainError> {
    match j {
        Json::Int(i) if *i >= 0 => Ok(*i as u64),
        _ => Err(shape(path, "a non-negative JSON integer")),
    }
}

fn key<'a>(m: &'a BTreeMap<String, Json>, k: &str, path: &str) -> Result<&'a Json, PlainError> {
    m.get(k).ok_or_else(|| shape(path, "a required key"))
}

/// A bare ULID string, in the one spelling it is allowed to have.
fn read_ulid(j: &Json, path: &str) -> Result<Ulid, PlainError> {
    let text = get_str(j, path)?;
    let decoded = Ulid::decode(text).map_err(|e| PlainError::Id(IdParseError::Ulid(e)))?;
    if decoded.encode() != text {
        return Err(PlainError::Id(IdParseError::NonCanonicalUlid));
    }
    Ok(decoded)
}

fn read_presence(j: &Json, path: &str) -> Result<StoredPresence, PlainError> {
    match get_str(j, path)? {
        "set" => Ok(StoredPresence::Set),
        "absent" => Ok(StoredPresence::Absent),
        "unknown" => Ok(StoredPresence::Unknown),
        _ => Err(shape(path, "one of set / absent / unknown")),
    }
}

fn read_field_key(j: &Json, path: &str) -> Result<FieldKey, PlainError> {
    let name = get_str(j, path)?;
    field_key(name).ok_or_else(|| shape(path, "a declared field wire name"))
}

fn read_fields(j: &Json, path: &str) -> Result<Vec<FieldSnap>, PlainError> {
    let m = get_obj(j, path)?;
    let mut out = Vec::with_capacity(m.len());
    for (name, entry) in m {
        let here = format!("{path}.{name}");
        let key = field_key(name).ok_or_else(|| shape(&here, "a declared field wire name"))?;
        let e = get_obj(entry, &here)?;
        let presence = read_presence(key_or(e, "presence", &here)?, &here)?;
        let prov = ProvenanceId(read_ulid(key_or(e, "prov", &here)?, &here)?);
        let value = e.get("value").cloned();
        out.push(FieldSnap {
            key,
            presence,
            value,
            prov,
        });
    }
    // The registry name order is not the key order, so the vector is sorted
    // into the ascending-key order the snapshot's contract states.
    out.sort_by_key(|f| f.key);
    Ok(out)
}

fn key_or<'a>(m: &'a BTreeMap<String, Json>, k: &str, path: &str) -> Result<&'a Json, PlainError> {
    key(m, k, &format!("{path}.{k}"))
}

fn read_absent_since(
    m: &BTreeMap<String, Json>,
    path: &str,
) -> Result<Option<Timestamp>, PlainError> {
    match m.get("absent_since") {
        None => Ok(None),
        Some(j) => Ok(Some(Timestamp(get_u64(j, path)?))),
    }
}

fn snapshot_from_json(j: &Json) -> Result<Snapshot, PlainError> {
    let root = get_obj(j, "$")?;
    for k in root.keys() {
        if !["batches", "edges", "history", "nodes", "provenance"].contains(&k.as_str()) {
            return Err(shape("$", "only the five declared top-level keys"));
        }
    }

    let mut nodes = Vec::new();
    for (i, item) in get_arr(key(root, "nodes", "$.nodes")?, "$.nodes")?
        .iter()
        .enumerate()
    {
        let path = format!("$.nodes[{i}]");
        let m = get_obj(item, &path)?;
        nodes.push(NodeSnap {
            id: NodeId::parse(get_str(key_or(m, "id", &path)?, &path)?)?,
            existence: ProvenanceId(read_ulid(key_or(m, "existence", &path)?, &path)?),
            absent_since: read_absent_since(m, &path)?,
            fields: read_fields(key_or(m, "fields", &path)?, &format!("{path}.fields"))?,
        });
    }

    let mut edges = Vec::new();
    for (i, item) in get_arr(key(root, "edges", "$.edges")?, "$.edges")?
        .iter()
        .enumerate()
    {
        let path = format!("$.edges[{i}]");
        let m = get_obj(item, &path)?;
        edges.push(EdgeSnap {
            id: EdgeId::parse(get_str(key_or(m, "id", &path)?, &path)?)?,
            from: NodeId::parse(get_str(key_or(m, "from", &path)?, &path)?)?,
            to: NodeId::parse(get_str(key_or(m, "to", &path)?, &path)?)?,
            prov: ProvenanceId(read_ulid(key_or(m, "prov", &path)?, &path)?),
            absent_since: read_absent_since(m, &path)?,
            fields: read_fields(key_or(m, "fields", &path)?, &format!("{path}.fields"))?,
        });
    }

    let mut provenance = Vec::new();
    for (i, item) in get_arr(key(root, "provenance", "$.provenance")?, "$.provenance")?
        .iter()
        .enumerate()
    {
        let path = format!("$.provenance[{i}]");
        let m = get_obj(item, &path)?;
        let actor = get_obj(key_or(m, "asserted_by", &path)?, &path)?;
        let user = actor
            .get("user")
            .ok_or_else(|| shape(&path, "an actor object with a `user` key"))?;
        if actor.len() != 1 {
            return Err(shape(&path, "a one-key actor object"));
        }
        let confidence = match get_str(key_or(m, "confidence", &path)?, &path)? {
            "asserted" => Confidence::Asserted,
            "derived" => Confidence::Derived,
            "heuristic" => Confidence::Heuristic,
            _ => return Err(shape(&path, "one of asserted / derived / heuristic")),
        };
        let origin = match get_str(key_or(m, "origin", &path)?, &path)? {
            "hand" => Origin::Hand,
            _ => return Err(shape(&path, "the one shipped origin, `hand`")),
        };
        provenance.push(ProvenanceRecord {
            id: ProvenanceId(read_ulid(key_or(m, "id", &path)?, &path)?),
            origin,
            asserted_at: Timestamp(get_u64(key_or(m, "asserted_at", &path)?, &path)?),
            asserted_by: Actor::User(UserId(read_ulid(user, &path)?)),
            confidence,
            supersedes: match m.get("supersedes") {
                None => None,
                Some(s) => Some(ProvenanceId(read_ulid(s, &path)?)),
            },
        });
    }

    let mut history = Vec::new();
    for (i, item) in get_arr(key(root, "history", "$.history")?, "$.history")?
        .iter()
        .enumerate()
    {
        let path = format!("$.history[{i}]");
        let m = get_obj(item, &path)?;
        let mut entries = Vec::new();
        for (n, e) in get_arr(key_or(m, "entries", &path)?, &path)?
            .iter()
            .enumerate()
        {
            let here = format!("{path}.entries[{n}]");
            let e = get_obj(e, &here)?;
            entries.push(HistoryEntrySnap {
                presence: read_presence(key_or(e, "presence", &here)?, &here)?,
                value: e.get("value").cloned(),
                prov: ProvenanceId(read_ulid(key_or(e, "prov", &here)?, &here)?),
            });
        }
        let truncated = get_u64(key_or(m, "truncated", &path)?, &path)?;
        history.push(HistorySnap {
            element: ElementId::parse(get_str(key_or(m, "element", &path)?, &path)?)?,
            key: read_field_key(key_or(m, "field", &path)?, &path)?,
            entries,
            truncated: u32::try_from(truncated)
                .map_err(|_| shape(&path, "a truncated count within u32"))?,
        });
    }

    let mut batches = Vec::new();
    for (i, item) in get_arr(key(root, "batches", "$.batches")?, "$.batches")?
        .iter()
        .enumerate()
    {
        let path = format!("$.batches[{i}]");
        let m = get_obj(item, &path)?;
        let mut ops = Vec::new();
        for (n, o) in get_arr(key_or(m, "ops", &path)?, &path)?.iter().enumerate() {
            ops.push(read_op(o, &format!("{path}.ops[{n}]"))?);
        }
        batches.push(Batch {
            id: BatchId(read_ulid(key_or(m, "id", &path)?, &path)?),
            label: get_str(key_or(m, "label", &path)?, &path)?.to_owned(),
            ops,
        });
    }

    Ok(Snapshot {
        nodes,
        edges,
        provenance,
        history,
        batches,
    })
}

fn read_op(j: &Json, path: &str) -> Result<Op, PlainError> {
    let m = get_obj(j, path)?;
    if m.len() != 1 {
        return Err(shape(path, "a one-key op object"));
    }
    let (tag, payload) = m.iter().next().expect("length checked");
    let p = get_obj(payload, path)?;
    match tag.as_str() {
        "add_node" => Ok(Op::AddNode {
            node: NodeId::parse(get_str(key_or(p, "node", path)?, path)?)?,
            prov: ProvenanceId(read_ulid(key_or(p, "prov", path)?, path)?),
        }),
        "add_edge" => Ok(Op::AddEdge {
            edge: EdgeId::parse(get_str(key_or(p, "edge", path)?, path)?)?,
            from: NodeId::parse(get_str(key_or(p, "from", path)?, path)?)?,
            to: NodeId::parse(get_str(key_or(p, "to", path)?, path)?)?,
            prov: ProvenanceId(read_ulid(key_or(p, "prov", path)?, path)?),
        }),
        "set_field" => Ok(Op::SetField {
            element: ElementId::parse(get_str(key_or(p, "element", path)?, path)?)?,
            key: read_field_key(key_or(p, "key", path)?, path)?,
            presence: read_presence(key_or(p, "presence", path)?, path)?,
            prov: ProvenanceId(read_ulid(key_or(p, "prov", path)?, path)?),
        }),
        "tombstone" => Ok(Op::Tombstone {
            element: ElementId::parse(get_str(key_or(p, "element", path)?, path)?)?,
            at: Timestamp(get_u64(key_or(p, "at", path)?, path)?),
        }),
        _ => Err(shape(path, "one of the four op tags")),
    }
}
