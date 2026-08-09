//! Opcode dispatch over WO-07 §4.4's byte protocol. One call, one reply; a
//! failure is a typed error record, never a trap and never an unwind across
//! the boundary (41 §3.9).
//!
//! The shell owns the only mutable state in the module: the finder, absent
//! until `OP_INIT` succeeds. Nothing here reads a clock, draws entropy or
//! touches a filesystem — which is why the built module's import section is
//! empty (`wasmbin::IMPORT_ALLOWLIST`).

use fathom_corpus::{CorpusIndex, Section, SourceFile};
use fathom_find::Finder;

use crate::protocol::{
    self, ERR_BAD_FRAME, ERR_BAD_UTF8, ERR_CORPUS_LOAD, ERR_INGEST_REFUSED, ERR_NOT_INITIALISED,
    ERR_NO_ELEMENT, ERR_PASTE_FRAME, ERR_UNKNOWN_OP, ERR_WELD_REFUSED,
};
use crate::{OP_ELEMENT, OP_EQUIPMENT, OP_ESTATE_DEMO, OP_INIT, OP_INV_ROWS, OP_PASTE, OP_QUERY};

pub struct Shell {
    finder: Option<Finder>,
    /// The inventory face's graph (WO-08 §4.4). Absent until
    /// `OP_ESTATE_DEMO` or `OP_PASTE` succeeds; the only workspace this build
    /// ever holds.
    estate: Option<fathom_graph::Graph>,
    /// The junos-srx statement dictionary, compiled in and built on first
    /// paste. Held rather than rebuilt because every paste needs the same one
    /// and building it parses six YAML files and runs the WO-03 §4.7 gates.
    dict: Option<fathom_ingest::dict::Dictionary>,
}

impl Shell {
    pub fn new() -> Shell {
        Shell {
            finder: None,
            estate: None,
            dict: None,
        }
    }

    /// One call, one reply (empty = success with nothing to say).
    pub fn handle(&mut self, op: u32, req: &[u8]) -> Vec<u8> {
        match op {
            OP_INIT => match self.init(req) {
                Ok(()) => Vec::new(),
                Err((code, detail)) => protocol::encode_error(code, &detail),
            },
            OP_QUERY => self.query(req),
            OP_ESTATE_DEMO => self.estate_demo(req),
            OP_PASTE => self.paste(req),
            OP_INV_ROWS => self.inv_rows(req),
            OP_ELEMENT => self.element(req),
            OP_EQUIPMENT => self.equipment(req),
            _ => protocol::encode_error(
                ERR_UNKNOWN_OP,
                &format!("opcode {op} is not implemented by this module"),
            ),
        }
    }

    /// No request bytes. Re-init is permitted, mirroring `OP_INIT`: the held
    /// estate is replaced.
    fn estate_demo(&mut self, req: &[u8]) -> Vec<u8> {
        if !req.is_empty() {
            return protocol::encode_error(
                ERR_BAD_FRAME,
                &format!("OP_ESTATE_DEMO takes no request; got {} bytes", req.len()),
            );
        }
        self.estate = Some(fathom_inventory::demo_estate());
        Vec::new()
    }

