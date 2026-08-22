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

/// Row flag bit 2 (value 4): ADR-0027 §2's label — the entry behind this row
/// has **not been run on a box**, so it carries no `verified_on` (61 §3.1).
///
/// It is not invariant 10's bit. A missing named reviewer is a different fact
/// about a different act, it is reported separately in the corpus review line,
/// and conflating the two is what let this flag clear itself on an action the
/// project has already scheduled — see `is_unverified`.
///
/// A **bit**, not a string the page pattern-matches: the row's register is a
/// typed fact, and deriving it by inspecting the stamp text is how a rendering
/// quietly starts disagreeing with the corpus.
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

// --- ADR-0036's rack elevation ----------------------------------------------
//
// Three roles rather than one, because the page must be able to tell a box
// that fits from one that does not without re-deriving the arithmetic. A
// single row kind with a status column would push that decision into the
// JavaScript, and `fathom-inventory`'s own doc is explicit that the page
// computes nothing.
//
// 12/13/14, NOT 8/9/10: those were free when this was written and are now
// FACE_CAPTURE, FACE_BOX and FACE_LINE on the tip. A face code is a wire
// discriminant, so a collision would silently render one record kind as
// another; the numbers moved on the rebase rather than the meanings.

/// The frame itself, always record 0: display id · label · height in units ·
/// the numbering token · the direction.
///
/// THE DIRECTION SLOT HAS THREE STATES, not two: `1` for U1 at the floor, `0`
/// for U1 at the top, and **EMPTY for "this build cannot read the token"**. It
/// was two, with empty meaning descending, and that is what let an unreadable
/// token be drawn ascending — the page had no way to tell "the rack says U1 is
/// at the top" from "the rack says something I do not understand", so it drew
/// both. The page must not re-derive the answer by comparing the token against
/// the enum's spellings: that is a second copy of the schema in JavaScript.
///
/// The numbering token travels as text alongside it so an unrecognised token
/// from a newer schema can be PRINTED rather than merely refused.
pub const FACE_RACK: u8 = 12;
/// One placed box: chassis display id · device · chassis · position_u ·
/// height_u (empty = never stated) · face · `1` when it overflows the frame.
pub const FACE_RACK_SLOT: u8 = 13;
/// One pair of boxes whose runs intersect: the two chassis display ids.
/// Reported, never resolved — this face has no basis for choosing which of two
/// conflicting assertions is right.
pub const FACE_RACK_CLASH: u8 = 14;
/// The inventory's editable columns, one record per reply, immediately after
/// the header and before the first row.
///
/// **It mirrors the header's slot layout exactly** — slot 0 is not a column,
/// slots 1..=6 are the columns in order, slot 7 is the opinions column — so the
/// page reads a column's key at the same index it read that column's name, and
/// an off-by-one is not available to it. Slot 0 and slot 7 are always empty:
/// neither is a field of the row, and the opinions column is a rule engine's,
/// which this build does not have.
///
/// Each column's slot holds `FieldKey` in decimal, or the empty string where
/// the column cannot be typed into — because it is a walk, or because
/// `fathom_inventory::is_authorable` says the schema's type for it cannot yet
/// be parsed from text. `fathom_inventory::column_keys` decides; nothing here
/// forms an opinion about it.
///
/// A record rather than more slots on the header, because [`FACE_SLOTS`] is
/// eight and the header already spends all eight. A record rather than a
/// name-to-key table in the page, because the page must never hold one: that is
/// how a form ends up writing one field into another's slot, and it is why
/// `encode_element_reply` already sends the inspector's keys the same way.
/// **29, not 15 — this was the third face-code collision in two days.**
///
/// 15 went to the shape digest, 16–19 to the findings view and 20–28 to rung 4,
/// every one of them on a branch built in parallel with this one. The paragraph
/// above warns that a face code is a wire discriminant and that a collision
/// renders one record kind as another; three branches then demonstrated it in a
/// row, which is the strongest argument available that the warning was not
/// enough on its own.
///
/// `artifact.rs`'s `the_pages_face_codes_match_the_modules` is what catches it
/// now, and it caught this one. Anyone adding a face should read the next free
/// number out of this file rather than out of a memory of it.
pub const FACE_INV_KEY: u8 = 29;

