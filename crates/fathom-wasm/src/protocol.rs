//! The byte protocol: 41 §3.3's T2 packed skeleton (a fixed header, fixed-width
//! records, one trailing UTF-8 string blob) plus 41 §3.9's error reply, decided
//! down to the offset in WO-07 §4.4.
//!
//! Everything is little-endian, written with `to_le_bytes` and read with
//! `from_le_bytes`, because the reader on the other side is `DataView` with
//! `littleEndian = true` (41 §3.4's worked row).
//!
//! The encoding of a reply is a pure function of its content: records in
//! order, each record's string fields appended to the blob in field order, no
//! de-duplication (invariant 9).

use fathom_corpus::model::Entry;
use fathom_corpus::{CorpusIndex, Risk, SourceFile};
use fathom_find::{Finder, Ranked, SearchResult, CONFIDENT_MILLI};

pub const REPLY_MAGIC: [u8; 4] = *b"FDLT";
pub const REPLY_VERSION: u16 = 1;
pub const KIND_ERROR: u16 = 0;
pub const KIND_FINDER_ROW: u16 = 3;
pub const ERROR_STRIDE: u32 = 28;
/// Stride 88, not 72: seven string refs rather than five. Both additions exist
/// so the page can render a row without composing one.
///
/// **s5, the verification stamp.** ADR-0027 §3 makes it required chrome on
/// every finder row rather than metadata in a file — *"the product's only
/// unforgeable differentiator currently lives in a YAML field"*. It travels
/// with the row for the same reason the field key travels with an inventory
/// field (`encode_element_reply`): platform and version train are per-entry
/// facts, and a page that spelled `junos-srx` into its own chrome would keep
/// saying it on the day a second platform's corpus loads.
///
/// **s6, the risk caption.** ADR-0011: *"the caption is the default rendering
/// of the band and may be overridden per corpus entry where the default is
/// untrue"*. One entry in the seed corpus already overrides it
/// (`CHANGES STATE — NOT REVERSIBLE BY COMMIT`), so a page holding the three
/// default captions in an array would render that row's caption wrongly today,
/// not merely one day. The risk *byte* still chooses the colour channel — the
/// three inks are closed and are not sent.
pub const FINDER_ROW_STRIDE: u32 = 88;
pub const ROLE_SUMMARY: u8 = 0;
pub const ROLE_SHOWN: u8 = 1;
pub const ROLE_BELOW: u8 = 2;

/// How many string slots one finder record carries.
const FINDER_SLOTS: usize = 7;

/// Row flag bit 2 (value 4): the entry behind this row carries no named
/// reviewer, so nothing about it has been checked by a human against a box
/// (invariant 10). A **bit**, not a string the page pattern-matches: the row's
/// register is a typed fact, and deriving it by inspecting the stamp text is
/// how a rendering quietly starts disagreeing with the corpus.
pub const ROW_UNVERIFIED: u8 = 4;
pub const ERR_UNKNOWN_OP: u16 = 1;
pub const ERR_NOT_INITIALISED: u16 = 2;
pub const ERR_CORPUS_LOAD: u16 = 3;
pub const ERR_BAD_FRAME: u16 = 4;
pub const ERR_BAD_UTF8: u16 = 5;

// --- the face record (WO-08 §4.4) --------------------------------------------
//
// Record kinds 0–4 are taken (41 §3.3); 5 is the face's. Stride 72:
//
//   offset  size  field
//   0       1     role
//   1       3     zero
//   4       4     slot_count (u32)
//   8       64    eight (u32 off, u32 len) string refs, s0–s7
//
// Everything else is WO-07 §4.3–§4.5's, reused unchanged: little-endian, the
// FDLT skeleton, the string-blob rules, the error record, the arena lifetime.

pub const KIND_FACE_ROW: u16 = 5;
pub const FACE_ROW_STRIDE: u32 = 72;
/// Role byte values.
pub const FACE_HEADER: u8 = 0;
pub const FACE_INV: u8 = 1;
pub const FACE_FIELD: u8 = 2;
pub const FACE_PORT: u8 = 3;
pub const FACE_IFACE: u8 = 4;

// --- the paste reply ---------------------------------------------------------
//
// Three more roles on the same stride-72 record. No new record kind: the reply
// is a list of labelled string rows, which is exactly what KIND_FACE_ROW is,
// and a second skeleton would be a second decoder in the page for no gain.
//
// The reply is deliberately shaped around `14`'s governing rule — NOTHING
// PARSED IS SILENTLY LOST — so the residue is not a footnote in the summary,
// it is rows. A caller that renders only `FACE_PASTE` shows a number; a caller
// that renders the residue rows shows the user which of their lines Fathom did
// not understand, which is the honest half of the answer.