    /// `OP_PASTE`: pasted text in, an estate out.
    ///
    /// Frame — a fixed 24-byte prefix, then the paste:
    ///
    /// ```text
    ///   0   8   at_ms   (u64) the host's clock, once, for the whole apply
    ///   8  16   entropy (u128) the host's CSPRNG, once, the mint's base
    ///  24   ..  the pasted bytes, verbatim and un-decoded
    /// ```
    ///
    /// Both are the host's because this module has neither and must not
    /// acquire either — the import section is empty and stays empty
    /// (`wasmbin::IMPORT_ALLOWLIST`). `fathom_weld::Manifest` is shaped for
    /// exactly this: invariant 9 puts nondeterminism at the host boundary and
    /// nowhere else.
    ///
    /// The paste is handed on **un-decoded**. `ingest` does its own UTF-8
    /// check and reports the offset of the first bad byte, which is a better
    /// answer than this layer's "not UTF-8".
    ///
    /// On success the held estate is replaced. A refusal leaves the previous
    /// estate in place: a paste that Fathom could not read is not a reason to
    /// throw away the one it could.
    fn paste(&mut self, req: &[u8]) -> Vec<u8> {
        const PREFIX: usize = 24;
        let Some(head) = req.get(..PREFIX) else {
            return protocol::encode_error(
                ERR_PASTE_FRAME,
                &format!(
                    "OP_PASTE needs a {PREFIX}-byte clock and entropy prefix; the frame is {} bytes",
                    req.len()
                ),
            );
        };
        let (at_bytes, entropy_bytes) = head.split_at(8);
        let mut at = [0u8; 8];
        at.copy_from_slice(at_bytes);
        let mut entropy = [0u8; 16];
        entropy.copy_from_slice(entropy_bytes);
        let at = fathom_graph::Timestamp(u64::from_le_bytes(at));
        let entropy = u128::from_le_bytes(entropy);
        let text = req.get(PREFIX..).unwrap_or_default();

        if self.dict.is_none() {
            match fathom_ingest::dict::Dictionary::embedded() {
                Ok(d) => self.dict = Some(d),
                Err(e) => {
                    return protocol::encode_error(
                        ERR_CORPUS_LOAD,
                        &format!(
                            "the compiled-in dictionary failed to load: {} line {}: {}",
                            e.file, e.line, e.message
                        ),
                    )
                }
            }
        }
        let Some(dict) = self.dict.as_ref() else {
            return protocol::encode_error(ERR_CORPUS_LOAD, "no dictionary");
        };

        let ingest = match fathom_ingest::ingest(text, dict) {
            Ok(o) => o,
            Err(e) => return protocol::encode_error(ERR_INGEST_REFUSED, &refusal_text(e)),
        };

        // The user and batch ids: the millisecond plus a fixed discriminator,
        // the pattern `fathom-inventory`'s demo estate and the weld's own
        // tests both use. Colliding with a minted element ULID is harmless —
        // `by_ulid` covers nodes and edges only, and batch ids are checked
        // against other batch ids, of which a fresh graph has none.
        let ids = |n: u128| fathom_id::Ulid::from_parts(at.0, n);
        let (Ok(user), Ok(batch)) = (ids(1), ids(2)) else {
            return protocol::encode_error(
                ERR_PASTE_FRAME,
                &format!(
                    "the clock reads {} ms, which is past the ULID ceiling",
                    at.0
                ),
            );
        };
        let manifest = fathom_weld::Manifest {
            at,
            entropy,
            actor: fathom_graph::Actor::User(fathom_graph::UserId(user)),
            batch: fathom_graph::BatchId(batch),
            label: PASTE_LABEL,
            platform: fathom_ir::scalar::PlatformId(dict.platform().to_owned()),
        };

        let mut graph = fathom_graph::Graph::new();
        let weld = match fathom_weld::apply_new_device(&mut graph, &ingest, &manifest) {
            Ok(w) => w,
            Err(e) => return protocol::encode_error(ERR_WELD_REFUSED, &format!("{e:?}")),
        };

        let reply = paste_reply(&graph, &ingest, &weld, dict);
        self.estate = Some(graph);
        reply
    }

    fn inv_rows(&mut self, req: &[u8]) -> Vec<u8> {
        let kind = match req {
            [0] => fathom_inventory::InvKind::Device,
            [1] => fathom_inventory::InvKind::PhysicalPort,
            [2] => fathom_inventory::InvKind::Premises,
            [b] => {
                return protocol::encode_error(
                    ERR_BAD_FRAME,
                    &format!("kind byte {b} is not 0, 1 or 2"),
                )
            }
            other => {
                return protocol::encode_error(
                    ERR_BAD_FRAME,
                    &format!("OP_INV_ROWS takes exactly one byte; got {}", other.len()),
                )
            }
        };
        let Some(estate) = self.estate.as_ref() else {
            return protocol::encode_error(ERR_NOT_INITIALISED, "no estate loaded");
        };
        protocol::encode_inv_reply(
            kind.label(),
            fathom_inventory::columns(kind),
            &fathom_inventory::rows(estate, kind),
        )
    }

