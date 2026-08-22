//! fathom-wasm: 41 §3.7's raw (ptr, len) ABI over the finder — slice one of
//! the browser core. Safe Rust throughout: both buffers are module-owned
//! `Vec`s; the host writes into a buffer whose address the module published,
//! and the module reads it back only inside a later export call, so no raw
//! pointer is ever dereferenced on this side of the boundary.
//!
//! Import section: empty — the finder needs neither entropy nor time
//! (41 §3.2's X13/X14 serve sealing and provenance, which are not linked
//! here). `tests/artifact_gates.rs` pins that fact against the built module.
//!
//! `#![forbid(unsafe_code)]` cannot be carried by this crate: `#[no_mangle]`
//! is rejected under it (symbol-collision hazard). deny + three per-item
//! allows is the narrowest working form; there is no `unsafe` block to allow.
#![deny(unsafe_code)]

pub mod dictframe;
pub mod protocol;
pub mod shell;
pub mod wasmbin;

use std::cell::RefCell;

use crate::shell::Shell;

/// 41 §3.7's opcode table. Stable forever; a new call is a new opcode, never
/// a changed one. Only the two this slice implements are named — an
/// unimplemented opcode is refused by number (protocol::ERR_UNKNOWN_OP).
pub const OP_INIT: u32 = 1;
pub const OP_QUERY: u32 = 4;

/// The inventory face's four opcodes (WO-08 §4.4). 41 §3.7's table holds
/// 1–10; these take the next free numbers. A new call is a new opcode, never
/// a changed one — 2, 3 and 5–10 stay refused by number.
///
/// **11 is reserved but not implemented by the shipping module.** The demo
/// estate it loaded was a development fixture costing 35,095 bytes of `44`
/// §5.2's ceiling, and it now builds only under the `demo-estate` feature,
/// which only test targets enable. The number stays declared here — and stays
/// unusable by anything else — because 41 §3.7's table is append-only: an
/// opcode that once meant "load the demo estate" may never come to mean
/// something else. Without the feature, a call to 11 returns `ERR_UNKNOWN_OP`.
pub const OP_ESTATE_DEMO: u32 = 11;
pub const OP_INV_ROWS: u32 = 12;
pub const OP_ELEMENT: u32 = 13;
pub const OP_EQUIPMENT: u32 = 14;

/// Paste in, estate out: the on-ramp opcode. Takes `14`'s pasted text, runs
/// ingest and the weld, and replaces the held estate with what it understood.
///
/// The host supplies the clock and the entropy **in the frame**, because the
/// module has none of either and must not acquire either: `wasmbin`'s import
/// allowlist is empty and this opcode does not grow it. That is not a
/// workaround — it is `fathom-weld`'s own `Manifest` contract (invariant 9),
/// which exists precisely so the weld cannot read a clock.
pub const OP_PASTE: u32 = 15;

/// Add one piece of equipment by hand: no config, no paste, no parser.
///
/// This is the **second door into the estate**, and the first one that does not
/// destroy what is already there. Every write before it — `OP_ESTATE_DEMO` and
/// `OP_PASTE` alike — installs a fresh `Graph` over whatever was held. This one
/// mutates in place, and creates an estate only when none exists, so a person
/// can start from an empty page and build.
///
/// It carries the same 24-byte host clock-and-entropy prefix `OP_PASTE` does,
/// for the same reason: the module has no clock and no RNG and must acquire
/// neither (`wasmbin::IMPORT_ALLOWLIST` is empty and stays empty). Hand entry
/// is not a special case of that rule; it is the same rule.
///
/// The provenance it writes is `Origin::Hand` — the first variant of the enum,
/// present since the beginning and until now produced nowhere a user could
/// reach. What a hand-entered field is *worth* is therefore recorded honestly
/// and is legible everywhere a parsed one is.
pub const OP_EQUIP_ADD: u32 = 16;