/// The one summary row, always record 0. Slots, all decimal strings except the
/// last three: nodes · edges · residue lines · secrets redacted · unresolved ·
/// device display id · hostname · platform.
pub const FACE_PASTE: u8 = 5;
/// One line the parser did not bind: line number · the line as stored (post
/// redaction) · why.
pub const FACE_RESIDUE: u8 = 6;
/// One reference the capture named and did not contain: what it named · the
/// edge kind that wanted it · the line number.
pub const FACE_UNRESOLVED: u8 = 7;
/// The paste as the REDACTION GATE left it — one row, slot 0, the whole text.
///
/// This exists so the page can journal a paste without journalling the secret
/// that was in it. The page holds only the raw text the operator pasted; the
/// redacted text exists only inside the module, because `RedactedCapture`'s
/// field is private and its one constructor is `pub(crate)` and is called from
/// exactly one place, the end of `ingest()`. So there is no way to obtain
/// redacted text except by running the gate, which is the point.
///
/// **A journal built from the raw paste would put a pre-shared key in the
/// operator's export file.** Invariant 3 is the whole reason this row exists.
pub const FACE_CAPTURE: u8 = 8;

/// One diagram box: display id · kind · label · x · y · w · h · **aggregation**.
///
/// Slot 7 is three space-separated fields — `<count> <interior> <group key>`,
/// the last possibly empty:
///
/// | field | meaning |
/// |---|---|
/// | `count` | how many graph nodes the box stands for. `1` is a plain box, and only then is slot 0 an element id the page may post to [`crate::OP_ELEMENT`] |
/// | `interior` | edges with both ends inside this box, drawn nowhere |
/// | `group key` | the aggregation group it belongs to, or empty |
///
/// Three facts in one slot because [`FACE_SLOTS`] is eight and this record
/// already used seven: widening the face record would change the stride of
/// every face in the protocol, and one space-separated triple is a much smaller
/// thing to explain than that. Group keys contain no spaces
/// (`agg:<kind>:<ulid>#<offset>`), so the split is unambiguous.
///
/// The count is not optional decoration. `59` §3.6: a collapse that does not
/// say how many it hid is *"a lie with fewer elements"*, so the number crosses
/// the boundary with the box rather than being something the page could choose
/// not to ask for.
pub const FACE_BOX: u8 = 9;
/// One routed line: from id · to id · edge kind · "1" when containment ·
/// the points as `x,y x,y ...` · how many graph edges it stands for.
pub const FACE_LINE: u8 = 10;
/// The drawing's extent: width · height. One row, always first.
///
/// When the caller passed a layer mask (`56` §4) the row carries four more
/// slots: the mask as a decimal 5-bit number · boxes the mask hid · lines it hid
/// · boxes drawn that `56` §4.1 has no row for. `slot_count` is 2 without a mask
/// and 6 with one, so an empty slot 2 means *"no layer projection was applied"*
/// and is a different claim from *"all five layers are on"* — the two differ by
/// §4.1's inspector-only kinds.
///
/// The counts travel because `59`'s governing rule applies to a layer toggle as
/// much as to an aggregate: a picture that hides things without saying how many
/// is a lie with fewer elements. The extent itself is the UNION layout's and
/// does not change with the mask (`56` §3.6).
pub const FACE_CANVAS: u8 = 11;

/// Codes 1–5 are WO-07's.
pub const ERR_NO_ELEMENT: u16 = 6;
/// The paste frame is shorter than its fixed 24-byte clock+entropy prefix, or
/// the text after it is not UTF-8. Distinct from `ERR_BAD_FRAME` so the page
/// can tell a malformed call from a paste the parser refused.
pub const ERR_PASTE_FRAME: u16 = 7;
/// `fathom_ingest::ingest` refused the input before parsing it: not UTF-8, or
/// past `14` §11.4's caps.
pub const ERR_INGEST_REFUSED: u16 = 8;
/// The weld refused to apply the fragment. The detail carries the refusal.
pub const ERR_WELD_REFUSED: u16 = 9;
/// The paste parsed without error and **bound nothing**: not one line became a
/// fact. Almost always the wrong text — a config from another vendor, or Junos
/// in its curly-brace form rather than `| display set`.
///
/// It is a distinct code because it is not a failure of the paste so much as a
/// failure of the *choice* of paste, and the page's remedy is different: tell
/// the operator what Fathom expected and keep what they already had.
pub const ERR_NOTHING_UNDERSTOOD: u16 = 10;

/// A hand-entered value is not what the schema declares that field to be — a
/// misspelt role, an out-of-range member index, a hostname that is not an
/// identifier.
///
/// Distinct from `ERR_BAD_FRAME` because it is not a protocol fault: the frame
/// was well-formed and the person simply typed something the field cannot hold.
/// The page's remedy differs accordingly — keep the form open, keep what they
/// typed, and say which field and why.
pub const ERR_FIELD_VALUE: u16 = 11;