    fn element(&mut self, req: &[u8]) -> Vec<u8> {
        let (estate, node) = match self.node_request(req) {
            Ok(pair) => pair,
            Err(reply) => return reply,
        };
        match fathom_inventory::element_page(estate, node) {
            Some(page) => protocol::encode_element_reply(&page),
            None => protocol::encode_error(ERR_NO_ELEMENT, &String::from_utf8_lossy(req)),
        }
    }

    fn equipment(&mut self, req: &[u8]) -> Vec<u8> {
        let (estate, node) = match self.node_request(req) {
            Ok(pair) => pair,
            Err(reply) => return reply,
        };
        // The anchor rule yielding None is the empty state, not an error.
        protocol::encode_equipment_reply(fathom_inventory::equipment_page(estate, node).as_ref())
    }

    /// The raw UTF-8 display id both element opcodes take, resolved against
    /// the held estate. An edge id is `ERR_NO_ELEMENT`: this face renders
    /// nodes.
    fn node_request<'a>(
        &'a self,
        req: &[u8],
    ) -> Result<(&'a fathom_graph::Graph, fathom_graph::NodeId), Vec<u8>> {
        let text = match std::str::from_utf8(req) {
            Ok(t) => t,
            Err(e) => {
                return Err(protocol::encode_error(
                    ERR_BAD_UTF8,
                    &format!("display id is not UTF-8: {e}"),
                ))
            }
        };
        let Some(estate) = self.estate.as_ref() else {
            return Err(protocol::encode_error(
                ERR_NOT_INITIALISED,
                "no estate loaded",
            ));
        };
        match fathom_inventory::parse_display_id(estate, text) {
            Some(fathom_graph::ElementId::Node(n)) => Ok((estate, n)),
            _ => Err(protocol::encode_error(ERR_NO_ELEMENT, text)),
        }
    }

    fn init(&mut self, req: &[u8]) -> Result<(), (u16, String)> {
        let files = parse_init_frame(req)?;
        let index =
            CorpusIndex::from_sources(&files).map_err(|e| (ERR_CORPUS_LOAD, e.to_string()))?;
        self.finder = Some(Finder::new(index));
        Ok(())
    }

    fn query(&mut self, req: &[u8]) -> Vec<u8> {
        let Some(finder) = self.finder.as_ref() else {
            return protocol::encode_error(
                ERR_NOT_INITIALISED,
                "no corpus is loaded: OP_INIT must succeed before OP_QUERY",
            );
        };
        let query = match std::str::from_utf8(req) {
            Ok(q) => q,
            Err(e) => {
                return protocol::encode_error(ERR_BAD_UTF8, &format!("query is not UTF-8: {e}"))
            }
        };
        let result = finder.search(query);
        protocol::encode_query_reply(finder, &result)
    }
}

impl Default for Shell {
    fn default() -> Shell {
        Shell::new()
    }
}

// --- the paste reply ---------------------------------------------------------

/// The batch's undo label (`53` §7.2, at most 60 bytes).
const PASTE_LABEL: &str = "Paste junos-srx config";

/// How many residue rows one reply carries. The summary always states the
/// **total**, so a page that renders both can say how many it is not showing —
/// `78` §5 forbids the silent cap, not the cap.
const RESIDUE_ROW_CAP: usize = 500;
/// The same, for references the capture named and did not contain.
const UNRESOLVED_ROW_CAP: usize = 200;