/// Correct one field of one element.
///
/// `52` §3.7 gives the inventory the contract *"Lets you change | Field values,
/// in place, in the cell"*, and until this opcode nothing could change a stored
/// value at all: a hostname that parsed but was wrong was permanent.
///
/// It is a **supersession, not an erasure**. `Graph::set_field_boxed` archives
/// the replaced slot and the store fills `supersedes` from the value that was
/// there, so a correction is recorded as one assertion replacing another and
/// both remain in the history. That is what lets an estate answer *"who said
/// this, and what did it say before"* rather than only *"what does it say"*.
pub const OP_FIELD_SET: u32 = 17;

/// Remove an element — a device added in error, a box that was decommissioned.
///
/// `Graph::tombstone` is the only removal this store has, and it is not a
/// delete: the element stays, marked absent from a moment, and its subtree goes
/// with it. So removing a device takes its chassis, which is right — a chassis
/// with no device is not a fact anyone asserted.
///
/// Nothing is ever hard-deleted, because an estate of record that can forget
/// silently is not a record. What this gives the operator is *"this is no longer
/// true"*, which is a different and more honest claim than *"this never was"*.
pub const OP_ELEMENT_REMOVE: u32 = 18;

/// The diagram: every live node as a positioned box, every live edge as a
/// routed line.
///
/// Layout runs HERE and not in the page — `41` §750, because it must be
/// deterministic (invariant 9), because the CLI's SVG export shares it, and
/// because `23` §6.5 already classes diagram layout as a deterministic
/// non-model task. The page receives coordinates and draws them; it computes no
/// geometry.
pub const OP_DIAGRAM: u32 = 19;

/// Hand the statement dictionary in.
///
/// The dictionary used to be `include_str!`'d into this module — 29 670 bytes
/// of YAML in the data section, against `44` §5.2's 900 000-byte ceiling, with
/// every further platform costing its own. It is corpus data, and corpus data
/// already has a door: `OP_INIT` has carried commands, explainers and rules in
/// from the page since WO-07. This is that door, used a second time, and
/// `crate::dictframe` documents the frame.
///
/// **20, not 19.** 19 is `OP_DIAGRAM`'s, taken concurrently in another branch.
/// An opcode is stable forever and a collision is worse than a gap
/// (41 §3.7: *"a new call is a new opcode, never a changed one"*), so this
/// takes the next free number rather than the next one up.
pub const OP_DICT: u32 = 20;

/// Put a box somewhere, or put it back under computed layout.
///
/// The owner asked for this three times — *"drag a device"*, *"add into
/// inventory by just drag and drop"*, *"didn't we agree we were gonna have a
/// drag and drop system?"* — and each time the answer was that there was nowhere
/// in `schema/` to store where a box sits. ADR-0035 is that decision made: **a
/// hand-placed position is graph data**, a `LayoutPin` contained by the element,
/// with `Origin::Hand` provenance like every other thing a person asserted.
///
/// It is therefore an op like any other, and that is the whole point. A position
/// kept beside the op log — in `localStorage`, in a view preference, in
/// side-state — would not survive an export, would not reach a colleague, and is
/// exactly the *"state written beside the op log"* that `75` §2.4 forbids because
/// it forecloses real-time collaboration. A position kept **in** the log is one
/// more op a CRDT converges.
///
/// It carries the same 24-byte host clock-and-entropy prefix every writing
/// opcode does, for the same reason: the module has no clock and no RNG and must
/// acquire neither (`wasmbin::IMPORT_ALLOWLIST` is empty and stays empty).
pub const OP_PLACE: u32 = 21;
/// Put one chassis in one rack, at one unit (ADR-0036).
///
/// **This is the only input a rack elevation can have today, and that is a
/// fact about the world rather than a gap in the dictionary.** No Junos
/// statement — none this project has established on any platform — says which
/// rack a box stands in or at what height. So physical placement is asserted
/// by a person or it does not exist, which makes this opcode a sibling of
/// `OP_EQUIP_ADD` rather than anything downstream of `OP_PASTE`, and makes
/// `Origin::Hand` the only provenance it can write.
///
/// The rack is found-or-created by label, which is not a shortcut: `Rack`'s
/// tier-1 identity tuple is `[owner(Premises), label]`, so matching an existing
/// rack by its label is the schema's own declared identity being used for what
/// identity is for. An engineer says "node0 is in R12 at U5"; they do not
/// create a frame and then fill it.
pub const OP_RACK_PLACE: u32 = 22;