/// The hand-entry frame itself is malformed: too short for its prefix, a field
/// count that overruns the buffer, a key that names nothing in `schema/`. A
/// page defect rather than an operator one.
pub const ERR_EQUIP_FRAME: u16 = 12;

/// The store refused a hand-authored write — a cardinality bound, a reused
/// provenance id, a containment rule. Carries the store's own words: these are
/// the errors that mean Fathom's model disagrees with what was asked for, and
/// paraphrasing them would lose the only diagnosis available.
pub const ERR_EQUIP_STORE: u16 = 13;

/// A paste arrived before the dictionary did.
///
/// A real state since 2026-08-15, when the statement dictionary stopped being
/// compiled into the module and started arriving over `OP_DICT`. Before that
/// the module could always fall back on `include_str!`; now there is nothing to
/// fall back on, and the two wrong answers are a panic and a silent empty
/// parse. The second is worse: an empty dictionary matches no statement, so
/// every line becomes residue and the page would report a perfectly well-formed
/// config as *"none of these lines is one Fathom knows"*, blaming the operator
/// for a boot the page failed to complete.
///
/// Distinct from `ERR_NOT_INITIALISED`, which already means two other things
/// (no corpus for `OP_QUERY`, no estate for the face opcodes). The remedy here
/// is the page's and only the page's: call `OP_DICT` first.
pub const ERR_NO_DICTIONARY: u16 = 14;

/// How many string slots one face record carries.
const FACE_SLOTS: usize = 8;

/// The fixed header: magic, version, record_kind, record_count, record_stride.
const HEADER_LEN: usize = 16;

// --- encoding ----------------------------------------------------------------

/// Encode §4.4's OP_INIT frame from bare-named sources. The reference
/// encoder: WO-08's build step and this crate's tests both use it.
pub fn pack_corpus(files: &[SourceFile]) -> Vec<u8> {
    let mut out = Vec::new();
    out.extend_from_slice(&(files.len() as u32).to_le_bytes());
    for f in files {
        out.push(section_byte(f.section));
        out.extend_from_slice(&(f.name.len() as u32).to_le_bytes());
        out.extend_from_slice(f.name.as_bytes());
        out.extend_from_slice(&(f.source.len() as u32).to_le_bytes());
        out.extend_from_slice(f.source.as_bytes());
    }
    out
}

fn section_byte(section: fathom_corpus::Section) -> u8 {
    match section {
        fathom_corpus::Section::Commands => 0,
        fathom_corpus::Section::Explainers => 1,
        fathom_corpus::Section::Rules => 2,
    }
}

/// The trailing string blob under construction, with the `(offset, len)` pairs
/// the records carry into it.
#[derive(Default)]
struct Blob {
    bytes: Vec<u8>,
}

impl Blob {
    /// `(0, 0)` encodes the empty string; otherwise `offset` indexes the blob.
    fn push(&mut self, s: &str) -> (u32, u32) {
        if s.is_empty() {
            return (0, 0);
        }
        let off = self.bytes.len() as u32;
        self.bytes.extend_from_slice(s.as_bytes());
        (off, s.len() as u32)
    }
}

fn header(kind: u16, count: u32, stride: u32) -> Vec<u8> {
    let mut out = Vec::with_capacity(HEADER_LEN);
    out.extend_from_slice(&REPLY_MAGIC);
    out.extend_from_slice(&REPLY_VERSION.to_le_bytes());
    out.extend_from_slice(&kind.to_le_bytes());
    out.extend_from_slice(&count.to_le_bytes());
    out.extend_from_slice(&stride.to_le_bytes());
    out
}

pub fn encode_error(code: u16, detail: &str) -> Vec<u8> {
    let mut blob = Blob::default();
    let (off, len) = blob.push(detail);
    let mut out = header(KIND_ERROR, 1, ERROR_STRIDE);
    out.extend_from_slice(&code.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes());
    out.extend_from_slice(&0u64.to_le_bytes());
    out.extend_from_slice(&0u64.to_le_bytes());
    out.extend_from_slice(&off.to_le_bytes());
    out.extend_from_slice(&len.to_le_bytes());
    out.extend_from_slice(&(blob.bytes.len() as u32).to_le_bytes());
    out.extend_from_slice(&blob.bytes);
    out
}

fn risk_byte(risk: Risk) -> u8 {
    match risk {
        Risk::ReadOnly => 0,
        Risk::ChangesConfig => 1,
        Risk::Disruptive => 2,
    }
}

/// The same quantisation `fathom-find` applies to the score (§8.4).
fn milli(v: f64) -> i32 {
    (v * 1000.0).round() as i32
}