// --- the shape reply (`49` §19 phase 0, item 3) -------------------------------

/// The held estate's shape digest — one row, slot 0, 16 lowercase hex
/// characters. [`fathom_graph::shape_hex`] defines what is in it.
///
/// One slot and no counts. The page already has the paste's four summary
/// numbers from [`FACE_PASTE`] and journals them itself, so repeating them here
/// would be a second place for the same fact to be written and a second place
/// for it to be wrong.
///
/// **The value is opaque to the page.** It compares two of these for equality
/// and never parses, truncates, orders or displays one. That is deliberate: the
/// digest is drift detection and is NOT tamper-evidence — FNV-1a is
/// non-cryptographic by its own specification (RFC 9923, February 2026) — so no
/// surface may present it as a seal.
pub const FACE_SHAPE: u8 = 15;

// --- what the estate does not know yet (`57` §13.5.3) ------------------------
//
// Four more roles on the stride-72 face record, for the reason FACE_PASTE
// gives: the reply is a list of labelled string rows, which is what
// KIND_FACE_ROW already is.
//
// 16–19. Nothing below 16 is free: 0–4 are WO-08's, 5–8 the paste's, 9–11 the
// diagram's, 12–14 the rack's and 15 the shape digest's. THESE WERE 15–18 UNTIL
// THE MERGE ON 2026-08-21, when the shape digest and this view both claimed 15
// from parallel branches — the exact collision the paragraph below warns about,
// arriving within a day of being written down. A face code is a wire discriminant, so a
// collision renders one record kind as another (see FACE_RACK's note, which
// records that happening).
//
// NOT CALLED A FINDING ANYWHERE IN THE WIRE FORMAT. `.context/conventions.md`
// reserves that word for "one rule firing against one node", and this build
// has no rule engine. What these rows carry is a GAP: a `card: "1"` field with
// no stored value. The view is named Findings because it is one of `52`'s six
// views; its content is not findings and must not claim to be.

/// The one summary row, always record 0: gap groups · unstated facts · live
/// elements walked · kinds present · kinds the estate holds none of.
pub const FACE_GAP_HEAD: u8 = 16;
/// One gap group — a kind, a required field, and how many lack it:
/// kind · field · missing · population · examples carried · the sentence ·
/// `1` when a person can type this field's value today.
///
/// The sentence is composed in `fathom-inventory` and travels whole. The page
/// renders strings and computes nothing, and "2 of 5" is a computation.
///
/// Slot 6 is the uncomfortable one, and being uncomfortable is why it is here:
/// both gaps a real estate produces in this build are fields nothing can type
/// in, so a row that reads as a job is not one yet. `Gap::authorable` carries
/// the reasoning.
pub const FACE_GAP: u8 = 17;
/// One element under the group above it: display id · display name · kind ·
/// the group's index as a decimal string.
///
/// The index rather than a nesting depth, because the page has to be able to
/// reassemble the tree from a flat record list and record ORDER is not a
/// contract anything else in this protocol relies on.
pub const FACE_GAP_ITEM: u8 = 18;
/// A kind the estate holds none of: kind · how many required fields went
/// unchecked.
///
/// Emitted so the view can distinguish "zero because they are all complete"
/// from "zero because there are none" — the second being the true state of
/// `Cable` and `PhysicalPort`, which nothing in this build creates (`57`
/// §6.2). A list that silently reported nothing for them would be telling an
/// operator their cabling was finished.
pub const FACE_GAP_EMPTY: u8 = 19;

// --- inside the box, the ladder's fourth rung (`57` §7) ----------------------
//
// Eight roles on the same stride-72 record and no new record kind, for the
// reason the paste reply's block already gives: a reply that is a list of
// labelled string rows is exactly what `KIND_FACE_ROW` is.
//
// The bands are FLAT and each child names its parent by display id, rather
// than the page reassembling them from record order. `FACE_GAP_ITEM` set that
// precedent one block up and its reason holds here too — record order is not
// a contract anything else in this protocol relies on, and a renderer that
// depends on one breaks silently the day a band is emitted somewhere else.

