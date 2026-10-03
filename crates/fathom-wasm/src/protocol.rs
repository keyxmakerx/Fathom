//! The byte protocol: 41 §3.3's T2 packed skeleton (a fixed header, fixed-width
//! records, one trailing UTF-8 string blob) plus 41 §3.9's error reply, decided
//! to the offset in WO-07 §4.4.
//!
//! Everything is little-endian (`to_le_bytes`/`from_le_bytes`), because the page
//! reads with `DataView` and `littleEndian = true` (41 §3.4).
//!
//! A reply's encoding is a pure function of its content: records in order, each
//! record's string fields appended to the blob in field order, no de-duplication
//! (invariant 9).

use fathom_corpus::model::Entry;
use fathom_corpus::{CorpusIndex, Risk, SourceFile};
use fathom_find::{Finder, Ranked, SearchResult, CONFIDENT_MILLI};

pub const REPLY_MAGIC: [u8; 4] = *b"FDLT";
pub const REPLY_VERSION: u16 = 1;
pub const KIND_ERROR: u16 = 0;
pub const KIND_FINDER_ROW: u16 = 3;
pub const ERROR_STRIDE: u32 = 28;
/// Stride 88, not 72: seven string refs, not five, so the page renders a row
/// without composing one.
///
/// **s5, the verification stamp.** ADR-0027 §3 makes it required chrome on every
/// finder row. It travels with the row because platform and version train are
/// per-entry facts; a page that spelled `junos-srx` into its chrome would keep
/// saying it when a second platform loads.
///
/// **s6, the risk caption.** ADR-0011: the caption is the band's default and may
/// be overridden per corpus entry (one seed entry already does:
/// `CHANGES STATE — NOT REVERSIBLE BY COMMIT`). The risk *byte* still chooses the
/// colour; the three inks are closed and not sent.
pub const FINDER_ROW_STRIDE: u32 = 88;
pub const ROLE_SUMMARY: u8 = 0;
pub const ROLE_SHOWN: u8 = 1;
pub const ROLE_BELOW: u8 = 2;

/// How many string slots one finder record carries.
const FINDER_SLOTS: usize = 7;

/// Row flag bit 2 (value 4): ADR-0027 §2's label. The entry behind this row has
/// **not been run on a box**, so it carries no `verified_on` (61 §3.1).
///
/// Not invariant 10's bit: a missing named reviewer is a different fact, reported
/// separately in the corpus review line. Conflating them let this flag clear
/// itself on an action already scheduled (see `is_unverified`). A **bit**, not a
/// string the page pattern-matches, so rendering cannot drift from the corpus.
pub const ROW_UNVERIFIED: u8 = 4;
pub const ERR_UNKNOWN_OP: u16 = 1;
pub const ERR_NOT_INITIALISED: u16 = 2;
pub const ERR_CORPUS_LOAD: u16 = 3;
pub const ERR_BAD_FRAME: u16 = 4;
pub const ERR_BAD_UTF8: u16 = 5;

// --- the face record (WO-08 §4.4) ---
//
// Record kinds 0–4 are taken (41 §3.3); 5 is the face's. Stride 72:
//
//   offset  size  field
//   0       1     role
//   1       3     zero
//   4       4     slot_count (u32)
//   8       64    eight (u32 off, u32 len) string refs, s0–s7
//
// The rest is WO-07 §4.3–§4.5's, unchanged.

pub const KIND_FACE_ROW: u16 = 5;
pub const FACE_ROW_STRIDE: u32 = 72;
/// Role byte values.
pub const FACE_HEADER: u8 = 0;
pub const FACE_INV: u8 = 1;
pub const FACE_FIELD: u8 = 2;
pub const FACE_PORT: u8 = 3;
pub const FACE_IFACE: u8 = 4;

// --- the paste reply ---
//
// Three more roles on the stride-72 record. No new record kind: the reply is
// labelled string rows, which `KIND_FACE_ROW` already is.
//
// Following `14`'s rule, NOTHING PARSED IS SILENTLY LOST, the residue is rows,
// not a footnote: rendering them shows which lines Fathom did not understand.

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
/// The paste as the REDACTION GATE left it: one row, slot 0, the whole text.
///
/// It lets the page journal a paste without journalling its secret. The page holds
/// only the raw text; redacted text exists only inside the module
/// (`RedactedCapture`'s field is private and its one constructor is `pub(crate)`,
/// called at the end of `ingest()`). **A journal built from the raw paste would put
/// a pre-shared key in the operator's export file** (invariant 3).
pub const FACE_CAPTURE: u8 = 8;

/// One diagram box: display id · kind · label · x · y · w · h · **aggregation**.
///
/// Slot 7 is `<count> <interior> <group key>`, the last possibly empty:
///
/// | field | meaning |
/// |---|---|
/// | `count` | how many graph nodes the box stands for. `1` is a plain box, and only then is slot 0 an element id the page may post to [`crate::OP_ELEMENT`] |
/// | `interior` | edges with both ends inside this box, drawn nowhere |
/// | `group key` | the aggregation group it belongs to, or empty |
///
/// Packed because [`FACE_SLOTS`] is eight and widening changes every face's
/// stride. Group keys have no spaces (`agg:<kind>:<ulid>#<offset>`).
///
/// The count is mandatory: `59` §3.6, a collapse that does not say how many it hid
/// is *"a lie with fewer elements"*.
pub const FACE_BOX: u8 = 9;
/// One routed line: from id · to id · edge kind · "1" when containment ·
/// the points as `x,y x,y ...` · how many graph edges it stands for.
pub const FACE_LINE: u8 = 10;
/// The drawing's extent: width · height. One row, always first.
///
/// With a layer mask (`56` §4) the row carries four more slots: the mask as a
/// decimal 5-bit number · boxes hidden · lines hidden · boxes drawn that `56` §4.1
/// has no row for. `slot_count` is 2 without a mask and 6 with one, so an empty
/// slot 2 means *"no layer projection was applied"*, distinct from *"all five
/// layers are on"* (they differ by §4.1's inspector-only kinds).
///
/// The counts travel because hiding things without saying how many is a lie with
/// fewer elements (`59`). The extent is the UNION layout's, unchanged by the mask
/// (`56` §3.6).
pub const FACE_CANVAS: u8 = 11;