fn refusal_text(e: fathom_ingest::IngestRefusal) -> String {
    match e {
        fathom_ingest::IngestRefusal::Undecodable { offset } => {
            format!("the paste is not UTF-8: the first bad byte is at offset {offset}")
        }
        fathom_ingest::IngestRefusal::TooLarge { bytes, lines } => format!(
            "the paste is {bytes} bytes over {lines} lines; the caps are {} and {}",
            fathom_ingest::MAX_PASTE_BYTES,
            fathom_ingest::MAX_PASTE_LINES
        ),
    }
}

/// Why one line was not bound, in the words the person who pasted it would
/// use. Every arm names something they could act on — *"Fathom does not know
/// this statement yet"* is a different problem from *"the paste is clipped"*,
/// and lumping them under "unparsed" hides which one it is.
fn residue_reason(outcome: &fathom_ingest::frame::LineOutcome) -> String {
    use fathom_ingest::frame::{LineOutcome, ShapeError};
    match outcome {
        LineOutcome::Unmapped { known_prefix } => match known_prefix {
            0 => "not in the dictionary".to_owned(),
            1 => "not in the dictionary past the first word".to_owned(),
            n => format!("not in the dictionary past the first {n} words"),
        },
        LineOutcome::Unshaped { reason } => match reason {
            ShapeError::NotVerbInitial => {
                "does not start with a config verb — a clipped or wrapped line".to_owned()
            }
            ShapeError::UnsupportedVerb => "not a `set` statement".to_owned(),
            ShapeError::UnterminatedQuote => "an unclosed quote".to_owned(),
            ShapeError::UnterminatedBracket => "an unclosed bracket".to_owned(),
            ShapeError::UnterminatedContinuation => {
                "ends in a continuation with nothing after it".to_owned()
            }
            ShapeError::KeyUnparsable => {
                "the name this statement configures could not be read".to_owned()
            }
            ShapeError::TooManySegments => "more than 64 words deep".to_owned(),
        },
        LineOutcome::Quarantined { label, orig_len } => format!(
            "held back at the redaction gate: {} ({orig_len} bytes)",
            label.token()
        ),
        // `ingest` builds `residue` from exactly the three arms above, so this
        // is unreachable through `ingest`. Naming the outcome rather than
        // asserting keeps a future fourth arm visible instead of silent.
        other => format!("{other:?}"),
    }
}

fn target_text(target: &fathom_ingest::bind::PendingTarget) -> String {
    use fathom_ingest::bind::PendingTarget;
    match target {
        PendingTarget::ByName { kind, name } => format!("{} {}", kind.name(), name.0),
        PendingTarget::InterfaceUnit { kind, name, unit } => {
            format!("{} {}.{unit}", kind.name(), name.0)
        }
    }
}

/// The reply one successful paste produces: what was understood, what was not,
/// and what was named and not found.
fn paste_reply(
    graph: &fathom_graph::Graph,
    ingest: &fathom_ingest::IngestOutput,
    weld: &fathom_weld::WeldOutput,
    dict: &fathom_ingest::dict::Dictionary,
) -> Vec<u8> {
    let text = ingest.capture.text();

    let residue: Vec<[String; 3]> = ingest
        .residue
        .iter()
        .take(RESIDUE_ROW_CAP)
        .map(|r| {
            let line = text
                .get(r.span.start as usize..r.span.end as usize)
                .unwrap_or_default();
            [
                (r.ordinal.0 + 1).to_string(),
                line.to_owned(),
                residue_reason(&r.outcome),
            ]
        })
        .collect();

    let unresolved: Vec<[String; 3]> = weld
        .unresolved
        .iter()
        .take(UNRESOLVED_ROW_CAP)
        .map(|u| {
            [
                target_text(&u.target),
                u.kind.name().to_owned(),
                (u.line.0 + 1).to_string(),
            ]
        })
        .collect();

    let page = fathom_inventory::element_page(graph, weld.device);
    let (device_id, hostname) = match &page {
        Some(p) => (p.id.as_str(), p.name.as_str()),
        None => ("", ""),
    };

    // Edges: the fragment's own, plus the containment edges the weld
    // materialised. Both are edges in the store and counting only the first
    // would under-report what was built by roughly the node count.
    let edges = (weld.edges.len() + weld.containment.len()).to_string();
    let nodes = weld.nodes.len().to_string();
    let residue_total = ingest.residue.len().to_string();
    let secrets = ingest.drops.entries.len().to_string();
    let unresolved_total = weld.unresolved.len().to_string();

    protocol::encode_paste_reply(&protocol::PasteReply {
        summary: [
            &nodes,
            &edges,
            &residue_total,
            &secrets,
            &unresolved_total,
            device_id,
            hostname,
            dict.platform(),
        ],
        residue: &residue,
        unresolved: &unresolved,
    })
}