/// The head, always record 0: device display id · hostname · interfaces ·
/// units · zones · policy sets · policies · `<routing instances> <tunnels>
/// <unzoned units>`.
///
/// Slot 7 is three space-separated decimals, which is [`FACE_BOX`]'s own
/// documented compromise and is taken here for the same reason: `FACE_SLOTS`
/// is eight, widening the face record would change the stride of every face in
/// the protocol, and three decimals in one slot is a much smaller thing to
/// explain than that.
///
/// **Every number is a count of live elements this build actually walked.**
/// The page prints them and computes none of them (ADR-0019).
pub const FACE_INSIDE: u8 = 20;
/// One interface: display id · name · schema kind word · unit count.
pub const FACE_IN_IFACE: u8 = 21;
/// One logical unit: display id · its interface's display id · label ·
/// addresses joined `, ` · zone display id · zone name · tunnel name.
///
/// Slots 4–6 are empty rather than an em dash where there is nothing. The
/// page owns how absence is said, so there is one convention for it and not
/// two — see `Unit::zone`.
pub const FACE_IN_UNIT: u8 = 22;
/// One zone: display id · name · member units.
pub const FACE_IN_ZONE: u8 = 23;
/// One policy set: display id · what the graph can say about the zone pair it
/// governs, **empty on every estate this build can produce** · policy count.
///
/// Slot 1's emptiness is the honest half of `57` §6.3 and is documented at
/// `fathom_inventory::SetBand::scope`: `PolicyScope` is a unit struct, so a
/// `PolicySet` cannot name the pair it sits between. The page says so in
/// words and draws no edge into this band.
pub const FACE_IN_SET: u8 = 24;
/// One security policy: display id · its set's display id · ordinal · name ·
/// action · `1`/`0`/empty for enabled · description.
///
/// Emitted in `ordinal` order, which is **the order the device reads them**
/// and is the one clause of `57` §6.3 that is both exact and buildable.
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

/// `OP_LINK` refused: the schema does not admit this link between these two
/// boxes, or there is no such link to cut.
///
/// Distinct from `ERR_NO_ELEMENT`, which means *"I cannot find that id"*. Here
/// both ids resolved and the refusal is about the pair.
///
/// **The detail is empty for the schema refusal, and that is deliberate.** The
/// sentence an operator reads — *"nothing in the schema connects a Device to a
/// Rack"* — names both kinds, and the page picked both boxes so it knows both
/// kinds. Building that sentence in the module measured 345 bytes against
/// `44` §5.2's ceiling, which the artifact's own budget can absorb for nothing.
/// The cut refusal carries its short sentence because the page cannot know
/// whether a link was there.
pub const ERR_NO_LINK: u16 = 15;

/// **Not a failure — a question.** `OP_LINK` found more than one edge kind the
/// schema admits between those two boxes, wrote nothing, and the detail is the
/// candidate kinds' declared names separated by single spaces.
///
/// It travels as an error record because that is what refusing to write *is*,
/// and because a bespoke reply shape measured over a kilobyte of module to
/// carry a list of names this record already carries. The page splits on the
/// space, offers the choice, and posts the chosen name back in the same frame.
///
/// A code of its own so the page can tell a question from a failure without
/// reading prose: `78` §6's floor is about not guessing, and a page that
/// pattern-matched an English sentence to decide whether to show a chooser
/// would be guessing.
pub const ERR_LINK_CHOICE: u16 = 16;