// --- ADR-0036's rack elevation ---
//
// Three roles, so the page tells a box that fits from one that does not without
// re-deriving the arithmetic (`fathom-inventory`: the page computes nothing).
//
// 12/13/14, NOT 8/9/10 (now FACE_CAPTURE, FACE_BOX, FACE_LINE): a face code is a
// wire discriminant, and a collision silently renders one kind as another.

/// The frame itself, always record 0: display id · label · height in units · the
/// numbering token · the direction.
///
/// THE DIRECTION SLOT HAS THREE STATES: `1` U1 at the floor, `0` U1 at the top,
/// **EMPTY for "this build cannot read the token"**. With two states an
/// unreadable token was drawn ascending. The page must not re-derive the answer
/// from the token's spelling (a second copy of the schema in JavaScript). The
/// token travels as text too, so an unrecognised one from a newer schema can be
/// PRINTED.
pub const FACE_RACK: u8 = 12;
/// One placed box: chassis display id · device · chassis · position_u ·
/// height_u (empty = never stated) · face · `1` when it overflows the frame.
pub const FACE_RACK_SLOT: u8 = 13;
/// One pair of boxes whose runs intersect: the two chassis display ids. Reported,
/// never resolved: this face cannot tell which of two conflicting assertions is
/// right.
pub const FACE_RACK_CLASH: u8 = 14;
/// The inventory's editable columns, one record per reply, after the header and
/// before the first row.
///
/// **It mirrors the header's slot layout**: slot 0 is not a column, slots 1..=6
/// are the columns in order, slot 7 is the opinions column. Slots 0 and 7 are
/// empty (the opinions column belongs to a rule engine this build lacks).
///
/// **A data row's slot 7 is not always empty (ADR-0041 D5/D7).** It packs
/// `<opinions> <hints>`, hints last because usually empty (as [`FACE_BOX`], so a
/// trailing space is unambiguous on `split_once(' ')`). `hints` is
/// `fathom_inventory::Row`'s comma-separated 0-based cell indices flagged by
/// `fathom_ingest::redact::looks_like_credential`, computed when the row is built
/// and never stored (ADR-0008: an opinion, not a fact). This KEY row's slot 7
/// stays empty.
///
/// Each slot holds `FieldKey` in decimal, or empty where the column cannot be typed
/// into (a walk, or a type `fathom_inventory::is_authorable` says cannot be parsed
/// from text); `fathom_inventory::column_keys` decides. A record, not a
/// name-to-key table in the page, which could write one field into another's slot.
///
/// **29, not 15: the third face-code collision in two days** (15 went to the shape
/// digest, 16–19 to findings, 20–28 to rung 4, on parallel branches).
/// `artifact.rs`'s `the_pages_face_codes_match_the_modules` now catches it. Read the
/// next free number out of this file.
pub const FACE_INV_KEY: u8 = 29;

// --- the config drawer's two line faces (ADR-0052 §2) ---
//
// Two more roles on the stride-72 record, as every face block gives (the reply
// is labelled string rows, `KIND_FACE_ROW`). 30 and 31 are the next free numbers
// after `FACE_INV_KEY`'s note: read the next free number out of THIS file.

/// One line's fate on a paste, one row per ledger line, in ledger order:
/// `ordinal · outcome token · byte start · byte end · display id it built,
/// or empty · built fields (comma-joined names), or empty · reason or label`.
///
/// **The outcome token is one of `built`, `kept`, `noise`, `quarantined`, never
/// the Rust variant name** (`shell::line_rows` owns the mapping). `built` is
/// `Bound`; `quarantined` is `Quarantined`; `noise` covers `Noise` and `Blank`;
/// `kept` covers what the gate did not destroy and the binder did not use
/// (`Unmapped`, `Unshaped`, `Header`): the drawer's "kept as text" mark.
///
/// **A line can carry both this row and a [`FACE_DROP`] row.** A statement whose
/// value the gate destroyed (the PSK line) still binds, as a `SecretPlaceholder`
/// (a successful parse of an absence), so the line is `built` and the destroyed
/// value gets its own row on the second face.
///
/// Not named `FACE_LINE`: that is the diagram's routed line (code 10).
pub const FACE_PASTE_LINE: u8 = 30;
/// One value the gate destroyed, one row per [`fathom_ingest::redact::DropManifest`]
/// entry: `ordinal · marker byte start · marker byte end, both in the POST-GATE
/// capture · label · detectors, comma-joined`.
///
/// **No slot carries the original value's length**, which is why this is separate
/// from [`FACE_PASTE_LINE`]: `RedactionEntry::orig_len` is "for the in-session
/// report only; the persistence layer must not store it" (`14` §9.5), and this row
/// reaches a page a browser can inspect. `shell::drop_rows` never reads it.
///
/// The marker span IS on the wire, safely: `redact::marker` writes a fixed string
/// per label (`<REDACTED:psk>`), so its width depends on the LABEL, not the secret.
pub const FACE_DROP: u8 = 31;

/// `OP_CHECKS` reply head: `<refuse> <warn> <idea> <rules loaded> <load failed: "1" or "">
/// <rules that ran out of budget>`.
pub const FACE_CHECK_HEAD: u8 = 32;

/// One finding: `<rule id> <severity word> <title> <fix> <why> <concept id> <source>
/// <elements>`. Source is publisher and document, url, note, one per line; elements are
/// `display id TAB name`, one per line, anchor first.
pub const FACE_CHECK: u8 = 33;

/// `OP_PLAN_PREVIEW`, one step: `<step display id> <ordinal> <why it cannot apply, or empty>
/// <impact, one sentence per line> <touches: display id TAB name, one per line>`. Followed by
/// the [`FACE_CHECK`] rows that step adds.
pub const FACE_PLAN_STEP: u8 = 34;

// --- the shape reply (`49` §19 phase 0, item 3) ---

/// The held estate's shape digest: one row, slot 0, 16 lowercase hex characters
/// ([`fathom_graph::shape_hex`] defines what is in it). One slot, no counts: the
/// page has the paste's summary from [`FACE_PASTE`].
///
/// **The value is opaque to the page**: compared for equality, never parsed,
/// truncated, ordered or displayed. It is drift detection, NOT tamper-evidence:
/// FNV-1a is non-cryptographic by specification (RFC 9923, February 2026), so no
/// surface may present it as a seal.
pub const FACE_SHAPE: u8 = 15;