/// One FinderRow record before it becomes 88 bytes.
struct Record {
    role: u8,
    risk: u8,
    flags: u8,
    entry: u32,
    score_milli: i32,
    contributions_milli: [i32; 5],
    strings: [(u32, u32); FINDER_SLOTS],
}

fn write_finder_record(out: &mut Vec<u8>, r: &Record) {
    out.push(r.role);
    out.push(r.risk);
    out.push(r.flags);
    out.push(0);
    out.extend_from_slice(&r.entry.to_le_bytes());
    out.extend_from_slice(&r.score_milli.to_le_bytes());
    for c in r.contributions_milli {
        out.extend_from_slice(&c.to_le_bytes());
    }
    for (off, len) in r.strings {
        out.extend_from_slice(&off.to_le_bytes());
        out.extend_from_slice(&len.to_le_bytes());
    }
}

fn row_flags(r: &Ranked, e: &Entry) -> u8 {
    let mut f = 0u8;
    if r.score_milli < CONFIDENT_MILLI {
        f |= 1;
    }
    if !e.next_if_bad.is_empty() {
        f |= 2;
    }
    if is_unverified(e) {
        f |= ROW_UNVERIFIED;
    }
    f
}

/// Invariant 10's test, and the same one `fathom_corpus::gates` applies: a
/// `reviewed_by` that opens with `<` is the `<named human>` placeholder rather
/// than a person. Empty counts too — an absent reviewer is not a reviewed
/// entry, and the two must not render differently.
fn is_unverified(e: &Entry) -> bool {
    e.reviewed_by.trim().is_empty() || e.reviewed_by.starts_with('<')
}

/// ADR-0027 §3's stamp, composed from what the corpus actually holds and from
/// nothing else.
///
/// The ADR's worked form is `junos-srx 21.4R3 · verified 2026-05-12 · K. Okafor`
/// — three facts: platform-and-train, a date, a name. This corpus can supply
/// two of them: `platform` and `versions`. **There is no `verified_on` field in
/// `61` §3 and none is invented here** (ADR-0008: a field that is not declared
/// does not exist), so the stamp claims a review and never a bench run, and the
/// unverified form says which of the two is missing rather than going quiet.
///
/// `versions: "*"` — every train — is dropped rather than printed. A stamp
/// reading `junos-srx *` looks like a version and is the absence of one.
fn verification_stamp(e: &Entry) -> String {
    let train = if e.versions == "*" || e.versions.is_empty() {
        String::new()
    } else {
        format!(" {}", e.versions)
    };
    if is_unverified(e) {
        format!(
            "{}{train} · unverified — no named reviewer, not run on a box",
            e.platform
        )
    } else {
        format!("{}{train} · reviewed by {}", e.platform, e.reviewed_by)
    }
}

/// The corpus-wide review line, carried on the summary record of every query
/// reply so the finder cannot render results without rendering this.
///
/// It is counted here rather than stated in the page, because a page holding
/// the number `98` would still be holding it on the day someone reviews an
/// entry. When the count reaches zero the line says so and stops being an
/// alarm, which is the behaviour that makes it safe to leave in the chrome
/// permanently.
pub fn review_line(index: &CorpusIndex) -> String {
    let total = index.corpus.entries.len();
    let unverified = index
        .corpus
        .entries
        .iter()
        .filter(|e| is_unverified(e))
        .count();
    if unverified == 0 {
        format!("{total} command entries · every one reviewed by a named human")
    } else {
        format!(
            "{unverified} of {total} command entries are unverified — \
             nothing here has been run on a box, and `reviewed_by` is still a placeholder \
             (invariant 10)"
        )
    }
}

fn summary_flags(result: &SearchResult) -> u8 {
    let mut f = 0u8;
    if result.ladder_group_trigger {
        f |= 1;
    }
    if let Some(rev) = &result.reverse {
        f |= 2;
        if rev.full {
            f |= 4;
        }
    }
    if result.filter_clause.is_some() {
        f |= 8;
    }
    f
}