/// Draw a link between two boxes by hand, or cut one.
///
/// **This is the opcode that makes a hand-built estate a network.** Before it,
/// the five write opcodes could add a device, correct a field, remove an
/// element, place a box and rack a chassis — and not one of them created an
/// EDGE. So a lab built by hand was a pile of unconnected boxes, and a diagram
/// of unconnected boxes is not a network diagram. `52` §3.6 has stated the
/// diagram's job as *"add a device, draw a link, draw a tunnel, drag for
/// layout"* since it was written; three of those four existed.
///
/// # Which edge, and why the module decides
///
/// `schema/` declares 84 edge kinds and a person pointing at two boxes is not
/// going to pick from 84. `fathom_weld::hand_link_candidates` narrows that to
/// the reference edges the schema admits between those two kinds, computed from
/// the generated tables and never from a hand-written list (ADR-0008). **When
/// exactly one is legal this opcode does not ask** — the schema has already
/// decided, and a menu of one is a question with no content. When several are,
/// it writes nothing and hands the candidates back for the page to offer,
/// because guessing writes a false fact into an estate of record. When none is,
/// it says so plainly, naming both kinds.
///
/// # Why the kind travels as a name
///
/// A hand-drawn link is journalled and an exported journal outlives the build
/// that wrote it. An index into `EdgeKind::ALL` is a number whose meaning moves
/// the next time `schema/` declares an edge; `"PeersWith"` is not, and it reads
/// as itself in the file an operator keeps.
///
/// It carries the same 24-byte host clock-and-entropy prefix every writing
/// opcode does, for the same reason: the module has no clock and no RNG and
/// must acquire neither (`wasmbin::IMPORT_ALLOWLIST` is empty and stays empty).
pub const OP_LINK: u32 = 24;

/// Read one rack's elevation — the frame, its capacity, and every box in it.
///
/// Returns numbers, not geometry. The page turns `position_u` into a `y`,
/// because that is one multiply and page bytes are artifact bytes while this
/// module is measured against `44` §5.2's ceiling.
pub const OP_RACK_ELEVATION: u32 = 23;

/// What the estate does not know yet.
///
/// The findings view's first real job (`57` §13.5 consequence 3): every field
/// `schema/schema.yaml` declares `card: "1"` against every live element that
/// has no value under it. Read-only, no clock, no entropy — it asserts
/// nothing, so it carries none of the 24-byte prefix the writing opcodes do.
///
/// # Why it is an opcode and not a page-side walk
///
/// `57` §14.1 files this as pile A, *"page-side, no module bytes"*, and that
/// classification does not survive contact with the two questions the view
/// has to ask. "Which fields are required" lives in the `card:` column and
/// reaches a reader only through `fathom-schemagen`'s generated tables
/// (ADR-0008); "which of them has no stored value" is
/// `Graph::presence`'s three-state answer, and the page has no graph — it has
/// the strings of whatever it last asked about. A page-side version would
/// need a copy of the schema in JavaScript and one `OP_ELEMENT` per element,
/// which is the exact defect `protocol::FACE_RACK` was written to stop.
///
/// So it costs module bytes, and `47`'s ceiling is the reason that is worth
/// stating out loud rather than absorbing quietly.
pub const OP_FINDINGS: u32 = 25;