// --- what the estate does not know yet (`57` §13.5.3) ---
//
// Four more roles on the stride-72 record, codes 16–19 (nothing below 16 is free;
// see FACE_RACK on collisions).
//
// NOT CALLED A FINDING ANYWHERE IN THE WIRE FORMAT. `.context/conventions.md`
// reserves that word for "one rule firing against one node", and this build has
// no rule engine. These rows carry a GAP: a `card: "1"` field with no stored
// value. The view is named Findings because it is one of `52`'s six views; its
// content is not findings and must not claim to be.

/// The one summary row, always record 0: gap groups · unstated facts · live
/// elements walked · kinds present · kinds the estate holds none of.
pub const FACE_GAP_HEAD: u8 = 16;
/// One gap group: kind · field · missing · population · examples carried · the
/// sentence · `1` when a person can type this field's value today.
///
/// The sentence is composed in `fathom-inventory` and travels whole: the page
/// computes nothing ("2 of 5" is a computation). Slot 6 is uncomfortable on
/// purpose: both gaps a real estate produces here are fields nothing can type in,
/// so a row that reads as a job is not one yet (`Gap::authorable`).
pub const FACE_GAP: u8 = 17;
/// One element under the group above it: display id · display name · kind · the
/// group's index as a decimal string. The index, not a nesting depth, because the
/// page reassembles the tree from a flat list and record ORDER is not a contract
/// anything else here relies on.
pub const FACE_GAP_ITEM: u8 = 18;
/// A kind the estate holds none of: kind · how many required fields went
/// unchecked.
///
/// Lets the view tell "zero because all are complete" from "zero because there
/// are none" (the true state of `Cable` and `PhysicalPort`, which nothing in this
/// build creates, `57` §6.2). Silence would tell an operator their cabling was
/// finished.
pub const FACE_GAP_EMPTY: u8 = 19;

// --- inside the box, the ladder's fourth rung (`57` §7) ---
//
// Eight roles on the stride-72 record. The bands are FLAT and each child names its
// parent by display id, as `FACE_GAP_ITEM` does: relying on record order breaks
// silently if a band is emitted elsewhere.

/// The head, always record 0: device display id · hostname · interfaces · units ·
/// zones · policy sets · policies · `<routing instances> <tunnels> <unzoned
/// units>` (three decimals in slot 7, as [`FACE_BOX`]).
///
/// **Every number counts live elements this build walked.** The page prints them
/// and computes none (ADR-0019).
pub const FACE_INSIDE: u8 = 20;
/// One interface: display id · name · schema kind word · unit count.
pub const FACE_IN_IFACE: u8 = 21;
/// One logical unit: display id · its interface's display id · label · addresses
/// joined `, ` · zone display id · zone name · tunnel name.
///
/// Slots 4–6 are empty, not an em dash, where there is nothing: the page owns how
/// absence is said (`Unit::zone`).
pub const FACE_IN_UNIT: u8 = 22;
/// One zone: display id · name · member units.
pub const FACE_IN_ZONE: u8 = 23;
/// One policy set: display id · what the graph can say about the zone pair it
/// governs, **empty on every estate this build can produce** · policy count.
///
/// Slot 1's emptiness is the honest half of `57` §6.3
/// (`fathom_inventory::SetBand::scope`): `PolicyScope` is a unit struct, so a
/// `PolicySet` cannot name its pair. The page says so in words and draws no edge
/// into this band.
pub const FACE_IN_SET: u8 = 24;
/// One security policy: display id · its set's display id · ordinal · name ·
/// action · `1`/`0`/empty for enabled · description.
///
/// Emitted in `ordinal` order, **the order the device reads them**: the one
/// clause of `57` §6.3 that is both exact and buildable.
pub const FACE_IN_POLICY: u8 = 25;
/// One routing instance: display id · name.
pub const FACE_IN_ROUTE: u8 = 26;
/// One routing protocol: display id · its instance's display id · protocol
/// token · adjacency count.
pub const FACE_IN_PROTO: u8 = 27;
/// One ipsec vpn: display id · name · the unit it binds, or empty.
pub const FACE_IN_TUNNEL: u8 = 28;

/// Codes 1–5 are WO-07's.
pub const ERR_NO_ELEMENT: u16 = 6;
/// The paste frame is shorter than its fixed 24-byte clock+entropy prefix, or the
/// text after it is not UTF-8. Distinct from `ERR_BAD_FRAME` so the page can tell
/// a malformed call from a paste the parser refused.
pub const ERR_PASTE_FRAME: u16 = 7;
/// `fathom_ingest::ingest` refused the input before parsing it: not UTF-8, or
/// past `14` §11.4's caps.
pub const ERR_INGEST_REFUSED: u16 = 8;
/// The weld refused to apply the fragment. The detail carries the refusal.
pub const ERR_WELD_REFUSED: u16 = 9;
/// The paste parsed without error and **bound nothing**: not one line became a
/// fact. Almost always the wrong text: another vendor's config, or Junos in
/// curly-brace form rather than `| display set`.
///
/// A distinct code because it is a failure of the *choice* of paste, and the
/// remedy differs: tell the operator what Fathom expected and keep what they had.
pub const ERR_NOTHING_UNDERSTOOD: u16 = 10;

/// A hand-entered value is not what the schema declares the field to be: a
/// misspelt role, an out-of-range member index, a hostname that is not an
/// identifier.
///
/// Distinct from `ERR_BAD_FRAME`: the frame was well-formed and the person typed
/// something the field cannot hold. The page keeps the form open and their input,
/// and says which field and why.
pub const ERR_FIELD_VALUE: u16 = 11;

/// The hand-entry frame is malformed: too short for its prefix, a field count
/// overrunning the buffer, or a key naming nothing in `schema/`. A page defect,
/// not an operator one.
pub const ERR_EQUIP_FRAME: u16 = 12;

/// The store refused a hand-authored write: a cardinality bound, a reused
/// provenance id, a containment rule. Carries the store's own words; paraphrase
/// would lose the only diagnosis (Fathom's model disagrees with the request).
pub const ERR_EQUIP_STORE: u16 = 13;