pub fn encode_query_reply(finder: &Finder, result: &SearchResult) -> Vec<u8> {
    let idx = &finder.index;
    let mut blob = Blob::default();
    let mut records: Vec<u8> = Vec::new();

    // Record 0 — the query summary. `risk` is 0 and not meaningful here.
    let captures = match &result.reverse {
        None => String::new(),
        Some(rev) => rev
            .captures
            .iter()
            .map(|(slot, value)| format!("{slot} := {value}"))
            .collect::<Vec<_>>()
            .join("\n"),
    };
    let summary_strings = [
        blob.push(result.filter_clause.as_deref().unwrap_or("")),
        blob.push(&match &result.reverse {
            None => String::new(),
            Some(rev) => idx.display_cmd(rev.entry),
        }),
        blob.push(match &result.reverse {
            None => "",
            Some(rev) => idx.entry(rev.entry).id.as_str(),
        }),
        blob.push(&captures),
        blob.push(&match &result.reverse {
            None => String::new(),
            Some(rev) => rev.leftover.join(" "),
        }),
        // Slot 5 on the summary is the corpus's own review state. It rides the
        // reply every query already makes rather than a second opcode, so there
        // is no ordering in which the page can have rows on screen and not have
        // this line.
        blob.push(&review_line(idx)),
        // s6 is the risk caption on a result row and is meaningless here.
        (0, 0),
    ];
    write_finder_record(
        &mut records,
        &Record {
            role: ROLE_SUMMARY,
            risk: 0,
            flags: summary_flags(result),
            entry: result.query_concepts.concepts.len() as u32,
            score_milli: milli(result.g_syn),
            contributions_milli: [0; 5],
            strings: summary_strings,
        },
    );

    for (role, rows) in [(ROLE_SHOWN, &result.shown), (ROLE_BELOW, &result.below)] {
        for r in rows.iter() {
            let e = idx.entry(r.entry);
            let next_if_bad = e.next_if_bad.first().map(String::as_str).unwrap_or("");
            let strings = [
                blob.push(&idx.display_cmd(r.entry)),
                blob.push(&e.id),
                blob.push(&e.answers),
                blob.push(&e.read_field),
                blob.push(next_if_bad),
                blob.push(&verification_stamp(e)),
                blob.push(e.risk_caption_override.as_deref().unwrap_or(e.risk.label())),
            ];
            let c = &r.contributions;
            write_finder_record(
                &mut records,
                &Record {
                    role,
                    risk: risk_byte(e.risk),
                    flags: row_flags(r, e),
                    entry: r.entry,
                    score_milli: r.score_milli,
                    contributions_milli: [
                        milli(c.concept),
                        milli(c.lexical),
                        milli(c.syntax),
                        milli(c.context),
                        milli(c.prior),
                    ],
                    strings,
                },
            );
        }
    }

    let count = 1 + result.shown.len() + result.below.len();
    let mut out = header(KIND_FINDER_ROW, count as u32, FINDER_ROW_STRIDE);
    out.extend_from_slice(&records);
    out.extend_from_slice(&(blob.bytes.len() as u32).to_le_bytes());
    out.extend_from_slice(&blob.bytes);
    out
}

// --- the face encoders (WO-08 §4.4) ------------------------------------------

/// One face record before it becomes 72 bytes. The encoders copy the
/// projections' strings verbatim; nothing is recomputed here.
struct FaceRecord {
    role: u8,
    slot_count: u32,
    strings: [(u32, u32); FACE_SLOTS],
}

fn write_face_record(out: &mut Vec<u8>, r: &FaceRecord) {
    out.push(r.role);
    out.extend_from_slice(&[0, 0, 0]);
    out.extend_from_slice(&r.slot_count.to_le_bytes());
    for (off, len) in r.strings {
        out.extend_from_slice(&off.to_le_bytes());
        out.extend_from_slice(&len.to_le_bytes());
    }
}

/// Push a record's slots s0–s7 into the blob in order; empty slots contribute
/// nothing, and there is no de-duplication (invariant 9).
fn face_slots(blob: &mut Blob, role: u8, slot_count: u32, slots: &[&str]) -> FaceRecord {
    let mut strings = [(0u32, 0u32); FACE_SLOTS];
    for (i, s) in slots.iter().take(FACE_SLOTS).enumerate() {
        strings[i] = blob.push(s);
    }
    FaceRecord {
        role,
        slot_count,
        strings,
    }
}

fn face_reply(records: Vec<u8>, count: usize, blob: Blob) -> Vec<u8> {
    let mut out = header(KIND_FACE_ROW, count as u32, FACE_ROW_STRIDE);
    out.extend_from_slice(&records);
    out.extend_from_slice(&(blob.bytes.len() as u32).to_le_bytes());
    out.extend_from_slice(&blob.bytes);
    out
}

pub fn encode_inv_reply(
    kind_label: &str,
    columns: &[&str],
    rows: &[fathom_inventory::Row],
) -> Vec<u8> {
    let mut blob = Blob::default();
    let mut records: Vec<u8> = Vec::new();
    // 2 = the kind label plus the opinions header; the columns sit between.
    let slot_count = 2 + columns.len() as u32;

    let mut header_slots: Vec<&str> = Vec::with_capacity(FACE_SLOTS);
    header_slots.push(kind_label);
    header_slots.extend(columns.iter().copied());
    while header_slots.len() < FACE_SLOTS - 1 {
        header_slots.push("");
    }
    header_slots.push("opinions");
    let rec = face_slots(&mut blob, FACE_HEADER, slot_count, &header_slots);
    write_face_record(&mut records, &rec);

    for row in rows {
        let mut slots: Vec<&str> = Vec::with_capacity(FACE_SLOTS);
        slots.push(row.id.as_str());
        slots.extend(row.cells.iter().map(String::as_str));
        while slots.len() < FACE_SLOTS - 1 {
            slots.push("");
        }
        slots.push(row.opinions);
        let rec = face_slots(&mut blob, FACE_INV, slot_count, &slots);
        write_face_record(&mut records, &rec);
    }

    face_reply(records, 1 + rows.len(), blob)
}