/// The paste names a device the design already holds, and Fathom will not
/// guess whether they are the same box.
///
/// **This code exists because the thing that used to stand in for it was
/// removed.** `70` §16.3 settled the collision question by deferring it:
///
/// > a tier-1 match is a **proposal to a human, not an automatic merge**,
/// > because two real branch sites may both run a `core-01` SRX on the same
/// > platform. **Until it is designed, `OP_PASTE` replaces the held estate and
/// > says so, which is the behaviour that cannot silently merge two boxes.**
///
/// Making the paste additive removes that guard, so the proposal has to exist.
/// It cannot ship bare.
///
/// **What replacing was actually doing.** Pasting the same box twice yielded
/// one device — because the second paste destroyed the first. That is not
/// correlation; it is amnesia that happens to look like correlation from one
/// angle. This code replaces it with a question, which is the truth about what
/// Fathom knows.
///
/// The message carries the existing device's display id and hostname so the
/// page can name it. The page turns it into buttons and **never picks** — the
/// same contract `ERR_LINK_CHOICE` has, and for the same reason.
///
/// **There is exactly one button.** *"These are different boxes — add it"*
/// re-posts the frame with `confirm = 1`. The other one a reader expects —
/// *"same box, update it"* — is `11` §10.4's re-identification, which has no
/// implementation anywhere in this tree, and the refusal says so in words
/// rather than offering a control that would lie.
pub const ERR_PASTE_CHOICE: u16 = 17;

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