/// A paste arrived before the dictionary did.
///
/// The dictionary arrives over `OP_DICT` rather than being compiled in, so there is
/// nothing to fall back on. A silent empty parse is the worst answer: every line
/// becomes residue and a well-formed config is reported as *"none of these lines is
/// one Fathom knows"*, blaming the operator for an incomplete boot.
///
/// Distinct from `ERR_NOT_INITIALISED`. The remedy is the page's: call `OP_DICT`
/// first.
pub const ERR_NO_DICTIONARY: u16 = 14;

/// `OP_LINK` refused: the schema does not admit this link between these boxes, or
/// there is no such link to cut. Distinct from `ERR_NO_ELEMENT`: both ids resolved
/// and the refusal is about the pair.
///
/// **The detail is empty for the schema refusal, deliberately**: the page picked
/// both boxes and knows both kinds, and the sentence cost 345 bytes against `44`
/// §5.2's ceiling. The cut refusal carries a short sentence since the page cannot
/// know whether a link existed.
pub const ERR_NO_LINK: u16 = 15;

/// **Not a failure: a question.** `OP_LINK` found more than one edge kind the schema
/// admits between those boxes and wrote nothing. The detail is the candidate
/// kinds' names separated by single spaces; the page offers the choice and posts
/// the chosen name back in the same frame.
///
/// An error record because refusing to write is one, and a bespoke reply shape cost
/// over a kilobyte. A code of its own so the page need not read prose (`78` §6:
/// not guessing).
pub const ERR_LINK_CHOICE: u16 = 16;

/// The paste names a device the design already holds, and Fathom will not guess
/// whether they are the same box.
///
/// **This replaces a guard that was removed.** `70` §16.3: *"a tier-1 match is a
/// proposal to a human, not an automatic merge, because two real branch sites may
/// both run a `core-01` SRX on the same platform. Until it is designed, `OP_PASTE`
/// replaces the held estate and says so, which is the behaviour that cannot
/// silently merge two boxes."* Making the paste additive removed that guard (the
/// second paste of a box used to yield one device only because it destroyed the
/// first), so the question must exist.
///
/// The message carries the existing device's display id and hostname so the page
/// can name it. The page turns it into buttons and **never picks**.
///
/// **Exactly one button:** *"These are different boxes — add it"* re-posts with
/// `confirm = 1`. *"Same box, update it"* is `11` §10.4's re-identification, which
/// is unimplemented, and the refusal says so rather than offering a control that
/// would lie.
pub const ERR_PASTE_CHOICE: u16 = 17;

/// `OP_CABLE`'s frame carries a count byte and this build refuses any value but
/// `1` (ADR-0038 D7). Not a limit on how many cables an estate holds but on how
/// many one CALL writes, so a future range-cabling frame fails loudly here
/// rather than silently truncating to the first record.
pub const ERR_CABLE_COUNT: u16 = 18;

/// `OP_CABLE`'s frame named an end spec that does not resolve: not a live port,
/// not a live device or chassis, both ends the same port, tag `3`
/// (`ExternalPeer`, reserved and unbuilt), or tag `2` (unknown) on the near end;
/// an unknown end is legal only on the FAR one.
///
/// The detail is empty, for `ERR_NO_LINK`'s reason: the page knows what it sent.
pub const ERR_CABLE_END: u16 = 19;

/// `OP_CABLE`'s cut named something that does not resolve to a live `Cable`.
pub const ERR_NO_CABLE: u16 = 20;

/// `OP_LOAD_PLAIN` or `OP_EXPORT_PLAIN` refused: `fathom_workspace::read_plain` or
/// `write_plain` returned an error, carried whole (ADR-0052 §4): wrong magic,
/// unsupported face version, missing plaintext banner, schema version mismatch, or
/// malformed body. The store's own words, as `ERR_WELD_REFUSED` carries.
pub const ERR_PLAIN_REFUSED: u16 = 21;

/// How many string slots one face record carries.
const FACE_SLOTS: usize = 8;

/// The fixed header: magic, version, record_kind, record_count, record_stride.
const HEADER_LEN: usize = 16;

// --- encoding ---

/// Encode §4.4's OP_INIT frame from bare-named sources. The reference encoder,
/// used by WO-08's build step and this crate's tests.
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

/// The wire tag for a corpus section. Public so a decoder can invert the encoder
/// rather than carry a second mapping (the artifact tests read the frame back out
/// of the assembled page).
pub fn section_byte(section: fathom_corpus::Section) -> u8 {
    match section {
        fathom_corpus::Section::Commands => 0,
        fathom_corpus::Section::Explainers => 1,
        fathom_corpus::Section::Rules => 2,
        // 3, appended: 0..=2 are on the wire in every frame built so far, and
        // renumbering would silently reinterpret them rather than reject.
        fathom_corpus::Section::Concepts => 3,
    }
}

/// The trailing string blob under construction, with the `(offset, len)` pairs
/// the records carry.
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