/// Inside one box — the zoom ladder's fourth rung (`57` §7).
///
/// Takes a `Device` display id as raw UTF-8, like every other node-addressed
/// face, and returns the four bands `fathom_inventory::inside` projects: the
/// ways in and out, the zones, the policy sets with their policies **in the
/// order the device reads them**, and the routing instances and tunnels.
///
/// Read-only. No clock, no entropy, no 24-byte prefix.
///
/// # Why an opcode, when `57` §14.1 filed rung 4 as page-side
///
/// The same answer `OP_FINDINGS` gives one paragraph up, and for a sharper
/// reason. This rung is eight graph walks — `HasInterface`, `HasUnit`,
/// `HasAddress`, `HasZone`, `ZoneMember`, `HasPolicySet`, `HasPolicy`,
/// `HasRoutingInstance` and their two siblings — plus a sort on
/// `SecurityPolicy.ordinal` whose correctness is the whole feature. The page
/// holds strings, not a graph; a page-side version would be one `OP_ELEMENT`
/// per element and a first-match ordering computed in JavaScript.
///
/// **`57` §14.1's "page-side and therefore free" was a byte-ceiling argument
/// and the ceiling was retired on 2026-08-21 (`49` §1).** What survives it is
/// ADR-0019's rule, which points the other way: views are pure functions of
/// typed data, and every join and count happens in Rust.
pub const OP_INSIDE: u32 = 26;

// There is deliberately no OP_RACK_LIST. A rack is inventory -- it has a
// label, a capacity and a count of what is in it -- so it is an `InvKind` and
// `OP_INV_ROWS` already lists it. A bespoke opcode would have been a second
// way to ask the same question, and it measured 1,663 bytes of module for the
// privilege.

thread_local! {
    static SHELL: RefCell<Shell> = RefCell::new(Shell::new());
    static REQ: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
    static REPLY: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
}

/// Allocate `len` bytes of scratch for the caller to write a request into.
/// One scratch buffer exists; a second call replaces the first. Never traps.
#[allow(unsafe_code)] // #[no_mangle] only; no unsafe block. WO-07 §3 probe 5.
#[no_mangle]
pub extern "C" fn fathom_alloc(len: u32) -> u32 {
    REQ.with(|r| {
        let mut v = r.borrow_mut();
        v.clear();
        v.resize(len as usize, 0);
        v.as_ptr() as usize as u32
    })
}

/// Release the scratch buffer. `ptr`/`len` are accepted for 41 §3.7 signature
/// fidelity and ignored: there is exactly one scratch to free.
#[allow(unsafe_code)] // as above
#[no_mangle]
pub extern "C" fn fathom_free(_ptr: u32, _len: u32) {
    REQ.with(|r| *r.borrow_mut() = Vec::new());
}

/// The one data-plane entry point (41 §3.7). Returns
/// `(reply_ptr as u64) << 32 | reply_len as u64`; 0 means "no reply". The
/// reply lives in a module-owned arena valid until the next `fathom_call`.
/// A failure is a reply with `record_kind = 0`, never a trap (41 §3.9);
/// `req_ptr` must be the live scratch address and `req_len` within it, else
/// the reply is `ERR_BAD_FRAME`.
#[allow(unsafe_code)] // as above
#[no_mangle]
pub extern "C" fn fathom_call(op: u32, req_ptr: u32, req_len: u32) -> u64 {
    let req: Option<Vec<u8>> = REQ.with(|r| {
        let v = r.borrow();
        let live = v.as_ptr() as usize as u32;
        if req_ptr == live && (req_len as usize) <= v.len() {
            Some(v[..req_len as usize].to_vec())
        } else {
            None
        }
    });
    let reply = match req {
        None => protocol::encode_error(
            protocol::ERR_BAD_FRAME,
            "request pointer is not the live scratch buffer",
        ),
        Some(bytes) => SHELL.with(|s| s.borrow_mut().handle(op, &bytes)),
    };
    REPLY.with(|r| {
        let mut v = r.borrow_mut();
        *v = reply;
        if v.is_empty() {
            0
        } else {
            ((v.as_ptr() as usize as u64) << 32) | v.len() as u64
        }
    })
}