fn write_element(
    blob: &mut Blob,
    records: &mut Vec<u8>,
    page: &fathom_inventory::ElementPage,
) -> usize {
    let rec = face_slots(
        blob,
        FACE_HEADER,
        4,
        &[
            page.kind_word,
            page.name.as_str(),
            page.id.as_str(),
            page.context.as_deref().unwrap_or(""),
        ],
    );
    write_face_record(records, &rec);
    for f in &page.fields {
        // Slot 3 is the field's wire key and slot 4 is whether it can be typed
        // in. Both travel WITH the row rather than being looked up on the page,
        // because a name-to-key table in JavaScript is how a form ends up
        // writing one field into another's slot.
        let key = f.key.0.to_string();
        let rec = face_slots(
            blob,
            FACE_FIELD,
            5,
            &[
                f.name,
                f.value.as_str(),
                f.provenance.as_str(),
                key.as_str(),
                if f.editable { "1" } else { "" },
            ],
        );
        write_face_record(records, &rec);
    }
    1 + page.fields.len()
}

pub fn encode_element_reply(page: &fathom_inventory::ElementPage) -> Vec<u8> {
    let mut blob = Blob::default();
    let mut records: Vec<u8> = Vec::new();
    let count = write_element(&mut blob, &mut records, page);
    face_reply(records, count, blob)
}

/// `None` is the empty state, not an error: kind 5 with `record_count = 0`.
pub fn encode_equipment_reply(page: Option<&fathom_inventory::EquipmentPage>) -> Vec<u8> {
    let mut blob = Blob::default();
    let mut records: Vec<u8> = Vec::new();
    let Some(page) = page else {
        return face_reply(records, 0, blob);
    };
    let mut count = write_element(&mut blob, &mut records, &page.element);

    for p in &page.ports {
        let (cable, far) = match &p.cabled {
            Some(c) => (c.text.as_str(), c.far_device.as_str()),
            None => ("—", ""),
        };
        let rec = face_slots(
            &mut blob,
            FACE_PORT,
            7,
            &[
                p.id.as_str(),
                p.label.as_str(),
                p.chassis.as_str(),
                p.connector.as_str(),
                p.service.as_str(),
                cable,
                far,
            ],
        );
        write_face_record(&mut records, &rec);
        count += 1;
    }

    for i in &page.interfaces {
        let rec = face_slots(
            &mut blob,
            FACE_IFACE,
            4,
            &[
                i.id.as_str(),
                i.name.as_str(),
                i.kind_word,
                i.ports.as_str(),
            ],
        );
        write_face_record(&mut records, &rec);
        count += 1;
    }

    face_reply(records, count, blob)
}

/// What one paste produced: the summary row, then the lines that were not
/// understood, then the references that were named and not found.
///
/// Numbers arrive as strings. That is deliberate: every one of them is a count
/// the page prints and never computes with, and a decimal string cannot be
/// read as the wrong width by a `DataView`. `summary[2]` is the **total**
/// residue count, which may exceed `residue.len()` when the caller capped the
/// rows — the page can then say how many it is not showing rather than
/// implying it showed them all.
pub struct PasteReply<'a> {
    /// nodes · edges · residue lines · secrets redacted · unresolved ·
    /// device display id · hostname · platform.
    pub summary: [&'a str; 8],
    /// line number · the line as stored · why it was not understood.
    pub residue: &'a [[String; 3]],
    /// what was named · the edge kind that wanted it · line number.
    pub unresolved: &'a [[String; 3]],
    /// The post-redaction text, for the page's journal. Empty for replies that
    /// are not a paste.
    pub capture: &'a str,
}