/// The detail of an error reply, `None` when `reply` is not one.
pub fn error_detail(reply: &[u8]) -> Option<(u16, String)> {
    if reply.get(6..8) != Some(&KIND_ERROR.to_le_bytes()[..]) {
        return None;
    }
    let at = |i: usize| {
        reply
            .get(i..i + 4)
            .map(|b| u32::from_le_bytes([b[0], b[1], b[2], b[3]]) as usize)
    };
    let (off, len) = (at(36)?, at(40)?);
    let blob = reply.get(48..)?;
    let code = u16::from_le_bytes([*reply.get(16)?, *reply.get(17)?]);
    Some((
        code,
        String::from_utf8_lossy(blob.get(off..off + len)?).into_owned(),
    ))
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

/// ADR-0027 §2's test and nothing else's: an entry **that has not been run on a
/// box** renders as unverified.
///
/// It keys on `verified_on`, NOT `reviewed_by`. 61 §3.1: *"Absent ⇒ the entry
/// renders an `unverified` margin tab."* Keying on `reviewed_by` was a bug: once
/// the queued named expert review lands, `reviewed_by` becomes a real name on all
/// 98 entries with none ever run on hardware, every stamp would flip to
/// "reviewed", `ROW_UNVERIFIED` would clear and the corpus line would claim every
/// entry was reviewed. A safety label that disarms itself on a scheduled action is
/// worse than none. (ADR-0008 licenses adding `verified_on` to the loader, not
/// redefining a safety label.)
///
/// Invariant 10's separate fact is reported as itself: `has_named_reviewer`,
/// `review_line`.
fn is_unverified(e: &Entry) -> bool {
    e.verified_on.is_none()
}

/// Invariant 10's test, as `fathom_corpus::gates` applies it: a `reviewed_by`
/// opening with `<` is the `<named human>` placeholder, not a person. Empty
/// counts too.
///
/// Deliberately NOT folded into `is_unverified`: two facts, four combinations,
/// and the corpus will pass through at least two (today every entry is both
/// unreviewed and unrun; the reviewer changes next).
fn has_named_reviewer(e: &Entry) -> bool {
    let r = e.reviewed_by.trim();
    !r.is_empty() && !r.starts_with('<')
}

/// ADR-0027 §3's stamp, composed only from what the corpus holds.
///
/// The ADR's form is `junos-srx 21.4R3 · verified 2026-05-12 · K. Okafor`. The DATE
/// deviates: `61` §3.1 declares `verified_on` as `{ platform, version }` with no
/// date, and the only date declared is `reviewed_on` (when someone read the entry,
/// not ran it). Printing it after `verified` would assert a bench date the corpus
/// lacks, so it is labelled for what it is. Inventing `verified_on.date` would
/// breach ADR-0008.
///
/// The verified form takes platform and train from `verified_on` (the box used),
/// never the entry's `platform`/`versions` (what it is *for*), so the unverified
/// form prints no train. Applicable trains are `16` §19.5's "not on your train"
/// caveat and belong to the row.
fn verification_stamp(e: &Entry) -> String {
    match &e.verified_on {
        // FOUR ARMS, NOT THREE: a bench run and a named reviewer are independent. Three
        // arms printed `reviewed … by {reviewed_by}` on any verified entry without asking
        // whether it was a person, so a run-before-review entry rendered
        //
        //     junos-srx 21.4R3 · verified · reviewed 2026-07-28 by <named human>
        //
        // : invariant 10's placeholder as though it were a human, in a line opening with
        // `verified`. Reachable if ADR-0027 §1's conformance lab lands before the review.
        Some(v) if has_named_reviewer(e) => format!(
            "{} {} · verified · reviewed {} by {}",
            v.platform, v.version, e.reviewed_on, e.reviewed_by
        ),
        Some(v) => format!(
            "{} {} · verified on a box · NO NAMED REVIEWER (invariant 10)",
            v.platform, v.version
        ),
        // Both missing facts are named: a real reviewer and no bench run must not read
        // as neither, or the corpus cannot show its progress.
        None if has_named_reviewer(e) => format!(
            "{} · unverified — not run on a box · reviewed {} by {}",
            e.platform, e.reviewed_on, e.reviewed_by
        ),
        None => format!(
            "{} · unverified — not run on a box, no named reviewer (invariant 10)",
            e.platform
        ),
    }
}

/// The corpus-wide review line, carried on every query reply's summary record so
/// the finder cannot render results without it. Counted here, not stated in the
/// page.
///
/// TWO COUNTS, NOT ONE (the structural half of the ADR-0027 fix): a count keyed on
/// `reviewed_by` went silent at zero, so the queued review would have taken the
/// alarm down while the hardware count stayed at 98. With both, completing the
/// review changes the sentence without ending it; the line goes quiet only when
/// both are zero (ADR-0027 §2).
pub fn review_line(index: &CorpusIndex) -> String {
    let entries = &index.corpus.entries;
    let total = entries.len();
    let unverified = entries.iter().filter(|e| is_unverified(e)).count();
    let unreviewed = entries.iter().filter(|e| !has_named_reviewer(e)).count();
    if unverified == 0 && unreviewed == 0 {
        return format!(
            "{total} command entries · every one run on a box and reviewed by a named human"
        );
    }
    // Built by appending, not collecting and joining: identical output, and the
    // join form cost 107 more wasm bytes (890,366 vs 890,259) against 44 §5.2's
    // 900,000 ceiling, the binding constraint.
    let mut line = format!("{total} command entries");
    if unverified > 0 {
        line.push_str(&format!(
            " · {unverified} unverified, never run on a box (ADR-0027)"
        ));
    }
    if unreviewed > 0 {
        line.push_str(&format!(
            " · {unreviewed} with no named reviewer (invariant 10)"
        ));
    }
    line
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

    // Record 0, the query summary. `risk` is 0 and not meaningful here.
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
        // Slot 5 on the summary is the corpus's review state. It rides the reply every
        // query makes, so rows cannot be on screen without this line.
        blob.push(&review_line(idx)),
        // s6 is the risk caption on a result row; meaningless here.
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

// --- the face encoders (WO-08 §4.4) ---

/// One face record before it becomes 72 bytes. The encoders copy the projections'
/// strings verbatim; nothing is recomputed here.
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
/// nothing, with no de-duplication (invariant 9).
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
    keys: &[Option<fathom_ir::bag::FieldKey>],
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

    // [`FACE_INV_KEY`]: which columns a person may type into, at the slot index the
    // header put their names. Written from `keys` verbatim; this decides nothing
    // about editability (`fathom_inventory::column_keys` does).
    let decimals: Vec<String> = keys
        .iter()
        .map(|k| k.map(|k| k.0.to_string()).unwrap_or_default())
        .collect();
    let mut key_slots: Vec<&str> = Vec::with_capacity(FACE_SLOTS);
    key_slots.push("");
    key_slots.extend(decimals.iter().map(String::as_str));
    while key_slots.len() < FACE_SLOTS {
        key_slots.push("");
    }
    let rec = face_slots(&mut blob, FACE_INV_KEY, slot_count, &key_slots);
    write_face_record(&mut records, &rec);

    for row in rows {
        let mut slots: Vec<&str> = Vec::with_capacity(FACE_SLOTS);
        slots.push(row.id.as_str());
        slots.extend(row.cells.iter().map(String::as_str));
        while slots.len() < FACE_SLOTS - 1 {
            slots.push("");
        }
        // `<opinions> <hints>` (ADR-0041 D5/D7; see [`FACE_INV_KEY`]). `hints` is the
        // usually-empty half, last as `FACE_BOX`'s group key is, so a token after it is
        // unambiguous on `split(' ')`.
        let slot7 = format!("{} {}", row.opinions, row.hints);
        slots.push(slot7.as_str());
        let rec = face_slots(&mut blob, FACE_INV, slot_count, &slots);
        write_face_record(&mut records, &rec);
    }

    // 2 = the header and the key row; chrome, not rows.
    face_reply(records, 2 + rows.len(), blob)
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
        // Slot 3 is the field's wire key, slot 4 whether it can be typed in. Both travel
        // WITH the row, since a name-to-key table in JavaScript is how a form ends up
        // writing one field into another's slot. Slot 5 is ADR-0041 D7's hint bit
        // (`fathom_inventory::element::FieldRow.hint`), carried as `Row.hints` rides on
        // `FACE_INV`'s slot 7: this face's field table (`renderMeaningFace`, reached
        // from the inventory's details pane and the diagram's) inherits the mark rather
        // than the page re-deciding it.
        let key = f.key.0.to_string();
        let rec = face_slots(
            blob,
            FACE_FIELD,
            6,
            &[
                f.name,
                f.value.as_str(),
                f.provenance.as_str(),
                key.as_str(),
                if f.editable { "1" } else { "" },
                if f.hint { "1" } else { "" },
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

/// One rack's elevation (ADR-0035): the frame, every box in it, then every clash.
///
/// Overflow rows are emitted and flagged in slot 6, not dropped or clipped: a 42U
/// rack holding a box recorded at U48 is a data error somebody must see. Numbers
/// are decimal strings (see `PasteReply`); the page computes only a rect's `y`.
pub fn encode_rack_reply(e: Option<&fathom_inventory::Elevation>) -> Vec<u8> {
    let mut blob = Blob::default();
    let mut records: Vec<u8> = Vec::new();
    // `None` is the empty state, as in `encode_equipment_reply`: no rack selected, or
    // one whose `height_u` was never stated and cannot be drawn.
    let Some(e) = e else {
        return face_reply(records, 0, blob);
    };

    let height = e.height_u.to_string();
    let rec = face_slots(
        &mut blob,
        FACE_RACK,
        5,
        &[
            e.id.as_str(),
            e.label.as_str(),
            height.as_str(),
            e.numbering.as_str(),
            match e.ascending {
                Some(true) => "1",
                Some(false) => "0",
                // Not a direction, and deliberately not defaulted to one.
                None => "",
            },
        ],
    );
    write_face_record(&mut records, &rec);
    let mut count = 1usize;

    for (slot, over) in e
        .slots
        .iter()
        .map(|s| (s, false))
        .chain(e.overflow.iter().map(|s| (s, true)))
    {
        let pos = slot.position_u.to_string();
        // An unstated height is an EMPTY slot, never "1". The page draws one unit and
        // marks it; collapsing the two would turn "nobody said" into a measurement.
        let h = slot.height_u.map(|v| v.to_string()).unwrap_or_default();
        let rec = face_slots(
            &mut blob,
            FACE_RACK_SLOT,
            7,
            &[
                slot.id.as_str(),
                slot.device.as_str(),
                slot.chassis.as_str(),
                pos.as_str(),
                h.as_str(),
                slot.face,
                if over { "1" } else { "" },
            ],
        );
        write_face_record(&mut records, &rec);
        count += 1;
    }

    for (a, b) in &e.collisions {
        let rec = face_slots(&mut blob, FACE_RACK_CLASH, 2, &[a.as_str(), b.as_str()]);
        write_face_record(&mut records, &rec);
        count += 1;
    }

    face_reply(records, count, blob)
}

/// What one paste produced: the summary row, then the lines not understood, then
/// the references named and not found.
///
/// Numbers are strings: each is a count the page prints and never computes with,
/// and a decimal string cannot be read at the wrong width. `summary[2]` is the
/// **total** residue count, which may exceed `residue.len()` when the caller
/// capped the rows, so the page can say how many it is not showing.
pub struct PasteReply<'a> {
    /// nodes · edges · residue lines · secrets redacted · unresolved ·
    /// device display id · hostname · platform.
    pub summary: [&'a str; 8],
    /// line number · the line as stored · why it was not understood.
    pub residue: &'a [[String; 3]],
    /// what was named · the edge kind that wanted it · line number.
    pub unresolved: &'a [[String; 3]],
    /// The post-redaction text, for the page's journal. Empty for replies that are
    /// not a paste.
    pub capture: &'a str,
    /// The shape digest of the estate this paste built — [`FACE_SHAPE`].
    pub shape: &'a str,
    /// [`FACE_PASTE_LINE`] rows, one per ledger line, in ledger order. Empty for
    /// replies this face does not apply to (`equip_reply_text` and the door opcodes'
    /// summaries reuse this encoder without it).
    pub lines: &'a [[String; 7]],
    /// [`FACE_DROP`] rows, one per destroyed value.
    pub drops: &'a [[String; 5]],
}

/// The diagram, as face rows. Numbers travel as decimal strings, as in every face
/// row: one page decoder, not two.
///
/// `filter` is `Some` exactly when the caller asked for a layer mask. It is
/// reported, not just obeyed: the page prints the mask it got back, so a picture
/// and its toggles cannot disagree about which layers produced it.
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
        // `<count> <interior> <placed> <role> <group>`; the possibly-empty group is last,
        // so a token inserted *before* it is unambiguous. The placed flag rides in this
        // slot because a ninth slot costs another `face_slots` argument and blob offset
        // per box, against 3,903 bytes of headroom under `44` §5.2.
        //
        // ADR-0037's role is at position 3 and is `-` when absent: two adjacent empty
        // tokens collapse on `split(' ')` and the page would read the group key as the
        // role. `-` is not a schema token (`62` §7 variants are `[a-z_]+`). The page reads
        // `parts[2]` flag, `parts[3]` role, `parts[4]` key.
        let agg = format!(
            "{} {} {} {} {}",
            n.count,
            n.interior,
            u8::from(n.placed),
            if n.role.is_empty() { "-" } else { &n.role },
            n.group
        );
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
        // Slot 6 (`hand`) was APPENDED after the five already on the wire; slot 7
        // (`cable`, ADR-0038) after that, the last `FACE_SLOTS = 8` allows. The page
        // reads slots by index, so inserting elsewhere would silently reinterpret every
        // existing row rather than reject it (as with ADR-0035's placed flag).
        let rec = face_slots(
            &mut blob,
            FACE_LINE,
            8,
            &[
                l.from.as_str(),
                l.to.as_str(),
                l.kind,
                if l.containment { "1" } else { "" },
                pts.as_str(),
                members.as_str(),
                if l.hand { "1" } else { "" },
                if l.cable { "1" } else { "" },
            ],
        );
        write_face_record(&mut records, &rec);
    }

    face_reply(records, 1 + d.nodes.len() + d.links.len(), blob)
}

/// What the estate does not know yet: the head row, every gap group with its
/// examples, then every kind the estate holds none of.
///
/// An estate with nothing missing is `record_count = 1`, the head row with zeros:
/// never an error or an empty reply, since an empty reply cannot be told from a
/// call that did not happen. Counts are decimal strings, as in `encode_rack_reply`.
pub fn encode_findings_reply(f: &fathom_inventory::Findings) -> Vec<u8> {
    let mut blob = Blob::default();
    let mut records: Vec<u8> = Vec::new();

    let groups = f.gaps.len().to_string();
    let facts = f.total_missing().to_string();
    let checked = f.checked.to_string();
    let kinds = f.kinds_present.to_string();
    let empties = f.empty.len().to_string();
    let rec = face_slots(
        &mut blob,
        FACE_GAP_HEAD,
        5,
        &[
            groups.as_str(),
            facts.as_str(),
            checked.as_str(),
            kinds.as_str(),
            empties.as_str(),
        ],
    );
    write_face_record(&mut records, &rec);
    let mut count = 1usize;

    for (i, gap) in f.gaps.iter().enumerate() {
        let index = i.to_string();
        let missing = gap.missing.to_string();
        let population = gap.population.to_string();
        let carried = gap.examples.len().to_string();
        let rec = face_slots(
            &mut blob,
            FACE_GAP,
            7,
            &[
                gap.kind_word,
                gap.field,
                missing.as_str(),
                population.as_str(),
                carried.as_str(),
                gap.sentence.as_str(),
                if gap.authorable { "1" } else { "" },
            ],
        );
        write_face_record(&mut records, &rec);
        count += 1;
        for ex in &gap.examples {
            let rec = face_slots(
                &mut blob,
                FACE_GAP_ITEM,
                4,
                &[
                    ex.id.as_str(),
                    ex.name.as_str(),
                    gap.kind_word,
                    index.as_str(),
                ],
            );
            write_face_record(&mut records, &rec);
            count += 1;
        }
    }

    for e in &f.empty {
        let n = e.required_fields.to_string();
        let rec = face_slots(&mut blob, FACE_GAP_EMPTY, 2, &[e.kind_word, n.as_str()]);
        write_face_record(&mut records, &rec);
        count += 1;
    }

    face_reply(records, count, blob)
}

/// `OP_CHECKS`'s reply, or `OP_CHECK_GESTURE`'s (`head` None).
pub fn encode_checks_reply(
    head: Option<([usize; 3], bool, usize, usize)>,
    rows: &[crate::checks::Row],
) -> Vec<u8> {
    let mut blob = Blob::default();
    let mut records: Vec<u8> = Vec::new();
    let mut count = 0usize;
    if let Some((c, failed, loaded, unfinished)) = head {
        let n: Vec<String> = c
            .iter()
            .chain([&loaded, &unfinished])
            .map(|v| v.to_string())
            .collect();
        let rec = face_slots(
            &mut blob,
            FACE_CHECK_HEAD,
            6,
            &[
                &n[0],
                &n[1],
                &n[2],
                &n[3],
                if failed { "1" } else { "" },
                &n[4],
            ],
        );
        write_face_record(&mut records, &rec);
        count += 1;
    }
    for r in rows {
        let rec = face_slots(
            &mut blob,
            FACE_CHECK,
            8,
            &[
                &r.rule,
                r.severity,
                &r.title,
                &r.fix,
                &r.why,
                &r.concept,
                &r.source,
                &r.elements,
            ],
        );
        write_face_record(&mut records, &rec);
        count += 1;
    }
    face_reply(records, count, blob)
}

/// `OP_PLAN_PREVIEW`'s reply.
pub fn encode_plan_reply(steps: &[crate::plan::StepOut]) -> Vec<u8> {
    let mut blob = Blob::default();
    let mut records: Vec<u8> = Vec::new();
    let mut count = 0usize;
    for s in steps {
        let ordinal = s.ordinal.to_string();
        let rec = face_slots(
            &mut blob,
            FACE_PLAN_STEP,
            5,
            &[&s.id, &ordinal, &s.error, &s.impact, &s.touches],
        );
        write_face_record(&mut records, &rec);
        count += 1;
        for r in &s.rows {
            let rec = face_slots(
                &mut blob,
                FACE_CHECK,
                8,
                &[
                    &r.rule,
                    r.severity,
                    &r.title,
                    &r.fix,
                    &r.why,
                    &r.concept,
                    &r.source,
                    &r.elements,
                ],
            );
            write_face_record(&mut records, &rec);
            count += 1;
        }
    }
    face_reply(records, count, blob)
}

/// Inside one box, as records (`57` §7).
///
/// `None` is the empty state, not an error (as [`encode_rack_reply`] and
/// `encode_equipment_reply`): the display id named something that is not a live
/// `Device`, and the page says so rather than showing a diagnostic.
///
/// Counts are decimal strings, as in [`encode_rack_reply`].
pub fn encode_inside_reply(i: Option<&fathom_inventory::Inside>) -> Vec<u8> {
    let mut blob = Blob::default();
    let mut records: Vec<u8> = Vec::new();
    let Some(i) = i else {
        return face_reply(records, 0, blob);
    };

    let ifaces = i.ways.len().to_string();
    let units = i.unit_count().to_string();
    let zones = i.zones.len().to_string();
    let sets = i.sets.len().to_string();
    let policies = i.policy_count().to_string();
    let tail = format!("{} {} {}", i.routes.len(), i.tunnels.len(), i.unzoned());
    let rec = face_slots(
        &mut blob,
        FACE_INSIDE,
        8,
        &[
            i.device.as_str(),
            i.name.as_str(),
            ifaces.as_str(),
            units.as_str(),
            zones.as_str(),
            sets.as_str(),
            policies.as_str(),
            tail.as_str(),
        ],
    );
    write_face_record(&mut records, &rec);
    let mut count = 1usize;

    for w in &i.ways {
        let n = w.units.len().to_string();
        let rec = face_slots(
            &mut blob,
            FACE_IN_IFACE,
            4,
            &[w.id.as_str(), w.name.as_str(), w.kind_word, n.as_str()],
        );
        write_face_record(&mut records, &rec);
        count += 1;
        for u in &w.units {
            // Joined here, not in the page: `55` §1.4 the other way round, a string a
            // reader is shown is composed on this side. Two addresses on one unit is
            // ordinary (inet plus inet6); the join is the band's only computation.
            let addrs = u.addresses.join(", ");
            let rec = face_slots(
                &mut blob,
                FACE_IN_UNIT,
                7,
                &[
                    u.id.as_str(),
                    w.id.as_str(),
                    u.label.as_str(),
                    addrs.as_str(),
                    u.zone.as_str(),
                    u.zone_name.as_str(),
                    u.tunnel.as_str(),
                ],
            );
            write_face_record(&mut records, &rec);
            count += 1;
        }
    }

    for z in &i.zones {
        let n = z.members.to_string();
        let rec = face_slots(
            &mut blob,
            FACE_IN_ZONE,
            3,
            &[z.id.as_str(), z.name.as_str(), n.as_str()],
        );
        write_face_record(&mut records, &rec);
        count += 1;
    }

    for s in &i.sets {
        let n = s.policies.len().to_string();
        let rec = face_slots(
            &mut blob,
            FACE_IN_SET,
            3,
            &[s.id.as_str(), s.scope.as_str(), n.as_str()],
        );
        write_face_record(&mut records, &rec);
        count += 1;
        for p in &s.policies {
            let rec = face_slots(
                &mut blob,
                FACE_IN_POLICY,
                7,
                &[
                    p.id.as_str(),
                    s.id.as_str(),
                    p.ordinal.as_str(),
                    p.name.as_str(),
                    p.action.as_str(),
                    p.enabled.as_str(),
                    p.description.as_str(),
                ],
            );
            write_face_record(&mut records, &rec);
            count += 1;
        }
    }

    for r in &i.routes {
        let rec = face_slots(
            &mut blob,
            FACE_IN_ROUTE,
            2,
            &[r.id.as_str(), r.name.as_str()],
        );
        write_face_record(&mut records, &rec);
        count += 1;
        for p in &r.protocols {
            let n = p.adjacencies.to_string();
            let rec = face_slots(
                &mut blob,
                FACE_IN_PROTO,
                4,
                &[
                    p.id.as_str(),
                    r.id.as_str(),
                    p.protocol.as_str(),
                    n.as_str(),
                ],
            );
            write_face_record(&mut records, &rec);
            count += 1;
        }
    }

    for t in &i.tunnels {
        let rec = face_slots(
            &mut blob,
            FACE_IN_TUNNEL,
            3,
            &[t.id.as_str(), t.name.as_str(), t.unit.as_str()],
        );
        write_face_record(&mut records, &rec);
        count += 1;
    }

    face_reply(records, count, blob)
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

    // Two optional tail rows, each present only when its string is. The arithmetic
    // counts what was written, since `equip_reply_text` reuses this encoder for
    // replies that are not pastes and have neither.
    let mut extra = 0;
    if !reply.capture.is_empty() {
        let rec = face_slots(&mut blob, FACE_CAPTURE, 1, &[reply.capture]);
        write_face_record(&mut records, &rec);
        extra += 1;
    }
    if !reply.shape.is_empty() {
        let rec = face_slots(&mut blob, FACE_SHAPE, 1, &[reply.shape]);
        write_face_record(&mut records, &rec);
        extra += 1;
    }

    for row in reply.lines {
        let slots: [&str; 7] = std::array::from_fn(|i| row[i].as_str());
        let rec = face_slots(&mut blob, FACE_PASTE_LINE, 7, &slots);
        write_face_record(&mut records, &rec);
    }
    for row in reply.drops {
        let slots: [&str; 5] = std::array::from_fn(|i| row[i].as_str());
        let rec = face_slots(&mut blob, FACE_DROP, 5, &slots);
        write_face_record(&mut records, &rec);
    }

    face_reply(
        records,
        1 + reply.residue.len()
            + reply.unresolved.len()
            + extra
            + reply.lines.len()
            + reply.drops.len(),
        blob,
    )
}

/// `OP_REDACT_TEXT`'s reply (ADR-0053 §6): the gated text, then what the gate
/// destroyed. No summary, lines or shape: those belong to a paste that reached
/// the binder, and this door stops before it.
pub struct RedactReply<'a> {
    /// The post-redaction text ([`FACE_CAPTURE`]), always present, even when the gate
    /// touched nothing.
    pub capture: &'a str,
    /// [`FACE_DROP`] rows, one per destroyed value, as `PasteReply::drops`.
    pub drops: &'a [[String; 5]],
}

pub fn encode_redact_reply(reply: &RedactReply<'_>) -> Vec<u8> {
    let mut blob = Blob::default();
    let mut records: Vec<u8> = Vec::new();

    let rec = face_slots(&mut blob, FACE_CAPTURE, 1, &[reply.capture]);
    write_face_record(&mut records, &rec);

    for row in reply.drops {
        let slots: [&str; 5] = std::array::from_fn(|i| row[i].as_str());
        let rec = face_slots(&mut blob, FACE_DROP, 5, &slots);
        write_face_record(&mut records, &rec);
    }

    face_reply(records, 1 + reply.drops.len(), blob)
}

// --- decoding ---

/// The reference reader: what decoder tests check parity against, and the
/// byte-level specification WO-08's TypeScript reader mirrors.
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

/// Refuses a bad magic, version, kind, stride, count, or out-of-blob string ref
/// with a message naming the offset. Empty input decodes to Empty.
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