/// The wire tag for a corpus section. Public so a decoder can invert the
/// encoder instead of carrying a second copy of the mapping — the artifact
/// tests read the frame back out of the assembled page and need to name the
/// sections it carries.
pub fn section_byte(section: fathom_corpus::Section) -> u8 {
    match section {
        fathom_corpus::Section::Commands => 0,
        fathom_corpus::Section::Explainers => 1,
        fathom_corpus::Section::Rules => 2,
        // 3, appended, because 0..=2 are already on the wire in every frame
        // built to date and renumbering them would be a silent reinterpretation
        // rather than a rejection.
        fathom_corpus::Section::Concepts => 3,
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

/// ADR-0027 §2's test, and nothing else's: an entry **that has not been run on
/// a box** renders as unverified.
///
/// It keys on `verified_on` and NOT on `reviewed_by`, and the difference is the
/// entire point of the label. 61 §3.1: *"Absent ⇒ the entry renders an
/// `unverified` margin tab."* 52 §3.2 says the same — *"or renders unverified
/// when `verified_against` is null"*.
///
/// THE BUG THIS REPLACED, because it is worth naming. Until 2026-08-15 this
/// keyed on `reviewed_by`, justified in a comment that said `61` §3 has no
/// `verified_on` field. §3.1 declares it on line 218; what was actually true
/// was narrower — `fathom_corpus`'s loader did not *parse* it — and ADR-0008
/// licenses adding the field to the loader, not redefining a safety label to
/// mean something the label's own ADR does not say. The consequence was
/// concrete: the named expert review of `corpus/` is already queued (CLAUDE.md's
/// owner-blocking list), and the day it lands `reviewed_by` becomes a real name
/// on all 98 entries with zero of them ever run on hardware — at which point
/// every stamp would have flipped to "reviewed", the ROW_UNVERIFIED bit would
/// have cleared, the dotted pending rule would have gone solid, and the corpus
/// line would have read "every one reviewed by a named human". A safety label
/// that disarms itself on a scheduled action is worse than no label.
///
/// Invariant 10's separate fact is not dropped — see `has_named_reviewer` and
/// `review_line`. It is reported as itself.
fn is_unverified(e: &Entry) -> bool {
    e.verified_on.is_none()
}

/// Invariant 10's test, and the same one `fathom_corpus::gates` applies: a
/// `reviewed_by` that opens with `<` is the `<named human>` placeholder rather
/// than a person. Empty counts too — an absent reviewer is not a reviewed
/// entry, and the two must not render differently.
///
/// Deliberately NOT folded into `is_unverified`. Two facts, two states, four
/// combinations, and the corpus will pass through at least two of them: today
/// every entry is both unreviewed and unrun, and the next thing to change is
/// the reviewer.
fn has_named_reviewer(e: &Entry) -> bool {
    let r = e.reviewed_by.trim();
    !r.is_empty() && !r.starts_with('<')
}

/// ADR-0027 §3's stamp, composed from what the corpus actually holds and from
/// nothing else.
///
/// The ADR's worked form is `junos-srx 21.4R3 · verified 2026-05-12 · K. Okafor`
/// — three facts: platform-and-train, a date, a name. All three are now
/// reachable, but the DATE needs care, and this is the one place the shipped
/// string deviates from the ADR's:
///
/// `61` §3.1 declares `verified_on` as `{ platform, version }` — a box, with no
/// date in it. The only date §3.1 declares is `reviewed_on`, and that is when
/// somebody read the entry, not when somebody ran it. Printing it straight after
/// the word `verified` would assert a bench date the corpus does not carry, so
/// the date is labelled by what it actually is. The rejected alternative was
/// inventing `verified_on.date` to match the ADR's string exactly, which is the
/// ADR-0008 breach the previous version of this function wrongly claimed it was
/// avoiding by keying the whole label on `reviewed_by` instead.
///
/// The verified form takes its platform and train from `verified_on` — the box
/// that was actually used — and never from the entry's own `platform`/`versions`,
/// which say what the entry is *for*. That distinction is why the unverified
/// form prints no train at all: there is no verified train, and a version number
/// sitting in the slot that means "the box we ran it on" is the exact confusion
/// this stamp exists to prevent. An entry's applicable trains are `16` §19.5's
/// "not on your train" caveat and belong to the row, not to its provenance line.
fn verification_stamp(e: &Entry) -> String {
    match &e.verified_on {
        // FOUR ARMS, NOT THREE. The two facts are independent — a bench run and
        // a named reviewer — so there are four states and the stamp must name
        // all four. The three-arm version asserted `reviewed … by {reviewed_by}`
        // on any verified entry without ever asking whether `reviewed_by` was a
        // person, so an entry run on a box before the expert review renders
        //
        //     junos-srx 21.4R3 · verified · reviewed 2026-07-28 by <named human>
        //
        // — invariant 10's literal placeholder printed as though it were a
        // human, in a line that opens with the word `verified`. Unreachable in
        // the shipped corpus, which has zero bench runs, and reachable the day
        // ADR-0027 §1's conformance lab lands before the review, an ordering
        // ADR-0027 §5 explicitly contemplates by tracking the placeholder as its
        // own blocker. The two `None` arms already made this distinction; this
        // one did not, which is the whole defect.
        Some(v) if has_named_reviewer(e) => format!(
            "{} {} · verified · reviewed {} by {}",
            v.platform, v.version, e.reviewed_on, e.reviewed_by
        ),
        Some(v) => format!(
            "{} {} · verified on a box · NO NAMED REVIEWER (invariant 10)",
            v.platform, v.version
        ),
        // Both missing facts are named. An entry with a real reviewer and no
        // bench run must not read the same as one with neither, or the corpus
        // cannot show its own progress.
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

/// The corpus-wide review line, carried on the summary record of every query
/// reply so the finder cannot render results without rendering this.
///
/// It is counted here rather than stated in the page, because a page holding
/// the number `98` would still be holding it on the day someone runs an entry.
///
/// TWO COUNTS, NOT ONE, and this is the structural half of the ADR-0027 fix.
/// The line before this reported a single number keyed on `reviewed_by` and
/// went silent when it hit zero — so the queued expert review would have taken
/// the alarm down while the hardware count stayed at 98. Reporting both means
/// completing the review changes the sentence, honestly, and does not end it.
/// The line only goes quiet when both are zero, which is the state ADR-0027 §2
/// actually describes.
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
    // Built by appending rather than by collecting into a Vec and joining:
    // byte-identical output, and measured 2026-08-15 the join form costs 107
    // more wasm bytes (890,366 vs 890,259) against 44 §5.2's 900,000 ceiling.
    // A small number, kept because it is free — the two forms are the same
    // length to read — and because the ceiling is the binding constraint here.
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

    // [`FACE_INV_KEY`]: which columns a person may type into, at the same slot
    // index the header put their names. Written from `keys` verbatim — this
    // function decides nothing about editability, it carries what
    // `fathom_inventory::column_keys` said.
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
        slots.push(row.opinions);
        let rec = face_slots(&mut blob, FACE_INV, slot_count, &slots);
        write_face_record(&mut records, &rec);
    }

    // 2 = the header and the key row. Both are chrome; neither is a row.
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

/// One rack's elevation (ADR-0035): the frame, every box in it, then every
/// clash.
///
/// Overflow rows are emitted with the fitting ones and flagged in slot 6,
/// rather than being dropped or clipped to the frame. A 42U rack holding a box
/// recorded at U48 is a data error somebody must see, and drawing it at U42
/// would destroy the evidence while looking tidy.
///
/// Numbers arrive as decimal strings, for the reason `PasteReply` gives: the
/// page prints them, and a string cannot be read at the wrong width by a
/// `DataView`. The page does compute one thing from them — the `y` of a rect —
/// and that is the whole reason the elevation is cheap.
pub fn encode_rack_reply(e: Option<&fathom_inventory::Elevation>) -> Vec<u8> {
    let mut blob = Blob::default();
    let mut records: Vec<u8> = Vec::new();
    // `None` is the empty state, not an error — the same convention
    // `encode_equipment_reply` uses: no rack selected, or a rack whose
    // `height_u` was never stated and so cannot be drawn.
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
        // An unstated height is an EMPTY slot, never "1". The page draws one
        // unit and marks it; collapsing the two here would turn "nobody said"
        // into a measurement, which is the one thing this face must not do.
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
    /// The shape digest of the estate this paste built — [`FACE_SHAPE`].
    pub shape: &'a str,
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
        // `<count> <interior> <placed> <role> <group>`, the group possibly empty
        // and therefore last. The placed flag rides in this slot rather than in
        // a ninth of its own for one reason and it is measured: the module has
        // 3,903 bytes of headroom against `44` §5.2's ceiling, a ninth slot is a
        // ninth `face_slots` argument and another blob offset per box, and the
        // group is the only token here that can be empty — so a token inserted
        // *before* it is unambiguous where one appended after it would not be.
        // ADR-0037's role is inserted at position 3 for exactly that reason, and
        // it carries `-` when absent rather than an empty string: two adjacent
        // empty tokens would collapse into one on a `split(' ')` and the page
        // would read the group key as the role. `-` is not a schema token
        // (`62` §7 variant names are `[a-z_]+`), so it cannot collide with a
        // real one. The page reads `parts[2]` as the flag, `parts[3]` as the
        // role and `parts[4]` as the key.
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
        // Slot 6 is APPENDED, after the five that were already on the wire. The
        // page reads slots by index, so inserting anywhere else would have
        // silently reinterpreted every existing row rather than rejected it —
        // the same reasoning ADR-0035's placed flag records for the box row,
        // where the flag went before the only possibly-empty token.
        let rec = face_slots(
            &mut blob,
            FACE_LINE,
            7,
            &[
                l.from.as_str(),
                l.to.as_str(),
                l.kind,
                if l.containment { "1" } else { "" },
                pts.as_str(),
                members.as_str(),
                if l.hand { "1" } else { "" },
            ],
        );
        write_face_record(&mut records, &rec);
    }

    face_reply(records, 1 + d.nodes.len() + d.links.len(), blob)
}

/// What the estate does not know yet: the head row, every gap group with its
/// examples, then every kind the estate holds none of.
///
/// An estate with nothing missing is `record_count = 1` — the head row alone,
/// with zeros in it. It is never an error and never an empty reply, because
/// "nothing is missing" is an answer the view has to be able to state plainly
/// and a caller cannot tell an empty reply from a call that did not happen.
///
/// Counts arrive as decimal strings for the reason `encode_rack_reply` gives:
/// the page prints them, and a string cannot be read at the wrong width by a
/// `DataView`.
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

/// Inside one box, as records (`57` §7).
///
/// `None` is the empty state and not an error, the convention
/// [`encode_rack_reply`] and `encode_equipment_reply` already use: the display
/// id named something that is not a live `Device`, and the page says so rather
/// than showing a diagnostic.
///
/// Counts arrive as decimal strings for the reason [`encode_rack_reply`]
/// gives: the page prints them, and a string cannot be read at the wrong width
/// by a `DataView`.
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
            // Joined here rather than in the page: `55` §1.4 the other way
            // round — a string a reader is shown is a string this side
            // composed. Two addresses on one unit is ordinary (inet plus
            // inet6) and the join is the only computation in the band.
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

    // Two optional tail rows, each present only when its string is. The
    // arithmetic counts what was written rather than assuming, because
    // `equip_reply_text` reuses this encoder for replies that are not pastes and
    // have neither.
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