/// The diagram, as face rows. Numbers travel as decimal strings for the same
/// reason every other face row does: one decoder in the page, not two.
///
/// `filter` is `Some` exactly when the caller asked for a layer mask. It is
/// reported rather than merely obeyed: the page prints the mask it got back, so
/// a picture and its toggles can never disagree about which layers produced it.
pub fn encode_diagram(
    d: &fathom_layout::Diagram,
    filter: Option<&fathom_layout::layers::Filter>,
) -> Vec<u8> {
    let mut blob = Blob::default();
    let mut records: Vec<u8> = Vec::new();

    let (w, h) = (d.width.to_string(), d.height.to_string());
    let rec = match filter {
        None => face_slots(&mut blob, FACE_CANVAS, 2, &[w.as_str(), h.as_str()]),
        Some(f) => {
            let (m, hn, hl, un) = (
                f.mask.bits().to_string(),
                f.hidden_objects.to_string(),
                f.hidden_edges.to_string(),
                f.untabled_nodes.to_string(),
            );
            face_slots(
                &mut blob,
                FACE_CANVAS,
                6,
                &[
                    w.as_str(),
                    h.as_str(),
                    m.as_str(),
                    hn.as_str(),
                    hl.as_str(),
                    un.as_str(),
                ],
            )
        }
    };
    write_face_record(&mut records, &rec);

    for n in &d.nodes {
        let (x, y, bw, bh) = (
            n.x.to_string(),
            n.y.to_string(),
            n.w.to_string(),
            n.h.to_string(),
        );
        let agg = format!("{} {} {}", n.count, n.interior, n.group);
        let rec = face_slots(
            &mut blob,
            FACE_BOX,
            8,
            &[
                n.id.as_str(),
                n.kind,
                n.label.as_str(),
                x.as_str(),
                y.as_str(),
                bw.as_str(),
                bh.as_str(),
                agg.as_str(),
            ],
        );
        write_face_record(&mut records, &rec);
    }

    for l in &d.links {
        let mut pts = String::new();
        for (i, (x, y)) in l.points.iter().enumerate() {
            if i > 0 {
                pts.push(' ');
            }
            pts.push_str(&x.to_string());
            pts.push(',');
            pts.push_str(&y.to_string());
        }
        let members = l.members.to_string();
        let rec = face_slots(
            &mut blob,
            FACE_LINE,
            6,
            &[
                l.from.as_str(),
                l.to.as_str(),
                l.kind,
                if l.containment { "1" } else { "" },
                pts.as_str(),
                members.as_str(),
            ],
        );
        write_face_record(&mut records, &rec);
    }

    face_reply(records, 1 + d.nodes.len() + d.links.len(), blob)
}

pub fn encode_paste_reply(reply: &PasteReply<'_>) -> Vec<u8> {
    let mut blob = Blob::default();
    let mut records: Vec<u8> = Vec::new();

    let rec = face_slots(&mut blob, FACE_PASTE, 8, &reply.summary);
    write_face_record(&mut records, &rec);

    for (role, rows) in [
        (FACE_RESIDUE, reply.residue),
        (FACE_UNRESOLVED, reply.unresolved),
    ] {
        for row in rows {
            let slots = [row[0].as_str(), row[1].as_str(), row[2].as_str()];
            let rec = face_slots(&mut blob, role, 3, &slots);
            write_face_record(&mut records, &rec);
        }
    }

    let mut extra = 0;
    if !reply.capture.is_empty() {
        let rec = face_slots(&mut blob, FACE_CAPTURE, 1, &[reply.capture]);
        write_face_record(&mut records, &rec);
        extra = 1;
    }

    face_reply(
        records,
        1 + reply.residue.len() + reply.unresolved.len() + extra,
        blob,
    )
}

// --- decoding ----------------------------------------------------------------

/// The reference reader — the decoder tests parity against, and the byte-
/// level specification WO-08's TypeScript reader mirrors.
#[derive(Debug, Clone)]
pub struct FinderRowView {
    pub role: u8,
    pub risk: u8,
    pub flags: u8,
    pub entry: u32,
    pub score_milli: i32,
    pub contributions_milli: [i32; 5],
    pub strings: [String; FINDER_SLOTS],
}

#[derive(Debug, Clone)]
pub struct ErrorView {
    pub code: u16,
    pub detail: String,
}

/// One decoded face record (WO-08 §4.4). `strings` carries every slot,
/// whether or not `slot_count` declares it meaningful.
#[derive(Debug, Clone)]
pub struct FaceRowView {
    pub role: u8,
    pub slot_count: u32,
    pub strings: [String; FACE_SLOTS],
}

#[derive(Debug, Clone)]
pub enum ReplyView {
    Empty,
    Error(ErrorView),
    FinderRows(Vec<FinderRowView>),
    FaceRows(Vec<FaceRowView>),
}

fn u16_at(bytes: &[u8], off: usize) -> u16 {
    u16::from_le_bytes([bytes[off], bytes[off + 1]])
}

fn u32_at(bytes: &[u8], off: usize) -> u32 {
    u32::from_le_bytes([bytes[off], bytes[off + 1], bytes[off + 2], bytes[off + 3]])
}

fn i32_at(bytes: &[u8], off: usize) -> i32 {
    u32_at(bytes, off) as i32
}