/// A cursor over the request bytes that refuses every short read.
struct Cursor<'a> {
    bytes: &'a [u8],
    at: usize,
}

impl<'a> Cursor<'a> {
    fn u8(&mut self) -> Result<u8, (u16, String)> {
        if self.at >= self.bytes.len() {
            return Err((
                ERR_BAD_FRAME,
                format!("frame truncated at byte {}", self.at),
            ));
        }
        let b = self.bytes[self.at];
        self.at += 1;
        Ok(b)
    }

    fn u32(&mut self) -> Result<u32, (u16, String)> {
        if self.at + 4 > self.bytes.len() {
            return Err((
                ERR_BAD_FRAME,
                format!("frame truncated at byte {}", self.at),
            ));
        }
        let v = u32::from_le_bytes([
            self.bytes[self.at],
            self.bytes[self.at + 1],
            self.bytes[self.at + 2],
            self.bytes[self.at + 3],
        ]);
        self.at += 4;
        Ok(v)
    }

    fn text(&mut self, len: u32) -> Result<String, (u16, String)> {
        let len = len as usize;
        let end = self.at.checked_add(len).ok_or_else(|| {
            (
                ERR_BAD_FRAME,
                format!("length overflows at byte {}", self.at),
            )
        })?;
        if end > self.bytes.len() {
            return Err((
                ERR_BAD_FRAME,
                format!("frame truncated at byte {}", self.at),
            ));
        }
        let slice = &self.bytes[self.at..end];
        self.at = end;
        std::str::from_utf8(slice).map(str::to_owned).map_err(|e| {
            (
                ERR_BAD_UTF8,
                format!("not UTF-8 at byte {}: {e}", self.at - len),
            )
        })
    }
}

/// §4.4's OP_INIT frame. Names are labels, never opened: each is prefixed
/// with its section directory so a load error reads the way `load_corpus`'s
/// does.
fn parse_init_frame(req: &[u8]) -> Result<Vec<SourceFile>, (u16, String)> {
    let mut c = Cursor { bytes: req, at: 0 };
    let file_count = c.u32()?;
    let mut files: Vec<SourceFile> = Vec::new();
    for _ in 0..file_count {
        let section = match c.u8()? {
            0 => Section::Commands,
            1 => Section::Explainers,
            2 => Section::Rules,
            other => {
                return Err((
                    ERR_BAD_FRAME,
                    format!("section byte {other} at byte {} is not 0, 1 or 2", c.at - 1),
                ))
            }
        };
        let name_len = c.u32()?;
        let name = c.text(name_len)?;
        let source_len = c.u32()?;
        let source = c.text(source_len)?;
        let name = format!("{}{name}", section_prefix(section));
        if files.iter().any(|f| f.section == section && f.name == name) {
            return Err((
                ERR_BAD_FRAME,
                format!("duplicate source `{name}` in the init frame"),
            ));
        }
        files.push(SourceFile {
            section,
            name,
            source,
        });
    }
    if c.at != req.len() {
        return Err((
            ERR_BAD_FRAME,
            format!(
                "{} trailing bytes after {file_count} sources",
                req.len() - c.at
            ),
        ));
    }
    Ok(files)
}

fn section_prefix(section: Section) -> &'static str {
    match section {
        Section::Commands => "commands/",
        Section::Explainers => "explainers/",
        Section::Rules => "rules/",
    }
}
