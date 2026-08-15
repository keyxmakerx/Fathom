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