fn string_at(blob: &[u8], bytes: &[u8], off: usize) -> Result<String, String> {
    let s_off = u32_at(bytes, off) as usize;
    let s_len = u32_at(bytes, off + 4) as usize;
    if s_len == 0 {
        return Ok(String::new());
    }
    let end = s_off
        .checked_add(s_len)
        .ok_or_else(|| format!("string ref at offset {off} overflows"))?;
    if end > blob.len() {
        return Err(format!("string ref at offset {off} runs past the blob"));
    }
    std::str::from_utf8(&blob[s_off..end])
        .map(str::to_owned)
        .map_err(|e| format!("string ref at offset {off} is not UTF-8: {e}"))
}

/// Refuses a bad magic, version, kind, stride, count, or out-of-blob string
/// ref with a message naming the offset. Empty input decodes to Empty.
pub fn decode_reply(bytes: &[u8]) -> Result<ReplyView, String> {
    if bytes.is_empty() {
        return Ok(ReplyView::Empty);
    }
    if bytes.len() < HEADER_LEN {
        return Err(format!(
            "reply is {} bytes: shorter than the {HEADER_LEN}-byte header at offset 0",
            bytes.len()
        ));
    }
    if bytes[0..4] != REPLY_MAGIC {
        return Err("bad magic at offset 0".to_owned());
    }
    let version = u16_at(bytes, 4);
    if version != REPLY_VERSION {
        return Err(format!("unknown version {version} at offset 4"));
    }
    let kind = u16_at(bytes, 6);
    let count = u32_at(bytes, 8) as usize;
    let stride = u32_at(bytes, 12);
    let expected_stride = match kind {
        KIND_ERROR => ERROR_STRIDE,
        KIND_FINDER_ROW => FINDER_ROW_STRIDE,
        KIND_FACE_ROW => FACE_ROW_STRIDE,
        _ => return Err(format!("unknown record_kind {kind} at offset 6")),
    };
    if stride != expected_stride {
        return Err(format!(
            "record_stride {stride} at offset 12 is not {expected_stride} for record_kind {kind}"
        ));
    }
    let records_len = count
        .checked_mul(stride as usize)
        .ok_or_else(|| format!("record_count {count} at offset 8 overflows"))?;
    let blob_len_off = HEADER_LEN
        .checked_add(records_len)
        .ok_or_else(|| format!("record_count {count} at offset 8 overflows"))?;
    if bytes.len() < blob_len_off + 4 {
        return Err(format!(
            "record_count {count} at offset 8 runs past the reply"
        ));
    }
    let blob_len = u32_at(bytes, blob_len_off) as usize;
    let blob_off = blob_len_off + 4;
    if bytes.len() != blob_off + blob_len {
        return Err(format!(
            "strings_len {blob_len} at offset {blob_len_off} does not match the reply length"
        ));
    }
    let blob = &bytes[blob_off..];

    match kind {
        KIND_ERROR => {
            if count != 1 {
                return Err(format!(
                    "record_count {count} at offset 8: an error reply carries exactly one record"
                ));
            }
            let base = HEADER_LEN;
            Ok(ReplyView::Error(ErrorView {
                code: u16_at(bytes, base),
                detail: string_at(blob, bytes, base + 20)?,
            }))
        }
        KIND_FACE_ROW => {
            let mut rows = Vec::with_capacity(count);
            for i in 0..count {
                let base = HEADER_LEN + i * stride as usize;
                let mut strings: [String; FACE_SLOTS] = Default::default();
                for (s, slot) in strings.iter_mut().enumerate() {
                    *slot = string_at(blob, bytes, base + 8 + s * 8)?;
                }
                rows.push(FaceRowView {
                    role: bytes[base],
                    slot_count: u32_at(bytes, base + 4),
                    strings,
                });
            }
            Ok(ReplyView::FaceRows(rows))
        }
        _ => {
            let mut rows = Vec::with_capacity(count);
            for i in 0..count {
                let base = HEADER_LEN + i * stride as usize;
                let mut strings: [String; FINDER_SLOTS] = Default::default();
                for (s, slot) in strings.iter_mut().enumerate() {
                    *slot = string_at(blob, bytes, base + 32 + s * 8)?;
                }
                rows.push(FinderRowView {
                    role: bytes[base],
                    risk: bytes[base + 1],
                    flags: bytes[base + 2],
                    entry: u32_at(bytes, base + 4),
                    score_milli: i32_at(bytes, base + 8),
                    contributions_milli: [
                        i32_at(bytes, base + 12),
                        i32_at(bytes, base + 16),
                        i32_at(bytes, base + 20),
                        i32_at(bytes, base + 24),
                        i32_at(bytes, base + 28),
                    ],
                    strings,
                });
            }
            Ok(ReplyView::FinderRows(rows))
        }
    }
}
